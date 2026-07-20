"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import type { EnvMode, WorkerOutput, SerializedEntity, SerializedEvidence } from "@/lib/worker/message-types";

export interface DetectionState {
  isReady: boolean;
  isAnalyzing: boolean;
  state: string;
  entities: SerializedEntity[];
  evidence: SerializedEvidence[];
  changeGrid: number[];
  fps: number;
  detectionCount: number;
  error: string | null;
}

export interface UseDetectionWorkerReturn extends DetectionState {
  startAnalysis: (video: HTMLVideoElement) => void;
  stopAnalysis: () => void;
  setMode: (mode: EnvMode) => void;
  incidents: Array<{ type: string; severity: string; confidence: number; timestamp: string }>;
}

const COCO_MAP: Record<string, string> = {
  car: "car", truck: "car", bus: "car",
  motorcycle: "motorcycle", motorbike: "motorcycle", bicycle: "motorcycle",
  person: "person",
};

export function useDetectionWorker(initialMode: EnvMode = "isolated"): UseDetectionWorkerReturn {
  const workerRef = useRef<Worker | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const modelRef = useRef<any>(null);
  const rafRef = useRef<number>(0);
  const lastDetectTimeRef = useRef(0);
  const fpsCounterRef = useRef({ frames: 0, lastTime: 0 });
  const modeRef = useRef<EnvMode>(initialMode);

  const [state, setState] = useState<DetectionState>({
    isReady: false, isAnalyzing: false, state: "monitoring",
    entities: [], evidence: [], changeGrid: new Array(80).fill(0),
    fps: 0, detectionCount: 0, error: null,
  });
  const [incidents, setIncidents] = useState<Array<{ type: string; severity: string; confidence: number; timestamp: string }>>([]);

  // Initialize worker
  useEffect(() => {
    const worker = new Worker(
      new URL("@/lib/worker/detection-worker.ts", import.meta.url),
      { type: "module" }
    );

    worker.onmessage = (e: MessageEvent<WorkerOutput>) => {
      const msg = e.data;
      switch (msg.type) {
        case "READY":
          worker.postMessage({ type: "INIT", envMode: initialMode });
          break;
        case "MODEL_LOADED":
          // Worker ready (model loads on main thread)
          break;
        case "RESULTS": {
          // Calculate FPS
          fpsCounterRef.current.frames++;
          const now = Date.now();
          let fps = 0;
          if (now - fpsCounterRef.current.lastTime > 1000) {
            fps = Math.round(fpsCounterRef.current.frames * 1000 / (now - fpsCounterRef.current.lastTime));
            fpsCounterRef.current.frames = 0;
            fpsCounterRef.current.lastTime = now;
          }

          setState(prev => ({
            ...prev, entities: msg.entities, evidence: msg.evidence,
            changeGrid: msg.changeGrid, state: msg.state,
            detectionCount: msg.detectionCount,
            ...(fps > 0 ? { fps } : {}),
          }));

          if (msg.state === "alert" && msg.evidence.length > 0) {
            const top = msg.evidence[0];
            const severity = top.confidence > 0.8 ? "critical" : "major";
            let incidentType = "vehicle_collision";
            if (top.type === "person_fall") incidentType = "pedestrian_collision";
            else if (top.type === "bike_off_track") incidentType = "vehicle_collision";

            setIncidents(prev => [...prev, {
              type: incidentType, severity,
              confidence: top.confidence, timestamp: new Date().toISOString(),
            }]);
          }
          break;
        }
        case "ERROR":
          console.error("[SAGE] Worker:", msg.message);
          break;
      }
    };

    worker.onerror = (err) => {
      console.error("[SAGE] Worker crashed:", err);
    };

    workerRef.current = worker;

    // Load TF.js lazily - don't block initial render
    const loadModel = async () => {
      try {
        const [tf, cocoSsd] = await Promise.all([
          import("@tensorflow/tfjs"),
          import("@tensorflow-models/coco-ssd"),
        ]);
        await tf.ready();
        modelRef.current = await cocoSsd.load({ base: "lite_mobilenet_v2" });
        setState(prev => ({ ...prev, isReady: true, error: null }));
      } catch (e) {
        console.error("Model load failed:", e);
        setState(prev => ({ ...prev, error: "AI model failed to load" }));
      }
    };
    // Delay model loading to not block initial render
    setTimeout(loadModel, 100);

    return () => worker.terminate();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Detection loop
  const runDetection = useCallback(() => {
    const video = videoRef.current;
    const worker = workerRef.current;
    const model = modelRef.current;
    if (!model || !video || !worker) return;
    if (video.paused || video.ended) return;

    const now = Date.now();
    // Throttle detection to every 300ms (~3 FPS)
    if (now - lastDetectTimeRef.current < 300) {
      rafRef.current = requestAnimationFrame(runDetection);
      return;
    }
    lastDetectTimeRef.current = now;

    // Create ImageBitmap for change detection in worker
    createImageBitmap(video, {
      resizeWidth: video.videoWidth || 640,
      resizeHeight: video.videoHeight || 480,
    }).then(bitmap => {
      // Run TF.js inference on main thread
      return model.detect(video).then((preds: any[]) => {
        const filtered = preds
          .filter((p: any) => p.class in COCO_MAP && p.score > 0.25)
          .map((p: any) => {
            const [x, y, w, h] = p.bbox;
            return { class: COCO_MAP[p.class], cx: x + w / 2, cy: y + h / 2, w, h, confidence: p.score };
          });

        // Send detections + bitmap to worker for tracking + change detection
        worker.postMessage({
          type: "DETECTIONS",
          detections: filtered,
          frame: Math.floor(now / 500),
          bitmap,
        }, [bitmap as unknown as Transferable]);
      }).catch(() => bitmap.close());
    }).catch(() => {});

    rafRef.current = requestAnimationFrame(runDetection);
  }, []);

  const startAnalysis = useCallback((video: HTMLVideoElement) => {
    if (!modelRef.current) {
      setState(prev => ({ ...prev, error: "AI model still loading..." }));
      return;
    }
    videoRef.current = video;
    lastDetectTimeRef.current = 0;
    fpsCounterRef.current = { frames: 0, lastTime: Date.now() };
    setIncidents([]);
    setState(prev => ({
      ...prev, isAnalyzing: true, entities: [], evidence: [],
      state: "monitoring", error: null,
    }));
    rafRef.current = requestAnimationFrame(runDetection);
  }, [runDetection]);

  const stopAnalysis = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    workerRef.current?.postMessage({ type: "STOP" });
    videoRef.current = null;
    setState(prev => ({ ...prev, isAnalyzing: false, state: "monitoring" }));
  }, []);

  const setMode = useCallback((mode: EnvMode) => {
    modeRef.current = mode;
    workerRef.current?.postMessage({ type: "SET_MODE", envMode: mode });
  }, []);

  return {
    ...state, startAnalysis, stopAnalysis, setMode, incidents,
  };
}

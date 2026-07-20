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

// COCO-SSD class mapping
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
  const detectingRef = useRef(false);
  const lastDetectTimeRef = useRef(0);
  const modeRef = useRef<EnvMode>(initialMode);

  const [state, setState] = useState<DetectionState>({
    isReady: false, isAnalyzing: false, state: "monitoring",
    entities: [], evidence: [], changeGrid: new Array(80).fill(0),
    fps: 0, detectionCount: 0, error: null,
  });
  const [incidents, setIncidents] = useState<Array<{ type: string; severity: string; confidence: number; timestamp: string }>>([]);

  // Initialize worker + TF.js model
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
          setState(prev => ({ ...prev, isReady: true, error: null }));
          break;
        case "MODEL_ERROR":
          setState(prev => ({ ...prev, error: msg.error }));
          break;
        case "RESULTS": {
          setState(prev => ({
            ...prev, entities: msg.entities, evidence: msg.evidence,
            changeGrid: msg.changeGrid, state: msg.state,
            detectionCount: msg.detectionCount,
          }));
          if (msg.state === "alert" && msg.evidence.length > 0) {
            const top = msg.evidence[0];
            const severity = top.confidence > 0.8 ? "critical" : "major";
            let incidentType = "vehicle_collision";
            if (top.type === "person_fall") incidentType = "pedestrian_collision";
            setIncidents(prev => [...prev, {
              type: incidentType, severity,
              confidence: top.confidence, timestamp: new Date().toISOString(),
            }]);
          }
          break;
        }
        case "ERROR":
          console.error("[SAGE] Worker error:", msg.message);
          break;
      }
    };

    worker.onerror = (err) => {
      console.error("[SAGE] Worker crashed:", err);
      setState(prev => ({ ...prev, error: "Worker crashed" }));
    };

    workerRef.current = worker;

    // Load TF.js COCO-SSD on main thread (needs DOM)
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
        console.error("COCO-SSD load failed:", e);
        setState(prev => ({ ...prev, error: "AI model failed to load" }));
      }
    };
    loadModel();

    return () => {
      worker.terminate();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Run detection loop on main thread
  const runDetection = useCallback(() => {
    if (!modelRef.current || !videoRef.current) return;
    const video = videoRef.current;
    if (video.paused || video.ended) return;

    const now = Date.now();
    // Throttle: run inference at most every 500ms (2 FPS for detection)
    if (now - lastDetectTimeRef.current < 500) {
      rafRef.current = requestAnimationFrame(runDetection);
      return;
    }
    lastDetectTimeRef.current = now;

    // Run COCO-SSD inference (this MUST be on main thread for DOM access)
    modelRef.current.detect(video).then((preds: any[]) => {
      const filtered = preds
        .filter((p: any) => p.class in COCO_MAP && p.score > 0.25)
        .map((p: any) => {
          const [x, y, w, h] = p.bbox;
          return { class: COCO_MAP[p.class], cx: x + w / 2, cy: y + h / 2, w, h, confidence: p.score };
        });

      // Send detections to worker for tracking + collision detection
      if (workerRef.current) {
        workerRef.current.postMessage({
          type: "DETECTIONS",
          detections: filtered,
          frame: Math.floor(now / 500),
        });
      }

      detectingRef.current = false;
    }).catch(() => { detectingRef.current = false; });

    // Continue loop
    rafRef.current = requestAnimationFrame(runDetection);
  }, []);

  const startAnalysis = useCallback((video: HTMLVideoElement) => {
    if (!modelRef.current) return;
    videoRef.current = video;
    detectingRef.current = false;
    lastDetectTimeRef.current = 0;
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

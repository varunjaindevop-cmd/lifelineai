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

export function useDetectionWorker(initialMode: EnvMode = "isolated"): UseDetectionWorkerReturn {
  const workerRef = useRef<Worker | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const rafRef = useRef<number>(0);
  const lastFrameTimeRef = useRef(0);
  const fpsCounterRef = useRef({ frames: 0, lastTime: 0 });
  const modelPathRef = useRef("/models/best.onnx");

  const [state, setState] = useState<DetectionState>({
    isReady: false,
    isAnalyzing: false,
    state: "monitoring",
    entities: [],
    evidence: [],
    changeGrid: new Array(80).fill(0),
    fps: 0,
    detectionCount: 0,
    error: null,
  });
  const [incidents, setIncidents] = useState<
    Array<{ type: string; severity: string; confidence: number; timestamp: string }>
  >([]);

  // ── Initialize worker + load ONNX model ──
  useEffect(() => {
    const worker = new Worker(
      new URL("@/lib/worker/detection-worker.ts", import.meta.url),
      { type: "module" }
    );

    worker.onmessage = (e: MessageEvent<WorkerOutput>) => {
      const msg = e.data;
      switch (msg.type) {
        case "READY":
          // Send init with model path
          worker.postMessage({
            type: "INIT",
            envMode: initialMode,
            modelPath: modelPathRef.current,
          });
          break;

        case "MODEL_LOADED":
          setState((prev) => ({ ...prev, isReady: true, error: null }));
          break;

        case "MODEL_ERROR":
          setState((prev) => ({
            ...prev,
            error: `Model load failed: ${msg.error}`,
          }));
          break;

        case "RESULTS": {
          // FPS calculation
          fpsCounterRef.current.frames++;
          const now = Date.now();
          let fps = 0;
          if (now - fpsCounterRef.current.lastTime > 1000) {
            fps = Math.round(
              (fpsCounterRef.current.frames * 1000) /
                (now - fpsCounterRef.current.lastTime)
            );
            fpsCounterRef.current.frames = 0;
            fpsCounterRef.current.lastTime = now;
          }

          setState((prev) => ({
            ...prev,
            entities: msg.entities,
            evidence: msg.evidence,
            changeGrid: msg.changeGrid,
            state: msg.state,
            detectionCount: msg.detectionCount,
            ...(fps > 0 ? { fps } : {}),
          }));

          // Fire incident if alert state with evidence
          if (msg.evidence.length > 0) {
            const top = msg.evidence[0];
            const severity =
              top.confidence > 0.8 ? "critical" : top.confidence > 0.6 ? "major" : "minor";

            let incidentType = "vehicle_collision";
            if (top.type === "person_fall") incidentType = "pedestrian_fall";

            setIncidents((prev) => [
              ...prev,
              {
                type: incidentType,
                severity,
                confidence: top.confidence,
                timestamp: new Date().toISOString(),
              },
            ]);
          }
          break;
        }

        case "ERROR":
          console.error("[SAGE Worker]", msg.message);
          break;
      }
    };

    worker.onerror = (err) => {
      console.error("[SAGE Worker] crashed:", err);
      setState((prev) => ({ ...prev, error: "Worker crashed" }));
    };

    workerRef.current = worker;
    return () => worker.terminate();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Detection loop: capture frames → send to worker ──
  const runDetection = useCallback(() => {
    const video = videoRef.current;
    const worker = workerRef.current;
    if (!video || !worker) return;
    if (video.paused || video.ended || video.readyState < 2) {
      rafRef.current = requestAnimationFrame(runDetection);
      return;
    }

    const now = performance.now();
    // Throttle to ~4 FPS (250ms between frames)
    if (now - lastFrameTimeRef.current < 250) {
      rafRef.current = requestAnimationFrame(runDetection);
      return;
    }
    lastFrameTimeRef.current = now;

    // Capture frame as ImageBitmap (zero-copy transfer to worker)
    createImageBitmap(video, {
      resizeWidth: video.videoWidth || 640,
      resizeHeight: video.videoHeight || 480,
      resizeQuality: "low",
    })
      .then((bitmap) => {
        worker.postMessage(
          {
            type: "FRAME",
            bitmap,
            frameNumber: Math.floor(now / 250),
          },
          [bitmap as unknown as Transferable]
        );
      })
      .catch(() => {});

    rafRef.current = requestAnimationFrame(runDetection);
  }, []);

  // ── Public API ──
  const startAnalysis = useCallback(
    (video: HTMLVideoElement) => {
      videoRef.current = video;
      lastFrameTimeRef.current = 0;
      fpsCounterRef.current = { frames: 0, lastTime: Date.now() };
      setIncidents([]);
      setState((prev) => ({
        ...prev,
        isAnalyzing: true,
        entities: [],
        evidence: [],
        state: "monitoring",
        error: null,
      }));
      rafRef.current = requestAnimationFrame(runDetection);
    },
    [runDetection]
  );

  const stopAnalysis = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    workerRef.current?.postMessage({ type: "STOP" });
    videoRef.current = null;
    setState((prev) => ({
      ...prev,
      isAnalyzing: false,
      state: "monitoring",
    }));
  }, []);

  const setMode = useCallback((mode: EnvMode) => {
    workerRef.current?.postMessage({ type: "SET_MODE", envMode: mode });
  }, []);

  // Send thresholds from localStorage to worker
  const syncThresholds = useCallback(() => {
    try {
      const raw = localStorage.getItem("sage_debug_thresholds");
      if (raw && workerRef.current) {
        const t = JSON.parse(raw);
        workerRef.current.postMessage({ type: "SET_THRESHOLDS", ...t });
      }
    } catch {}
  }, []);

  // Sync thresholds on mount and periodically
  useEffect(() => {
    syncThresholds();
    const id = setInterval(syncThresholds, 5000);
    return () => clearInterval(id);
  }, [syncThresholds]);

  return {
    ...state,
    startAnalysis,
    stopAnalysis,
    setMode,
    incidents,
  };
}

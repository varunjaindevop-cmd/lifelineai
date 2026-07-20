"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import type { EnvMode, WorkerOutput, SerializedEntity, SerializedEvidence } from "@/lib/worker/message-types";

export interface DetectionState {
  isReady: boolean;
  isAnalyzing: boolean;
  state: string;
  backend: string; // "onnx" or "demo"
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
  const fpsFramesRef = useRef(0);
  const fpsLastTimeRef = useRef(0);
  const lastIncidentFrameRef = useRef(-1);

  const [state, setState] = useState<DetectionState>({
    isReady: false, isAnalyzing: false, state: "monitoring", backend: "unknown",
    entities: [], evidence: [], changeGrid: new Array(80).fill(0),
    fps: 0, detectionCount: 0, error: null,
  });
  const [incidents, setIncidents] = useState<Array<{ type: string; severity: string; confidence: number; timestamp: string }>>([]);

  // Keep refs for FPS calculation inside RAF loop
  const backendRef = useRef("unknown");
  const fpsDisplayRef = useRef(0);

  // Initialize worker
  useEffect(() => {
    console.log("[SAGE] Creating detection worker...");
    const worker = new Worker(new URL("@/lib/worker/detection-worker.ts", import.meta.url), { type: "module" });

    worker.onmessage = (e: MessageEvent<WorkerOutput>) => {
      const msg = e.data;
      switch (msg.type) {
        case "READY":
          console.log("[SAGE] Worker ready, sending INIT...");
          worker.postMessage({ type: "INIT", modelPath: "/models/best.onnx" });
          break;
        case "MODEL_LOADED":
          console.log(`[SAGE] Model loaded (backend: ${msg.backend})`);
          backendRef.current = msg.backend;
          setState(prev => ({ ...prev, isReady: true, backend: msg.backend, error: null }));
          break;
        case "MODEL_ERROR":
          console.error("[SAGE] Model error:", msg.error);
          setState(prev => ({ ...prev, error: msg.error, backend: "error" }));
          break;
        case "RESULTS": {
          // FPS — compute from wall-clock time between RESULTS messages
          fpsFramesRef.current++;
          const now = Date.now();
          let fps = fpsDisplayRef.current;
          if (now - fpsLastTimeRef.current >= 1000) {
            fps = Math.round((fpsFramesRef.current * 1000) / (now - fpsLastTimeRef.current));
            fpsFramesRef.current = 0;
            fpsLastTimeRef.current = now;
            fpsDisplayRef.current = fps;
          }

          setState(prev => ({
            ...prev,
            entities: msg.entities,
            evidence: msg.evidence,
            changeGrid: msg.changeGrid,
            state: msg.state,
            detectionCount: msg.detectionCount,
            fps,
          }));

          if (msg.state === "alert" && msg.evidence.length > 0 && msg.frame !== lastIncidentFrameRef.current) {
            lastIncidentFrameRef.current = msg.frame;
            const top = msg.evidence[0];
            const severity = top.confidence > 0.8 ? "critical" : top.confidence > 0.6 ? "major" : "minor";
            const incidentType = top.type === "person_fall" ? "pedestrian_fall" : "vehicle_collision";
            console.log(`[SAGE] INCIDENT: ${incidentType} (${severity}) conf=${top.confidence.toFixed(2)}`);
            setIncidents(prev => [...prev, { type: incidentType, severity, confidence: top.confidence, timestamp: new Date().toISOString() }]);
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
      setState(prev => ({ ...prev, error: "Worker crashed" }));
    };

    workerRef.current = worker;
    return () => worker.terminate();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Detection loop
  const runDetection = useCallback(() => {
    const video = videoRef.current;
    const worker = workerRef.current;
    if (!video || !worker) return;
    if (video.paused || video.ended || video.readyState < 2) {
      rafRef.current = requestAnimationFrame(runDetection);
      return;
    }

    const now = performance.now();
    if (now - lastFrameTimeRef.current < 200) {
      rafRef.current = requestAnimationFrame(runDetection);
      return;
    }
    lastFrameTimeRef.current = now;

    const vw = video.videoWidth || 640;
    const vh = video.videoHeight || 480;
    createImageBitmap(video, { resizeWidth: vw, resizeHeight: vh, resizeQuality: "low" })
      .then((bitmap) => {
        const frameNum = Math.floor(now);
        worker.postMessage({ type: "FRAME", bitmap, frame: frameNum }, [bitmap as unknown as Transferable]);
      })
      .catch(() => {});

    rafRef.current = requestAnimationFrame(runDetection);
  }, []);

  const startAnalysis = useCallback((video: HTMLVideoElement) => {
    console.log("[SAGE] Starting analysis...");
    videoRef.current = video;
    lastFrameTimeRef.current = 0;
    lastIncidentFrameRef.current = -1;
    fpsFramesRef.current = 0;
    fpsLastTimeRef.current = Date.now();
    fpsDisplayRef.current = 0;
    setIncidents([]);
    setState(prev => ({ ...prev, isAnalyzing: true, entities: [], evidence: [], state: "monitoring", fps: 0, error: null }));
    rafRef.current = requestAnimationFrame(runDetection);
  }, [runDetection]);

  const stopAnalysis = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    workerRef.current?.postMessage({ type: "STOP" });
    videoRef.current = null;
    setState(prev => ({ ...prev, isAnalyzing: false, state: "monitoring", fps: 0 }));
  }, []);

  const setMode = useCallback((mode: EnvMode) => {
    workerRef.current?.postMessage({ type: "SET_MODE", envMode: mode });
  }, []);

  // Sync thresholds from localStorage to worker
  const syncThresholds = useCallback(() => {
    try {
      const raw = localStorage.getItem("sage_debug_thresholds");
      if (raw && workerRef.current) {
        workerRef.current.postMessage({ type: "SET_THRESHOLDS", ...JSON.parse(raw) });
      }
    } catch {}
  }, []);

  useEffect(() => {
    syncThresholds();
    const id = setInterval(syncThresholds, 5000);
    return () => clearInterval(id);
  }, [syncThresholds]);

  return { ...state, startAnalysis, stopAnalysis, setMode, incidents };
}

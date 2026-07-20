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
  const lastIncidentFrameRef = useRef(-1); // prevent duplicate incidents

  const [state, setState] = useState<DetectionState>({
    isReady: false, isAnalyzing: false, state: "monitoring",
    entities: [], evidence: [], changeGrid: new Array(80).fill(0),
    fps: 0, detectionCount: 0, error: null,
  });
  const [incidents, setIncidents] = useState<Array<{ type: string; severity: string; confidence: number; timestamp: string }>>([]);

  // Initialize worker
  useEffect(() => {
    console.log("[SAGE] Creating detection worker...");
    const worker = new Worker(new URL("@/lib/worker/detection-worker.ts", import.meta.url), { type: "module" });

    worker.onmessage = (e: MessageEvent<WorkerOutput>) => {
      const msg = e.data;
      switch (msg.type) {
        case "READY":
          console.log("[SAGE] Worker ready, sending INIT...");
          worker.postMessage({ type: "INIT", envMode: initialMode });
          break;
        case "MODEL_LOADED":
          console.log(`[SAGE] Model loaded (backend: ${msg.backend})`);
          setState(prev => ({ ...prev, isReady: true, error: null }));
          break;
        case "MODEL_ERROR":
          console.error("[SAGE] Model error:", msg.error);
          setState(prev => ({ ...prev, error: msg.error }));
          break;
        case "RESULTS": {
          // FPS
          fpsCounterRef.current.frames++;
          const now = Date.now();
          let fps = 0;
          if (now - fpsCounterRef.current.lastTime > 1000) {
            fps = Math.round((fpsCounterRef.current.frames * 1000) / (now - fpsCounterRef.current.lastTime));
            fpsCounterRef.current = { frames: 0, lastTime: now };
          }

          setState(prev => ({
            ...prev,
            entities: msg.entities,
            evidence: msg.evidence,
            changeGrid: msg.changeGrid,
            state: msg.state,
            detectionCount: msg.detectionCount,
            ...(fps > 0 ? { fps } : {}),
          }));

          // Only create incident when state is "alert" AND we haven't already for this frame
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

  // Detection loop: capture frames → send to worker
  const runDetection = useCallback(() => {
    const video = videoRef.current;
    const worker = workerRef.current;
    if (!video || !worker) return;
    if (video.paused || video.ended || video.readyState < 2) {
      rafRef.current = requestAnimationFrame(runDetection);
      return;
    }

    const now = performance.now();
    if (now - lastFrameTimeRef.current < 250) { // ~4 FPS
      rafRef.current = requestAnimationFrame(runDetection);
      return;
    }
    lastFrameTimeRef.current = now;

    createImageBitmap(video, {
      resizeWidth: video.videoWidth || 640,
      resizeHeight: video.videoHeight || 480,
      resizeQuality: "low",
    }).then(bitmap => {
      worker.postMessage({ type: "FRAME", bitmap, frameNumber: Math.floor(now / 250) }, [bitmap as unknown as Transferable]);
    }).catch(() => {});

    rafRef.current = requestAnimationFrame(runDetection);
  }, []);

  const startAnalysis = useCallback((video: HTMLVideoElement) => {
    console.log("[SAGE] Starting analysis...");
    videoRef.current = video;
    lastFrameTimeRef.current = 0;
    lastIncidentFrameRef.current = -1;
    fpsCounterRef.current = { frames: 0, lastTime: Date.now() };
    setIncidents([]);
    setState(prev => ({ ...prev, isAnalyzing: true, entities: [], evidence: [], state: "monitoring", error: null }));
    rafRef.current = requestAnimationFrame(runDetection);
  }, [runDetection]);

  const stopAnalysis = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    workerRef.current?.postMessage({ type: "STOP" });
    videoRef.current = null;
    setState(prev => ({ ...prev, isAnalyzing: false, state: "monitoring" }));
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

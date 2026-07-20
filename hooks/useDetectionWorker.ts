"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { FrameScheduler } from "@/lib/worker/frame-scheduler";
import type { EnvMode, WorkerOutput, SerializedEntity, SerializedEvidence } from "@/lib/worker/message-types";

export interface DetectionState {
  isReady: boolean;
  isAnalyzing: boolean;
  state: string; // monitoring | alert
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

export function useDetectionWorker(
  initialMode: EnvMode = "isolated"
): UseDetectionWorkerReturn {
  const workerRef = useRef<Worker | null>(null);
  const schedulerRef = useRef<FrameScheduler | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const alertTimeoutRef = useRef<NodeJS.Timeout | null>(null);

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

  const [mode, setModeState] = useState<EnvMode>(initialMode);
  const [incidents, setIncidents] = useState<Array<{ type: string; severity: string; confidence: number; timestamp: string }>>([]);

  // Initialize worker on mount
  useEffect(() => {
    const worker = new Worker(
      new URL("@/lib/worker/detection-worker.ts", import.meta.url),
      { type: "module" }
    );

    worker.onmessage = (e: MessageEvent<WorkerOutput>) => {
      const msg = e.data;

      switch (msg.type) {
        case "READY":
          worker.postMessage({ type: "INIT", envMode: mode });
          break;

        case "MODEL_LOADED":
          setState(prev => ({ ...prev, isReady: true, error: null }));
          console.log(`[SAGE] Detection worker ready (${msg.backend})`);
          break;

        case "MODEL_ERROR":
          setState(prev => ({ ...prev, error: msg.error }));
          console.error("[SAGE] Model error:", msg.error);
          break;

        case "RESULTS": {
          setState(prev => ({
            ...prev,
            entities: msg.entities,
            evidence: msg.evidence,
            changeGrid: msg.changeGrid,
            state: msg.state,
            fps: msg.fps,
            detectionCount: msg.detectionCount,
          }));

          // Handle alert state transition
          if (msg.state === "alert" && msg.evidence.length > 0) {
            const topEvidence = msg.evidence[0];
            const severity = topEvidence.confidence > 0.8 ? "critical" : "major";

            let incidentType = "vehicle_collision";
            if (topEvidence.type === "person_fall") incidentType = "pedestrian_collision";
            else if (topEvidence.type === "bike_off_track") incidentType = "vehicle_collision";

            setIncidents(prev => [
              ...prev,
              {
                type: incidentType,
                severity,
                confidence: topEvidence.confidence,
                timestamp: new Date().toISOString(),
              },
            ]);
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
    schedulerRef.current = new FrameScheduler({ targetFPS: 4, maxFrameSkip: 3 });

    return () => {
      schedulerRef.current?.stop();
      worker.postMessage({ type: "DISPOSE" });
      worker.terminate();
      if (alertTimeoutRef.current) clearTimeout(alertTimeoutRef.current);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const startAnalysis = useCallback((video: HTMLVideoElement) => {
    const worker = workerRef.current;
    const scheduler = schedulerRef.current;
    if (!worker || !scheduler) return;

    videoRef.current = video;
    setIncidents([]);
    setState(prev => ({
      ...prev,
      isAnalyzing: true,
      entities: [],
      evidence: [],
      state: "monitoring",
      error: null,
    }));

    scheduler.start(worker, video);
  }, []);

  const stopAnalysis = useCallback(() => {
    schedulerRef.current?.stop();
    workerRef.current?.postMessage({ type: "STOP" });
    setState(prev => ({ ...prev, isAnalyzing: false, state: "monitoring" }));
    if (alertTimeoutRef.current) {
      clearTimeout(alertTimeoutRef.current);
      alertTimeoutRef.current = null;
    }
  }, []);

  const setMode = useCallback((newMode: EnvMode) => {
    setModeState(newMode);
    workerRef.current?.postMessage({ type: "SET_MODE", envMode: newMode });
  }, []);

  return {
    ...state,
    startAnalysis,
    stopAnalysis,
    setMode,
    incidents,
  };
}

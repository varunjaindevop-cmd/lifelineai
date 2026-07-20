"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { loadModel, detect, toPixelDetections, isModelReady } from "@/lib/detection/onnx-engine";
import { MultiObjectTracker, type TrackedEntity } from "@/lib/detection/kalman-tracker";
import { FrameMemory } from "@/lib/detection/frame-memory";
import { FrameBuffer, encodeClip, uploadClip } from "@/lib/detection/clip-capture";
import { createIncident } from "@/lib/alerts/alert-service";
import { createClient } from "@/lib/supabase/client";

// ── Types ───────────────────────────────────────────────────────
interface DetectionState {
  isReady: boolean;
  isAnalyzing: boolean;
  detections: any[];
  entities: any[];
  state: string;
  fps: number;
  incidentCount: number;
  lastAlert: any | null;
  error: string | null;
}

// ── IoU helper ──────────────────────────────────────────────────
function iou(
  ax: number, ay: number, aw: number, ah: number,
  bx: number, by: number, bw: number, bh: number
): number {
  const ix1 = Math.max(ax - aw / 2, bx - bw / 2);
  const iy1 = Math.max(ay - ah / 2, by - bh / 2);
  const ix2 = Math.min(ax + aw / 2, bx + bw / 2);
  const iy2 = Math.min(ay + ah / 2, by + bh / 2);
  const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
  const areaA = aw * ah;
  const areaB = bw * bh;
  return inter / (areaA + areaB - inter + 1e-6);
}

// ── Hook ────────────────────────────────────────────────────────
export function useDetection(cameraId: string, latitude: number, longitude: number) {
  const [state, setState] = useState<DetectionState>({
    isReady: false,
    isAnalyzing: false,
    detections: [],
    entities: [],
    state: "monitoring",
    fps: 0,
    incidentCount: 0,
    lastAlert: null,
    error: null,
  });

  const trackerRef = useRef(new MultiObjectTracker());
  const memoryRef = useRef(new FrameMemory());
  const frameBufferRef = useRef(new FrameBuffer(5, 15));
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef(0);
  const lastFrameTimeRef = useRef(0);
  const frameCountRef = useRef(0);
  const fpsCounterRef = useRef({ frames: 0, lastTime: 0 });
  const supabase = createClient();

  // ── Load ONNX model ──
  useEffect(() => {
    loadModel("/models/best.onnx")
      .then(() => setState((prev) => ({ ...prev, isReady: true })))
      .catch((e) => setState((prev) => ({ ...prev, error: e.message })));

    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  // ── Detection loop ──
  const runDetection = useCallback(async () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !isModelReady()) return;
    if (video.paused || video.ended || video.readyState < 2) {
      rafRef.current = requestAnimationFrame(runDetection);
      return;
    }

    const now = performance.now();
    // Throttle to ~4 FPS
    if (now - lastFrameTimeRef.current < 250) {
      rafRef.current = requestAnimationFrame(runDetection);
      return;
    }
    lastFrameTimeRef.current = now;
    frameCountRef.current++;

    // FPS
    fpsCounterRef.current.frames++;
    if (now - fpsCounterRef.current.lastTime > 1000) {
      const fps = Math.round(
        (fpsCounterRef.current.frames * 1000) / (now - fpsCounterRef.current.lastTime)
      );
      fpsCounterRef.current = { frames: 0, lastTime: now };
      setState((prev) => ({ ...prev, fps }));
    }

    // Extract frame
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

    // Add to frame buffer for clip capture
    frameBufferRef.current.addFrame(imageData);

    // ONNX inference
    let dets: any[] = [];
    try {
      dets = await detect(imageData);
    } catch {}

    const pixelDets = toPixelDetections(dets, canvas.width, canvas.height);

    // Kalman tracking
    const entities = trackerRef.current.update(pixelDets, frameCountRef.current);
    const valid = entities.filter((e) => e.age >= 1);

    // Frame memory
    memoryRef.current.addFrame({
      frame: frameCountRef.current,
      timestamp: Date.now(),
      entities: valid.map((e) => ({
        id: e.id,
        class: e.class,
        x: e.kalman.getState().x,
        y: e.kalman.getState().y,
        speed: e.speed,
        heading: e.heading,
      })),
    });

    // Simple collision detection (same rules as worker)
    let alertTriggered = false;
    let alertType: string | null = null;
    let alertConfidence = 0;

    const vehicles = valid.filter(
      (e) => e.age >= 3 && ["car", "truck", "bus", "motorcycle"].includes(e.class)
    );
    const people = valid.filter((e) => e.age >= 3 && e.class === "person");
    const allPairs = [...vehicles, ...people];

    for (let i = 0; i < allPairs.length; i++) {
      for (let j = i + 1; j < allPairs.length; j++) {
        const a = allPairs[i];
        const b = allPairs[j];
        if (a.class === "person" && b.class === "person") continue;

        const iouVal = iou(
          a.kalman.getState().x, a.kalman.getState().y, a.w, a.h,
          b.kalman.getState().x, b.kalman.getState().y, b.w, b.h
        );

        if (iouVal >= 0.2) {
          alertTriggered = true;
          alertType = "vehicle_collision";
          alertConfidence = Math.min(0.95, iouVal);
        }
      }
    }

    // Check fallen_person
    const fallen = valid.filter((e) => e.class === "fallen_person" && e.confidence >= 0.6);
    if (fallen.length > 0 && fallen[0].age >= 3) {
      alertTriggered = true;
      alertType = "pedestrian_fall";
      alertConfidence = Math.min(0.9, fallen[0].confidence);
    }

    setState((prev) => ({
      ...prev,
      detections: dets,
      entities: valid.map((e) => ({
        id: e.id,
        class: e.class,
        confidence: e.confidence,
        speed: e.speed,
        heading: e.heading,
        w: e.w,
        h: e.h,
        age: e.age,
      })),
      state: alertTriggered ? "alert" : "monitoring",
    }));

    // Handle alert
    if (alertTriggered && alertType) {
      const severity =
        alertConfidence > 0.8 ? "critical" : alertConfidence > 0.6 ? "major" : "minor";

      const clipBlob = await encodeClip(frameBufferRef.current.getPreRollFrames(), [], 640, 480);
      let videoClipUrl: string | undefined;
      if (clipBlob) {
        const tempId = `clip-${Date.now()}`;
        videoClipUrl = (await uploadClip(supabase, tempId, clipBlob)) || undefined;
      }

      const incidentId = await createIncident({
        severity,
        incidentType: alertType,
        latitude,
        longitude,
        cameraId,
        videoClipUrl,
        detectionConfidence: alertConfidence,
        detectionData: {
          objects: valid.map((e) => ({ class: e.class, speed: e.speed })),
        },
      });

      setState((prev) => ({
        ...prev,
        incidentCount: prev.incidentCount + 1,
        lastAlert: {
          id: incidentId,
          type: alertType,
          severity,
          confidence: alertConfidence,
          timestamp: new Date(),
        },
      }));
    }

    rafRef.current = requestAnimationFrame(runDetection);
  }, [cameraId, latitude, longitude, supabase]);

  // ── Start analysis ──
  const startAnalysis = useCallback(
    async (videoElement: HTMLVideoElement, canvasElement: HTMLCanvasElement) => {
      videoRef.current = videoElement;
      canvasRef.current = canvasElement;

      // Try to start browser camera if no video source
      try {
        if (!videoElement.srcObject) {
          const stream = await navigator.mediaDevices.getUserMedia({
            video: { width: 640, height: 480 },
          });
          videoElement.srcObject = stream;
          await videoElement.play();
        }
      } catch {
        // Not a camera — assume video file is playing
      }

      setState((prev) => ({
        ...prev,
        isAnalyzing: true,
        fps: 0,
        incidentCount: 0,
        lastAlert: null,
      }));

      lastFrameTimeRef.current = 0;
      fpsCounterRef.current = { frames: 0, lastTime: performance.now() };
      frameCountRef.current = 0;
      trackerRef.current.reset();
      memoryRef.current.clear();
      frameBufferRef.current.clear();

      rafRef.current = requestAnimationFrame(runDetection);
    },
    [runDetection]
  );

  // ── Stop analysis ──
  const stopAnalysis = useCallback(() => {
    cancelAnimationFrame(rafRef.current);

    if (videoRef.current?.srcObject) {
      const tracks = (videoRef.current.srcObject as MediaStream).getTracks();
      tracks.forEach((track) => track.stop());
    }

    setState((prev) => ({ ...prev, isAnalyzing: false, state: "monitoring" }));
  }, []);

  return {
    ...state,
    startAnalysis,
    stopAnalysis,
  };
}

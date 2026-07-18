"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { AccidentDetector } from "@/lib/ai/detector";
import { FrameBuffer, encodeClip, uploadClip } from "@/lib/detection/clip-capture";
import { createIncident } from "@/lib/alerts/alert-service";
import { createClient } from "@/lib/supabase/client";
import { QualityMetrics, Detection, TrackedObject } from "@/lib/ai/types";

interface DetectionState {
  isAnalyzing: boolean;
  detections: Detection[];
  trackedObjects: TrackedObject[];
  quality: QualityMetrics | null;
  adaptiveConfig: any;
  state: string;
  incidentCount: number;
  lastAlert: any | null;
}

export function useDetection(cameraId: string, latitude: number, longitude: number) {
  const [state, setState] = useState<DetectionState>({
    isAnalyzing: false,
    detections: [],
    trackedObjects: [],
    quality: null,
    adaptiveConfig: null,
    state: "monitoring",
    incidentCount: 0,
    lastAlert: null,
  });

  const detectorRef = useRef<AccidentDetector | null>(null);
  const frameBufferRef = useRef<FrameBuffer>(new FrameBuffer(5, 15));
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const supabase = createClient();

  // Initialize detector
  useEffect(() => {
    detectorRef.current = new AccidentDetector(50, 5);
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, []);

  // Capture frame from video
  const captureFrame = useCallback((): ImageData | null => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return null;

    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    canvas.width = 640;
    canvas.height = 480;
    ctx.drawImage(video, 0, 0, 640, 480);

    return ctx.getImageData(0, 0, 640, 480);
  }, []);

  // Start analysis
  const startAnalysis = useCallback(
    async (videoElement: HTMLVideoElement, canvasElement: HTMLCanvasElement) => {
      videoRef.current = videoElement;
      canvasRef.current = canvasElement;

      // Start video if browser camera
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 640, height: 480 },
        });
        videoElement.srcObject = stream;
        await videoElement.play();
      } catch {
        // Not browser camera, assume video file is playing
      }

      setState((prev) => ({ ...prev, isAnalyzing: true }));

      // Analysis loop
      intervalRef.current = setInterval(async () => {
        const frame = captureFrame();
        if (!frame || !detectorRef.current) return;

        // Add to frame buffer
        frameBufferRef.current.addFrame(frame);

        // Process frame
        const result = detectorRef.current.processFrame(frame);

        setState((prev) => ({
          ...prev,
          detections: result.detections,
          trackedObjects: result.trackedObjects,
          quality: result.quality,
          adaptiveConfig: result.adaptiveConfig,
          state: result.state,
        }));

        // Handle alert
        if (result.alert?.triggered) {
          const clipBlob = await encodeClip(
            frameBufferRef.current.getPreRollFrames(),
            [], // Post-roll frames would be captured here
            640,
            480
          );

          let videoClipUrl: string | undefined;
          if (clipBlob) {
            const tempId = `temp-${Date.now()}`;
            videoClipUrl = (await uploadClip(supabase, tempId, clipBlob)) || undefined;
          }

          const incidentId = await createIncident({
            severity: result.alert.severity,
            incidentType: result.alert.type!,
            latitude,
            longitude,
            cameraId,
            vehicleSpeed: result.trackedObjects.find(
              (o) => o.class === "car" && o.speed > 0
            )?.speed,
            videoClipUrl,
            detectionConfidence: result.alert.confidence,
            detectionData: {
              objects: result.trackedObjects.map((o) => ({
                class: o.class,
                speed: o.speed,
              })),
              sceneChangeScore: result.sceneChangeScore,
            },
          });

          setState((prev) => ({
            ...prev,
            incidentCount: prev.incidentCount + 1,
            lastAlert: {
              id: incidentId,
              type: result.alert!.type,
              severity: result.alert!.severity,
              confidence: result.alert!.confidence,
              timestamp: new Date(),
            },
          }));
        }
      }, 200); // 5 FPS
    },
    [cameraId, latitude, longitude, captureFrame, supabase]
  );

  // Stop analysis
  const stopAnalysis = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    if (videoRef.current?.srcObject) {
      const tracks = (videoRef.current.srcObject as MediaStream).getTracks();
      tracks.forEach((track) => track.stop());
    }

    setState((prev) => ({ ...prev, isAnalyzing: false }));
  }, []);

  return {
    ...state,
    startAnalysis,
    stopAnalysis,
  };
}

"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  ArrowLeft,
  Video,
  Play,
  Pause,
  AlertTriangle,
  Clock,
  Navigation,
  RotateCcw,
  Loader2,
} from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";

interface VideoClip {
  name: string;
  src: string;
  description: string;
}

interface Detection {
  class: string;
  confidence: number;
  bbox: [number, number, number, number];
  speed?: number;
  id?: number;
  consecutiveFramesNear?: number;
}

interface IncidentAlert {
  type: string;
  severity: string;
  confidence: number;
  timestamp: string;
  latitude: number;
  longitude: number;
}

interface TrackedBlob {
  id: number;
  class: "person" | "car" | "bike";
  cx: number;
  cy: number;
  w: number;
  h: number;
  vx: number;
  vy: number;
  framesTracked: number;
  lastSeen: number;
  speedKmh: number;
  consecutiveFramesNear: number;
  prevPositions: { x: number; y: number }[];
  classHistory: string[];      // last N classifications for smoothing
}

const VIDEO_CLIPS: VideoClip[] = [
  {
    name: "accident_sample.mp4",
    src: "/videos/accident_sample.mp4",
    description: "Vehicle collision scenario — expect accident detection",
  },
  {
    name: "camera2_demo.mp4",
    src: "/videos/camera2_demo.mp4",
    description: "Camera 2 feed — traffic monitoring demo",
  },
  {
    name: "camera4_demo.mp4",
    src: "/videos/camera4_demo.mp4",
    description: "Camera 4 feed — intersection monitoring demo",
  },
  {
    name: "checking.mp4",
    src: "/videos/checking.mp4",
    description: "Test clip — system verification",
  },
];

const DEMO_LAT = 22.7196;
const DEMO_LNG = 75.8577;

let nextBlobId = 1;

export default function VideoAnalysisPage() {
  const [selectedClip, setSelectedClip] = useState<VideoClip | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [videoReady, setVideoReady] = useState(false);
  const [detections, setDetections] = useState<Detection[]>([]);
  const [incidents, setIncidents] = useState<IncidentAlert[]>([]);
  const [currentState, setCurrentState] = useState("monitoring");
  const [sceneChange, setSceneChange] = useState(0);
  const [demoMode, setDemoMode] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const analysisCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const prevFrameRef = useRef<ImageData | null>(null);
  const stateRef = useRef("monitoring");
  const frameCountRef = useRef(0);
  const trackedBlobsRef = useRef<TrackedBlob[]>([]);
  const alertedRef = useRef(false);
  const stateFrameRef = useRef(0);
  const alertCooldownRef = useRef(0);
  const frameBufferRef = useRef<ImageData[]>([]);
  const avgSceneMotionRef = useRef(0.05); // running average of scene motion
  const supabase = createClient();

  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  useEffect(() => {
    setVideoReady(false);
    prevFrameRef.current = null;
    const timeout = setTimeout(() => setVideoReady(true), 8000);
    return () => clearTimeout(timeout);
  }, [selectedClip]);

  const handleVideoReady = () => setVideoReady(true);
  const handleVideoError = () => {
    setTimeout(() => { if (videoRef.current) videoRef.current.load(); }, 1000);
  };

  const getAnalysisCanvas = useCallback(() => {
    if (!analysisCanvasRef.current) {
      analysisCanvasRef.current = document.createElement("canvas");
    }
    return analysisCanvasRef.current;
  }, []);

  const captureFrame = useCallback((): ImageData | null => {
    const video = videoRef.current;
    if (!video || video.paused || video.ended || video.readyState < 2) return null;
    const canvas = getAnalysisCanvas();
    canvas.width = 320;
    canvas.height = 240;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, 320, 240);
    return ctx.getImageData(0, 0, 320, 240);
  }, [getAnalysisCanvas]);

  // Draw bounding boxes on the visible canvas overlay (scaled from 320x240 to display size)
  const drawDetections = (dets: Detection[]) => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const scaleX = canvas.width / 320;
    const scaleY = canvas.height / 240;

    dets.forEach((det) => {
      const [x1, y1, x2, y2] = det.bbox;
      const sx1 = x1 * scaleX;
      const sy1 = y1 * scaleY;
      const sx2 = x2 * scaleX;
      const sy2 = y2 * scaleY;
      const sw = sx2 - sx1;
      const sh = sy2 - sy1;
      const color = det.class === "person" ? "#3B82F6" : det.class === "bike" ? "#F97316" : "#22C55E";

      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.strokeRect(sx1, sy1, sw, sh);

      const label = `${det.class} ${(det.confidence * 100).toFixed(0)}%${det.speed ? ` | ${det.speed}km/h` : ""}`;
      ctx.font = "bold 13px Arial";
      const textW = ctx.measureText(label).width;
      ctx.fillStyle = color;
      ctx.fillRect(sx1, sy1 - 22, textW + 10, 22);
      ctx.fillStyle = "white";
      ctx.fillText(label, sx1 + 5, sy1 - 6);
    });
  };

  // Motion-based detection — adaptive thresholds based on scene motion level
  const detectMotion = useCallback((currFrame: ImageData, prevFrame: ImageData, avgSceneMotion: number): Detection[] => {
    const w = currFrame.width;
    const h = currFrame.height;
    const curr = currFrame.data;
    const prev = prevFrame.data;

    // Adaptive thresholds: low-motion scenes use lower thresholds to catch subtle events
    const motionThreshold = avgSceneMotion < 0.05 ? 25 : avgSceneMotion < 0.1 ? 30 : 35;
    const minBlobArea = avgSceneMotion < 0.05 ? 400 : avgSceneMotion < 0.1 ? 500 : 600;

    // Step 1: Difference map with adaptive threshold
    const diff = new Uint8Array(w * h);
    for (let i = 0; i < diff.length; i++) {
      const idx = i * 4;
      const grayCurr = curr[idx] * 0.299 + curr[idx + 1] * 0.587 + curr[idx + 2] * 0.114;
      const grayPrev = prev[idx] * 0.299 + prev[idx + 1] * 0.587 + prev[idx + 2] * 0.114;
      diff[i] = Math.abs(grayCurr - grayPrev) > motionThreshold ? 255 : 0;
    }

    // Step 2: Aggressive dilation (merge nearby motion into big blobs)
    const dilated = new Uint8Array(w * h);
    const kernel = 8;
    for (let y = kernel; y < h - kernel; y++) {
      for (let x = kernel; x < w - kernel; x++) {
        let max = 0;
        for (let dy = -kernel; dy <= kernel; dy += 2) {
          for (let dx = -kernel; dx <= kernel; dx += 2) {
            if (diff[(y + dy) * w + (x + dx)] > max) max = diff[(y + dy) * w + (x + dx)];
          }
        }
        dilated[y * w + x] = max;
      }
    }

    // Step 3: Connected components — only large blobs survive
    const visited = new Uint8Array(w * h);
    const blobs: { x: number; y: number; w: number; h: number; cx: number; cy: number; area: number; motionDensity: number }[] = [];

    for (let y = kernel; y < h - kernel; y += 4) {
      for (let x = kernel; x < w - kernel; x += 4) {
        if (visited[y * w + x] || dilated[y * w + x] === 0) continue;

        let minX = x, maxX = x, minY = y, maxY = y, sumX = 0, sumY = 0, count = 0;
        const queue = [x, y];
        visited[y * w + x] = 1;

        while (queue.length > 0) {
          const qx = queue.shift()!;
          const qy = queue.shift()!;
          sumX += qx; sumY += qy; count++;
          if (qx < minX) minX = qx; if (qx > maxX) maxX = qx;
          if (qy < minY) minY = qy; if (qy > maxY) maxY = qy;

          for (const [ddx, ddy] of [[-4, 0], [4, 0], [0, -4], [0, 4]]) {
            const nx = qx + ddx, ny = qy + ddy;
            if (nx >= 0 && nx < w && ny >= 0 && ny < h && !visited[ny * w + nx] && dilated[ny * w + nx] > 0) {
              visited[ny * w + nx] = 1;
              queue.push(nx, ny);
            }
          }
        }

        const blobW = maxX - minX;
        const blobH = maxY - minY;
        const area = blobW * blobH;

        // Adaptive minimum blob size
        if (area < minBlobArea || count < 30) continue;

        // Motion density: what % of the bounding box is actually moving
        const motionDensity = count / Math.max(area / 16, 1);

        blobs.push({
          x: minX, y: minY, w: blobW, h: blobH,
          cx: sumX / count, cy: sumY / count,
          area, motionDensity,
        });
      }
    }

    // Step 4: Strict classification — only confident detections
    const dets: Detection[] = [];
    const MAX_OBJECTS = 5; // hard cap on tracked objects

    for (const blob of blobs) {
      if (dets.length >= MAX_OBJECTS) break;

      const aspectRatio = blob.w / Math.max(blob.h, 1);
      const heightRatio = blob.h / Math.max(blob.w, 1);

      let classification: "person" | "car" | "bike" | null = null;
      let confidence = 0;

      // CAR: large area + wide aspect ratio — high confidence
      if (blob.area > 2500 && aspectRatio > 1.2) {
        classification = "car";
        confidence = Math.min(0.95, 0.7 + blob.area / 10000);
      }
      // PERSON: tall + narrow + small — high confidence
      else if (heightRatio > 1.5 && blob.area < 1200 && blob.area > 600) {
        classification = "person";
        confidence = Math.min(0.90, 0.65 + blob.area / 3000);
      }
      // BIKE: medium area, roughly square
      else if (blob.area > 1000 && blob.area < 2500 && aspectRatio > 0.7 && aspectRatio < 1.3) {
        classification = "bike";
        confidence = Math.min(0.85, 0.6 + blob.area / 5000);
      }
      // LARGE but ambiguous — could be car at angle
      else if (blob.area > 3000) {
        classification = "car";
        confidence = Math.min(0.85, 0.6 + blob.area / 8000);
      }

      // SKIP low-confidence detections entirely
      if (!classification || confidence < 0.65) continue;

      dets.push({
        class: classification,
        confidence,
        bbox: [blob.x, blob.y, blob.x + blob.w, blob.y + blob.h] as [number, number, number, number],
        speed: classification === "car" ? 0 : undefined,
      });
    }

    return dets;
  }, []);

  // Match new detections to tracked blobs
  const trackBlobs = useCallback((dets: Detection[], frameNum: number): Detection[] => {
    const tracked = trackedBlobsRef.current;
    const matched = new Set<number>();
    const FPS = 4; // analysis runs at ~4fps

    // Match existing tracked blobs to new detections by proximity
    for (const blob of tracked) {
      let bestIdx = -1;
      let bestDist = 60;

      for (let i = 0; i < dets.length; i++) {
        if (matched.has(i)) continue;
        const d = dets[i];
        const dcx = (d.bbox[0] + d.bbox[2]) / 2;
        const dcy = (d.bbox[1] + d.bbox[3]) / 2;
        const dist = Math.sqrt((blob.cx - dcx) ** 2 + (blob.cy - dcy) ** 2);
        if (dist < bestDist) {
          bestDist = dist;
          bestIdx = i;
        }
      }

      if (bestIdx >= 0) {
        const d = dets[bestIdx];
        const newCx = (d.bbox[0] + d.bbox[2]) / 2;
        const newCy = (d.bbox[1] + d.bbox[3]) / 2;
        blob.vx = newCx - blob.cx;
        blob.vy = newCy - blob.cy;
        blob.cx = newCx;
        blob.cy = newCy;
        blob.w = d.bbox[2] - d.bbox[0];
        blob.h = d.bbox[3] - d.bbox[1];
        blob.class = d.class as "person" | "car" | "bike";
        blob.framesTracked++;
        blob.lastSeen = frameNum;
        matched.add(bestIdx);

        // Compute speed from centroid displacement
        // ~2 pixels per meter for 320x240 CCTV at typical road distance
        const PPM = 2;
        const pixelDist = Math.sqrt(blob.vx ** 2 + blob.vy ** 2);
        const rawSpeedKmh = (pixelDist / PPM) * FPS * 3.6;

        // Smooth positions over last 8 frames
        blob.prevPositions.push({ x: newCx, y: newCy });
        if (blob.prevPositions.length > 8) blob.prevPositions.shift();

        if (blob.prevPositions.length >= 3) {
          const positions = blob.prevPositions;
          const oldest = positions[0];
          const newest = positions[positions.length - 1];
          const totalDist = Math.sqrt((newest.x - oldest.x) ** 2 + (newest.y - oldest.y) ** 2);
          const totalFrames = positions.length - 1;
          const avgPixelPerFrame = totalDist / totalFrames;
          const smoothedSpeedKmh = (avgPixelPerFrame / PPM) * FPS * 3.6;
          blob.speedKmh = Math.round(Math.max(15, Math.min(90, smoothedSpeedKmh)));
        } else {
          blob.speedKmh = Math.round(Math.max(15, Math.min(90, rawSpeedKmh)));
        }

        // Classification smoothing: use majority vote over last 5 frames
        blob.classHistory.push(d.class);
        if (blob.classHistory.length > 5) blob.classHistory.shift();
        if (blob.classHistory.length >= 3) {
          const counts: Record<string, number> = {};
          for (const c of blob.classHistory) counts[c] = (counts[c] || 0) + 1;
          const majority = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
          blob.class = majority as "person" | "car" | "bike";
        }
      } else {
        blob.framesTracked = 0;
      }
    }

    // Create new tracked blobs for unmatched detections
    for (let i = 0; i < dets.length; i++) {
      if (matched.has(i)) continue;
      const d = dets[i];
      const cx = (d.bbox[0] + d.bbox[2]) / 2;
      const cy = (d.bbox[1] + d.bbox[3]) / 2;
      tracked.push({
        id: nextBlobId++,
        class: d.class as "person" | "car" | "bike",
        cx,
        cy,
        w: d.bbox[2] - d.bbox[0],
        h: d.bbox[3] - d.bbox[1],
        vx: 0,
        vy: 0,
        framesTracked: 1,
        lastSeen: frameNum,
        speedKmh: 0,
        consecutiveFramesNear: 0,
        prevPositions: [{ x: cx, y: cy }],
        classHistory: [d.class],
      });
    }

    // Remove blobs not seen for 5 frames, cap at 5 tracked objects
    trackedBlobsRef.current = tracked
      .filter((b) => frameNum - b.lastSeen < 5)
      .sort((a, b) => b.framesTracked - a.framesTracked)
      .slice(0, 5);

    // Return objects tracked for 5+ frames
    return trackedBlobsRef.current
      .filter((b) => b.framesTracked >= 5)
      .map((b) => ({
        class: b.class,
        confidence: Math.min(0.95, 0.7 + b.framesTracked * 0.02),
        bbox: [b.cx - b.w / 2, b.cy - b.h / 2, b.cx + b.w / 2, b.cy + b.h / 2] as [number, number, number, number],
        speed: b.class === "car" ? b.speedKmh : undefined,
        id: b.id,
      }));
  }, []);

  const calculateSceneChange = (prev: ImageData, curr: ImageData): number => {
    let diff = 0;
    const step = 8;
    let count = 0;
    for (let i = 0; i < prev.data.length; i += step * 4) {
      const pg = prev.data[i] * 0.299 + prev.data[i + 1] * 0.587 + prev.data[i + 2] * 0.114;
      const cg = curr.data[i] * 0.299 + curr.data[i + 1] * 0.587 + curr.data[i + 2] * 0.114;
      diff += Math.abs(pg - cg);
      count++;
    }
    return count > 0 ? diff / count / 255 : 0;
  };

  const checkForAccident = (tracked: TrackedBlob[], sceneScore: number): IncidentAlert | null => {
    // Check objects tracked for 6+ frames (confirmed objects)
    const vehicles = tracked.filter((b) => (b.class === "car" || b.class === "bike") && b.framesTracked >= 6);
    const persons = tracked.filter((b) => b.class === "person" && b.framesTracked >= 6);

    // Vehicle-vehicle collision
    for (let i = 0; i < vehicles.length; i++) {
      for (let j = i + 1; j < vehicles.length; j++) {
        const a = vehicles[i];
        const b = vehicles[j];

        // Bounding box overlap
        const aLeft = a.cx - a.w / 2, aRight = a.cx + a.w / 2;
        const aTop = a.cy - a.h / 2, aBot = a.cy + a.h / 2;
        const bLeft = b.cx - b.w / 2, bRight = b.cx + b.w / 2;
        const bTop = b.cy - b.h / 2, bBot = b.cy + b.h / 2;
        const overlapX = Math.max(0, Math.min(aRight, bRight) - Math.max(aLeft, bLeft));
        const overlapY = Math.max(0, Math.min(aBot, bBot) - Math.max(aTop, bTop));
        const overlapArea = overlapX * overlapY;
        const aArea = a.w * a.h;
        const bArea = b.w * b.h;
        const minArea = Math.min(aArea, bArea);
        const iou = (aArea + bArea - overlapArea) > 0 ? overlapArea / (aArea + bArea - overlapArea) : 0;

        // Direction analysis
        const aAngle = Math.atan2(a.vy, a.vx);
        const bAngle = Math.atan2(b.vy, b.vx);
        const angleDiff = Math.abs(aAngle - bAngle);
        const parallel = angleDiff < Math.PI * 0.3 || angleDiff > Math.PI * 1.7;

        // Track sustained proximity — need 6+ consecutive frames
        const closeThreshold = Math.max(a.w, b.w) * 0.8;
        if (Math.sqrt((a.cx - b.cx) ** 2 + (a.cy - b.cy) ** 2) < closeThreshold) {
          a.consecutiveFramesNear++;
          b.consecutiveFramesNear++;
        } else {
          a.consecutiveFramesNear = Math.max(0, a.consecutiveFramesNear - 2);
          b.consecutiveFramesNear = Math.max(0, b.consecutiveFramesNear - 2);
        }

        const sustainedNear = Math.min(a.consecutiveFramesNear, b.consecutiveFramesNear);

        // REQUIREMENT 1: ACTUAL overlap — 10% of smaller object
        const hasOverlap = overlapArea > minArea * 0.10;

        // REQUIREMENT 2: Sustained 6+ frames AND not parallel
        const sustained = sustainedNear >= 6 && !parallel;

        if (hasOverlap || sustained) {
          const confidence = Math.min(0.95,
            0.35 * Math.min(iou * 6, 1) +
            0.3 * (hasOverlap ? 1 : 0) +
            0.2 * (!parallel ? 1 : 0) +
            0.15 * Math.min(sceneScore / 0.25, 1)
          );

          if (confidence > 0.65) {
            return {
              type: "vehicle_collision",
              severity: confidence > 0.8 ? "critical" : "major",
              confidence,
              timestamp: new Date().toISOString(),
              latitude: DEMO_LAT + (Math.random() - 0.5) * 0.01,
              longitude: DEMO_LNG + (Math.random() - 0.5) * 0.01,
            };
          }
        }
      }
    }

    // Vehicle-pedestrian: ONLY actual overlap, nothing else
    for (const vehicle of vehicles) {
      for (const ped of persons) {
        const vLeft = vehicle.cx - vehicle.w / 2, vRight = vehicle.cx + vehicle.w / 2;
        const vTop = vehicle.cy - vehicle.h / 2, vBot = vehicle.cy + vehicle.h / 2;
        const pLeft = ped.cx - ped.w / 2, pRight = ped.cx + ped.w / 2;
        const pTop = ped.cy - ped.h / 2, pBot = ped.cy + ped.h / 2;
        const overlapX = Math.max(0, Math.min(vRight, pRight) - Math.max(vLeft, pLeft));
        const overlapY = Math.max(0, Math.min(vBot, pBot) - Math.max(vTop, pTop));
        const overlapArea = overlapX * overlapY;
        const minArea = Math.min(vehicle.w * vehicle.h, ped.w * ped.h);

        // ONLY trigger on ACTUAL overlap — 10% of smaller object
        if (overlapArea > minArea * 0.10) {
          return {
            type: "pedestrian_collision",
            severity: "critical",
            confidence: 0.9,
            timestamp: new Date().toISOString(),
            latitude: DEMO_LAT + (Math.random() - 0.5) * 0.01,
            longitude: DEMO_LNG + (Math.random() - 0.5) * 0.01,
          };
        }
      }
    }

    return null;
  };

  const recordClipAndAlert = async (alert: IncidentAlert) => {
    // Record the clip as an encoded image composite (reliable, no MediaRecorder)
    const frames = frameBufferRef.current;
    let clipUrl: string | undefined;

    // Try to encode frames as a single composite image (strip of frames)
    if (frames.length >= 4) {
      try {
        const COLS = 4;
        const ROWS = Math.min(3, Math.ceil(frames.length / COLS));
        const FRAME_W = 240;
        const FRAME_H = 180;
        const canvas = document.createElement("canvas");
        canvas.width = COLS * FRAME_W;
        canvas.height = ROWS * FRAME_H;
        const ctx = canvas.getContext("2d")!;

        // Draw sampled frames in a grid
        const step = Math.max(1, Math.floor(frames.length / (COLS * ROWS)));
        let idx = 0;
        for (let row = 0; row < ROWS && idx < frames.length; row++) {
          for (let col = 0; col < COLS && idx < frames.length; col++) {
            const frame = frames[Math.min(idx * step, frames.length - 1)];
            const tmpCanvas = document.createElement("canvas");
            tmpCanvas.width = 320;
            tmpCanvas.height = 240;
            const tmpCtx = tmpCanvas.getContext("2d")!;
            tmpCtx.putImageData(frame, 0, 0);
            ctx.drawImage(tmpCanvas, col * FRAME_W, row * FRAME_H, FRAME_W, FRAME_H);
            idx++;
          }
        }

        // Draw detection boxes on the last frame
        const lastFrame = frames[frames.length - 1];
        const tmpCanvas = document.createElement("canvas");
        tmpCanvas.width = 320;
        tmpCanvas.height = 240;
        const tmpCtx = tmpCanvas.getContext("2d")!;
        tmpCtx.putImageData(lastFrame, 0, 0);

        const blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, "image/jpeg", 0.85)
        );

        if (blob && blob.size > 1000) {
          const filename = `clips/${Date.now()}-frames.jpg`;
          const { data } = await supabase.storage
            .from("incident-clips")
            .upload(filename, blob, { contentType: "image/jpeg" });

          if (data) {
            const { data: urlData } = supabase.storage
              .from("incident-clips")
              .getPublicUrl(filename);
            clipUrl = urlData?.publicUrl;
          }
        }
      } catch (err) {
        console.error("Frame encoding failed:", err);
      }
    }

    // Determine the best clip URL: prefer source video, fallback to encoded frames
    const videoSrc = selectedClip?.src || null;
    const videoTime = videoRef.current ? Math.floor(videoRef.current.currentTime) : 0;

    // Store source video info in detection_data so ambulance can play the actual clip
    const detectionData = {
      source: "video_analysis",
      clip: selectedClip?.name,
      video_src: videoSrc,
      video_timestamp: videoTime,
      frames_captured: frames.length,
    };

    // Create incident
    const { data: incident, error } = await supabase
      .from("incidents")
      .insert({
        severity: alert.severity,
        incident_type: alert.type,
        latitude: alert.latitude,
        longitude: alert.longitude,
        location_name: `Video Analysis: ${selectedClip?.name}`,
        detection_confidence: alert.confidence,
        detection_data: detectionData,
        video_clip_url: clipUrl || videoSrc || null,
        status: "detected",
      })
      .select()
      .single();

    if (error) {
      console.error("Incident insert error:", error);
      setIncidents((prev) => [...prev, { ...alert, video_clip_url: clipUrl || videoSrc || undefined }]);
      toast.error(`ACCIDENT DETECTED: ${alert.type.replace(/_/g, " ")} (${alert.severity})`);
      return;
    }

    setIncidents((prev) => [...prev, { ...alert, video_clip_url: clipUrl || videoSrc || undefined }]);
    toast.error(`ACCIDENT DETECTED: ${alert.type.replace(/_/g, " ")} (${alert.severity}) — dispatching ambulance!`);

    // Broadcast to ambulance with full data
    supabase.channel("alerts:ambulance").send({
      type: "broadcast",
      event: "new_incident",
      payload: {
        incident_id: incident.id,
        severity: alert.severity,
        incident_type: alert.type,
        latitude: alert.latitude,
        longitude: alert.longitude,
        video_clip_url: clipUrl || videoSrc,
        video_src: videoSrc,
        video_timestamp: videoTime,
        message: `ACCIDENT from video analysis: ${alert.type.replace(/_/g, " ")}`,
      },
    });

    // If we later get a better clip URL, update it
    if (clipUrl && clipUrl !== videoSrc) {
      await supabase.from("incidents").update({ video_clip_url: clipUrl }).eq("id", incident.id);
      supabase.channel("alerts:ambulance").send({
        type: "broadcast",
        event: "clip_ready",
        payload: { incident_id: incident.id, video_clip_url: clipUrl },
      });
    }
  };

  const startAnalysis = async () => {
    if (!videoRef.current || !selectedClip) return;

    const video = videoRef.current;
    try {
      await video.play();
    } catch {
      video.muted = false;
      try { await video.play(); } catch {
        toast.error("Could not play video. Try again.");
        return;
      }
    }

    setVideoReady(true);
    setIsAnalyzing(true);
    setDetections([]);
    setIncidents([]);
    setCurrentState("monitoring");
    stateRef.current = "monitoring";
    stateFrameRef.current = 0;
    prevFrameRef.current = null;
    frameCountRef.current = 0;
    alertedRef.current = false;
    alertCooldownRef.current = 0;
    trackedBlobsRef.current = [];
    frameBufferRef.current = [];
    nextBlobId = 1;

    await new Promise((r) => setTimeout(r, 300));

    intervalRef.current = setInterval(() => {
      const frame = captureFrame();
      if (!frame) return;

      frameCountRef.current++;
      const fn = frameCountRef.current;

      // Maintain 60-frame buffer (~15s) for clip recording
      frameBufferRef.current.push(frame);
      if (frameBufferRef.current.length > 60) frameBufferRef.current.shift();

      // Alert cooldown (60 frames = 15 seconds between alerts)
      if (alertCooldownRef.current > 0) alertCooldownRef.current--;

      // Scene change
      let sceneScore = 0;
      if (prevFrameRef.current) {
        sceneScore = calculateSceneChange(prevFrameRef.current, frame);
      }
      setSceneChange(sceneScore);

      // Update running average scene motion
      avgSceneMotionRef.current = avgSceneMotionRef.current * 0.9 + sceneScore * 0.1;

      // Real motion detection + tracking with adaptive thresholds
      let dets: Detection[];
      if (prevFrameRef.current) {
        const motionDets = detectMotion(frame, prevFrameRef.current, avgSceneMotionRef.current);
        dets = trackBlobs(motionDets, fn);
      } else {
        dets = [];
      }

      prevFrameRef.current = frame;
      setDetections(dets);
      drawDetections(dets);

      // State machine
      stateFrameRef.current++;
      const sf = stateFrameRef.current;

      // Check for real collision from tracked objects
      const accident = checkForAccident(trackedBlobsRef.current, sceneScore);

      let state = stateRef.current;

      if (accident) {
        // Only progress state on REAL detections
        if (state === "monitoring") state = "watching";
        else if (state === "watching") state = "confirming";
        else if (state === "confirming") state = "alert";
      } else if (!demoMode) {
        // REAL mode: decay back to monitoring if no sustained accident signal
        if (state !== "monitoring" && sf % 5 === 0) {
          state = state === "alert" ? "confirming" : state === "confirming" ? "watching" : "monitoring";
        }
      }

      // Demo mode: time-based progression (for testing only)
      if (demoMode) {
        if (sf === 15 && state === "monitoring") state = "watching";
        if (sf === 25 && state === "watching") state = "confirming";
        if (sf >= 35 && state === "confirming") state = "alert";
      }

      // Trigger alert
      if (state === "alert" && stateRef.current !== "alert" && alertCooldownRef.current <= 0) {
        alertCooldownRef.current = 80; // 20 second cooldown

        const alertData: IncidentAlert = accident || {
          type: "vehicle_collision",
          severity: demoMode ? "critical" : "major",
          confidence: demoMode ? 0.88 : 0.7,
          timestamp: new Date().toISOString(),
          latitude: DEMO_LAT + (Math.random() - 0.5) * 0.01,
          longitude: DEMO_LNG + (Math.random() - 0.5) * 0.01,
        };

        recordClipAndAlert(alertData);

        setTimeout(() => {
          stateRef.current = "monitoring";
          stateFrameRef.current = 0;
          setCurrentState("monitoring");
        }, 5000);
      }

      stateRef.current = state;
      setCurrentState(state);
    }, 250);
  };

  const stopAnalysis = () => {
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
    if (videoRef.current) { videoRef.current.pause(); videoRef.current.currentTime = 0; }
    setIsAnalyzing(false);
    setCurrentState("monitoring");
    stateRef.current = "monitoring";
  };

  const resetClip = () => {
    stopAnalysis();
    setDetections([]);
    setIncidents([]);
    setSceneChange(0);
    prevFrameRef.current = null;
    frameCountRef.current = 0;
    stateFrameRef.current = 0;
    alertedRef.current = false;
    trackedBlobsRef.current = [];
  };

  const stateColors: Record<string, string> = {
    monitoring: "bg-green-500/20 text-green-500",
    watching: "bg-yellow-500/20 text-yellow-500",
    confirming: "bg-orange-500/20 text-orange-500",
    alert: "bg-red-500/20 text-red-500 animate-pulse",
  };

  return (
    <div className="space-y-6">
      <Link href="/admin" className="inline-flex items-center gap-2 text-muted-foreground hover:text-foreground">
        <ArrowLeft size={16} />
        Back to Admin
      </Link>

      <div>
        <h1 className="text-2xl font-bold">Video Analysis</h1>
        <p className="text-muted-foreground">
          AI-powered analysis of camera clips — accidents auto-dispatch ambulance
        </p>
      </div>

      {!selectedClip ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {VIDEO_CLIPS.map((clip) => (
            <button
              key={clip.name}
              onClick={() => setSelectedClip(clip)}
              className="bg-card p-5 rounded-xl border border-border hover:border-primary/50 transition-colors text-left"
            >
              <div className="flex items-start gap-4">
                <div className="w-16 h-16 bg-background rounded-lg flex items-center justify-center shrink-0">
                  <Video className="w-8 h-8 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="font-semibold truncate">{clip.name}</h3>
                  <p className="text-sm text-muted-foreground mt-1">{clip.description}</p>
                  <div className="mt-3 flex items-center gap-2">
                    <span className="px-2 py-1 bg-primary/20 text-primary rounded text-xs">AI Analysis</span>
                    <span className="px-2 py-1 bg-background rounded text-xs">{clip.src}</span>
                  </div>
                </div>
              </div>
            </button>
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          <button
            onClick={() => { resetClip(); setSelectedClip(null); setVideoReady(false); }}
            className="text-sm text-primary hover:underline"
          >
            &larr; Choose different clip
          </button>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2 space-y-4">
              <div className="bg-card rounded-xl border border-border overflow-hidden">
                <div className="aspect-video bg-black relative">
                  <video
                    ref={videoRef}
                    src={selectedClip.src}
                    className="w-full h-full object-contain"
                    playsInline muted loop
                    onLoadedData={handleVideoReady}
                    onCanPlay={handleVideoReady}
                    onError={handleVideoError}
                  />
                  <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" style={{ pointerEvents: "none" }} />

                  {!videoReady && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/50">
                      <div className="flex items-center gap-2 text-white">
                        <Loader2 className="w-5 h-5 animate-spin" />
                        <span className="text-sm">Loading video...</span>
                      </div>
                    </div>
                  )}

                  {isAnalyzing && (
                    <>
                      <div className="absolute top-4 left-4 flex items-center gap-2">
                        <div className="w-3 h-3 bg-red-500 rounded-full animate-pulse" />
                        <span className="text-sm font-medium bg-black/60 px-2 py-1 rounded">AI Analyzing</span>
                      </div>
                      <div className="absolute top-4 right-4 bg-black/60 px-3 py-1 rounded text-sm">
                        Objects: {detections.length}
                      </div>
                    </>
                  )}
                </div>

                <div className="p-4 border-t border-border flex items-center gap-3 flex-wrap">
                  {!isAnalyzing ? (
                    <button onClick={startAnalysis} disabled={!videoReady}
                      className="px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed">
                      {videoReady ? <Play size={16} /> : <Loader2 size={16} className="animate-spin" />}
                      {videoReady ? "Start AI Analysis" : "Loading..."}
                    </button>
                  ) : (
                    <>
                      <button onClick={stopAnalysis} className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors flex items-center gap-2">
                        <Pause size={16} /> Stop
                      </button>
                      <button onClick={resetClip} className="px-4 py-2 bg-card border border-border rounded-lg hover:bg-background transition-colors flex items-center gap-2">
                        <RotateCcw size={16} /> Reset
                      </button>
                    </>
                  )}

                  {/* Demo Mode toggle */}
                  <label className="flex items-center gap-2 text-sm cursor-pointer select-none ml-auto">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${demoMode ? "bg-yellow-500/20 text-yellow-500" : "bg-green-500/20 text-green-500"}`}>
                      {demoMode ? "DEMO" : "REAL"}
                    </span>
                    <div
                      onClick={() => !isAnalyzing && setDemoMode(!demoMode)}
                      className={`w-10 h-5 rounded-full transition-colors relative ${demoMode ? "bg-yellow-500" : "bg-green-600"}`}
                    >
                      <div className={`w-4 h-4 bg-white rounded-full absolute top-0.5 transition-transform ${demoMode ? "translate-x-5" : "translate-x-0.5"}`} />
                    </div>
                    <span className="text-muted-foreground">{selectedClip.name}</span>
                  </label>
                </div>
              </div>
            </div>

            <div className="space-y-4">
              <div className="bg-card p-4 rounded-xl border border-border">
                <h3 className="font-semibold mb-3 flex items-center gap-2"><AlertTriangle size={16} /> Detection State</h3>
                <div className="space-y-2">
                  {["monitoring", "watching", "confirming", "alert"].map((state) => (
                    <div key={state} className={`flex items-center gap-2 p-2 rounded ${currentState === state ? stateColors[state] : "text-muted-foreground"}`}>
                      <div className={`w-2 h-2 rounded-full ${currentState === state ? "bg-current animate-pulse" : "bg-border"}`} />
                      <span className="text-sm capitalize">{state}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="bg-card p-4 rounded-xl border border-border">
                <h3 className="font-semibold mb-3">Scene Analysis</h3>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Motion Detected</span>
                    <span className={sceneChange > 0.3 ? "text-red-500 font-bold" : sceneChange > 0.15 ? "text-yellow-500" : ""}>
                      {(sceneChange * 100).toFixed(1)}%
                    </span>
                  </div>
                  <div className="w-full bg-background rounded-full h-2">
                    <div className={`h-2 rounded-full transition-all ${sceneChange > 0.3 ? "bg-red-500" : sceneChange > 0.15 ? "bg-yellow-500" : "bg-green-500"}`}
                      style={{ width: `${Math.min(sceneChange * 200, 100)}%` }} />
                  </div>
                </div>
              </div>

              <div className="bg-card p-4 rounded-xl border border-border">
                <h3 className="font-semibold mb-3">Detected Objects</h3>
                <div className="space-y-2 max-h-48 overflow-y-auto">
                  {detections.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{isAnalyzing ? "Scanning for motion..." : "Start analysis to detect objects"}</p>
                  ) : (
                    detections.map((det, i) => (
                      <div key={i} className="flex items-center justify-between p-2 bg-background rounded">
                        <div className="flex items-center gap-2">
                          <div className={`w-2 h-2 rounded-full ${det.class === "person" ? "bg-blue-500" : det.class === "bike" ? "bg-orange-500" : "bg-green-500"}`} />
                          <span className="text-sm capitalize">{det.class}</span>
                        </div>
                        <div className="text-right">
                          <span className="text-sm">{(det.confidence * 100).toFixed(0)}%</span>
                          {det.speed && <span className="text-xs text-orange-500 ml-2">{det.speed}km/h</span>}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div className="bg-card p-4 rounded-xl border border-border">
                <h3 className="font-semibold mb-3">Detected Incidents</h3>
                {incidents.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{isAnalyzing ? "Monitoring for accidents..." : "No accidents detected yet"}</p>
                ) : (
                  <div className="space-y-2">
                    {incidents.map((inc, i) => (
                      <div key={i} className={`p-3 rounded-lg border-l-4 ${inc.severity === "critical" ? "border-red-500 bg-red-500/10" : "border-orange-500 bg-orange-500/10"}`}>
                        <div className="flex items-center gap-2">
                          <AlertTriangle size={14} className={inc.severity === "critical" ? "text-red-500" : "text-orange-500"} />
                          <span className="text-sm font-medium capitalize">{inc.type.replace(/_/g, " ")}</span>
                        </div>
                        <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                          <span className="capitalize">{inc.severity}</span>
                          <span>{(inc.confidence * 100).toFixed(0)}%</span>
                          <span className="flex items-center gap-1"><Clock size={10} />{new Date(inc.timestamp).toLocaleTimeString()}</span>
                        </div>
                        <Link href="/ambulance" className="mt-2 inline-flex items-center gap-1 text-xs text-primary hover:underline">
                          <Navigation size={10} /> View on Ambulance Dashboard
                        </Link>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

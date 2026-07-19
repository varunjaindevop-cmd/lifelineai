"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  ArrowLeft, Video, Play, Pause, AlertTriangle, Clock,
  Navigation, RotateCcw, Loader2, Zap, Car, Users, Bike,
} from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";

// Dynamic imports for TensorFlow (avoids SSR issues)
let cocoSsdModule: any = null;
let tfModule: any = null;

// ========== TYPES ==========
interface VideoClip { name: string; src: string; description: string }
interface IncidentAlert { type: string; severity: string; confidence: number; timestamp: string; latitude: number; longitude: number }

interface TrackedObject {
  id: number; cx: number; cy: number; w: number; h: number;
  vx: number; vy: number; frames: number; lastSeen: number;
  class: string; // "car" | "motorcycle" | "person" | "bus" | "truck"
  cocoClass: string; // original COCO class
  confidence: number;
  positions: { x: number; y: number }[];
  area: number;
  speed: number;
  acceleration: number;
  heading: number;
  headingChange: number;
  aspectRatio: number;
  aspectHistory: number[];
  speedHistory: number[];
  decelFrames: number;
  _near?: number;
}

type EnvMode = "isolated" | "traffic" | "marketplace";

const VIDEO_CLIPS: VideoClip[] = [
  { name: "accident_sample.mp4", src: "/videos/accident_sample.mp4", description: "Vehicle collision" },
  { name: "camera2_demo.mp4", src: "/videos/camera2_demo.mp4", description: "Traffic monitoring" },
  { name: "camera4_demo.mp4", src: "/videos/camera4_demo.mp4", description: "Intersection monitoring" },
  { name: "checking.mp4", src: "/videos/checking.mp4", description: "System check" },
];

// COCO-SSD class mapping to our labels
const COCO_MAP: Record<string, string> = {
  car: "car", truck: "car", bus: "car",
  motorcycle: "motorcycle", "motorbike": "motorcycle",
  bicycle: "motorcycle",
  person: "person",
};

const LAT = 22.7196, LNG = 75.8577;

let nextObjId = 1;

export default function VideoAnalysisPage() {
  const [selectedClip, setSelectedClip] = useState<VideoClip | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [videoReady, setVideoReady] = useState(false);
  const [incidents, setIncidents] = useState<IncidentAlert[]>([]);
  const [state, setState] = useState("monitoring");
  const [demoMode, setDemoMode] = useState(false);
  const [objectCount, setObjectCount] = useState(0);
  const [envMode, setEnvMode] = useState<EnvMode>("isolated");
  const [modelLoading, setModelLoading] = useState(false);
  const [modelReady, setModelReady] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tmpCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number>(0);
  const blobsRef = useRef<TrackedObject[]>([]);
  const modelRef = useRef<any>(null);
  const stateRef = useRef("monitoring");
  const frameRef = useRef(0);
  const stateFrameRef = useRef(0);
  const cooldownRef = useRef(0);
  const accumRef = useRef<Float32Array | null>(null);
  const prevFrameRef = useRef<ImageData | null>(null);
  const consecutiveAnomalyRef = useRef(0);
  const supabase = createClient();

  // Load COCO-SSD model on mount
  useEffect(() => {
    const loadModel = async () => {
      setModelLoading(true);
      try {
        const [tf, cocoSsd] = await Promise.all([
          import("@tensorflow/tfjs"),
          import("@tensorflow-models/coco-ssd"),
        ]);
        tfModule = tf;
        cocoSsdModule = cocoSsd;
        await tfModule.ready();
        modelRef.current = await cocoSsdModule.load({ base: "lite_mobilenet_v2" });
        setModelReady(true);
      } catch (e) {
        console.error("Failed to load COCO-SSD:", e);
        toast.error("AI model failed to load. Detection unavailable.");
      }
      setModelLoading(false);
    };
    loadModel();
    return () => { cancelAnimationFrame(rafRef.current); };
  }, []);

  useEffect(() => { setVideoReady(false); const t = setTimeout(() => setVideoReady(true), 8000); return () => clearTimeout(t); }, [selectedClip]);

  const getTmp = useCallback(() => {
    if (!tmpCanvasRef.current) tmpCanvasRef.current = document.createElement("canvas");
    return tmpCanvasRef.current;
  }, []);

  // ========== COCO-SSD DETECTION ==========
  const detectObjects = async (video: HTMLVideoElement): Promise<{ class: string; cx: number; cy: number; w: number; h: number; confidence: number }[]> => {
    if (!modelRef.current) return [];
    try {
      const predictions = await modelRef.current.detect(video);
        return predictions
          .filter((p: any) => p.class in COCO_MAP && p.score > 0.4)
          .map((p: any) => {
          const [x, y, w, h] = p.bbox;
          return {
            class: COCO_MAP[p.class] || p.class,
            cx: x + w / 2,
            cy: y + h / 2,
            w, h,
            confidence: p.score,
          };
        });
    } catch {
      return [];
    }
  };

  // ========== TRACKING WITH PHYSICS ==========
  const trackObjects = (detections: { class: string; cx: number; cy: number; w: number; h: number; confidence: number }[], frame: number): TrackedObject[] => {
    const tracked = blobsRef.current;
    const matched = new Set<number>();

    for (const obj of tracked) {
      let best = -1, bestD = 80;
      for (let i = 0; i < detections.length; i++) {
        if (matched.has(i)) continue;
        // Only match same class
        if (detections[i].class !== obj.class) continue;
        const d = Math.sqrt((obj.cx - detections[i].cx) ** 2 + (obj.cy - detections[i].cy) ** 2);
        if (d < bestD) { bestD = d; best = i; }
      }
      if (best >= 0) {
        const det = detections[best];
        const newVx = det.cx - obj.cx;
        const newVy = det.cy - obj.cy;
        const newSpeed = Math.sqrt(newVx * newVx + newVy * newVy);
        const newHeading = Math.atan2(newVy, newVx);

        obj.acceleration = newSpeed - obj.speed;
        obj.decelFrames = obj.acceleration < -0.5 ? obj.decelFrames + 1 : 0;

        let hdgDiff = Math.abs(newHeading - obj.heading);
        if (hdgDiff > Math.PI) hdgDiff = 2 * Math.PI - hdgDiff;
        obj.headingChange = hdgDiff;

        obj.vx = newVx; obj.vy = newVy;
        obj.cx = det.cx; obj.cy = det.cy;
        obj.w = det.w; obj.h = det.h;
        obj.area = det.w * det.h;
        obj.speed = newSpeed;
        obj.heading = newHeading;
        obj.confidence = det.confidence;
        obj.aspectRatio = det.w / Math.max(det.h, 1);
        obj.aspectHistory.push(obj.aspectRatio);
        if (obj.aspectHistory.length > 8) obj.aspectHistory.shift();
        obj.speedHistory.push(newSpeed);
        if (obj.speedHistory.length > 8) obj.speedHistory.shift();
        obj.frames++;
        obj.lastSeen = frame;
        obj.positions.push({ x: det.cx, y: det.cy });
        if (obj.positions.length > 10) obj.positions.shift();
        matched.add(best);
      }
    }

    for (let i = 0; i < detections.length; i++) {
      if (matched.has(i)) continue;
      const d = detections[i];
      tracked.push({
        id: nextObjId++, cx: d.cx, cy: d.cy, w: d.w, h: d.h,
        vx: 0, vy: 0, frames: 1, lastSeen: frame,
        class: d.class, cocoClass: d.class, confidence: d.confidence,
        positions: [{ x: d.cx, y: d.cy }],
        area: d.w * d.h,
        speed: 0, acceleration: 0, heading: 0, headingChange: 0,
        aspectRatio: d.w / Math.max(d.h, 1),
        aspectHistory: [d.w / Math.max(d.h, 1)],
        speedHistory: [0], decelFrames: 0,
      });
    }

    blobsRef.current = tracked.filter(b => frame - b.lastSeen < 8);
    return blobsRef.current;
  };

  // ========== COLLISION DETECTION ==========
  const detectCollision = (objects: TrackedObject[]): { confidence: number; a: TrackedObject; b: TrackedObject; evidence: string } | null => {
    const candidates = objects.filter(b => b.frames >= 2);
    if (candidates.length < 2) return null;

    let best: { confidence: number; a: TrackedObject; b: TrackedObject; evidence: string } | null = null;

    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        const a = candidates[i], b = candidates[j];
        if (a.class === "person" && b.class === "person") continue;

        const dist = Math.sqrt((a.cx - b.cx) ** 2 + (a.cy - b.cy) ** 2);
        const combinedR = Math.sqrt(a.area) + Math.sqrt(b.area);
        if (dist > combinedR * 0.8) continue;

        let strongSignals = 0;
        const evidence: string[] = [];

        // Hard deceleration
        if (a.decelFrames >= 3 || b.decelFrames >= 3) { strongSignals++; evidence.push("hard_brake"); }

        // Sudden stop
        for (const obj of [a, b]) {
          if (obj.speedHistory.length >= 4) {
            const prev = (obj.speedHistory[0] + obj.speedHistory[1]) / 2;
            const curr = obj.speedHistory[obj.speedHistory.length - 1];
            if (prev > 2 && curr < prev * 0.25) { strongSignals++; evidence.push("sudden_stop"); break; }
          }
        }

        // Shape change
        for (const obj of [a, b]) {
          if (obj.aspectHistory.length >= 4) {
            const prevAR = (obj.aspectHistory[0] + obj.aspectHistory[1]) / 2;
            const currAR = obj.aspectHistory[obj.aspectHistory.length - 1];
            if (Math.abs(currAR - prevAR) / Math.max(prevAR, 0.1) > 0.5) { strongSignals++; evidence.push("shape_change"); break; }
          }
        }

        // Mutual convergence
        const dx = b.cx - a.cx, dy = b.cy - a.cy;
        const dotA = a.vx * dx + a.vy * dy;
        const dotB = b.vx * (-dx) + b.vy * (-dy);
        if (dotA > 0 && dotB > 0) { strongSignals++; evidence.push("mutual_converge"); }

        // Speed differential
        if (Math.abs(a.speed - b.speed) > 2 && Math.max(a.speed, b.speed) > 2) {
          strongSignals++; evidence.push("speed_diff");
        }

        if (strongSignals < 2) continue;

        const angleDiff = Math.abs(a.heading - b.heading);
        const wrapped = angleDiff > Math.PI ? 2 * Math.PI - angleDiff : angleDiff;
        if (wrapped < Math.PI * 0.3 && Math.abs(a.speed - b.speed) < 1.5) continue;

        const proximity = 1 - Math.min(dist / (combinedR * 0.8), 1);

        const closeThresh = combinedR * 0.8;
        if (dist < closeThresh) { a._near = (a._near || 0) + 1; b._near = (b._near || 0) + 1; }
        else { a._near = Math.max(0, (a._near || 0) - 1); b._near = Math.max(0, (b._near || 0) - 1); }
        const near = Math.min(a._near || 0, b._near || 0);

        const conf = Math.min(0.95, 0.30 * proximity + 0.25 * Math.min(near / 3, 1) + 0.25 * (strongSignals / 5) + 0.20 * (dotA > 0 && dotB > 0 ? 1 : 0.2));
        if (conf > 0.4 && (!best || conf > best.confidence)) {
          best = { confidence: conf, a, b, evidence: evidence.join("+") };
        }
      }
    }
    return best;
  };

  // ========== ACCUMULATED CHANGE (for normal mode) ==========
  const computeChange = (curr: ImageData): number => {
    const prev = prevFrameRef.current;
    if (!prev) { prevFrameRef.current = curr; return 0; }
    let diff = 0;
    const step = 16;
    for (let i = 0; i < curr.data.length; i += step * 4) {
      const g1 = curr.data[i] * 0.299 + curr.data[i + 1] * 0.587 + curr.data[i + 2] * 0.114;
      const g2 = prev.data[i] * 0.299 + prev.data[i + 1] * 0.587 + prev.data[i + 2] * 0.114;
      diff += Math.abs(g1 - g2);
    }
    prevFrameRef.current = curr;
    return diff / (curr.data.length / (step * 4)) / 255;
  };

  // ========== DRAW ==========
  const drawBoxes = (objects: TrackedObject[], collision: ReturnType<typeof detectCollision>, changeScore: number) => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (const obj of objects) {
      if (obj.frames < 2) continue;
      const isCollision = collision && (collision.a.id === obj.id || collision.b.id === obj.id);
      const baseColor = obj.class === "car" ? "#22c55e" : obj.class === "motorcycle" ? "#f59e0b" : "#3b82f6";
      const color = isCollision ? "#ef4444" : baseColor;

      ctx.strokeStyle = color;
      ctx.lineWidth = isCollision ? 3 : 2;
      ctx.strokeRect(obj.cx - obj.w / 2, obj.cy - obj.h / 2, obj.w, obj.h);

      // Heading arrow
      const arrowLen = Math.min(obj.w, obj.h) * 0.5;
      ctx.beginPath();
      ctx.moveTo(obj.cx, obj.cy);
      ctx.lineTo(obj.cx + Math.cos(obj.heading) * arrowLen, obj.cy + Math.sin(obj.heading) * arrowLen);
      ctx.strokeStyle = isCollision ? "#ef4444" : "#ffffff";
      ctx.lineWidth = 2;
      ctx.stroke();

      // ESP label
      const speedKmh = Math.round(obj.speed * 5);
      const accelLabel = obj.acceleration < -0.5 ? "BRAKE" : obj.acceleration > 0.5 ? "ACC" : "";
      const label = `${obj.class} ${(obj.confidence * 100).toFixed(0)}% | ${speedKmh}km/h${accelLabel ? " | " + accelLabel : ""}`;
      ctx.font = "bold 11px Arial";
      const tw = ctx.measureText(label).width;
      const labelY = obj.cy - obj.h / 2 - 20;
      ctx.fillStyle = isCollision ? "#ef4444" : "rgba(0,0,0,0.75)";
      ctx.fillRect(obj.cx - obj.w / 2, labelY, tw + 8, 18);
      ctx.fillStyle = "white";
      ctx.fillText(label, obj.cx - obj.w / 2 + 4, labelY + 13);
    }

    // Bottom bar
    const barY = canvas.height - 22;
    ctx.fillStyle = "rgba(0,0,0,0.7)";
    ctx.fillRect(0, barY, canvas.width, 22);
    ctx.fillStyle = changeScore > 0.04 ? "#ef4444" : changeScore > 0.02 ? "#f59e0b" : "#22c55e";
    ctx.fillRect(0, barY, Math.min(changeScore * canvas.width * 5, canvas.width), 22);
    ctx.fillStyle = "white";
    ctx.font = "11px Arial";
    const modeLabel = envMode === "traffic" ? "TRAFFIC" : envMode === "marketplace" ? "MARKETPLACE" : "ISOLATED";
    const collisionLabel = collision ? ` | COLLISION: ${collision.evidence}` : "";
    ctx.fillText(`${modeLabel} | Objects: ${objects.filter(b => b.frames >= 2).length} | Change: ${(changeScore * 100).toFixed(1)}%${collisionLabel}`, 8, barY + 15);
  };

  const createIncident = async (alert: IncidentAlert) => {
    const { data: inc } = await supabase.from("incidents").insert({
      severity: alert.severity, incident_type: alert.type,
      latitude: alert.latitude, longitude: alert.longitude,
      location_name: `Video Analysis: ${selectedClip?.name}`,
      detection_confidence: alert.confidence,
      detection_data: { source: "coco_ssd", clip: selectedClip?.name },
      video_clip_url: selectedClip?.src || null,
      status: "detected",
    }).select().single();

    setIncidents(prev => [...prev, alert]);
    toast.error(`ACCIDENT: ${alert.type.replace(/_/g, " ")} (${alert.severity})`);

    if (inc) {
      supabase.channel("alerts:ambulance").send({
        type: "broadcast", event: "new_incident",
        payload: {
          incident_id: inc.id, severity: alert.severity, incident_type: alert.type,
          latitude: alert.latitude, longitude: alert.longitude, video_clip_url: selectedClip?.src,
          message: `ACCIDENT: ${alert.type.replace(/_/g, " ")}`,
        },
      });
    }
  };

  // ========== MAIN LOOP ==========
  const startAnalysis = async () => {
    if (!videoRef.current || !selectedClip) return;
    if (!modelRef.current) { toast.error("AI model still loading..."); return; }
    const video = videoRef.current;
    try { await video.play(); } catch {
      video.muted = false;
      try { await video.play(); } catch { toast.error("Cannot play video"); return; }
    }

    blobsRef.current = [];
    prevFrameRef.current = null;
    accumRef.current = new Float32Array(80);
    frameRef.current = 0;
    stateFrameRef.current = 0;
    cooldownRef.current = 0;
    consecutiveAnomalyRef.current = 0;
    stateRef.current = "monitoring";
    nextObjId = 1;

    setVideoReady(true);
    setIsAnalyzing(true);
    setIncidents([]);
    setState("monitoring");
    setObjectCount(0);

    let lastDetectTime = 0;
    let latestDetections: { class: string; cx: number; cy: number; w: number; h: number; confidence: number }[] = [];
    let prevChangeGrid: Float32Array | null = null;

    const loop = async () => {
      try {
        if (!videoRef.current || videoRef.current.paused || videoRef.current.ended) return;

        frameRef.current++;
        if (cooldownRef.current > 0) cooldownRef.current--;

        // Run COCO-SSD every 300ms (~3 FPS detection, display at frame rate)
        const now = Date.now();
        if (now - lastDetectTime > 300) {
          lastDetectTime = now;
          latestDetections = await detectObjects(video);
        }

        // Track objects
        const tracked = trackObjects(latestDetections, frameRef.current);
        setObjectCount(tracked.filter(b => b.frames >= 2).length);

        // Compute change score + update accumulated grid
        const tmp = getTmp();
        tmp.width = 640; tmp.height = 480;
        const ctx = tmp.getContext("2d")!;
        ctx.drawImage(video, 0, 0, 640, 480);
        const imgData = ctx.getImageData(0, 0, 640, 480);
        const changeScore = computeChange(imgData);

        // Update accum grid for display
        const data = imgData.data;
        const cw = Math.floor(640 / 10), ch = Math.floor(480 / 8);
        const currGrid = new Float32Array(80);
        for (let r = 0; r < 8; r++) for (let c = 0; c < 10; c++) {
          let s = 0, n = 0;
          for (let dy = 0; dy < ch; dy += 4) for (let dx = 0; dx < cw; dx += 4) {
            const i = ((r * ch + dy) * 640 + (c * cw + dx)) * 4;
            s += data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114; n++;
          }
          currGrid[r * 10 + c] = n > 0 ? s / n : 128;
        }
        if (accumRef.current) {
          for (let i = 0; i < 80; i++) {
            const diff = prevChangeGrid ? Math.abs(currGrid[i] - prevChangeGrid[i]) / 255 : 0;
            accumRef.current[i] = accumRef.current[i] * 0.95 + diff * 3;
          }
        }
        prevChangeGrid = currGrid;

        // Collision detection (always active)
        const collision = detectCollision(tracked);

        // ========== ANOMALY ==========
        let hasAnomaly = false;
        let anomalyConfidence = 0;
        let anomalyType = "";
        let isCollisionSignal = false;

        if (collision) {
          hasAnomaly = true;
          anomalyConfidence = collision.confidence;
          anomalyType = "collision";
          const hasImpact = collision.evidence.includes("sudden_stop") || collision.evidence.includes("shape_change") || collision.evidence.includes("hard_brake");
          isCollisionSignal = hasImpact;
        } else if (envMode === "isolated") {
          if (changeScore > 0.04) {
            hasAnomaly = true;
            anomalyConfidence = Math.min(0.8, changeScore * 8);
            anomalyType = "change";
            isCollisionSignal = changeScore > 0.08;
          }
        }

        // Draw
        drawBoxes(tracked, collision, changeScore);

        if (hasAnomaly) consecutiveAnomalyRef.current++;
        else consecutiveAnomalyRef.current = Math.max(0, consecutiveAnomalyRef.current - 1);

        // ========== STATE MACHINE ==========
        stateFrameRef.current++;
        let st = stateRef.current;

        if (hasAnomaly && consecutiveAnomalyRef.current >= 3) {
          if (st === "monitoring") st = "watching";
          else if (st === "watching" && consecutiveAnomalyRef.current >= 6) st = "confirming";
          else if (st === "confirming" && isCollisionSignal && consecutiveAnomalyRef.current >= 8) st = "alert";
        } else if (!demoMode && frameRef.current % 5 === 0) {
          st = st === "alert" ? "confirming" : st === "confirming" ? "watching" : "monitoring";
        }

        if (demoMode) {
          const sf = stateFrameRef.current;
          if (sf === 15 && st === "monitoring") st = "watching";
          if (sf === 25 && st === "watching") st = "confirming";
          if (sf >= 35 && st === "confirming") st = "alert";
        }

        if (st === "alert" && stateRef.current !== "alert" && cooldownRef.current <= 0) {
          cooldownRef.current = envMode === "traffic" ? 120 : 40;
          consecutiveAnomalyRef.current = 0;

          let incidentType = "vehicle_collision";
          let severity = "major";
          if (collision) {
            const isPed = collision.a.class === "person" || collision.b.class === "person";
            incidentType = isPed ? "pedestrian_collision" : "vehicle_collision";
            severity = collision.confidence > 0.7 ? "critical" : "major";
          } else {
            incidentType = "";
          }

          if (incidentType) {
            createIncident({
              type: incidentType, severity,
              confidence: anomalyConfidence || 0.6,
              timestamp: new Date().toISOString(),
              latitude: LAT + (Math.random() - 0.5) * 0.01,
              longitude: LNG + (Math.random() - 0.5) * 0.01,
            });
            setTimeout(() => { stateRef.current = "monitoring"; stateFrameRef.current = 0; setState("monitoring"); }, 8000);
          } else {
            stateRef.current = "monitoring"; stateFrameRef.current = 0; setState("monitoring");
          }
        }

        stateRef.current = st;
        setState(st);
      } catch (e) { console.error(e); }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
  };

  const stopAnalysis = () => {
    cancelAnimationFrame(rafRef.current);
    if (videoRef.current) { videoRef.current.pause(); videoRef.current.currentTime = 0; }
    setIsAnalyzing(false);
    setState("monitoring");
    stateRef.current = "monitoring";
  };

  const resetClip = () => {
    stopAnalysis();
    setIncidents([]);
    blobsRef.current = [];
    prevFrameRef.current = null;
    accumRef.current = new Float32Array(80);
    frameRef.current = 0;
    stateFrameRef.current = 0;
    cooldownRef.current = 0;
    consecutiveAnomalyRef.current = 0;
    setObjectCount(0);
  };

  const stateColors: Record<string, string> = {
    monitoring: "bg-green-500/20 text-green-500",
    watching: "bg-yellow-500/20 text-yellow-500",
    confirming: "bg-orange-500/20 text-orange-500",
    alert: "bg-red-500/20 text-red-500 animate-pulse",
  };

  const envModes: { key: EnvMode; label: string; icon: React.ReactNode; desc: string; color: string }[] = [
    { key: "isolated", label: "Isolated Road", icon: <Car size={14} />, desc: "Low traffic, vehicles only", color: "blue" },
    { key: "traffic", label: "Traffic", icon: <Car size={14} />, desc: "Rush area, dense vehicles", color: "orange" },
    { key: "marketplace", label: "Marketplace", icon: <Users size={14} />, desc: "Pedestrians, walking area", color: "purple" },
  ];

  return (
    <div className="space-y-6">
      <Link href="/admin" className="inline-flex items-center gap-2 text-muted-foreground hover:text-foreground">
        <ArrowLeft size={16} /> Back to Admin
      </Link>
      <div>
        <h1 className="text-2xl font-bold">Video Analysis</h1>
        <p className="text-muted-foreground">COCO-SSD AI detection + physics-based collision analysis</p>
      </div>

      {!selectedClip ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {VIDEO_CLIPS.map(clip => (
            <button key={clip.name} onClick={() => setSelectedClip(clip)}
              className="bg-card p-5 rounded-xl border border-border hover:border-primary/50 transition-colors text-left">
              <div className="flex items-start gap-4">
                <div className="w-16 h-16 bg-background rounded-lg flex items-center justify-center shrink-0">
                  <Video className="w-8 h-8 text-primary" />
                </div>
                <div>
                  <h3 className="font-semibold">{clip.name}</h3>
                  <p className="text-sm text-muted-foreground mt-1">{clip.description}</p>
                </div>
              </div>
            </button>
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          <button onClick={() => { resetClip(); setSelectedClip(null); setVideoReady(false); }}
            className="text-sm text-primary hover:underline">&larr; Choose different clip</button>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2">
              <div className="bg-card rounded-xl border border-border overflow-hidden">
                <div className="aspect-video bg-black relative">
                  <video ref={videoRef} src={selectedClip.src} className="w-full h-full object-contain"
                    playsInline muted loop onLoadedData={() => setVideoReady(true)} onCanPlay={() => setVideoReady(true)} />
                  <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" style={{ pointerEvents: "none" }} />
                  {!videoReady && <div className="absolute inset-0 flex items-center justify-center bg-black/50">
                    <div className="flex items-center gap-2 text-white"><Loader2 className="w-5 h-5 animate-spin" /> Loading...</div>
                  </div>}
                  {isAnalyzing && <div className="absolute top-4 left-4 flex items-center gap-2">
                    <div className="w-3 h-3 bg-red-500 rounded-full animate-pulse" />
                    <span className="text-sm font-medium bg-black/60 px-2 py-1 rounded">Tracking {objectCount} objects</span>
                  </div>}
                </div>
                <div className="p-4 border-t border-border flex items-center gap-3 flex-wrap">
                  {!isAnalyzing ? (
                    <button onClick={startAnalysis} disabled={!videoReady || !modelReady}
                      className="px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors flex items-center gap-2 disabled:opacity-50">
                      {!modelReady ? <><Loader2 size={16} className="animate-spin" /> Loading AI...</> :
                        videoReady ? <><Play size={16} /> Start Analysis</> :
                          <><Loader2 size={16} className="animate-spin" /> Loading...</>}
                    </button>
                  ) : (
                    <>
                      <button onClick={stopAnalysis} className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors flex items-center gap-2"><Pause size={16} /> Stop</button>
                      <button onClick={resetClip} className="px-4 py-2 bg-card border border-border rounded-lg hover:bg-background transition-colors flex items-center gap-2"><RotateCcw size={16} /> Reset</button>
                    </>
                  )}

                  {/* Demo toggle */}
                  <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${demoMode ? "bg-yellow-500/20 text-yellow-500" : "bg-green-500/20 text-green-500"}`}>{demoMode ? "DEMO" : "REAL"}</span>
                    <div onClick={() => setDemoMode(!demoMode)} className={`w-10 h-5 rounded-full transition-colors relative cursor-pointer ${demoMode ? "bg-yellow-500" : "bg-green-600"}`}>
                      <div className={`w-4 h-4 bg-white rounded-full absolute top-0.5 transition-transform ${demoMode ? "translate-x-5" : "translate-x-0.5"}`} />
                    </div>
                  </label>

                  <span className="text-muted-foreground text-xs">{selectedClip.name}</span>

                  {/* Environment Mode Buttons */}
                  <div className="flex gap-1 ml-auto">
                    {envModes.map(m => (
                      <button key={m.key} onClick={() => setEnvMode(m.key)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5 ${
                          envMode === m.key
                            ? m.color === "blue" ? "bg-blue-600 text-white"
                              : m.color === "orange" ? "bg-orange-600 text-white"
                              : "bg-purple-600 text-white"
                            : "bg-card border border-border text-muted-foreground hover:bg-background"
                        }`}>
                        {m.icon}
                        {m.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            <div className="space-y-4">
              {/* State */}
              <div className="bg-card p-4 rounded-xl border border-border">
                <h3 className="font-semibold mb-3 flex items-center gap-2"><AlertTriangle size={16} /> State</h3>
                <div className="space-y-2">
                  {["monitoring", "watching", "confirming", "alert"].map(s => (
                    <div key={s} className={`flex items-center gap-2 p-2 rounded ${state === s ? stateColors[s] : "text-muted-foreground"}`}>
                      <div className={`w-2 h-2 rounded-full ${state === s ? "bg-current animate-pulse" : "bg-border"}`} />
                      <span className="text-sm capitalize">{s}</span>
                    </div>
                  ))}
                </div>
                <div className="mt-2 text-xs text-muted-foreground">
                  Mode: {envMode} | Cooldown: {cooldownRef.current}f
                </div>
              </div>

              {/* Change Detection Grid */}
              <div className="bg-card p-4 rounded-xl border border-border">
                <h3 className="font-semibold mb-3 flex items-center gap-2">
                  <Zap size={16} /> Change Detection
                </h3>
                <p className="text-xs text-muted-foreground mb-2">Region-level pixel change (accumulated)</p>
                <div className="grid gap-px" style={{ gridTemplateColumns: `repeat(10, 1fr)` }}>
                  {Array.from(accumRef.current || new Float32Array(80)).map((v, i) => (
                    <div key={i} className="aspect-square rounded-sm" style={{
                      backgroundColor: v > 0.08 ? `rgb(${Math.min(255, Math.floor(v * 2000))},0,0)` :
                        v > 0.03 ? `rgb(${Math.min(255, Math.floor(v * 1500))},${Math.floor(v * 500)},0)` :
                          `rgb(0,${Math.min(255, Math.floor(v * 3000))},0)`
                    }} />
                  ))}
                </div>
                <div className="flex justify-between text-xs text-muted-foreground mt-1">
                  <span>Green = calm</span>
                  <span>Red = high change</span>
                </div>
              </div>

              {/* Collision Status */}
              <div className="bg-card p-4 rounded-xl border border-border">
                <h3 className="font-semibold mb-3 flex items-center gap-2"><AlertTriangle size={16} /> Collision</h3>
                {(() => {
                  const c = detectCollision(blobsRef.current);
                  if (!c) return <p className="text-sm text-green-400">No collision</p>;
                  return (
                    <div className="p-2 bg-red-500/10 border border-red-500/30 rounded text-xs space-y-1">
                      <div className="font-medium text-red-400">DETECTED ({(c.confidence * 100).toFixed(0)}%)</div>
                      <div className="text-muted-foreground">#{c.a.id}({c.a.class}) + #{c.b.id}({c.b.class})</div>
                      <div className="text-muted-foreground">Evidence: {c.evidence}</div>
                    </div>
                  );
                })()}
              </div>

              {/* Vehicle ESP */}
              <div className="bg-card p-4 rounded-xl border border-border">
                <h3 className="font-semibold mb-3 flex items-center gap-2"><Zap size={16} /> Vehicle ESP</h3>
                <div className="space-y-2 max-h-60 overflow-y-auto">
                  {(() => {
                    const valid = blobsRef.current.filter(b => b.frames >= 2);
                    if (valid.length === 0) return <p className="text-sm text-muted-foreground">{isAnalyzing ? "Scanning..." : "Start"}</p>;
                    return valid.map(b => {
                      const speedKmh = Math.round(b.speed * 5);
                      const accelLabel = b.acceleration < -0.5 ? "BRAKE" : b.acceleration > 0.5 ? "ACC" : "CRUISE";
                      const accelColor = b.acceleration < -0.5 ? "text-red-400" : b.acceleration > 0.5 ? "text-green-400" : "text-gray-400";
                      return (
                        <div key={b.id} className="p-2 bg-background rounded text-xs space-y-1">
                          <div className="flex items-center justify-between">
                            <span className={`font-medium ${b.class === "car" ? "text-green-400" : b.class === "motorcycle" ? "text-yellow-400" : "text-blue-400"}`}>{b.class} #{b.id}</span>
                            <span className={accelColor}>{accelLabel}</span>
                          </div>
                          <div className="flex gap-2 text-muted-foreground flex-wrap">
                            <span>{speedKmh}km/h</span>
                            <span>a:{b.acceleration.toFixed(1)}</span>
                            <span>θ:{Math.round(b.heading * 180 / Math.PI)}°</span>
                            <span>AR:{b.aspectRatio.toFixed(2)}</span>
                            <span>brk:{b.decelFrames}f</span>
                            <span>conf:{(b.confidence * 100).toFixed(0)}%</span>
                          </div>
                        </div>
                      );
                    });
                  })()}
                </div>
              </div>

              {/* Incidents */}
              <div className="bg-card p-4 rounded-xl border border-border">
                <h3 className="font-semibold mb-3">Incidents</h3>
                {incidents.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{isAnalyzing ? "Monitoring..." : "None"}</p>
                ) : incidents.map((inc, i) => (
                  <div key={i} className={`p-3 rounded-lg border-l-4 mb-2 ${inc.severity === "critical" ? "border-red-500 bg-red-500/10" : "border-orange-500 bg-orange-500/10"}`}>
                    <div className="flex items-center gap-2">
                      <AlertTriangle size={14} className="text-red-500" />
                      <span className="text-sm font-medium capitalize">{inc.type.replace(/_/g, " ")}</span>
                    </div>
                    <div className="flex gap-3 mt-1 text-xs text-muted-foreground">
                      <span>{(inc.confidence * 100).toFixed(0)}%</span>
                      <span className="flex items-center gap-1"><Clock size={10} />{new Date(inc.timestamp).toLocaleTimeString()}</span>
                    </div>
                    <Link href="/ambulance" className="mt-1 inline-flex items-center gap-1 text-xs text-primary hover:underline">
                      <Navigation size={10} /> Ambulance Dashboard
                    </Link>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

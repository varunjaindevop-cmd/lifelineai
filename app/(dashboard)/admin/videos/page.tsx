"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  ArrowLeft, Video, Play, Pause, AlertTriangle, Clock,
  Navigation, RotateCcw, Loader2, Zap, Car, Users,
} from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { MultiObjectTracker, TrackedEntity } from "@/lib/detection/kalman-tracker";
import { findAllTTCPairs, detectAccidents, TTCPair, AccidentEvidence } from "@/lib/detection/ttc-engine";
import { autoCalibrate, calculateRealSpeed, perspectiveCorrectedSpeed } from "@/lib/detection/speed-estimator";

// ========== TYPES ==========
interface VideoClip { name: string; src: string; description: string }
interface IncidentAlert { type: string; severity: string; confidence: number; timestamp: string; latitude: number; longitude: number }

type EnvMode = "isolated" | "traffic" | "marketplace";

const VIDEO_CLIPS: VideoClip[] = [
  { name: "accident_sample.mp4", src: "/videos/accident_sample.mp4", description: "Vehicle collision" },
  { name: "camera2_demo.mp4", src: "/videos/camera2_demo.mp4", description: "Traffic monitoring" },
  { name: "camera4_demo.mp4", src: "/videos/camera4_demo.mp4", description: "Intersection monitoring" },
  { name: "checking.mp4", src: "/videos/checking.mp4", description: "System check" },
];

const COCO_MAP: Record<string, string> = {
  car: "car", truck: "car", bus: "car",
  motorcycle: "motorcycle", motorbike: "motorcycle", bicycle: "motorcycle",
  person: "person",
};

const LAT = 22.7196, LNG = 75.8577;
const GRID_COLS = 10, GRID_ROWS = 8;

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
  const trackerRef = useRef<MultiObjectTracker>(new MultiObjectTracker());
  const modelRef = useRef<any>(null);
  const stateRef = useRef("monitoring");
  const frameRef = useRef(0);
  const stateFrameRef = useRef(0);
  const cooldownRef = useRef(0);
  const accumRef = useRef<Float32Array>(new Float32Array(GRID_COLS * GRID_ROWS));
  const prevChangeGridRef = useRef<Float32Array | null>(null);
  const consecutiveAnomalyRef = useRef(0);
  const ttcPairsRef = useRef<TTCPair[]>([]);
  const evidenceRef = useRef<AccidentEvidence[]>([]);
  const pixelsPerMeterRef = useRef(50);
  const supabase = createClient();

  // Load COCO-SSD model
  useEffect(() => {
    const loadModel = async () => {
      setModelLoading(true);
      try {
        const [tf, cocoSsd] = await Promise.all([
          import("@tensorflow/tfjs"),
          import("@tensorflow-models/coco-ssd"),
        ]);
        await tf.ready();
        modelRef.current = await cocoSsd.load({ base: "lite_mobilenet_v2" });
        setModelReady(true);
      } catch (e) {
        console.error("Failed to load COCO-SSD:", e);
        toast.error("AI model failed to load.");
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

  // COCO-SSD detection
  const detectObjects = async (video: HTMLVideoElement) => {
    if (!modelRef.current) return [];
    try {
      const predictions = await modelRef.current.detect(video);
      return predictions
        .filter((p: any) => p.class in COCO_MAP && p.score > 0.4)
        .map((p: any) => {
          const [x, y, w, h] = p.bbox;
          return { class: COCO_MAP[p.class], cx: x + w / 2, cy: y + h / 2, w, h, confidence: p.score };
        });
    } catch { return []; }
  };

  // Compute accumulated change grid
  const computeChangeGrid = (data: Uint8ClampedArray, w: number, h: number): Float32Array => {
    const grid = new Float32Array(GRID_COLS * GRID_ROWS);
    const cw = Math.floor(w / GRID_COLS), ch = Math.floor(h / GRID_ROWS);
    for (let r = 0; r < GRID_ROWS; r++) for (let c = 0; c < GRID_COLS; c++) {
      let s = 0, n = 0;
      for (let dy = 0; dy < ch; dy += 4) for (let dx = 0; dx < cw; dx += 4) {
        const i = ((r * ch + dy) * w + (c * cw + dx)) * 4;
        s += data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114; n++;
      }
      grid[r * GRID_COLS + c] = n > 0 ? s / n : 128;
    }
    return grid;
  };

  // Draw everything
  const drawFrame = (
    entities: TrackedEntity[], ttcPairs: TTCPair[], evidence: AccidentEvidence[],
    changeGrid: Float32Array, videoW: number, videoH: number
  ) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    canvas.width = videoW;
    canvas.height = videoH;
    ctx.clearRect(0, 0, videoW, videoH);

    const ppm = pixelsPerMeterRef.current;

    // Draw tracked objects with ESP boxes
    for (const entity of entities) {
      if (entity.age < 2) continue;
      const isInvolved = evidence.some(e => e.objects.includes(entity.id));
      const baseColor = entity.class === "car" ? "#22c55e" : entity.class === "motorcycle" ? "#f59e0b" : "#3b82f6";
      const color = isInvolved ? "#ef4444" : baseColor;

      // Bounding box
      const bx = entity.kalman.getState().x - entity.w / 2;
      const by = entity.kalman.getState().y - entity.h / 2;
      ctx.strokeStyle = color;
      ctx.lineWidth = isInvolved ? 3 : 2;
      ctx.strokeRect(bx, by, entity.w, entity.h);

      // Heading arrow
      const cx = entity.kalman.getState().x;
      const cy = entity.kalman.getState().y;
      const arrowLen = Math.min(entity.w, entity.h) * 0.5;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(entity.heading) * arrowLen, cy + Math.sin(entity.heading) * arrowLen);
      ctx.strokeStyle = isInvolved ? "#ef4444" : "#ffffff";
      ctx.lineWidth = 2;
      ctx.stroke();

      // Speed label with REAL km/h
      const { current: speedKmh } = calculateRealSpeed(entity, ppm);
      const correctedSpeed = perspectiveCorrectedSpeed(speedKmh, entity.kalman.getState().y, videoH);
      const accelLabel = entity.acceleration < -0.3 ? "BRAKE" : entity.acceleration > 0.3 ? "ACC" : "";
      const label = `${entity.class} ${(entity.confidence * 100).toFixed(0)}% | ${correctedSpeed}km/h${accelLabel ? " | " + accelLabel : ""}`;
      ctx.font = "bold 11px Arial";
      const tw = ctx.measureText(label).width;
      const labelY = by - 20;
      ctx.fillStyle = isInvolved ? "#ef4444" : "rgba(0,0,0,0.75)";
      ctx.fillRect(bx, labelY, tw + 8, 18);
      ctx.fillStyle = "white";
      ctx.fillText(label, bx + 4, labelY + 13);
    }

    // Draw TTC warning lines for critical pairs
    for (const pair of ttcPairs) {
      if (pair.severity === "none") continue;
      const ax = pair.a.kalman.getState().x;
      const ay = pair.a.kalman.getState().y;
      const bx = pair.b.kalman.getState().x;
      const by = pair.b.kalman.getState().y;

      const lineColor = pair.severity === "impact" ? "#ef4444"
        : pair.severity === "critical" ? "#f97316"
        : "#f59e0b";

      ctx.setLineDash([5, 5]);
      ctx.strokeStyle = lineColor;
      ctx.lineWidth = pair.severity === "impact" ? 3 : 2;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
      ctx.setLineDash([]);

      // TTC label at midpoint
      if (!isNaN(pair.ttc)) {
        const mx = (ax + bx) / 2, my = (ay + by) / 2;
        ctx.font = "bold 10px Arial";
        ctx.fillStyle = lineColor;
        ctx.fillText(`TTC: ${pair.ttc.toFixed(1)}s`, mx + 5, my - 5);
      }
    }

    // Bottom bar
    const barY = videoH - 22;
    ctx.fillStyle = "rgba(0,0,0,0.7)";
    ctx.fillRect(0, barY, videoW, 22);
    const modeLabel = envMode === "traffic" ? "TRAFFIC" : envMode === "marketplace" ? "MARKETPLACE" : "ISOLATED";
    const topEvidence = evidence[0];
    const evLabel = topEvidence ? ` | ${topEvidence.type}: ${topEvidence.details}` : "";
    ctx.fillStyle = "white";
    ctx.font = "11px Arial";
    ctx.fillText(`${modeLabel} | Objects: ${entities.filter(e => e.age >= 2).length} | PPM: ${ppm.toFixed(1)}${evLabel}`, 8, barY + 15);
  };

  const createIncident = async (alert: IncidentAlert) => {
    const { data: inc } = await supabase.from("incidents").insert({
      severity: alert.severity, incident_type: alert.type,
      latitude: alert.latitude, longitude: alert.longitude,
      location_name: `Video Analysis: ${selectedClip?.name}`,
      detection_confidence: alert.confidence,
      detection_data: { source: "ttc_engine", clip: selectedClip?.name },
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

    trackerRef.current.reset();
    accumRef.current.fill(0);
    prevChangeGridRef.current = null;
    frameRef.current = 0;
    stateFrameRef.current = 0;
    cooldownRef.current = 0;
    consecutiveAnomalyRef.current = 0;
    stateRef.current = "monitoring";
    nextObjId = 1;

    // Auto-calibrate
    pixelsPerMeterRef.current = autoCalibrate(video.videoWidth || 640, video.videoHeight || 480, envMode);

    setVideoReady(true);
    setIsAnalyzing(true);
    setIncidents([]);
    setState("monitoring");
    setObjectCount(0);

    let lastDetectTime = 0;
    let latestDetections: { class: string; cx: number; cy: number; w: number; h: number; confidence: number }[] = [];

    const loop = async () => {
      try {
        if (!videoRef.current || videoRef.current.paused || videoRef.current.ended) return;

        frameRef.current++;
        if (cooldownRef.current > 0) cooldownRef.current--;

        // COCO-SSD detection every 100ms (~10 FPS)
        const now = Date.now();
        if (now - lastDetectTime > 100) {
          lastDetectTime = now;
          latestDetections = await detectObjects(video);
        }

        // Track with Kalman filter
        const entities = trackerRef.current.update(latestDetections, frameRef.current);
        const validEntities = entities.filter(e => e.age >= 2);
        setObjectCount(validEntities.length);

        // Compute change grid
        const tmp = getTmp();
        tmp.width = video.videoWidth || 640;
        tmp.height = video.videoHeight || 480;
        const ctx = tmp.getContext("2d")!;
        ctx.drawImage(video, 0, 0, tmp.width, tmp.height);
        const imgData = ctx.getImageData(0, 0, tmp.width, tmp.height);
        const changeGrid = computeChangeGrid(imgData.data, tmp.width, tmp.height);

        // Update accum grid
        const prev = prevChangeGridRef.current;
        for (let i = 0; i < GRID_COLS * GRID_ROWS; i++) {
          const diff = prev ? Math.abs(changeGrid[i] - prev[i]) / 255 : 0;
          accumRef.current[i] = accumRef.current[i] * 0.95 + diff * 3;
        }
        prevChangeGridRef.current = changeGrid;

        // TTC computation
        const ttcPairs = findAllTTCPairs(validEntities);
        ttcPairsRef.current = ttcPairs;

        // Accident detection
        const avgChange = accumRef.current.reduce((a, b) => a + b, 0) / (GRID_COLS * GRID_ROWS);
        const evidence = detectAccidents(validEntities, ttcPairs, avgChange);
        evidenceRef.current = evidence;

        // Draw
        drawFrame(validEntities, ttcPairs, evidence, changeGrid, video.videoWidth || 640, video.videoHeight || 480);

        // ========== STATE MACHINE (TTC-based) ==========
        const hasCriticalEvidence = evidence.some(e =>
          e.type === "ttc_critical" && e.confidence > 0.5
        );
        const hasAnyEvidence = evidence.length > 0;

        if (hasCriticalEvidence) consecutiveAnomalyRef.current++;
        else if (hasAnyEvidence) consecutiveAnomalyRef.current = Math.max(0, consecutiveAnomalyRef.current - 0.5);
        else consecutiveAnomalyRef.current = Math.max(0, consecutiveAnomalyRef.current - 1);

        stateFrameRef.current++;
        let st = stateRef.current;

        // TTC-based state transitions
        const topTTC = ttcPairs.length > 0 ? ttcPairs[0].ttc : Infinity;

        if (hasCriticalEvidence && consecutiveAnomalyRef.current >= 3) {
          if (st === "monitoring") st = "watching";
          else if (st === "watching" && topTTC < 1.5) st = "confirming";
          else if (st === "confirming" && topTTC < 0.5) st = "alert";
        } else if (hasAnyEvidence && consecutiveAnomalyRef.current >= 5) {
          if (st === "monitoring") st = "watching";
        } else if (!demoMode && frameRef.current % 5 === 0) {
          st = st === "alert" ? "confirming" : st === "confirming" ? "watching" : "monitoring";
        }

        if (demoMode) {
          const sf = stateFrameRef.current;
          if (sf === 15 && st === "monitoring") st = "watching";
          if (sf === 25 && st === "watching") st = "confirming";
          if (sf >= 35 && st === "confirming") st = "alert";
        }

        // Fire alert
        if (st === "alert" && stateRef.current !== "alert" && cooldownRef.current <= 0) {
          cooldownRef.current = envMode === "traffic" ? 120 : 40;
          consecutiveAnomalyRef.current = 0;

          const topEv = evidence[0];
          let incidentType = "vehicle_collision";
          let severity = "major";

          if (topEv) {
            if (topEv.type === "ttc_critical") {
              incidentType = evidence.some(e => e.objects.some(id => {
                const ent = validEntities.find(v => v.id === id);
                return ent?.class === "person";
              })) ? "pedestrian_collision" : "vehicle_collision";
              severity = topEv.confidence > 0.7 ? "critical" : "major";
            } else if (topEv.type === "post_impact") {
              incidentType = "vehicle_collision";
              severity = "critical";
            } else {
              incidentType = "";
            }
          }

          if (incidentType) {
            createIncident({
              type: incidentType, severity,
              confidence: topEv?.confidence || 0.6,
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
    trackerRef.current.reset();
    accumRef.current.fill(0);
    prevChangeGridRef.current = null;
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

  const envModes: { key: EnvMode; label: string; icon: React.ReactNode; color: string }[] = [
    { key: "isolated", label: "Isolated Road", icon: <Car size={14} />, color: "blue" },
    { key: "traffic", label: "Traffic", icon: <Car size={14} />, color: "orange" },
    { key: "marketplace", label: "Marketplace", icon: <Users size={14} />, color: "purple" },
  ];

  return (
    <div className="space-y-6">
      <Link href="/admin" className="inline-flex items-center gap-2 text-muted-foreground hover:text-foreground">
        <ArrowLeft size={16} /> Back to Admin
      </Link>
      <div>
        <h1 className="text-2xl font-bold">Video Analysis</h1>
        <p className="text-muted-foreground">Kalman tracking + TTC prediction + COCO-SSD detection</p>
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

                  <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${demoMode ? "bg-yellow-500/20 text-yellow-500" : "bg-green-500/20 text-green-500"}`}>{demoMode ? "DEMO" : "REAL"}</span>
                    <div onClick={() => setDemoMode(!demoMode)} className={`w-10 h-5 rounded-full transition-colors relative cursor-pointer ${demoMode ? "bg-yellow-500" : "bg-green-600"}`}>
                      <div className={`w-4 h-4 bg-white rounded-full absolute top-0.5 transition-transform ${demoMode ? "translate-x-5" : "translate-x-0.5"}`} />
                    </div>
                  </label>

                  <span className="text-muted-foreground text-xs">{selectedClip.name}</span>

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
                        {m.icon}{m.label}
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
                  Mode: {envMode} | PPM: {pixelsPerMeterRef.current.toFixed(1)} | Cooldown: {cooldownRef.current}f
                </div>
              </div>

              {/* Change Detection */}
              <div className="bg-card p-4 rounded-xl border border-border">
                <h3 className="font-semibold mb-3 flex items-center gap-2"><Zap size={16} /> Change Detection</h3>
                <div className="grid gap-px" style={{ gridTemplateColumns: `repeat(${GRID_COLS}, 1fr)` }}>
                  {Array.from(accumRef.current).map((v, i) => (
                    <div key={i} className="aspect-square rounded-sm" style={{
                      backgroundColor: v > 0.08 ? `rgb(${Math.min(255, Math.floor(v * 2000))},0,0)` :
                        v > 0.03 ? `rgb(${Math.min(255, Math.floor(v * 1500))},${Math.floor(v * 500)},0)` :
                          `rgb(0,${Math.min(255, Math.floor(v * 3000))},0)`
                    }} />
                  ))}
                </div>
              </div>

              {/* TTC Status */}
              <div className="bg-card p-4 rounded-xl border border-border">
                <h3 className="font-semibold mb-3 flex items-center gap-2"><AlertTriangle size={16} /> Time-to-Collision</h3>
                {(() => {
                  const pairs = ttcPairsRef.current;
                  if (pairs.length === 0) return <p className="text-sm text-green-400">No converging objects</p>;
                  return pairs.slice(0, 3).map((p, i) => (
                    <div key={i} className={`p-2 rounded mb-1 text-xs ${p.severity === "impact" ? "bg-red-500/10 border border-red-500/30" : p.severity === "critical" ? "bg-orange-500/10" : "bg-yellow-500/10"}`}>
                      <div className="flex justify-between">
                        <span>#{p.a.id}({p.a.class}) + #{p.b.id}({p.b.class})</span>
                        <span className={`font-bold ${p.severity === "impact" ? "text-red-400" : p.severity === "critical" ? "text-orange-400" : "text-yellow-400"}`}>
                          {isNaN(p.ttc) ? "N/A" : `${p.ttc.toFixed(1)}s`}
                        </span>
                      </div>
                      <div className="text-muted-foreground">dist: {p.distance.toFixed(0)}px | closing: {p.closingSpeed.toFixed(1)}px/f</div>
                    </div>
                  ));
                })()}
              </div>

              {/* Evidence */}
              <div className="bg-card p-4 rounded-xl border border-border">
                <h3 className="font-semibold mb-3 flex items-center gap-2"><AlertTriangle size={16} /> Accident Evidence</h3>
                {(() => {
                  const ev = evidenceRef.current;
                  if (ev.length === 0) return <p className="text-sm text-green-400">No evidence detected</p>;
                  return ev.slice(0, 3).map((e, i) => (
                    <div key={i} className="p-2 bg-red-500/5 border border-red-500/20 rounded mb-1 text-xs">
                      <div className="font-medium text-red-400">{e.type} ({(e.confidence * 100).toFixed(0)}%)</div>
                      <div className="text-muted-foreground">{e.details}</div>
                    </div>
                  ));
                })()}
              </div>

              {/* Vehicle ESP */}
              <div className="bg-card p-4 rounded-xl border border-border">
                <h3 className="font-semibold mb-3 flex items-center gap-2"><Zap size={16} /> Vehicle ESP</h3>
                <div className="space-y-2 max-h-60 overflow-y-auto">
                  {(() => {
                    const valid = trackerRef.current ? [] : [];
                    const entities = Array.from((trackerRef.current as any).entities?.values?.() || []) as TrackedEntity[];
                    const filtered = entities.filter((b: any) => b.age >= 2);
                    if (filtered.length === 0) return <p className="text-sm text-muted-foreground">{isAnalyzing ? "Scanning..." : "Start"}</p>;
                    return filtered.map((b: any) => {
                      const { current: speedKmh } = calculateRealSpeed(b, pixelsPerMeterRef.current);
                      const correctedSpeed = perspectiveCorrectedSpeed(speedKmh, b.kalman.getState().y, videoRef.current?.videoHeight || 480);
                      const accelLabel = b.acceleration < -0.3 ? "BRAKE" : b.acceleration > 0.3 ? "ACC" : "CRUISE";
                      const accelColor = b.acceleration < -0.3 ? "text-red-400" : b.acceleration > 0.3 ? "text-green-400" : "text-gray-400";
                      return (
                        <div key={b.id} className="p-2 bg-background rounded text-xs space-y-1">
                          <div className="flex items-center justify-between">
                            <span className={`font-medium ${b.class === "car" ? "text-green-400" : b.class === "motorcycle" ? "text-yellow-400" : "text-blue-400"}`}>{b.class} #{b.id}</span>
                            <span className={accelColor}>{accelLabel}</span>
                          </div>
                          <div className="flex gap-2 text-muted-foreground flex-wrap">
                            <span>{correctedSpeed}km/h</span>
                            <span>a:{b.acceleration.toFixed(2)}</span>
                            <span>θ:{Math.round(b.heading * 180 / Math.PI)}°</span>
                            <span>age:{b.age}f</span>
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

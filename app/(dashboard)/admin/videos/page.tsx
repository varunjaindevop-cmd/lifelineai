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

export default function VideoAnalysisPage() {
  const [selectedClip, setSelectedClip] = useState<VideoClip | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [videoReady, setVideoReady] = useState(false);
  const [incidents, setIncidents] = useState<IncidentAlert[]>([]);
  const [state, setState] = useState("monitoring");
  const [objectCount, setObjectCount] = useState(0);
  const [envMode, setEnvMode] = useState<EnvMode>("isolated");
  const [modelReady, setModelReady] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tmpCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number>(0);
  const analyzingRef = useRef(false);
  const trackerRef = useRef(new MultiObjectTracker());
  const modelRef = useRef<any>(null);
  const stateRef = useRef("monitoring");
  const frameRef = useRef(0);
  const cooldownRef = useRef(0);
  const accumRef = useRef<Float32Array>(new Float32Array(GRID_COLS * GRID_ROWS));
  const prevChangeGridRef = useRef<Float32Array | null>(null);
  const consecutiveAnomalyRef = useRef(0);
  const pixelsPerMeterRef = useRef(20);
  const alertTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const videoReadyTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const canvasSizedRef = useRef(false);
  const supabase = createClient();

  // Load COCO-SSD once on mount
  useEffect(() => {
    const loadModel = async () => {
      try {
        const [tf, cocoSsd] = await Promise.all([
          import("@tensorflow/tfjs"),
          import("@tensorflow-models/coco-ssd"),
        ]);
        await tf.ready();
        modelRef.current = await cocoSsd.load({ base: "lite_mobilenet_v2" });
        setModelReady(true);
      } catch (e) {
        console.error("COCO-SSD load failed:", e);
        toast.error("AI model failed to load.");
      }
    };
    loadModel();
    return () => {
      cancelAnimationFrame(rafRef.current);
      if (alertTimeoutRef.current) clearTimeout(alertTimeoutRef.current);
      if (videoReadyTimeoutRef.current) clearTimeout(videoReadyTimeoutRef.current);
    };
  }, []);

  // Fallback: force videoReady after 5s if events don't fire (Vercel issue)
  useEffect(() => {
    if (selectedClip) {
      setVideoReady(false);
      if (videoReadyTimeoutRef.current) clearTimeout(videoReadyTimeoutRef.current);
      videoReadyTimeoutRef.current = setTimeout(() => {
        setVideoReady(true);
        console.log("[SAGE] Video ready forced by timeout (events may not have fired)");
      }, 5000);
    }
    return () => { if (videoReadyTimeoutRef.current) clearTimeout(videoReadyTimeoutRef.current); };
  }, [selectedClip]);

  // Recalibrate PPM when env mode changes
  useEffect(() => {
    if (videoRef.current) {
      pixelsPerMeterRef.current = autoCalibrate(videoRef.current.videoWidth || 640, videoRef.current.videoHeight || 480, envMode);
    }
  }, [envMode]);

  const getTmp = useCallback(() => {
    if (!tmpCanvasRef.current) tmpCanvasRef.current = document.createElement("canvas");
    return tmpCanvasRef.current;
  }, []);

  // Create AudioContext on first user interaction
  const getAudioCtx = useCallback(() => {
    if (!audioCtxRef.current) {
      try { audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)(); } catch {}
    }
    return audioCtxRef.current;
  }, []);

  const playAlertSound = useCallback(() => {
    const ctx = getAudioCtx();
    if (!ctx) return;
    try {
      if (ctx.state === "suspended") ctx.resume();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.frequency.value = 880; osc.type = "sine"; gain.gain.value = 0.3;
      osc.start(); gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
      osc.stop(ctx.currentTime + 0.4);
    } catch {}
  }, [getAudioCtx]);

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

  const drawFrame = (entities: TrackedEntity[], ttcPairs: TTCPair[], evidence: AccidentEvidence[], videoW: number, videoH: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Size canvas once
    if (!canvasSizedRef.current || canvas.width !== videoW || canvas.height !== videoH) {
      canvas.width = videoW;
      canvas.height = videoH;
      canvasSizedRef.current = true;
    }
    ctx.clearRect(0, 0, videoW, videoH);

    // Draw objects
    for (const entity of entities) {
      if (entity.age < 1) continue;
      const isInvolved = evidence.some(e => e.objects.includes(entity.id));
      const baseColor = entity.class === "car" ? "#22c55e" : entity.class === "motorcycle" ? "#f59e0b" : "#3b82f6";
      const color = isInvolved ? "#ef4444" : baseColor;
      const cx = entity.kalman.getState().x, cy = entity.kalman.getState().y;
      const bx = cx - entity.w / 2, by = cy - entity.h / 2;

      ctx.strokeStyle = color;
      ctx.lineWidth = isInvolved ? 3 : 2;
      ctx.strokeRect(bx, by, entity.w, entity.h);

      // Heading arrow
      const arrowLen = Math.min(entity.w, entity.h) * 0.5;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(entity.heading) * arrowLen, cy + Math.sin(entity.heading) * arrowLen);
      ctx.strokeStyle = isInvolved ? "#ef4444" : "#fff";
      ctx.lineWidth = 2;
      ctx.stroke();

      // Label
      const { current: speedKmh } = calculateRealSpeed(entity, pixelsPerMeterRef.current);
      const corrected = perspectiveCorrectedSpeed(speedKmh, cy, videoH);
      const accelLabel = entity.acceleration < -0.3 ? " BRAKE" : "";
      const label = `${entity.class} ${corrected}km/h${accelLabel}`;
      ctx.font = "bold 11px Arial";
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = isInvolved ? "#ef4444" : "rgba(0,0,0,0.75)";
      ctx.fillRect(bx, by - 18, tw + 8, 16);
      ctx.fillStyle = "#fff";
      ctx.fillText(label, bx + 4, by - 5);
    }

    // TTC lines
    for (const pair of ttcPairs) {
      if (pair.severity === "none") continue;
      const lineColor = pair.severity === "impact" ? "#ef4444" : pair.severity === "critical" ? "#f97316" : "#f59e0b";
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = lineColor;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(pair.a.kalman.getState().x, pair.a.kalman.getState().y);
      ctx.lineTo(pair.b.kalman.getState().x, pair.b.kalman.getState().y);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Bottom bar
    const barY = videoH - 20;
    ctx.fillStyle = "rgba(0,0,0,0.7)";
    ctx.fillRect(0, barY, videoW, 20);
    ctx.fillStyle = "#fff";
    ctx.font = "11px Arial";
    const modeLabel = envMode === "traffic" ? "TRAFFIC" : envMode === "marketplace" ? "MARKETPLACE" : "ISOLATED";
    ctx.fillText(`${modeLabel} | Objects: ${entities.filter(e => e.age >= 1).length} | PPM: ${pixelsPerMeterRef.current.toFixed(1)}`, 8, barY + 14);
  };

  const createIncident = async (alert: IncidentAlert) => {
    setIncidents(prev => [...prev, alert]);
    toast.error(`ACCIDENT: ${alert.type.replace(/_/g, " ")} (${alert.severity})`);
    playAlertSound();

    try {
      const { data: inc, error } = await supabase.from("incidents").insert({
        severity: alert.severity, incident_type: alert.type,
        latitude: alert.latitude, longitude: alert.longitude,
        location_name: `Video Analysis: ${selectedClip?.name}`,
        detection_confidence: alert.confidence,
        detection_data: { source: "ttc_engine", clip: selectedClip?.name },
        video_clip_url: selectedClip?.src || null,
        status: "detected",
      }).select().single();
      if (!error && inc) {
        try {
          supabase.channel("alerts:ambulance").send({
            type: "broadcast", event: "new_incident",
            payload: { incident_id: inc.id, severity: alert.severity, incident_type: alert.type,
              latitude: alert.latitude, longitude: alert.longitude, video_clip_url: selectedClip?.src,
              message: `ACCIDENT: ${alert.type.replace(/_/g, " ")}` },
          });
        } catch {}
      }
    } catch (e) { console.error("Incident failed:", e); }
  };

  // ========== MAIN LOOP ==========
  const startAnalysis = async () => {
    if (!videoRef.current || !selectedClip || analyzingRef.current) return;
    if (!modelRef.current) { toast.error("AI model still loading..."); return; }
    const video = videoRef.current;
    try { await video.play(); } catch {
      video.muted = true;
      try { await video.play(); } catch { toast.error("Cannot play video"); return; }
    }

    trackerRef.current.reset();
    accumRef.current.fill(0);
    prevChangeGridRef.current = null;
    frameRef.current = 0;
    cooldownRef.current = 0;
    consecutiveAnomalyRef.current = 0;
    stateRef.current = "monitoring";
    canvasSizedRef.current = false;
    pixelsPerMeterRef.current = autoCalibrate(video.videoWidth || 640, video.videoHeight || 480, envMode);

    analyzingRef.current = true;
    setIsAnalyzing(true);
    setIncidents([]);
    setState("monitoring");
    setObjectCount(0);

    let lastDetectTime = 0;
    let latestDetections: { class: string; cx: number; cy: number; w: number; h: number; confidence: number }[] = [];
    let isDetecting = false;

    const scheduleDetection = (vid: HTMLVideoElement) => {
      if (isDetecting || !modelRef.current || vid.paused || vid.ended) return;
      const now = Date.now();
      if (now - lastDetectTime < 300) return;
      isDetecting = true;
      lastDetectTime = now;
      modelRef.current.detect(vid).then((preds: any[]) => {
        // Filter by class and score
        const filtered = preds
          .filter((p: any) => p.class in COCO_MAP && p.score > 0.25)
          .map((p: any) => {
            const [x, y, w, h] = p.bbox;
            return { class: COCO_MAP[p.class], cx: x + w / 2, cy: y + h / 2, w, h, confidence: p.score };
          });

        // Merge duplicate detections of same class that overlap heavily
        const merged: typeof filtered = [];
        const used = new Set<number>();
        for (let i = 0; i < filtered.length; i++) {
          if (used.has(i)) continue;
          let best = filtered[i];
          for (let j = i + 1; j < filtered.length; j++) {
            if (used.has(j)) continue;
            if (filtered[i].class !== filtered[j].class) continue;
            // Check center distance — if very close, it's the same object
            const d = Math.sqrt((best.cx - filtered[j].cx) ** 2 + (best.cy - filtered[j].cy) ** 2);
            const avgSize = (best.w + best.h + filtered[j].w + filtered[j].h) / 4;
            if (d < avgSize * 0.5) {
              // Merge: keep the higher confidence one
              if (filtered[j].confidence > best.confidence) best = filtered[j];
              used.add(j);
            }
          }
          merged.push(best);
        }

        latestDetections = merged;
        console.log(`[SAGE] COCO-SSD: ${preds.length} raw → ${filtered.length} filtered → ${merged.length} merged`);
      }).catch((e: any) => {
        console.error("[SAGE] COCO-SSD error:", e);
      }).finally(() => { isDetecting = false; });
    };

    let lastChangeTime = 0;

    const loop = () => {
      try {
        if (!videoRef.current || videoRef.current.paused || videoRef.current.ended || !analyzingRef.current) return;

        const now = Date.now();
        frameRef.current++;
        if (cooldownRef.current > 0) cooldownRef.current--;

        scheduleDetection(videoRef.current);

        const entities = trackerRef.current.update(latestDetections, frameRef.current);
        const validEntities = entities.filter(e => e.age >= 1); // age 1 = just detected

        // Debug logging every 3 seconds
        if (now - (loop as any).lastLogTime > 3000) {
          (loop as any).lastLogTime = now;
          console.log(`[SAGE] Frame ${frameRef.current} | Objects: ${validEntities.length} | Detections: ${latestDetections.length} | Mode: ${envMode}`);
        }

        // Update object count every 500ms
        if (now % 500 < 20) setObjectCount(validEntities.length);

        // Change detection — time-based, every 500ms
        if (now - lastChangeTime > 500) {
          lastChangeTime = now;
          try {
            const tmp = getTmp();
            tmp.width = video.videoWidth || 640;
            tmp.height = video.videoHeight || 480;
            const tCtx = tmp.getContext("2d", { willReadFrequently: true })!;
            tCtx.drawImage(video, 0, 0, tmp.width, tmp.height);
            const imgData = tCtx.getImageData(0, 0, tmp.width, tmp.height);
            const changeGrid = computeChangeGrid(imgData.data, tmp.width, tmp.height);
            const prev = prevChangeGridRef.current;
            for (let i = 0; i < GRID_COLS * GRID_ROWS; i++) {
              const diff = prev ? Math.abs(changeGrid[i] - prev[i]) / 255 : 0;
              accumRef.current[i] = accumRef.current[i] * 0.95 + diff * 3;
            }
            prevChangeGridRef.current = changeGrid;
          } catch {}
        }

        const ttcPairs = findAllTTCPairs(validEntities);
        const evidence = detectAccidents(validEntities, ttcPairs, envMode);

        drawFrame(validEntities, ttcPairs, evidence, video.videoWidth || 640, video.videoHeight || 480);

        // State machine — simple: overlap for N frames = alert
        const hasCollision = evidence.some(e => e.type === "collision");

        if (hasCollision) consecutiveAnomalyRef.current++;
        else consecutiveAnomalyRef.current = Math.max(0, consecutiveAnomalyRef.current - 1);

        let st = stateRef.current;

        if (consecutiveAnomalyRef.current >= 2) {
          if (st === "monitoring") st = "watching";
          else if (st === "watching" && consecutiveAnomalyRef.current >= 4) st = "confirming";
          else if (st === "confirming" && consecutiveAnomalyRef.current >= 6) st = "alert";
        } else if (now % 2000 < 20) {
          st = st === "alert" ? "confirming" : st === "confirming" ? "watching" : "monitoring";
        }

        // Alert
        if (st === "alert" && stateRef.current !== "alert" && cooldownRef.current <= 0) {
          cooldownRef.current = 300; // 10 seconds at 60fps — long cooldown
          consecutiveAnomalyRef.current = 0;

          const topEv = evidence[0];
          let incidentType = "vehicle_collision";
          let severity = topEv?.confidence === 0.9 ? "critical" : "major";

          if (incidentType) {
            createIncident({
              type: incidentType, severity,
              confidence: topEv?.confidence || 0.6,
              timestamp: new Date().toISOString(),
              latitude: LAT + (Math.random() - 0.5) * 0.01,
              longitude: LNG + (Math.random() - 0.5) * 0.01,
            });
            if (alertTimeoutRef.current) clearTimeout(alertTimeoutRef.current);
            alertTimeoutRef.current = setTimeout(() => { stateRef.current = "monitoring"; setState("monitoring"); }, 8000);
          }
        }

        stateRef.current = st;
        setState(st);
      } catch (e) { console.error(e); }

      if (analyzingRef.current && videoRef.current && !videoRef.current.paused) {
        rafRef.current = requestAnimationFrame(loop);
      }
    };
    rafRef.current = requestAnimationFrame(loop);
  };

  const stopAnalysis = () => {
    analyzingRef.current = false;
    cancelAnimationFrame(rafRef.current);
    if (alertTimeoutRef.current) { clearTimeout(alertTimeoutRef.current); alertTimeoutRef.current = null; }
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
    cooldownRef.current = 0;
    consecutiveAnomalyRef.current = 0;
    canvasSizedRef.current = false;
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
        <p className="text-muted-foreground">COCO-SSD AI + Kalman tracking + TTC prediction</p>
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
                    playsInline muted loop preload="auto"
                    onLoadedData={() => { setVideoReady(true); if (videoReadyTimeoutRef.current) clearTimeout(videoReadyTimeoutRef.current); }}
                    onCanPlay={() => { setVideoReady(true); if (videoReadyTimeoutRef.current) clearTimeout(videoReadyTimeoutRef.current); }}
                    onError={(e) => console.error("[SAGE] Video error:", e)} />
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
                        <><Play size={16} /> Start Analysis</>}
                    </button>
                  ) : (
                    <button onClick={stopAnalysis} className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors flex items-center gap-2"><Pause size={16} /> Stop</button>
                  )}
                  <span className="text-muted-foreground text-xs">{selectedClip.name}</span>
                  <div className="flex gap-1 ml-auto">
                    {envModes.map(m => (
                      <button key={m.key} onClick={() => setEnvMode(m.key)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5 ${
                          envMode === m.key
                            ? m.color === "blue" ? "bg-blue-600 text-white" : m.color === "orange" ? "bg-orange-600 text-white" : "bg-purple-600 text-white"
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
                <div className="mt-2 text-xs text-muted-foreground">Mode: {envMode} | PPM: {pixelsPerMeterRef.current.toFixed(1)}</div>
              </div>

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

              <div className="bg-card p-4 rounded-xl border border-border">
                <h3 className="font-semibold mb-3 flex items-center gap-2"><AlertTriangle size={16} /> Vehicle ESP</h3>
                <div className="space-y-2 max-h-60 overflow-y-auto">
                  {(() => {
                    const entities = Array.from((trackerRef.current as any).entities?.values?.() || []) as TrackedEntity[];
                    const filtered = entities.filter((b: any) => b.age >= 1);
                    if (filtered.length === 0) return <p className="text-sm text-muted-foreground">{isAnalyzing ? "Scanning..." : "Start"}</p>;
                    return filtered.map((b: any) => {
                      const { current: speedKmh } = calculateRealSpeed(b, pixelsPerMeterRef.current);
                      const corrected = perspectiveCorrectedSpeed(speedKmh, b.kalman.getState().y, videoRef.current?.videoHeight || 480);
                      const accelLabel = b.acceleration < -0.3 ? "BRAKE" : b.acceleration > 0.3 ? "ACC" : "CRUISE";
                      const accelColor = b.acceleration < -0.3 ? "text-red-400" : b.acceleration > 0.3 ? "text-green-400" : "text-gray-400";
                      return (
                        <div key={b.id} className="p-2 bg-background rounded text-xs">
                          <div className="flex items-center justify-between">
                            <span className={`font-medium ${b.class === "car" ? "text-green-400" : b.class === "motorcycle" ? "text-yellow-400" : "text-blue-400"}`}>{b.class} #{b.id}</span>
                            <span className={accelColor}>{accelLabel}</span>
                          </div>
                          <div className="flex gap-2 text-muted-foreground flex-wrap">
                            <span>{corrected}km/h</span>
                            <span>a:{b.acceleration.toFixed(2)}</span>
                            <span>θ:{Math.round(b.heading * 180 / Math.PI)}°</span>
                          </div>
                        </div>
                      );
                    });
                  })()}
                </div>
              </div>

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

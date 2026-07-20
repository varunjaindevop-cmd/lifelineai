"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { ArrowLeft, Video, Play, Pause, AlertTriangle, Clock, Navigation, Loader2, Zap, Car, Users, Activity, BarChart3, TrendingUp } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { useDetectionWorker, type UseDetectionWorkerReturn } from "@/hooks/useDetectionWorker";

interface VideoClip { name: string; src: string; description: string }
interface IncidentAlert { type: string; severity: string; confidence: number; timestamp: string; latitude: number; longitude: number }
type EnvMode = "isolated" | "traffic" | "marketplace";

const VIDEO_CLIPS: VideoClip[] = [
  { name: "accident_sample.mp4", src: "/videos/accident_sample.mp4", description: "Vehicle collision" },
  { name: "camera2_demo.mp4", src: "/videos/camera2_demo.mp4", description: "Traffic monitoring" },
  { name: "camera4_demo.mp4", src: "/videos/camera4_demo.mp4", description: "Intersection monitoring" },
  { name: "checking.mp4", src: "/videos/checking.mp4", description: "System check" },
];
const LAT = 22.7196, LNG = 75.8577;
const GRID_COLS = 10, GRID_ROWS = 8;

function MiniSparkline({ data, color = "#22c55e", maxVal = 80 }: { data: number[]; color?: string; maxVal?: number }) {
  if (data.length < 2) return <div className="h-6 bg-muted/30 rounded" />;
  const w = 120, h = 24;
  return (
    <svg width={w} height={h} className="block">
      <polyline fill="none" stroke={color} strokeWidth="1.5"
        points={data.map((v, i) => `${(i / (data.length - 1)) * w},${h - Math.min(v, maxVal) / maxVal * h}`).join(" ")} />
    </svg>
  );
}

function ClassBarChart({ entities }: { entities: { class: string; age: number }[] }) {
  const counts = { car: 0, motorcycle: 0, person: 0 };
  entities.filter(e => e.age >= 1).forEach(e => { if (e.class in counts) counts[e.class as keyof typeof counts]++; });
  const max = Math.max(1, ...Object.values(counts));
  const colors: Record<string, string> = { car: "#22c55e", motorcycle: "#f59e0b", person: "#3b82f6" };
  return (
    <div className="space-y-1.5">
      {Object.entries(counts).map(([cls, count]) => (
        <div key={cls} className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground w-16 truncate">{cls}</span>
          <div className="flex-1 h-3 bg-muted/30 rounded-full overflow-hidden">
            <div className="h-full rounded-full transition-all duration-300" style={{ width: `${(count / max) * 100}%`, backgroundColor: colors[cls] }} />
          </div>
          <span className="text-xs font-mono w-4 text-right">{count}</span>
        </div>
      ))}
    </div>
  );
}

export default function VideoAnalysisPage() {
  const [selectedClip, setSelectedClip] = useState<VideoClip | null>(null);
  const [videoReady, setVideoReady] = useState(false);
  const [envMode, setEnvMode] = useState<EnvMode>("isolated");
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoReadyTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const supabase = createClient();
  const detection: UseDetectionWorkerReturn = useDetectionWorker(envMode);
  const { isReady, isAnalyzing, state, entities, evidence, changeGrid, fps, incidents } = detection;
  const speedHistoryRef = useRef<Record<number, number[]>>({});
  const confHistoryRef = useRef<number[]>([]);

  useEffect(() => {
    if (!isAnalyzing || entities.length === 0) return;
    const newHistory = { ...speedHistoryRef.current };
    entities.filter(e => e.age >= 1).forEach(e => {
      const speed = Math.round(Math.abs(e.speed) * 10);
      if (!newHistory[e.id]) newHistory[e.id] = [];
      newHistory[e.id] = [...newHistory[e.id].slice(-19), speed];
    });
    speedHistoryRef.current = newHistory;
    if (evidence.length > 0) confHistoryRef.current = [...confHistoryRef.current.slice(-19), evidence[0].confidence * 100];
  }, [entities, evidence, isAnalyzing]);

  useEffect(() => {
    if (selectedClip) {
      setVideoReady(false);
      if (videoReadyTimeoutRef.current) clearTimeout(videoReadyTimeoutRef.current);
      videoReadyTimeoutRef.current = setTimeout(() => setVideoReady(true), 5000);
    }
    return () => { if (videoReadyTimeoutRef.current) clearTimeout(videoReadyTimeoutRef.current); };
  }, [selectedClip]);

  useEffect(() => { detection.setMode(envMode); }, [envMode]); // eslint-disable-line react-hooks/exhaustive-deps

  const getAudioCtx = useCallback(() => {
    if (!audioCtxRef.current) try { audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)(); } catch {}
    return audioCtxRef.current;
  }, []);

  const playAlertSound = useCallback(() => {
    const ctx = getAudioCtx();
    if (!ctx) return;
    try {
      if (ctx.state === "suspended") ctx.resume();
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.frequency.value = 880; osc.type = "sine"; gain.gain.value = 0.3;
      osc.start(); gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
      osc.stop(ctx.currentTime + 0.4);
    } catch {}
  }, [getAudioCtx]);

  const createIncident = useCallback(async (alert: IncidentAlert) => {
    toast.error(`ACCIDENT: ${alert.type.replace(/_/g, " ")} (${alert.severity})`);
    playAlertSound();
    try {
      const { data: inc, error } = await supabase.from("incidents").insert({
        severity: alert.severity, incident_type: alert.type,
        latitude: alert.latitude, longitude: alert.longitude,
        location_name: `Video Analysis: ${selectedClip?.name}`,
        detection_confidence: alert.confidence,
        detection_data: { source: "yolov8n_worker", clip: selectedClip?.name },
        video_clip_url: selectedClip?.src || null, status: "detected",
      }).select().single();
      if (!error && inc) {
        supabase.channel("alerts:ambulance").send({
          type: "broadcast", event: "new_incident",
          payload: { incident_id: inc.id, severity: alert.severity, incident_type: alert.type,
            latitude: alert.latitude, longitude: alert.longitude, video_clip_url: selectedClip?.src,
            message: `ACCIDENT: ${alert.type.replace(/_/g, " ")}` },
        }).catch(() => {});
      }
    } catch (e) { console.error("Incident failed:", e); }
  }, [supabase, selectedClip, playAlertSound]);

  useEffect(() => {
    if (incidents.length === 0) return;
    const latest = incidents[incidents.length - 1];
    createIncident({ ...latest, latitude: LAT + (Math.random() - 0.5) * 0.01, longitude: LNG + (Math.random() - 0.5) * 0.01 });
  }, [incidents.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Canvas drawing — sized to video display dimensions via CSS, pixel coords via getBoundingClientRect
  const drawFrame = useCallback(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Size canvas to match the video's CSS display size (not intrinsic size)
    const rect = video.getBoundingClientRect();
    const displayW = Math.round(rect.width);
    const displayH = Math.round(rect.height);
    if (canvas.width !== displayW || canvas.height !== displayH) {
      canvas.width = displayW;
      canvas.height = displayH;
    }

    const currentEntities = entitiesRef.current;
    const currentEvidence = evidenceRef.current;

    ctx.clearRect(0, 0, displayW, displayH);

    // Scale factor: display coords vs video intrinsic coords
    const videoW = video.videoWidth || 640;
    const videoH = video.videoHeight || 480;
    const scaleX = displayW / videoW;
    const scaleY = displayH / videoH;

    for (const entity of currentEntities) {
      if (entity.age < 1) continue;
      const isInvolved = currentEvidence.some(e => e.objects.includes(entity.id));
      const baseColor = entity.class === "car" ? "#22c55e" : entity.class === "motorcycle" ? "#f59e0b" : "#3b82f6";
      const color = isInvolved ? "#ef4444" : baseColor;

      // Convert entity coords (in video intrinsic pixels) to display pixels
      const bx = (entity.x - entity.w / 2) * scaleX;
      const by = (entity.y - entity.h / 2) * scaleY;
      const bw = entity.w * scaleX;
      const bh = entity.h * scaleY;

      ctx.strokeStyle = color;
      ctx.lineWidth = isInvolved ? 3 : 2;
      ctx.strokeRect(bx, by, bw, bh);

      // Corner markers
      const cl = Math.min(8, bw * 0.15, bh * 0.15);
      ctx.lineWidth = 3;
      [[bx, by + cl, bx, by, bx + cl, by], [bx + bw - cl, by, bx + bw, by, bx + bw, by + cl],
       [bx, by + bh - cl, bx, by + bh, bx + cl, by + bh], [bx + bw - cl, by + bh, bx + bw, by + bh, bx + bw, by + bh - cl]]
        .forEach(([x1, y1, x2, y2, x3, y3]) => { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.lineTo(x3, y3); ctx.stroke(); });

      // Trail
      if (entity.positions.length > 1) {
        ctx.beginPath(); ctx.strokeStyle = `${color}66`; ctx.lineWidth = 1;
        const trail = entity.positions.slice(-5);
        trail.forEach((p, i) => { i === 0 ? ctx.moveTo(p.x * scaleX, p.y * scaleY) : ctx.lineTo(p.x * scaleX, p.y * scaleY); });
        ctx.stroke();
      }

      // Label
      const speedKmh = Math.round(entity.speed * 10);
      const accelLabel = entity.acceleration < -0.3 ? " BRAKE" : entity.acceleration > 0.3 ? " ACC" : "";
      const label = `#${entity.id} ${entity.class} ${speedKmh}km/h${accelLabel}`;
      ctx.font = `bold ${Math.max(10, 10 * scaleX)}px monospace`;
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = isInvolved ? "#ef4444" : "rgba(0,0,0,0.8)";
      ctx.fillRect(bx, by - 20, tw + 8, 18);
      ctx.fillStyle = "#fff";
      ctx.fillText(label, bx + 4, by - 6);
    }

    // Bottom bar
    const barY = displayH - 20;
    ctx.fillStyle = "rgba(0,0,0,0.7)";
    ctx.fillRect(0, barY, displayW, 20);
    ctx.fillStyle = "#fff";
    ctx.font = `${Math.max(11, 11 * scaleX)}px Arial`;
    const modeLabel = envMode === "traffic" ? "TRAFFIC" : envMode === "marketplace" ? "MARKETPLACE" : "ISOLATED";
    ctx.fillText(`${modeLabel} | Objects: ${currentEntities.filter(e => e.age >= 1).length} | FPS: ${fps}`, 8, barY + 14);
  }, [envMode, fps]);

  const entitiesRef = useRef(entities);
  const evidenceRef = useRef(evidence);
  entitiesRef.current = entities;
  evidenceRef.current = evidence;

  useEffect(() => {
    if (!isAnalyzing) return;
    let rafId: number;
    let lastDraw = 0;
    const draw = (timestamp: number) => {
      if (timestamp - lastDraw > 66) { lastDraw = timestamp; drawFrame(); }
      rafId = requestAnimationFrame(draw);
    };
    rafId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafId);
  }, [isAnalyzing]); // eslint-disable-line react-hooks/exhaustive-deps

  const startAnalysis = useCallback(() => {
    if (!videoRef.current || !selectedClip) return;
    const video = videoRef.current;
    video.play().then(() => detection.startAnalysis(video))
      .catch(() => { video.muted = true; video.play().then(() => detection.startAnalysis(video)).catch(() => toast.error("Cannot play video")); });
  }, [detection, selectedClip]);

  const stopAnalysis = useCallback(() => {
    detection.stopAnalysis();
    if (videoRef.current) { videoRef.current.pause(); videoRef.current.currentTime = 0; }
  }, [detection]);

  const stateColors: Record<string, string> = { monitoring: "bg-green-500/20 text-green-500", alert: "bg-red-500/20 text-red-500 animate-pulse" };
  const envModes: { key: EnvMode; label: string; icon: React.ReactNode; color: string }[] = [
    { key: "isolated", label: "Isolated Road", icon: <Car size={14} />, color: "blue" },
    { key: "traffic", label: "Traffic", icon: <Car size={14} />, color: "orange" },
    { key: "marketplace", label: "Marketplace", icon: <Users size={14} />, color: "purple" },
  ];

  return (
    <div className="space-y-6">
      <Link href="/admin" className="inline-flex items-center gap-2 text-muted-foreground hover:text-foreground"><ArrowLeft size={16} /> Back to Admin</Link>
      <div>
        <h1 className="text-2xl font-bold">Video Analysis</h1>
        <p className="text-muted-foreground">YOLOv8n AI + Kalman tracking (Web Worker)</p>
      </div>

      {!selectedClip ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {VIDEO_CLIPS.map(clip => (
            <button key={clip.name} onClick={() => setSelectedClip(clip)} className="bg-card p-5 rounded-xl border border-border hover:border-primary/50 transition-colors text-left">
              <div className="flex items-start gap-4">
                <div className="w-16 h-16 bg-background rounded-lg flex items-center justify-center shrink-0"><Video className="w-8 h-8 text-primary" /></div>
                <div><h3 className="font-semibold">{clip.name}</h3><p className="text-sm text-muted-foreground mt-1">{clip.description}</p></div>
              </div>
            </button>
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          <button onClick={() => { stopAnalysis(); setSelectedClip(null); setVideoReady(false); }} className="text-sm text-primary hover:underline">&larr; Choose different clip</button>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2">
              <div className="bg-card rounded-xl border border-border overflow-hidden">
                <div className="relative bg-black">
                  {/* Video fills its container width naturally */}
                  <video ref={videoRef} src={selectedClip.src} className="w-full h-auto object-contain block"
                    playsInline muted loop preload="auto"
                    onLoadedData={() => { setVideoReady(true); if (videoReadyTimeoutRef.current) clearTimeout(videoReadyTimeoutRef.current); }}
                    onCanPlay={() => { setVideoReady(true); if (videoReadyTimeoutRef.current) clearTimeout(videoReadyTimeoutRef.current); }} />
                  {/* Canvas overlay positioned to exactly match video display size */}
                  <canvas ref={canvasRef} className="absolute inset-0 w-full h-full pointer-events-none" />
                  {!videoReady && <div className="absolute inset-0 flex items-center justify-center bg-black/50">
                    <div className="flex items-center gap-2 text-white"><Loader2 className="w-5 h-5 animate-spin" /> Loading...</div>
                  </div>}
                  {isAnalyzing && <div className="absolute top-4 left-4 flex items-center gap-2">
                    <div className="w-3 h-3 bg-red-500 rounded-full animate-pulse" />
                    <span className="text-sm font-medium bg-black/60 px-2 py-1 rounded">Tracking {entities.length} objects | {fps} FPS</span>
                  </div>}
                </div>
                <div className="p-4 border-t border-border flex items-center gap-3 flex-wrap">
                  {!isAnalyzing ? (
                    <button onClick={startAnalysis} disabled={!videoReady || !isReady}
                      className="px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors flex items-center gap-2 disabled:opacity-50">
                      {!isReady ? <><Loader2 size={16} className="animate-spin" /> Loading AI...</> : <><Play size={16} /> Start Analysis</>}
                    </button>
                  ) : (
                    <button onClick={stopAnalysis} className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors flex items-center gap-2"><Pause size={16} /> Stop</button>
                  )}
                  <span className="text-muted-foreground text-xs">{selectedClip.name}</span>
                  <div className="flex gap-1 ml-auto">
                    {envModes.map(m => (
                      <button key={m.key} onClick={() => setEnvMode(m.key)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5 ${envMode === m.key ? (m.color === "blue" ? "bg-blue-600 text-white" : m.color === "orange" ? "bg-orange-600 text-white" : "bg-purple-600 text-white") : "bg-card border border-border text-muted-foreground hover:bg-background"}`}>
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
                  {["monitoring", "alert"].map(s => (
                    <div key={s} className={`flex items-center gap-2 p-2 rounded ${state === s ? stateColors[s] : "text-muted-foreground"}`}>
                      <div className={`w-2 h-2 rounded-full ${state === s ? "bg-current animate-pulse" : "bg-border"}`} />
                      <span className="text-sm capitalize">{s}</span>
                    </div>
                  ))}
                </div>
                <div className="mt-2 text-xs text-muted-foreground">Mode: {envMode} | FPS: {fps}</div>
              </div>

              <div className="bg-card p-4 rounded-xl border border-border">
                <h3 className="font-semibold mb-3 flex items-center gap-2"><BarChart3 size={16} /> Object Distribution</h3>
                <ClassBarChart entities={entities} />
              </div>

              <div className="bg-card p-4 rounded-xl border border-border">
                <h3 className="font-semibold mb-3 flex items-center gap-2"><Zap size={16} /> Motion Heatmap</h3>
                <div className="grid gap-px" style={{ gridTemplateColumns: `repeat(${GRID_COLS}, 1fr)` }}>
                  {changeGrid.map((v, i) => (
                    <div key={i} className="aspect-square rounded-sm" style={{
                      backgroundColor: v > 0.08 ? `rgb(${Math.min(255, Math.floor(v * 2000))},0,0)` : v > 0.03 ? `rgb(${Math.min(255, Math.floor(v * 1500))},${Math.floor(v * 500)},0)` : `rgb(0,${Math.min(255, Math.floor(v * 3000))},0)`
                    }} />
                  ))}
                </div>
              </div>

              <div className="bg-card p-4 rounded-xl border border-border">
                <h3 className="font-semibold mb-3 flex items-center gap-2"><TrendingUp size={16} /> Confidence Trend</h3>
                <MiniSparkline data={confHistoryRef.current} color={confHistoryRef.current.length > 0 ? "#ef4444" : "#6b7280"} maxVal={100} />
                <div className="text-[10px] text-muted-foreground mt-1">{confHistoryRef.current.length > 0 ? `Current: ${confHistoryRef.current[confHistoryRef.current.length - 1].toFixed(0)}%` : "No data yet"}</div>
              </div>

              <div className="bg-card p-4 rounded-xl border border-border">
                <h3 className="font-semibold mb-3 flex items-center gap-2"><Activity size={16} /> Vehicle ESP</h3>
                <div className="space-y-2 max-h-60 overflow-y-auto">
                  {entities.filter(e => e.age >= 1).length === 0 ? (
                    <p className="text-sm text-muted-foreground">{isAnalyzing ? "Scanning..." : "Start analysis"}</p>
                  ) : entities.filter(e => e.age >= 1).map(b => {
                    const accelLabel = b.acceleration < -0.3 ? "BRAKE" : b.acceleration > 0.3 ? "ACC" : "CRUISE";
                    const accelColor = b.acceleration < -0.3 ? "text-red-400" : b.acceleration > 0.3 ? "text-green-400" : "text-gray-400";
                    const clsColor = b.class === "car" ? "text-green-400" : b.class === "motorcycle" ? "text-yellow-400" : "text-blue-400";
                    const sparkData = speedHistoryRef.current[b.id] || [];
                    return (
                      <div key={b.id} className="p-2 bg-background rounded text-xs">
                        <div className="flex items-center justify-between">
                          <span className={`font-medium ${clsColor}`}>{b.class} #{b.id}</span>
                          <span className={accelColor}>{accelLabel}</span>
                        </div>
                        <div className="flex gap-2 text-muted-foreground flex-wrap mt-1">
                          <span>{Math.round(Math.abs(b.speed) * 10)}km/h</span>
                          <span>a:{b.acceleration.toFixed(2)}</span>
                          <span>&theta;:{Math.round(b.heading * 180 / Math.PI)}&deg;</span>
                        </div>
                        {sparkData.length > 1 && <div className="mt-1"><MiniSparkline data={sparkData} color={clsColor === "text-green-400" ? "#22c55e" : clsColor === "text-yellow-400" ? "#f59e0b" : "#3b82f6"} /></div>}
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="bg-card p-4 rounded-xl border border-border">
                <h3 className="font-semibold mb-3">Incidents ({incidents.length})</h3>
                <div className="max-h-48 overflow-y-auto space-y-2">
                  {incidents.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{isAnalyzing ? "Monitoring..." : "None"}</p>
                  ) : incidents.map((inc, i) => (
                    <div key={i} className={`p-3 rounded-lg border-l-4 ${inc.severity === "critical" ? "border-red-500 bg-red-500/10" : "border-orange-500 bg-orange-500/10"}`}>
                      <div className="flex items-center gap-2"><AlertTriangle size={14} className="text-red-500" /><span className="text-sm font-medium capitalize">{inc.type.replace(/_/g, " ")}</span></div>
                      <div className="flex gap-3 mt-1 text-xs text-muted-foreground">
                        <span>{(inc.confidence * 100).toFixed(0)}%</span>
                        <span className="flex items-center gap-1"><Clock size={10} />{new Date(inc.timestamp).toLocaleTimeString()}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

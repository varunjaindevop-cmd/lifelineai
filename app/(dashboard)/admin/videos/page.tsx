"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  ArrowLeft, Video, Play, Pause, AlertTriangle, Clock,
  Navigation, RotateCcw, Loader2, Zap,
} from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";

interface VideoClip {
  name: string;
  src: string;
  description: string;
}

interface IncidentAlert {
  type: string;
  severity: string;
  confidence: number;
  timestamp: string;
  latitude: number;
  longitude: number;
}

interface MotionMetrics {
  totalEnergy: number;       // total motion in frame (0-1)
  maxRegionEnergy: number;   // hottest region (0-1)
  motionGradient: number;    // how fast motion is changing
  hotspots: { x: number; y: number; energy: number; w: number; h: number }[];
}

const VIDEO_CLIPS: VideoClip[] = [
  { name: "accident_sample.mp4", src: "/videos/accident_sample.mp4", description: "Vehicle collision scenario" },
  { name: "camera2_demo.mp4", src: "/videos/camera2_demo.mp4", description: "Traffic monitoring demo" },
  { name: "camera4_demo.mp4", src: "/videos/camera4_demo.mp4", description: "Intersection monitoring demo" },
  { name: "checking.mp4", src: "/videos/checking.mp4", description: "System verification clip" },
];

const DEMO_LAT = 22.7196;
const DEMO_LNG = 75.8577;

export default function VideoAnalysisPage() {
  const [selectedClip, setSelectedClip] = useState<VideoClip | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [videoReady, setVideoReady] = useState(false);
  const [incidents, setIncidents] = useState<IncidentAlert[]>([]);
  const [currentState, setCurrentState] = useState("monitoring");
  const [motionMetrics, setMotionMetrics] = useState<MotionMetrics | null>(null);
  const [motionHistory, setMotionHistory] = useState<number[]>([]);
  const [demoMode, setDemoMode] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const analysisCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const stateRef = useRef("monitoring");
  const frameCountRef = useRef(0);
  const stateFrameRef = useRef(0);
  const alertCooldownRef = useRef(0);
  const prevFrameRef = useRef<ImageData | null>(null);
  const motionHistoryRef = useRef<number[]>([]);
  const bgModelRef = useRef<Float32Array | null>(null); // running background model
  const supabase = createClient();

  useEffect(() => {
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, []);

  useEffect(() => {
    setVideoReady(false);
    const timeout = setTimeout(() => setVideoReady(true), 8000);
    return () => clearTimeout(timeout);
  }, [selectedClip]);

  const handleVideoReady = () => setVideoReady(true);
  const handleVideoError = () => {
    setTimeout(() => { if (videoRef.current) videoRef.current.load(); }, 1000);
  };

  const getAnalysisCanvas = useCallback(() => {
    if (!analysisCanvasRef.current) analysisCanvasRef.current = document.createElement("canvas");
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

  // ========== MOTION ENERGY ANALYSIS ==========
  // This is how real surveillance systems detect accidents —
  // by measuring anomalous motion patterns, not by identifying objects.

  const analyzeMotion = useCallback((currFrame: ImageData, prevFrame: ImageData, frameNum: number): MotionMetrics => {
    const w = currFrame.width;
    const h = currFrame.height;
    const curr = currFrame.data;
    const prev = prevFrame.data;
    const totalPixels = w * h;

    // Step 1: Compute per-pixel motion magnitude
    const motionMap = new Float32Array(totalPixels);
    let totalMotion = 0;
    let maxMotion = 0;

    for (let i = 0; i < totalPixels; i++) {
      const idx = i * 4;
      const grayCurr = curr[idx] * 0.299 + curr[idx + 1] * 0.587 + curr[idx + 2] * 0.114;
      const grayPrev = prev[idx] * 0.299 + prev[idx + 1] * 0.587 + prev[idx + 2] * 0.114;
      const diff = Math.abs(grayCurr - grayPrev) / 255;
      motionMap[i] = diff;
      totalMotion += diff;
      if (diff > maxMotion) maxMotion = diff;
    }

    const totalEnergy = totalMotion / totalPixels;

    // Step 2: Update background model (slow-moving average)
    if (!bgModelRef.current) {
      bgModelRef.current = new Float32Array(totalPixels);
      for (let i = 0; i < totalPixels; i++) {
        bgModelRef.current[i] = curr[i * 4] * 0.299 + curr[i * 4 + 1] * 0.587 + curr[i * 4 + 2] * 0.114;
      }
    } else {
      const alpha = 0.02; // slow adaptation
      for (let i = 0; i < totalPixels; i++) {
        const gray = curr[i * 4] * 0.299 + curr[i * 4 + 1] * 0.587 + curr[i * 4 + 2] * 0.114;
        bgModelRef.current[i] = bgModelRef.current[i] * (1 - alpha) + gray * alpha;
      }
    }

    // Step 3: Find hotspots (regions with concentrated motion)
    const blockSize = 32;
    const hotspots: MotionMetrics["hotspots"] = [];

    for (let by = 0; by < h; by += blockSize) {
      for (let bx = 0; bx < w; bx += blockSize) {
        let regionMotion = 0;
        let count = 0;

        for (let dy = 0; dy < blockSize && by + dy < h; dy++) {
          for (let dx = 0; dx < blockSize && bx + dx < w; dx++) {
            regionMotion += motionMap[(by + dy) * w + (bx + dx)];
            count++;
          }
        }

        const avgRegionMotion = count > 0 ? regionMotion / count : 0;

        if (avgRegionMotion > 0.08) { // significant motion in this region
          hotspots.push({
            x: bx, y: by,
            energy: avgRegionMotion,
            w: Math.min(blockSize, w - bx),
            h: Math.min(blockSize, h - by),
          });
        }
      }
    }

    // Sort hotspots by energy, keep top 5
    hotspots.sort((a, b) => b.energy - a.energy);
    const topHotspots = hotspots.slice(0, 5);

    const maxRegionEnergy = topHotspots.length > 0 ? topHotspots[0].energy : 0;

    // Step 4: Motion gradient (how fast total motion is changing)
    const history = motionHistoryRef.current;
    history.push(totalEnergy);
    if (history.length > 20) history.shift();

    let motionGradient = 0;
    if (history.length >= 5) {
      const recent = history.slice(-5).reduce((a, b) => a + b, 0) / 5;
      const older = history.slice(0, 5).reduce((a, b) => a + b, 0) / 5;
      motionGradient = older > 0 ? (recent - older) / older : 0;
    }

    return { totalEnergy, maxRegionEnergy, motionGradient, hotspots: topHotspots };
  }, []);

  // ========== ACCIDENT DETECTION ==========
  // Key insight: accidents cause SUSTAINED energy spikes (3+ frames).
  // A car passing is a brief 1-2 frame blip. People walking = gradual rise.
  // We require the spike to PERSIST before triggering.

  const spikeFrameRef = useRef(0); // how many consecutive frames have been spiking

  const detectAccident = useCallback((metrics: MotionMetrics, frameNum: number): { detected: boolean; confidence: number; type: string } => {
    const history = motionHistoryRef.current;

    if (history.length < 8) return { detected: false, confidence: 0, type: "" };

    // Baseline = average of frames 4-8 ago (well before current activity)
    const baselineSlice = history.slice(Math.max(0, history.length - 8), Math.max(0, history.length - 3));
    const baselineAvg = baselineSlice.length > 0 ? baselineSlice.reduce((a, b) => a + b, 0) / baselineSlice.length : 0.01;

    const currentEnergy = metrics.totalEnergy;

    // Spike ratio
    const spikeRatio = baselineAvg > 0.001 ? currentEnergy / baselineAvg : currentEnergy > 0.02 ? 5 : 0;

    // Frame-to-frame jump: how FAST did energy increase?
    // Accident = sudden jump (1 frame). Car passing = gradual (3-4 frames).
    const prevEnergy = history.length >= 2 ? history[history.length - 2] : baselineAvg;
    const frameJump = prevEnergy > 0.001 ? currentEnergy / prevEnergy : 1;
    const suddenJump = frameJump > 1.5; // >50% increase in single frame = sudden

    // Sustained check: must be spiking for 2+ consecutive frames
    const isSpikeNow = spikeRatio > 1.6 && currentEnergy > 0.012;
    if (isSpikeNow) {
      spikeFrameRef.current++;
    } else {
      spikeFrameRef.current = Math.max(0, spikeFrameRef.current - 1);
    }

    const sustainedSpike = spikeFrameRef.current >= 2; // sustained for 2+ frames

    // Confidence
    const confidence = Math.min(0.95,
      Math.min(spikeRatio / 3, 1) * 0.4 +
      (suddenJump ? 0.25 : 0) +
      (sustainedSpike ? 0.25 : 0) +
      (currentEnergy > 0.03 ? 0.1 : 0)
    );

    // Detection: sustained spike OR sudden large spike
    const detected = (sustainedSpike && spikeRatio > 1.6) || (suddenJump && spikeRatio > 2.0 && currentEnergy > 0.02);

    return { detected, confidence, type: "vehicle_collision" };
  }, []);

  // Draw motion visualization on canvas
  const drawMotionOverlay = (metrics: MotionMetrics | null) => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video || !metrics) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const scaleX = canvas.width / 320;
    const scaleY = canvas.height / 240;

    // Draw hotspots as semi-transparent overlays
    for (const spot of metrics.hotspots) {
      const intensity = Math.min(spot.energy * 5, 1);
      const color = intensity > 0.6 ? `rgba(255, 0, 0, ${intensity * 0.4})` :
                    intensity > 0.3 ? `rgba(255, 165, 0, ${intensity * 0.3})` :
                    `rgba(255, 255, 0, ${intensity * 0.2})`;

      ctx.fillStyle = color;
      ctx.fillRect(spot.x * scaleX, spot.y * scaleY, spot.w * scaleX, spot.h * scaleY);

      // Border for significant hotspots
      if (intensity > 0.4) {
        ctx.strokeStyle = intensity > 0.6 ? "red" : "orange";
        ctx.lineWidth = 2;
        ctx.strokeRect(spot.x * scaleX, spot.y * scaleY, spot.w * scaleX, spot.h * scaleY);

        // Label
        ctx.fillStyle = "white";
        ctx.font = "bold 12px Arial";
        ctx.fillText(`${(intensity * 100).toFixed(0)}%`, spot.x * scaleX + 4, spot.y * scaleY + 16);
      }
    }

    // Motion energy bar at bottom
    const barY = canvas.height - 30;
    const barWidth = canvas.width;
    const energyWidth = Math.min(metrics.totalEnergy * barWidth * 10, barWidth);
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(0, barY, barWidth, 25);
    ctx.fillStyle = metrics.totalEnergy > 0.05 ? "#ef4444" : metrics.totalEnergy > 0.02 ? "#f59e0b" : "#22c55e";
    ctx.fillRect(0, barY, energyWidth, 25);
    ctx.fillStyle = "white";
    ctx.font = "11px Arial";
    ctx.fillText(`Motion: ${(metrics.totalEnergy * 100).toFixed(1)}%`, 8, barY + 16);
  };

  const createIncidentFromDetection = async (alert: IncidentAlert) => {
    const { data: incident, error } = await supabase
      .from("incidents")
      .insert({
        severity: alert.severity,
        incident_type: alert.type,
        latitude: alert.latitude,
        longitude: alert.longitude,
        location_name: `Video Analysis: ${selectedClip?.name}`,
        detection_confidence: alert.confidence,
        detection_data: { source: "motion_energy", clip: selectedClip?.name },
        video_clip_url: selectedClip?.src || null,
        status: "detected",
      })
      .select()
      .single();

    if (error) {
      console.error("Incident insert error:", error);
    }

    setIncidents((prev) => [...prev, alert]);
    toast.error(`ACCIDENT DETECTED: ${alert.type.replace(/_/g, " ")} (${alert.severity}) — dispatching ambulance!`);

    if (incident) {
      supabase.channel("alerts:ambulance").send({
        type: "broadcast",
        event: "new_incident",
        payload: {
          incident_id: incident.id,
          severity: alert.severity,
          incident_type: alert.type,
          latitude: alert.latitude,
          longitude: alert.longitude,
          video_clip_url: selectedClip?.src,
          message: `ACCIDENT from video analysis: ${alert.type.replace(/_/g, " ")}`,
        },
      });
    }
  };

  const startAnalysis = async () => {
    if (!videoRef.current || !selectedClip) return;

    const video = videoRef.current;
    try { await video.play(); } catch {
      video.muted = false;
      try { await video.play(); } catch {
        toast.error("Could not play video. Try again.");
        return;
      }
    }

    setVideoReady(true);
    setIsAnalyzing(true);
    setIncidents([]);
    setCurrentState("monitoring");
    stateRef.current = "monitoring";
    stateFrameRef.current = 0;
    frameCountRef.current = 0;
    alertCooldownRef.current = 0;
    prevFrameRef.current = null;
    motionHistoryRef.current = [];
    bgModelRef.current = null;
    spikeFrameRef.current = 0;
    setMotionHistory([]);

    await new Promise((r) => setTimeout(r, 300));

    intervalRef.current = setInterval(() => {
      const frame = captureFrame();
      if (!frame) return;

      frameCountRef.current++;
      const fn = frameCountRef.current;

      if (alertCooldownRef.current > 0) alertCooldownRef.current--;

      let metrics: MotionMetrics | null = null;
      if (prevFrameRef.current) {
        metrics = analyzeMotion(frame, prevFrameRef.current, fn);
        setMotionMetrics(metrics);
        setMotionHistory([...motionHistoryRef.current]);

        // Draw overlay
        drawMotionOverlay(metrics);

        // Detect accident
        const result = detectAccident(metrics, fn);

        stateFrameRef.current++;
        let state = stateRef.current;

        if (result.detected) {
          if (state === "monitoring") state = "watching";
          else if (state === "watching") state = "confirming";
          else if (state === "confirming") state = "alert";
        } else if (!demoMode) {
          // Decay in real mode
          if (state !== "monitoring" && fn % 4 === 0) {
            state = state === "alert" ? "confirming" : state === "confirming" ? "watching" : "monitoring";
          }
        }

        // Demo mode: time-based
        if (demoMode) {
          const sf = stateFrameRef.current;
          if (sf === 15 && state === "monitoring") state = "watching";
          if (sf === 25 && state === "watching") state = "confirming";
          if (sf >= 35 && state === "confirming") state = "alert";
        }

        // Trigger alert — 10s cooldown so real accident after false alarm still triggers
        if (state === "alert" && stateRef.current !== "alert" && alertCooldownRef.current <= 0) {
          alertCooldownRef.current = 40; // 10 seconds

          createIncidentFromDetection({
            type: result.type || "vehicle_collision",
            severity: result.confidence > 0.7 ? "critical" : "major",
            confidence: result.confidence,
            timestamp: new Date().toISOString(),
            latitude: DEMO_LAT + (Math.random() - 0.5) * 0.01,
            longitude: DEMO_LNG + (Math.random() - 0.5) * 0.01,
          });

          setTimeout(() => {
            stateRef.current = "monitoring";
            stateFrameRef.current = 0;
            setCurrentState("monitoring");
          }, 5000);
        }

        stateRef.current = state;
        setCurrentState(state);
      }

      prevFrameRef.current = frame;
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
    setIncidents([]);
    setMotionMetrics(null);
    setMotionHistory([]);
    prevFrameRef.current = null;
    frameCountRef.current = 0;
    stateFrameRef.current = 0;
    alertCooldownRef.current = 0;
    motionHistoryRef.current = [];
    bgModelRef.current = null;
    spikeFrameRef.current = 0;
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
        <ArrowLeft size={16} /> Back to Admin
      </Link>

      <div>
        <h1 className="text-2xl font-bold">Video Analysis</h1>
        <p className="text-muted-foreground">Motion energy anomaly detection — accidents auto-dispatch ambulance</p>
      </div>

      {!selectedClip ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {VIDEO_CLIPS.map((clip) => (
            <button key={clip.name} onClick={() => setSelectedClip(clip)}
              className="bg-card p-5 rounded-xl border border-border hover:border-primary/50 transition-colors text-left">
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
          <button onClick={() => { resetClip(); setSelectedClip(null); setVideoReady(false); }}
            className="text-sm text-primary hover:underline">&larr; Choose different clip</button>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2 space-y-4">
              <div className="bg-card rounded-xl border border-border overflow-hidden">
                <div className="aspect-video bg-black relative">
                  <video ref={videoRef} src={selectedClip.src}
                    className="w-full h-full object-contain" playsInline muted loop
                    onLoadedData={handleVideoReady} onCanPlay={handleVideoReady} onError={handleVideoError} />
                  <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" style={{ pointerEvents: "none" }} />

                  {!videoReady && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/50">
                      <div className="flex items-center gap-2 text-white">
                        <Loader2 className="w-5 h-5 animate-spin" /> <span className="text-sm">Loading video...</span>
                      </div>
                    </div>
                  )}

                  {isAnalyzing && (
                    <>
                      <div className="absolute top-4 left-4 flex items-center gap-2">
                        <div className="w-3 h-3 bg-red-500 rounded-full animate-pulse" />
                        <span className="text-sm font-medium bg-black/60 px-2 py-1 rounded">Motion Analysis Active</span>
                      </div>
                      {motionMetrics && (
                        <div className="absolute top-4 right-4 bg-black/60 px-3 py-1 rounded text-sm">
                          Energy: {(motionMetrics.totalEnergy * 100).toFixed(1)}%
                        </div>
                      )}
                    </>
                  )}
                </div>

                <div className="p-4 border-t border-border flex items-center gap-3 flex-wrap">
                  {!isAnalyzing ? (
                    <button onClick={startAnalysis} disabled={!videoReady}
                      className="px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors flex items-center gap-2 disabled:opacity-50">
                      {videoReady ? <Play size={16} /> : <Loader2 size={16} className="animate-spin" />}
                      {videoReady ? "Start Analysis" : "Loading..."}
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
                  <label className="flex items-center gap-2 text-sm cursor-pointer select-none ml-auto">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${demoMode ? "bg-yellow-500/20 text-yellow-500" : "bg-green-500/20 text-green-500"}`}>
                      {demoMode ? "DEMO" : "REAL"}
                    </span>
                    <div onClick={() => !isAnalyzing && setDemoMode(!demoMode)}
                      className={`w-10 h-5 rounded-full transition-colors relative ${demoMode ? "bg-yellow-500" : "bg-green-600"}`}>
                      <div className={`w-4 h-4 bg-white rounded-full absolute top-0.5 transition-transform ${demoMode ? "translate-x-5" : "translate-x-0.5"}`} />
                    </div>
                    <span className="text-muted-foreground">{selectedClip.name}</span>
                  </label>
                </div>
              </div>
            </div>

            <div className="space-y-4">
              {/* Detection State */}
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

              {/* Motion Energy */}
              <div className="bg-card p-4 rounded-xl border border-border">
                <h3 className="font-semibold mb-3 flex items-center gap-2"><Zap size={16} /> Motion Energy</h3>
                {motionMetrics ? (
                  <div className="space-y-3">
                    <div>
                      <div className="flex justify-between text-sm mb-1">
                        <span className="text-muted-foreground">Total Energy</span>
                        <span className={motionMetrics.totalEnergy > 0.05 ? "text-red-500 font-bold" : ""}>
                          {(motionMetrics.totalEnergy * 100).toFixed(1)}%
                        </span>
                      </div>
                      <div className="w-full bg-background rounded-full h-2">
                        <div className={`h-2 rounded-full transition-all ${motionMetrics.totalEnergy > 0.05 ? "bg-red-500" : motionMetrics.totalEnergy > 0.02 ? "bg-yellow-500" : "bg-green-500"}`}
                          style={{ width: `${Math.min(motionMetrics.totalEnergy * 500, 100)}%` }} />
                      </div>
                    </div>
                    <div>
                      <div className="flex justify-between text-sm mb-1">
                        <span className="text-muted-foreground">Hotspot Intensity</span>
                        <span className={motionMetrics.maxRegionEnergy > 0.15 ? "text-red-500 font-bold" : ""}>
                          {(motionMetrics.maxRegionEnergy * 100).toFixed(1)}%
                        </span>
                      </div>
                      <div className="w-full bg-background rounded-full h-2">
                        <div className={`h-2 rounded-full transition-all ${motionMetrics.maxRegionEnergy > 0.15 ? "bg-red-500" : "bg-green-500"}`}
                          style={{ width: `${Math.min(motionMetrics.maxRegionEnergy * 300, 100)}%` }} />
                      </div>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Gradient</span>
                      <span className={motionMetrics.motionGradient > 0.5 ? "text-orange-500" : ""}>
                        {motionMetrics.motionGradient > 0 ? "+" : ""}{(motionMetrics.motionGradient * 100).toFixed(0)}%
                      </span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Hotspots</span>
                      <span>{motionMetrics.hotspots.length}</span>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">{isAnalyzing ? "Analyzing motion..." : "Start analysis"}</p>
                )}
              </div>

              {/* Motion History Chart */}
              <div className="bg-card p-4 rounded-xl border border-border">
                <h3 className="font-semibold mb-3">Motion Timeline</h3>
                <div className="h-16 flex items-end gap-px">
                  {motionHistory.length === 0 ? (
                    <p className="text-xs text-muted-foreground w-full text-center">No data yet</p>
                  ) : (
                    motionHistory.map((val, i) => (
                      <div key={i} className="flex-1 rounded-t"
                        style={{
                          height: `${Math.min(val * 800, 100)}%`,
                          backgroundColor: val > 0.05 ? "#ef4444" : val > 0.02 ? "#f59e0b" : "#22c55e",
                          opacity: 0.5 + (i / motionHistory.length) * 0.5,
                        }} />
                    ))
                  )}
                </div>
              </div>

              {/* Incidents */}
              <div className="bg-card p-4 rounded-xl border border-border">
                <h3 className="font-semibold mb-3">Detected Incidents</h3>
                {incidents.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{isAnalyzing ? "Monitoring for accidents..." : "No incidents detected"}</p>
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

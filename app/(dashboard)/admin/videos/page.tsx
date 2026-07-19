"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  ArrowLeft, Video, Play, Pause, AlertTriangle, Clock,
  Navigation, RotateCcw, Loader2, Zap, Eye,
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

const VIDEO_CLIPS: VideoClip[] = [
  { name: "accident_sample.mp4", src: "/videos/accident_sample.mp4", description: "Vehicle collision scenario" },
  { name: "camera2_demo.mp4", src: "/videos/camera2_demo.mp4", description: "Traffic monitoring demo" },
  { name: "camera4_demo.mp4", src: "/videos/camera4_demo.mp4", description: "Intersection monitoring demo" },
  { name: "checking.mp4", src: "/videos/checking.mp4", description: "System verification clip" },
];

const DEMO_LAT = 22.7196;
const DEMO_LNG = 75.8577;

const GRID_COLS = 8;
const GRID_ROWS = 6;

export default function VideoAnalysisPage() {
  const [selectedClip, setSelectedClip] = useState<VideoClip | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [videoReady, setVideoReady] = useState(false);
  const [incidents, setIncidents] = useState<IncidentAlert[]>([]);
  const [currentState, setCurrentState] = useState("monitoring");
  const [regionHeatmap, setRegionHeatmap] = useState<number[]>([]);
  const [motionScore, setMotionScore] = useState(0);
  const [demoMode, setDemoMode] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const analysisCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const stateRef = useRef("monitoring");
  const frameCountRef = useRef(0);
  const stateFrameRef = useRef(0);
  const alertCooldownRef = useRef(0);
  const supabase = createClient();

  // Accumulated region change map — THE KEY INNOVATION
  // Instead of instantaneous motion, we ACCUMULATE changes over time.
  // Passing car: accumulates briefly, then decays → low value
  // Accident: accumulates and STAYS → high value triggers alert
  const accumulatedMapRef = useRef<Float32Array>(new Float32Array(GRID_COLS * GRID_ROWS));
  const prevGrayMapRef = useRef<Float32Array | null>(null);
  const baselineGrayRef = useRef<Float32Array | null>(null);
  const frameNumRef = useRef(0);

  useEffect(() => {
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
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

  // Convert frame to low-res grayscale grid (8x6 regions)
  const frameToGrid = useCallback((frame: ImageData): Float32Array => {
    const w = frame.width;
    const h = frame.height;
    const data = frame.data;
    const grid = new Float32Array(GRID_COLS * GRID_ROWS);
    const cellW = Math.floor(w / GRID_COLS);
    const cellH = Math.floor(h / GRID_ROWS);

    for (let gy = 0; gy < GRID_ROWS; gy++) {
      for (let gx = 0; gx < GRID_COLS; gx++) {
        let sum = 0;
        let count = 0;
        const startX = gx * cellW;
        const startY = gy * cellH;

        for (let dy = 0; dy < cellH; dy += 2) {
          for (let dx = 0; dx < cellW; dx += 2) {
            const px = startX + dx;
            const py = startY + dy;
            if (px < w && py < h) {
              const idx = (py * w + px) * 4;
              sum += data[idx] * 0.299 + data[idx + 1] * 0.587 + data[idx + 2] * 0.114;
              count++;
            }
          }
        }
        grid[gy * GRID_COLS + gx] = count > 0 ? sum / count : 128;
      }
    }
    return grid;
  }, []);

  // ========== CORE DETECTION: Accumulated Region Change ==========
  // This is fundamentally different from motion energy:
  // - Motion energy = instant snapshot → noisy, false alarms
  // - Accumulated change = tracks PERMANENT scene changes over time
  //
  // How it works:
  // 1. Each frame, compute per-region difference from previous frame
  // 2. ADD the difference to an accumulated map (never resets to zero)
  // 3. DECAY the map slowly (multiply by 0.98 each frame)
  // 4. A region with HIGH accumulated change = something PERMANENTLY changed there
  //
  // Why this works:
  // - Car passing: difference appears then disappears → accumulation stays low
  // - Crowd walking: small gradual changes → accumulation stays moderate
  // - Accident: sudden large change that PERSISTS → accumulation spikes

  const analyzeAccumulated = useCallback((currentGrid: Float32Array): {
    regionChanges: number[];
    maxRegion: number;
    totalChange: number;
    spikeRegion: number;
  } => {
    const grid = accumulatedMapRef.current;
    const prev = prevGrayMapRef.current;
    const DECAY = 0.97; // slow decay — changes accumulate over time

    let totalChange = 0;
    let maxRegion = 0;
    let spikeRegion = -1;

    const regionChanges: number[] = [];

    for (let i = 0; i < GRID_COLS * GRID_ROWS; i++) {
      // Frame-to-frame difference
      const frameDiff = prev ? Math.abs(currentGrid[i] - prev[i]) / 255 : 0;

      // Accumulate: add new difference, decay old
      grid[i] = grid[i] * DECAY + frameDiff * 2; // multiply by 2 to boost signal

      // Clamp to prevent overflow
      if (grid[i] > 1) grid[i] = 1;

      regionChanges.push(grid[i]);
      totalChange += grid[i];

      if (grid[i] > maxRegion) {
        maxRegion = grid[i];
        spikeRegion = i;
      }
    }

    prevGrayMapRef.current = new Float32Array(currentGrid);

    return { regionChanges, maxRegion, totalChange, spikeRegion };
  }, []);

  // Detect accident from accumulated changes
  const detectAccident = useCallback((analysis: {
    regionChanges: number[];
    maxRegion: number;
    totalChange: number;
    spikeRegion: number;
  }, frameNum: number): { detected: boolean; confidence: number } => {
    const fn = frameNum;

    // Need baseline frames to settle
    if (fn < 12) return { detected: false, confidence: 0 };

    const avgChange = analysis.totalChange / (GRID_COLS * GRID_ROWS);

    // Update baseline (average of older accumulated values)
    if (!baselineGrayRef.current) {
      baselineGrayRef.current = new Float32Array([avgChange]);
    } else {
      const history = baselineGrayRef.current;
      // Keep last 30 values
      if (history.length > 30) {
        const newArr = new Float32Array(30);
        newArr.set(history.subarray(history.length - 29));
        newArr[29] = avgChange;
        baselineGrayRef.current = newArr;
      } else {
        const newArr = new Float32Array(history.length + 1);
        newArr.set(history);
        newArr[history.length] = avgChange;
        baselineGrayRef.current = newArr;
      }
    }

    const baseline = baselineGrayRef.current;
    const baselineAvg = baseline.length > 5
      ? baseline.slice(0, baseline.length - 5).reduce((a, b) => a + b, 0) / (baseline.length - 5)
      : 0.01;

    // Spike ratio: current accumulated change vs baseline
    const spikeRatio = baselineAvg > 0.001 ? avgChange / baselineAvg : avgChange > 0.02 ? 5 : 0;

    // Hot region: one specific region has much higher accumulation than others
    const otherAvg = (analysis.totalChange - analysis.maxRegion) / Math.max(GRID_COLS * GRID_ROWS - 1, 1);
    const hotRegionRatio = otherAvg > 0.001 ? analysis.maxRegion / otherAvg : 1;

    // Confidence
    const confidence = Math.min(0.95,
      Math.min(spikeRatio / 3, 1) * 0.4 +
      Math.min(hotRegionRatio / 5, 1) * 0.3 +
      (analysis.maxRegion > 0.1 ? 0.2 : 0) +
      (avgChange > 0.02 ? 0.1 : 0)
    );

    // Detection: accumulated change spiked AND there's a hot region
    const detected = (spikeRatio > 2.0 && analysis.maxRegion > 0.05) ||
                     (spikeRatio > 3.0) || // very large spike overrides
                     (hotRegionRatio > 4 && analysis.maxRegion > 0.08); // concentrated change

    return { detected, confidence };
  }, []);

  // Draw heatmap overlay
  const drawHeatmap = (regionChanges: number[]) => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const cellW = canvas.width / GRID_COLS;
    const cellH = canvas.height / GRID_ROWS;

    for (let i = 0; i < regionChanges.length; i++) {
      const gx = i % GRID_COLS;
      const gy = Math.floor(i / GRID_COLS);
      const val = Math.min(regionChanges[i] * 4, 1); // boost visibility

      if (val > 0.05) {
        const r = Math.floor(val * 255);
        const g = Math.floor((1 - val) * 100);
        ctx.fillStyle = `rgba(${r}, ${g}, 0, ${val * 0.5})`;
        ctx.fillRect(gx * cellW, gy * cellH, cellW, cellH);

        if (val > 0.3) {
          ctx.strokeStyle = `rgba(255, 0, 0, ${val * 0.7})`;
          ctx.lineWidth = 2;
          ctx.strokeRect(gx * cellW, gy * cellH, cellW, cellH);
        }
      }
    }

    // Score bar at bottom
    const barH = 20;
    const barY = canvas.height - barH;
    ctx.fillStyle = "rgba(0,0,0,0.7)";
    ctx.fillRect(0, barY, canvas.width, barH);
    const score = regionChanges.reduce((a, b) => a + b, 0) / regionChanges.length;
    const barWidth = Math.min(score * canvas.width * 8, canvas.width);
    ctx.fillStyle = score > 0.05 ? "#ef4444" : score > 0.02 ? "#f59e0b" : "#22c55e";
    ctx.fillRect(0, barY, barWidth, barH);
    ctx.fillStyle = "white";
    ctx.font = "11px Arial";
    ctx.fillText(`Accumulated Change: ${(score * 100).toFixed(1)}%`, 8, barY + 14);
  };

  const createIncident = async (alert: IncidentAlert) => {
    const { data: incident } = await supabase
      .from("incidents")
      .insert({
        severity: alert.severity,
        incident_type: alert.type,
        latitude: alert.latitude,
        longitude: alert.longitude,
        location_name: `Video Analysis: ${selectedClip?.name}`,
        detection_confidence: alert.confidence,
        detection_data: { source: "accumulated_change", clip: selectedClip?.name },
        video_clip_url: selectedClip?.src || null,
        status: "detected",
      })
      .select()
      .single();

    setIncidents((prev) => [...prev, alert]);
    toast.error(`ACCIDENT DETECTED: ${alert.type.replace(/_/g, " ")} (${alert.severity}) — dispatching ambulance!`);

    if (incident) {
      supabase.channel("alerts:ambulance").send({
        type: "broadcast",
        event: "new_incident",
        payload: {
          incident_id: incident.id, severity: alert.severity, incident_type: alert.type,
          latitude: alert.latitude, longitude: alert.longitude, video_clip_url: selectedClip?.src,
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
        toast.error("Could not play video.");
        return;
      }
    }

    // Reset all state
    accumulatedMapRef.current.fill(0);
    prevGrayMapRef.current = null;
    baselineGrayRef.current = null;
    frameNumRef.current = 0;

    setVideoReady(true);
    setIsAnalyzing(true);
    setIncidents([]);
    setCurrentState("monitoring");
    stateRef.current = "monitoring";
    stateFrameRef.current = 0;
    frameCountRef.current = 0;
    alertCooldownRef.current = 0;
    setRegionHeatmap([]);
    setMotionScore(0);

    await new Promise((r) => setTimeout(r, 300));

    // Main analysis loop — wrapped in try/catch to prevent crashes
    const runLoop = () => {
      try {
        if (!videoRef.current || videoRef.current.paused || videoRef.current.ended) return;

        const video = videoRef.current;
        const canvas = getAnalysisCanvas();
        canvas.width = 320;
        canvas.height = 240;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        ctx.drawImage(video, 0, 0, 320, 240);
        const frame = ctx.getImageData(0, 0, 320, 240);

        frameNumRef.current++;
        frameCountRef.current++;
        const fn = frameNumRef.current;

        if (alertCooldownRef.current > 0) alertCooldownRef.current--;

        // Convert to grid and analyze
        const grid = frameToGrid(frame);
        const analysis = analyzeAccumulated(grid);

        setRegionHeatmap(analysis.regionChanges);
        setMotionScore(analysis.totalChange / (GRID_COLS * GRID_ROWS));

        // Draw heatmap
        drawHeatmap(analysis.regionChanges);

        // Detect
        const result = detectAccident(analysis, fn);

        stateFrameRef.current++;
        let state = stateRef.current;

        if (result.detected) {
          if (state === "monitoring") state = "watching";
          else if (state === "watching") state = "confirming";
          else if (state === "confirming") state = "alert";
        } else if (!demoMode && fn % 5 === 0) {
          state = state === "alert" ? "confirming" : state === "confirming" ? "watching" : "monitoring";
        }

        if (demoMode) {
          const sf = stateFrameRef.current;
          if (sf === 15 && state === "monitoring") state = "watching";
          if (sf === 25 && state === "watching") state = "confirming";
          if (sf >= 35 && state === "confirming") state = "alert";
        }

        if (state === "alert" && stateRef.current !== "alert" && alertCooldownRef.current <= 0) {
          alertCooldownRef.current = 40;
          createIncident({
            type: "vehicle_collision",
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
      } catch (err) {
        console.error("Analysis frame error:", err);
      }

      // Schedule next frame — always reschedules unless stopped
      if (isAnalyzing && videoRef.current && !videoRef.current.paused) {
        intervalRef.current = setTimeout(runLoop, 250) as unknown as NodeJS.Timeout;
      }
    };

    runLoop();
  };

  const stopAnalysis = () => {
    if (intervalRef.current) { clearTimeout(intervalRef.current); intervalRef.current = null; }
    if (videoRef.current) { videoRef.current.pause(); videoRef.current.currentTime = 0; }
    setIsAnalyzing(false);
    setCurrentState("monitoring");
    stateRef.current = "monitoring";
  };

  const resetClip = () => {
    stopAnalysis();
    setIncidents([]);
    setRegionHeatmap([]);
    setMotionScore(0);
    accumulatedMapRef.current.fill(0);
    prevGrayMapRef.current = null;
    baselineGrayRef.current = null;
    frameNumRef.current = 0;
    stateFrameRef.current = 0;
    alertCooldownRef.current = 0;
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
        <p className="text-muted-foreground">Accumulated region change detection — detects permanent scene changes</p>
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
                    <div className="absolute top-4 left-4 flex items-center gap-2">
                      <div className="w-3 h-3 bg-red-500 rounded-full animate-pulse" />
                      <span className="text-sm font-medium bg-black/60 px-2 py-1 rounded">Analyzing</span>
                    </div>
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
                <h3 className="font-semibold mb-3 flex items-center gap-2"><Eye size={16} /> Region Analysis</h3>
                {regionHeatmap.length > 0 ? (
                  <div className="space-y-3">
                    <div>
                      <div className="flex justify-between text-sm mb-1">
                        <span className="text-muted-foreground">Accumulated Change</span>
                        <span className={motionScore > 0.05 ? "text-red-500 font-bold" : ""}>
                          {(motionScore * 100).toFixed(1)}%
                        </span>
                      </div>
                      <div className="w-full bg-background rounded-full h-2">
                        <div className={`h-2 rounded-full transition-all ${motionScore > 0.05 ? "bg-red-500" : motionScore > 0.02 ? "bg-yellow-500" : "bg-green-500"}`}
                          style={{ width: `${Math.min(motionScore * 500, 100)}%` }} />
                      </div>
                    </div>
                    {/* Mini heatmap grid */}
                    <div className="grid grid-cols-8 gap-px">
                      {regionHeatmap.map((val, i) => (
                        <div key={i} className="aspect-square rounded-sm"
                          style={{
                            backgroundColor: val > 0.1 ? `rgb(${Math.floor(val * 500)}, 0, 0)` :
                              val > 0.03 ? `rgb(${Math.floor(val * 2000)}, ${Math.floor(val * 500)}, 0)` :
                                `rgb(0, ${Math.floor(val * 2000)}, 0)`,
                          }} />
                      ))}
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">{isAnalyzing ? "Building baseline..." : "Start analysis"}</p>
                )}
              </div>

              <div className="bg-card p-4 rounded-xl border border-border">
                <h3 className="font-semibold mb-3">Detected Incidents</h3>
                {incidents.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{isAnalyzing ? "Monitoring..." : "No incidents"}</p>
                ) : (
                  <div className="space-y-2">
                    {incidents.map((inc, i) => (
                      <div key={i} className={`p-3 rounded-lg border-l-4 ${inc.severity === "critical" ? "border-red-500 bg-red-500/10" : "border-orange-500 bg-orange-500/10"}`}>
                        <div className="flex items-center gap-2">
                          <AlertTriangle size={14} className={inc.severity === "critical" ? "text-red-500" : "text-orange-500"} />
                          <span className="text-sm font-medium capitalize">{inc.type.replace(/_/g, " ")}</span>
                        </div>
                        <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
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

"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { loadModel, detect, toPixelDetections } from "@/lib/detection/onnx-engine";
import { MultiObjectTracker } from "@/lib/detection/kalman-tracker";
import { FrameMemory } from "@/lib/detection/frame-memory";

// ── LocalStorage keys ───────────────────────────────────────────
const STORAGE_KEY = "sage_debug_thresholds";

interface Thresholds {
  iouThreshold: number;
  speedDropPct: number;
  fallConfThreshold: number;
  confirmDurationMs: number;
  cooldownMs: number;
}

const DEFAULTS: Thresholds = {
  iouThreshold: 0.2,
  speedDropPct: 0.4,
  fallConfThreshold: 0.6,
  confirmDurationMs: 500,
  cooldownMs: 5000,
};

function loadThresholds(): Thresholds {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

function saveThresholds(t: Thresholds) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(t));
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

// ── Page component ──────────────────────────────────────────────
export default function DebugPage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const [modelReady, setModelReady] = useState(false);
  const [running, setRunning] = useState(false);
  const [selectedVideo, setSelectedVideo] = useState("/videos/accident_sample.mp4");
  const [thresholds, setThresholds] = useState<Thresholds>(loadThresholds);
  const [log, setLog] = useState<string[]>([]);
  const [stats, setStats] = useState({ fps: 0, detections: 0, entities: 0, state: "idle" });

  const trackerRef = useRef<MultiObjectTracker>(new MultiObjectTracker());
  const memoryRef = useRef<FrameMemory>(new FrameMemory());
  const frameCountRef = useRef(0);
  const rafRef = useRef(0);
  const lastTimeRef = useRef(0);
  const fpsFramesRef = useRef(0);

  // ── Load model on mount ──
  useEffect(() => {
    loadModel("/models/best.onnx")
      .then(() => setModelReady(true))
      .catch((e) => addLog(`Model load error: ${e.message}`));
  }, []);

  // ── Add log entry ──
  const addLog = useCallback((msg: string) => {
    const ts = new Date().toLocaleTimeString();
    setLog((prev) => [`[${ts}] ${msg}`, ...prev.slice(0, 199)]);
  }, []);

  // ── Save thresholds to localStorage ──
  const updateThreshold = useCallback(
    (key: keyof Thresholds, value: number) => {
      setThresholds((prev) => {
        const next = { ...prev, [key]: value };
        saveThresholds(next);
        return next;
      });
    },
    []
  );

  // ── Detection loop ──
  const runDetection = useCallback(async () => {
    const video = videoRef.current;
    const overlay = overlayRef.current;
    if (!video || !overlay || !modelReady) return;

    const ctx = overlay.getContext("2d");
    if (!ctx) return;

    // Create offscreen canvas for frame extraction
    const offCanvas = document.createElement("canvas");
    const offCtx = offCanvas.getContext("2d", { willReadFrequently: true })!;

    const loop = async () => {
      if (!running || video.paused || video.ended) {
        setStats((s) => ({ ...s, state: "stopped" }));
        return;
      }

      const now = performance.now();
      frameCountRef.current++;
      fpsFramesRef.current++;

      if (now - lastTimeRef.current >= 1000) {
        setStats((s) => ({ ...s, fps: fpsFramesRef.current }));
        fpsFramesRef.current = 0;
        lastTimeRef.current = now;
      }

      // Extract frame
      offCanvas.width = video.videoWidth || 640;
      offCanvas.height = video.videoHeight || 480;
      offCtx.drawImage(video, 0, 0, offCanvas.width, offCanvas.height);
      const imageData = offCtx.getImageData(0, 0, offCanvas.width, offCanvas.height);

      // Run ONNX inference
      let dets: any[] = [];
      try {
        dets = await detect(imageData);
      } catch {
        // Model not ready
      }

      const pixelDets = toPixelDetections(dets, offCanvas.width, offCanvas.height);

      // Run Kalman tracker
      const entities = trackerRef.current.update(pixelDets, frameCountRef.current);
      const valid = entities.filter((e) => e.age >= 1);

      // Store in frame memory
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

      // Simple collision check (same rules as worker)
      let collisionFound = false;
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

          if (iouVal >= thresholds.iouThreshold) {
            collisionFound = true;
            addLog(
              `COLLISION: #${a.id}(${a.class}) ↔ #${b.id}(${b.class}) IoU=${iouVal.toFixed(3)}`
            );
          }
        }
      }

      // Check fallen_person detections
      const fallen = valid.filter((e) => e.class === "fallen_person" && e.confidence >= thresholds.fallConfThreshold);
      if (fallen.length > 0) {
        addLog(`FALLEN_PERSON: id=${fallen[0].id} conf=${fallen[0].confidence.toFixed(3)}`);
      }

      // Update overlay
      ctx.clearRect(0, 0, overlay.width, overlay.height);
      ctx.strokeStyle = collisionFound ? "#ef4444" : "#22c55e";
      ctx.lineWidth = 2;
      ctx.font = "12px monospace";

      for (const e of valid) {
        const k = e.kalman.getState();
        const x = k.x - e.w / 2;
        const y = k.y - e.h / 2;

        // Draw bbox
        ctx.strokeRect(x, y, e.w, e.h);

        // Draw label
        const label = `#${e.id} ${e.class} ${e.speed.toFixed(1)}px/f`;
        ctx.fillStyle = collisionFound ? "#ef4444" : "#22c55e";
        ctx.fillText(label, x, y - 4);

        // Draw speed indicator
        if (e.speedHistory.length >= 3) {
          const avgSpeed = e.speedHistory.slice(0, 3).reduce((s, v) => s + v, 0) / 3;
          ctx.fillStyle = avgSpeed > 2 ? "#f59e0b" : "#6b7280";
          ctx.fillText(`spd:${avgSpeed.toFixed(2)}`, x, y + e.h + 12);
        }
      }

      // Draw IoU pairs for debugging
      for (let i = 0; i < allPairs.length; i++) {
        for (let j = i + 1; j < allPairs.length; j++) {
          const a = allPairs[i];
          const b = allPairs[j];
          if (a.class === "person" && b.class === "person") continue;

          const iouVal = iou(
            a.kalman.getState().x, a.kalman.getState().y, a.w, a.h,
            b.kalman.getState().x, b.kalman.getState().y, b.w, b.h
          );

          if (iouVal > 0.01) {
            const ka = a.kalman.getState();
            const kb = b.kalman.getState();
            ctx.beginPath();
            ctx.moveTo(ka.x, ka.y);
            ctx.lineTo(kb.x, kb.y);
            ctx.strokeStyle = iouVal >= thresholds.iouThreshold ? "#ef4444" : "#4b5563";
            ctx.lineWidth = 1;
            ctx.stroke();

            const midX = (ka.x + kb.x) / 2;
            const midY = (ka.y + kb.y) / 2;
            ctx.fillStyle = "#fbbf24";
            ctx.fillText(`IoU:${iouVal.toFixed(3)}`, midX, midY);
          }
        }
      }

      setStats({
        fps: fpsFramesRef.current,
        detections: dets.length,
        entities: valid.length,
        state: collisionFound ? "COLLISION" : "monitoring",
      });

      rafRef.current = requestAnimationFrame(loop);
    };

    lastTimeRef.current = performance.now();
    fpsFramesRef.current = 0;
    rafRef.current = requestAnimationFrame(loop);
  }, [running, modelReady, thresholds, addLog]);

  // ── Start/stop ──
  const toggleRunning = useCallback(() => {
    if (running) {
      cancelAnimationFrame(rafRef.current);
      setRunning(false);
      addLog("Stopped detection");
    } else {
      setRunning(true);
      addLog(`Starting detection on ${selectedVideo}`);
    }
  }, [running, selectedVideo, addLog]);

  // ── Reset tracker ──
  const resetTracker = useCallback(() => {
    trackerRef.current.reset();
    memoryRef.current.clear();
    frameCountRef.current = 0;
    addLog("Tracker reset");
  }, [addLog]);

  // ── Trigger detection loop when running state changes ──
  useEffect(() => {
    if (running) runDetection();
    return () => cancelAnimationFrame(rafRef.current);
  }, [running, runDetection]);

  // ── Video list ──
  const videos = [
    { label: "Accident Sample", path: "/videos/accident_sample.mp4" },
    { label: "Camera 2 Demo", path: "/videos/camera2_demo.mp4" },
    { label: "Camera 4 Demo", path: "/videos/camera4_demo.mp4" },
    { label: "Checking", path: "/videos/checking.mp4" },
  ];

  return (
    <div className="min-h-screen bg-background p-6">
      <h1 className="text-2xl font-bold mb-6">Debug — Detection Calibration</h1>

      {/* Video + Overlay */}
      <div className="mb-6 flex gap-4 flex-wrap">
        <div className="relative">
          <video
            ref={videoRef}
            src={selectedVideo}
            className="rounded-lg bg-black"
            width={640}
            height={480}
            controls
            loop
            crossOrigin="anonymous"
          />
          <canvas
            ref={overlayRef}
            width={640}
            height={480}
            className="absolute top-0 left-0 rounded-lg pointer-events-none"
          />
        </div>

        {/* Controls */}
        <div className="flex flex-col gap-3 min-w-[240px]">
          {/* Video selector */}
          <div>
            <label className="text-sm text-muted-foreground block mb-1">Video</label>
            <select
              value={selectedVideo}
              onChange={(e) => {
                setSelectedVideo(e.target.value);
                resetTracker();
              }}
              className="w-full bg-card border border-border rounded px-3 py-2 text-sm"
            >
              {videos.map((v) => (
                <option key={v.path} value={v.path}>
                  {v.label}
                </option>
              ))}
            </select>
          </div>

          {/* Status */}
          <div className="bg-card border border-border rounded p-3 text-sm space-y-1">
            <div>Model: {modelReady ? "✅ Loaded" : "⏳ Loading..."}</div>
            <div>FPS: {stats.fps}</div>
            <div>Detections: {stats.detections}</div>
            <div>Tracked: {stats.entities}</div>
            <div>
              State:{" "}
              <span className={stats.state === "COLLISION" ? "text-red-400 font-bold" : "text-green-400"}>
                {stats.state}
              </span>
            </div>
          </div>

          {/* Buttons */}
          <div className="flex gap-2">
            <button
              onClick={toggleRunning}
              disabled={!modelReady}
              className={`flex-1 px-4 py-2 rounded font-semibold text-sm ${
                running
                  ? "bg-red-600 hover:bg-red-700 text-white"
                  : "bg-primary hover:bg-primary/90 text-white"
              } disabled:opacity-50`}
            >
              {running ? "Stop" : "Start"}
            </button>
            <button
              onClick={resetTracker}
              className="px-4 py-2 rounded text-sm bg-card border border-border hover:bg-background"
            >
              Reset
            </button>
          </div>

          {/* Threshold sliders */}
          <div className="bg-card border border-border rounded p-3 space-y-3">
            <h3 className="text-sm font-semibold">Thresholds</h3>

            <div>
              <label className="text-xs text-muted-foreground">
                IoU Threshold: {thresholds.iouThreshold.toFixed(2)}
              </label>
              <input
                type="range"
                min={0.05}
                max={0.5}
                step={0.01}
                value={thresholds.iouThreshold}
                onChange={(e) => updateThreshold("iouThreshold", parseFloat(e.target.value))}
                className="w-full"
              />
            </div>

            <div>
              <label className="text-xs text-muted-foreground">
                Speed Drop %: {(thresholds.speedDropPct * 100).toFixed(0)}%
              </label>
              <input
                type="range"
                min={0.1}
                max={0.8}
                step={0.05}
                value={thresholds.speedDropPct}
                onChange={(e) => updateThreshold("speedDropPct", parseFloat(e.target.value))}
                className="w-full"
              />
            </div>

            <div>
              <label className="text-xs text-muted-foreground">
                Fall Confidence: {thresholds.fallConfThreshold.toFixed(2)}
              </label>
              <input
                type="range"
                min={0.3}
                max={0.95}
                step={0.05}
                value={thresholds.fallConfThreshold}
                onChange={(e) => updateThreshold("fallConfThreshold", parseFloat(e.target.value))}
                className="w-full"
              />
            </div>

            <div>
              <label className="text-xs text-muted-foreground">
                Confirm Duration: {thresholds.confirmDurationMs}ms
              </label>
              <input
                type="range"
                min={200}
                max={3000}
                step={100}
                value={thresholds.confirmDurationMs}
                onChange={(e) => updateThreshold("confirmDurationMs", parseInt(e.target.value))}
                className="w-full"
              />
            </div>

            <div>
              <label className="text-xs text-muted-foreground">
                Cooldown: {thresholds.cooldownMs}ms
              </label>
              <input
                type="range"
                min={1000}
                max={15000}
                step={500}
                value={thresholds.cooldownMs}
                onChange={(e) => updateThreshold("cooldownMs", parseInt(e.target.value))}
                className="w-full"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Event Log */}
      <div className="bg-card border border-border rounded-lg">
        <div className="px-4 py-2 border-b border-border flex items-center justify-between">
          <h3 className="text-sm font-semibold">Event Log</h3>
          <button
            onClick={() => setLog([])}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Clear
          </button>
        </div>
        <div
          ref={logRef}
          className="p-3 h-[300px] overflow-y-auto font-mono text-xs space-y-0.5"
        >
          {log.length === 0 && (
            <div className="text-muted-foreground">No events yet. Click Start to begin.</div>
          )}
          {log.map((entry, i) => (
            <div
              key={i}
              className={
                entry.includes("COLLISION")
                  ? "text-red-400"
                  : entry.includes("FALLEN")
                  ? "text-yellow-400"
                  : "text-muted-foreground"
              }
            >
              {entry}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

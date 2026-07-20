"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import {
  ArrowLeft,
  Play,
  Pause,
  AlertTriangle,
  Loader2,
  Activity,
  Settings,
  RotateCcw,
} from "lucide-react";
import Link from "next/link";
import { useDetectionWorker, type UseDetectionWorkerReturn } from "@/hooks/useDetectionWorker";
import DetectionOverlay from "@/components/DetectionOverlay";

const STORAGE_KEY = "sage_debug_thresholds";

const DEFAULTS = {
  iouThreshold: 0.2,
  speedDropPct: 0.4,
  fallConfThreshold: 0.6,
  confirmDurationMs: 500,
  cooldownMs: 5000,
};

interface VideoClip {
  name: string;
  src: string;
  description: string;
}

const VIDEO_CLIPS: VideoClip[] = [
  { name: "accident_sample.mp4", src: "/videos/accident_sample.mp4", description: "Vehicle collision" },
  { name: "camera2_demo.mp4", src: "/videos/camera2_demo.mp4", description: "Traffic monitoring" },
  { name: "camera4_demo.mp4", src: "/videos/camera4_demo.mp4", description: "Intersection monitoring" },
  { name: "checking.mp4", src: "/videos/checking.mp4", description: "System check" },
];

export default function DebugPage() {
  const [values, setValues] = useState(DEFAULTS);
  const [selectedClip, setSelectedClip] = useState<VideoClip | null>(null);
  const [videoReady, setVideoReady] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const detection: UseDetectionWorkerReturn = useDetectionWorker("isolated");
  const { isReady, isAnalyzing, state, entities, evidence, fps, incidents } = detection;

  // Load saved thresholds
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) setValues({ ...DEFAULTS, ...JSON.parse(raw) });
    } catch {}
  }, []);

  // Sync thresholds to worker
  useEffect(() => {
    detection.setMode?.("isolated" as any);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const update = (key: keyof typeof values, val: number) => {
    setValues((prev) => {
      const next = { ...prev, [key]: val };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  };

  const resetDefaults = () => {
    setValues(DEFAULTS);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(DEFAULTS));
  };

  const startAnalysis = useCallback(() => {
    if (!videoRef.current || !selectedClip) return;
    const video = videoRef.current;
    video
      .play()
      .then(() => detection.startAnalysis(video))
      .catch(() => {
        video.muted = true;
        video
          .play()
          .then(() => detection.startAnalysis(video))
          .catch(() => {});
      });
  }, [detection, selectedClip]);

  const stopAnalysis = useCallback(() => {
    detection.stopAnalysis();
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.currentTime = 0;
    }
  }, [detection]);

  return (
    <div className="min-h-screen bg-background p-6">
      <Link
        href="/admin"
        className="inline-flex items-center gap-2 text-muted-foreground hover:text-foreground mb-4"
      >
        <ArrowLeft size={16} /> Back
      </Link>
      <h1 className="text-2xl font-bold mb-2">Debug — Detection Calibration</h1>
      <p className="text-sm text-muted-foreground mb-6">
        Load a video, tune thresholds, and observe detection/tracking/alerting in real time.
      </p>

      {!selectedClip ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
          {VIDEO_CLIPS.map((clip) => (
            <button
              key={clip.name}
              onClick={() => { setSelectedClip(clip); setVideoReady(false); }}
              className="bg-card p-5 rounded-xl border border-border hover:border-primary/50 transition-colors text-left"
            >
              <div className="flex items-start gap-4">
                <div className="w-16 h-16 bg-background rounded-lg flex items-center justify-center shrink-0">
                  <AlertTriangle className="w-8 h-8 text-primary" />
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
        <div className="space-y-4 mb-6">
          <button
            onClick={() => { stopAnalysis(); setSelectedClip(null); setVideoReady(false); }}
            className="text-sm text-primary hover:underline"
          >
            &larr; Choose different clip
          </button>

          {/* Video + Overlay */}
          <div className="bg-card rounded-xl border border-border overflow-hidden">
            <div className="relative bg-black">
              <video
                ref={videoRef}
                src={selectedClip.src}
                className="w-full h-auto object-contain block"
                playsInline
                muted
                loop
                preload="auto"
                onLoadedData={() => setVideoReady(true)}
                onCanPlay={() => setVideoReady(true)}
              />
              <DetectionOverlay
                videoRef={videoRef}
                entities={entities}
                evidence={evidence}
                isAnalyzing={isAnalyzing}
                fps={fps}
              />
              {!videoReady && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/50">
                  <div className="flex items-center gap-2 text-white">
                    <Loader2 className="w-5 h-5 animate-spin" /> Loading...
                  </div>
                </div>
              )}
              {isAnalyzing && (
                <div className="absolute top-4 left-4 flex items-center gap-2">
                  <div className="w-3 h-3 bg-red-500 rounded-full animate-pulse" />
                  <span className="text-sm font-medium bg-black/60 px-2 py-1 rounded">
                    Tracking {entities.length} objects | {fps} FPS
                  </span>
                </div>
              )}
            </div>
            <div className="p-4 border-t border-border flex items-center gap-3">
              {!isAnalyzing ? (
                <button
                  onClick={startAnalysis}
                  disabled={!videoReady || !isReady}
                  className="px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors flex items-center gap-2 disabled:opacity-50"
                >
                  {!isReady ? (
                    <>
                      <Loader2 size={16} className="animate-spin" /> Loading AI...
                    </>
                  ) : (
                    <>
                      <Play size={16} /> Start Analysis
                    </>
                  )}
                </button>
              ) : (
                <button
                  onClick={stopAnalysis}
                  className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors flex items-center gap-2"
                >
                  <Pause size={16} /> Stop
                </button>
              )}
              <span className="text-muted-foreground text-xs">{selectedClip.name}</span>
            </div>
          </div>
        </div>
      )}

      {/* Debug Panels */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: Threshold Sliders */}
        <div className="space-y-4">
          <div className="bg-card p-4 rounded-xl border border-border">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold flex items-center gap-2">
                <Settings size={16} /> Thresholds
              </h3>
              <button
                onClick={resetDefaults}
                className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
              >
                <RotateCcw size={12} /> Reset
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="text-sm text-muted-foreground">
                  IoU Threshold: {values.iouThreshold.toFixed(2)}
                </label>
                <input
                  type="range"
                  min={0.05}
                  max={0.5}
                  step={0.01}
                  value={values.iouThreshold}
                  onChange={(e) => update("iouThreshold", parseFloat(e.target.value))}
                  className="w-full"
                />
                <p className="text-xs text-muted-foreground">
                  Min overlap to consider collision candidate.
                </p>
              </div>

              <div>
                <label className="text-sm text-muted-foreground">
                  Speed Drop %: {(values.speedDropPct * 100).toFixed(0)}%
                </label>
                <input
                  type="range"
                  min={0.1}
                  max={0.8}
                  step={0.05}
                  value={values.speedDropPct}
                  onChange={(e) => update("speedDropPct", parseFloat(e.target.value))}
                  className="w-full"
                />
                <p className="text-xs text-muted-foreground">
                  Min speed reduction to flag deceleration.
                </p>
              </div>

              <div>
                <label className="text-sm text-muted-foreground">
                  Fall Confidence: {values.fallConfThreshold.toFixed(2)}
                </label>
                <input
                  type="range"
                  min={0.3}
                  max={0.95}
                  step={0.05}
                  value={values.fallConfThreshold}
                  onChange={(e) => update("fallConfThreshold", parseFloat(e.target.value))}
                  className="w-full"
                />
                <p className="text-xs text-muted-foreground">
                  Min confidence for fallen_person detection.
                </p>
              </div>

              <div>
                <label className="text-sm text-muted-foreground">
                  Confirm Duration: {values.confirmDurationMs}ms
                </label>
                <input
                  type="range"
                  min={200}
                  max={3000}
                  step={100}
                  value={values.confirmDurationMs}
                  onChange={(e) => update("confirmDurationMs", parseInt(e.target.value))}
                  className="w-full"
                />
                <p className="text-xs text-muted-foreground">
                  How long event must persist before alert.
                </p>
              </div>

              <div>
                <label className="text-sm text-muted-foreground">
                  Cooldown: {values.cooldownMs}ms
                </label>
                <input
                  type="range"
                  min={1000}
                  max={15000}
                  step={500}
                  value={values.cooldownMs}
                  onChange={(e) => update("cooldownMs", parseInt(e.target.value))}
                  className="w-full"
                />
                <p className="text-xs text-muted-foreground">
                  Time to ignore new events after alert.
                </p>
              </div>
            </div>

            <div className="mt-4 p-3 bg-background rounded-lg">
              <pre className="text-xs text-muted-foreground overflow-x-auto">
                {JSON.stringify(values, null, 2)}
              </pre>
            </div>
          </div>
        </div>

        {/* Center: State Machine + Collision Candidates */}
        <div className="space-y-4">
          <div className="bg-card p-4 rounded-xl border border-border">
            <h3 className="font-semibold mb-3 flex items-center gap-2">
              <Activity size={16} /> State Machine
            </h3>
            <div className="space-y-2">
              {["monitoring", "watching", "confirming", "alert"].map((s) => (
                <div
                  key={s}
                  className={`flex items-center gap-2 p-2 rounded ${
                    state === s
                      ? s === "alert"
                        ? "bg-red-500/20 text-red-500 animate-pulse"
                        : "bg-green-500/20 text-green-500"
                      : "text-muted-foreground"
                  }`}
                >
                  <div
                    className={`w-2 h-2 rounded-full ${
                      state === s ? "bg-current animate-pulse" : "bg-border"
                    }`}
                  />
                  <span className="text-sm capitalize">{s}</span>
                </div>
              ))}
            </div>
            <div className="mt-3 text-xs text-muted-foreground">
              Ready: {isReady ? "Yes" : "No"} | Analyzing: {isAnalyzing ? "Yes" : "No"} | FPS: {fps}
            </div>
          </div>

          <div className="bg-card p-4 rounded-xl border border-border">
            <h3 className="font-semibold mb-3 flex items-center gap-2">
              <AlertTriangle size={16} /> Collision Candidates
            </h3>
            <div className="max-h-48 overflow-y-auto space-y-2">
              {evidence.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {isAnalyzing ? "No candidates detected" : "Start analysis"}
                </p>
              ) : (
                evidence.map((ev, i) => (
                  <div
                    key={i}
                    className={`p-3 rounded-lg border-l-4 ${
                      ev.confidence > 0.7
                        ? "border-red-500 bg-red-500/10"
                        : "border-orange-500 bg-orange-500/10"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <AlertTriangle size={14} className="text-red-500" />
                      <span className="text-sm font-medium capitalize">
                        {ev.type.replace(/_/g, " ")}
                      </span>
                    </div>
                    <div className="flex gap-3 mt-1 text-xs text-muted-foreground">
                      <span>{(ev.confidence * 100).toFixed(0)}%</span>
                      <span>Objects: {ev.objects.join(", ")}</span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">{ev.details}</p>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="bg-card p-4 rounded-xl border border-border">
            <h3 className="font-semibold mb-3">Incidents ({incidents.length})</h3>
            <div className="max-h-32 overflow-y-auto space-y-2">
              {incidents.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {isAnalyzing ? "Monitoring..." : "None"}
                </p>
              ) : (
                incidents.map((inc, i) => (
                  <div
                    key={i}
                    className={`p-2 rounded text-xs ${
                      inc.severity === "critical"
                        ? "bg-red-500/10 text-red-400"
                        : "bg-orange-500/10 text-orange-400"
                    }`}
                  >
                    {inc.type.replace(/_/g, " ")} ({(inc.confidence * 100).toFixed(0)}%)
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {/* Right: Tracked Objects */}
        <div className="space-y-4">
          <div className="bg-card p-4 rounded-xl border border-border">
            <h3 className="font-semibold mb-3 flex items-center gap-2">
              <Activity size={16} /> Tracked Objects
            </h3>
            <div className="max-h-[500px] overflow-y-auto space-y-2">
              {entities.filter((e) => e.age >= 1).length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {isAnalyzing ? "Scanning..." : "Start analysis"}
                </p>
              ) : (
                entities
                  .filter((e) => e.age >= 1)
                  .map((b) => {
                    const accelLabel =
                      b.acceleration < -0.3
                        ? "BRAKE"
                        : b.acceleration > 0.3
                        ? "ACC"
                        : "CRUISE";
                    const accelColor =
                      b.acceleration < -0.3
                        ? "text-red-400"
                        : b.acceleration > 0.3
                        ? "text-green-400"
                        : "text-gray-400";
                    const clsColor =
                      b.class === "car"
                        ? "text-green-400"
                        : b.class === "motorcycle"
                        ? "text-yellow-400"
                        : "text-blue-400";

                    return (
                      <div key={b.id} className="p-2 bg-background rounded text-xs">
                        <div className="flex items-center justify-between">
                          <span className={`font-medium ${clsColor}`}>
                            {b.class} #{b.id}
                          </span>
                          <span className={accelColor}>{accelLabel}</span>
                        </div>
                        <div className="flex gap-2 text-muted-foreground flex-wrap mt-1">
                          <span>{Math.round(b.speed * 100)}px/f</span>
                          <span>a:{b.acceleration.toFixed(2)}</span>
                          <span>&theta;:{Math.round((b.heading * 180) / Math.PI)}&deg;</span>
                          <span>age:{b.age}</span>
                        </div>
                      </div>
                    );
                  })
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

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
  MapPin,
} from "lucide-react";
import Link from "next/link";
import { useDetectionWorker, type UseDetectionWorkerReturn } from "@/hooks/useDetectionWorker";
import DetectionOverlay from "@/components/DetectionOverlay";
import type { EnvMode } from "@/lib/worker/message-types";

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

const MODE_INFO: Record<EnvMode, { label: string; color: string; description: string }> = {
  isolated: { label: "Isolated", color: "#22c55e", description: "Low traffic, easy detection. Threshold: 40%, 3-frame confirm." },
  traffic: { label: "Traffic", color: "#f59e0b", description: "Busy road, conservative filtering. Threshold: 65%, 5-frame confirm. Both vehicles must decelerate." },
  marketplace: { label: "Marketplace", color: "#8b5cf6", description: "Pedestrian-heavy area. Threshold: 55%, 5-frame confirm. Vehicle alerts suppressed." },
};

export default function DebugPage() {
  const [selectedClip, setSelectedClip] = useState<VideoClip | null>(null);
  const [videoReady, setVideoReady] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const detection: UseDetectionWorkerReturn = useDetectionWorker("isolated");
  const { isReady, isAnalyzing, state, entities, evidence, fps, incidents, mode, setMode } = detection;

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
        Load a video, select mode, tune detection, and observe in real time.
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

          {/* Mode Selector */}
          <div className="bg-card p-4 rounded-xl border border-border">
            <h3 className="font-semibold mb-3 flex items-center gap-2">
              <MapPin size={16} /> Detection Mode
            </h3>
            <div className="grid grid-cols-3 gap-3">
              {(Object.keys(MODE_INFO) as EnvMode[]).map((m) => {
                const info = MODE_INFO[m];
                const isActive = mode === m;
                return (
                  <button
                    key={m}
                    onClick={() => setMode(m)}
                    className={`p-3 rounded-lg border-2 transition-all text-left ${
                      isActive
                        ? "border-current bg-current/10"
                        : "border-border hover:border-muted-foreground/50"
                    }`}
                    style={{ color: isActive ? info.color : undefined }}
                  >
                    <div className="font-semibold text-sm">{info.label}</div>
                    <div className="text-xs text-muted-foreground mt-1">{info.description}</div>
                  </button>
                );
              })}
            </div>
          </div>

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
                    {MODE_INFO[mode].label} Mode | {entities.length} objects | {fps} FPS
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
                  className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 flex items-center gap-2"
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
        {/* Left: State Machine + Mode */}
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
              Ready: {isReady ? "Yes" : "No"} | Analyzing: {isAnalyzing ? "Yes" : "No"} | FPS: {fps} | Backend: {detection.backend}
            </div>
          </div>

          {/* Collision Candidates with Signal Breakdown */}
          <div className="bg-card p-4 rounded-xl border border-border">
            <h3 className="font-semibold mb-3 flex items-center gap-2">
              <AlertTriangle size={16} /> Collision Evidence
            </h3>
            <div className="max-h-64 overflow-y-auto space-y-3">
              {evidence.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {isAnalyzing ? "No alerts detected" : "Start analysis"}
                </p>
              ) : (
                evidence.map((ev, i) => (
                  <div
                    key={i}
                    className={`p-3 rounded-lg border-l-4 ${
                      ev.confidence > 0.7
                        ? "border-red-500 bg-red-500/10"
                        : ev.confidence > 0.5
                        ? "border-orange-500 bg-orange-500/10"
                        : "border-yellow-500 bg-yellow-500/10"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <AlertTriangle size={14} className="text-red-500" />
                      <span className="text-sm font-medium capitalize">
                        {ev.type.replace(/_/g, " ")}
                      </span>
                      <span className="text-xs px-2 py-0.5 rounded-full bg-muted">
                        {ev.sceneContext}
                      </span>
                    </div>
                    <div className="flex gap-3 mt-1 text-xs text-muted-foreground">
                      <span className="font-bold">{(ev.confidence * 100).toFixed(0)}%</span>
                      <span>Objects: {ev.objects.join(", ")}</span>
                    </div>
                    {/* Signal Breakdown */}
                    <div className="mt-2 grid grid-cols-5 gap-1">
                      {ev.signals.map((sig, j) => (
                        <div
                          key={j}
                          className={`text-center text-[10px] p-1 rounded ${
                            sig.passed
                              ? "bg-green-500/20 text-green-400"
                              : "bg-muted text-muted-foreground"
                          }`}
                        >
                          <div className="font-medium">{sig.name}</div>
                          <div>{(sig.value * 100).toFixed(0)}%</div>
                        </div>
                      ))}
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">{ev.details}</p>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {/* Center: Incidents */}
        <div className="space-y-4">
          <div className="bg-card p-4 rounded-xl border border-border">
            <h3 className="font-semibold mb-3">Incidents ({incidents.length})</h3>
            <div className="max-h-48 overflow-y-auto space-y-2">
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
                        : inc.severity === "major"
                        ? "bg-orange-500/10 text-orange-400"
                        : "bg-yellow-500/10 text-yellow-400"
                    }`}
                  >
                    <div className="flex justify-between">
                      <span className="font-medium">{inc.type.replace(/_/g, " ")}</span>
                      <span>{(inc.confidence * 100).toFixed(0)}%</span>
                    </div>
                    {/* Mini signal summary */}
                    <div className="flex gap-1 mt-1">
                      {inc.signals.map((sig, j) => (
                        <span
                          key={j}
                          className={`px-1 rounded ${
                            sig.passed ? "bg-green-500/30 text-green-300" : "bg-muted text-muted-foreground"
                          }`}
                        >
                          {sig.name.slice(0, 4)}
                        </span>
                      ))}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="bg-card p-4 rounded-xl border border-border">
            <h3 className="font-semibold mb-3 flex items-center gap-2">
              <Settings size={16} /> Mode Thresholds
            </h3>
            <div className="space-y-2 text-xs">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Current Mode</span>
                <span className="font-medium" style={{ color: MODE_INFO[mode].color }}>{MODE_INFO[mode].label}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Min Score</span>
                <span>{mode === "isolated" ? "0.40" : mode === "traffic" ? "0.65" : "0.55"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Confirm Frames</span>
                <span>{mode === "isolated" ? "3" : "5"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Both Decel Required</span>
                <span>{mode === "traffic" ? "Yes" : "No"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Passing Filter</span>
                <span>{mode === "traffic" ? "Strict" : "Basic"}</span>
              </div>
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

                    const isInvolved = evidence.some(e => e.objects.includes(b.id));

                    return (
                      <div key={b.id} className={`p-2 bg-background rounded text-xs ${isInvolved ? "border border-red-500/50" : ""}`}>
                        <div className="flex items-center justify-between">
                          <span className={`font-medium ${isInvolved ? "text-red-400" : clsColor}`}>
                            {b.class} #{b.id}
                          </span>
                          <span className={accelColor}>{accelLabel}</span>
                        </div>
                        <div className="flex gap-2 text-muted-foreground flex-wrap mt-1">
                          <span>{Math.round(b.speed * 100)}px/f</span>
                          <span>a:{b.acceleration.toFixed(2)}</span>
                          <span>&theta;:{Math.round((b.heading * 180) / Math.PI)}&deg;</span>
                          <span>age:{b.age}</span>
                          <span>cf:{b.confirmedFrames}</span>
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

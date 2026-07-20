"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { useParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import {
  ArrowLeft,
  Camera,
  AlertTriangle,
  Play,
  Pause,
  Loader2,
} from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { useDetectionWorker } from "@/hooks/useDetectionWorker";
import DetectionOverlay from "@/components/DetectionOverlay";
import type { EnvMode } from "@/lib/worker/message-types";

interface Camera {
  id: string;
  name: string;
  location_name: string;
  latitude: number;
  longitude: number;
  stream_url: string;
  stream_type: string;
  is_active: boolean;
  calibration_data?: any;
}

export default function CameraFeedPage() {
  const params = useParams();
  const [camera, setCamera] = useState<Camera | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const objectUrlRef = useRef<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [envMode, setEnvMode] = useState<EnvMode>("isolated");
  const supabase = createClient();

  const detection = useDetectionWorker(envMode);
  const { isReady, isAnalyzing, entities, evidence, fps, incidents, startAnalysis, stopAnalysis, setMode } = detection;

  useEffect(() => {
    const fetchCamera = async () => {
      const { data } = await supabase
        .from("cameras")
        .select("*")
        .eq("id", params.id)
        .single();
      if (data) setCamera(data);
    };
    fetchCamera();

    return () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
  }, [params.id]);

  const handleStart = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;

    video
      .play()
      .then(() => startAnalysis(video))
      .catch(() => {
        video.muted = true;
        video.play().then(() => startAnalysis(video)).catch(() => {});
      });
  }, [startAnalysis]);

  const handleStop = useCallback(() => {
    stopAnalysis();
    if (videoRef.current) {
      videoRef.current.pause();
    }
  }, [stopAnalysis]);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      setSelectedFile(file);
      const url = URL.createObjectURL(file);
      objectUrlRef.current = url;
      if (videoRef.current) {
        videoRef.current.src = url;
        videoRef.current.play();
      }
    }
  };

  const handleModeChange = (mode: EnvMode) => {
    setEnvMode(mode);
    setMode(mode);
  };

  if (!camera) {
    return (
      <div className="text-center py-12 text-muted-foreground">Loading camera...</div>
    );
  }

  return (
    <div className="space-y-6">
      <Link
        href="/cameras"
        className="inline-flex items-center gap-2 text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft size={16} />
        Back to Cameras
      </Link>

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{camera.name}</h1>
          <p className="text-muted-foreground">{camera.location_name || "AI-Powered Camera Feed"}</p>
        </div>
        <div className="flex gap-2 items-center">
          {/* Mode Selector */}
          <select
            value={envMode}
            onChange={(e) => handleModeChange(e.target.value as EnvMode)}
            className="px-3 py-2 bg-background border border-border rounded-lg text-sm"
          >
            <option value="isolated">Isolated</option>
            <option value="traffic">Traffic</option>
            <option value="marketplace">Marketplace</option>
          </select>

          {!isAnalyzing ? (
            <button
              onClick={handleStart}
              disabled={!isReady}
              className="px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors flex items-center gap-2 disabled:opacity-50"
            >
              {!isReady ? (
                <><Loader2 size={16} className="animate-spin" /> Loading AI...</>
              ) : (
                <><Play size={16} /> Start AI Analysis</>
              )}
            </button>
          ) : (
            <button
              onClick={handleStop}
              className="px-4 py-2 bg-severity-critical text-white rounded-lg hover:bg-severity-critical/90 transition-colors flex items-center gap-2"
            >
              <Pause size={16} /> Stop
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Video Feed */}
        <div className="lg:col-span-2 space-y-4">
          <div className="bg-card rounded-xl border border-border overflow-hidden">
            <div className="aspect-video bg-background relative">
              <video
                ref={videoRef}
                className="w-full h-full object-cover"
                playsInline
                muted
              />
              <DetectionOverlay
                videoRef={videoRef}
                entities={entities.map((e: any) => ({
                  id: e.id, cls: e.class ?? e.cls, conf: e.confidence ?? e.conf,
                  x: e.x, y: e.y, w: e.w, h: e.h,
                  speed: e.speed ?? 0, heading: e.heading ?? 0,
                }))}
                alerts={evidence.map((ev: any) => ({
                  objs: ev.objects, conf: ev.confidence, type: ev.type,
                }))}
                active={isAnalyzing}
              />

              {isAnalyzing && (
                <div className="absolute top-4 left-4 flex items-center gap-2">
                  <div className="w-3 h-3 bg-severity-critical rounded-full animate-severity-pulse" />
                  <span className="text-sm font-medium bg-black/50 px-2 py-1 rounded">
                    AI Active | {envMode} mode
                  </span>
                </div>
              )}

              {isAnalyzing && (
                <div className="absolute top-4 right-4 bg-black/50 px-3 py-1 rounded text-sm">
                  Objects: {entities.filter(e => e.age >= 1).length} | Alerts: {evidence.length}
                </div>
              )}
            </div>

            {/* File upload */}
            <div className="p-4 border-t border-border">
              <input
                type="file"
                ref={fileInputRef}
                accept="video/*"
                onChange={handleFileUpload}
                className="hidden"
              />
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="text-sm text-primary hover:underline"
                >
                  Upload video file
                </button>
                <span className="text-muted-foreground text-xs">or try demo clips:</span>
                {[
                  { name: "Accident", src: "/videos/accident_sample.mp4" },
                  { name: "Camera 2", src: "/videos/camera2_demo.mp4" },
                  { name: "Camera 4", src: "/videos/camera4_demo.mp4" },
                  { name: "Check", src: "/videos/checking.mp4" },
                ].map((demo) => (
                  <button
                    key={demo.name}
                    onClick={() => {
                      if (videoRef.current) {
                        videoRef.current.src = demo.src;
                        videoRef.current.play();
                        setSelectedFile(new File([], demo.name));
                      }
                    }}
                    className="px-2 py-1 bg-primary/10 text-primary rounded text-xs hover:bg-primary/20 transition-colors"
                  >
                    {demo.name}
                  </button>
                ))}
              </div>
              {selectedFile && selectedFile.name && (
                <span className="mt-2 block text-sm text-muted-foreground">
                  Loaded: {selectedFile.name}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Side Panel */}
        <div className="space-y-4">
          {/* Detection State */}
          <div className="bg-card p-4 rounded-xl border border-border">
            <h3 className="font-semibold mb-3 flex items-center gap-2">
              <AlertTriangle size={16} />
              Detection State
            </h3>
            <div className="space-y-2">
              {["Monitoring", "Watching", "Confirming", "Alert"].map((s, i) => {
                const stateName = s.toLowerCase();
                const isActive = stateName === detection.state;
                return (
                  <div
                    key={s}
                    className={`flex items-center gap-2 p-2 rounded ${
                      isActive ? "bg-primary/20 text-primary" : "text-muted-foreground"
                    }`}
                  >
                    <div
                      className={`w-2 h-2 rounded-full ${
                        isActive ? "bg-primary animate-pulse" : "bg-border"
                      }`}
                    />
                    <span className="text-sm">{s}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Evidence */}
          <div className="bg-card p-4 rounded-xl border border-border">
            <h3 className="font-semibold mb-3">Detected Objects ({entities.filter(e => e.age >= 1).length})</h3>
            <div className="space-y-2 max-h-48 overflow-y-auto">
              {entities.filter(e => e.age >= 1).length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {isAnalyzing ? "Scanning for objects..." : "Start analysis to detect objects"}
                </p>
              ) : (
                entities.filter(e => e.age >= 1).map((ent) => {
                  const isInvolved = evidence.some(e => e.objects.includes(ent.id));
                  return (
                    <div key={ent.id} className={`flex items-center justify-between p-2 bg-background rounded ${isInvolved ? "border border-red-500/50" : ""}`}>
                      <div className="flex items-center gap-2">
                        <div className={`w-2 h-2 rounded-full ${isInvolved ? "bg-red-500" : ent.class === "person" ? "bg-primary" : ent.class === "car" ? "bg-green-500" : "bg-severity-major"}`} />
                        <span className="text-sm capitalize">{ent.class}</span>
                        <span className="text-xs text-muted-foreground">#{ent.id}</span>
                      </div>
                      <div className="text-right">
                        <span className="text-sm">{(ent.confidence * 100).toFixed(0)}%</span>
                        <span className="text-xs text-severity-major ml-2">age:{ent.age}</span>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Alerts */}
          <div className="bg-card p-4 rounded-xl border border-border">
            <h3 className="font-semibold mb-3">Incidents Detected</h3>
            <p className="text-3xl font-bold text-severity-critical">{incidents.length}</p>
            <p className="text-sm text-muted-foreground">Alerts in this session</p>
            {incidents.length > 0 && (
              <div className="mt-2 space-y-1 max-h-24 overflow-y-auto">
                {incidents.slice(-5).reverse().map((inc, i) => (
                  <div key={i} className="text-xs p-1 rounded bg-severity-critical/10 text-severity-critical">
                    {inc.type.replace(/_/g, " ")} ({(inc.confidence * 100).toFixed(0)}%)
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

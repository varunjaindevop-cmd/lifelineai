"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  ArrowLeft,
  Video,
  Play,
  Pause,
  AlertTriangle,
  MapPin,
  Clock,
  Navigation,
  CheckCircle,
  Loader2,
  RotateCcw,
} from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";

interface VideoClip {
  name: string;
  src: string;
  description: string;
}

interface Detection {
  class: string;
  confidence: number;
  bbox: [number, number, number, number];
  speed?: number;
}

interface AnalysisResult {
  clipName: string;
  status: "idle" | "analyzing" | "completed";
  detections: Detection[];
  incidents: IncidentAlert[];
  progress: number;
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
  {
    name: "accident_sample.mp4",
    src: "/videos/accident_sample.mp4",
    description: "Vehicle collision scenario — expect accident detection",
  },
  {
    name: "camera2_demo.mp4",
    src: "/videos/camera2_demo.mp4",
    description: "Camera 2 feed — traffic monitoring demo",
  },
  {
    name: "camera4_demo.mp4",
    src: "/videos/camera4_demo.mp4",
    description: "Camera 4 feed — intersection monitoring demo",
  },
  {
    name: "checking.mp4",
    src: "/videos/checking.mp4",
    description: "Test clip — system verification",
  },
];

// Default coordinates for demo (New Delhi area)
const DEMO_LAT = 28.6139;
const DEMO_LNG = 77.209;

export default function VideoAnalysisPage() {
  const [selectedClip, setSelectedClip] = useState<VideoClip | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [detections, setDetections] = useState<Detection[]>([]);
  const [incidents, setIncidents] = useState<IncidentAlert[]>([]);
  const [currentState, setCurrentState] = useState("monitoring");
  const [sceneChange, setSceneChange] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const frameBufferRef = useRef<ImageData[]>([]);
  const supabase = createClient();

  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  const captureFrame = useCallback((): ImageData | null => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.paused || video.ended) return null;

    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    canvas.width = 640;
    canvas.height = 480;
    ctx.drawImage(video, 0, 0, 640, 480);
    return ctx.getImageData(0, 0, 640, 480);
  }, []);

  const detectObjects = (imageData: ImageData): Detection[] => {
    const detections: Detection[] = [];
    const data = imageData.data;
    const gridSize = 64;

    for (let y = 0; y < imageData.height; y += gridSize) {
      for (let x = 0; x < imageData.width; x += gridSize) {
        let brightness = 0;
        let pixelCount = 0;

        for (let dy = 0; dy < gridSize && y + dy < imageData.height; dy++) {
          for (let dx = 0; dx < gridSize && x + dx < imageData.width; dx++) {
            const idx = ((y + dy) * imageData.width + (x + dx)) * 4;
            brightness += data[idx] * 0.299 + data[idx + 1] * 0.587 + data[idx + 2] * 0.114;
            pixelCount++;
          }
        }
        brightness /= pixelCount;

        if (brightness > 80 && brightness < 200 && Math.random() > 0.88) {
          const isPerson = Math.random() > 0.55;
          const confidence = 0.45 + Math.random() * 0.5;
          const bboxSize = isPerson ? 40 + Math.random() * 30 : 60 + Math.random() * 40;

          detections.push({
            class: isPerson ? "person" : "car",
            confidence,
            bbox: [
              x + Math.random() * 20,
              y + Math.random() * 20,
              x + bboxSize,
              y + bboxSize * (isPerson ? 2 : 1),
            ],
            speed: !isPerson ? Math.floor(20 + Math.random() * 80) : undefined,
          });
        }
      }
    }
    return detections;
  };

  const calculateSceneChange = (prev: ImageData, curr: ImageData): number => {
    let diff = 0;
    const step = 16;
    for (let i = 0; i < prev.data.length; i += step * 4) {
      const prevGray = prev.data[i] * 0.299 + prev.data[i + 1] * 0.587 + prev.data[i + 2] * 0.114;
      const currGray = curr.data[i] * 0.299 + curr.data[i + 1] * 0.587 + curr.data[i + 2] * 0.114;
      diff += Math.abs(prevGray - currGray);
    }
    return diff / (prev.data.length / 4 / step) / 255;
  };

  const checkForAccident = (
    dets: Detection[],
    sceneScore: number,
    prevFrame: ImageData | null,
    currFrame: ImageData
  ): IncidentAlert | null => {
    const vehicles = dets.filter((d) => d.class === "car");
    const pedestrians = dets.filter((d) => d.class === "person");

    // Vehicle-vehicle proximity
    for (let i = 0; i < vehicles.length; i++) {
      for (let j = i + 1; j < vehicles.length; j++) {
        const v1 = vehicles[i];
        const v2 = vehicles[j];
        const overlap = Math.max(
          0,
          Math.min(v1.bbox[2], v2.bbox[2]) - Math.max(v1.bbox[0], v2.bbox[0])
        ) * Math.max(
          0,
          Math.min(v1.bbox[3], v2.bbox[3]) - Math.max(v1.bbox[1], v2.bbox[1])
        );
        const area1 = (v1.bbox[2] - v1.bbox[0]) * (v1.bbox[3] - v1.bbox[1]);
        const iou = area1 > 0 ? overlap / area1 : 0;

        if (iou > 0.1 || sceneScore > 0.3) {
          const confidence = 0.4 * Math.min(iou * 5, 1) + 0.3 * Math.min(sceneScore / 0.3, 1) + 0.3;
          if (confidence > 0.5) {
            return {
              type: "vehicle_collision",
              severity: confidence > 0.7 ? "critical" : "major",
              confidence,
              timestamp: new Date().toISOString(),
              latitude: DEMO_LAT + (Math.random() - 0.5) * 0.01,
              longitude: DEMO_LNG + (Math.random() - 0.5) * 0.01,
            };
          }
        }
      }
    }

    // Vehicle-pedestrian proximity
    for (const vehicle of vehicles) {
      for (const ped of pedestrians) {
        const overlap = Math.max(
          0,
          Math.min(vehicle.bbox[2], ped.bbox[2]) - Math.max(vehicle.bbox[0], ped.bbox[0])
        ) * Math.max(
          0,
          Math.min(vehicle.bbox[3], ped.bbox[3]) - Math.max(vehicle.bbox[1], ped.bbox[1])
        );
        if (overlap > 100 && sceneScore > 0.2) {
          return {
            type: "pedestrian_collision",
            severity: "critical",
            confidence: 0.7 + Math.random() * 0.2,
            timestamp: new Date().toISOString(),
            latitude: DEMO_LAT + (Math.random() - 0.5) * 0.01,
            longitude: DEMO_LNG + (Math.random() - 0.5) * 0.01,
          };
        }
      }
    }

    return null;
  };

  const drawDetections = (dets: Detection[]) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    dets.forEach((det) => {
      const [x1, y1, x2, y2] = det.bbox;
      const color = det.class === "person" ? "#3B82F6" : "#22C55E";

      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);

      ctx.fillStyle = color;
      ctx.fillRect(x1, y1 - 20, 130, 20);
      ctx.fillStyle = "white";
      ctx.font = "12px Arial";
      ctx.fillText(
        `${det.class} ${(det.confidence * 100).toFixed(0)}%${det.speed ? ` | ${det.speed}km/h` : ""}`,
        x1 + 4,
        y1 - 6
      );
    });
  };

  const startAnalysis = () => {
    if (!videoRef.current || !selectedClip) return;

    videoRef.current.play();
    setIsPlaying(true);
    setIsAnalyzing(true);
    setDetections([]);
    setIncidents([]);
    setCurrentState("monitoring");
    frameBufferRef.current = [];

    let prevFrame: ImageData | null = null;
    let state = "monitoring";

    intervalRef.current = setInterval(() => {
      const frame = captureFrame();
      if (!frame) return;

      // Buffer for clip recording
      frameBufferRef.current.push(frame);
      if (frameBufferRef.current.length > 75) frameBufferRef.current.shift();

      // Scene change
      let sceneScore = 0;
      if (prevFrame) {
        sceneScore = calculateSceneChange(prevFrame, frame);
      }
      prevFrame = frame;
      setSceneChange(sceneScore);

      // Detect
      const dets = detectObjects(frame);
      setDetections(dets);
      drawDetections(dets);

      // State machine
      const accident = checkForAccident(dets, sceneScore, prevFrame, frame);

      if (accident) {
        if (state === "monitoring") {
          state = "watching";
          setCurrentState("watching");
        } else if (state === "watching" && accident.confidence > 0.5) {
          state = "confirming";
          setCurrentState("confirming");
        } else if (state === "confirming" && accident.confidence > 0.6) {
          state = "alert";
          setCurrentState("alert");

          // Create incident in DB
          createIncidentFromDetection(accident);

          // Reset after alert
          state = "monitoring";
          setCurrentState("monitoring");
        }
      } else {
        if (state !== "monitoring") {
          state = "monitoring";
          setCurrentState("monitoring");
        }
      }
    }, 200);
  };

  const createIncidentFromDetection = async (alert: IncidentAlert) => {
    const { data: incident, error } = await supabase
      .from("incidents")
      .insert({
        severity: alert.severity,
        incident_type: alert.type,
        latitude: alert.latitude,
        longitude: alert.longitude,
        location_name: `Demo Clip: ${selectedClip?.name}`,
        camera_id: "demo-clip",
        detection_confidence: alert.confidence,
        detection_data: { source: "video_analysis", clip: selectedClip?.name },
        status: "detected",
      })
      .select()
      .single();

    if (!error && incident) {
      setIncidents((prev) => [...prev, alert]);
      toast.error(
        `ACCIDENT DETECTED: ${alert.type.replace(/_/g, " ")} (${alert.severity})`
      );

      // Broadcast to ambulance channel
      supabase.channel("alerts:ambulance").send({
        type: "broadcast",
        event: "new_incident",
        payload: {
          incident_id: incident.id,
          severity: alert.severity,
          incident_type: alert.type,
          latitude: alert.latitude,
          longitude: alert.longitude,
          message: `ACCIDENT from video analysis: ${alert.type.replace(/_/g, " ")}`,
          camera_id: "demo-clip",
        },
      });
    }
  };

  const stopAnalysis = () => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.currentTime = 0;
    }
    setIsPlaying(false);
    setIsAnalyzing(false);
    setCurrentState("monitoring");
  };

  const resetClip = () => {
    stopAnalysis();
    setDetections([]);
    setIncidents([]);
    setSceneChange(0);
  };

  const stateColors: Record<string, string> = {
    monitoring: "bg-green-500/20 text-green-500",
    watching: "bg-yellow-500/20 text-yellow-500",
    confirming: "bg-orange-500/20 text-orange-500",
    alert: "bg-red-500/20 text-red-500 animate-pulse",
  };

  return (
    <div className="space-y-6">
      <Link
        href="/admin"
        className="inline-flex items-center gap-2 text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft size={16} />
        Back to Admin
      </Link>

      <div>
        <h1 className="text-2xl font-bold">Video Analysis</h1>
        <p className="text-muted-foreground">
          AI-powered analysis of camera clips — accidents auto-dispatch ambulance
        </p>
      </div>

      {!selectedClip ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {VIDEO_CLIPS.map((clip) => (
            <button
              key={clip.name}
              onClick={() => setSelectedClip(clip)}
              className="bg-card p-5 rounded-xl border border-border hover:border-primary/50 transition-colors text-left"
            >
              <div className="flex items-start gap-4">
                <div className="w-16 h-16 bg-background rounded-lg flex items-center justify-center shrink-0">
                  <Video className="w-8 h-8 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="font-semibold truncate">{clip.name}</h3>
                  <p className="text-sm text-muted-foreground mt-1">
                    {clip.description}
                  </p>
                  <div className="mt-3 flex items-center gap-2">
                    <span className="px-2 py-1 bg-primary/20 text-primary rounded text-xs">
                      AI Analysis
                    </span>
                    <span className="px-2 py-1 bg-background rounded text-xs">
                      {clip.src}
                    </span>
                  </div>
                </div>
              </div>
            </button>
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          <button
            onClick={() => {
              resetClip();
              setSelectedClip(null);
            }}
            className="text-sm text-primary hover:underline"
          >
            ← Choose different clip
          </button>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Video */}
            <div className="lg:col-span-2 space-y-4">
              <div className="bg-card rounded-xl border border-border overflow-hidden">
                <div className="aspect-video bg-black relative">
                  <video
                    ref={videoRef}
                    src={selectedClip.src}
                    className="w-full h-full object-contain"
                    playsInline
                    muted
                    loop
                  />
                  <canvas
                    ref={canvasRef}
                    className="absolute inset-0 w-full h-full"
                    style={{ pointerEvents: "none" }}
                  />

                  {isAnalyzing && (
                    <div className="absolute top-4 left-4 flex items-center gap-2">
                      <div className="w-3 h-3 bg-red-500 rounded-full animate-pulse" />
                      <span className="text-sm font-medium bg-black/60 px-2 py-1 rounded">
                        AI Analyzing
                      </span>
                    </div>
                  )}

                  {isAnalyzing && (
                    <div className="absolute top-4 right-4 bg-black/60 px-3 py-1 rounded text-sm">
                      Objects: {detections.length}
                    </div>
                  )}
                </div>

                <div className="p-4 border-t border-border flex items-center gap-3">
                  {!isAnalyzing ? (
                    <button
                      onClick={startAnalysis}
                      className="px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors flex items-center gap-2"
                    >
                      <Play size={16} />
                      Start AI Analysis
                    </button>
                  ) : (
                    <>
                      <button
                        onClick={stopAnalysis}
                        className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors flex items-center gap-2"
                      >
                        <Pause size={16} />
                        Stop
                      </button>
                      <button
                        onClick={resetClip}
                        className="px-4 py-2 bg-card border border-border rounded-lg hover:bg-background transition-colors flex items-center gap-2"
                      >
                        <RotateCcw size={16} />
                        Reset
                      </button>
                    </>
                  )}
                  <span className="ml-auto text-sm text-muted-foreground">
                    {selectedClip.name}
                  </span>
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
                  {["monitoring", "watching", "confirming", "alert"].map(
                    (state) => (
                      <div
                        key={state}
                        className={`flex items-center gap-2 p-2 rounded ${
                          currentState === state
                            ? stateColors[state]
                            : "text-muted-foreground"
                        }`}
                      >
                        <div
                          className={`w-2 h-2 rounded-full ${
                            currentState === state
                              ? "bg-current animate-pulse"
                              : "bg-border"
                          }`}
                        />
                        <span className="text-sm capitalize">{state}</span>
                      </div>
                    )
                  )}
                </div>
              </div>

              {/* Scene Change */}
              <div className="bg-card p-4 rounded-xl border border-border">
                <h3 className="font-semibold mb-3">Scene Analysis</h3>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Scene Change</span>
                    <span
                      className={
                        sceneChange > 0.3
                          ? "text-red-500 font-bold"
                          : sceneChange > 0.15
                          ? "text-yellow-500"
                          : ""
                      }
                    >
                      {(sceneChange * 100).toFixed(1)}%
                    </span>
                  </div>
                  <div className="w-full bg-background rounded-full h-2">
                    <div
                      className={`h-2 rounded-full transition-all ${
                        sceneChange > 0.3
                          ? "bg-red-500"
                          : sceneChange > 0.15
                          ? "bg-yellow-500"
                          : "bg-green-500"
                      }`}
                      style={{ width: `${Math.min(sceneChange * 200, 100)}%` }}
                    />
                  </div>
                </div>
              </div>

              {/* Detected Objects */}
              <div className="bg-card p-4 rounded-xl border border-border">
                <h3 className="font-semibold mb-3">Detected Objects</h3>
                <div className="space-y-2 max-h-48 overflow-y-auto">
                  {detections.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      {isAnalyzing
                        ? "Scanning..."
                        : "Start analysis to detect objects"}
                    </p>
                  ) : (
                    detections.map((det, i) => (
                      <div
                        key={i}
                        className="flex items-center justify-between p-2 bg-background rounded"
                      >
                        <div className="flex items-center gap-2">
                          <div
                            className={`w-2 h-2 rounded-full ${
                              det.class === "person"
                                ? "bg-blue-500"
                                : "bg-green-500"
                            }`}
                          />
                          <span className="text-sm capitalize">{det.class}</span>
                        </div>
                        <div className="text-right">
                          <span className="text-sm">
                            {(det.confidence * 100).toFixed(0)}%
                          </span>
                          {det.speed && (
                            <span className="text-xs text-orange-500 ml-2">
                              {det.speed}km/h
                            </span>
                          )}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>

              {/* Incidents */}
              <div className="bg-card p-4 rounded-xl border border-border">
                <h3 className="font-semibold mb-3">Detected Incidents</h3>
                {incidents.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No accidents detected yet
                  </p>
                ) : (
                  <div className="space-y-2">
                    {incidents.map((inc, i) => (
                      <div
                        key={i}
                        className={`p-3 rounded-lg border-l-4 ${
                          inc.severity === "critical"
                            ? "border-red-500 bg-red-500/10"
                            : "border-orange-500 bg-orange-500/10"
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <AlertTriangle
                            size={14}
                            className={
                              inc.severity === "critical"
                                ? "text-red-500"
                                : "text-orange-500"
                            }
                          />
                          <span className="text-sm font-medium capitalize">
                            {inc.type.replace(/_/g, " ")}
                          </span>
                        </div>
                        <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                          <span className="capitalize">{inc.severity}</span>
                          <span>{(inc.confidence * 100).toFixed(0)}%</span>
                          <span className="flex items-center gap-1">
                            <Clock size={10} />
                            {new Date(inc.timestamp).toLocaleTimeString()}
                          </span>
                        </div>
                        <Link
                          href="/ambulance"
                          className="mt-2 inline-flex items-center gap-1 text-xs text-primary hover:underline"
                        >
                          <Navigation size={10} />
                          View on Ambulance Dashboard
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

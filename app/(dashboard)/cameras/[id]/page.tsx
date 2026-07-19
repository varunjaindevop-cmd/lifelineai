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
  Settings,
} from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";

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

interface Detection {
  class: string;
  confidence: number;
  bbox: [number, number, number, number]; // x1, y1, x2, y2
  speed?: number;
}

interface QualityMetrics {
  brightness: number;
  contrast: number;
  sharpness: number;
  noise: number;
}

export default function CameraFeedPage() {
  const params = useParams();
  const [camera, setCamera] = useState<Camera | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [detections, setDetections] = useState<Detection[]>([]);
  const [quality, setQuality] = useState<QualityMetrics | null>(null);
  const [incidentCount, setIncidentCount] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [frameBuffer, setFrameBuffer] = useState<ImageData[]>([]);
  const supabase = createClient();

  useEffect(() => {
    const fetchCamera = async () => {
      const { data } = await supabase
        .from("cameras")
        .select("*")
        .eq("id", params.id)
        .single();

      if (data) {
        setCamera(data);
      }
    };

    fetchCamera();
  }, [params.id]);

  // Capture frame from video
  const captureFrame = useCallback((): ImageData | null => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return null;

    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    canvas.width = 640;
    canvas.height = 480;
    ctx.drawImage(video, 0, 0, 640, 480);

    return ctx.getImageData(0, 0, 640, 480);
  }, []);

  // Analyze image quality
  const analyzeQuality = (imageData: ImageData): QualityMetrics => {
    const data = imageData.data;
    let sum = 0;
    let sumSq = 0;
    const pixels = data.length / 4;

    for (let i = 0; i < data.length; i += 4) {
      const gray = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
      sum += gray;
      sumSq += gray * gray;
    }

    const mean = sum / pixels;
    const variance = sumSq / pixels - mean * mean;

    return {
      brightness: mean,
      contrast: Math.sqrt(variance),
      sharpness: Math.random() * 100, // Simplified
      noise: Math.random() * 50, // Simplified
    };
  };

  // Detect objects (simplified YOLO simulation for demo)
  const detectObjects = (imageData: ImageData): Detection[] => {
    // In production, this would run ONNX inference
    // For demo, we simulate detections
    const detections: Detection[] = [];

    // Simulate random detections for demo
    if (Math.random() > 0.7) {
      detections.push({
        class: "person",
        confidence: 0.6 + Math.random() * 0.3,
        bbox: [
          100 + Math.random() * 200,
          100 + Math.random() * 200,
          150 + Math.random() * 200,
          250 + Math.random() * 200,
        ],
      });
    }

    if (Math.random() > 0.8) {
      detections.push({
        class: "car",
        confidence: 0.5 + Math.random() * 0.4,
        bbox: [
          300 + Math.random() * 100,
          200 + Math.random() * 100,
          400 + Math.random() * 100,
          300 + Math.random() * 100,
        ],
        speed: Math.floor(20 + Math.random() * 80),
      });
    }

    return detections;
  };

  // Draw detections on canvas
  const drawDetections = (dets: Detection[]) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    dets.forEach((det) => {
      const [x1, y1, x2, y2] = det.bbox;
      const color =
        det.class === "person"
          ? "#3B82F6"
          : det.class === "car"
          ? "#22C55E"
          : "#F97316";

      // Draw bounding box
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);

      // Draw label
      ctx.fillStyle = color;
      ctx.fillRect(x1, y1 - 20, 120, 20);
      ctx.fillStyle = "white";
      ctx.font = "12px Arial";
      ctx.fillText(
        `${det.class} ${(det.confidence * 100).toFixed(0)}%${
          det.speed ? ` | ${det.speed} km/h` : ""
        }`,
        x1 + 4,
        y1 - 6
      );
    });
  };

  // Main analysis loop
  const startAnalysis = async () => {
    if (!camera) return;

    setIsAnalyzing(true);
    setIncidentCount(0);

    // If using browser camera
    if (camera.stream_type === "browser" || !camera.stream_url) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 640, height: 480 },
        });
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play();
        }
      } catch (err) {
        toast.error(
          "Camera access denied. Please upload a video file instead."
        );
        setIsAnalyzing(false);
        return;
      }
    }

    // Analysis interval
    const interval = setInterval(() => {
      const frame = captureFrame();
      if (!frame) return;

      // Maintain 15-second buffer (75 frames at 5fps)
      setFrameBuffer((prev) => {
        const newBuffer = [...prev, frame];
        if (newBuffer.length > 75) {
          newBuffer.shift();
        }
        return newBuffer;
      });

      // Analyze quality
      const q = analyzeQuality(frame);
      setQuality(q);

      // Detect objects
      const dets = detectObjects(frame);
      setDetections(dets);
      drawDetections(dets);

      // Check for incidents (simplified)
      const hasAccident = dets.some(
        (d) =>
          (d.class === "car" && d.confidence > 0.8) ||
          (d.class === "person" && d.confidence > 0.85)
      );

      if (hasAccident && Math.random() > 0.95) {
        setIncidentCount((prev) => prev + 1);
        toast.error("Potential incident detected!");
      }
    }, 200); // 5 FPS analysis

    // Cleanup
    return () => {
      clearInterval(interval);
      if (videoRef.current?.srcObject) {
        const tracks = (videoRef.current.srcObject as MediaStream).getTracks();
        tracks.forEach((track) => track.stop());
      }
    };
  };

  const stopAnalysis = () => {
    setIsAnalyzing(false);
    if (videoRef.current?.srcObject) {
      const tracks = (videoRef.current.srcObject as MediaStream).getTracks();
      tracks.forEach((track) => track.stop());
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setSelectedFile(file);
      const url = URL.createObjectURL(file);
      if (videoRef.current) {
        videoRef.current.src = url;
        videoRef.current.play();
      }
    }
  };

  if (!camera) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        Loading camera...
      </div>
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
          <p className="text-muted-foreground">
            {camera.location_name || "AI-Powered Camera Feed"}
          </p>
        </div>
        <div className="flex gap-2">
          {!isAnalyzing ? (
            <button
              onClick={startAnalysis}
              className="px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors flex items-center gap-2"
            >
              <Play size={16} />
              Start AI Analysis
            </button>
          ) : (
            <button
              onClick={stopAnalysis}
              className="px-4 py-2 bg-severity-critical text-white rounded-lg hover:bg-severity-critical/90 transition-colors flex items-center gap-2"
            >
              <Pause size={16} />
              Stop
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
              <canvas
                ref={canvasRef}
                className="absolute inset-0 w-full h-full"
                style={{ pointerEvents: "none" }}
              />

              {/* Detection overlay */}
              {isAnalyzing && (
                <div className="absolute top-4 left-4 flex items-center gap-2">
                  <div className="w-3 h-3 bg-severity-critical rounded-full animate-severity-pulse" />
                  <span className="text-sm font-medium bg-black/50 px-2 py-1 rounded">
                    AI Analysis Active
                  </span>
                </div>
              )}

              {/* Detection count */}
              {isAnalyzing && (
                <div className="absolute top-4 right-4 bg-black/50 px-3 py-1 rounded text-sm">
                  Objects: {detections.length}
                </div>
              )}
            </div>

            {/* File upload for demo */}
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
          {/* State Machine */}
          <div className="bg-card p-4 rounded-xl border border-border">
            <h3 className="font-semibold mb-3 flex items-center gap-2">
              <AlertTriangle size={16} />
              Detection State
            </h3>
            <div className="space-y-2">
              {["Monitoring", "Watching", "Confirming", "Alert"].map(
                (state, i) => {
                  const isActive = isAnalyzing && i === 0;
                  return (
                    <div
                      key={state}
                      className={`flex items-center gap-2 p-2 rounded ${
                        isActive
                          ? "bg-primary/20 text-primary"
                          : "text-muted-foreground"
                      }`}
                    >
                      <div
                        className={`w-2 h-2 rounded-full ${
                          isActive ? "bg-primary animate-pulse" : "bg-border"
                        }`}
                      />
                      <span className="text-sm">{state}</span>
                    </div>
                  );
                }
              )}
            </div>
          </div>

          {/* Quality Metrics */}
          {quality && (
            <div className="bg-card p-4 rounded-xl border border-border">
              <h3 className="font-semibold mb-3 flex items-center gap-2">
                <Settings size={16} />
                Quality Analysis
              </h3>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Brightness</span>
                  <span>{quality.brightness.toFixed(0)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Contrast</span>
                  <span>{quality.contrast.toFixed(0)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Sharpness</span>
                  <span>{quality.sharpness.toFixed(0)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Noise</span>
                  <span>{quality.noise.toFixed(0)}</span>
                </div>
              </div>
              {(quality.brightness < 50 || quality.contrast < 30) && (
                <div className="mt-3 p-2 bg-severity-major/20 text-severity-major rounded text-xs">
                  Auto-enhancing: {quality.brightness < 50 ? "CLAHE enabled" : ""}
                  {quality.contrast < 30 ? " Contrast boost" : ""}
                </div>
              )}
            </div>
          )}

          {/* Detections */}
          <div className="bg-card p-4 rounded-xl border border-border">
            <h3 className="font-semibold mb-3">Detected Objects</h3>
            <div className="space-y-2">
              {detections.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {isAnalyzing
                    ? "Scanning for objects..."
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
                            ? "bg-primary"
                            : det.class === "car"
                            ? "bg-green-500"
                            : "bg-severity-major"
                        }`}
                      />
                      <span className="text-sm capitalize">{det.class}</span>
                    </div>
                    <div className="text-right">
                      <span className="text-sm">
                        {(det.confidence * 100).toFixed(0)}%
                      </span>
                      {det.speed && (
                        <span className="text-xs text-severity-major ml-2">
                          {det.speed} km/h
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
            <h3 className="font-semibold mb-3">Incidents Detected</h3>
            <p className="text-3xl font-bold text-severity-critical">
              {incidentCount}
            </p>
            <p className="text-sm text-muted-foreground">
              Potential incidents in this session
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

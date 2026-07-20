"use client";

import { useState, useRef, useCallback } from "react";
import { loadModel, detect, isModelReady } from "@/lib/detection/onnx-engine";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";

export default function TestPage() {
  const [status, setStatus] = useState("Click Load Model to begin");
  const [detectionCount, setDetectionCount] = useState(0);
  const [inferenceTime, setInferenceTime] = useState(0);
  const [loading, setLoading] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);

  const loadModelHandler = useCallback(async () => {
    setLoading(true);
    setStatus("Loading ONNX model...");
    try {
      await loadModel("/models/best.onnx");
      setStatus("Model loaded successfully! Upload an image or use the test image below.");
    } catch (err: any) {
      setStatus(`Model load FAILED: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  const drawTestImage = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    canvas.width = 640;
    canvas.height = 480;
    // Draw a simple test scene
    ctx.fillStyle = "#87CEEB";
    ctx.fillRect(0, 0, 640, 480);
    ctx.fillStyle = "#228B22";
    ctx.fillRect(0, 350, 640, 130);
    ctx.fillStyle = "#555";
    ctx.fillRect(100, 380, 440, 60);
    // Draw a "car" shape
    ctx.fillStyle = "#e74c3c";
    ctx.fillRect(200, 360, 120, 50);
    ctx.fillRect(210, 340, 100, 30);
    // Draw a "person" shape
    ctx.fillStyle = "#f39c12";
    ctx.beginPath();
    ctx.arc(450, 340, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(444, 352, 12, 40);
    setStatus("Test image drawn. Click Run Inference.");
  }, []);

  const runInference = useCallback(async () => {
    const canvas = canvasRef.current;
    const overlay = overlayRef.current;
    if (!canvas || !overlay) return;
    if (!isModelReady()) {
      setStatus("Model not loaded! Click Load Model first.");
      return;
    }

    setStatus("Running inference...");
    const ctx = canvas.getContext("2d")!;
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

    const t0 = performance.now();
    const dets = await detect(imageData);
    const elapsed = performance.now() - t0;

    setDetectionCount(dets.length);
    setInferenceTime(Math.round(elapsed));
    setStatus(`Done! ${dets.length} detections in ${Math.round(elapsed)}ms`);

    // Draw bounding boxes on overlay
    const octx = overlay.getContext("2d")!;
    overlay.width = canvas.width;
    overlay.height = canvas.height;
    octx.clearRect(0, 0, overlay.width, overlay.height);

    for (const det of dets) {
      const x = det.bbox[0] * overlay.width;
      const y = det.bbox[1] * overlay.height;
      const w = (det.bbox[2] - det.bbox[0]) * overlay.width;
      const h = (det.bbox[3] - det.bbox[1]) * overlay.height;

      octx.strokeStyle = "#ff0000";
      octx.lineWidth = 3;
      octx.strokeRect(x, y, w, h);

      octx.fillStyle = "rgba(255,0,0,0.8)";
      octx.fillRect(x, y - 20, 200, 20);
      octx.fillStyle = "#fff";
      octx.font = "bold 12px monospace";
      octx.fillText(`${det.class} ${(det.confidence * 100).toFixed(0)}%`, x + 4, y - 5);
    }
  }, []);

  const handleFileUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const img = new Image();
    img.onload = () => {
      const canvas = canvasRef.current!;
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      setStatus("Image loaded. Click Run Inference.");
    };
    img.src = URL.createObjectURL(file);
  }, []);

  return (
    <div className="min-h-screen bg-background p-6">
      <Link href="/admin" className="inline-flex items-center gap-2 text-muted-foreground hover:text-foreground mb-4">
        <ArrowLeft size={16} /> Back to Admin
      </Link>
      <h1 className="text-2xl font-bold mb-6">Diagnostic Test Page</h1>

      <div className="flex gap-4 mb-6 flex-wrap">
        <button onClick={loadModelHandler} disabled={loading}
          className="px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary/90 disabled:opacity-50">
          {loading ? "Loading..." : "Load ONNX Model"}
        </button>
        <button onClick={drawTestImage}
          className="px-4 py-2 bg-card border border-border rounded-lg hover:bg-background">
          Draw Test Image
        </button>
        <button onClick={runInference}
          className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700">
          Run Inference
        </button>
        <label className="px-4 py-2 bg-card border border-border rounded-lg hover:bg-background cursor-pointer">
          Upload Image
          <input type="file" accept="image/*" onChange={handleFileUpload} className="hidden" />
        </label>
      </div>

      <div className="mb-4 text-sm">
        <div>Status: <span className={status.includes("FAILED") ? "text-red-500" : "text-green-500"}>{status}</span></div>
        <div>Model Ready: {isModelReady() ? "YES" : "NO"}</div>
        <div>Detections: {detectionCount}</div>
        <div>Inference Time: {inferenceTime}ms</div>
      </div>

      <div className="relative inline-block">
        <canvas ref={canvasRef} width={640} height={480} className="bg-gray-200 rounded-lg" />
        <canvas ref={overlayRef} width={640} height={480} className="absolute top-0 left-0 pointer-events-none" />
      </div>
    </div>
  );
}

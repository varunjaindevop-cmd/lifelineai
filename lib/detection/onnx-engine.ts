/**
 * ONNX YOLOv8n Inference Engine for browser.
 * Uses onnxruntime-web with WebGL (or WASM fallback).
 *
 * Expected model: best.onnx at /models/best.onnx
 * Output shape: [1, 11, 8400]  (7 classes + 4 bbox coords)
 * Class mapping: 0 person, 1 car, 2 motorcycle, 3 bus, 4 truck, 5 bicycle, 6 fallen_person
 */

import * as ort from "onnxruntime-web";

// ── Class mapping ────────────────────────────────────────────────
const CLASS_NAMES: Record<number, string> = {
  0: "person",
  1: "car",
  2: "motorcycle",
  3: "bus",
  4: "truck",
  5: "bicycle",
  6: "fallen_person",
};

export interface Detection {
  bbox: [number, number, number, number]; // [x1, y1, x2, y2] normalised 0‑1
  class: string;
  classId: number;
  confidence: number;
  cx: number;
  cy: number;
  width: number;
  height: number;
}

// ── Preprocessing constants (must match YOLOv8 training) ─────────
const INPUT_SIZE = 640;

// ── NMS settings ────────────────────────────────────────────────
const IOU_THRESHOLD = 0.5;
const SCORE_THRESHOLD = 0.25;

// ── Singleton session ────────────────────────────────────────────
let session: ort.InferenceSession | null = null;
let loading = false;

/**
 * Load the ONNX model. WebGL preferred, WASM fallback.
 */
export async function loadModel(modelPath = "/models/best.onnx"): Promise<void> {
  if (session || loading) return;
  loading = true;

  try {
    // Try WebGL first, fall back to WASM
    let backend: string;
    try {
      const backends = (ort.env as any).backends;
      if (backends?.webgl?.init) await backends.webgl.init();
      backend = "webgl";
    } catch {
      backend = "wasm";
    }

    session = await ort.InferenceSession.create(modelPath, {
      executionProviders: [backend, "wasm"],
      graphOptimizationLevel: "all",
    });

    console.log(`[ONNXEngine] Loaded model from ${modelPath} (backend: ${backend})`);
  } finally {
    loading = false;
  }
}

export function isModelReady(): boolean {
  return session !== null;
}

// ── Letterbox preprocessing ─────────────────────────────────────

interface LetterboxResult {
  tensor: ort.Tensor;
  ratio: number;
  padX: number;
  padY: number;
}

function letterbox(imageData: ImageData): LetterboxResult {
  const { width: srcW, height: srcH, data } = imageData;

  // Compute scale and padding
  const scale = Math.min(INPUT_SIZE / srcW, INPUT_SIZE / srcH);
  const newW = Math.round(srcW * scale);
  const newH = Math.round(srcH * scale);
  const padX = (INPUT_SIZE - newW) / 2;
  const padY = (INPUT_SIZE - newH) / 2;

  // Create canvas for resizing
  const canvas = new OffscreenCanvas(INPUT_SIZE, INPUT_SIZE);
  const ctx = canvas.getContext("2d")!;

  // Fill with grey (114/255 — standard YOLO letterbox fill)
  ctx.fillStyle = `rgb(114,114,114)`;
  ctx.fillRect(0, 0, INPUT_SIZE, INPUT_SIZE);

  // Draw source image scaled
  const srcCanvas = new OffscreenCanvas(srcW, srcH);
  const srcCtx = srcCanvas.getContext("2d")!;
  srcCtx.putImageData(imageData, 0, 0);
  ctx.drawImage(srcCanvas, padX, padY, newW, newH);

  // Extract pixel data and build NCHW Float32 tensor
  const pixels = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE).data;
  const chw = new Float32Array(3 * INPUT_SIZE * INPUT_SIZE);

  for (let i = 0; i < INPUT_SIZE * INPUT_SIZE; i++) {
    const px = i * 4;
    // Normalise to [0, 1] (mean=0, std=1 — same as ultralytics)
    chw[i] = pixels[px] / 255.0;                        // R → channel 0
    chw[INPUT_SIZE * INPUT_SIZE + i] = pixels[px + 1] / 255.0; // G → channel 1
    chw[2 * INPUT_SIZE * INPUT_SIZE + i] = pixels[px + 2] / 255.0; // B → channel 2
  }

  return {
    tensor: new ort.Tensor("float32", chw, [1, 3, INPUT_SIZE, INPUT_SIZE]),
    ratio: scale,
    padX,
    padY,
  };
}

// ── NMS (Non-Maximum Suppression) ───────────────────────────────

function nms(boxes: Detection[], iouThresh: number): Detection[] {
  // Sort by confidence descending
  boxes.sort((a, b) => b.confidence - a.confidence);
  const keep: Detection[] = [];
  const suppressed = new Set<number>();

  for (let i = 0; i < boxes.length; i++) {
    if (suppressed.has(i)) continue;
    keep.push(boxes[i]);

    for (let j = i + 1; j < boxes.length; j++) {
      if (suppressed.has(j)) continue;
      if (boxes[i].classId !== boxes[j].classId) continue;

      // Compute IoU
      const [x1a, y1a, x2a, y2a] = boxes[i].bbox;
      const [x1b, y1b, x2b, y2b] = boxes[j].bbox;
      const ix1 = Math.max(x1a, x1b);
      const iy1 = Math.max(y1a, y1b);
      const ix2 = Math.min(x2a, x2b);
      const iy2 = Math.min(y2a, y2b);
      const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
      const areaA = (x2a - x1a) * (y2a - y1a);
      const areaB = (x2b - x1b) * (y2b - y1b);
      const iou = inter / (areaA + areaB - inter + 1e-6);

      if (iou > iouThresh) {
        suppressed.add(j);
      }
    }
  }
  return keep;
}

// ── Main detect function ────────────────────────────────────────

/**
 * Run YOLOv8 inference on an ImageData frame.
 * Returns detections in normalised [0,1] coordinates.
 */
export async function detect(imageData: ImageData): Promise<Detection[]> {
  if (!session) throw new Error("Model not loaded. Call loadModel() first.");

  // 1. Preprocess
  const { tensor, ratio, padX, padY } = letterbox(imageData);

  // 2. Inference
  const inputName = session.inputNames[0];
  const output = await session.run({ [inputName]: tensor });
  const outputName = session.outputNames[0];
  const outputTensor = output[outputName];

  // Output shape: [1, 11, 8400] → 7 classes + 4 bbox (cx, cy, w, h)
  const dims = outputTensor.dims; // [1, 11, 8400]
  const numChannels = dims[1];    // 11
  const numAnchors = dims[2];     // 8400
  const raw = outputTensor.data as Float32Array;

  const numClasses = numChannels - 4; // 7

  // 3. Parse detections
  const candidates: Detection[] = [];

  for (let a = 0; a < numAnchors; a++) {
    // Extract bbox (cx, cy, w, h) in letterbox space
    const cx_l = raw[0 * numAnchors + a];
    const cy_l = raw[1 * numAnchors + a];
    const w_l = raw[2 * numAnchors + a];
    const h_l = raw[3 * numAnchors + a];

    // Find best class
    let bestScore = -Infinity;
    let bestClass = 0;
    for (let c = 0; c < numClasses; c++) {
      const score = raw[(4 + c) * numAnchors + a];
      if (score > bestScore) {
        bestScore = score;
        bestClass = c;
      }
    }

    if (bestScore < SCORE_THRESHOLD) continue;

    // Convert from letterbox centre format to original image coords (normalised 0‑1)
    const x1_orig = (cx_l - w_l / 2 - padX) / ratio / imageData.width;
    const y1_orig = (cy_l - h_l / 2 - padY) / ratio / imageData.height;
    const x2_orig = (cx_l + w_l / 2 - padX) / ratio / imageData.width;
    const y2_orig = (cy_l + h_l / 2 - padY) / ratio / imageData.height;

    // Clamp to [0, 1]
    const x1 = Math.max(0, Math.min(1, x1_orig));
    const y1 = Math.max(0, Math.min(1, y1_orig));
    const x2 = Math.max(0, Math.min(1, x2_orig));
    const y2 = Math.max(0, Math.min(1, y2_orig));

    const w = x2 - x1;
    const h = y2 - y1;
    if (w < 0.005 || h < 0.005) continue; // skip tiny

    candidates.push({
      bbox: [x1, y1, x2, y2],
      class: CLASS_NAMES[bestClass] || `class_${bestClass}`,
      classId: bestClass,
      confidence: bestScore,
      cx: (x1 + x2) / 2,
      cy: (y1 + y2) / 2,
      width: w,
      height: h,
    });
  }

  // 4. NMS
  return nms(candidates, IOU_THRESHOLD);
}

/**
 * Convert normalised detections to pixel-space format expected by the worker/tracker.
 */
export function toPixelDetections(
  dets: Detection[],
  frameW: number,
  frameH: number
): { class: string; cx: number; cy: number; w: number; h: number; confidence: number }[] {
  return dets.map((d) => ({
    class: d.class,
    cx: d.cx * frameW,
    cy: d.cy * frameH,
    w: d.width * frameW,
    h: d.height * frameH,
    confidence: d.confidence,
  }));
}

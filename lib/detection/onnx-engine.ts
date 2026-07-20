/**
 * ONNX YOLOv8n Inference Engine — browser-only.
 * Loads /models/best.onnx via onnxruntime-web WASM backend.
 *
 * Model output: [1, 11, 8400]  (4 bbox + 7 classes)
 * Classes: 0 person, 1 car, 2 motorcycle, 3 bus, 4 truck, 5 bicycle, 6 fallen_person
 */

import * as ort from "onnxruntime-web/wasm";

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
  bbox: [number, number, number, number]; // [x1,y1,x2,y2] normalised 0‑1
  class: string;
  classId: number;
  confidence: number;
  cx: number;
  cy: number;
  width: number;
  height: number;
}

const INPUT_SIZE = 640;
const IOU_THRESHOLD = 0.5;
const SCORE_THRESHOLD = 0.25;

let session: ort.InferenceSession | null = null;
let loading = false;

export async function loadModel(modelPath = "/models/best.onnx"): Promise<void> {
  if (session || loading) return;
  loading = true;
  console.log(`[ONNX] Loading model from ${modelPath}...`);
  try {
    session = await ort.InferenceSession.create(modelPath, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    });
    console.log(`[ONNX] Model loaded. Inputs:`, session.inputNames, "Outputs:", session.outputNames);
    const inputMeta = session.inputNames[0] ? session.inputNames[0] : "unknown";
    console.log(`[ONNX] Input name: ${inputMeta}`);
  } finally {
    loading = false;
  }
}

export function isModelReady(): boolean {
  return session !== null;
}

function letterbox(imageData: ImageData): { tensor: ort.Tensor; ratio: number; padX: number; padY: number } {
  const { width: srcW, height: srcH } = imageData;
  const scale = Math.min(INPUT_SIZE / srcW, INPUT_SIZE / srcH);
  const newW = Math.round(srcW * scale);
  const newH = Math.round(srcH * scale);
  const padX = (INPUT_SIZE - newW) / 2;
  const padY = (INPUT_SIZE - newH) / 2;

  const canvas = new OffscreenCanvas(INPUT_SIZE, INPUT_SIZE);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "rgb(114,114,114)";
  ctx.fillRect(0, 0, INPUT_SIZE, INPUT_SIZE);

  const srcCanvas = new OffscreenCanvas(srcW, srcH);
  const srcCtx = srcCanvas.getContext("2d")!;
  srcCtx.putImageData(imageData, 0, 0);
  ctx.drawImage(srcCanvas, padX, padY, newW, newH);

  const pixels = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE).data;
  const chw = new Float32Array(3 * INPUT_SIZE * INPUT_SIZE);
  const n = INPUT_SIZE * INPUT_SIZE;
  for (let i = 0; i < n; i++) {
    const px = i * 4;
    chw[i] = pixels[px] / 255.0;
    chw[n + i] = pixels[px + 1] / 255.0;
    chw[2 * n + i] = pixels[px + 2] / 255.0;
  }

  return { tensor: new ort.Tensor("float32", chw, [1, 3, INPUT_SIZE, INPUT_SIZE]), ratio: scale, padX, padY };
}

function nms(boxes: Detection[], iouThresh: number): Detection[] {
  boxes.sort((a, b) => b.confidence - a.confidence);
  const keep: Detection[] = [];
  const suppressed = new Set<number>();
  for (let i = 0; i < boxes.length; i++) {
    if (suppressed.has(i)) continue;
    keep.push(boxes[i]);
    for (let j = i + 1; j < boxes.length; j++) {
      if (suppressed.has(j) || boxes[i].classId !== boxes[j].classId) continue;
      const [x1a, y1a, x2a, y2a] = boxes[i].bbox;
      const [x1b, y1b, x2b, y2b] = boxes[j].bbox;
      const ix1 = Math.max(x1a, x1b), iy1 = Math.max(y1a, y1b);
      const ix2 = Math.min(x2a, x2b), iy2 = Math.min(y2a, y2b);
      const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
      const areaA = (x2a - x1a) * (y2a - y1a), areaB = (x2b - x1b) * (y2b - y1b);
      if (inter / (areaA + areaB - inter + 1e-6) > iouThresh) suppressed.add(j);
    }
  }
  return keep;
}

export async function detect(imageData: ImageData): Promise<Detection[]> {
  if (!session) throw new Error("Model not loaded. Call loadModel() first.");
  const t0 = performance.now();

  const { tensor, ratio, padX, padY } = letterbox(imageData);
  const inputName = session.inputNames[0];
  const output = await session.run({ [inputName]: tensor });
  const outputTensor = output[session.outputNames[0]];
  const dims = outputTensor.dims;
  const numChannels = dims[1];
  const numAnchors = dims[2];
  const raw = outputTensor.data as Float32Array;
  const numClasses = numChannels - 4;
  const candidates: Detection[] = [];

  for (let a = 0; a < numAnchors; a++) {
    const cx_l = raw[0 * numAnchors + a];
    const cy_l = raw[1 * numAnchors + a];
    const w_l = raw[2 * numAnchors + a];
    const h_l = raw[3 * numAnchors + a];

    let bestScore = -Infinity, bestClass = 0;
    for (let c = 0; c < numClasses; c++) {
      const score = raw[(4 + c) * numAnchors + a];
      if (score > bestScore) { bestScore = score; bestClass = c; }
    }
    if (bestScore < SCORE_THRESHOLD) continue;

    const x1 = Math.max(0, Math.min(1, (cx_l - w_l / 2 - padX) / ratio / imageData.width));
    const y1 = Math.max(0, Math.min(1, (cy_l - h_l / 2 - padY) / ratio / imageData.height));
    const x2 = Math.max(0, Math.min(1, (cx_l + w_l / 2 - padX) / ratio / imageData.width));
    const y2 = Math.max(0, Math.min(1, (cy_l + h_l / 2 - padY) / ratio / imageData.height));
    const w = x2 - x1, h = y2 - y1;
    if (w < 0.005 || h < 0.005) continue;

    candidates.push({ bbox: [x1, y1, x2, y2], class: CLASS_NAMES[bestClass] || `c${bestClass}`, classId: bestClass, confidence: bestScore, cx: (x1 + x2) / 2, cy: (y1 + y2) / 2, width: w, height: h });
  }

  const result = nms(candidates, IOU_THRESHOLD);
  console.log(`[ONNX] Inference: ${(performance.now() - t0).toFixed(1)}ms, raw=${numAnchors} anchors, candidates=${candidates.length}, after NMS=${result.length}`);
  return result;
}

export function toPixelDetections(dets: Detection[], frameW: number, frameH: number) {
  return dets.map(d => ({ class: d.class, cx: d.cx * frameW, cy: d.cy * frameH, w: d.width * frameW, h: d.height * frameH, confidence: d.confidence }));
}

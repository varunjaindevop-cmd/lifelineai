/**
 * COCO-SSD Fallback Detection Engine
 * Uses TensorFlow.js COCO-SSD when ONNX model is unavailable.
 * Maps COCO classes to our unified class set.
 */

import * as cocoSsd from "@tensorflow-models/coco-ssd";
import * as tf from "@tensorflow/tfjs";

export interface Detection {
  bbox: [number, number, number, number]; // [x1, y1, x2, y2] normalized 0-1
  class: string;
  classId: number;
  confidence: number;
  cx: number;
  cy: number;
  width: number;
  height: number;
}

// Map COCO classes to our unified class names
const COCO_TO_SAGE: Record<string, string> = {
  "person": "person",
  "car": "car",
  "truck": "truck",
  "bus": "bus",
  "motorcycle": "motorcycle",
  "bicycle": "bicycle",
};

// COCO class IDs we care about
const RELEVANT_CLASSES = new Set(["person", "car", "truck", "bus", "motorcycle", "bicycle"]);

let model: cocoSsd.ObjectDetection | null = null;
let loading = false;

export async function loadCocoModel(): Promise<void> {
  if (model || loading) return;
  loading = true;

  console.log("[COCO-SSD] Loading model...");
  const t0 = performance.now();

  try {
    await tf.ready();
    model = await cocoSsd.load({ base: "lite_mobilenet_v2" });
    const elapsed = (performance.now() - t0).toFixed(0);
    console.log(`[COCO-SSD] Model loaded in ${elapsed}ms`);
  } catch (err: any) {
    console.error("[COCO-SSD] Failed to load:", err.message);
    model = null;
    throw err;
  } finally {
    loading = false;
  }
}

export function isCocoReady(): boolean {
  return model !== null;
}

export async function detectWithCoco(imageData: ImageData): Promise<Detection[]> {
  if (!model) throw new Error("COCO-SSD model not loaded");

  const t0 = performance.now();

  // Create canvas from ImageData for COCO-SSD input
  const canvas = new OffscreenCanvas(imageData.width, imageData.height);
  const ctx = canvas.getContext("2d")!;
  ctx.putImageData(imageData, 0, 0);

  // COCO-SSD expects an image element, canvas, or video
  // We'll use the canvas as input
  const bitmap = await createImageBitmap(canvas);

  const predictions = await model.detect(bitmap as any);
  bitmap.close();

  const results: Detection[] = [];

  for (const pred of predictions) {
    const sageClass = COCO_TO_SAGE[pred.class];
    if (!sageClass || !RELEVANT_CLASSES.has(pred.class)) continue;
    if (pred.score < 0.3) continue; // minimum confidence

    // pred.bbox is [x, y, width, height] in pixels
    const [bx, by, bw, bh] = pred.bbox;
    const x1 = bx / imageData.width;
    const y1 = by / imageData.height;
    const x2 = (bx + bw) / imageData.width;
    const y2 = (by + bh) / imageData.height;

    results.push({
      bbox: [Math.max(0, x1), Math.max(0, y1), Math.min(1, x2), Math.min(1, y2)],
      class: sageClass,
      classId: Object.keys(COCO_TO_SAGE).indexOf(pred.class),
      confidence: pred.score,
      cx: (x1 + x2) / 2,
      cy: (y1 + y2) / 2,
      width: x2 - x1,
      height: y2 - y1,
    });
  }

  const elapsed = (performance.now() - t0).toFixed(1);
  console.log(`[COCO-SSD] Inference: ${elapsed}ms, detections=${results.length}`);

  return results;
}

export function toPixelDetections(
  dets: Detection[],
  frameW: number,
  frameH: number
) {
  return dets.map((d) => ({
    class: d.class,
    cx: d.cx * frameW,
    cy: d.cy * frameH,
    w: d.width * frameW,
    h: d.height * frameH,
    confidence: d.confidence,
  }));
}

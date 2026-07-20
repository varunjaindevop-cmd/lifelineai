// Detection engine using TensorFlow.js COCO-SSD
// Provides a clean interface for object detection

export interface Detection {
  class: string;
  confidence: number;
  bbox: [number, number, number, number]; // [x, y, w, h]
  cx: number;
  cy: number;
  width: number;
  height: number;
}

// Class name mapping from COCO to our unified format
const COCO_MAP: Record<string, string> = {
  car: "car", truck: "car", bus: "car",
  motorcycle: "motorcycle", motorbike: "motorcycle", bicycle: "motorcycle",
  person: "person",
};

let model: any = null;
let tfReady = false;

/**
 * Load COCO-SSD model via TensorFlow.js
 */
export async function initDetection(): Promise<void> {
  if (model) return;

  const [tf, cocoSsd] = await Promise.all([
    import("@tensorflow/tfjs"),
    import("@tensorflow-models/coco-ssd"),
  ]);
  await tf.ready();
  tfReady = true;
  model = await cocoSsd.load({ base: "lite_mobilenet_v2" });
}

/**
 * Run detection on a video element
 */
export async function detectObjects(
  source: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement
): Promise<Detection[]> {
  if (!model) throw new Error("Model not initialized. Call initDetection() first.");

  const preds = await model.detect(source);
  const filtered = preds
    .filter((p: any) => p.class in COCO_MAP && p.score > 0.25)
    .map((p: any) => {
      const [x, y, w, h] = p.bbox;
      return {
        class: COCO_MAP[p.class],
        confidence: p.score,
        bbox: [x, y, w, h] as [number, number, number, number],
        cx: x + w / 2,
        cy: y + h / 2,
        width: w,
        height: h,
      };
    });

  return mergeDetections(filtered);
}

/**
 * Merge duplicate detections of same class
 */
function mergeDetections(detections: Detection[]): Detection[] {
  const merged: Detection[] = [];
  const used = new Set<number>();

  for (let i = 0; i < detections.length; i++) {
    if (used.has(i)) continue;
    let best = detections[i];

    for (let j = i + 1; j < detections.length; j++) {
      if (used.has(j)) continue;
      if (detections[i].class !== detections[j].class) continue;

      const dist = Math.sqrt(
        (best.cx - detections[j].cx) ** 2 + (best.cy - detections[j].cy) ** 2
      );
      const avgSize = (best.width + best.height + detections[j].width + detections[j].height) / 4;

      if (dist < avgSize * 0.5) {
        if (detections[j].confidence > best.confidence) best = detections[j];
        used.add(j);
      }
    }
    merged.push(best);
  }
  return merged;
}

export function isDetectionReady(): boolean {
  return tfReady && model !== null;
}

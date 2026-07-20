// YOLOv8n post-processing utilities
// Letterbox resize, NMS, output tensor processing

export interface YOLODetection {
  classId: number;
  className: string;
  confidence: number;
  bbox: [number, number, number, number]; // [x1, y1, x2, y2] in original image coords
  cx: number;
  cy: number;
  width: number;
  height: number;
}

// COCO class mapping for YOLOv8n
const YOLO_CLASSES: Record<number, string> = {
  0: "person",
  1: "bicycle",
  2: "car",
  3: "motorcycle",
  5: "bus",
  7: "truck",
};

// Our unified class mapping
const UNIFIED_MAP: Record<string, string> = {
  car: "car",
  truck: "car",
  bus: "car",
  motorcycle: "motorcycle",
  bicycle: "motorcycle",
  person: "person",
};

/**
 * Letterbox resize image to target size with padding
 */
export function letterbox(
  sourceWidth: number,
  sourceHeight: number,
  targetSize: number = 640
): { scale: number; padX: number; padY: number; newWidth: number; newHeight: number } {
  const scale = Math.min(targetSize / sourceWidth, targetSize / sourceHeight);
  const newWidth = Math.round(sourceWidth * scale);
  const newHeight = Math.round(sourceHeight * scale);
  const padX = (targetSize - newWidth) / 2;
  const padY = (targetSize - newHeight) / 2;

  return { scale, padX, padY, newWidth, newHeight };
}

/**
 * Convert YOLO output tensor [1, 84, 8400] to detection array
 * YOLOv8 output format: [batch, 4+num_classes, num_detections]
 * First 4 values: cx, cy, w, h (normalized 0-1)
 * Remaining values: class probabilities
 */
export function processYOLOOutput(
  outputData: Float32Array,
  sourceWidth: number,
  sourceHeight: number,
  confidenceThreshold: number = 0.25,
  numClasses: number = 80
): YOLODetection[] {
  const detections: YOLODetection[] = [];

  // YOLOv8 output shape: [1, 84, 8400] -> transposed to [8400, 84]
  const numDetections = 8400;
  const stride = 4 + numClasses; // 84 for COCO

  // Letterbox params to map back to original coordinates
  const lb = letterbox(sourceWidth, sourceHeight);

  for (let i = 0; i < numDetections; i++) {
    // Get class scores (skip first 4 bbox values)
    let maxScore = 0;
    let maxClassId = -1;

    for (let c = 0; c < numClasses; c++) {
      const score = outputData[i * stride + 4 + c];
      if (score > maxScore) {
        maxScore = score;
        maxClassId = c;
      }
    }

    if (maxScore < confidenceThreshold) continue;
    if (!(maxClassId in YOLO_CLASSES)) continue;

    // Get bbox (center format)
    const cx_norm = outputData[i * stride + 0];
    const cy_norm = outputData[i * stride + 1];
    const w_norm = outputData[i * stride + 2];
    const h_norm = outputData[i * stride + 3];

    // Convert from normalized letterbox coords to original image coords
    const cx_lb = cx_norm * 640;
    const cy_lb = cy_norm * 640;
    const w_lb = w_norm * 640;
    const h_lb = h_norm * 640;

    // Remove letterbox padding
    const cx_img = (cx_lb - lb.padX) / lb.scale;
    const cy_img = (cy_lb - lb.padY) / lb.scale;
    const w_img = w_lb / lb.scale;
    const h_img = h_lb / lb.scale;

    // Clip to image bounds
    const x1 = Math.max(0, cx_img - w_img / 2);
    const y1 = Math.max(0, cy_img - h_img / 2);
    const x2 = Math.min(sourceWidth, cx_img + w_img / 2);
    const y2 = Math.min(sourceHeight, cy_img + h_img / 2);

    const finalW = x2 - x1;
    const finalH = y2 - y1;

    if (finalW < 5 || finalH < 5) continue; // Skip tiny detections

    const className = YOLO_CLASSES[maxClassId];
    const unifiedClass = UNIFIED_MAP[className] || className;

    detections.push({
      classId: maxClassId,
      className: unifiedClass,
      confidence: maxScore,
      bbox: [x1, y1, x2, y2],
      cx: cx_img,
      cy: cy_img,
      width: finalW,
      height: finalH,
    });
  }

  return detections;
}

/**
 * Non-Maximum Suppression
 * Removes overlapping boxes of the same class
 */
export function nms(
  detections: YOLODetection[],
  iouThreshold: number = 0.45
): YOLODetection[] {
  if (detections.length === 0) return [];

  // Sort by confidence descending
  const sorted = [...detections].sort((a, b) => b.confidence - a.confidence);

  const kept: YOLODetection[] = [];
  const suppressed = new Set<number>();

  for (let i = 0; i < sorted.length; i++) {
    if (suppressed.has(i)) continue;

    kept.push(sorted[i]);

    for (let j = i + 1; j < sorted.length; j++) {
      if (suppressed.has(j)) continue;
      if (sorted[i].classId !== sorted[j].classId) continue;

      const iou = calculateIoU(sorted[i].bbox, sorted[j].bbox);
      if (iou > iouThreshold) {
        suppressed.add(j);
      }
    }
  }

  return kept;
}

/**
 * Calculate IoU between two bounding boxes [x1, y1, x2, y2]
 */
function calculateIoU(
  box1: [number, number, number, number],
  box2: [number, number, number, number]
): number {
  const [x1, y1, x2, y2] = box1;
  const [x3, y3, x4, y4] = box2;

  const intersectX1 = Math.max(x1, x3);
  const intersectY1 = Math.max(y1, y3);
  const intersectX2 = Math.min(x2, x4);
  const intersectY2 = Math.min(y2, y4);

  const intersectArea = Math.max(0, intersectX2 - intersectX1) * Math.max(0, intersectY2 - intersectY1);
  const box1Area = (x2 - x1) * (y2 - y1);
  const box2Area = (x4 - x3) * (y4 - y3);
  const unionArea = box1Area + box2Area - intersectArea;

  return unionArea > 0 ? intersectArea / unionArea : 0;
}

/**
 * Merge duplicate detections of same class that are close together
 */
export function mergeDetections(
  detections: YOLODetection[],
  mergeDistanceFactor: number = 0.5
): YOLODetection[] {
  const merged: YOLODetection[] = [];
  const used = new Set<number>();

  for (let i = 0; i < detections.length; i++) {
    if (used.has(i)) continue;

    let best = detections[i];

    for (let j = i + 1; j < detections.length; j++) {
      if (used.has(j)) continue;
      if (detections[i].className !== detections[j].className) continue;

      const dist = Math.sqrt(
        (best.cx - detections[j].cx) ** 2 +
        (best.cy - detections[j].cy) ** 2
      );
      const avgSize = (best.width + best.height + detections[j].width + detections[j].height) / 4;

      if (dist < avgSize * mergeDistanceFactor) {
        if (detections[j].confidence > best.confidence) {
          best = detections[j];
        }
        used.add(j);
      }
    }

    merged.push(best);
  }

  return merged;
}

/**
 * Full post-processing pipeline: raw tensor -> clean detections
 */
export function postprocess(
  outputData: Float32Array,
  sourceWidth: number,
  sourceHeight: number,
  options: {
    confidenceThreshold?: number;
    nmsThreshold?: number;
    mergeDistance?: number;
  } = {}
): YOLODetection[] {
  const {
    confidenceThreshold = 0.25,
    nmsThreshold = 0.45,
    mergeDistance = 0.5,
  } = options;

  // Step 1: Process raw tensor
  const raw = processYOLOOutput(outputData, sourceWidth, sourceHeight, confidenceThreshold);

  // Step 2: NMS to remove overlapping boxes
  const nmsed = nms(raw, nmsThreshold);

  // Step 3: Merge duplicate detections
  const merged = mergeDetections(nmsed, mergeDistance);

  return merged;
}

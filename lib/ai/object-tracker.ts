import { Detection, TrackedObject } from "./types";

let nextObjectId = 1;

// IoU (Intersection over Union) calculation
export function calculateIoU(
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

// Calculate distance between two points
function distance(
  p1: { x: number; y: number },
  p2: { x: number; y: number }
): number {
  return Math.sqrt(Math.pow(p2.x - p1.x, 2) + Math.pow(p2.y - p1.y, 2));
}

// Match detections to existing tracked objects
export function trackObjects(
  detections: Detection[],
  trackedObjects: TrackedObject[],
  iouThreshold: number = 0.3
): { tracked: TrackedObject[]; unmatched: Detection[] } {
  const matched = new Set<number>();
  const unmatchedDetections: Detection[] = [];

  // Try to match each detection to an existing object
  for (const detection of detections) {
    let bestMatch: TrackedObject | null = null;
    let bestIoU = iouThreshold;

    for (const obj of trackedObjects) {
      const lastDetection = obj.detections[obj.detections.length - 1];
      const iou = calculateIoU(detection.bbox, lastDetection.bbox);

      if (iou > bestIoU) {
        bestIoU = iou;
        bestMatch = obj;
      }
    }

    if (bestMatch) {
      // Update existing object
      const prevPos = bestMatch.currentPosition;
      const newPos = {
        x: detection.centerX,
        y: detection.centerY,
      };

      // Calculate velocity
      const vx = newPos.x - prevPos.x;
      const vy = newPos.y - prevPos.y;

      bestMatch.detections.push(detection);
      bestMatch.currentPosition = newPos;
      bestMatch.velocity = { vx, vy };
      bestMatch.trajectory.push(newPos);
      bestMatch.lastSeen = Date.now();

      // Keep trajectory limited
      if (bestMatch.trajectory.length > 30) {
        bestMatch.trajectory.shift();
      }

      matched.add(detections.indexOf(detection));
    } else {
      unmatchedDetections.push(detection);
    }
  }

  // Remove objects not seen for a while
  const activeObjects = trackedObjects.filter(
    (obj) => Date.now() - obj.lastSeen < 2000
  );

  return { tracked: activeObjects, unmatched: unmatchedDetections };
}

// Create new tracked objects from unmatched detections
export function createNewObjects(
  unmatched: Detection[],
  existing: TrackedObject[]
): TrackedObject[] {
  const newObjects: TrackedObject[] = [];

  for (const detection of unmatched) {
    const newObj: TrackedObject = {
      id: nextObjectId++,
      class: detection.class,
      detections: [detection],
      currentPosition: {
        x: detection.centerX,
        y: detection.centerY,
      },
      velocity: { vx: 0, vy: 0 },
      speed: 0,
      trajectory: [{ x: detection.centerX, y: detection.centerY }],
      lastSeen: Date.now(),
    };
    newObjects.push(newObj);
  }

  return [...existing, ...newObjects];
}

// Calculate speed from trajectory (pixels per frame to km/h)
export function calculateSpeed(
  obj: TrackedObject,
  pixelsPerMeter: number,
  fps: number
): number {
  if (obj.trajectory.length < 2) return 0;

  const lastTwo = obj.trajectory.slice(-2);
  const pixelDistance = distance(lastTwo[0], lastTwo[1]);
  const metersPerFrame = pixelDistance / pixelsPerMeter;
  const metersPerSecond = metersPerFrame * fps;
  return Math.round(metersPerSecond * 3.6);
}

/**
 * Simple IOU-based multi-object tracker.
 * Assigns consistent IDs across frames using IoU matching.
 */

export interface TrackedObject {
  id: number;
  bbox: [number, number, number, number]; // [x1, y1, x2, y2] normalized 0-1
  class: string;
  confidence: number;
  lastSeen: number;
  age: number;
  positions: { x: number; y: number }[];
  speed: number;
}

function calcIoU(
  a: [number, number, number, number],
  b: [number, number, number, number]
): number {
  const ix1 = Math.max(a[0], b[0]);
  const iy1 = Math.max(a[1], b[1]);
  const ix2 = Math.min(a[2], b[2]);
  const iy2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
  const areaA = (a[2] - a[0]) * (a[3] - a[1]);
  const areaB = (b[2] - b[0]) * (b[3] - b[1]);
  return inter / (areaA + areaB - inter + 1e-6);
}

export class SimpleTracker {
  private tracks: Map<number, TrackedObject> = new Map();
  private nextId = 1;
  private maxAge: number;
  private iouThreshold: number;

  constructor(opts: { maxAge?: number; iouThreshold?: number } = {}) {
    this.maxAge = opts.maxAge ?? 10;
    this.iouThreshold = opts.iouThreshold ?? 0.3;
  }

  update(
    detections: { bbox: [number, number, number, number]; class: string; confidence: number }[],
    frame: number
  ): TrackedObject[] {
    const matchedTrackIds = new Set<number>();
    const matchedDetIndices = new Set<number>();

    // Match existing tracks to new detections by class + IoU
    for (const [trackId, track] of Array.from(this.tracks.entries())) {
      let bestDetIdx = -1;
      let bestIoU = this.iouThreshold;

      for (let i = 0; i < detections.length; i++) {
        if (matchedDetIndices.has(i)) continue;
        if (detections[i].class !== track.class) continue;
        const iou = calcIoU(track.bbox, detections[i].bbox);
        if (iou > bestIoU) {
          bestIoU = iou;
          bestDetIdx = i;
        }
      }

      if (bestDetIdx >= 0) {
        const det = detections[bestDetIdx];
        const cx = (det.bbox[0] + det.bbox[2]) / 2;
        const cy = (det.bbox[1] + det.bbox[3]) / 2;
        track.bbox = det.bbox;
        track.confidence = det.confidence;
        track.lastSeen = frame;
        track.age++;
        track.positions.push({ x: cx, y: cy });
        if (track.positions.length > 30) track.positions.shift();

        if (track.positions.length >= 2) {
          const last = track.positions[track.positions.length - 1];
          const prev = track.positions[track.positions.length - 2];
          track.speed = Math.sqrt((last.x - prev.x) ** 2 + (last.y - prev.y) ** 2);
        }

        matchedTrackIds.add(trackId);
        matchedDetIndices.add(bestDetIdx);
      }
    }

    // Create new tracks for unmatched detections
    for (let i = 0; i < detections.length; i++) {
      if (matchedDetIndices.has(i)) continue;
      const det = detections[i];
      const cx = (det.bbox[0] + det.bbox[2]) / 2;
      const cy = (det.bbox[1] + det.bbox[3]) / 2;
      const id = this.nextId++;
      this.tracks.set(id, {
        id,
        bbox: det.bbox,
        class: det.class,
        confidence: det.confidence,
        lastSeen: frame,
        age: 1,
        positions: [{ x: cx, y: cy }],
        speed: 0,
      });
    }

    // Remove stale tracks
    for (const [id, track] of Array.from(this.tracks.entries())) {
      if (frame - track.lastSeen > this.maxAge) {
        this.tracks.delete(id);
      }
    }

    return Array.from(this.tracks.values());
  }

  reset(): void {
    this.tracks.clear();
    this.nextId = 1;
  }
}

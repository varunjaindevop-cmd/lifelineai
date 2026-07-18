// Vehicle speed estimation via perspective transform
import { TrackedObject } from "../ai/types";

interface CalibrationData {
  referencePoints: [[number, number], [number, number]];
  realDistanceMeters: number;
}

// Calculate pixels per meter from calibration
export function calculatePixelsPerMeter(
  calibration: CalibrationData
): number {
  const [[x1, y1], [x2, y2]] = calibration.referencePoints;
  const pixelDistance = Math.sqrt(
    Math.pow(x2 - x1, 2) + Math.pow(y2 - y1, 2)
  );
  return pixelDistance / calibration.realDistanceMeters;
}

// Calculate speed for a tracked object
export function calculateVehicleSpeed(
  obj: TrackedObject,
  pixelsPerMeter: number,
  fps: number
): number {
  if (obj.trajectory.length < 2) return 0;

  const lastTwo = obj.trajectory.slice(-2);
  const dx = lastTwo[1].x - lastTwo[0].x;
  const dy = lastTwo[1].y - lastTwo[0].y;
  const pixelDistance = Math.sqrt(dx * dx + dy * dy);

  const metersPerFrame = pixelDistance / pixelsPerMeter;
  const metersPerSecond = metersPerFrame * fps;
  const kmh = Math.round(metersPerSecond * 3.6);

  return kmh;
}

// Apply perspective transform (simplified)
export function perspectiveTransform(
  point: [number, number],
  srcPoints: [number, number][],
  dstPoints: [number, number][]
): [number, number] {
  // Simplified homography - in production use a proper matrix library
  const [x, y] = point;

  // Calculate affine approximation
  const dx = dstPoints[1][0] - dstPoints[0][0];
  const dy = dstPoints[1][1] - dstPoints[0][1];
  const sx = srcPoints[1][0] - srcPoints[0][0];
  const sy = srcPoints[1][1] - srcPoints[0][1];

  const scale = Math.sqrt((dx * dx + dy * dy) / (sx * sx + sy * sy));
  const angle = Math.atan2(dy, dx) - Math.atan2(sy, sx);

  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  const rx = x - srcPoints[0][0];
  const ry = y - srcPoints[0][1];

  const tx = rx * cos * scale - ry * sin * scale + dstPoints[0][0];
  const ty = rx * sin * scale + ry * cos * scale + dstPoints[0][1];

  return [tx, ty];
}

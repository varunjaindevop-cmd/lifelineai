// Vehicle speed estimation with auto-calibration
// Uses Kalman-smoothed velocities + camera calibration

import { TrackedEntity } from "./kalman-tracker";

// Auto-calibrate pixels-per-meter from video frame
// Assumes standard road lanes (~3.5m wide) and estimates road width from frame
export function autoCalibrate(
  videoWidth: number,
  videoHeight: number,
  envMode: "isolated" | "traffic" | "marketplace"
): number {
  // Default assumptions based on environment
  const assumptions = {
    isolated: { lanes: 2, laneWidth: 3.5 },
    traffic: { lanes: 3, laneWidth: 3.5 },
    marketplace: { lanes: 1, laneWidth: 3.0 },
  };

  const { lanes, laneWidth } = assumptions[envMode];
  const totalRoadWidthMeters = lanes * laneWidth;

  // Use the SMALLER dimension as reference (most CCTV cameras are landscape)
  // Road typically occupies 30-40% of the shorter dimension
  const refDimension = Math.min(videoWidth, videoHeight);
  const roadWidthFraction = 0.35;
  const roadWidthPixels = refDimension * roadWidthFraction;

  const ppm = roadWidthPixels / totalRoadWidthMeters;

  // Clamp to reasonable range (10-40 PPM for most cameras)
  return Math.max(10, Math.min(40, ppm));
}

// Convert entity speed to real km/h
// Uses actual position history for more accurate speed
export function pixelSpeedToKmh(
  entity: TrackedEntity,
  pixelsPerMeter: number,
  fps: number = 3
): number {
  // Use actual position displacement if available
  if (entity.positions.length >= 2) {
    const last = entity.positions[entity.positions.length - 1];
    const prev = entity.positions[entity.positions.length - 2];
    const dx = last.x - prev.x;
    const dy = last.y - prev.y;
    const pixelDist = Math.sqrt(dx * dx + dy * dy);

    if (pixelDist < 0.1) return 0;

    const metersPerFrame = pixelDist / pixelsPerMeter;
    const metersPerSecond = metersPerFrame * fps;
    return Math.round(metersPerSecond * 3.6);
  }

  // Fallback to Kalman velocity
  const pixelSpeed = entity.speed;
  if (pixelSpeed < 0.1) return 0;
  const metersPerFrame = pixelSpeed / pixelsPerMeter;
  const metersPerSecond = metersPerFrame * fps;
  return Math.round(metersPerSecond * 3.6);
}

// Calculate speed with smoothing and history
export function calculateRealSpeed(
  entity: TrackedEntity,
  pixelsPerMeter: number,
  fps: number = 10
): { current: number; average: number; max: number } {
  const current = pixelSpeedToKmh(entity, pixelsPerMeter, fps);
  
  const speeds = entity.speedHistory.map(s => {
    const mps = s / pixelsPerMeter * fps;
    return Math.round(mps * 3.6);
  });
  
  const average = speeds.length > 0 
    ? Math.round(speeds.reduce((a, b) => a + b, 0) / speeds.length)
    : 0;
  
  const max = speeds.length > 0
    ? Math.round(Math.max(...speeds))
    : 0;
  
  return { current, average, max };
}

// Perspective-corrected speed (accounts for camera angle)
// Objects further away appear to move slower — correct for this
export function perspectiveCorrectedSpeed(
  speed: number,
  yPosition: number,
  frameHeight: number
): number {
  // Objects lower in frame are closer (move faster in reality)
  // Objects higher in frame are further (appear slower)
  const normalizedY = yPosition / frameHeight; // 0 = top, 1 = bottom
  
  // Correction factor: 1.0 at bottom, up to 1.5 at top
  const correction = 1.0 + (1.0 - normalizedY) * 0.5;
  
  return Math.round(speed * correction);
}

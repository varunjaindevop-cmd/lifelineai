// Unified Collision Detection Engine
// Uses 5 signals: overlap, deceleration, proximity, trajectory convergence, energy transfer
// Mode-aware: isolated (easy), traffic (conservative), marketplace (pedestrian-focused)

import { TrackedEntity } from "./kalman-tracker";

export type EnvMode = "isolated" | "traffic" | "marketplace";

export interface AccidentEvidence {
  type: "collision" | "person_fall" | "bike_off_track";
  confidence: number;
  objects: number[];
  details: string;
  signals: EvidenceSignal[];
  sceneContext: EnvMode;
}

export interface EvidenceSignal {
  name: string;
  value: number;
  weight: number;
  passed: boolean;
}

// ========== HELPERS ==========

function dist(a: TrackedEntity, b: TrackedEntity): number {
  const dx = a.kalman.getState().x - b.kalman.getState().x;
  const dy = a.kalman.getState().y - b.kalman.getState().y;
  return Math.sqrt(dx * dx + dy * dy);
}

function combinedR(a: TrackedEntity, b: TrackedEntity): number {
  return (Math.sqrt(a.w * a.h) + Math.sqrt(b.w * b.h)) / 2;
}

function isOverlapping(a: TrackedEntity, b: TrackedEntity): boolean {
  return !(a.bbox[2] < b.bbox[0] || b.bbox[2] < a.bbox[0] ||
           a.bbox[3] < b.bbox[1] || b.bbox[3] < a.bbox[1]);
}

function calcIoU(a: TrackedEntity, b: TrackedEntity): number {
  const ix1 = Math.max(a.bbox[0], b.bbox[0]);
  const iy1 = Math.max(a.bbox[1], b.bbox[1]);
  const ix2 = Math.min(a.bbox[2], b.bbox[2]);
  const iy2 = Math.min(a.bbox[3], b.bbox[3]);
  const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
  const areaA = (a.bbox[2] - a.bbox[0]) * (a.bbox[3] - a.bbox[1]);
  const areaB = (b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1]);
  return inter / (areaA + areaB - inter + 1e-6);
}

function wasFast(entity: TrackedEntity): boolean {
  if (entity.speedHistory.length < 3) return false;
  return entity.speedHistory[0] > 1.5 || entity.speedHistory[1] > 1.5 || entity.speedHistory[2] > 1.5;
}

function hasDecelerated(entity: TrackedEntity): boolean {
  if (entity.speedHistory.length < 5) return false;
  // Compare recent 3 frames vs older 3 frames
  const recent = entity.speedHistory.slice(0, 3);
  const older = entity.speedHistory.slice(3, 6);
  if (older.length === 0) return false;
  const avgRecent = recent.reduce((a, b) => a + b, 0) / recent.length;
  const avgOlder = older.reduce((a, b) => a + b, 0) / older.length;
  return avgOlder > 0.5 && avgRecent < avgOlder * 0.6;
}

function angleDiff(a: number, b: number): number {
  const diff = Math.abs(a - b);
  return diff > Math.PI ? 2 * Math.PI - diff : diff;
}

function isStationary(entity: TrackedEntity): boolean {
  return entity.speed < 0.3 && entity.speedHistory.slice(0, 3).every(s => s < 0.5);
}

/**
 * Check if two objects are PASSING each other (not colliding).
 * This is the KEY false positive filter for traffic mode.
 */
function isPassing(a: TrackedEntity, b: TrackedEntity): boolean {
  // Both must be moving at reasonable speed
  if (a.speed < 0.8 || b.speed < 0.8) return false;

  const headingDiff = angleDiff(a.heading, b.heading);
  // Same direction within 45 degrees
  if (headingDiff < Math.PI * 0.25) return true;

  // Both maintaining speed (no deceleration) — they're just near each other
  if (!hasDecelerated(a) && !hasDecelerated(b)) return true;

  return false;
}

/**
 * Check if two entities were approaching each other (distance decreasing).
 */
function wasApproaching(a: TrackedEntity, b: TrackedEntity): boolean {
  if (a.positions.length < 3 || b.positions.length < 3) return false;

  const recentA = a.positions[a.positions.length - 1];
  const recentB = b.positions[b.positions.length - 1];
  const olderA = a.positions[a.positions.length - 3];
  const olderB = b.positions[b.positions.length - 3];

  const d1 = Math.sqrt((recentA.x - recentB.x) ** 2 + (recentA.y - recentB.y) ** 2);
  const d2 = Math.sqrt((olderA.x - olderB.x) ** 2 + (olderA.y - olderB.y) ** 2);

  return d2 > d1 + 0.5; // distance was decreasing
}

// ========== MODE THRESHOLDS ==========

interface ModeConfig {
  minScore: number;
  minSignals: number;
  decelerationRequired: boolean;
  bothDecelerateRequired: boolean;
  passingFilterStrict: boolean;
  confirmationFrames: number;
  cooldownMs: number;
}

const MODE_CONFIG: Record<EnvMode, ModeConfig> = {
  isolated: {
    minScore: 0.40,
    minSignals: 2,
    decelerationRequired: false,
    bothDecelerateRequired: false,
    passingFilterStrict: false,
    confirmationFrames: 3,
    cooldownMs: 3000,
  },
  traffic: {
    minScore: 0.65,
    minSignals: 3,
    decelerationRequired: true,
    bothDecelerateRequired: true,
    passingFilterStrict: true,
    confirmationFrames: 5,
    cooldownMs: 8000,
  },
  marketplace: {
    minScore: 0.55,
    minSignals: 3,
    decelerationRequired: false,
    bothDecelerateRequired: false,
    passingFilterStrict: true,
    confirmationFrames: 5,
    cooldownMs: 8000,
  },
};

// ========== SIGNAL SCORING (5 signals) ==========

/**
 * Signal 1: Overlap — IoU between bounding boxes
 * Weight: 0.30
 */
function scoreOverlap(a: TrackedEntity, b: TrackedEntity): EvidenceSignal {
  const iou = calcIoU(a, b);
  const value = Math.min(iou * 5, 1.0); // 20% IoU = full score
  return {
    name: "overlap",
    value,
    weight: 0.30,
    passed: iou > 0.05,
  };
}

/**
 * Signal 2: Deceleration — both vehicles slowing down
 * Weight: 0.25
 */
function scoreDeceleration(a: TrackedEntity, b: TrackedEntity): EvidenceSignal {
  const aDecel = hasDecelerated(a) ? 1 : 0;
  const bDecel = hasDecelerated(b) ? 1 : 0;
  const value = (aDecel + bDecel) / 2;
  return {
    name: "deceleration",
    value,
    weight: 0.25,
    passed: value > 0,
  };
}

/**
 * Signal 3: Proximity — how close the objects are
 * Weight: 0.20
 */
function scoreProximity(a: TrackedEntity, b: TrackedEntity): EvidenceSignal {
  const d = dist(a, b);
  const cr = combinedR(a, b);

  let value: number;
  if (d < cr * 0.7) value = 1.0;       // touching
  else if (d < cr * 1.2) value = 0.7;  // close
  else if (d < cr * 2.0) value = 0.3;  // approaching
  else value = 0;

  return {
    name: "proximity",
    value,
    weight: 0.20,
    passed: value > 0,
  };
}

/**
 * Signal 4: Trajectory Convergence — predicted paths intersect
 * Weight: 0.15
 */
function scoreTrajectoryConvergence(a: TrackedEntity, b: TrackedEntity): EvidenceSignal {
  if (a.positions.length < 3 || b.positions.length < 3) {
    return { name: "trajectory", value: 0, weight: 0.15, passed: false };
  }

  // Simple trajectory projection using current velocity
  const ka = a.kalman.getState();
  const kb = b.kalman.getState();
  const horizon = 10; // frames ahead

  let minDist = Infinity;
  for (let t = 1; t <= horizon; t++) {
    const px_a = ka.x + ka.vx * t;
    const py_a = ka.y + ka.vy * t;
    const px_b = kb.x + kb.vx * t;
    const py_b = kb.y + kb.vy * t;
    const d = Math.sqrt((px_a - px_b) ** 2 + (py_a - py_b) ** 2);
    if (d < minDist) minDist = d;
  }

  const cr = combinedR(a, b);
  let value: number;
  if (minDist < cr * 0.5) value = 1.0;
  else if (minDist < cr * 1.0) value = 0.7;
  else if (minDist < cr * 2.0) value = 0.3;
  else value = 0;

  return {
    name: "trajectory",
    value,
    weight: 0.15,
    passed: value > 0.3,
  };
}

/**
 * Signal 5: Energy Transfer — one vehicle lost kinetic energy near another
 * Weight: 0.10
 */
function scoreEnergyTransfer(a: TrackedEntity, b: TrackedEntity): EvidenceSignal {
  const MASS: Record<string, number> = { car: 1.5, truck: 3.0, bus: 4.0, motorcycle: 0.3, person: 0.08 };

  const massA = MASS[a.class] || 1.0;
  const massB = MASS[b.class] || 1.0;

  const keA_now = 0.5 * massA * a.speed * a.speed;
  const keB_now = 0.5 * massB * b.speed * b.speed;

  const oldSpeedA = a.speedHistory.length > 2 ? a.speedHistory[Math.min(2, a.speedHistory.length - 1)] : a.speed;
  const oldSpeedB = b.speedHistory.length > 2 ? b.speedHistory[Math.min(2, b.speedHistory.length - 1)] : b.speed;

  const keA_prev = 0.5 * massA * oldSpeedA * oldSpeedA;
  const keB_prev = 0.5 * massB * oldSpeedB * oldSpeedB;

  const lossA = keA_prev - keA_now;
  const lossB = keB_prev - keB_now;

  // At least one entity lost significant energy
  const significantLoss = (lossA > 0.5 && a.speed < oldSpeedA * 0.3) ||
                          (lossB > 0.5 && b.speed < oldSpeedB * 0.3);

  const value = significantLoss ? Math.min(1.0, Math.max(lossA, lossB) / 3) : 0;

  return {
    name: "energy_transfer",
    value,
    weight: 0.10,
    passed: significantLoss,
  };
}

// ========== COLLISION DETECTION ==========

function detectVehicleCollision(
  entities: TrackedEntity[],
  envMode: EnvMode
): AccidentEvidence[] {
  const evidence: AccidentEvidence[] = [];
  const config = MODE_CONFIG[envMode];
  const candidates = entities.filter(e => e.age >= 3 && ["car", "truck", "bus", "motorcycle"].includes(e.class));

  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i];
      const b = candidates[j];

      // STRICT PASSING FILTER: if both are passing, skip entirely
      if (config.passingFilterStrict && isPassing(a, b)) continue;

      // BASIC PASSING FILTER (isolated mode): same direction + no decel = skip
      if (!config.passingFilterStrict && isPassing(a, b)) continue;

      // Must be close enough
      const d = dist(a, b);
      const cr = combinedR(a, b);
      if (d > cr * 3.0) continue;

      // Calculate all 5 signals
      const overlap = scoreOverlap(a, b);
      const deceleration = scoreDeceleration(a, b);
      const proximity = scoreProximity(a, b);
      const trajectory = scoreTrajectoryConvergence(a, b);
      const energy = scoreEnergyTransfer(a, b);

      const signals = [overlap, deceleration, proximity, trajectory, energy];

      // Weighted confidence
      let confidence = signals.reduce((sum, s) => sum + s.value * s.weight, 0);

      // Traffic mode: BOTH must decelerate
      if (config.bothDecelerateRequired && !hasDecelerated(a) && !hasDecelerated(b)) {
        confidence *= 0.3; // heavy penalty
      }

      // Traffic mode: require approaching history
      if (envMode === "traffic" && !wasApproaching(a, b)) {
        confidence *= 0.4;
      }

      const passedSignals = signals.filter(s => s.passed).length;

      // Apply mode-specific thresholds
      if (confidence >= config.minScore && passedSignals >= config.minSignals) {
        // Mode multiplier
        const modeMultiplier = envMode === "isolated" ? 1.0 : envMode === "traffic" ? 0.85 : 0.9;
        confidence = Math.min(0.95, confidence * modeMultiplier);

        evidence.push({
          type: "collision",
          confidence,
          objects: [a.id, b.id],
          details: `${envMode}: signals=${passedSignals}/5 d=${d.toFixed(0)}px`,
          signals,
          sceneContext: envMode,
        });
      }
    }
  }

  return evidence;
}

// ========== PERSON FALL ==========

function detectPersonFall(entities: TrackedEntity[]): AccidentEvidence[] {
  const evidence: AccidentEvidence[] = [];
  for (const entity of entities) {
    if (entity.class !== "person" || entity.age < 4) continue;
    if (entity.aspectHistory.length < 4) continue;

    const currentAR = entity.aspectHistory[entity.aspectHistory.length - 1];
    const prevAR = (entity.aspectHistory[0] + entity.aspectHistory[1]) / 2;
    const wasStanding = prevAR < 0.8;
    const nowLying = currentAR > 0.9;

    if (wasStanding && nowLying) {
      const lastY = entity.positions[entity.positions.length - 1]?.y || 0;
      const prevY = entity.positions.length >= 3 ? entity.positions[entity.positions.length - 3].y : lastY;
      const dropped = lastY > prevY + 3;
      const wasMoving = wasFast(entity);
      const stationary = isStationary(entity);

      let confidence = 0.7;
      if (dropped) confidence += 0.1;
      if (wasMoving && stationary) confidence += 0.1;

      const signals: EvidenceSignal[] = [
        { name: "aspect_ratio", value: currentAR, weight: 0.4, passed: nowLying },
        { name: "position_drop", value: dropped ? 1 : 0, weight: 0.3, passed: dropped },
        { name: "was_moving", value: wasMoving ? 1 : 0, weight: 0.2, passed: wasMoving && stationary },
        { name: "sustained", value: entity.confirmedFrames >= 3 ? 1 : 0, weight: 0.1, passed: entity.confirmedFrames >= 3 },
      ];

      evidence.push({
        type: "person_fall",
        confidence: Math.min(0.9, confidence),
        objects: [entity.id],
        details: `Fall: AR ${prevAR.toFixed(2)}->${currentAR.toFixed(2)}`,
        signals,
        sceneContext: "isolated",
      });
    }
  }
  return evidence;
}

// ========== BIKE OFF-TRACK ==========

function detectBikeOffTrack(entities: TrackedEntity[]): AccidentEvidence[] {
  const evidence: AccidentEvidence[] = [];
  for (const entity of entities) {
    if (entity.class !== "motorcycle" || entity.age < 4) continue;
    if (entity.headingHistory.length < 4) continue;

    const recentH = entity.headingHistory[entity.headingHistory.length - 1];
    const prevH = entity.headingHistory[entity.headingHistory.length - 3];
    let headingChange = Math.abs(recentH - prevH);
    if (headingChange > Math.PI) headingChange = 2 * Math.PI - headingChange;

    const wasMoving = wasFast(entity);
    const significantChange = headingChange > Math.PI * 0.3;

    if (wasMoving && significantChange) {
      const signals: EvidenceSignal[] = [
        { name: "heading_change", value: headingChange / Math.PI, weight: 0.5, passed: significantChange },
        { name: "was_fast", value: 1, weight: 0.5, passed: wasMoving },
      ];

      evidence.push({
        type: "bike_off_track",
        confidence: 0.7,
        objects: [entity.id],
        details: `Bike heading ${(headingChange * 180 / Math.PI).toFixed(0)} deg`,
        signals,
        sceneContext: "isolated",
      });
    }
  }
  return evidence;
}

// ========== MAIN EXPORT ==========

export function detectAccidents(
  entities: TrackedEntity[],
  envMode: EnvMode
): AccidentEvidence[] {
  let evidence: AccidentEvidence[] = [];

  // Vehicle collisions (mode-aware)
  evidence.push(...detectVehicleCollision(entities, envMode));

  // Person falls (always active)
  evidence.push(...detectPersonFall(entities));

  // Bike off-track (always active)
  evidence.push(...detectBikeOffTrack(entities));

  // Deduplicate: keep highest confidence per object pair
  const deduped: AccidentEvidence[] = [];
  const seen = new Map<string, AccidentEvidence>();

  evidence.sort((a, b) => b.confidence - a.confidence);
  for (const ev of evidence) {
    const key = `${ev.type}:${[...ev.objects].sort().join(",")}`;
    if (!seen.has(key)) {
      seen.set(key, ev);
      deduped.push(ev);
    }
  }

  return deduped;
}

export function getModeConfig(mode: EnvMode): ModeConfig {
  return MODE_CONFIG[mode];
}

export { isPassing, hasDecelerated, wasApproaching, dist, combinedR, calcIoU };

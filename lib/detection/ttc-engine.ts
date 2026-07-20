// Unified Collision Detection Engine v3
// Traffic mode: only actual crashes and bike/vehicle drops. Cars following = normal.
// Isolated mode: sensitive to any collision. Marketplace: pedestrian-focused.

import { TrackedEntity } from "./kalman-tracker";

export type EnvMode = "isolated" | "traffic" | "marketplace";

export interface AccidentEvidence {
  type: "collision" | "person_fall" | "bike_off_track" | "vehicle_fall";
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

function hasDecelerated(entity: TrackedEntity): boolean {
  if (entity.speedHistory.length < 3) return false;
  const recent = entity.speedHistory.slice(0, 2);
  const older = entity.speedHistory.slice(2, Math.min(5, entity.speedHistory.length));
  if (older.length === 0) return false;
  const avgRecent = recent.reduce((a, b) => a + b, 0) / recent.length;
  const avgOlder = older.reduce((a, b) => a + b, 0) / older.length;
  return avgOlder > 0.3 && avgRecent < avgOlder * 0.65;
}

function wasFast(entity: TrackedEntity): boolean {
  if (entity.speedHistory.length < 2) return false;
  return entity.speedHistory[0] > 1.0 || entity.speedHistory[1] > 1.0;
}

function angleDiff(a: number, b: number): number {
  const diff = Math.abs(a - b);
  return diff > Math.PI ? 2 * Math.PI - diff : diff;
}

function isStationary(entity: TrackedEntity): boolean {
  return entity.speed < 0.3 && entity.speedHistory.slice(0, 3).every(s => s < 0.5);
}

function isPassing(a: TrackedEntity, b: TrackedEntity): boolean {
  if (a.speed < 0.6 || b.speed < 0.6) return false;
  const headingDiff = angleDiff(a.heading, b.heading);
  if (headingDiff < Math.PI * 0.25) return true;
  if (!hasDecelerated(a) && !hasDecelerated(b)) return true;
  return false;
}

/**
 * Detect if a vehicle has suddenly changed aspect ratio (fell over).
 * A motorcycle/car that was upright and is now wide = fell/rolled.
 */
function detectVehicleFall(entity: TrackedEntity): AccidentEvidence | null {
  if (entity.age < 4) return null;
  if (entity.aspectHistory.length < 4) return null;

  const currentAR = entity.aspectHistory[entity.aspectHistory.length - 1];
  const prevAR = (entity.aspectHistory[0] + entity.aspectHistory[1]) / 2;

  // Vehicle was taller than wide (AR < 0.8), now wider than tall (AR > 1.2)
  const wasUpright = prevAR < 0.8;
  const nowFallen = currentAR > 1.2;
  const significantChange = currentAR > prevAR * 1.5;

  if ((wasUpright && nowFallen) || significantChange) {
    const wasMoving = wasFast(entity);
    const stationary = isStationary(entity);

    let confidence = 0.6;
    if (wasMoving && stationary) confidence += 0.15;
    if (significantChange) confidence += 0.1;

    const signals: EvidenceSignal[] = [
      { name: "aspect_flip", value: significantChange ? 1 : 0, weight: 0.4, passed: significantChange },
      { name: "was_moving", value: wasMoving ? 1 : 0, weight: 0.3, passed: wasMoving },
      { name: "now_stationary", value: stationary ? 1 : 0, weight: 0.3, passed: stationary },
    ];

    return {
      type: "vehicle_fall",
      confidence: Math.min(0.9, confidence),
      objects: [entity.id],
      details: `${entity.class} AR ${prevAR.toFixed(2)}->${currentAR.toFixed(2)}${wasMoving ? " was_moving" : ""}`,
      signals,
      sceneContext: "traffic",
    };
  }

  return null;
}

// ========== COLLISION DETECTION ==========

function detectVehicleCollision(entities: TrackedEntity[], envMode: EnvMode): AccidentEvidence[] {
  const evidence: AccidentEvidence[] = [];
  const candidates = entities.filter(e => e.age >= 2 && ["car", "truck", "bus", "motorcycle"].includes(e.class));

  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i];
      const b = candidates[j];

      const d = dist(a, b);
      const cr = combinedR(a, b);
      const iou = calcIoU(a, b);

      if (envMode === "traffic") {
        // ===== TRAFFIC MODE: ONLY actual crashes =====
        // Rule 1: Must have REAL overlap (IoU > 0.15) — not just proximity
        if (iou < 0.15) continue;

        // Rule 2: BOTH must have decelerated
        if (!hasDecelerated(a) || !hasDecelerated(b)) continue;

        // Rule 3: Must be very close (within touching distance)
        if (d > cr * 1.5) continue;

        // Rule 4: Passing filter — same direction + fast = not a crash
        if (isPassing(a, b)) continue;

        // If we get here, it's a real crash: overlap + both decelerated + close
        const confidence = Math.min(0.95,
          0.4 * Math.min(iou * 3, 1) +  // overlap signal
          0.3 * 1.0 +                      // both decelerated (guaranteed)
          0.3 * (d < cr * 0.8 ? 1 : 0.5)  // proximity bonus
        );

        console.log(`[TTC] TRAFFIC CRASH: ${a.class}#${a.id} + ${b.class}#${b.id} iou=${iou.toFixed(3)} d=${d.toFixed(0)}px both_decel=yes`);

        evidence.push({
          type: "collision",
          confidence,
          objects: [a.id, b.id],
          details: `Traffic crash: iou=${iou.toFixed(3)} d=${d.toFixed(0)}px both decelerated`,
          signals: [
            { name: "overlap", value: iou, weight: 0.4, passed: iou > 0.15 },
            { name: "both_decel", value: 1, weight: 0.3, passed: true },
            { name: "proximity", value: d < cr * 0.8 ? 1 : 0.5, weight: 0.3, passed: true },
          ],
          sceneContext: "traffic",
        });
      } else {
        // ===== ISOLATED / MARKETPLACE: 5-signal scoring =====
        if (isPassing(a, b)) continue;
        if (d > cr * 3.5) continue;

        const overlap = scoreOverlapSignal(iou);
        const deceleration = (hasDecelerated(a) ? 0.5 : 0) + (hasDecelerated(b) ? 0.5 : 0);
        const proximity = d < cr * 0.8 ? 1.0 : d < cr * 1.5 ? 0.7 : d < cr * 2.5 ? 0.3 : 0;
        const trajectory = scoreTrajectorySignal(a, b);
        const energy = scoreEnergySignal(a, b);

        let confidence = 0.30 * overlap + 0.25 * deceleration + 0.20 * proximity + 0.15 * trajectory + 0.10 * energy;

        const passedCount = [overlap > 0.03, deceleration > 0, proximity > 0, trajectory > 0.2, energy > 0].filter(Boolean).length;

        const minScore = envMode === "isolated" ? 0.35 : 0.50;
        const minSignals = envMode === "isolated" ? 2 : 3;

        if (confidence >= minScore && passedCount >= minSignals) {
          console.log(`[TTC] ${envMode.toUpperCase()} ALERT: ${a.class}#${a.id} + ${b.class}#${b.id} score=${confidence.toFixed(3)} signals=${passedCount}/5`);
          evidence.push({
            type: "collision",
            confidence: Math.min(0.95, confidence),
            objects: [a.id, b.id],
            details: `${envMode}: signals=${passedCount}/5 d=${d.toFixed(0)}px iou=${iou.toFixed(3)}`,
            signals: [
              { name: "overlap", value: overlap, weight: 0.30, passed: overlap > 0.03 },
              { name: "deceleration", value: deceleration, weight: 0.25, passed: deceleration > 0 },
              { name: "proximity", value: proximity, weight: 0.20, passed: proximity > 0 },
              { name: "trajectory", value: trajectory, weight: 0.15, passed: trajectory > 0.2 },
              { name: "energy_transfer", value: energy, weight: 0.10, passed: energy > 0 },
            ],
            sceneContext: envMode,
          });
        }
      }
    }
  }

  return evidence;
}

function scoreOverlapSignal(iou: number): number {
  return Math.min(iou * 4, 1.0);
}

function scoreTrajectorySignal(a: TrackedEntity, b: TrackedEntity): number {
  if (a.positions.length < 2 || b.positions.length < 2) return 0;
  const ka = a.kalman.getState();
  const kb = b.kalman.getState();
  let minDist = Infinity;
  for (let t = 1; t <= 10; t++) {
    const d = Math.sqrt(
      ((ka.x + ka.vx * t) - (kb.x + kb.vx * t)) ** 2 +
      ((ka.y + ka.vy * t) - (kb.y + kb.vy * t)) ** 2
    );
    if (d < minDist) minDist = d;
  }
  const cr = combinedR(a, b);
  if (minDist < cr * 0.6) return 1.0;
  if (minDist < cr * 1.2) return 0.7;
  if (minDist < cr * 2.5) return 0.3;
  return 0;
}

function scoreEnergySignal(a: TrackedEntity, b: TrackedEntity): number {
  const MASS: Record<string, number> = { car: 1.5, truck: 3.0, bus: 4.0, motorcycle: 0.3, person: 0.08 };
  const massA = MASS[a.class] || 1.0;
  const massB = MASS[b.class] || 1.0;
  const oldA = a.speedHistory.length > 2 ? a.speedHistory[Math.min(2, a.speedHistory.length - 1)] : a.speed;
  const oldB = b.speedHistory.length > 2 ? b.speedHistory[Math.min(2, b.speedHistory.length - 1)] : b.speed;
  const lossA = 0.5 * massA * oldA * oldA - 0.5 * massA * a.speed * a.speed;
  const lossB = 0.5 * massB * oldB * oldB - 0.5 * massB * b.speed * b.speed;
  const sigA = lossA > 0.3 && a.speed < oldA * 0.4;
  const sigB = lossB > 0.3 && b.speed < oldB * 0.4;
  if (!sigA && !sigB) return 0;
  return Math.min(1.0, Math.max(lossA, lossB) / 2);
}

// ========== PERSON FALL ==========

function detectPersonFall(entities: TrackedEntity[]): AccidentEvidence[] {
  const evidence: AccidentEvidence[] = [];
  for (const entity of entities) {
    if (entity.class !== "person" || entity.age < 3) continue;
    if (entity.aspectHistory.length < 3) continue;

    const currentAR = entity.aspectHistory[entity.aspectHistory.length - 1];
    const prevAR = entity.aspectHistory.length >= 3
      ? (entity.aspectHistory[0] + entity.aspectHistory[1]) / 2
      : currentAR;
    const wasStanding = prevAR < 0.8;
    const nowLying = currentAR > 0.9;

    if (wasStanding && nowLying) {
      const lastY = entity.positions[entity.positions.length - 1]?.y || 0;
      const prevY = entity.positions.length >= 3 ? entity.positions[entity.positions.length - 3].y : lastY;
      const dropped = lastY > prevY + 3;
      const wasMoving = wasFast(entity);
      const stationary = isStationary(entity);

      let confidence = 0.65;
      if (dropped) confidence += 0.1;
      if (wasMoving && stationary) confidence += 0.1;

      evidence.push({
        type: "person_fall",
        confidence: Math.min(0.9, confidence),
        objects: [entity.id],
        details: `Fall: AR ${prevAR.toFixed(2)}->${currentAR.toFixed(2)}`,
        signals: [
          { name: "aspect_ratio", value: currentAR, weight: 0.4, passed: nowLying },
          { name: "position_drop", value: dropped ? 1 : 0, weight: 0.3, passed: dropped },
          { name: "was_moving", value: wasMoving ? 1 : 0, weight: 0.2, passed: wasMoving && stationary },
          { name: "sustained", value: entity.confirmedFrames >= 2 ? 1 : 0, weight: 0.1, passed: entity.confirmedFrames >= 2 },
        ],
        sceneContext: "isolated",
      });
    }
  }
  return evidence;
}

// ========== BIKE OFF-TRACK / VEHICLE FALL ==========

function detectBikeOffTrack(entities: TrackedEntity[], envMode: EnvMode): AccidentEvidence[] {
  const evidence: AccidentEvidence[] = [];
  for (const entity of entities) {
    // Check for vehicle fall (bike/motorcycle sudden drop)
    if (entity.class === "motorcycle" || entity.class === "car") {
      const fall = detectVehicleFall(entity);
      if (fall) {
        fall.sceneContext = envMode;
        evidence.push(fall);
        continue;
      }
    }

    // Bike heading change
    if (entity.class !== "motorcycle" || entity.age < 3) continue;
    if (entity.headingHistory.length < 3) continue;

    const recentH = entity.headingHistory[entity.headingHistory.length - 1];
    const prevH = entity.headingHistory[entity.headingHistory.length - 3];
    let headingChange = Math.abs(recentH - prevH);
    if (headingChange > Math.PI) headingChange = 2 * Math.PI - headingChange;

    const wasMoving = wasFast(entity);
    const significantChange = headingChange > Math.PI * 0.3;

    if (wasMoving && significantChange) {
      evidence.push({
        type: "bike_off_track",
        confidence: 0.7,
        objects: [entity.id],
        details: `Bike heading ${(headingChange * 180 / Math.PI).toFixed(0)} deg`,
        signals: [
          { name: "heading_change", value: headingChange / Math.PI, weight: 0.5, passed: significantChange },
          { name: "was_fast", value: 1, weight: 0.5, passed: wasMoving },
        ],
        sceneContext: envMode,
      });
    }
  }
  return evidence;
}

// ========== MAIN EXPORT ==========

export function detectAccidents(entities: TrackedEntity[], envMode: EnvMode): AccidentEvidence[] {
  let evidence: AccidentEvidence[] = [];
  evidence.push(...detectVehicleCollision(entities, envMode));
  evidence.push(...detectPersonFall(entities));
  evidence.push(...detectBikeOffTrack(entities, envMode));

  // Deduplicate
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

  if (deduped.length > 0) {
    console.log(`[TTC] ALERT: ${deduped.length} items, top=${deduped[0].type} conf=${deduped[0].confidence.toFixed(3)}`);
  }

  return deduped;
}

export function getModeConfig(mode: EnvMode) {
  return MODE_CONFIG[mode];
}

const MODE_CONFIG: Record<EnvMode, { minScore: number; minSignals: number; cooldownMs: number }> = {
  isolated: { minScore: 0.35, minSignals: 2, cooldownMs: 3000 },
  traffic: { minScore: 0.55, minSignals: 2, cooldownMs: 8000 },
  marketplace: { minScore: 0.50, minSignals: 3, cooldownMs: 8000 },
};

export { isPassing, hasDecelerated, dist, combinedR, calcIoU };

// Time-to-Collision Engine v3
// KEY INSIGHT: A collision shows SPEED CHANGE at the moment of proximity.
// Normal passing: both objects keep moving at constant speed.
// Collision: at least one object suddenly decelerates when near the other.

import { TrackedEntity } from "./kalman-tracker";

export interface TTCPair {
  a: TrackedEntity;
  b: TrackedEntity;
  ttc: number;
  distance: number;
  closingSpeed: number;
  severity: "none" | "warning" | "critical" | "impact";
}

export interface AccidentEvidence {
  type: "collision" | "post_impact" | "perpendicular_impact";
  confidence: number;
  objects: number[];
  details: string;
}

// Check if two entities are very close
function distance(a: TrackedEntity, b: TrackedEntity): number {
  const dx = a.kalman.getState().x - b.kalman.getState().x;
  const dy = a.kalman.getState().y - b.kalman.getState().y;
  return Math.sqrt(dx * dx + dy * dy);
}

function combinedRadius(a: TrackedEntity, b: TrackedEntity): number {
  return (Math.sqrt(a.w * a.h) + Math.sqrt(b.w * b.h)) / 2;
}

function isClose(a: TrackedEntity, b: TrackedEntity, mult: number = 1.0): boolean {
  return distance(a, b) < combinedRadius(a, b) * mult;
}

// === THE CORE TEST: Did speed change near the other object? ===
// This is the ONLY reliable differentiator between collision and passing.
// 
// Collision signature: object was moving → got close to other → speed dropped
// Passing signature: object was moving → got close to other → speed stayed constant
//
function hasSpeedChangeNearOther(entity: TrackedEntity, other: TrackedEntity): {
  changed: boolean;
  deceleration: number;
  wasMoving: boolean;
} {
  const speedHist = entity.speedHistory;
  if (speedHist.length < 4) return { changed: false, deceleration: 0, wasMoving: false };

  // Was the entity moving before the encounter?
  const prevSpeed = (speedHist[0] + speedHist[1]) / 2;
  const currSpeed = entity.speed;
  const wasMoving = prevSpeed > 1.0;

  if (!wasMoving) return { changed: false, deceleration: 0, wasMoving: false };

  // Did speed drop significantly?
  const deceleration = prevSpeed - currSpeed;
  const changed = deceleration > 1.0; // dropped by more than 1 px/frame

  return { changed, deceleration, wasMoving };
}

// Compute collision score between two entities
// Uses ONLY speed-change-at-proximity as the primary signal
function computeCollisionScore(a: TrackedEntity, b: TrackedEntity): {
  score: number;
  ttc: number;
  reason: string;
} | null {
  const dist = distance(a, b);
  const combinedR = combinedRadius(a, b);

  // Must be within reasonable distance
  if (dist > combinedR * 6) return null;

  const speedA = Math.sqrt(a.kalman.getState().vx ** 2 + a.kalman.getState().vy ** 2);
  const speedB = Math.sqrt(b.kalman.getState().vx ** 2 + b.kalman.getState().vy ** 2);

  // At least one must have been moving
  if (speedA < 0.3 && speedB < 0.3) return null;

  let score = 0;
  const reasons: string[] = [];

  // === PRIMARY SIGNAL: Speed change at proximity ===
  const aSpeedChange = hasSpeedChangeNearOther(a, b);
  const bSpeedChange = hasSpeedChangeNearOther(b, a);

  // One or both objects decelerated near the other
  if (aSpeedChange.changed && aSpeedChange.wasMoving) {
    score += 0.5;
    reasons.push(`A_brake(${aSpeedChange.deceleration.toFixed(1)})`);
  }
  if (bSpeedChange.changed && bSpeedChange.wasMoving) {
    score += 0.5;
    reasons.push(`B_brake(${bSpeedChange.deceleration.toFixed(1)})`);
  }

  // === SECONDARY SIGNAL: Both decelerated (strongest collision evidence) ===
  if (aSpeedChange.changed && bSpeedChange.changed) {
    score += 0.2;
    reasons.push("both_brake");
  }

  // === TERTIARY: Very close proximity ===
  if (isClose(a, b, 0.7)) {
    score += 0.2;
    reasons.push("touching");
  } else if (isClose(a, b, 1.2)) {
    score += 0.1;
    reasons.push("close");
  }

  // === PENALTY: Both still moving fast = passing through ===
  if (speedA > 1.5 && speedB > 1.5 && !aSpeedChange.changed && !bSpeedChange.changed) {
    score -= 0.6;
    reasons.push("PASSING");
  }

  // === PENALTY: Parallel same direction ===
  const angleA = a.heading;
  const angleB = b.heading;
  let angleDiff = Math.abs(angleA - angleB);
  if (angleDiff > Math.PI) angleDiff = 2 * Math.PI - angleDiff;
  if (angleDiff < Math.PI * 0.3) {
    score -= 0.2;
    reasons.push("parallel");
  }

  // TTC for reference
  const dx = b.kalman.getState().x - a.kalman.getState().x;
  const dy = b.kalman.getState().y - a.kalman.getState().y;
  const rvx = b.kalman.getState().vx - a.kalman.getState().vx;
  const rvy = b.kalman.getState().vy - a.kalman.getState().vy;
  const closingSpeed = -(dx * rvx + dy * rvy) / Math.max(dist, 1);
  const ttc = closingSpeed > 0.5 ? Math.max(0, (dist - combinedR) / closingSpeed) : NaN;

  if (score < 0.4) return null;

  return { score: Math.min(score, 1), ttc, reason: reasons.join("+") };
}

// Find all collision pairs
export function findAllTTCPairs(entities: TrackedEntity[]): TTCPair[] {
  const pairs: TTCPair[] = [];
  const candidates = entities.filter(e => e.age >= 3);

  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i], b = candidates[j];
      if (a.class === "person" && b.class === "person") continue;

      const result = computeCollisionScore(a, b);
      if (!result) continue;

      const dist = distance(a, b);
      const dx = b.kalman.getState().x - a.kalman.getState().x;
      const dy = b.kalman.getState().y - a.kalman.getState().y;
      const rvx = b.kalman.getState().vx - a.kalman.getState().vx;
      const rvy = b.kalman.getState().vy - a.kalman.getState().vy;
      const closingSpeed = -(dx * rvx + dy * rvy) / Math.max(dist, 1);

      let severity: TTCPair["severity"] = "none";
      if (result.score >= 0.8) severity = "impact";
      else if (result.score >= 0.6) severity = "critical";
      else if (result.score >= 0.4) severity = "warning";

      pairs.push({ a, b, ttc: result.ttc, distance: dist, closingSpeed, severity });
    }
  }

  pairs.sort((a, b) => b.distance - a.distance);
  return pairs;
}

// Post-impact: both stopped + very close + were moving
export function detectPostImpact(entities: TrackedEntity[], ttcPairs: TTCPair[]): AccidentEvidence | null {
  for (const pair of ttcPairs) {
    if (pair.distance > 80) continue;

    const speedA = pair.a.speed;
    const speedB = pair.b.speed;

    if (speedA > 0.5 || speedB > 0.5) continue;

    const wasMovingA = pair.a.speedHistory.length >= 3 && pair.a.speedHistory.some(s => s > 2);
    const wasMovingB = pair.b.speedHistory.length >= 3 && pair.b.speedHistory.some(s => s > 2);
    if (!wasMovingA || !wasMovingB) continue;

    if (!isClose(pair.a, pair.b, 0.6)) continue;

    return {
      type: "post_impact",
      confidence: 0.9,
      objects: [pair.a.id, pair.b.id],
      details: `Both stopped after moving (dist: ${pair.distance.toFixed(0)}px)`,
    };
  }
  return null;
}

// Main accident detection
export function detectAccidents(
  entities: TrackedEntity[],
  ttcPairs: TTCPair[]
): AccidentEvidence[] {
  const evidence: AccidentEvidence[] = [];

  // 1. Active collision (speed change near other object)
  for (const pair of ttcPairs) {
    if (pair.severity === "impact" || pair.severity === "critical") {
      const result = computeCollisionScore(pair.a, pair.b);
      if (result && result.score >= 0.5) {
        evidence.push({
          type: "collision",
          confidence: Math.min(0.95, result.score),
          objects: [pair.a.id, pair.b.id],
          details: `score: ${result.score.toFixed(2)} | ${result.reason} | dist: ${pair.distance.toFixed(0)}px`,
        });
      }
    }
  }

  // 2. Post-impact (most reliable)
  const postImpact = detectPostImpact(entities, ttcPairs);
  if (postImpact) evidence.push(postImpact);

  // 3. Perpendicular: object stopped suddenly near a moving object
  for (const entity of entities) {
    if (entity.speedHistory.length < 4) continue;
    const prevSpeed = (entity.speedHistory[0] + entity.speedHistory[1]) / 2;
    const currSpeed = entity.speed;

    if (prevSpeed < 2 || currSpeed > 0.8) continue;

    for (const other of entities) {
      if (other.id === entity.id) continue;
      if (other.speed < 1) continue;
      if (!isClose(entity, other, 1.5)) continue;

      evidence.push({
        type: "perpendicular_impact",
        confidence: 0.7,
        objects: [entity.id, other.id],
        details: `#${entity.id} stopped near moving #${other.id}`,
      });
      break;
    }
  }

  evidence.sort((a, b) => b.confidence - a.confidence);
  const seen = new Set<string>();
  return evidence.filter(e => {
    const key = e.objects.sort().join(",");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

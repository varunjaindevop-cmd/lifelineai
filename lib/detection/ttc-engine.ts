// Time-to-Collision (TTC) Engine v2
// Key insight: TTC alone can't distinguish "passing by" from "colliding"
// We need path intersection analysis + multiple confirmation signals

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

// ===== CORE: Is this a real collision vs passing by? =====
// Two objects "pass by" if:
//   1. They're moving in roughly the same direction (parallel)
//   2. One overtakes the other
//   3. They cross paths but at different times
// Two objects "collide" if:
//   1. Their paths intersect AND they arrive at the intersection simultaneously
//   2. OR they are already overlapping/very close with converging velocities
//   3. OR one suddenly stops after being close to the other (post-impact)

function areParallel(a: TrackedEntity, b: TrackedEntity): boolean {
  const angleA = a.heading;
  const angleB = b.heading;
  let diff = Math.abs(angleA - angleB);
  if (diff > Math.PI) diff = 2 * Math.PI - diff;
  return diff < Math.PI * 0.4; // within ~72 degrees = parallel
}

function willPathsCrossAtSameTime(a: TrackedEntity, b: TrackedEntity): boolean {
  // Project both objects forward and check if they'd be at the same spot at the same time
  const ax = a.kalman.getState().x, ay = a.kalman.getState().y;
  const bx = b.kalman.getState().x, by = b.kalman.getState().y;
  const avx = a.kalman.getState().vx, avy = a.kalman.getState().vy;
  const bvx = b.kalman.getState().vx, bvy = b.kalman.getState().vy;

  // Check multiple future time steps
  for (let t = 1; t <= 5; t++) {
    const futAx = ax + avx * t;
    const futAy = ay + avy * t;
    const futBx = bx + bvx * t;
    const futBy = by + bvy * t;
    const dist = Math.sqrt((futAx - futBx) ** 2 + (futAy - futBy) ** 2);
    const combinedR = (Math.sqrt(a.w * a.h) + Math.sqrt(b.w * b.h)) / 2;
    if (dist < combinedR * 0.8) return true; // would overlap at time t
  }
  return false;
}

function hasBoundingBoxOverlap(a: TrackedEntity, b: TrackedEntity): boolean {
  const ax = a.kalman.getState().x - a.w / 2;
  const ay = a.kalman.getState().y - a.h / 2;
  const bx = b.kalman.getState().x - b.w / 2;
  const by = b.kalman.getState().y - b.h / 2;
  return !(ax + a.w < bx || bx + b.w < ax || ay + a.h < by || by + b.h < ay);
}

function areVeryClose(a: TrackedEntity, b: TrackedEntity, threshold: number = 1.2): boolean {
  const dx = a.kalman.getState().x - b.kalman.getState().x;
  const dy = a.kalman.getState().y - b.kalman.getState().y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const combinedR = (Math.sqrt(a.w * a.h) + Math.sqrt(b.w * b.h)) / 2;
  return dist < combinedR * threshold;
}

// Compute collision likelihood between two entities
function computeCollisionScore(a: TrackedEntity, b: TrackedEntity): { score: number; ttc: number; reason: string } | null {
  const ax = a.kalman.getState().x, ay = a.kalman.getState().y;
  const bx = b.kalman.getState().x, by = b.kalman.getState().y;
  const dx = bx - ax, dy = by - ay;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const combinedR = (Math.sqrt(a.w * a.h) + Math.sqrt(b.w * b.h)) / 2;

  // Skip if too far apart
  if (dist > combinedR * 5) return null;

  const avx = a.kalman.getState().vx, avy = a.kalman.getState().vy;
  const bvx = b.kalman.getState().vx, bvy = b.kalman.getState().vy;
  const speedA = Math.sqrt(avx * avx + avy * avy);
  const speedB = Math.sqrt(bvx * bvx + bvy * bvy);

  // At least one must be moving
  if (speedA < 0.3 && speedB < 0.3) return null;

  let score = 0;
  let reasons: string[] = [];

  // === SIGNAL 1: Bounding box overlap (strongest signal) ===
  if (hasBoundingBoxOverlap(a, b)) {
    score += 0.5;
    reasons.push("overlap");
  }

  // === SIGNAL 2: Very close proximity ===
  if (areVeryClose(a, b, 0.8)) {
    score += 0.3;
    reasons.push("very_close");
  } else if (areVeryClose(a, b, 1.5)) {
    score += 0.1;
    reasons.push("close");
  }

  // === SIGNAL 3: Not parallel (one is cutting across the other's path) ===
  const parallel = areParallel(a, b);
  if (!parallel) {
    score += 0.2;
    reasons.push("crossing");
  }

  // === SIGNAL 4: Closing speed (approaching each other) ===
  const closingSpeed = -(dx * (bvx - avx) + dy * (bvy - avy)) / Math.max(dist, 1);
  if (closingSpeed > 2) {
    score += 0.2;
    reasons.push("closing_fast");
  } else if (closingSpeed > 0.5) {
    score += 0.1;
    reasons.push("closing");
  }

  // === SIGNAL 5: Will paths cross at same time? ===
  if (willPathsCrossAtSameTime(a, b)) {
    score += 0.2;
    reasons.push("path_cross");
  }

  // === SIGNAL 6: Sudden deceleration near the other object ===
  const decelA = a.speedHistory.length >= 3
    ? a.speedHistory[a.speedHistory.length - 3] - a.speed
    : 0;
  const decelB = b.speedHistory.length >= 3
    ? b.speedHistory[b.speedHistory.length - 3] - b.speed
    : 0;
  if ((decelA > 1.5 || decelB > 1.5) && areVeryClose(a, b, 3)) {
    score += 0.3;
    reasons.push("hard_brake_nearby");
  }

  // === PENALTY: Parallel + similar speed = passing by ===
  if (parallel && Math.abs(speedA - speedB) < 1.5) {
    score -= 0.4;
    reasons.push("PASSING");
  }

  // === PENALTY: One clearly overtaking the other ===
  if (parallel) {
    const angleDiff = Math.abs(a.heading - b.heading);
    const wrapped = angleDiff > Math.PI ? 2 * Math.PI - angleDiff : angleDiff;
    if (wrapped < Math.PI * 0.2) {
      // Same direction — check if one is behind and faster (overtaking)
      const aBehind = (dx * avx + dy * avy) < 0; // a is behind b relative to b's direction
      const bFaster = speedB > speedA;
      if ((aBehind && bFaster) || (!aBehind && speedA > speedB)) {
        score -= 0.3;
        reasons.push("overtaking");
      }
    }
  }

  // TTC for reference
  const ttc = closingSpeed > 0.5 ? Math.max(0, (dist - combinedR) / closingSpeed) : NaN;

  // Minimum score threshold
  if (score < 0.5) return null;

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

      const closingSpeed = -( 
        (b.kalman.getState().x - a.kalman.getState().x) * (b.kalman.getState().vx - a.kalman.getState().vx) +
        (b.kalman.getState().y - a.kalman.getState().y) * (b.kalman.getState().vy - a.kalman.getState().vy)
      ) / Math.max(
        Math.sqrt(
          (b.kalman.getState().x - a.kalman.getState().x) ** 2 +
          (b.kalman.getState().y - a.kalman.getState().y) ** 2
        ), 1
      );

      const dist = Math.sqrt(
        (a.kalman.getState().x - b.kalman.getState().x) ** 2 +
        (a.kalman.getState().y - b.kalman.getState().y) ** 2
      );

      let severity: TTCPair["severity"] = "none";
      if (result.score >= 0.7) severity = "impact";
      else if (result.score >= 0.55) severity = "critical";
      else if (result.score >= 0.4) severity = "warning";

      pairs.push({
        a, b,
        ttc: result.ttc,
        distance: dist,
        closingSpeed,
        severity,
      });
    }
  }

  pairs.sort((a, b) => b.distance - a.distance); // closest first
  return pairs;
}

// Post-impact: both objects stopped + very close + were recently moving
export function detectPostImpact(entities: TrackedEntity[], ttcPairs: TTCPair[]): AccidentEvidence | null {
  for (const pair of ttcPairs) {
    if (pair.distance > 100) continue; // must be very close

    const speedA = pair.a.speed;
    const speedB = pair.b.speed;

    // Both must be nearly stopped
    if (speedA > 0.8 || speedB > 0.8) continue;

    // Must have been moving recently
    const wasMovingA = pair.a.speedHistory.length >= 3 && pair.a.speedHistory.some(s => s > 2);
    const wasMovingB = pair.b.speedHistory.length >= 3 && pair.b.speedHistory.some(s => s > 2);
    if (!wasMovingA || !wasMovingB) continue;

    // Must be overlapping or very close
    if (!areVeryClose(pair.a, pair.b, 0.8)) continue;

    return {
      type: "post_impact",
      confidence: 0.85,
      objects: [pair.a.id, pair.b.id],
      details: `Both stopped after moving (dist: ${pair.distance.toFixed(0)}px)`,
    };
  }
  return null;
}

// Main accident detection — conservative, high-confidence only
export function detectAccidents(
  entities: TrackedEntity[],
  ttcPairs: TTCPair[]
): AccidentEvidence[] {
  const evidence: AccidentEvidence[] = [];

  // 1. Active collision detection (from TTC pairs with high collision score)
  for (const pair of ttcPairs) {
    if (pair.severity === "impact") {
      const result = computeCollisionScore(pair.a, pair.b);
      if (result && result.score >= 0.6) {
        evidence.push({
          type: "collision",
          confidence: Math.min(0.95, result.score),
          objects: [pair.a.id, pair.b.id],
          details: `score: ${result.score.toFixed(2)} | ${result.reason} | dist: ${pair.distance.toFixed(0)}px`,
        });
      }
    }
  }

  // 2. Post-impact detection (most reliable — objects stopped after moving)
  const postImpact = detectPostImpact(entities, ttcPairs);
  if (postImpact) evidence.push(postImpact);

  // 3. Perpendicular impact: one object stopped suddenly near another moving object
  for (const entity of entities) {
    if (entity.speedHistory.length < 4) continue;
    const prevSpeed = (entity.speedHistory[0] + entity.speedHistory[1]) / 2;
    const currSpeed = entity.speed;
    
    // Object was moving fast and suddenly stopped
    if (prevSpeed < 2 || currSpeed > 0.8) continue;
    
    // Check if another moving object is very close
    for (const other of entities) {
      if (other.id === entity.id) continue;
      if (other.speed < 1) continue; // other must be moving
      if (!areVeryClose(entity, other, 1.5)) continue;
      
      // The stopped object + moving nearby object = possible perpendicular impact
      evidence.push({
        type: "perpendicular_impact",
        confidence: 0.7,
        objects: [entity.id, other.id],
        details: `Object #${entity.id} stopped suddenly near moving #${other.id}`,
      });
      break;
    }
  }

  // Sort by confidence, deduplicate
  evidence.sort((a, b) => b.confidence - a.confidence);
  const seen = new Set<string>();
  return evidence.filter(e => {
    const key = e.objects.sort().join(",");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

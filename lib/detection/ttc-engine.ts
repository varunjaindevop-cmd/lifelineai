// Collision Detection Engine v4
// PHILOSOPHY: Only detect what ACTUALLY happens in a real accident.
//
// What happens in a REAL collision:
//   1. Object was moving fast → suddenly stopped/slowed dramatically
//   2. The stopped object stays in ONE spot for multiple frames
//   3. Bike: falls sideways (aspect ratio change from tall to wide)
//   4. Person: gets thrown (trajectory deviates from standing position)
//   5. Both objects were VERY close at the moment of speed change
//
// What does NOT happen in normal traffic:
//   - Objects passing each other at distance → both keep moving
//   - Traffic overlap → objects continue at same speed
//   - Car in front of person at distance → no speed change
//
// RULE: Speed change at close proximity = collision candidate.
//       Speed change at far distance = NOT a collision.
//       No speed change = NOT a collision (regardless of distance).

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
  type: "collision" | "post_impact" | "bike_fall" | "person_thrown";
  confidence: number;
  objects: number[];
  details: string;
}

// ===== PHYSICS-BASED COLLISION SIGNATURES =====

// Signature 1: Object was fast, now stopped/stopped at specific spot
function wasMovingNowStopped(entity: TrackedEntity): boolean {
  if (entity.speedHistory.length < 3) return false;
  const recentSpeed = entity.speed;
  const prevSpeed = (entity.speedHistory[0] + entity.speedHistory[1]) / 2;
  // Was moving (prevSpeed > 2 px/frame), now stopped (recentSpeed < 0.5)
  return prevSpeed > 2 && recentSpeed < 0.5;
}

// Signature 2: Object is stationary at a specific spot (not just slow)
function isStationary(entity: TrackedEntity): boolean {
  if (entity.positions.length < 4) return false;
  const last4 = entity.positions.slice(-4);
  const maxDist = Math.max(
    ...last4.map((p, i) =>
      i === 0 ? 0 : Math.sqrt((p.x - last4[0].x) ** 2 + (p.y - last4[0].y) ** 2)
    )
  );
  return maxDist < 5; // moved less than 5 pixels in 4 frames
}

// Signature 3: Bike fell sideways (aspect ratio changed dramatically)
function detectBikeFall(entity: TrackedEntity): boolean {
  if (entity.class !== "motorcycle") return false;
  if (entity.speedHistory.length < 3) return false;
  if (entity.positions.length < 3) return false;

  const currentAR = entity.w / Math.max(entity.h, 1);
  const wasMoving = entity.speedHistory.some(s => s > 2);
  const nowStopped = entity.speed < 0.5;

  // Bike was moving, now stopped, and aspect ratio changed
  // A bike falling sideways goes from tall (AR < 0.7) to wider (AR > 1.0)
  if (wasMoving && nowStopped) {
    // Check if heading changed dramatically (bike spun/fell)
    if (entity.headingHistory.length >= 3) {
      const headingDiff = Math.abs(
        entity.headingHistory[entity.headingHistory.length - 1] -
        entity.headingHistory[entity.headingHistory.length - 3]
      );
      if (headingDiff > Math.PI * 0.3) return true; // > 54 degrees
    }
    // Or if position is low on screen (fell to ground)
    if (entity.positions.length >= 3) {
      const lastY = entity.positions[entity.positions.length - 1].y;
      const prevY = entity.positions[entity.positions.length - 3].y;
      if (lastY > prevY + 5) return true; // dropped
    }
  }
  return false;
}

// Signature 4: Person thrown (trajectory deviates from normal walking)
function detectPersonThrown(entity: TrackedEntity): boolean {
  if (entity.class !== "person") return false;
  if (entity.speedHistory.length < 3) return false;

  const wasMoving = entity.speedHistory.some(s => s > 2);
  const nowStopped = entity.speed < 0.5;

  if (wasMoving && nowStopped) {
    // Person was moving fast and suddenly stopped
    return true;
  }
  return false;
}

// ===== DISTANCE FILTERING =====
// Critical: Only consider collisions at CLOSE range
// Far-away objects passing each other should NEVER trigger alerts

function isCloseRange(a: TrackedEntity, b: TrackedEntity): boolean {
  const dist = Math.sqrt(
    (a.kalman.getState().x - b.kalman.getState().x) ** 2 +
    (a.kalman.getState().y - b.kalman.getState().y) ** 2
  );
  const combinedR = (Math.sqrt(a.w * a.h) + Math.sqrt(b.w * b.h)) / 2;
  return dist < combinedR * 1.5; // must be VERY close
}

function areOverlapping(a: TrackedEntity, b: TrackedEntity): boolean {
  const ax = a.kalman.getState().x - a.w / 2;
  const ay = a.kalman.getState().y - a.h / 2;
  const bx = b.kalman.getState().x - b.w / 2;
  const by = b.kalman.getState().y - b.h / 2;
  return !(ax + a.w < bx || bx + b.w < ax || ay + a.h < by || by + b.h < ay);
}

// ===== MAIN COLLISION DETECTION =====

function computeCollisionScore(a: TrackedEntity, b: TrackedEntity): {
  score: number;
  reason: string;
} | null {
  const dist = Math.sqrt(
    (a.kalman.getState().x - b.kalman.getState().x) ** 2 +
    (a.kalman.getState().y - b.kalman.getState().y) ** 2
  );
  const combinedR = (Math.sqrt(a.w * a.h) + Math.sqrt(b.w * b.h)) / 2;

  // HARD FILTER: Must be close range (within 1.5x combined radius)
  if (dist > combinedR * 1.5) return null;

  let score = 0;
  const reasons: string[] = [];

  // ===== SIGNAL 1: Overlapping bounding boxes (strongest) =====
  if (areOverlapping(a, b)) {
    score += 0.5;
    reasons.push("overlap");
  }

  // ===== SIGNAL 2: One object stopped after being fast =====
  const aStopped = wasMovingNowStopped(a);
  const bStopped = wasMovingNowStopped(b);

  if (aStopped) {
    score += 0.4;
    reasons.push("A_stopped");
  }
  if (bStopped) {
    score += 0.4;
    reasons.push("B_stopped");
  }

  // ===== SIGNAL 3: Stationary at this spot (sustained) =====
  if (isStationary(a) && a.speedHistory.some(s => s > 2)) {
    score += 0.2;
    reasons.push("A_stationary");
  }
  if (isStationary(b) && b.speedHistory.some(s => s > 2)) {
    score += 0.2;
    reasons.push("B_stationary");
  }

  // ===== SIGNAL 4: Bike fell =====
  if (detectBikeFall(a)) {
    score += 0.5;
    reasons.push("bike_A_fell");
  }
  if (detectBikeFall(b)) {
    score += 0.5;
    reasons.push("bike_B_fell");
  }

  // ===== SIGNAL 5: Person thrown =====
  if (detectPersonThrown(a)) {
    score += 0.4;
    reasons.push("person_A_thrown");
  }
  if (detectPersonThrown(b)) {
    score += 0.4;
    reasons.push("person_B_thrown");
  }

  // ===== PENALTIES =====
  // Both objects still moving fast = passing through, not collision
  const speedA = a.speed;
  const speedB = b.speed;
  if (speedA > 1.5 && speedB > 1.5) {
    score -= 0.6;
    reasons.push("BOTH_MOVING");
  }

  // Same direction = parallel traffic
  const angleA = a.heading;
  const angleB = b.heading;
  let angleDiff = Math.abs(angleA - angleB);
  if (angleDiff > Math.PI) angleDiff = 2 * Math.PI - angleDiff;
  if (angleDiff < Math.PI * 0.3) {
    score -= 0.3;
    reasons.push("parallel");
  }

  if (score < 0.4) return null;

  return { score: Math.min(score, 1), reason: reasons.join("+") };
}

// Find all collision pairs
export function findAllTTCPairs(entities: TrackedEntity[]): TTCPair[] {
  const pairs: TTCPair[] = [];
  const candidates = entities.filter(e => e.age >= 1);

  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i], b = candidates[j];
      if (a.class === "person" && b.class === "person") continue;

      const result = computeCollisionScore(a, b);
      if (!result) continue;

      const dist = Math.sqrt(
        (a.kalman.getState().x - b.kalman.getState().x) ** 2 +
        (a.kalman.getState().y - b.kalman.getState().y) ** 2
      );

      let severity: TTCPair["severity"] = "none";
      if (result.score >= 0.7) severity = "impact";
      else if (result.score >= 0.55) severity = "critical";
      else if (result.score >= 0.4) severity = "warning";

      pairs.push({
        a, b, ttc: NaN, distance: dist, closingSpeed: 0, severity,
      });
    }
  }

  pairs.sort((a, b) => b.distance - a.distance);
  return pairs;
}

// Post-impact: both stopped + overlapping + were moving
export function detectPostImpact(entities: TrackedEntity[], ttcPairs: TTCPair[]): AccidentEvidence | null {
  for (const pair of ttcPairs) {
    if (pair.distance > 50) continue;

    const speedA = pair.a.speed;
    const speedB = pair.b.speed;

    // Both must be nearly stopped
    if (speedA > 0.5 || speedB > 0.5) continue;

    // Both must have been moving recently
    const wasMovingA = pair.a.speedHistory.length >= 3 && pair.a.speedHistory.some(s => s > 2);
    const wasMovingB = pair.b.speedHistory.length >= 3 && pair.b.speedHistory.some(s => s > 2);
    if (!wasMovingA || !wasMovingB) continue;

    return {
      type: "post_impact",
      confidence: 0.9,
      objects: [pair.a.id, pair.b.id],
      details: `Both stopped after moving (dist: ${pair.distance.toFixed(0)}px)`,
    };
  }
  return null;
}

// Main detection
export function detectAccidents(
  entities: TrackedEntity[],
  ttcPairs: TTCPair[]
): AccidentEvidence[] {
  const evidence: AccidentEvidence[] = [];

  // Active collision (speed change + close proximity)
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

  // Post-impact (most reliable)
  const postImpact = detectPostImpact(entities, ttcPairs);
  if (postImpact) evidence.push(postImpact);

  // Bike falls (standalone — bike fell after being hit)
  for (const entity of entities) {
    if (detectBikeFall(entity)) {
      evidence.push({
        type: "bike_fall",
        confidence: 0.75,
        objects: [entity.id],
        details: `Bike fell: heading change + stopped`,
      });
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

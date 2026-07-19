// Collision Detection Engine v5
// SIMPLIFIED for reliability: only detect REAL accidents.
//
// RULE 1: Objects passing at distance = NOT collision (no matter what)
// RULE 2: Overlapping + one stopped = COLLISION
// RULE 3: Both stopped after both were moving + close = POST-IMPACT
// RULE 4: Bike heading change + stopped = BIKE FALL
// RULE 5: No overlap + both moving = NEVER a collision

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
  type: "collision" | "post_impact" | "bike_fall";
  confidence: number;
  objects: number[];
  details: string;
}

// ===== HELPERS =====

function dist(a: TrackedEntity, b: TrackedEntity): number {
  const dx = a.kalman.getState().x - b.kalman.getState().x;
  const dy = a.kalman.getState().y - b.kalman.getState().y;
  return Math.sqrt(dx * dx + dy * dy);
}

function combinedR(a: TrackedEntity, b: TrackedEntity): number {
  return (Math.sqrt(a.w * a.h) + Math.sqrt(b.w * b.h)) / 2;
}

function isOverlapping(a: TrackedEntity, b: TrackedEntity): boolean {
  const ax = a.kalman.getState().x - a.w / 2;
  const ay = a.kalman.getState().y - a.h / 2;
  const bx = b.kalman.getState().x - b.w / 2;
  const by = b.kalman.getState().y - b.h / 2;
  return !(ax + a.w < bx || bx + b.w < ax || ay + a.h < by || by + b.h < ay);
}

function isVeryClose(a: TrackedEntity, b: TrackedEntity): boolean {
  return dist(a, b) < combinedR(a, b) * 1.0;
}

function wasFast(entity: TrackedEntity): boolean {
  if (entity.speedHistory.length < 3) return false;
  return entity.speedHistory.some(s => s > 2);
}

function isStopped(entity: TrackedEntity): boolean {
  return entity.speed < 0.5;
}

function isStationary(entity: TrackedEntity): boolean {
  if (entity.positions.length < 5) return false;
  const last5 = entity.positions.slice(-5);
  let maxMove = 0;
  for (let i = 1; i < last5.length; i++) {
    const d = Math.sqrt((last5[i].x - last5[0].x) ** 2 + (last5[i].y - last5[0].y) ** 2);
    maxMove = Math.max(maxMove, d);
  }
  return maxMove < 8; // barely moved in 5 frames
}

// ===== BIKE FALL DETECTION =====
function isBikeFall(entity: TrackedEntity): boolean {
  if (entity.class !== "motorcycle") return false;
  if (!wasFast(entity)) return false;
  if (!isStopped(entity)) return false;
  if (entity.headingHistory.length < 3) return false;

  // Heading changed significantly while stopping
  const headingDiff = Math.abs(
    entity.headingHistory[entity.headingHistory.length - 1] -
    entity.headingHistory[Math.max(0, entity.headingHistory.length - 3)]
  );
  if (headingDiff > Math.PI * 0.4) return true;

  return false;
}

// ===== MAIN COLLISION SCORING =====
function scoreCollision(a: TrackedEntity, b: TrackedEntity): {
  score: number;
  reason: string;
} | null {
  const d = dist(a, b);
  const cr = combinedR(a, b);

  // HARD RULE: Must be close range
  if (d > cr * 1.5) return null;

  // HARD RULE: If both moving fast, it's passing — skip
  if (a.speed > 1.5 && b.speed > 1.5) return null;

  let score = 0;
  const reasons: string[] = [];

  // ===== Overlapping: strongest signal =====
  if (isOverlapping(a, b)) {
    score += 0.6;
    reasons.push("overlap");
  }

  // ===== Very close proximity =====
  if (isVeryClose(a, b)) {
    score += 0.15;
    reasons.push("touching");
  }

  // ===== One stopped after being fast =====
  const aStopped = wasFast(a) && isStopped(a);
  const bStopped = wasFast(b) && isStopped(b);

  if (aStopped) {
    // Only count if also close to the other object
    if (isVeryClose(a, b) || isOverlapping(a, b)) {
      score += 0.3;
      reasons.push("A_stopped_near");
    }
  }
  if (bStopped) {
    if (isVeryClose(a, b) || isOverlapping(a, b)) {
      score += 0.3;
      reasons.push("B_stopped_near");
    }
  }

  // ===== Both stopped after both were moving (post-impact) =====
  if (aStopped && bStopped && wasFast(a) && wasFast(b)) {
    score += 0.2;
    reasons.push("both_stopped");
  }

  // ===== Stationary at this position =====
  if (isStationary(a) && wasFast(a)) {
    score += 0.1;
    reasons.push("A_stationary");
  }
  if (isStationary(b) && wasFast(b)) {
    score += 0.1;
    reasons.push("B_stationary");
  }

  // ===== PENALTIES =====
  const angleA = a.heading;
  const angleB = b.heading;
  let angleDiff = Math.abs(angleA - angleB);
  if (angleDiff > Math.PI) angleDiff = 2 * Math.PI - angleDiff;
  if (angleDiff < Math.PI * 0.3) {
    score -= 0.2;
    reasons.push("parallel");
  }

  // Far apart (close to threshold) = less likely collision
  if (d > cr * 1.2) {
    score -= 0.2;
    reasons.push("far");
  }

  if (score < 0.5) return null;

  return { score: Math.min(score, 1), reason: reasons.join("+") };
}

// ===== EXPORTS =====

export function findAllTTCPairs(entities: TrackedEntity[]): TTCPair[] {
  const pairs: TTCPair[] = [];
  const candidates = entities.filter(e => e.age >= 1);

  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i], b = candidates[j];
      if (a.class === "person" && b.class === "person") continue;

      const result = scoreCollision(a, b);
      if (!result) continue;

      let severity: TTCPair["severity"] = "none";
      if (result.score >= 0.7) severity = "impact";
      else if (result.score >= 0.55) severity = "critical";
      else severity = "warning";

      pairs.push({ a, b, ttc: NaN, distance: dist(a, b), closingSpeed: 0, severity });
    }
  }

  pairs.sort((a, b) => a.distance - b.distance); // closest first
  return pairs;
}

export function detectPostImpact(entities: TrackedEntity[], ttcPairs: TTCPair[]): AccidentEvidence | null {
  for (const pair of ttcPairs) {
    if (pair.distance > 60) continue;
    if (!isStopped(pair.a) || !isStopped(pair.b)) continue;
    if (!wasFast(pair.a) || !wasFast(pair.b)) continue;
    if (!isOverlapping(pair.a, pair.b) && !isVeryClose(pair.a, pair.b)) continue;

    return {
      type: "post_impact",
      confidence: 0.9,
      objects: [pair.a.id, pair.b.id],
      details: `Both stopped + close (dist: ${pair.distance.toFixed(0)}px)`,
    };
  }
  return null;
}

export function detectAccidents(
  entities: TrackedEntity[],
  ttcPairs: TTCPair[]
): AccidentEvidence[] {
  const evidence: AccidentEvidence[] = [];

  // Active collision
  for (const pair of ttcPairs) {
    if (pair.severity === "impact" || pair.severity === "critical") {
      const result = scoreCollision(pair.a, pair.b);
      if (result && result.score >= 0.5) {
        evidence.push({
          type: "collision",
          confidence: Math.min(0.95, result.score),
          objects: [pair.a.id, pair.b.id],
          details: `score:${result.score.toFixed(2)} ${result.reason} dist:${pair.distance.toFixed(0)}px`,
        });
      }
    }
  }

  // Post-impact
  const postImpact = detectPostImpact(entities, ttcPairs);
  if (postImpact) evidence.push(postImpact);

  // Bike falls (standalone — bike was moving, now stopped with heading change)
  for (const entity of entities) {
    if (isBikeFall(entity)) {
      // Only alert if bike is close to another object (likely hit by something)
      const nearbyVehicle = entities.find(e =>
        e.id !== entity.id &&
        (e.class === "car" || e.class === "motorcycle") &&
        dist(e, entity) < combinedR(e, entity) * 3
      );
      if (nearbyVehicle) {
        evidence.push({
          type: "bike_fall",
          confidence: 0.8,
          objects: [entity.id, nearbyVehicle.id],
          details: `Bike fell near vehicle #${nearbyVehicle.id}`,
        });
      }
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

// Collision Detection Engine v6
// PRINCIPLE: A collision has a SIGNATURE — not just proximity.
//
// Collision signature:
//   - Object was fast → suddenly decelerated → stopped
//   - AND this happened at the SAME location as another object
//   - AND the other object was also involved (close + decelerating)
//
// NOT a collision:
//   - Both objects moving past each other (no deceleration)
//   - One object stopped at a red light (no nearby impact)
//   - Cars in adjacent lanes (close but not decelerating together)

import { TrackedEntity } from "./kalman-tracker";

const H = 240; // frame height for position checks

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
  return !(ax + a.w < bx || bx + b.w < ax || ay + a.h < by || by + b.h > ay);
}

// Was the entity moving fast recently?
function wasFast(entity: TrackedEntity): boolean {
  if (entity.speedHistory.length < 3) return false;
  return entity.speedHistory[0] > 2 || entity.speedHistory[1] > 2;
}

// Is the entity currently stopped?
function isStopped(entity: TrackedEntity): boolean {
  return entity.speed < 0.5;
}

// Did the entity decelerate suddenly? (big speed drop in last 3 frames)
function hasSuddenDeceleration(entity: TrackedEntity): boolean {
  if (entity.speedHistory.length < 4) return false;
  const prevAvg = (entity.speedHistory[0] + entity.speedHistory[1]) / 2;
  const curr = entity.speed;
  // Dropped from >2 to <1 in recent frames
  return prevAvg > 2 && curr < 1;
}

// Is entity stationary for multiple frames?
function isStationary(entity: TrackedEntity): boolean {
  if (entity.positions.length < 5) return false;
  const last5 = entity.positions.slice(-5);
  let maxMove = 0;
  for (let i = 1; i < last5.length; i++) {
    const d = Math.sqrt((last5[i].x - last5[0].x) ** 2 + (last5[i].y - last5[0].y) ** 2);
    maxMove = Math.max(maxMove, d);
  }
  return maxMove < 8;
}

// Bike fell: heading changed dramatically while stopping
function isBikeFall(entity: TrackedEntity): boolean {
  if (entity.class !== "motorcycle") return false;
  if (!wasFast(entity)) return false;
  if (!isStopped(entity)) return false;
  if (entity.headingHistory.length < 3) return false;
  const headingDiff = Math.abs(
    entity.headingHistory[entity.headingHistory.length - 1] -
    entity.headingHistory[Math.max(0, entity.headingHistory.length - 3)]
  );
  return headingDiff > Math.PI * 0.4;
}

// ===== COLLISION SCORING =====
function scoreCollision(a: TrackedEntity, b: TrackedEntity): {
  score: number;
  reason: string;
} | null {
  const d = dist(a, b);
  const cr = combinedR(a, b);

  // HARD GATE 1: Must be close (within 1.5x combined radius)
  if (d > cr * 1.5) return null;

  // HARD GATE 2: Both moving fast in same direction = passing
  if (a.speed > 2 && b.speed > 2) {
    const angleDiff = Math.abs(a.heading - b.heading);
    const wrapped = angleDiff > Math.PI ? 2 * Math.PI - angleDiff : angleDiff;
    if (wrapped < Math.PI * 0.3) return null; // same direction = passing
  }

  let score = 0;
  const reasons: string[] = [];

  // Signal 1: Overlapping bounding boxes (strongest physical evidence)
  if (isOverlapping(a, b)) {
    score += 0.5;
    reasons.push("overlap");
  }

  // Signal 2: Very close proximity
  if (d < cr * 0.7) {
    score += 0.15;
    reasons.push("touching");
  }

  // Signal 3: Converging — heading toward each other
  const dx = b.kalman.getState().x - a.kalman.getState().x;
  const dy = b.kalman.getState().y - a.kalman.getState().y;
  const dotA = a.kalman.getState().vx * dx + a.kalman.getState().vy * dy;
  const dotB = b.kalman.getState().vx * (-dx) + b.kalman.getState().vy * (-dy);
  if (dotA > 0 || dotB > 0) {
    score += 0.2;
    reasons.push("converging");
  }

  // Signal 4: Sudden deceleration
  const aDecel = hasSuddenDeceleration(a);
  const bDecel = hasSuddenDeceleration(b);
  if (aDecel) { score += 0.3; reasons.push("A_decel"); }
  if (bDecel) { score += 0.3; reasons.push("B_decel"); }
  if (aDecel && bDecel) { score += 0.1; reasons.push("both_decel"); }

  // Signal 5: One stopped near the other
  const aStopped = wasFast(a) && isStopped(a);
  const bStopped = wasFast(b) && isStopped(b);
  if (aStopped && isStationary(a)) { score += 0.15; reasons.push("A_stopped"); }
  if (bStopped && isStationary(b)) { score += 0.15; reasons.push("B_stopped"); }

  // ===== PENALTIES =====
  const angleDiff = Math.abs(a.heading - b.heading);
  const wrapped = angleDiff > Math.PI ? 2 * Math.PI - angleDiff : angleDiff;
  if (wrapped < Math.PI * 0.3 && a.speed > 1 && b.speed > 1) {
    score -= 0.3;
    reasons.push("parallel");
  }

  if (score < 0.5) return null;

  return { score: Math.min(score, 1), reason: reasons.join("+") };
}

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

  pairs.sort((a, b) => a.distance - b.distance);
  return pairs;
}

export function detectPostImpact(entities: TrackedEntity[], ttcPairs: TTCPair[]): AccidentEvidence | null {
  // Scan ALL entity pairs, not just TTC pairs — objects may scatter after crash
  const candidates = entities.filter(e => e.age >= 3);

  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i], b = candidates[j];
      if (a.class === "person" && b.class === "person") continue;

      const d = dist(a, b);

      // Must be within reasonable distance (objects scatter after crash)
      if (d > 200) continue;

      // Both must be stopped
      if (!isStopped(a) || !isStopped(b)) continue;

      // Both must have been moving fast recently
      if (!wasFast(a) || !wasFast(b)) continue;

      // Both should be stationary (not just stopped — actually still)
      if (!isStationary(a) || !isStationary(b)) continue;

      // At least one must have been tracked for a while (not a flash detection)
      if (a.age < 5 || b.age < 5) continue;

      return {
        type: "post_impact",
        confidence: 0.9,
        objects: [a.id, b.id],
        details: `Both stopped after fast movement (dist: ${d.toFixed(0)}px)`,
      };
    }
  }
  return null;
}

export function detectAccidents(
  entities: TrackedEntity[],
  ttcPairs: TTCPair[]
): AccidentEvidence[] {
  const evidence: AccidentEvidence[] = [];

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

  const postImpact = detectPostImpact(entities, ttcPairs);
  if (postImpact) evidence.push(postImpact);

  for (const entity of entities) {
    // Bike fall near a vehicle
    if (isBikeFall(entity)) {
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
          details: `Bike fell near #${nearbyVehicle.id}`,
        });
      }
    }

    // Person fell: was moving fast, now stopped and low on screen (on ground)
    if (entity.class === "person" && wasFast(entity) && isStopped(entity) && isStationary(entity)) {
      if (entity.positions.length >= 3) {
        const lastY = entity.positions[entity.positions.length - 1].y;
        const prevY = entity.positions[entity.positions.length - 3].y;
        // Person dropped (fell to ground) or is in lower half of frame
        if (lastY > prevY + 3 || lastY > H * 0.6) {
          evidence.push({
            type: "bike_fall", // reuse type for person fall
            confidence: 0.7,
            objects: [entity.id],
            details: `Person fell (was fast, now stopped on ground)`,
          });
        }
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

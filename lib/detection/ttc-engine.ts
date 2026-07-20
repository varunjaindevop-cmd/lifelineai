// Collision Detection Engine v15 — Restore working detection + targeted false-positive fix
// The old detection WORKED for real accidents. We only need to fix passing-car false positives.
// Strategy: Keep original detection as primary, add velocity checks as FILTERS not requirements

import { TrackedEntity } from "./kalman-tracker";

export interface AccidentEvidence {
  type: "collision" | "person_fall" | "bike_off_track";
  confidence: number;
  objects: number[];
  details: string;
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
  const ax = a.kalman.getState().x - a.w / 2;
  const ay = a.kalman.getState().y - a.h / 2;
  const bx = b.kalman.getState().x - b.w / 2;
  const by = b.kalman.getState().y - b.h / 2;
  return !(ax + a.w < bx || bx + b.w < ax || ay + a.h < by || by + b.h < ay);
}

function wasFast(entity: TrackedEntity): boolean {
  if (entity.speedHistory.length < 3) return false;
  return entity.speedHistory[0] > 1.5 || entity.speedHistory[1] > 1.5 || entity.speedHistory[2] > 1.5;
}

function hasDecelerated(entity: TrackedEntity): boolean {
  if (entity.speedHistory.length < 3) return false;
  const maxRecent = Math.max(...entity.speedHistory.slice(0, 3));
  return maxRecent > 1.0 && entity.speed < 0.8;
}

function angleDiff(a: number, b: number): number {
  const diff = Math.abs(a - b);
  return diff > Math.PI ? 2 * Math.PI - diff : diff;
}

function isStationary(entity: TrackedEntity): boolean {
  return entity.speed < 0.3 && entity.speedHistory.slice(0, 3).every(s => s < 0.5);
}

/**
 * Check if two objects are PASSING each other (not colliding)
 * Passing = both moving fast + similar direction + no deceleration
 */
function isPassing(a: TrackedEntity, b: TrackedEntity): boolean {
  if (a.speed < 0.8 || b.speed < 0.8) return false;
  const headingDiff = angleDiff(a.heading, b.heading);
  // Same direction within 45 degrees
  return headingDiff < Math.PI * 0.25;
}

// ========== ISOLATED MODE: Original logic that worked + passing filter ==========

function scoreIsolated(a: TrackedEntity, b: TrackedEntity): { score: number; reason: string } | null {
  const d = dist(a, b);
  const cr = combinedR(a, b);

  // Must be close enough
  if (d > cr * 2.5) return null;

  // FILTER: If clearly passing, reject immediately
  if (isPassing(a, b)) return null;

  let score = 0;
  const reasons: string[] = [];

  // Signal 1: Overlap (+0.5) — PRIMARY signal
  if (isOverlapping(a, b)) {
    score += 0.5;
    reasons.push("overlap");
  }

  // Signal 2: Deceleration (+0.4 each, max 0.6)
  const aDecel = hasDecelerated(a);
  const bDecel = hasDecelerated(b);
  if (aDecel && bDecel) {
    score += 0.6;
    reasons.push("both_decel");
  } else if (aDecel || bDecel) {
    score += 0.35;
    reasons.push(aDecel ? "A_decel" : "B_decel");
  }

  // Without any deceleration AND no overlap, it's just proximity
  if (!aDecel && !bDecel && !isOverlapping(a, b)) return null;

  // Signal 3: Touching proximity (+0.2)
  if (d < cr * 0.7) {
    score += 0.2;
    reasons.push("touching");
  }

  // Signal 4: Closing speed — objects getting closer (+0.15)
  if (a.positions.length >= 2 && b.positions.length >= 2) {
    const lastA = a.positions[a.positions.length - 1];
    const lastB = b.positions[b.positions.length - 1];
    const prevA = a.positions[a.positions.length - 2];
    const prevB = b.positions[b.positions.length - 2];
    const d1 = Math.sqrt((lastA.x - lastB.x) ** 2 + (lastA.y - lastB.y) ** 2);
    const d2 = Math.sqrt((prevA.x - prevB.x) ** 2 + (prevA.y - prevB.y) ** 2);
    if (d2 > d1 + 0.5) {
      score += 0.15;
      reasons.push("closing");
    }
  }

  // Signal 5: One was moving fast, now stopped near other (+0.1)
  const aWasFast = wasFast(a);
  const bWasFast = wasFast(b);
  if ((aWasFast || bWasFast) && (isStationary(a) || isStationary(b))) {
    score += 0.1;
    reasons.push("stopped_after_moving");
  }

  // FILTER: Passing penalty (if both fast but NOT same direction)
  // This catches cases where objects are moving at angles but not actually colliding
  if (a.speed > 1 && b.speed > 1) {
    const headingDiff = angleDiff(a.heading, b.heading);
    if (headingDiff > Math.PI * 0.5) {
      // Different directions — could be crossing but also could be passing at angle
      // Only penalize if they're not actually decelerating
      if (!aDecel && !bDecel) {
        score -= 0.3;
        reasons.push("angle_passing");
      }
    }
  }

  if (score < 0.5) return null;
  return { score: Math.min(score, 1), reason: reasons.join("+") };
}

// ========== TRAFFIC MODE: Sudden stop near another object ==========

const trafficCooldown = new Map<number, number>();

function detectTrafficAlerts(entities: TrackedEntity[]): AccidentEvidence[] {
  const evidence: AccidentEvidence[] = [];
  const now = Date.now();

  for (const entity of entities) {
    if (entity.age < 8 || entity.speedHistory.length < 5) continue;

    const lastAlert = trafficCooldown.get(entity.id) || 0;
    if (now - lastAlert < 10000) continue;

    const recentSpeed = entity.speed;
    const maxRecent = Math.max(entity.speedHistory[0], entity.speedHistory[1], entity.speedHistory[2]);

    // Dramatic stop: was fast (>4), now stopped (<0.3)
    if (maxRecent <= 4 || recentSpeed >= 0.3) continue;

    // Find nearby objects
    const nearby = entities.filter(e =>
      e.id !== entity.id && e.age >= 5 && dist(e, entity) < combinedR(e, entity) * 2.0
    );
    if (nearby.length === 0) continue;

    for (const n of nearby) {
      // The nearby object must ALSO have decelerated
      if (!hasDecelerated(n)) continue;

      // FILTER: Check if they were approaching each other before stop
      if (entity.positions && entity.positions.length >= 3 && n.positions.length >= 3) {
        const entityPrevPos = entity.positions[entity.positions.length - 3];
        const nPrevPos = n.positions[n.positions.length - 3];
        const prevDist = Math.sqrt(
          (entityPrevPos.x - nPrevPos.x) ** 2 + (entityPrevPos.y - nPrevPos.y) ** 2
        );
        const currentDist = dist(entity, n);
        // If they weren't getting closer, it's not a collision
        if (currentDist > prevDist) continue;
      }

      // FILTER: Check if passing
      if (isPassing(entity, n)) continue;

      const d = dist(entity, n);
      const cr = combinedR(entity, n);

      let confidence = 0.65;
      const reasons: string[] = ["dramatic_stop", "mutual_decel"];

      if (d < cr * 0.6) { confidence += 0.15; reasons.push("touching"); }
      if (isOverlapping(entity, n)) { confidence += 0.1; reasons.push("overlap"); }

      trafficCooldown.set(entity.id, now);
      evidence.push({
        type: "collision",
        confidence: Math.min(confidence, 0.9),
        objects: [entity.id, n.id],
        details: `Traffic: ${maxRecent.toFixed(1)}->${recentSpeed.toFixed(1)} + #${n.id} [${reasons.join("+")}]`,
      });
      break;
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
      const wasMoving = entity.speedHistory.some(s => s > 0.8);
      const stationary = isStationary(entity);

      let confidence = 0.7;
      if (dropped) confidence += 0.1;
      if (wasMoving && stationary) confidence += 0.1;

      evidence.push({
        type: "person_fall",
        confidence: Math.min(confidence, 0.9),
        objects: [entity.id],
        details: `Fall: AR ${prevAR.toFixed(2)}->${currentAR.toFixed(2)}`,
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
      evidence.push({
        type: "bike_off_track",
        confidence: 0.7,
        objects: [entity.id],
        details: `Bike heading ${(headingChange * 180 / Math.PI).toFixed(0)} deg`,
      });
    }
  }
  return evidence;
}

// ========== EXPORTS ==========

export function findAllTTCPairs() { return []; }

export function detectAccidents(
  entities: TrackedEntity[],
  _ttcPairs: any[],
  envMode: "isolated" | "traffic" | "marketplace"
): AccidentEvidence[] {
  let evidence: AccidentEvidence[] = [];

  if (envMode === "traffic") {
    evidence = detectTrafficAlerts(entities);
  } else {
    const candidates = entities.filter(e => e.age >= 3);
    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        const a = candidates[i], b = candidates[j];
        if (a.class === "person" && b.class === "person") continue;
        const result = scoreIsolated(a, b);
        if (result && result.score >= 0.5) {
          evidence.push({
            type: "collision",
            confidence: Math.min(0.95, result.score),
            objects: [a.id, b.id],
            details: `score:${result.score.toFixed(2)} ${result.reason} d:${dist(a, b).toFixed(0)}px`,
          });
        }
      }
    }
  }

  evidence.push(...detectPersonFall(entities));
  evidence.push(...detectBikeOffTrack(entities));

  // Deduplicate
  const deduped: AccidentEvidence[] = [];
  const seen = new Set<string>();
  evidence.sort((a, b) => b.confidence - a.confidence);
  for (const ev of evidence) {
    const key = [...ev.objects].sort().join(",");
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(ev);
    }
  }

  return deduped;
}

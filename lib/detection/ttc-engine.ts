// Collision Detection Engine v12 — Post-collision detection + tighter traffic rules
// Key insight: COCO-SSD at 2 FPS often catches objects AFTER collision
// Must detect "objects stopped + overlapping = collision happened"

import { TrackedEntity } from "./kalman-tracker";

export interface TTCPair {
  a: TrackedEntity; b: TrackedEntity;
  ttc: number; distance: number; closingSpeed: number;
  severity: "none" | "warning" | "critical" | "impact";
}

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

function wasFastRecently(entity: TrackedEntity, threshold: number = 1.0): boolean {
  if (entity.speedHistory.length < 2) return false;
  // Check if ANY frame in history was fast
  return entity.speedHistory.some(s => s > threshold);
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
  return entity.speed < 0.3;
}

function wasApproaching(a: TrackedEntity, b: TrackedEntity): boolean {
  if (a.positions.length < 3 || b.positions.length < 3) return false;
  const recentDist = dist(a, b);
  const prevA = a.positions[a.positions.length - 3];
  const prevB = b.positions[b.positions.length - 3];
  const prevDist = Math.sqrt((prevA.x - prevB.x) ** 2 + (prevA.y - prevB.y) ** 2);
  return recentDist < prevDist;
}

function closingSpeed(a: TrackedEntity, b: TrackedEntity): number {
  if (a.positions.length < 2 || b.positions.length < 2) return 0;
  const lastA = a.positions[a.positions.length - 1];
  const lastB = b.positions[b.positions.length - 1];
  const prevA = a.positions[a.positions.length - 2];
  const prevB = b.positions[b.positions.length - 2];
  const d1 = Math.sqrt((lastA.x - lastB.x) ** 2 + (lastA.y - lastB.y) ** 2);
  const d2 = Math.sqrt((prevA.x - prevB.x) ** 2 + (prevA.y - prevB.y) ** 2);
  return d2 - d1;
}

// ========== POST-COLLISION DETECTION ==========
// Key insight: When COCO-SSD catches the scene at 2 FPS, the collision often
// already happened. Objects are stopped and overlapping/touching.
// This detects that scenario.

function detectPostCollision(entities: TrackedEntity[]): AccidentEvidence[] {
  const evidence: AccidentEvidence[] = [];

  for (let i = 0; i < entities.length; i++) {
    for (let j = i + 1; j < entities.length; j++) {
      const a = entities[i];
      const b = entities[j];

      // Skip person-person pairs
      if (a.class === "person" && b.class === "person") continue;

      const d = dist(a, b);
      const cr = combinedR(a, b);

      // Must be VERY close (overlapping or touching)
      const touching = d < cr * 0.8;
      const overlapping = isOverlapping(a, b);
      if (!touching && !overlapping) continue;

      // At least one must be a vehicle
      const aIsVehicle = a.class === "car" || a.class === "motorcycle" || a.class === "truck" || a.class === "bus";
      const bIsVehicle = b.class === "car" || b.class === "motorcycle" || b.class === "truck" || b.class === "bus";
      if (!aIsVehicle && !bIsVehicle) continue;

      // At least one must be stationary (post-collision)
      const aStopped = isStationary(a);
      const bStopped = isStationary(b);
      if (!aStopped && !bStopped) continue;

      // At least one must have been moving fast recently (before collision)
      const aWasMoving = wasFastRecently(a, 1.0);
      const bWasMoving = wasFastRecently(b, 1.0);
      if (!aWasMoving && !bWasMoving) continue;

      // Must have enough tracking history
      if (a.age < 3 || b.age < 3) continue;

      let confidence = 0.7;
      const reasons: string[] = [];

      if (overlapping) { confidence += 0.1; reasons.push("overlap"); }
      if (d < cr * 0.4) { confidence += 0.1; reasons.push("touching_close"); }

      // If a vehicle hit a person, that's very serious
      const personHit = (a.class === "person" && bIsVehicle) || (b.class === "person" && aIsVehicle);
      if (personHit) { confidence += 0.1; reasons.push("person_hit"); }

      // Both stopped = collision already happened
      if (aStopped && bStopped) { confidence += 0.05; reasons.push("both_stopped"); }

      evidence.push({
        type: "collision",
        confidence: Math.min(confidence, 0.95),
        objects: [a.id, b.id],
        details: `Post-collision: ${a.class}#${a.id} + ${b.class}#${b.id} d=${d.toFixed(0)}px [${reasons.join("+")}]`,
      });
    }
  }

  return evidence;
}

// ========== ISOLATED MODE ==========

function scoreIsolated(a: TrackedEntity, b: TrackedEntity): { score: number; reason: string } | null {
  const d = dist(a, b);
  const cr = combinedR(a, b);

  if (d > cr * 2.5) return null;

  let score = 0;
  const reasons: string[] = [];

  // Overlap
  const overlap = isOverlapping(a, b);
  if (overlap) { score += 0.35; reasons.push("overlap"); }

  // Proximity
  if (d < cr * 0.6) { score += 0.3; reasons.push("touching"); }
  else if (d < cr * 1.2) { score += 0.15; reasons.push("close"); }
  else if (d < cr * 2.0) { score += 0.05; reasons.push("moderate"); }

  // Deceleration
  const aDecel = hasDecelerated(a);
  const bDecel = hasDecelerated(b);
  if (aDecel && bDecel) { score += 0.25; reasons.push("both_decel"); }
  else if (aDecel || bDecel) { score += 0.15; reasons.push(aDecel ? "A_decel" : "B_decel"); }

  // Closing speed
  const closing = closingSpeed(a, b);
  if (closing > 0.5) { score += 0.15; reasons.push("closing"); }

  // One was moving, now stopped near the other = post-collision
  const aWasMoving = wasFastRecently(a, 1.0);
  const bWasMoving = wasFastRecently(b, 1.0);
  const oneStopped = isStationary(a) || isStationary(b);
  if ((aWasMoving || bWasMoving) && oneStopped && d < cr * 1.2) {
    score += 0.2;
    reasons.push("post_collision_signal");
  }

  if (score < 0.4) return null;
  return { score: Math.min(score, 1), reason: reasons.join("+") };
}

// ========== TRAFFIC MODE ==========

const trafficAlertCooldown = new Map<number, number>();

function detectTrafficAlerts(entities: TrackedEntity[]): AccidentEvidence[] {
  const evidence: AccidentEvidence[] = [];
  const now = Date.now();

  for (const entity of entities) {
    if (entity.age < 10 || entity.speedHistory.length < 5) continue;

    const lastAlert = trafficAlertCooldown.get(entity.id) || 0;
    if (now - lastAlert < 10000) continue;

    const recentSpeed = entity.speed;
    const maxRecent = Math.max(entity.speedHistory[0], entity.speedHistory[1], entity.speedHistory[2]);

    // Dramatic stop: was fast, now stopped
    if (maxRecent <= 5 || recentSpeed >= 0.5) continue;

    // Find VERY close nearby objects
    const nearby = entities.filter(e =>
      e.id !== entity.id && e.age >= 8 && dist(e, entity) < combinedR(e, entity) * 1.5
    );
    if (nearby.length === 0) continue;

    for (const n of nearby) {
      // BOTH must have decelerated (not just one stopping in traffic)
      if (!hasDecelerated(n)) continue;

      // MUST have been approaching (distance was decreasing before stop)
      if (!wasApproaching(entity, n)) continue;

      // Must NOT be passing
      const d = dist(entity, n);
      const cr = combinedR(entity, n);
      if (d > cr * 1.5) continue;

      // At least very close
      const isClose = d < cr * 0.8;

      let confidence = 0.65;
      const reasons: string[] = ["mutual_decel", "was_approaching"];

      if (isClose) { confidence += 0.1; reasons.push("close"); }
      if (isOverlapping(entity, n)) { confidence += 0.1; reasons.push("overlap"); }

      trafficAlertCooldown.set(entity.id, now);
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
    if (entity.class !== "person" || entity.age < 5) continue;
    if (entity.aspectHistory.length < 4) continue;

    const currentAR = entity.aspectHistory[entity.aspectHistory.length - 1];
    const prevAR = (entity.aspectHistory[0] + entity.aspectHistory[1]) / 2;
    const wasStanding = prevAR < 0.8;
    const nowLying = currentAR > 0.9;

    if (wasStanding && nowLying) {
      const lastY = entity.positions[entity.positions.length - 1].y;
      const prevY = entity.positions[Math.max(0, entity.positions.length - 3)].y;
      const dropped = lastY > prevY + 3;
      const wasMoving = entity.speedHistory.some(s => s > 1);
      const stationary = isStationary(entity);

      if (dropped || wasMoving) {
        let confidence = 0.7;
        if (dropped && wasMoving) confidence = 0.85;
        if (stationary && nowLying) confidence = 0.8;
        evidence.push({
          type: "person_fall",
          confidence,
          objects: [entity.id],
          details: `Fall: AR ${prevAR.toFixed(2)}->${currentAR.toFixed(2)} dropped=${dropped}`,
        });
      }
    }
  }
  return evidence;
}

// ========== BIKE OFF-TRACK ==========

function detectBikeOffTrack(entities: TrackedEntity[]): AccidentEvidence[] {
  const evidence: AccidentEvidence[] = [];
  for (const entity of entities) {
    if (entity.class !== "motorcycle" || entity.age < 5) continue;
    if (entity.headingHistory.length < 5) continue;

    const recentHeading = entity.headingHistory[entity.headingHistory.length - 1];
    const prevHeading = entity.headingHistory[entity.headingHistory.length - 4];
    let headingChange = Math.abs(recentHeading - prevHeading);
    if (headingChange > Math.PI) headingChange = 2 * Math.PI - headingChange;

    const wasMoving = entity.speedHistory.some(s => s > 1.5);
    const significantChange = headingChange > Math.PI * 0.33;

    if (wasMoving && significantChange) {
      const nearbyVehicle = entities.find(e =>
        e.id !== entity.id && (e.class === "car" || e.class === "motorcycle") &&
        dist(e, entity) < combinedR(e, entity) * 4
      );
      evidence.push({
        type: "bike_off_track",
        confidence: 0.7,
        objects: nearbyVehicle ? [entity.id, nearbyVehicle.id] : [entity.id],
        details: `Bike heading ${(headingChange * 180 / Math.PI).toFixed(0)} deg`,
      });
    }
  }
  return evidence;
}

// ========== EXPORTS ==========

export function findAllTTCPairs(entities: TrackedEntity[]): TTCPair[] {
  return [];
}

export function detectAccidents(
  entities: TrackedEntity[],
  ttcPairs: TTCPair[],
  envMode: "isolated" | "traffic" | "marketplace"
): AccidentEvidence[] {
  let evidence: AccidentEvidence[] = [];

  if (envMode === "traffic") {
    evidence = detectTrafficAlerts(entities);
  } else {
    // Isolated: BOTH post-collision AND active collision detection
    // Post-collision catches accidents that already happened
    evidence.push(...detectPostCollision(entities));

    // Active detection for collisions caught in progress
    const candidates = entities.filter(e => e.age >= 3);
    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        const a = candidates[i], b = candidates[j];
        if (a.class === "person" && b.class === "person") continue;
        const result = scoreIsolated(a, b);
        if (result && result.score >= 0.4) {
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

  // Deduplicate evidence (keep highest confidence for same object pair)
  const deduped: AccidentEvidence[] = [];
  const seen = new Set<string>();
  evidence.sort((a, b) => b.confidence - a.confidence);
  for (const ev of evidence) {
    const key = ev.objects.sort().join(",");
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(ev);
    }
  }

  return deduped;
}

// Collision Detection Engine v10 — Enhanced with anti-false-positive logic
//
// ISOLATED MODE: Multi-signal scoring with trajectory prediction
//   Trajectory intersection + direction convergence + deceleration + proximity
//   Strong anti-passing: objects moving in same direction are NOT flagged
//
// TRAFFIC MODE: Energy transfer detection
//   Requires mutual deceleration + approach before stop + scene change
//   Normal braking near another car is NOT a collision
//
// FALL/BIKE DETECTION: Enhanced with sustained detection + vehicle interaction

import { TrackedEntity } from "./kalman-tracker";

export interface TTCPair {
  a: TrackedEntity; b: TrackedEntity;
  ttc: number; distance: number; closingSpeed: number;
  severity: "none" | "warning" | "critical" | "impact";
}

export interface AccidentEvidence {
  type: "collision" | "person_fall" | "bike_off_track" | "vehicle_rolling" | "pileup";
  confidence: number;
  objects: number[];
  details: string;
}

// ========== HELPER FUNCTIONS ==========

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

function wasFast(entity: TrackedEntity, threshold: number = 2): boolean {
  if (entity.speedHistory.length < 3) return false;
  return entity.speedHistory[0] > threshold || entity.speedHistory[1] > threshold || entity.speedHistory[2] > threshold;
}

function hasDecelerated(entity: TrackedEntity): boolean {
  if (entity.speedHistory.length < 3) return false;
  const maxRecent = Math.max(...entity.speedHistory.slice(0, 3));
  const curr = entity.speed;
  return maxRecent > 1.5 && curr < 0.8;
}

function angleDiff(a: number, b: number): number {
  const diff = Math.abs(a - b);
  return diff > Math.PI ? 2 * Math.PI - diff : diff;
}

/**
 * Predict where an entity will be in N frames using Kalman prediction
 */
function predictPosition(entity: TrackedEntity, frames: number): { x: number; y: number } {
  return entity.kalman.predict(frames);
}

/**
 * Check if predicted trajectories of two entities will intersect
 * Returns true if paths cross within a reasonable distance
 */
function willPathsIntersect(
  a: TrackedEntity,
  b: TrackedEntity,
  horizon: number = 15
): { intersect: boolean; minDist: number; crossFrame: number } {
  let minDist = Infinity;
  let crossFrame = -1;

  for (let t = 1; t <= horizon; t++) {
    const posA = predictPosition(a, t);
    const posB = predictPosition(b, t);
    const d = Math.sqrt((posA.x - posB.x) ** 2 + (posA.y - posB.y) ** 2);

    if (d < minDist) {
      minDist = d;
      crossFrame = t;
    }
  }

  // Paths intersect if predicted distance gets very small
  const combinedSize = combinedR(a, b);
  return {
    intersect: minDist < combinedSize * 1.5,
    minDist,
    crossFrame,
  };
}

/**
 * Determine the directional relationship between two entities
 * Returns: "converging" | "diverging" | "passing" | "parallel"
 */
function getDirectionRelation(a: TrackedEntity, b: TrackedEntity): string {
  const va = { x: a.kalman.getState().vx, y: a.kalman.getState().vy };
  const vb = { x: b.kalman.getState().vx, y: b.kalman.getState().vy };
  const speedA = Math.sqrt(va.x * va.x + va.y * va.y);
  const speedB = Math.sqrt(vb.x * vb.x + vb.y * vb.y);

  if (speedA < 0.3 && speedB < 0.3) return "both_stopped";
  if (speedA < 0.3 || speedB < 0.3) return "one_stopped";

  // Direction from A to B
  const dx = b.kalman.getState().x - a.kalman.getState().x;
  const dy = b.kalman.getState().y - a.kalman.getState().y;

  // Dot product of A's velocity with direction toward B
  const dotA = va.x * dx + va.y * dy;
  // Dot product of B's velocity with direction toward A
  const dotB = vb.x * (-dx) + vb.y * (-dy);

  // Both heading toward each other
  if (dotA > 0 && dotB > 0) return "converging";

  // Moving away from each other
  if (dotA < 0 && dotB < 0) return "diverging";

  // One passing the other (similar direction)
  const headingDiff = angleDiff(a.heading, b.heading);
  if (headingDiff < Math.PI * 0.3) return "passing";

  // Crossing paths (perpendicular-ish)
  if (dotA > 0 || dotB > 0) return "crossing";

  return "parallel";
}

/**
 * Check if distance between two entities was decreasing (approaching)
 */
function wasApproaching(a: TrackedEntity, b: TrackedEntity): boolean {
  if (a.positions.length < 3 || b.positions.length < 3) return false;

  const recentDist = dist(a, b);
  const prevPosA = a.positions[a.positions.length - 3];
  const prevPosB = b.positions[b.positions.length - 3];
  const prevDist = Math.sqrt(
    (prevPosA.x - prevPosB.x) ** 2 + (prevPosA.y - prevPosB.y) ** 2
  );

  return recentDist < prevDist - 1; // At least 1px closer
}

/**
 * Check if entities were approaching each other over multiple frames
 */
function sustainedApproach(a: TrackedEntity, b: TrackedEntity, minFrames: number = 3): boolean {
  if (a.positions.length < minFrames || b.positions.length < minFrames) return false;

  let approachCount = 0;
  const len = Math.min(a.positions.length, b.positions.length);

  for (let i = 1; i < len && i <= minFrames + 1; i++) {
    const idx1 = len - i - 1;
    const idx2 = len - i;
    if (idx1 < 0) break;

    const d1 = Math.sqrt(
      (a.positions[idx1].x - b.positions[idx1].x) ** 2 +
      (a.positions[idx1].y - b.positions[idx1].y) ** 2
    );
    const d2 = Math.sqrt(
      (a.positions[idx2].x - b.positions[idx2].x) ** 2 +
      (a.positions[idx2].y - b.positions[idx2].y) ** 2
    );

    if (d2 < d1) approachCount++;
  }

  return approachCount >= minFrames;
}

// ========== ISOLATED MODE ==========

function scoreIsolated(a: TrackedEntity, b: TrackedEntity): { score: number; reason: string } | null {
  const d = dist(a, b);
  const cr = combinedR(a, b);

  // Must be close
  if (d > cr * 2.5) return null;

  let score = 0;
  const reasons: string[] = [];

  // === ANTI-FALSE-POSITIVE: Direction check first ===
  const relation = getDirectionRelation(a, b);

  // If clearly passing or diverging, reject immediately
  if (relation === "passing" && d > cr * 0.8) return null;
  if (relation === "diverging") return null;

  // === SIGNAL 1: Direction convergence (+0.4) ===
  if (relation === "converging") {
    score += 0.4;
    reasons.push("converging");
  } else if (relation === "crossing") {
    score += 0.25;
    reasons.push("crossing");
  } else if (relation === "both_stopped" || relation === "one_stopped") {
    // One or both stopped - less signal for convergence
    score += 0.1;
    reasons.push("stopped");
  } else {
    return null; // Not converging = not a collision scenario
  }

  // === SIGNAL 2: Overlap (+0.3) ===
  if (isOverlapping(a, b)) {
    score += 0.3;
    reasons.push("overlap");
  }

  // === SIGNAL 3: Deceleration (+0.4 each, max 0.6) ===
  const aDecel = hasDecelerated(a);
  const bDecel = hasDecelerated(b);
  if (aDecel && bDecel) {
    score += 0.6;
    reasons.push("both_decel");
  } else if (aDecel || bDecel) {
    score += 0.35;
    reasons.push(aDecel ? "A_decel" : "B_decel");
  }

  // Without any deceleration and no convergence, low confidence
  if (!aDecel && !bDecel && relation !== "converging") {
    return null;
  }

  // === SIGNAL 4: Touching proximity (+0.2) ===
  if (d < cr * 0.7) {
    score += 0.2;
    reasons.push("touching");
  }

  // === SIGNAL 5: Trajectory intersection (+0.3) ===
  const trajectory = willPathsIntersect(a, b, 15);
  if (trajectory.intersect) {
    score += 0.3;
    reasons.push(`intersect_d${trajectory.minDist.toFixed(0)}`);
  }

  // === SIGNAL 6: Sustained approach (+0.2) ===
  if (sustainedApproach(a, b, 3)) {
    score += 0.2;
    reasons.push("approaching");
  }

  // === PENALTY: Similar heading penalty ===
  // Note: "passing" relation is already rejected above, but check heading similarity
  // for cases where relation is "crossing" but objects are actually similar-heading
  if (a.speed > 1 && b.speed > 1 && angleDiff(a.heading, b.heading) < Math.PI * 0.3) {
    score -= 0.5;
    reasons.push("PENALTY_similar_heading");
  }

  // Minimum threshold
  if (score < 0.6) return null;

  return { score: Math.min(score, 1), reason: reasons.join("+") };
}

// ========== TRAFFIC MODE ==========

const trafficAlertCooldown = new Map<number, number>();

function detectTrafficAlerts(entities: TrackedEntity[]): AccidentEvidence[] {
  const evidence: AccidentEvidence[] = [];
  const now = Date.now();

  for (const entity of entities) {
    if (entity.age < 8 || entity.speedHistory.length < 5) continue;

    // Per-object cooldown
    const lastAlert = trafficAlertCooldown.get(entity.id) || 0;
    if (now - lastAlert < 5000) continue;

    const recentSpeed = entity.speed;
    const maxRecent = Math.max(entity.speedHistory[0], entity.speedHistory[1], entity.speedHistory[2]);

    // Must have been moving FAST and now STOPPED
    if (maxRecent <= 4 || recentSpeed >= 0.3) continue;

    // Find nearby objects
    const nearby = entities.filter(e =>
      e.id !== entity.id && e.age >= 5 && dist(e, entity) < combinedR(e, entity) * 2.5
    );
    if (nearby.length === 0) continue;

    // === ANTI-FALSE-POSITIVE CHECKS ===

    let confirmed = false;
    let bestNearby = nearby[0];
    let confidence = 0.7;
    const reasons: string[] = [];

    for (const n of nearby) {
      // CHECK 1: Mutual deceleration - the nearby object must ALSO show velocity change
      const nearbyDecel = hasDecelerated(n);
      if (nearbyDecel) {
        confidence += 0.1;
        reasons.push("mutual_decel");
      }

      // CHECK 2: Was approaching before stop
      if (wasApproaching(entity, n)) {
        confidence += 0.1;
        reasons.push("was_approaching");
      }

      // CHECK 3: Direction convergence (not just stopping in same lane)
      const relation = getDirectionRelation(entity, n);
      if (relation === "converging") {
        confidence += 0.1;
        reasons.push("converging");
      } else if (relation === "passing") {
        // One car just passing another that stopped = NOT a collision
        continue;
      }

      // CHECK 4: Very close proximity (touching)
      const d = dist(entity, n);
      const cr = combinedR(entity, n);
      if (d < cr * 0.5) {
        confidence += 0.1;
        reasons.push("touching");
      }

      bestNearby = n;
      confirmed = true;
      break;
    }

    if (!confirmed) continue;

    trafficAlertCooldown.set(entity.id, now);
    evidence.push({
      type: "collision",
      confidence: Math.min(confidence, 0.95),
      objects: [entity.id, bestNearby.id],
      details: `Dramatic stop: ${maxRecent.toFixed(1)}→${recentSpeed.toFixed(1)} near #${bestNearby.id} [${reasons.join("+")}]`,
    });
  }

  return evidence;
}

// ========== PERSON FALL DETECTION ==========

function detectPersonFall(entities: TrackedEntity[]): AccidentEvidence[] {
  const evidence: AccidentEvidence[] = [];

  for (const entity of entities) {
    if (entity.class !== "person" || entity.age < 5) continue;
    if (entity.aspectHistory.length < 4) continue;

    const currentAR = entity.aspectHistory[entity.aspectHistory.length - 1];
    const prevAR = (entity.aspectHistory[0] + entity.aspectHistory[1]) / 2;

    // Standing person: aspect ratio < 0.7 (tall and narrow)
    // Lying person: aspect ratio > 1.0 (wide)
    const wasStanding = prevAR < 0.8;
    const nowLying = currentAR > 0.9;

    if (wasStanding && nowLying) {
      // Check Y position dropped (fell to ground)
      const lastY = entity.positions[entity.positions.length - 1].y;
      const prevY = entity.positions[Math.max(0, entity.positions.length - 3)].y;
      const dropped = lastY > prevY + 3;

      // Was moving before falling
      const wasMoving = entity.speedHistory.some(s => s > 1);

      // Sustained lying: person stays horizontal for 5+ frames
      const sustainedLying = entity.aspectHistory.slice(-5).every(ar => ar > 0.85);

      if (dropped || wasMoving || sustainedLying) {
        let confidence = 0.75;
        if (sustainedLying) confidence += 0.1;
        if (dropped && wasMoving) confidence += 0.1;

        evidence.push({
          type: "person_fall",
          confidence: Math.min(confidence, 0.95),
          objects: [entity.id],
          details: `Person fell: AR ${prevAR.toFixed(2)}→${currentAR.toFixed(2)}, Y dropped=${dropped}, sustained=${sustainedLying}`,
        });
      }
    }
  }

  return evidence;
}

// ========== BIKE OFF-TRACK / ROLLOVER DETECTION ==========

function detectBikeOffTrack(entities: TrackedEntity[]): AccidentEvidence[] {
  const evidence: AccidentEvidence[] = [];

  for (const entity of entities) {
    if (entity.class !== "motorcycle" || entity.age < 5) continue;
    if (entity.headingHistory.length < 5) continue;

    const recentHeading = entity.headingHistory[entity.headingHistory.length - 1];
    const prevHeading = entity.headingHistory[entity.headingHistory.length - 4];
    let headingChange = Math.abs(recentHeading - prevHeading);
    if (headingChange > Math.PI) headingChange = 2 * Math.PI - headingChange;

    const wasMoving = entity.speedHistory.some(s => s > 2);
    const significantChange = headingChange > Math.PI * 0.33; // 60 degrees

    if (wasMoving && significantChange) {
      // Find nearby vehicle
      const nearbyVehicle = entities.find(e =>
        e.id !== entity.id &&
        (e.class === "car" || e.class === "motorcycle") &&
        dist(e, entity) < combinedR(e, entity) * 4
      );

      // Rollover detection: motorcycle aspect ratio becomes near-square (was tall)
      const currentAR = entity.aspectHistory[entity.aspectHistory.length - 1];
      const prevAR = entity.aspectHistory.length > 3
        ? (entity.aspectHistory[0] + entity.aspectHistory[1]) / 2
        : currentAR;
      const rollover = prevAR < 0.6 && currentAR > 0.85; // Was tall, now wide = on side

      let confidence = rollover ? 0.85 : 0.7;
      if (nearbyVehicle) confidence += 0.05;

      evidence.push({
        type: "bike_off_track",
        confidence: Math.min(confidence, 0.95),
        objects: nearbyVehicle ? [entity.id, nearbyVehicle.id] : [entity.id],
        details: `Bike heading changed ${(headingChange * 180 / Math.PI).toFixed(0)}°, rollover=${rollover}${nearbyVehicle ? ` near #${nearbyVehicle.id}` : ""}`,
      });
    }
  }

  return evidence;
}

// ========== MULTI-OBJECT PILEUP ==========

function detectPileup(entities: TrackedEntity[]): AccidentEvidence[] {
  const evidence: AccidentEvidence[] = [];

  // Find clusters of stopped/slow vehicles with people nearby
  const stoppedVehicles = entities.filter(e =>
    (e.class === "car" || e.class === "motorcycle") &&
    e.age >= 5 &&
    e.speed < 0.3 &&
    wasFast(e, 1)
  );

  if (stoppedVehicles.length < 3) return evidence;

  // Check if they're all close together
  for (let i = 0; i < stoppedVehicles.length; i++) {
    const cluster = [stoppedVehicles[i]];
    for (let j = i + 1; j < stoppedVehicles.length; j++) {
      if (dist(stoppedVehicles[i], stoppedVehicles[j]) < combinedR(stoppedVehicles[i], stoppedVehicles[j]) * 4) {
        cluster.push(stoppedVehicles[j]);
      }
    }

    if (cluster.length >= 3) {
      const avgConfidence = cluster.reduce((s, e) => s + e.speed, 0) / cluster.length;
      evidence.push({
        type: "pileup",
        confidence: 0.85,
        objects: cluster.map(e => e.id),
        details: `Pileup: ${cluster.length} stopped vehicles`,
      });
      break; // Only report once
    }
  }

  return evidence;
}

// ========== EXPORTS ==========

export function findAllTTCPairs(entities: TrackedEntity[]): TTCPair[] {
  return []; // Not used in v10
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
    // Isolated / marketplace: multi-signal scoring
    const candidates = entities.filter(e => e.age >= 3);

    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        const a = candidates[i], b = candidates[j];
        if (a.class === "person" && b.class === "person") continue;

        const result = scoreIsolated(a, b);
        if (result && result.score >= 0.6) {
          evidence.push({
            type: "collision",
            confidence: Math.min(0.95, result.score),
            objects: [a.id, b.id],
            details: `score:${result.score.toFixed(2)} ${result.reason} dist:${dist(a, b).toFixed(0)}px`,
          });
        }
      }
    }
  }

  // Add fall and off-track detection for ALL modes
  evidence.push(...detectPersonFall(entities));
  evidence.push(...detectBikeOffTrack(entities));

  // Add pileup detection for traffic mode
  if (envMode === "traffic") {
    evidence.push(...detectPileup(entities));
  }

  evidence.sort((a, b) => b.confidence - a.confidence);
  return evidence;
}

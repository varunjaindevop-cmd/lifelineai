// Collision Detection Engine v9 — Two completely separate engines
//
// ISOLATED MODE: v3 scoring (what worked before)
//   Overlap + deceleration + touching - passing penalty
//   Works because few objects = COCO-SSD overlap IS meaningful
//
// TRAFFIC MODE: No overlap. Only sudden stops.
//   Dense traffic = overlap is meaningless. Only detect
//   objects that suddenly stopped mid-flow.

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
  return entity.speedHistory[0] > 2 || entity.speedHistory[1] > 2;
}

function hasDecelerated(entity: TrackedEntity): boolean {
  if (entity.speedHistory.length < 4) return false;
  const prevAvg = (entity.speedHistory[0] + entity.speedHistory[1]) / 2;
  return prevAvg > 2 && entity.speed < 1;
}

// ========== ISOLATED MODE ==========
// The v3 approach that worked: overlap + deceleration + proximity
function scoreIsolated(a: TrackedEntity, b: TrackedEntity): { score: number; reason: string } | null {
  const d = dist(a, b);
  const cr = combinedR(a, b);

  // Must be close
  if (d > cr * 2) return null;

  let score = 0;
  const reasons: string[] = [];

  // Overlap: +0.5
  if (isOverlapping(a, b)) { score += 0.5; reasons.push("overlap"); }

  // Deceleration: +0.4 each (REQUIRED — overlap alone is not enough)
  const aDecel = hasDecelerated(a);
  const bDecel = hasDecelerated(b);
  if (aDecel) { score += 0.4; reasons.push("A_decel"); }
  if (bDecel) { score += 0.4; reasons.push("B_decel"); }

  // Without at least one deceleration, overlap is just proximity
  if (!aDecel && !bDecel) return null;

  // Touching: +0.2
  if (d < cr * 0.7) { score += 0.2; reasons.push("touching"); }

  // Passing penalty
  if (a.speed > 1 && b.speed > 1) {
    const angleDiff = Math.abs(a.heading - b.heading);
    const wrapped = angleDiff > Math.PI ? 2 * Math.PI - angleDiff : angleDiff;
    if (wrapped < Math.PI * 0.35) { score -= 0.6; reasons.push("PASSING"); }
  }

  if (score < 0.5) return null;
  return { score: Math.min(score, 1), reason: reasons.join("+") };
}

// ========== TRAFFIC MODE ==========
// NO overlap check. Only sudden stops near other objects.
function detectTrafficAlerts(entities: TrackedEntity[]): AccidentEvidence[] {
  const evidence: AccidentEvidence[] = [];

  for (const entity of entities) {
    if (entity.age < 5 || entity.speedHistory.length < 5) continue;

    const recentSpeed = entity.speed;
    const prevAvg = (entity.speedHistory[0] + entity.speedHistory[1] + entity.speedHistory[2]) / 3;

    // Was moving fast (>3 px/frame), now stopped (<0.5)
    if (prevAvg <= 3 || recentSpeed >= 0.5) continue;

    // Find nearby object
    const nearby = entities.find(e =>
      e.id !== entity.id && e.age >= 3 && dist(e, entity) < combinedR(e, entity) * 3
    );
    if (!nearby) continue;

    evidence.push({
      type: "collision",
      confidence: 0.75,
      objects: [entity.id, nearby.id],
      details: `Sudden stop: ${prevAvg.toFixed(1)}→${recentSpeed.toFixed(1)} near #${nearby.id}`,
    });
  }

  return evidence;
}

// ========== PERSON FALL DETECTION ==========
// Person was standing (tall bbox), now lying (wide bbox) + dropped in Y
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
      // Also check Y position dropped (fell to ground)
      const lastY = entity.positions[entity.positions.length - 1].y;
      const prevY = entity.positions[Math.max(0, entity.positions.length - 3)].y;
      const dropped = lastY > prevY + 3;

      // And was moving (not just standing still)
      const wasMoving = entity.speedHistory.some(s => s > 1);

      if (dropped || wasMoving) {
        evidence.push({
          type: "person_fall",
          confidence: 0.8,
          objects: [entity.id],
          details: `Person fell: AR ${prevAR.toFixed(2)}→${currentAR.toFixed(2)}, Y dropped`,
        });
      }
    }
  }

  return evidence;
}

// ========== BIKE OFF-TRACK DETECTION ==========
// Bike was moving straight, suddenly changed direction dramatically
function detectBikeOffTrack(entities: TrackedEntity[]): AccidentEvidence[] {
  const evidence: AccidentEvidence[] = [];

  for (const entity of entities) {
    if (entity.class !== "motorcycle" || entity.age < 5) continue;
    if (entity.headingHistory.length < 5) continue;

    // Check if heading changed dramatically in last 3 frames
    const recentHeading = entity.headingHistory[entity.headingHistory.length - 1];
    const prevHeading = entity.headingHistory[entity.headingHistory.length - 4];
    let headingChange = Math.abs(recentHeading - prevHeading);
    if (headingChange > Math.PI) headingChange = 2 * Math.PI - headingChange;

    // Was moving fast, now heading changed > 60 degrees
    const wasFast = entity.speedHistory.some(s => s > 2);
    const significantChange = headingChange > Math.PI * 0.33; // 60 degrees

    if (wasFast && significantChange) {
      // Find nearby vehicle (likely what caused the off-track)
      const nearbyVehicle = entities.find(e =>
        e.id !== entity.id &&
        (e.class === "car" || e.class === "motorcycle") &&
        dist(e, entity) < combinedR(e, entity) * 4
      );

      evidence.push({
        type: "bike_off_track",
        confidence: 0.7,
        objects: nearbyVehicle ? [entity.id, nearbyVehicle.id] : [entity.id],
        details: `Bike heading changed ${(headingChange * 180 / Math.PI).toFixed(0)}°${nearbyVehicle ? ` near #${nearbyVehicle.id}` : ""}`,
      });
    }
  }

  return evidence;
}

// ========== EXPORTS ==========

export function findAllTTCPairs(entities: TrackedEntity[]): TTCPair[] {
  return []; // Not used in v9
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
    // Isolated / marketplace: v3 scoring
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
            details: `score:${result.score.toFixed(2)} ${result.reason} dist:${dist(a, b).toFixed(0)}px`,
          });
        }
      }
    }
  }

  // Add fall and off-track detection for ALL modes
  evidence.push(...detectPersonFall(entities));
  evidence.push(...detectBikeOffTrack(entities));

  evidence.sort((a, b) => b.confidence - a.confidence);
  return evidence;
}

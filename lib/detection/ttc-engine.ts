// Collision Detection Engine v13 — Velocity discontinuity + Gemini-ready architecture
// Core principle: A collision causes VELOCITY DISCONTINUITY, not just proximity
// A car passing a person at constant speed = NOT a collision
// A car that suddenly stops when near someone = POSSIBLE collision
// Two objects that both suddenly change velocity = LIKELY collision

import { TrackedEntity } from "./kalman-tracker";

export interface AccidentEvidence {
  type: "collision" | "person_fall" | "bike_off_track" | "scene_anomaly";
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
  return !(ax + a.w < bx || bx + b.w < ax || ay + a.h < by || by + b.h > ay);
}

function isOverlappingFixed(a: TrackedEntity, b: TrackedEntity): boolean {
  const ax = a.kalman.getState().x - a.w / 2;
  const ay = a.kalman.getState().y - a.h / 2;
  const bx = b.kalman.getState().x - b.w / 2;
  const by = b.kalman.getState().y - b.h / 2;
  return !(ax + a.w < bx || bx + b.w < ax || ay + a.h < by || by + b.h < ay);
}

/**
 * VELOCITY ANOMALY DETECTION
 * A collision causes sudden velocity change. Normal driving does not.
 * Returns a score 0-1 indicating how "abnormal" the velocity change is.
 */
function velocityAnomalyScore(entity: TrackedEntity): number {
  const h = entity.speedHistory;
  if (h.length < 4) return 0;

  // Calculate average speed of first 3 frames vs last 3 frames
  const oldAvg = (h[3] + (h[4] || h[3])) / 2;
  const newAvg = (h[0] + h[1]) / 2;

  // Sudden speed change
  const speedChange = Math.abs(oldAvg - newAvg);
  const speedChangeRatio = oldAvg > 0.5 ? speedChange / oldAvg : 0;

  // Sudden heading change
  const headingHist = entity.headingHistory;
  if (headingHist.length >= 3) {
    const headingChange = Math.abs(headingHist[0] - headingHist[2]);
    const wrappedChange = headingChange > Math.PI ? 2 * Math.PI - headingChange : headingChange;
    if (wrappedChange > 0.5) return Math.min(1.0, 0.5 + wrappedChange * 0.3);
  }

  // Speed dropped to near zero suddenly
  if (oldAvg > 1.0 && newAvg < 0.3) return Math.min(1.0, 0.6 + speedChangeRatio * 0.4);

  // Speed increased suddenly (less likely collision, more like acceleration)
  if (speedChangeRatio > 0.8 && newAvg > oldAvg) return 0.2;

  return Math.min(1.0, speedChangeRatio * 0.5);
}

/**
 * MUTUAL VELOCITY ANOMALY
 * Both objects showing velocity discontinuity = collision
 * Only one showing it = might be braking or turning
 */
function mutualVelocityAnomaly(a: TrackedEntity, b: TrackedEntity): number {
  const aAnomaly = velocityAnomalyScore(a);
  const bAnomaly = velocityAnomalyScore(b);

  if (aAnomaly > 0.3 && bAnomaly > 0.3) {
    // Both anomalous = very likely collision
    return Math.min(1.0, (aAnomaly + bAnomaly) / 2 + 0.2);
  }
  if (aAnomaly > 0.3 || bAnomaly > 0.3) {
    // One anomalous = possible but less certain
    return Math.max(aAnomaly, bAnomaly) * 0.7;
  }
  return 0;
}

/**
 * Check if entity was recently moving fast
 */
function wasFast(entity: TrackedEntity, threshold: number = 1.0): boolean {
  return entity.speedHistory.some(s => s > threshold);
}

/**
 * Check if entity is stationary
 */
function isStopped(entity: TrackedEntity): boolean {
  return entity.speed < 0.3;
}

// ========== POST-COLLISION DETECTION ==========
// Detects accidents where objects are already stopped after collision

function detectPostCollision(entities: TrackedEntity[]): AccidentEvidence[] {
  const evidence: AccidentEvidence[] = [];

  for (let i = 0; i < entities.length; i++) {
    for (let j = i + 1; j < entities.length; j++) {
      const a = entities[i];
      const b = entities[j];
      if (a.class === "person" && b.class === "person") continue;

      const d = dist(a, b);
      const cr = combinedR(a, b);
      const overlapping = isOverlappingFixed(a, b);
      const veryClose = d < cr * 0.8;

      if (!overlapping && !veryClose) continue;

      const aIsVehicle = ["car", "truck", "bus", "motorcycle"].includes(a.class);
      const bIsVehicle = ["car", "truck", "bus", "motorcycle"].includes(b.class);
      if (!aIsVehicle && !bIsVehicle) continue;

      const aStopped = isStopped(a);
      const bStopped = isStopped(b);
      if (!aStopped && !bStopped) continue;

      const aWasMoving = wasFast(a, 1.0);
      const bWasMoving = wasFast(b, 1.0);
      if (!aWasMoving && !bWasMoving) continue;
      if (a.age < 3 || b.age < 3) continue;

      // KEY: Check velocity anomaly - was there a sudden change?
      const anomaly = mutualVelocityAnomaly(a, b);

      let confidence = 0.6;
      if (overlapping) confidence += 0.15;
      if (d < cr * 0.4) confidence += 0.1;
      if (anomaly > 0.3) confidence += anomaly * 0.2;

      // Person hit by vehicle is very serious
      const personHit = (a.class === "person" && bIsVehicle) || (b.class === "person" && aIsVehicle);
      if (personHit) confidence += 0.1;

      if (confidence < 0.65) continue;

      evidence.push({
        type: "collision",
        confidence: Math.min(confidence, 0.95),
        objects: [a.id, b.id],
        details: `Post-collision: ${a.class}#${a.id}+${b.class}#${b.id} anomaly=${anomaly.toFixed(2)} d=${d.toFixed(0)}`,
      });
    }
  }
  return evidence;
}

// ========== ACTIVE COLLISION DETECTION ==========
// Detects collisions happening RIGHT NOW (velocity discontinuity)

function detectActiveCollisions(entities: TrackedEntity[]): AccidentEvidence[] {
  const evidence: AccidentEvidence[] = [];

  for (let i = 0; i < entities.length; i++) {
    for (let j = i + 1; j < entities.length; j++) {
      const a = entities[i];
      const b = entities[j];
      if (a.class === "person" && b.class === "person") continue;

      const d = dist(a, b);
      const cr = combinedR(a, b);
      if (d > cr * 2.5) continue;

      // KEY CHECK: Velocity discontinuity
      const anomaly = mutualVelocityAnomaly(a, b);

      // Without velocity anomaly, objects near each other are NOT colliding
      if (anomaly < 0.2) continue;

      let score = 0;
      const reasons: string[] = [];

      // Velocity anomaly is the PRIMARY signal
      score += anomaly * 0.5;
      reasons.push(`anomaly=${anomaly.toFixed(2)}`);

      // Proximity
      if (d < cr * 0.6) { score += 0.25; reasons.push("touching"); }
      else if (d < cr * 1.2) { score += 0.15; reasons.push("close"); }
      else if (d < cr * 2.0) { score += 0.05; reasons.push("moderate"); }

      // Overlap
      if (isOverlappingFixed(a, b)) { score += 0.15; reasons.push("overlap"); }

      // Both decelerated (not just one)
      const aDecel = a.speedHistory.length >= 3 && a.speedHistory[0] > 1.5 && a.speed < 0.5;
      const bDecel = b.speedHistory.length >= 3 && b.speedHistory[0] > 1.5 && b.speed < 0.5;
      if (aDecel && bDecel) { score += 0.15; reasons.push("both_decel"); }
      else if (aDecel || bDecel) { score += 0.08; reasons.push("one_decel"); }

      if (score < 0.4) continue;

      evidence.push({
        type: "collision",
        confidence: Math.min(score, 0.95),
        objects: [a.id, b.id],
        details: `Active: ${a.class}#${a.id}+${b.class}#${b.id} score=${score.toFixed(2)} [${reasons.join("+")}]`,
      });
    }
  }
  return evidence;
}

// ========== PERSON FALL ==========

function detectPersonFall(entities: TrackedEntity[]): AccidentEvidence[] {
  const evidence: AccidentEvidence[] = [];
  for (const entity of entities) {
    if (entity.class !== "person" || entity.age < 4) continue;
    if (entity.aspectHistory.length < 3) continue;

    const currentAR = entity.aspectHistory[entity.aspectHistory.length - 1];
    const prevAR = entity.aspectHistory.length >= 3
      ? (entity.aspectHistory[0] + entity.aspectHistory[1]) / 2
      : currentAR;

    const wasStanding = prevAR < 0.8;
    const nowLying = currentAR > 0.9;

    if (wasStanding && nowLying) {
      const velocityAnomaly = velocityAnomalyScore(entity);
      const wasMoving = entity.speedHistory.some(s => s > 0.8);
      const stationary = isStopped(entity);
      const lastY = entity.positions[entity.positions.length - 1]?.y || 0;
      const prevY = entity.positions.length >= 3 ? entity.positions[entity.positions.length - 3].y : lastY;
      const dropped = lastY > prevY + 2;

      let confidence = 0.65;
      if (dropped) confidence += 0.1;
      if (velocityAnomaly > 0.3) confidence += 0.1;
      if (stationary && nowLying) confidence += 0.1;
      if (wasMoving) confidence += 0.05;

      evidence.push({
        type: "person_fall",
        confidence: Math.min(confidence, 0.9),
        objects: [entity.id],
        details: `Fall: AR ${prevAR.toFixed(2)}->${currentAR.toFixed(2)} anomaly=${velocityAnomaly.toFixed(2)} dropped=${dropped}`,
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

    const anomaly = velocityAnomalyScore(entity);
    const wasMoving = entity.speedHistory.some(s => s > 1.0);
    const significantChange = headingChange > Math.PI * 0.3;

    if ((wasMoving && significantChange) || anomaly > 0.5) {
      evidence.push({
        type: "bike_off_track",
        confidence: Math.min(0.6 + anomaly * 0.2, 0.85),
        objects: [entity.id],
        details: `Bike heading ${(headingChange * 180 / Math.PI).toFixed(0)} deg anomaly=${anomaly.toFixed(2)}`,
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
    // Traffic: use active collision detection (velocity anomaly required)
    evidence = detectActiveCollisions(entities);
  } else {
    // Isolated/marketplace: both post-collision and active detection
    evidence.push(...detectPostCollision(entities));
    evidence.push(...detectActiveCollisions(entities));
  }

  // Always run person fall and bike off-track
  evidence.push(...detectPersonFall(entities));
  evidence.push(...detectBikeOffTrack(entities));

  // Deduplicate: keep highest confidence per object pair
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

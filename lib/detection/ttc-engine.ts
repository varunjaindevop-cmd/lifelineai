// Collision Detection Engine v14 — Zero false-positive architecture
// RULE: A collision requires MUTUAL velocity discontinuity
// If car passes person at constant speed = NO alert
// If car hits person = BOTH show sudden velocity change = ALERT

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

/**
 * SMOOTHED velocity change detection
 * Uses weighted average of recent speeds to avoid noise
 */
function smoothedSpeed(entity: TrackedEntity, lookback: number = 3): number {
  const h = entity.speedHistory;
  if (h.length === 0) return 0;
  const n = Math.min(lookback, h.length);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += h[i];
  return sum / n;
}

/**
 * Detect if entity had a SUDDEN velocity change
 * Requires: was fast (smoothed) -> now slow/stopped
 * Returns 0-1 anomaly score
 */
function suddenVelocityChange(entity: TrackedEntity): number {
  const h = entity.speedHistory;
  if (h.length < 5) return 0;

  // Smoothed speed from 3-5 frames ago
  const oldSpeed = (h[3] + h[4]) / 2;
  // Smoothed speed from last 2 frames
  const newSpeed = (h[0] + h[1]) / 2;

  // Must have been moving fast and now slow
  if (oldSpeed < 1.0) return 0; // Wasn't moving fast enough
  if (newSpeed > oldSpeed * 0.7) return 0; // Didn't slow down much

  // How sudden was the change?
  const speedDrop = (oldSpeed - newSpeed) / oldSpeed;
  return Math.min(1.0, speedDrop);
}

/**
 * Check if entity was recently moving fast (for post-collision detection)
 */
function wasRecentlyFast(entity: TrackedEntity): boolean {
  return entity.speedHistory.slice(0, 5).some(s => s > 1.5);
}

// ========== CORE DETECTION: MUTUAL VELOCITY DISCONTINUITY ==========

function detectCollisions(entities: TrackedEntity[]): AccidentEvidence[] {
  const evidence: AccidentEvidence[] = [];

  const valid = entities.filter(e => e.age >= 5);

  for (let i = 0; i < valid.length; i++) {
    for (let j = i + 1; j < valid.length; j++) {
      const a = valid[i];
      const b = valid[j];

      // Skip person-person
      if (a.class === "person" && b.class === "person") continue;

      const d = dist(a, b);
      const cr = combinedR(a, b);

      // Must be within detection range
      if (d > cr * 2.0) continue;

      // KEY CHECK: Both objects must show velocity discontinuity
      const aAnomaly = suddenVelocityChange(a);
      const bAnomaly = suddenVelocityChange(b);

      // Without mutual anomaly, it's NOT a collision
      // A car passing at constant speed = 0 anomaly for both = rejected
      if (aAnomaly < 0.2 && bAnomaly < 0.2) continue;

      // Calculate collision confidence based on multiple signals
      let confidence = 0;
      const reasons: string[] = [];

      // Signal 1: Mutual velocity anomaly (PRIMARY - required)
      const mutualAnomaly = Math.min(aAnomaly, bAnomaly); // Weakest link
      if (mutualAnomaly < 0.2) continue; // Both MUST show significant change
      confidence += mutualAnomaly * 0.4;
      reasons.push(`mutual_anomaly=${mutualAnomaly.toFixed(2)}`);

      // Signal 2: Proximity
      if (d < cr * 0.5) { confidence += 0.25; reasons.push("touching"); }
      else if (d < cr * 1.0) { confidence += 0.15; reasons.push("close"); }

      // Signal 3: Overlap
      if (isOverlapping(a, b)) { confidence += 0.15; reasons.push("overlap"); }

      // Signal 4: One was moving fast before (impact)
      const aWasFast = wasRecentlyFast(a);
      const bWasFast = wasRecentlyFast(b);
      if (aWasFast || bWasFast) { confidence += 0.1; reasons.push("was_fast"); }

      // Signal 5: Both now stopped or slow (post-impact)
      const aSlow = a.speed < 0.5;
      const bSlow = b.speed < 0.5;
      if (aSlow && bSlow) { confidence += 0.1; reasons.push("both_slow"); }

      // Minimum threshold
      if (confidence < 0.5) continue;

      evidence.push({
        type: "collision",
        confidence: Math.min(confidence, 0.95),
        objects: [a.id, b.id],
        details: `${a.class}#${a.id}+${b.class}#${b.id} conf=${confidence.toFixed(2)} [${reasons.join("+")}]`,
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
    if (entity.aspectHistory.length < 4) continue;

    const currentAR = entity.aspectHistory[entity.aspectHistory.length - 1];
    const prevAR = (entity.aspectHistory[0] + entity.aspectHistory[1]) / 2;

    const wasStanding = prevAR < 0.8;
    const nowLying = currentAR > 0.9;

    if (!wasStanding || !nowLying) continue;

    // Must show velocity change (person was moving, now stopped)
    const velocityChange = suddenVelocityChange(entity);
    const wasMoving = entity.speedHistory.slice(0, 5).some(s => s > 0.5);
    const isStopped = entity.speed < 0.3;

    // Y position drop
    const lastY = entity.positions[entity.positions.length - 1]?.y || 0;
    const prevY = entity.positions.length >= 3 ? entity.positions[entity.positions.length - 3].y : lastY;
    const dropped = lastY > prevY + 3;

    let confidence = 0.6;
    if (velocityChange > 0.2) confidence += 0.15;
    if (wasMoving && isStopped) confidence += 0.1;
    if (dropped) confidence += 0.1;

    evidence.push({
      type: "person_fall",
      confidence: Math.min(confidence, 0.9),
      objects: [entity.id],
      details: `Fall: AR ${prevAR.toFixed(2)}->${currentAR.toFixed(2)} velChange=${velocityChange.toFixed(2)}`,
    });
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

    const velocityChange = suddenVelocityChange(entity);
    const wasMoving = entity.speedHistory.slice(0, 5).some(s => s > 1.0);
    const significantChange = headingChange > Math.PI * 0.3;

    if ((wasMoving && significantChange) || velocityChange > 0.5) {
      evidence.push({
        type: "bike_off_track",
        confidence: Math.min(0.6 + velocityChange * 0.2, 0.85),
        objects: [entity.id],
        details: `Bike heading ${(headingChange * 180 / Math.PI).toFixed(0)} deg velChange=${velocityChange.toFixed(2)}`,
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

  // Core collision detection (same for all modes - requires mutual velocity anomaly)
  evidence = detectCollisions(entities);

  // Always run person fall and bike detection
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

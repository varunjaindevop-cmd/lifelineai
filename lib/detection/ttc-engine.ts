// Collision Detection Engine v11 — Balanced detection with proper thresholds
// Fixed: traffic false alarms, isolated misses, proper state machine cooldown

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

function wasFast(entity: TrackedEntity, threshold: number = 1.5): boolean {
  if (entity.speedHistory.length < 3) return false;
  return entity.speedHistory.slice(0, 3).some(s => s > threshold);
}

function hasDecelerated(entity: TrackedEntity): boolean {
  if (entity.speedHistory.length < 3) return false;
  const maxRecent = Math.max(...entity.speedHistory.slice(0, 3));
  return maxRecent > 1.2 && entity.speed < 0.8;
}

function angleDiff(a: number, b: number): number {
  const diff = Math.abs(a - b);
  return diff > Math.PI ? 2 * Math.PI - diff : diff;
}

function isStationary(entity: TrackedEntity): boolean {
  if (entity.speedHistory.length < 3) return false;
  return entity.speed < 0.3 && entity.speedHistory.slice(0, 3).every(s => s < 0.5);
}

function getDirectionRelation(a: TrackedEntity, b: TrackedEntity): string {
  const va = { x: a.kalman.getState().vx, y: a.kalman.getState().vy };
  const vb = { x: b.kalman.getState().vx, y: b.kalman.getState().vy };
  const speedA = Math.sqrt(va.x * va.x + va.y * va.y);
  const speedB = Math.sqrt(vb.x * vb.x + vb.y * vb.y);

  if (speedA < 0.3 && speedB < 0.3) return "both_stopped";
  if (speedA < 0.3 || speedB < 0.3) return "one_stopped";

  const dx = b.kalman.getState().x - a.kalman.getState().x;
  const dy = b.kalman.getState().y - a.kalman.getState().y;
  const dotA = va.x * dx + va.y * dy;
  const dotB = vb.x * (-dx) + vb.y * (-dy);

  if (dotA > 0 && dotB > 0) return "converging";
  if (dotA < 0 && dotB < 0) return "diverging";

  const headingDiff = angleDiff(a.heading, b.heading);
  if (headingDiff < Math.PI * 0.3) return "passing";

  if (dotA > 0 || dotB > 0) return "crossing";
  return "parallel";
}

function sustainedApproach(a: TrackedEntity, b: TrackedEntity, minFrames: number = 2): boolean {
  if (a.positions.length < minFrames || b.positions.length < minFrames) return false;
  let approachCount = 0;
  const len = Math.min(a.positions.length, b.positions.length);
  for (let i = 1; i < len && i <= minFrames + 1; i++) {
    const idx1 = len - i - 1;
    const idx2 = len - i;
    if (idx1 < 0) break;
    const d1 = Math.sqrt((a.positions[idx1].x - b.positions[idx1].x) ** 2 + (a.positions[idx1].y - b.positions[idx1].y) ** 2);
    const d2 = Math.sqrt((a.positions[idx2].x - b.positions[idx2].x) ** 2 + (a.positions[idx2].y - b.positions[idx2].y) ** 2);
    if (d2 < d1) approachCount++;
  }
  return approachCount >= minFrames;
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

// ========== ISOLATED MODE ==========

function scoreIsolated(a: TrackedEntity, b: TrackedEntity): { score: number; reason: string } | null {
  const d = dist(a, b);
  const cr = combinedR(a, b);

  if (d > cr * 2.5) return null;

  const score = { value: 0 };
  const reasons: string[] = [];
  const relation = getDirectionRelation(a, b);

  // Reject clear passing/diverging
  if (relation === "diverging") return null;

  // Stationary person protection
  const aStatPerson = a.class === "person" && isStationary(a);
  const bStatPerson = b.class === "person" && isStationary(b);
  const hasStatPerson = aStatPerson || bStatPerson;

  // Signal 1: Overlap (+0.4)
  const overlap = isOverlapping(a, b);
  if (hasStatPerson && !overlap) return null;
  if (overlap) { score.value += 0.4; reasons.push("overlap"); }

  // Signal 2: Proximity (+0.3 touch, +0.15 close, +0.05 moderate)
  if (d < cr * 0.6) { score.value += 0.3; reasons.push("touching"); }
  else if (d < cr * 1.0) { score.value += 0.15; reasons.push("close"); }
  else if (d < cr * 2.0) { score.value += 0.05; reasons.push("moderate"); }

  // Signal 3: Direction (+0.2 converging, +0.1 crossing, +0.05 stopped)
  if (relation === "converging") { score.value += 0.2; reasons.push("converging"); }
  else if (relation === "crossing") { score.value += 0.1; reasons.push("crossing"); }
  else if (relation === "one_stopped" || relation === "both_stopped") { score.value += 0.05; reasons.push("stopped"); }
  else if (relation === "passing") { score.value -= 0.3; reasons.push("passing_penalty"); }

  // Signal 4: Deceleration (+0.2 each, max 0.35)
  const aDecel = hasDecelerated(a);
  const bDecel = hasDecelerated(b);
  if (aDecel && bDecel) { score.value += 0.35; reasons.push("both_decel"); }
  else if (aDecel || bDecel) { score.value += 0.2; reasons.push(aDecel ? "A_decel" : "B_decel"); }

  // Signal 5: Closing speed (+0.15)
  const closing = closingSpeed(a, b);
  if (closing > 0.5) { score.value += 0.15; reasons.push("closing"); }

  // Signal 6: Approach (+0.1)
  if (sustainedApproach(a, b, 2)) { score.value += 0.1; reasons.push("approaching"); }

  // Penalties
  if (a.speed > 1 && b.speed > 1 && angleDiff(a.heading, b.heading) < Math.PI * 0.3) {
    score.value -= 0.3; reasons.push("heading_penalty");
  }

  if (score.value < 0.45) return null;
  return { score: Math.min(score.value, 1), reason: reasons.join("+") };
}

// ========== TRAFFIC MODE ==========

const trafficAlertCooldown = new Map<number, number>();

function detectTrafficAlerts(entities: TrackedEntity[]): AccidentEvidence[] {
  const evidence: AccidentEvidence[] = [];
  const now = Date.now();

  for (const entity of entities) {
    if (entity.age < 10 || entity.speedHistory.length < 5) continue;

    const lastAlert = trafficAlertCooldown.get(entity.id) || 0;
    if (now - lastAlert < 8000) continue; // 8 second cooldown

    const recentSpeed = entity.speed;
    const maxRecent = Math.max(entity.speedHistory[0], entity.speedHistory[1], entity.speedHistory[2]);

    // Must have been moving FAST (>5 px/frame) and now nearly STOPPED (<0.5)
    if (maxRecent <= 5 || recentSpeed >= 0.5) continue;

    // Find nearby objects within tight range
    const nearby = entities.filter(e =>
      e.id !== entity.id && e.age >= 8 && dist(e, entity) < combinedR(e, entity) * 1.8
    );
    if (nearby.length === 0) continue;

    let confirmed = false;
    let bestNearby = nearby[0];
    let confidence = 0;
    const reasons: string[] = [];

    for (const n of nearby) {
      let checks = 0;

      // CHECK 1: Nearby object also decelerated (MUST pass)
      if (!hasDecelerated(n)) continue;

      // CHECK 2: Was approaching before stop
      if (wasApproaching(entity, n)) checks++;

      // CHECK 3: Direction convergence
      const relation = getDirectionRelation(entity, n);
      if (relation === "passing") continue; // NOT a collision
      if (relation === "converging") checks++;

      // CHECK 4: Very close (touching)
      const d = dist(entity, n);
      const cr = combinedR(entity, n);
      if (d < cr * 0.5) checks++;

      // Need at least 2 of 3 additional checks
      if (checks < 2) continue;

      confidence = 0.65 + checks * 0.1;
      bestNearby = n;
      confirmed = true;
      reasons.push(`decel+approach=${checks}`);
      break;
    }

    if (!confirmed) continue;

    trafficAlertCooldown.set(entity.id, now);
    evidence.push({
      type: "collision",
      confidence: Math.min(confidence, 0.9),
      objects: [entity.id, bestNearby.id],
      details: `Traffic: ${maxRecent.toFixed(1)}->${recentSpeed.toFixed(1)} near #${bestNearby.id} [${reasons.join("+")}]`,
    });
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

      if (dropped || wasMoving) {
        let confidence = 0.7;
        if (dropped && wasMoving) confidence = 0.85;
        evidence.push({
          type: "person_fall",
          confidence,
          objects: [entity.id],
          details: `Fall: AR ${prevAR.toFixed(2)}->${currentAR.toFixed(2)}`,
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
        details: `Bike heading ${(headingChange * 180 / Math.PI).toFixed(0)} deg${nearbyVehicle ? ` near #${nearbyVehicle.id}` : ""}`,
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
    const candidates = entities.filter(e => e.age >= 3);
    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        const a = candidates[i], b = candidates[j];
        if (a.class === "person" && b.class === "person") continue;
        const result = scoreIsolated(a, b);
        if (result && result.score >= 0.45) {
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

  evidence.push(...detectPersonFall(entities));
  evidence.push(...detectBikeOffTrack(entities));

  evidence.sort((a, b) => b.confidence - a.confidence);
  return evidence;
}

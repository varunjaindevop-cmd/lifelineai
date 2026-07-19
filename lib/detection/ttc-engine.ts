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
  type: "collision";
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

  if (d > cr * 2) return null;

  let score = 0;
  const reasons: string[] = [];

  // Overlap: +0.6
  if (isOverlapping(a, b)) { score += 0.6; reasons.push("overlap"); }

  // Deceleration: +0.4 each
  if (hasDecelerated(a)) { score += 0.4; reasons.push("A_decel"); }
  if (hasDecelerated(b)) { score += 0.4; reasons.push("B_decel"); }

  // Touching (within 0.7x radius): +0.2
  if (d < cr * 0.7) { score += 0.2; reasons.push("touching"); }

  // Passing penalty: both moving + same direction
  if (a.speed > 1 && b.speed > 1) {
    const angleDiff = Math.abs(a.heading - b.heading);
    const wrapped = angleDiff > Math.PI ? 2 * Math.PI - angleDiff : angleDiff;
    if (wrapped < Math.PI * 0.35) { score -= 0.6; reasons.push("PASSING"); }
  }

  if (score < 0.4) return null;
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

// ========== EXPORTS ==========

export function findAllTTCPairs(entities: TrackedEntity[]): TTCPair[] {
  return []; // Not used in v9
}

export function detectAccidents(
  entities: TrackedEntity[],
  ttcPairs: TTCPair[],
  envMode: "isolated" | "traffic" | "marketplace"
): AccidentEvidence[] {
  if (envMode === "traffic") {
    return detectTrafficAlerts(entities);
  }

  // Isolated / marketplace: use v3 scoring
  const evidence: AccidentEvidence[] = [];
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

  evidence.sort((a, b) => b.confidence - a.confidence);
  return evidence;
}

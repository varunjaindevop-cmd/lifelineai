// Collision Detection Engine v7 — ULTRA SIMPLE
// ONLY ONE SIGNAL: bounding box overlap sustained over multiple frames.
// No speed, no convergence, no aftermath. Just overlap.
//
// Why: Every other signal I added caused false positives.
// Overlap is the ONLY thing that actually means two objects are in contact.

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

// Track overlap history per pair using a Map
const overlapHistory = new Map<string, number>();

function getPairKey(a: TrackedEntity, b: TrackedEntity): string {
  const id1 = Math.min(a.id, b.id);
  const id2 = Math.max(a.id, b.id);
  return `${id1}-${id2}`;
}

export function findAllTTCPairs(entities: TrackedEntity[]): TTCPair[] {
  const pairs: TTCPair[] = [];
  const candidates = entities.filter(e => e.age >= 2);
  const nowActive = new Set<string>();

  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i], b = candidates[j];
      if (a.class === "person" && b.class === "person") continue;

      const key = getPairKey(a, b);
      nowActive.add(key);

      if (isOverlapping(a, b)) {
        // FILTER: If both moving in same direction = passing, not collision
        const angleDiff = Math.abs(a.heading - b.heading);
        const wrapped = angleDiff > Math.PI ? 2 * Math.PI - angleDiff : angleDiff;
        const bothMoving = a.speed > 1 && b.speed > 1;
        const sameDirection = wrapped < Math.PI * 0.4; // within ~72 degrees
        if (bothMoving && sameDirection) {
          overlapHistory.set(key, 0); // reset — this is passing
          continue;
        }

        const prev = overlapHistory.get(key) || 0;
        overlapHistory.set(key, prev + 1);
        const overlapFrames = overlapHistory.get(key)!;

        if (overlapFrames >= 2) {
          let severity: TTCPair["severity"] = "warning";
          if (overlapFrames >= 6) severity = "impact";
          else if (overlapFrames >= 4) severity = "critical";

          pairs.push({
            a, b, ttc: NaN, distance: dist(a, b), closingSpeed: 0, severity,
          });
        }
      } else {
        // No overlap — reset counter
        overlapHistory.set(key, 0);
      }
    }
  }

  // Clean up pairs that are no longer active
  for (const key of Array.from(overlapHistory.keys())) {
    if (!nowActive.has(key)) overlapHistory.delete(key);
  }

  pairs.sort((a, b) => a.distance - b.distance);
  return pairs;
}

export function detectAccidents(
  entities: TrackedEntity[],
  ttcPairs: TTCPair[]
): AccidentEvidence[] {
  const evidence: AccidentEvidence[] = [];

  for (const pair of ttcPairs) {
    if (pair.severity === "impact" || pair.severity === "critical") {
      evidence.push({
        type: "collision",
        confidence: pair.severity === "impact" ? 0.9 : 0.75,
        objects: [pair.a.id, pair.b.id],
        details: `Overlap sustained (${pair.severity}) dist:${pair.distance.toFixed(0)}px`,
      });
    }
  }

  evidence.sort((a, b) => b.confidence - a.confidence);
  return evidence;
}

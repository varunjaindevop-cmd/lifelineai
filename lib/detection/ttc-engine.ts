// Collision Detection Engine v8 — Mode-specific logic
//
// ISOLATED ROAD: Track center-to-center distance between object pairs.
//   Alert when distance drops below threshold + objects converge.
//   No bounding box overlap check (unreliable with COCO-SSD).
//
// TRAFFIC MODE: NO collision detection at all.
//   Dense traffic always has close objects. Only flag if an object
//   suddenly stops mid-traffic (post-crash behavior).
//
// KEY INSIGHT: COCO-SSD bounding boxes overlap in normal traffic.
// We must NEVER use overlap as a collision signal.

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

// Track distance history per pair
const distanceHistory = new Map<string, number[]>();

function getPairKey(a: TrackedEntity, b: TrackedEntity): string {
  return `${Math.min(a.id, b.id)}-${Math.max(a.id, b.id)}`;
}

// ISOLATED MODE: Distance-based collision detection
function detectIsolatedCollision(entities: TrackedEntity[]): AccidentEvidence[] {
  const evidence: AccidentEvidence[] = [];
  const candidates = entities.filter(e => e.age >= 3);
  const activePairs = new Set<string>();

  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i], b = candidates[j];
      if (a.class === "person" && b.class === "person") continue;

      const key = getPairKey(a, b);
      activePairs.add(key);

      const d = dist(a, b);
      const cr = combinedR(a, b);

      // Track distance history
      const hist = distanceHistory.get(key) || [];
      hist.push(d);
      if (hist.length > 10) hist.shift();
      distanceHistory.set(key, hist);

      // Need at least 3 frames of history
      if (hist.length < 3) continue;

      // Check if distance is decreasing (objects converging)
      const recentAvg = (hist[hist.length - 1] + hist[hist.length - 2]) / 2;
      const prevAvg = (hist[0] + hist[1]) / 2;
      const converging = recentAvg < prevAvg - 1;

      // Check if very close (within 0.5x combined radius)
      const veryClose = d < cr * 0.5;

      // Check if one object stopped suddenly
      const aStopped = a.speedHistory.length >= 3 &&
        a.speedHistory[0] > 2 && a.speed < 0.5;
      const bStopped = b.speedHistory.length >= 3 &&
        b.speedHistory[0] > 2 && b.speed < 0.5;
      const oneStopped = aStopped || bStopped;

      // Collision signal: converging + very close + (one stopped OR both converging fast)
      if (veryClose && converging && oneStopped) {
        evidence.push({
          type: "collision",
          confidence: 0.85,
          objects: [a.id, b.id],
          details: `Converging + very close + stopped (dist: ${d.toFixed(0)}px)`,
        });
      } else if (veryClose && converging && hist.length >= 4) {
        // Distance was larger, now very close = rapid approach
        const rapidApproach = prevAvg - recentAvg > 3;
        if (rapidApproach) {
          evidence.push({
            type: "collision",
            confidence: 0.7,
            objects: [a.id, b.id],
            details: `Rapid approach: ${prevAvg.toFixed(0)}→${recentAvg.toFixed(0)}px`,
          });
        }
      }
    }
  }

  // Cleanup stale pairs
  for (const key of Array.from(distanceHistory.keys())) {
    if (!activePairs.has(key)) distanceHistory.delete(key);
  }

  return evidence;
}

// TRAFFIC MODE: Only detect sudden stops mid-traffic
function detectTrafficCollision(entities: TrackedEntity[]): AccidentEvidence[] {
  const evidence: AccidentEvidence[] = [];

  for (const entity of entities) {
    if (entity.age < 5) continue;
    if (entity.speedHistory.length < 5) continue;

    // Was moving fast, now suddenly stopped
    const recentSpeed = entity.speed;
    const prevSpeed = (entity.speedHistory[0] + entity.speedHistory[1] + entity.speedHistory[2]) / 3;

    // Sudden stop: was >3 px/frame, now <0.5, dropped in 2-3 frames
    if (prevSpeed > 3 && recentSpeed < 0.5) {
      // Check if there are other objects nearby (could be the collision partner)
      const nearbyObj = entities.find(e =>
        e.id !== entity.id &&
        e.age >= 3 &&
        dist(e, entity) < combinedR(e, entity) * 3
      );

      if (nearbyObj) {
        evidence.push({
          type: "collision",
          confidence: 0.75,
          objects: [entity.id, nearbyObj.id],
          details: `Sudden stop near #${nearbyObj.id} (${prevSpeed.toFixed(1)}→${recentSpeed.toFixed(1)} px/f)`,
        });
      }
    }
  }

  return evidence;
}

export function findAllTTCPairs(entities: TrackedEntity[]): TTCPair[] {
  // No TTC pairs in v8 — we use mode-specific detection instead
  return [];
}

export function detectAccidents(
  entities: TrackedEntity[],
  ttcPairs: TTCPair[],
  envMode: "isolated" | "traffic" | "marketplace"
): AccidentEvidence[] {
  let evidence: AccidentEvidence[];

  if (envMode === "traffic") {
    evidence = detectTrafficCollision(entities);
  } else {
    // isolated or marketplace
    evidence = detectIsolatedCollision(entities);
  }

  evidence.sort((a, b) => b.confidence - a.confidence);
  return evidence;
}

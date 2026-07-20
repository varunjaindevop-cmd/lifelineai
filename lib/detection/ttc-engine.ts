// Unified Collision Detection Engine v4
// Distance-aware: only near-camera objects trigger accident alerts.
// Person-bike association: tracks rider-bike relationships for anomaly detection.
// Traffic mode: bike fall + person ejection detection.

import { TrackedEntity } from "./kalman-tracker";

export type EnvMode = "isolated" | "traffic" | "marketplace";

export interface AccidentEvidence {
  type: "collision" | "person_fall" | "bike_off_track" | "vehicle_fall" | "bike_crash" | "person_ejected";
  confidence: number;
  objects: number[];
  details: string;
  signals: EvidenceSignal[];
  sceneContext: EnvMode;
}

export interface EvidenceSignal {
  name: string;
  value: number;
  weight: number;
  passed: boolean;
}

// ========== DISTANCE ESTIMATION ==========

/**
 * Estimate distance from camera based on vertical position in frame.
 * Lower in frame = closer to camera. Higher = farther away.
 * Returns 0-1 where 0 = bottom (closest), 1 = top (farthest).
 */
function estimateDistance(entity: TrackedEntity, frameHeight: number = 480): number {
  const k = entity.kalman.getState();
  const normalizedY = k.y / frameHeight; // 0 = top, 1 = bottom
  return 1 - normalizedY; // invert: 0 = closest, 1 = farthest
}

/**
 * Check if entity is in the near zone (bottom 65% of frame).
 * Near zone = likely close to camera = high confidence accidents.
 */
function isNearCamera(entity: TrackedEntity, frameHeight: number = 480): boolean {
  const k = entity.kalman.getState();
  const normalizedY = k.y / frameHeight;
  return normalizedY > 0.35; // bottom 65% of frame
}

/**
 * Get distance priority: 0 = closest (highest priority), 1 = farthest.
 * Used to weight evidence confidence.
 */
function distancePriority(entity: TrackedEntity, frameHeight: number = 480): number {
  const dist = estimateDistance(entity, frameHeight);
  // Near objects (dist < 0.4) get priority 1.0
  // Far objects (dist > 0.7) get priority 0.3
  if (dist < 0.3) return 1.0;
  if (dist < 0.5) return 0.8;
  if (dist < 0.7) return 0.5;
  return 0.3;
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

function calcIoU(a: TrackedEntity, b: TrackedEntity): number {
  const ix1 = Math.max(a.bbox[0], b.bbox[0]);
  const iy1 = Math.max(a.bbox[1], b.bbox[1]);
  const ix2 = Math.min(a.bbox[2], b.bbox[2]);
  const iy2 = Math.min(a.bbox[3], b.bbox[3]);
  const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
  const areaA = (a.bbox[2] - a.bbox[0]) * (a.bbox[3] - a.bbox[1]);
  const areaB = (b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1]);
  return inter / (areaA + areaB - inter + 1e-6);
}

function hasDecelerated(entity: TrackedEntity): boolean {
  if (entity.speedHistory.length < 3) return false;
  const recent = entity.speedHistory.slice(0, 2);
  const older = entity.speedHistory.slice(2, Math.min(5, entity.speedHistory.length));
  if (older.length === 0) return false;
  const avgRecent = recent.reduce((a, b) => a + b, 0) / recent.length;
  const avgOlder = older.reduce((a, b) => a + b, 0) / older.length;
  return avgOlder > 0.3 && avgRecent < avgOlder * 0.65;
}

function wasFast(entity: TrackedEntity): boolean {
  if (entity.speedHistory.length < 2) return false;
  return entity.speedHistory[0] > 1.0 || entity.speedHistory[1] > 1.0;
}

function angleDiff(a: number, b: number): number {
  const diff = Math.abs(a - b);
  return diff > Math.PI ? 2 * Math.PI - diff : diff;
}

function isStationary(entity: TrackedEntity): boolean {
  return entity.speed < 0.3 && entity.speedHistory.slice(0, 3).every(s => s < 0.5);
}

function isPassing(a: TrackedEntity, b: TrackedEntity): boolean {
  if (a.speed < 0.6 || b.speed < 0.6) return false;
  const headingDiff = angleDiff(a.heading, b.heading);
  if (headingDiff < Math.PI * 0.25) return true;
  if (!hasDecelerated(a) && !hasDecelerated(b)) return true;
  return false;
}

// ========== PERSON-BIKE ASSOCIATION ==========

interface PersonBikePair {
  person: TrackedEntity;
  bike: TrackedEntity;
  associationStrength: number; // 0-1, how likely they're related
  distance: number; // current distance between them
}

/**
 * Find person-bike pairs: persons near bikes that have been tracked together.
 */
function findPersonBikePairs(entities: TrackedEntity[]): PersonBikePair[] {
  const persons = entities.filter(e => e.class === "person" && e.age >= 3);
  const bikes = entities.filter(e => (e.class === "motorcycle" || e.class === "bicycle") && e.age >= 3);
  const pairs: PersonBikePair[] = [];

  for (const person of persons) {
    let bestBike: TrackedEntity | null = null;
    let bestDist = Infinity;

    for (const bike of bikes) {
      const d = dist(person, bike);
      const combinedSize = combinedR(person, bike);

      // Person must be near the bike (within 3x combined size)
      if (d < combinedSize * 3 && d < bestDist) {
        bestDist = d;
        bestBike = bike;
      }
    }

    if (bestBike) {
      const combinedSize = combinedR(person, bestBike);
      const associationStrength = Math.max(0, 1 - bestDist / (combinedSize * 3));
      pairs.push({
        person,
        bike: bestBike,
        associationStrength,
        distance: bestDist,
      });
    }
  }

  return pairs;
}

/**
 * Detect bike crash with person ejection:
 * - Bike was moving fast, suddenly stopped/fell
 * - Person associated with bike is now separated or lying down
 */
function detectBikeCrash(pairs: PersonBikePair[], envMode: EnvMode): AccidentEvidence[] {
  const evidence: AccidentEvidence[] = [];

  for (const pair of pairs) {
    const { person, bike, distance } = pair;

    // Check if bike has fallen (aspect ratio flip)
    const bikeWasUpright = bike.aspectHistory.length >= 3
      ? (bike.aspectHistory[0] + bike.aspectHistory[1]) / 2 < 0.8
      : false;
    const bikeNowFallen = bike.aspectHistory.length > 0
      ? bike.aspectHistory[bike.aspectHistory.length - 1] > 1.2
      : false;

    // Check if bike stopped suddenly
    const bikeWasMoving = wasFast(bike);
    const bikeNowStopped = isStationary(bike);
    const bikeDecelerated = hasDecelerated(bike);

    // Check if person is lying down
    const personAR = person.aspectHistory.length > 0
      ? person.aspectHistory[person.aspectHistory.length - 1]
      : 0.5;
    const personLying = personAR > 0.9;

    // Check if person separated from bike (distance increased suddenly)
    let personSeparated = false;
    if (person.positions.length >= 3 && bike.positions.length >= 3) {
      const prevDist = Math.sqrt(
        (person.positions[person.positions.length - 3].x - bike.positions[bike.positions.length - 3].x) ** 2 +
        (person.positions[person.positions.length - 3].y - bike.positions[bike.positions.length - 3].y) ** 2
      );
      personSeparated = distance > prevDist * 1.5 + 10; // distance increased significantly
    }

    // Only detect if near camera
    if (!isNearCamera(bike) && !isNearCamera(person)) continue;

    // Score the evidence
    let confidence = 0;
    const signals: EvidenceSignal[] = [];

    // Signal 1: Bike fell (aspect ratio flip)
    if (bikeWasUpright && bikeNowFallen) {
      confidence += 0.35;
      signals.push({ name: "bike_fell", value: 1, weight: 0.35, passed: true });
    } else {
      signals.push({ name: "bike_fell", value: 0, weight: 0.35, passed: false });
    }

    // Signal 2: Bike stopped suddenly
    if (bikeWasMoving && bikeNowStopped) {
      confidence += 0.25;
      signals.push({ name: "bike_stopped", value: 1, weight: 0.25, passed: true });
    } else if (bikeDecelerated) {
      confidence += 0.15;
      signals.push({ name: "bike_stopped", value: 0.5, weight: 0.25, passed: false });
    } else {
      signals.push({ name: "bike_stopped", value: 0, weight: 0.25, passed: false });
    }

    // Signal 3: Person lying down
    if (personLying) {
      confidence += 0.25;
      signals.push({ name: "person_lying", value: 1, weight: 0.25, passed: true });
    } else {
      signals.push({ name: "person_lying", value: 0, weight: 0.25, passed: false });
    }

    // Signal 4: Person separated from bike
    if (personSeparated) {
      confidence += 0.15;
      signals.push({ name: "person_separated", value: 1, weight: 0.15, passed: true });
    } else {
      signals.push({ name: "person_separated", value: 0, weight: 0.15, passed: false });
    }

    // Distance boost: near-camera objects get higher confidence
    const distBoost = Math.max(distancePriority(bike), distancePriority(person));
    confidence *= (0.7 + 0.3 * distBoost); // 70% base + 30% distance priority

    // Require at least 2 signals
    const passedSignals = signals.filter(s => s.passed).length;
    if (passedSignals < 2 || confidence < 0.40) continue;

    console.log(`[TTC] BIKE CRASH: bike#${bike.id} person#${person.id} conf=${confidence.toFixed(3)} signals=${passedSignals}/4 fell=${bikeNowFallen} stopped=${bikeNowStopped} lying=${personLying} separated=${personSeparated}`);

    evidence.push({
      type: "bike_crash",
      confidence: Math.min(0.95, confidence),
      objects: [bike.id, person.id],
      details: `Bike crash: fell=${bikeNowFallen} stopped=${bikeNowStopped} person_lying=${personLying} sep=${personSeparated}`,
      signals,
      sceneContext: envMode,
    });
  }

  return evidence;
}

// ========== VEHICLE FALL (standalone bike/vehicle fall without person) ==========

function detectVehicleFall(entities: TrackedEntity[], envMode: EnvMode): AccidentEvidence[] {
  const evidence: AccidentEvidence[] = [];

  for (const entity of entities) {
    if (entity.age < 2) continue;
    if (entity.class !== "motorcycle" && entity.class !== "car") continue;
    if (!isNearCamera(entity)) continue;
    if (entity.aspectHistory.length < 2) continue;

    const currentAR = entity.aspectHistory[entity.aspectHistory.length - 1];
    const prevAR = (entity.aspectHistory[0] + entity.aspectHistory[1]) / 2;

    const wasUpright = prevAR < 0.8;
    const nowFallen = currentAR > 1.2;
    const significantChange = currentAR > prevAR * 1.5;

    if ((wasUpright && nowFallen) || significantChange) {
      const wasMoving = wasFast(entity);
      const stationary = isStationary(entity);

      let confidence = 0.55;
      if (wasMoving && stationary) confidence += 0.15;
      if (significantChange) confidence += 0.1;
      confidence *= (0.7 + 0.3 * distancePriority(entity));

      evidence.push({
        type: "vehicle_fall",
        confidence: Math.min(0.9, confidence),
        objects: [entity.id],
        details: `${entity.class} AR ${prevAR.toFixed(2)}->${currentAR.toFixed(2)}`,
        signals: [
          { name: "aspect_flip", value: significantChange ? 1 : 0, weight: 0.4, passed: significantChange },
          { name: "was_moving", value: wasMoving ? 1 : 0, weight: 0.3, passed: wasMoving },
          { name: "now_stationary", value: stationary ? 1 : 0, weight: 0.3, passed: stationary },
        ],
        sceneContext: envMode,
      });
    }
  }

  return evidence;
}

// ========== COLLISION DETECTION ==========

function detectVehicleCollision(entities: TrackedEntity[], envMode: EnvMode): AccidentEvidence[] {
  const evidence: AccidentEvidence[] = [];
  const candidates = entities.filter(e =>
    e.age >= 1 &&
    ["car", "truck", "bus", "motorcycle"].includes(e.class) &&
    isNearCamera(e)
  );

  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i];
      const b = candidates[j];

      const d = dist(a, b);
      const cr = combinedR(a, b);
      const iou = calcIoU(a, b);

      if (envMode === "traffic") {
        // Traffic: strict overlap + both decelerated
        if (iou < 0.15) continue;
        if (!hasDecelerated(a) || !hasDecelerated(b)) continue;
        if (d > cr * 1.5) continue;
        if (isPassing(a, b)) continue;

        const distBoost = Math.max(distancePriority(a), distancePriority(b));
        const confidence = Math.min(0.95,
          (0.4 * Math.min(iou * 3, 1) + 0.3 * 1.0 + 0.3 * (d < cr * 0.8 ? 1 : 0.5)) *
          (0.7 + 0.3 * distBoost)
        );

        evidence.push({
          type: "collision",
          confidence,
          objects: [a.id, b.id],
          details: `Traffic crash: iou=${iou.toFixed(3)} d=${d.toFixed(0)}px`,
          signals: [
            { name: "overlap", value: iou, weight: 0.4, passed: iou > 0.15 },
            { name: "both_decel", value: 1, weight: 0.3, passed: true },
            { name: "proximity", value: d < cr * 0.8 ? 1 : 0.5, weight: 0.3, passed: true },
          ],
          sceneContext: "traffic",
        });
      } else {
        // Isolated/Marketplace: 5-signal scoring
        if (isPassing(a, b)) continue;
        if (d > cr * 3.5) continue;

        const overlap = Math.min(iou * 4, 1.0);
        const deceleration = (hasDecelerated(a) ? 0.5 : 0) + (hasDecelerated(b) ? 0.5 : 0);
        const proximity = d < cr * 0.8 ? 1.0 : d < cr * 1.5 ? 0.7 : d < cr * 2.5 ? 0.3 : 0;

        let confidence = 0.30 * overlap + 0.25 * deceleration + 0.20 * proximity;
        const distBoost = Math.max(distancePriority(a), distancePriority(b));
        confidence *= (0.7 + 0.3 * distBoost);

        const passedCount = [overlap > 0.03, deceleration > 0, proximity > 0].filter(Boolean).length;
        const minScore = envMode === "isolated" ? 0.35 : 0.50;

        if (confidence >= minScore && passedCount >= 2) {
          evidence.push({
            type: "collision",
            confidence: Math.min(0.95, confidence),
            objects: [a.id, b.id],
            details: `${envMode}: signals=${passedCount}/3 d=${d.toFixed(0)}px`,
            signals: [
              { name: "overlap", value: overlap, weight: 0.30, passed: overlap > 0.03 },
              { name: "deceleration", value: deceleration, weight: 0.25, passed: deceleration > 0 },
              { name: "proximity", value: proximity, weight: 0.20, passed: proximity > 0 },
            ],
            sceneContext: envMode,
          });
        }
      }
    }
  }

  return evidence;
}

// ========== PERSON FALL ==========

function detectPersonFall(entities: TrackedEntity[], envMode: EnvMode): AccidentEvidence[] {
  const evidence: AccidentEvidence[] = [];

  for (const entity of entities) {
    if (entity.class !== "person" || entity.age < 2) continue;
    if (!isNearCamera(entity)) continue;
    if (entity.aspectHistory.length < 2) continue;

    const currentAR = entity.aspectHistory[entity.aspectHistory.length - 1];
    const prevAR = entity.aspectHistory.length >= 3
      ? (entity.aspectHistory[0] + entity.aspectHistory[1]) / 2
      : currentAR;
    const wasStanding = prevAR < 0.8;
    const nowLying = currentAR > 0.9;

    if (wasStanding && nowLying) {
      const lastY = entity.positions[entity.positions.length - 1]?.y || 0;
      const prevY = entity.positions.length >= 3 ? entity.positions[entity.positions.length - 3].y : lastY;
      const dropped = lastY > prevY + 3;
      const wasMoving = wasFast(entity);
      const stationary = isStationary(entity);

      let confidence = 0.60;
      if (dropped) confidence += 0.1;
      if (wasMoving && stationary) confidence += 0.1;
      confidence *= (0.7 + 0.3 * distancePriority(entity));

      evidence.push({
        type: "person_fall",
        confidence: Math.min(0.9, confidence),
        objects: [entity.id],
        details: `Fall: AR ${prevAR.toFixed(2)}->${currentAR.toFixed(2)}`,
        signals: [
          { name: "aspect_ratio", value: currentAR, weight: 0.4, passed: nowLying },
          { name: "position_drop", value: dropped ? 1 : 0, weight: 0.3, passed: dropped },
          { name: "was_moving", value: wasMoving ? 1 : 0, weight: 0.2, passed: wasMoving && stationary },
          { name: "sustained", value: entity.confirmedFrames >= 2 ? 1 : 0, weight: 0.1, passed: entity.confirmedFrames >= 2 },
        ],
        sceneContext: envMode,
      });
    }
  }

  return evidence;
}

// ========== MOTION-BASED ACCIDENT DETECTION ==========
// Works even when COCO-SSD misses objects (fallen bike, lying person).
// Detects accidents purely from tracking data: sudden stops, proximity changes, disappearance.

function detectMotionAnomalies(entities: TrackedEntity[], envMode: EnvMode): AccidentEvidence[] {
  const evidence: AccidentEvidence[] = [];

  // 1. Sudden stop near another entity — vehicle was moving, suddenly stopped close to something
  const vehicles = entities.filter(e => e.age >= 2 && ["car", "truck", "bus", "motorcycle"].includes(e.class));
  const persons = entities.filter(e => e.age >= 2 && e.class === "person");

  for (const v of vehicles) {
    if (!isNearCamera(v)) continue;
    if (v.speedHistory.length < 4) continue;

    // Check: was fast recently, now stopped
    const recentSpeed = Math.max(...v.speedHistory.slice(0, 3));
    const isNowStopped = v.speed < 0.3;
    const wasMoving = recentSpeed > 0.8;

    if (!wasMoving || !isNowStopped) continue;

    // Find nearby entities (person or vehicle)
    const nearby = [...vehicles, ...persons].filter(e =>
      e.id !== v.id && e.age >= 1 && dist(v, e) < combinedR(v, e) * 3
    );

    for (const n of nearby) {
      // The nearby entity should also be stopped or slow
      const nSlow = n.speed < 0.5;
      if (!nSlow) continue;

      // Check they were approaching before
      let wasApproaching = false;
      if (v.positions.length >= 3 && n.positions.length >= 3) {
        const prevAx = v.positions[v.positions.length - 3].x;
        const prevAy = v.positions[v.positions.length - 3].y;
        const prevBx = n.positions[n.positions.length - 3].x;
        const prevBy = n.positions[n.positions.length - 3].y;
        const prevD = Math.sqrt((prevAx - prevBx) ** 2 + (prevAy - prevBy) ** 2);
        const curD = dist(v, n);
        wasApproaching = prevD > curD + 2;
      }

      let confidence = 0.50;
      const signals: EvidenceSignal[] = [
        { name: "sudden_stop", value: 1, weight: 0.35, passed: true },
        { name: "nearby_stopped", value: nSlow ? 1 : 0, weight: 0.25, passed: nSlow },
        { name: "was_approaching", value: wasApproaching ? 1 : 0, weight: 0.20, passed: wasApproaching },
        { name: "near_camera", value: distancePriority(v), weight: 0.20, passed: distancePriority(v) > 0.5 },
      ];

      if (wasApproaching) confidence += 0.15;
      if (n.class === "person") confidence += 0.10; // person nearby = more serious

      confidence *= (0.7 + 0.3 * distancePriority(v));

      if (confidence >= 0.45) {
        console.log(`[TTC] MOTION ANOMALY: ${v.class}#${v.id} stopped near ${n.class}#${n.id} conf=${confidence.toFixed(3)}`);
        evidence.push({
          type: "collision",
          confidence: Math.min(0.9, confidence),
          objects: [v.id, n.id],
          details: `Motion: ${v.class} stopped near ${n.class} (was ${recentSpeed.toFixed(1)}px/f)`,
          signals,
          sceneContext: envMode,
        });
      }
    }
  }

  // 2. Person suddenly stopped on road (possible fall even if AR hasn't changed yet)
  for (const p of persons) {
    if (!isNearCamera(p)) continue;
    if (p.speedHistory.length < 4) continue;

    const wasMoving = Math.max(...p.speedHistory.slice(0, 3)) > 0.5;
    const isNowStopped = p.speed < 0.2;
    const stoppedFrames = p.speedHistory.slice(0, 5).filter(s => s < 0.3).length;

    if (wasMoving && isNowStopped && stoppedFrames >= 2) {
      // Check if person's position dropped (fell down)
      let positionDropped = false;
      if (p.positions.length >= 3) {
        const prevY = p.positions[p.positions.length - 3].y;
        const curY = p.positions[p.positions.length - 1].y;
        positionDropped = curY > prevY + 2; // moved down in frame = closer to ground
      }

      let confidence = 0.45;
      if (positionDropped) confidence += 0.15;

      const signals: EvidenceSignal[] = [
        { name: "was_moving", value: 1, weight: 0.3, passed: true },
        { name: "now_stopped", value: 1, weight: 0.3, passed: true },
        { name: "position_dropped", value: positionDropped ? 1 : 0, weight: 0.25, passed: positionDropped },
        { name: "sustained_stop", value: stoppedFrames >= 3 ? 1 : 0, weight: 0.15, passed: stoppedFrames >= 3 },
      ];

      confidence *= (0.7 + 0.3 * distancePriority(p));

      if (confidence >= 0.45) {
        console.log(`[TTC] PERSON STOPPED: #${p.id} was moving, now stopped conf=${confidence.toFixed(3)}`);
        evidence.push({
          type: "person_fall",
          confidence: Math.min(0.85, confidence),
          objects: [p.id],
          details: `Person stopped suddenly (was moving, now stationary for ${stoppedFrames} frames)`,
          signals,
          sceneContext: envMode,
        });
      }
    }
  }

  return evidence;
}

// ========== MAIN EXPORT ==========

export function detectAccidents(entities: TrackedEntity[], envMode: EnvMode): AccidentEvidence[] {
  let evidence: AccidentEvidence[] = [];

  // 1. Motion-based anomalies (works even when objects aren't detected properly)
  evidence.push(...detectMotionAnomalies(entities, envMode));

  // 2. Person-bike crash detection
  const pairs = findPersonBikePairs(entities);
  evidence.push(...detectBikeCrash(pairs, envMode));

  // 3. Vehicle collision (near-camera only)
  evidence.push(...detectVehicleCollision(entities, envMode));

  // 4. Vehicle fall (near-camera only)
  evidence.push(...detectVehicleFall(entities, envMode));

  // 5. Person fall (near-camera only)
  evidence.push(...detectPersonFall(entities, envMode));

  // Deduplicate: keep highest confidence per object set
  const deduped: AccidentEvidence[] = [];
  const seen = new Map<string, AccidentEvidence>();
  evidence.sort((a, b) => b.confidence - a.confidence);
  for (const ev of evidence) {
    const key = `${ev.type}:${[...ev.objects].sort().join(",")}`;
    if (!seen.has(key)) {
      seen.set(key, ev);
      deduped.push(ev);
    }
  }

  if (deduped.length > 0) {
    console.log(`[TTC] ALERT: ${deduped.length} items, top=${deduped[0].type} conf=${deduped[0].confidence.toFixed(3)}`);
  }

  return deduped;
}

export function getModeConfig(mode: EnvMode) {
  return MODE_CONFIG[mode];
}

const MODE_CONFIG: Record<EnvMode, { minScore: number; minSignals: number; cooldownMs: number }> = {
  isolated: { minScore: 0.35, minSignals: 2, cooldownMs: 3000 },
  traffic: { minScore: 0.55, minSignals: 2, cooldownMs: 8000 },
  marketplace: { minScore: 0.50, minSignals: 3, cooldownMs: 8000 },
};

export { isNearCamera, distancePriority, isPassing, hasDecelerated, dist, combinedR, calcIoU };

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
 * Traffic mode uses stricter zone (bottom 45%) to filter far vehicles.
 */
function isNearCamera(entity: TrackedEntity, frameHeight: number = 480, envMode: EnvMode = "isolated"): boolean {
  const k = entity.kalman.getState();
  const normalizedY = k.y / frameHeight;
  if (envMode === "traffic") {
    return normalizedY > 0.55; // traffic: only bottom 45% — far vehicles excluded
  }
  return normalizedY > 0.35; // isolated/marketplace: bottom 65%
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
  // Use more lenient thresholds for COCO-SSD noise tolerance
  // Look at the MAX speed in recent history vs the MAX in older history
  const recent = entity.speedHistory.slice(0, 3);
  const older = entity.speedHistory.slice(3, Math.min(8, entity.speedHistory.length));
  if (older.length === 0) {
    // Fallback: just check if recent speeds are declining
    return recent[0] < recent[1] * 0.7 && recent[1] > 0.2;
  }
  const maxRecent = Math.max(...recent);
  const maxOlder = Math.max(...older);
  // Deceleration: older speeds were higher, now they're lower
  // Use max instead of avg to be noise-tolerant
  return maxOlder > 0.2 && maxRecent < maxOlder * 0.7;
}

function wasFast(entity: TrackedEntity): boolean {
  if (entity.speedHistory.length < 2) return false;
  // Lowered threshold: COCO-SSD speed estimates are often lower than reality
  return entity.speedHistory[0] > 0.5 || entity.speedHistory[1] > 0.5 ||
    (entity.speedHistory.length >= 3 && entity.speedHistory[2] > 0.5);
}

function angleDiff(a: number, b: number): number {
  const diff = Math.abs(a - b);
  return diff > Math.PI ? 2 * Math.PI - diff : diff;
}

function isStationary(entity: TrackedEntity): boolean {
  // Noise-tolerant: check if the entity is currently slow AND
  // at least 2 of the last 3 speed readings are low
  if (entity.speed > 0.5) return false; // still moving fast
  const recent3 = entity.speedHistory.slice(0, 3);
  const slowCount = recent3.filter(s => s < 0.6).length;
  return slowCount >= 2; // majority of recent readings are slow
}

function isPassing(a: TrackedEntity, b: TrackedEntity): boolean {
  if (a.speed < 0.4 || b.speed < 0.4) return false;
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
    // Traffic mode: BOTH bike AND person must be near camera (strict)
    // Other modes: at least one must be near camera
    if (envMode === "traffic") {
      if (!isNearCamera(bike) || !isNearCamera(person)) continue;
    } else {
      if (!isNearCamera(bike) && !isNearCamera(person)) continue;
    }

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
    if (passedSignals < 2 || confidence < 0.35) continue;

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
    // Traffic mode: only motorcycles can "fall" (cars don't fall in traffic)
    if (envMode === "traffic" && entity.class === "car") continue;
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
  // Traffic mode: NO vehicle-to-vehicle collision alerts.
  // Cars braking near each other is normal traffic. Only bike/person falls matter.
  if (envMode === "traffic") return [];

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
      const minScore = envMode === "isolated" ? 0.30 : 0.40;

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

  const vehicles = entities.filter(e => e.age >= 2 && ["car", "truck", "bus", "motorcycle"].includes(e.class));
  const persons = entities.filter(e => e.age >= 2 && e.class === "person");
  const bikes = entities.filter(e => e.age >= 2 && (e.class === "motorcycle" || e.class === "bicycle"));

  // 1. Sudden stop near another entity — ONLY for isolated/marketplace
  // Traffic mode: car braking near another car is NORMAL
  if (envMode !== "traffic") {
    for (const v of vehicles) {
      if (!isNearCamera(v)) continue;
      if (v.speedHistory.length < 4) continue;

      const recentSpeed = Math.max(...v.speedHistory.slice(0, 3));
      const isNowStopped = v.speed < 0.5;
      const wasMoving = recentSpeed > 0.4;

      if (!wasMoving || !isNowStopped) continue;

      const nearby = [...vehicles, ...persons].filter(e =>
        e.id !== v.id && e.age >= 1 && dist(v, e) < combinedR(v, e) * 4
      );

      for (const n of nearby) {
        const nSlow = n.speed < 0.5;
        if (!nSlow) continue;

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
        if (n.class === "person") confidence += 0.10;

        confidence *= (0.7 + 0.3 * distancePriority(v));

        if (confidence >= 0.40) {
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
  }

  // 2. Traffic mode: bike fall detection (bike stopped suddenly + person near)
  if (envMode === "traffic") {
    for (const bike of bikes) {
      if (!isNearCamera(bike)) continue;
      if (bike.speedHistory.length < 3) continue;

      const recentSpeed = Math.max(...bike.speedHistory.slice(0, 3));
      const wasMoving = recentSpeed > 0.3;
      const bikeNowStopped = bike.speed < 0.4;
      const bikeDecelerated = hasDecelerated(bike);

      // Check if bike fell (AR flip)
      const bikeAR = bike.aspectHistory.length > 0
        ? bike.aspectHistory[bike.aspectHistory.length - 1]
        : 0.5;
      const bikeWasUpright = bike.aspectHistory.length >= 3
        ? (bike.aspectHistory[0] + bike.aspectHistory[1]) / 2 < 0.8
        : false;
      const bikeNowFallen = bikeAR > 1.0;

      if (!wasMoving || (!bikeNowStopped && !bikeDecelerated && !bikeNowFallen)) continue;

      // Find associated person nearby
      const nearbyPerson = persons.find(p =>
        isNearCamera(p) && dist(bike, p) < combinedR(bike, p) * 5
      );

      let confidence = 0;
      const signals: EvidenceSignal[] = [];

      if (bikeNowFallen && bikeWasUpright) {
        confidence += 0.40;
        signals.push({ name: "bike_fell", value: 1, weight: 0.40, passed: true });
      } else {
        signals.push({ name: "bike_fell", value: 0, weight: 0.40, passed: false });
      }

      if (wasMoving && bikeNowStopped) {
        confidence += 0.30;
        signals.push({ name: "bike_stopped", value: 1, weight: 0.30, passed: true });
      } else if (bikeDecelerated) {
        confidence += 0.15;
        signals.push({ name: "bike_stopped", value: 0.5, weight: 0.30, passed: false });
      } else {
        signals.push({ name: "bike_stopped", value: 0, weight: 0.30, passed: false });
      }

      if (nearbyPerson) {
        confidence += 0.30;
        signals.push({ name: "person_near", value: 1, weight: 0.30, passed: true });
      } else {
        signals.push({ name: "person_near", value: 0, weight: 0.30, passed: false });
      }

      confidence *= (0.7 + 0.3 * distancePriority(bike));

      const passedCount = signals.filter(s => s.passed).length;
      if (passedCount >= 2 && confidence >= 0.45) {
        console.log(`[TTC] TRAFFIC BIKE FALL: bike#${bike.id} conf=${confidence.toFixed(3)} fallen=${bikeNowFallen} stopped=${bikeNowStopped} person=${!!nearbyPerson}`);
        evidence.push({
          type: "bike_crash",
          confidence: Math.min(0.9, confidence),
          objects: nearbyPerson ? [bike.id, nearbyPerson.id] : [bike.id],
          details: `Traffic bike fall: fallen=${bikeNowFallen} stopped=${bikeNowStopped} person=${!!nearbyPerson}`,
          signals,
          sceneContext: "traffic",
        });
      }
    }
  }

  // 3. Person suddenly stopped on road — ALL modes (person fall is always suspicious)
  for (const p of persons) {
    if (!isNearCamera(p)) continue;
    if (p.speedHistory.length < 4) continue;

    const wasMoving = Math.max(...p.speedHistory.slice(0, 3)) > 0.3;
    const isNowStopped = p.speed < 0.35;
    const stoppedFrames = p.speedHistory.slice(0, 5).filter(s => s < 0.4).length;

    if (wasMoving && isNowStopped && stoppedFrames >= 2) {
      // Check if person's position dropped (fell down)
      let positionDropped = false;
      if (p.positions.length >= 3) {
        const prevY = p.positions[p.positions.length - 3].y;
        const curY = p.positions[p.positions.length - 1].y;
        positionDropped = curY > prevY + 2;
      }

      // Check if person's AR changed (lying down)
      const personAR = p.aspectHistory.length > 0
        ? p.aspectHistory[p.aspectHistory.length - 1]
        : 0.5;
      const personLying = personAR > 0.85;

      // Traffic mode: require position drop OR lying down (more strict)
      if (envMode === "traffic" && !positionDropped && !personLying) continue;

      let confidence = 0.45;
      if (positionDropped) confidence += 0.15;
      if (personLying) confidence += 0.10;

      const signals: EvidenceSignal[] = [
        { name: "was_moving", value: 1, weight: 0.3, passed: true },
        { name: "now_stopped", value: 1, weight: 0.3, passed: true },
        { name: "position_dropped", value: positionDropped ? 1 : 0, weight: 0.2, passed: positionDropped },
        { name: "person_lying", value: personLying ? 1 : 0, weight: 0.2, passed: personLying },
      ];

      confidence *= (0.7 + 0.3 * distancePriority(p));

      if (confidence >= 0.40) {
        console.log(`[TTC] PERSON STOPPED: #${p.id} was moving, now stopped conf=${confidence.toFixed(3)}`);
        evidence.push({
          type: "person_fall",
          confidence: Math.min(0.85, confidence),
          objects: [p.id],
          details: `Person stopped suddenly (was moving, now stationary for ${stoppedFrames} frames, lying=${personLying})`,
          signals,
          sceneContext: envMode,
        });
      }
    }
  }

  return evidence;
}

// ========== LOST ENTITY DETECTION ==========
// When a tracked entity disappears, check if it was in an accident.
// This catches objects that COCO-SSD stops detecting (fallen bike, lying person).

export interface LostEntityData {
  id: number;
  class: string;
  lastX: number;
  lastY: number;
  lastSpeed: number;
  lastHeading: number;
  lostAtFrame: number;
  wasMoving: boolean;
}

function detectLostEntityAccidents(
  lostEntities: LostEntityData[],
  currentEntities: TrackedEntity[],
  envMode: EnvMode
): AccidentEvidence[] {
  const evidence: AccidentEvidence[] = [];

  for (const lost of lostEntities) {
    // Traffic mode: only care about bikes and persons disappearing (not cars)
    if (envMode === "traffic" && lost.class !== "motorcycle" && lost.class !== "bicycle" && lost.class !== "person") continue;

    console.log(`[TTC] CHECKING LOST ENTITY: ${lost.class}#${lost.id} was ${lost.lastSpeed.toFixed(1)}px/f at (${lost.lastX.toFixed(0)},${lost.lastY.toFixed(0)})`);

    // Find nearby current entities (broadened radius)
    const nearby = currentEntities.filter(e => {
      const dx = e.kalman.getState().x - lost.lastX;
      const dy = e.kalman.getState().y - lost.lastY;
      const d = Math.sqrt(dx * dx + dy * dy);
      return d < 300; // relaxed from 200
    });

    console.log(`[TTC] LOST ENTITY ${lost.id}: found ${nearby.length} nearby entities`);

    for (const n of nearby) {
      // Traffic mode: require nearby entity to be a person (bike fell + person nearby)
      if (envMode === "traffic" && lost.class !== "person" && n.class !== "person") continue;

      // Check if the nearby entity also stopped or slowed down
      const nSlowed = n.speed < 0.6 || hasDecelerated(n); // relaxed
      if (!nSlowed) continue;

      let confidence = lost.wasMoving ? 0.60 : 0.45; // higher if was moving
      confidence *= (0.7 + 0.3 * distancePriority(n));

      console.log(`[TTC] LOST ENTITY ALERT: ${lost.class}#${lost.id} disappeared near ${n.class}#${n.id} conf=${confidence.toFixed(3)}`);

      evidence.push({
        type: "collision",
        confidence: Math.min(0.85, confidence),
        objects: [lost.id, n.id],
        details: `Lost entity: ${lost.class}#${lost.id} disappeared near ${n.class}#${n.id} (was ${lost.lastSpeed.toFixed(1)}px/f)`,
        signals: [
          { name: "entity_lost", value: 1, weight: 0.35, passed: true },
          { name: "was_moving", value: lost.wasMoving ? 1 : 0, weight: 0.30, passed: lost.wasMoving },
          { name: "nearby_stopped", value: nSlowed ? 1 : 0, weight: 0.35, passed: nSlowed },
        ],
        sceneContext: envMode,
      });
    }

    // Also fire if entity vanished while near camera and was moving (no need for nearby entity)
    // Traffic mode: only for bikes/persons, not vehicles
    if (lost.wasMoving && lost.lastY > 0.35) { // near camera (bottom 65%)
      const isTrafficRelevant = envMode !== "traffic" || lost.class === "motorcycle" || lost.class === "bicycle" || lost.class === "person";
      if (isTrafficRelevant) {
        const hasNearby = nearby.some(e => e.speed < 0.6);
        if (!hasNearby) {
          // Entity vanished while moving near camera — suspicious on its own
          let confidence = 0.40;
          confidence *= (0.7 + 0.3 * (lost.lastY > 0.7 ? 1.0 : lost.lastY > 0.5 ? 0.8 : 0.5));
          evidence.push({
            type: "collision",
            confidence: Math.min(0.75, confidence),
            objects: [lost.id],
            details: `Entity vanished: ${lost.class}#${lost.id} was moving near camera, disappeared`,
            signals: [
              { name: "entity_lost", value: 1, weight: 0.40, passed: true },
              { name: "was_moving", value: 1, weight: 0.30, passed: true },
              { name: "near_camera", value: 1, weight: 0.30, passed: true },
            ],
            sceneContext: envMode,
          });
        }
      }
    }
  }

  return evidence;
}

// ========== HEATMAP COLLISION DETECTION ==========
// Detects collisions from sudden change grid fluctuations in isolated mode.
// A sudden spike in pixel changes = impact / collision event.

function detectHeatmapCollision(entities: TrackedEntity[], changeGrid: number[]): AccidentEvidence[] {
  const evidence: AccidentEvidence[] = [];
  if (changeGrid.length === 0) return evidence;

  const GRID_COLS = 10;
  const GRID_ROWS = 8;
  const avgChange = changeGrid.reduce((a, b) => a + b, 0) / changeGrid.length;

  // Find cells with significant change — lower threshold for collision detection
  const hotCells: number[] = [];
  for (let i = 0; i < changeGrid.length; i++) {
    // Any cell with change > 10% OR > 2x average is suspicious
    if (changeGrid[i] > 0.08 || changeGrid[i] > avgChange * 1.5) {
      hotCells.push(i);
    }
  }

  // Find clusters of hot cells (adjacent = collision event, not random noise)
  const clusters: number[][] = [];
  let currentCluster = hotCells.length > 0 ? [hotCells[0]] : [];
  for (let i = 1; i < hotCells.length; i++) {
    // Adjacent if within 2 cells (horizontal or vertical)
    const prevCell = hotCells[i - 1];
    const curCell = hotCells[i];
    const prevRow = Math.floor(prevCell / GRID_COLS);
    const prevCol = prevCell % GRID_COLS;
    const curRow = Math.floor(curCell / GRID_COLS);
    const curCol = curCell % GRID_COLS;
    const isAdjacent = Math.abs(prevRow - curRow) <= 1 && Math.abs(prevCol - curCol) <= 2;
    if (isAdjacent) {
      currentCluster.push(curCell);
    } else {
      if (currentCluster.length >= 1) clusters.push(currentCluster);
      currentCluster = [curCell];
    }
  }
  if (currentCluster.length >= 1) clusters.push(currentCluster);

  for (const cluster of clusters) {
    // Calculate cluster center in normalized coordinates
    const avgCell = cluster.reduce((a, b) => a + b, 0) / cluster.length;
    const gridX = (avgCell % GRID_COLS) / GRID_COLS;
    const gridY = Math.floor(avgCell / GRID_COLS) / GRID_ROWS;
    const maxChange = Math.max(...cluster.map(i => changeGrid[i]));

    // Check if any near-camera entity is near this heatmap spike
    const nearEntities = entities.filter(e => {
      const k = e.kalman.getState();
      const eNormX = k.x / 640;
      const eNormY = k.y / 480;
      const dx = eNormX - gridX;
      const dy = eNormY - gridY;
      return Math.sqrt(dx * dx + dy * dy) < 0.3 && isNearCamera(e);
    });

    if (nearEntities.length === 0) continue;

    // Check entity states
    const movingCount = nearEntities.filter(e => wasFast(e)).length;
    const decelCount = nearEntities.filter(e => hasDecelerated(e)).length;
    const deflectedCount = nearEntities.filter(e => {
      if (e.headingHistory.length < 5) return false;
      const cur = e.headingHistory[e.headingHistory.length - 1];
      const prev = e.headingHistory[e.headingHistory.length - 5];
      let change = Math.abs(cur - prev);
      if (change > Math.PI) change = 2 * Math.PI - change;
      return (change * 180) / Math.PI > 25;
    }).length;
    const stoppedCount = nearEntities.filter(e => e.speed < 0.3).length;

    let confidence = 0.35;
    // Heatmap spike strength
    confidence += 0.15 * Math.min(maxChange * 4, 1);
    // Cluster size (more hot cells = bigger impact)
    confidence += 0.10 * Math.min(cluster.length / 3, 1);
    // Moving entities near spike
    if (movingCount >= 1) confidence += 0.10;
    // Deceleration after spike
    if (decelCount >= 1) confidence += 0.10;
    // Direction change (deflection)
    if (deflectedCount >= 1) confidence += 0.15;
    // Stopped after moving
    if (stoppedCount >= 1 && movingCount >= 1) confidence += 0.10;

    confidence *= (0.7 + 0.3 * distancePriority(nearEntities[0]));

    const signals: EvidenceSignal[] = [
      { name: "heatmap_spike", value: maxChange, weight: 0.25, passed: maxChange > 0.08 },
      { name: "entities_near", value: nearEntities.length, weight: 0.20, passed: nearEntities.length >= 1 },
      { name: "moving_before", value: movingCount, weight: 0.15, passed: movingCount >= 1 },
      { name: "deceleration", value: decelCount, weight: 0.15, passed: decelCount >= 1 },
      { name: "deflection", value: deflectedCount, weight: 0.15, passed: deflectedCount >= 1 },
      { name: "stopped", value: stoppedCount, weight: 0.10, passed: stoppedCount >= 1 },
    ];

    if (confidence >= 0.45) {
      console.log(`[TTC] HEATMAP COLLISION: ${nearEntities.length} entities, spike=${maxChange.toFixed(3)}, cluster=${cluster.length}, conf=${confidence.toFixed(3)}`);
      evidence.push({
        type: "collision",
        confidence: Math.min(0.85, confidence),
        objects: nearEntities.map(e => e.id),
        details: `Heatmap: ${cluster.length} hot cells, spike=${maxChange.toFixed(3)}, moving=${movingCount}, decel=${decelCount}, deflect=${deflectedCount}`,
        signals,
        sceneContext: "isolated",
      });
    }
  }

  return evidence;
}

// ========== MAIN EXPORT ==========

/**
 * Isolated-mode only: detect thrown vehicles and person recovery.
 * Only fires on clear accident signals, not normal driving.
 */
function detectIsolatedAnomalies(entities: TrackedEntity[]): AccidentEvidence[] {
  const evidence: AccidentEvidence[] = [];
  const vehicles = entities.filter(e => e.age >= 2 && ["car", "truck", "bus", "motorcycle"].includes(e.class));
  const persons = entities.filter(e => e.age >= 2 && e.class === "person");

  // 1. Vehicle fall: was upright (AR < 0.8), now fallen (AR > 1.2) = bike/car on its side
  for (const v of vehicles) {
    if (!isNearCamera(v)) continue;
    if (v.aspectHistory.length < 3) continue;

    const currentAR = v.aspectHistory[v.aspectHistory.length - 1];
    const prevAR = (v.aspectHistory[0] + v.aspectHistory[1]) / 2;
    const wasUpright = prevAR < 0.8;
    const nowFallen = currentAR > 1.2;

    if (wasUpright && nowFallen) {
      const wasMoving = wasFast(v);
      const stationary = isStationary(v);
      let confidence = 0.65;
      if (wasMoving && stationary) confidence += 0.15;
      confidence *= (0.7 + 0.3 * distancePriority(v));

      evidence.push({
        type: "vehicle_fall",
        confidence: Math.min(0.9, confidence),
        objects: [v.id],
        details: `${v.class} fell: AR ${prevAR.toFixed(2)}->${currentAR.toFixed(2)}`,
        signals: [
          { name: "aspect_flip", value: 1, weight: 0.5, passed: true },
          { name: "was_moving", value: wasMoving ? 1 : 0, weight: 0.3, passed: wasMoving },
          { name: "now_stationary", value: stationary ? 1 : 0, weight: 0.2, passed: stationary },
        ],
        sceneContext: "isolated",
      });
    }
  }

  // 2. Person recovery: was lying (AR > 0.8), now standing (AR < 0.75) = got up after accident
  for (const p of persons) {
    if (!isNearCamera(p)) continue;
    if (p.aspectHistory.length < 3) continue;

    const currentAR = p.aspectHistory[p.aspectHistory.length - 1];
    const prevAR = (p.aspectHistory[0] + p.aspectHistory[1]) / 2;
    const wasLying = prevAR > 0.8;
    const nowStanding = currentAR < 0.75;

    if (wasLying && nowStanding) {
      let confidence = 0.70;
      const wasStationary = p.speedHistory.slice(0, 3).every(s => s < 0.3);
      if (wasStationary) confidence += 0.10;
      confidence *= (0.7 + 0.3 * distancePriority(p));

      evidence.push({
        type: "person_fall",
        confidence: Math.min(0.9, confidence),
        objects: [p.id],
        details: `Person recovery: AR ${prevAR.toFixed(2)}->${currentAR.toFixed(2)}`,
        signals: [
          { name: "was_lying", value: 1, weight: 0.4, passed: true },
          { name: "now_standing", value: 1, weight: 0.3, passed: true },
          { name: "was_stationary", value: wasStationary ? 1 : 0, weight: 0.3, passed: wasStationary },
        ],
        sceneContext: "isolated",
      });
    }
  }

  // 3. Sudden deceleration to zero near another entity = collision impact
  for (const v of vehicles) {
    if (!isNearCamera(v)) continue;
    if (v.speedHistory.length < 4) continue;

    const recentSpeed = Math.max(...v.speedHistory.slice(0, 2));
    const isNowStopped = v.speed < 0.2;
    const wasMoving = recentSpeed > 1.0;

    if (!wasMoving || !isNowStopped) continue;

    // Must be near another entity
    const nearby = [...vehicles, ...persons].filter(e =>
      e.id !== v.id && e.age >= 1 && dist(v, e) < combinedR(v, e) * 4
    );
    if (nearby.length === 0) continue;

    let confidence = 0.55;
    confidence *= (0.7 + 0.3 * distancePriority(v));

    evidence.push({
      type: "collision",
      confidence: Math.min(0.85, confidence),
      objects: [v.id, nearby[0].id],
      details: `${v.class} sudden stop near ${nearby[0].class} (was ${recentSpeed.toFixed(1)}px/f)`,
      signals: [
        { name: "sudden_stop", value: 1, weight: 0.5, passed: true },
        { name: "nearby_entity", value: 1, weight: 0.5, passed: true },
      ],
      sceneContext: "isolated",
    });
  }

  // 4. DEFLECTION DETECTION: sudden heading change at speed = collision impact
  // When a vehicle is moving fast and suddenly changes direction, it hit something
  for (const v of vehicles) {
    if (!isNearCamera(v)) continue;
    if (v.headingHistory.length < 5 || v.speedHistory.length < 5) continue;

    const recentSpeed = Math.max(...v.speedHistory.slice(0, 2));
    if (recentSpeed < 0.5) continue; // must have been moving

    // Calculate heading change over last 5 frames
    const currentHeading = v.headingHistory[v.headingHistory.length - 1];
    const prevHeading = v.headingHistory[v.headingHistory.length - 5];
    let headingChange = Math.abs(currentHeading - prevHeading);
    if (headingChange > Math.PI) headingChange = 2 * Math.PI - headingChange;
    const headingChangeDeg = (headingChange * 180) / Math.PI;

    // Sudden direction change (>30 degrees in 5 frames) = deflection/collision
    if (headingChangeDeg < 30) continue;

    // Must be near another entity (the thing it hit)
    const nearby = [...vehicles, ...persons].filter(e =>
      e.id !== v.id && e.age >= 1 && dist(v, e) < combinedR(v, e) * 5
    );
    if (nearby.length === 0) continue;

    // Check if nearby entity also changed direction or decelerated
    const nearbyDeflected = nearby.some(n => {
      if (n.headingHistory.length < 5) return false;
      const nCur = n.headingHistory[n.headingHistory.length - 1];
      const nPrev = n.headingHistory[n.headingHistory.length - 5];
      let nChange = Math.abs(nCur - nPrev);
      if (nChange > Math.PI) nChange = 2 * Math.PI - nChange;
      return (nChange * 180) / Math.PI > 25;
    });
    const nearbyDecelerated = nearby.some(n => hasDecelerated(n) || n.speed < 0.3);

    let confidence = 0.50;
    const signals: EvidenceSignal[] = [
      { name: "heading_change", value: headingChangeDeg / 90, weight: 0.40, passed: headingChangeDeg > 30 },
      { name: "was_moving", value: recentSpeed > 0.5 ? 1 : 0, weight: 0.25, passed: recentSpeed > 0.5 },
      { name: "nearby_entity", value: 1, weight: 0.20, passed: true },
      { name: "nearby_deflected", value: nearbyDeflected ? 1 : 0, weight: 0.15, passed: nearbyDeflected },
    ];

    if (headingChangeDeg > 45) confidence += 0.15;
    if (nearbyDeflected) confidence += 0.10;
    if (nearbyDecelerated) confidence += 0.10;
    confidence *= (0.7 + 0.3 * distancePriority(v));

    if (confidence >= 0.45) {
      console.log(`[TTC] DEFLECTION: ${v.class}#${v.id} heading changed ${headingChangeDeg.toFixed(0)}deg near ${nearby[0].class}#${nearby[0].id} conf=${confidence.toFixed(3)}`);
      evidence.push({
        type: "collision",
        confidence: Math.min(0.9, confidence),
        objects: [v.id, nearby[0].id],
        details: `Deflection: ${v.class} heading changed ${headingChangeDeg.toFixed(0)}deg at ${(recentSpeed * 3.6).toFixed(0)}km/h`,
        signals,
        sceneContext: "isolated",
      });
    }
  }

  return evidence;
}

export function detectAccidents(
  entities: TrackedEntity[],
  envMode: EnvMode,
  lostEntities: LostEntityData[] = [],
  changeGrid: number[] = []
): AccidentEvidence[] {
  // ====== TRAFFIC MODE: bike/person only, no vehicles ======
  if (envMode === "traffic") {
    return detectTrafficAccidents(entities, lostEntities);
  }

  // ====== ISOLATED/MARKETPLACE: full detection ======
  let evidence: AccidentEvidence[] = [];

  // 1. Heatmap collision detection (isolated mode)
  if (envMode === "isolated" && changeGrid.length > 0) {
    evidence.push(...detectHeatmapCollision(entities, changeGrid));
  }

  // 2. Lost entity detection
  evidence.push(...detectLostEntityAccidents(lostEntities, entities, envMode));

  // 3. Motion-based anomalies
  evidence.push(...detectMotionAnomalies(entities, envMode));

  // 4. Isolated-mode specific
  if (envMode === "isolated") {
    evidence.push(...detectIsolatedAnomalies(entities));
  }

  // 5. Person-bike crash detection
  const pairs = findPersonBikePairs(entities);
  evidence.push(...detectBikeCrash(pairs, envMode));

  // 6. Vehicle collision (near-camera only)
  evidence.push(...detectVehicleCollision(entities, envMode));

  // 7. Vehicle fall (near-camera only)
  evidence.push(...detectVehicleFall(entities, envMode));

  // 8. Person fall (near-camera only)
  evidence.push(...detectPersonFall(entities, envMode));

  return deduplicate(evidence);
}

/**
 * TRAFFIC MODE: Strict detection — only bike falls, bike stops, person falls.
 * Zero vehicle-to-vehicle alerts. Cars braking near each other = normal traffic.
 */
function detectTrafficAccidents(
  entities: TrackedEntity[],
  lostEntities: LostEntityData[]
): AccidentEvidence[] {
  const evidence: AccidentEvidence[] = [];
  const persons = entities.filter(e => e.age >= 2 && e.class === "person");
  const bikes = entities.filter(e => e.age >= 2 && (e.class === "motorcycle" || e.class === "bicycle"));

  // 1. Bike crash detection (both bike AND person must be near camera)
  const pairs = findPersonBikePairs(entities);
  for (const pair of pairs) {
    const { person, bike, distance } = pair;
    if (!isNearCamera(bike, 480, "traffic") || !isNearCamera(person, 480, "traffic")) continue;

    const bikeWasUpright = bike.aspectHistory.length >= 3
      ? (bike.aspectHistory[0] + bike.aspectHistory[1]) / 2 < 0.8
      : false;
    const bikeNowFallen = bike.aspectHistory.length > 0
      ? bike.aspectHistory[bike.aspectHistory.length - 1] > 1.0
      : false;
    const bikeWasMoving = wasFast(bike);
    const bikeNowStopped = isStationary(bike);
    const bikeDecelerated = hasDecelerated(bike);
    const personAR = person.aspectHistory.length > 0
      ? person.aspectHistory[person.aspectHistory.length - 1]
      : 0.5;
    const personLying = personAR > 0.85;

    let personSeparated = false;
    if (person.positions.length >= 3 && bike.positions.length >= 3) {
      const prevDist = Math.sqrt(
        (person.positions[person.positions.length - 3].x - bike.positions[bike.positions.length - 3].x) ** 2 +
        (person.positions[person.positions.length - 3].y - bike.positions[bike.positions.length - 3].y) ** 2
      );
      personSeparated = distance > prevDist * 1.5 + 10;
    }

    let confidence = 0;
    const signals: EvidenceSignal[] = [];

    if (bikeWasUpright && bikeNowFallen) {
      confidence += 0.40;
      signals.push({ name: "bike_fell", value: 1, weight: 0.40, passed: true });
    } else {
      signals.push({ name: "bike_fell", value: 0, weight: 0.40, passed: false });
    }

    if (bikeWasMoving && bikeNowStopped) {
      confidence += 0.25;
      signals.push({ name: "bike_stopped", value: 1, weight: 0.25, passed: true });
    } else if (bikeDecelerated) {
      confidence += 0.10;
      signals.push({ name: "bike_stopped", value: 0.5, weight: 0.25, passed: false });
    } else {
      signals.push({ name: "bike_stopped", value: 0, weight: 0.25, passed: false });
    }

    if (personLying) {
      confidence += 0.25;
      signals.push({ name: "person_lying", value: 1, weight: 0.25, passed: true });
    } else {
      signals.push({ name: "person_lying", value: 0, weight: 0.25, passed: false });
    }

    if (personSeparated) {
      confidence += 0.10;
      signals.push({ name: "person_separated", value: 1, weight: 0.10, passed: true });
    } else {
      signals.push({ name: "person_separated", value: 0, weight: 0.10, passed: false });
    }

    const distBoost = Math.max(distancePriority(bike), distancePriority(person));
    confidence *= (0.7 + 0.3 * distBoost);

    const passedSignals = signals.filter(s => s.passed).length;
    if (passedSignals < 2 || confidence < 0.45) continue;

    console.log(`[TTC] TRAFFIC BIKE CRASH: bike#${bike.id} person#${person.id} conf=${confidence.toFixed(3)} fell=${bikeNowFallen} stopped=${bikeNowStopped} lying=${personLying}`);
    evidence.push({
      type: "bike_crash",
      confidence: Math.min(0.95, confidence),
      objects: [bike.id, person.id],
      details: `Bike crash: fell=${bikeNowFallen} stopped=${bikeNowStopped} person_lying=${personLying} sep=${personSeparated}`,
      signals,
      sceneContext: "traffic",
    });
  }

  // 2. Standalone bike fall (no person needed — bike fell on its own)
  for (const bike of bikes) {
    if (!isNearCamera(bike, 480, "traffic")) continue;
    if (bike.aspectHistory.length < 3) continue;

    const currentAR = bike.aspectHistory[bike.aspectHistory.length - 1];
    const prevAR = (bike.aspectHistory[0] + bike.aspectHistory[1]) / 2;
    const wasUpright = prevAR < 0.8;
    const nowFallen = currentAR > 1.0;

    if (!wasUpright || !nowFallen) continue;
    const wasMoving = wasFast(bike);
    const stationary = isStationary(bike);

    let confidence = 0.55;
    if (wasMoving && stationary) confidence += 0.15;
    confidence *= (0.7 + 0.3 * distancePriority(bike));

    // Check if person is nearby
    const nearbyPerson = persons.find(p =>
      isNearCamera(p, 480, "traffic") && dist(bike, p) < combinedR(bike, p) * 5
    );
    if (nearbyPerson) confidence += 0.10;

    console.log(`[TTC] TRAFFIC BIKE FALL: bike#${bike.id} conf=${confidence.toFixed(3)} fell=${nowFallen} person=${!!nearbyPerson}`);
    evidence.push({
      type: "bike_crash",
      confidence: Math.min(0.9, confidence),
      objects: nearbyPerson ? [bike.id, nearbyPerson.id] : [bike.id],
      details: `Bike fell: AR ${prevAR.toFixed(2)}->${currentAR.toFixed(2)} person=${!!nearbyPerson}`,
      signals: [
        { name: "bike_fell", value: 1, weight: 0.45, passed: true },
        { name: "was_moving", value: wasMoving ? 1 : 0, weight: 0.25, passed: wasMoving },
        { name: "now_stationary", value: stationary ? 1 : 0, weight: 0.30, passed: stationary },
      ],
      sceneContext: "traffic",
    });
  }

  // 3. Person fall — person was standing, now lying (both near camera)
  for (const p of persons) {
    if (!isNearCamera(p, 480, "traffic")) continue;
    if (p.aspectHistory.length < 3) continue;

    const currentAR = p.aspectHistory[p.aspectHistory.length - 1];
    const prevAR = p.aspectHistory.length >= 3
      ? (p.aspectHistory[0] + p.aspectHistory[1]) / 2
      : currentAR;
    const wasStanding = prevAR < 0.8;
    const nowLying = currentAR > 0.85;

    if (!wasStanding || !nowLying) continue;

    // Require position drop (person actually fell, not just detected as lying)
    let positionDropped = false;
    if (p.positions.length >= 3) {
      const prevY = p.positions[p.positions.length - 3].y;
      const curY = p.positions[p.positions.length - 1].y;
      positionDropped = curY > prevY + 3;
    }

    // Also require person was moving or recently moving (fell while active)
    const wasMoving = wasFast(p);

    // Need at least position drop OR was moving
    if (!positionDropped && !wasMoving) continue;

    let confidence = 0.60;
    if (positionDropped) confidence += 0.10;
    if (wasMoving) confidence += 0.10;
    confidence *= (0.7 + 0.3 * distancePriority(p));

    console.log(`[TTC] TRAFFIC PERSON FALL: #${p.id} conf=${confidence.toFixed(3)} dropped=${positionDropped} wasMoving=${wasMoving}`);
    evidence.push({
      type: "person_fall",
      confidence: Math.min(0.9, confidence),
      objects: [p.id],
      details: `Person fell: AR ${prevAR.toFixed(2)}->${currentAR.toFixed(2)} dropped=${positionDropped}`,
      signals: [
        { name: "person_lying", value: 1, weight: 0.40, passed: true },
        { name: "position_drop", value: positionDropped ? 1 : 0, weight: 0.30, passed: positionDropped },
        { name: "was_moving", value: wasMoving ? 1 : 0, weight: 0.30, passed: wasMoving },
      ],
      sceneContext: "traffic",
    });
  }

  // 4. Lost entity — only bikes/persons (lost bike near stopped person, or vice versa)
  for (const lost of lostEntities) {
    if (lost.class !== "motorcycle" && lost.class !== "bicycle" && lost.class !== "person") continue;
    if (lost.lastY < 0.55) continue; // must be in bottom 45% (near camera in traffic)

    const nearby = currentEntities(entities, lost.lastX, lost.lastY, 200);
    for (const n of nearby) {
      if (n.class !== "person" && lost.class !== "person") continue; // one must be a person
      if (n.speed > 0.6 && !hasDecelerated(n)) continue;

      let confidence = lost.wasMoving ? 0.60 : 0.45;
      confidence *= (0.7 + 0.3 * distancePriority(n));

      evidence.push({
        type: "collision",
        confidence: Math.min(0.85, confidence),
        objects: [lost.id, n.id],
        details: `Lost: ${lost.class}#${lost.id} near ${n.class}#${n.id} (was ${lost.lastSpeed.toFixed(1)}px/f)`,
        signals: [
          { name: "entity_lost", value: 1, weight: 0.35, passed: true },
          { name: "was_moving", value: lost.wasMoving ? 1 : 0, weight: 0.30, passed: lost.wasMoving },
          { name: "nearby_stopped", value: 1, weight: 0.35, passed: true },
        ],
        sceneContext: "traffic",
      });
    }
  }

  return deduplicate(evidence);
}

function currentEntities(entities: TrackedEntity[], x: number, y: number, radius: number): TrackedEntity[] {
  return entities.filter(e => {
    const dx = e.kalman.getState().x - x;
    const dy = e.kalman.getState().y - y;
    return Math.sqrt(dx * dx + dy * dy) < radius;
  });
}

function deduplicate(evidence: AccidentEvidence[]): AccidentEvidence[] {
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
  isolated: { minScore: 0.30, minSignals: 2, cooldownMs: 3000 },
  traffic: { minScore: 0.45, minSignals: 2, cooldownMs: 6000 },
  marketplace: { minScore: 0.40, minSignals: 2, cooldownMs: 6000 },
};

export { isNearCamera, distancePriority, isPassing, hasDecelerated, dist, combinedR, calcIoU };

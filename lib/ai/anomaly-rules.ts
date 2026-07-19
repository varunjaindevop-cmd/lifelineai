import { Detection, TrackedObject, AnomalyResult, AnomalySignal } from "./types";

export type SceneContext = "isolated_road" | "traffic" | "marketplace";

// Calculate IoU between two bounding boxes
function calculateIoU(
  box1: [number, number, number, number],
  box2: [number, number, number, number]
): number {
  const [x1, y1, x2, y2] = box1;
  const [x3, y3, x4, y4] = box2;
  const intersectX1 = Math.max(x1, x3);
  const intersectY1 = Math.max(y1, y3);
  const intersectX2 = Math.min(x2, x4);
  const intersectY2 = Math.min(y2, y4);
  const intersectArea = Math.max(0, intersectX2 - intersectX1) * Math.max(0, intersectY2 - intersectY1);
  const box1Area = (x2 - x1) * (y2 - y1);
  const box2Area = (x4 - x3) * (y4 - y3);
  const unionArea = box1Area + box2Area - intersectArea;
  return unionArea > 0 ? intersectArea / unionArea : 0;
}

// Calculate distance between two points
function distance(p1: { x: number; y: number }, p2: { x: number; y: number }): number {
  return Math.sqrt(Math.pow(p2.x - p1.x, 2) + Math.pow(p2.y - p1.y, 2));
}

// Estimate scene context from tracked objects
export function estimateSceneContext(objects: TrackedObject[]): SceneContext {
  const vehicles = objects.filter(o => o.class === "car" || o.class === "truck" || o.class === "bus");
  const pedestrians = objects.filter(o => o.class === "person");
  const total = vehicles.length + pedestrians.length;
  if (total === 0) return "isolated_road";

  const vehicleRatio = vehicles.length / total;
  const pedestrianCount = pedestrians.length;

  // Marketplace: mostly pedestrians, few/no vehicles
  if (vehicleRatio < 0.15 && pedestrianCount >= 3) return "marketplace";
  // Traffic: significant vehicles present
  if (vehicleRatio >= 0.3) return "traffic";
  // Default: isolated road with sparse objects
  return "isolated_road";
}

// Detect vehicle-vehicle collision
export function detectVehicleCollision(
  objects: TrackedObject[],
  sceneChangeScore: number,
  sceneContext: SceneContext = "isolated_road"
): AnomalyResult | null {
  const vehicles = objects.filter(
    (o) => o.class === "car" || o.class === "truck" || o.class === "bus"
  );

  // In marketplace, skip vehicle-vehicle collision (no vehicles expected)
  if (sceneContext === "marketplace" && vehicles.length < 2) return null;

  let bestResult: AnomalyResult | null = null;

  for (let i = 0; i < vehicles.length; i++) {
    for (let j = i + 1; j < vehicles.length; j++) {
      const v1 = vehicles[i];
      const v2 = vehicles[j];
      const lastDet1 = v1.detections[v1.detections.length - 1];
      const lastDet2 = v2.detections[v2.detections.length - 1];

      const iou = calculateIoU(lastDet1.bbox, lastDet2.bbox);
      const sceneSpike = sceneChangeScore > 0.3 ? 1 : sceneChangeScore / 0.3;

      // Check actual direction convergence using velocity vectors
      const v1Speed = Math.sqrt(v1.velocity.vx ** 2 + v1.velocity.vy ** 2);
      const v2Speed = Math.sqrt(v2.velocity.vx ** 2 + v2.velocity.vy ** 2);

      // Require both vehicles to actually be moving for convergence check
      let convergenceScore = 0;
      if (v1Speed > 1 && v2Speed > 1) {
        // Dot product of normalized velocities — negative means heading toward each other
        const dot = (v1.velocity.vx * v2.velocity.vx + v1.velocity.vy * v2.velocity.vy) / (v1Speed * v2Speed);
        convergenceScore = dot < -0.2 ? Math.min(Math.abs(dot), 1) : 0;
      }

      const signals: AnomalySignal[] = [
        { name: "IoU Overlap", value: iou, threshold: 0.1, passed: iou > 0.1 },
        { name: "Scene Spike", value: sceneChangeScore, threshold: 0.3, passed: sceneChangeScore > 0.3 },
        { name: "Direction Convergence", value: convergenceScore, threshold: 0.3, passed: convergenceScore > 0.3 },
      ];

      const confidence =
        0.4 * Math.min(iou * 5, 1) +
        0.3 * sceneSpike +
        0.3 * convergenceScore;

      // Require IoU overlap OR convergence+scene spike — at least 2 signals
      if (confidence > 0.35 && signals.filter((s) => s.passed).length >= 2) {
        const severity =
          confidence > 0.7 ? "critical" : confidence > 0.5 ? "major" : "minor";

        if (!bestResult || confidence > bestResult.confidence) {
          bestResult = {
            type: "vehicle_collision",
            confidence,
            signals,
            severity,
          };
        }
      }
    }
  }

  return bestResult;
}

// Detect vehicle-pedestrian collision
export function detectPedestrianCollision(
  objects: TrackedObject[],
  sceneChangeScore: number,
  sceneContext: SceneContext = "isolated_road"
): AnomalyResult | null {
  const vehicles = objects.filter(
    (o) => o.class === "car" || o.class === "truck" || o.class === "bus"
  );
  const pedestrians = objects.filter((o) => o.class === "person");

  // No vehicles = no vehicle-pedestrian collision possible
  if (vehicles.length === 0) return null;

  // In marketplace with only 1 car detection (likely false positive), skip
  if (sceneContext === "marketplace" && vehicles.length < 2) return null;

  let bestResult: AnomalyResult | null = null;

  for (const vehicle of vehicles) {
    const vSpeed = Math.sqrt(vehicle.velocity.vx ** 2 + vehicle.velocity.vy ** 2);
    // Vehicle must be moving to hit a pedestrian
    if (vSpeed < 1) continue;

    for (const pedestrian of pedestrians) {
      const lastV = vehicle.detections[vehicle.detections.length - 1];
      const lastP = pedestrian.detections[pedestrian.detections.length - 1];

      const iou = calculateIoU(lastV.bbox, lastP.bbox);
      const overlap = iou > 0.05 ? 1 : 0;

      // Proximity: are they close (within 1.5x combined bounding box size)?
      const dist = distance(
        { x: (lastV.bbox[0] + lastV.bbox[2]) / 2, y: (lastV.bbox[1] + lastV.bbox[3]) / 2 },
        { x: (lastP.bbox[0] + lastP.bbox[2]) / 2, y: (lastP.bbox[1] + lastP.bbox[3]) / 2 }
      );
      const combinedSize = Math.sqrt(lastV.width ** 2 + lastV.height ** 2) + Math.sqrt(lastP.width ** 2 + lastP.height ** 2);
      const proximity = dist < combinedSize * 0.75 ? 1 : dist < combinedSize * 1.5 ? 0.5 : 0;

      // Vehicle heading toward pedestrian
      const dx = lastP.centerX - lastV.centerX;
      const dy = lastP.centerY - lastV.centerY;
      const headingDot = vehicle.velocity.vx * dx + vehicle.velocity.vy * dy;
      const headingToward = headingDot > 0 ? 1 : 0;

      const signals: AnomalySignal[] = [
        { name: "Overlap", value: overlap, threshold: 0.5, passed: overlap > 0.5 },
        { name: "Proximity", value: proximity, threshold: 0.5, passed: proximity > 0.5 },
        { name: "Scene Spike", value: sceneChangeScore, threshold: 0.2, passed: sceneChangeScore > 0.2 },
        { name: "Vehicle Heading Toward", value: headingToward, threshold: 0.5, passed: headingToward > 0.5 },
      ];

      const confidence =
        0.3 * overlap + 0.25 * proximity + 0.2 * sceneChangeScore + 0.15 * headingToward + 0.1 * 0.5;

      // Require overlap OR (proximity + heading toward + scene change)
      const hasOverlap = overlap > 0.5;
      const hasProximityEvidence = proximity > 0.5 && headingToward > 0.5 && sceneChangeScore > 0.15;

      if (confidence > 0.3 && (hasOverlap || hasProximityEvidence)) {
        const severity =
          confidence > 0.6 ? "critical" : confidence > 0.4 ? "major" : "minor";

        if (!bestResult || confidence > bestResult.confidence) {
          bestResult = {
            type: "pedestrian_collision",
            confidence,
            signals,
            severity,
          };
        }
      }
    }
  }

  return bestResult;
}

// Detect pedestrian fall
export function detectPedestrianFall(
  objects: TrackedObject[]
): AnomalyResult | null {
  const pedestrians = objects.filter((o) => o.class === "person");

  for (const person of pedestrians) {
    const lastDet = person.detections[person.detections.length - 1];
    const { width, height } = lastDet;

    // Check if person is horizontal (fallen)
    const aspectRatio = width / Math.max(height, 1);
    const isHorizontal = aspectRatio > 1.5 ? 1 : aspectRatio > 1.2 ? 0.5 : 0;

    // Check if person is low on screen (on ground)
    const yPos = lastDet.centerY / 480; // Normalize by typical frame height
    const isLow = yPos > 0.7 ? 1 : yPos > 0.5 ? 0.5 : 0;

    // Check if velocity dropped (stopped moving)
    const speed = Math.sqrt(
      person.velocity.vx ** 2 + person.velocity.vy ** 2
    );
    const isStationary = speed < 2 ? 1 : speed < 5 ? 0.5 : 0;

    // Require sustained detection (at least 3 frames tracked)
    const sustainedFrames = person.detections.length;
    const isSustained = sustainedFrames >= 3 ? 1 : sustainedFrames >= 2 ? 0.5 : 0;

    const signals: AnomalySignal[] = [
      { name: "Aspect Ratio", value: isHorizontal, threshold: 0.5, passed: isHorizontal > 0.5 },
      { name: "Position Drop", value: isLow, threshold: 0.5, passed: isLow > 0.5 },
      { name: "Velocity Drop", value: isStationary, threshold: 0.5, passed: isStationary > 0.5 },
      { name: "Sustained", value: isSustained, threshold: 0.5, passed: isSustained > 0.5 },
    ];

    const confidence =
      0.3 * isHorizontal + 0.25 * isLow + 0.2 * isStationary + 0.15 * isSustained + 0.1 * 0.5;

    if (confidence > 0.35 && signals.filter((s) => s.passed).length >= 3) {
      return {
        type: "pedestrian_fall",
        confidence,
        signals,
        severity: confidence > 0.6 ? "major" : "minor",
      };
    }
  }

  return null;
}

// Detect crowd anomaly — suppressed in marketplace (crowds are normal there)
export function detectCrowdAnomaly(
  objects: TrackedObject[],
  sceneContext: SceneContext = "isolated_road"
): AnomalyResult | null {
  // In marketplace, high pedestrian density is expected — suppress crowd alerts
  if (sceneContext === "marketplace") return null;

  const pedestrians = objects.filter((o) => o.class === "person");

  // In traffic mode, require more pedestrians to signal anomaly
  const minCount = sceneContext === "traffic" ? 10 : 5;
  if (pedestrians.length < minCount) return null;

  // Calculate density
  const positions = pedestrians.map((p) => p.currentPosition);
  const avgX = positions.reduce((s, p) => s + p.x, 0) / positions.length;
  const avgY = positions.reduce((s, p) => s + p.y, 0) / positions.length;
  const avgDist =
    positions.reduce((s, p) => s + distance(p, { x: avgX, y: avgY }), 0) /
    positions.length;

  const density = pedestrians.length / Math.max(avgDist, 1);
  const countScore = Math.min(pedestrians.length / 15, 1);
  const densityScore = Math.min(density / 0.15, 1);

  // Check for unusual motion patterns (not just count)
  // In traffic mode, crowd anomaly = stopped pedestrians blocking traffic
  let stoppedRatio = 0;
  if (sceneContext === "traffic") {
    const stopped = pedestrians.filter(p => {
      const speed = Math.sqrt(p.velocity.vx ** 2 + p.velocity.vy ** 2);
      return speed < 1;
    });
    stoppedRatio = stopped.length / pedestrians.length;
  }

  const signals: AnomalySignal[] = [
    { name: "Person Count", value: pedestrians.length, threshold: minCount + 3, passed: pedestrians.length > minCount + 3 },
    { name: "Density", value: densityScore, threshold: 0.6, passed: densityScore > 0.6 },
    ...(sceneContext === "traffic" ? [
      { name: "Stopped Ratio", value: stoppedRatio, threshold: 0.7, passed: stoppedRatio > 0.7 },
    ] : []),
  ];

  const passedCount = signals.filter((s) => s.passed).length;
  const requiredPasses = sceneContext === "traffic" ? 2 : 2;

  const confidence = 0.35 * countScore + 0.35 * densityScore + 0.15 * 0.5 + 0.15 * 0.5;

  if (confidence > 0.4 && passedCount >= requiredPasses) {
    return {
      type: "crowd_anomaly",
      confidence,
      signals,
      severity: confidence > 0.6 ? "major" : "minor",
    };
  }

  return null;
}

// Detect speeding vehicle
export function detectSpeeding(
  objects: TrackedObject[],
  speedLimit: number = 60
): AnomalyResult | null {
  const vehicles = objects.filter(
    (o) =>
      (o.class === "car" || o.class === "truck" || o.class === "bus") &&
      o.speed > 0
  );

  for (const vehicle of vehicles) {
    if (vehicle.speed > speedLimit) {
      const overBy = (vehicle.speed - speedLimit) / speedLimit;
      const confidence = Math.min(overBy, 1);

      return {
        type: "speeding",
        confidence,
        signals: [
          { name: "Speed", value: vehicle.speed, threshold: speedLimit, passed: true },
          { name: "Over Limit", value: overBy, threshold: 0.2, passed: overBy > 0.2 },
        ],
        severity: confidence > 0.5 ? "major" : "minor",
      };
    }
  }

  return null;
}

// Main anomaly detection function
export function detectAnomalies(
  objects: TrackedObject[],
  sceneChangeScore: number,
  sceneContext?: SceneContext
): AnomalyResult[] {
  const ctx = sceneContext || estimateSceneContext(objects);
  const results: AnomalyResult[] = [];

  const collision = detectVehicleCollision(objects, sceneChangeScore, ctx);
  if (collision) results.push(collision);

  const pedCollision = detectPedestrianCollision(objects, sceneChangeScore, ctx);
  if (pedCollision) results.push(pedCollision);

  const fall = detectPedestrianFall(objects);
  if (fall) results.push(fall);

  const crowd = detectCrowdAnomaly(objects, ctx);
  if (crowd) results.push(crowd);

  const speeding = detectSpeeding(objects);
  if (speeding) results.push(speeding);

  // Sort by confidence
  results.sort((a, b) => b.confidence - a.confidence);

  return results;
}

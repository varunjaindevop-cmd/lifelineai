import { Detection, TrackedObject, AnomalyResult, AnomalySignal } from "./types";

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

// Detect vehicle-vehicle collision
export function detectVehicleCollision(
  objects: TrackedObject[],
  sceneChangeScore: number
): AnomalyResult | null {
  const vehicles = objects.filter(
    (o) => o.class === "car" || o.class === "truck" || o.class === "bus"
  );

  let bestResult: AnomalyResult | null = null;

  for (let i = 0; i < vehicles.length; i++) {
    for (let j = i + 1; j < vehicles.length; j++) {
      const v1 = vehicles[i];
      const v2 = vehicles[j];
      const lastDet1 = v1.detections[v1.detections.length - 1];
      const lastDet2 = v2.detections[v2.detections.length - 1];

      const iou = calculateIoU(lastDet1.bbox, lastDet2.bbox);
      const sceneSpike = sceneChangeScore > 0.3 ? 1 : sceneChangeScore / 0.3;

      // Check if velocities are converging
      const v1Speed = Math.sqrt(v1.velocity.vx ** 2 + v1.velocity.vy ** 2);
      const v2Speed = Math.sqrt(v2.velocity.vx ** 2 + v2.velocity.vy ** 2);
      const converging = v1Speed > 0 && v2Speed > 0 ? 0.5 : 0;

      const signals: AnomalySignal[] = [
        { name: "IoU Overlap", value: iou, threshold: 0.1, passed: iou > 0.1 },
        { name: "Scene Spike", value: sceneChangeScore, threshold: 0.3, passed: sceneChangeScore > 0.3 },
        { name: "Velocity Evidence", value: converging, threshold: 0.3, passed: converging > 0.3 },
      ];

      const confidence =
        0.4 * Math.min(iou * 5, 1) +
        0.3 * sceneSpike +
        0.2 * converging +
        0.1 * 0.5;

      if (confidence > 0.3 && signals.filter((s) => s.passed).length >= 2) {
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
  sceneChangeScore: number
): AnomalyResult | null {
  const vehicles = objects.filter(
    (o) => o.class === "car" || o.class === "truck" || o.class === "bus"
  );
  const pedestrians = objects.filter((o) => o.class === "person");

  let bestResult: AnomalyResult | null = null;

  for (const vehicle of vehicles) {
    for (const pedestrian of pedestrians) {
      const lastV = vehicle.detections[vehicle.detections.length - 1];
      const lastP = pedestrian.detections[pedestrian.detections.length - 1];

      const iou = calculateIoU(lastV.bbox, lastP.bbox);
      const overlap = iou > 0.05 ? 1 : 0;

      const signals: AnomalySignal[] = [
        { name: "Overlap", value: overlap, threshold: 0.5, passed: overlap > 0.5 },
        { name: "Scene Spike", value: sceneChangeScore, threshold: 0.2, passed: sceneChangeScore > 0.2 },
      ];

      const confidence =
        0.35 * overlap + 0.25 * sceneChangeScore + 0.2 * 0.5 + 0.1 * 0.5 + 0.1 * 0.5;

      if (confidence > 0.25 && signals.filter((s) => s.passed).length >= 1) {
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

    const signals: AnomalySignal[] = [
      { name: "Aspect Ratio", value: isHorizontal, threshold: 0.5, passed: isHorizontal > 0.5 },
      { name: "Position Drop", value: isLow, threshold: 0.5, passed: isLow > 0.5 },
      { name: "Velocity Drop", value: isStationary, threshold: 0.5, passed: isStationary > 0.5 },
    ];

    const confidence =
      0.3 * isHorizontal + 0.25 * isLow + 0.2 * isStationary + 0.15 * 0.5 + 0.1 * 0.5;

    if (confidence > 0.3 && signals.filter((s) => s.passed).length >= 2) {
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

// Detect crowd anomaly
export function detectCrowdAnomaly(
  objects: TrackedObject[]
): AnomalyResult | null {
  const pedestrians = objects.filter((o) => o.class === "person");

  if (pedestrians.length < 5) return null;

  // Calculate density
  const positions = pedestrians.map((p) => p.currentPosition);
  const avgX = positions.reduce((s, p) => s + p.x, 0) / positions.length;
  const avgY = positions.reduce((s, p) => s + p.y, 0) / positions.length;
  const avgDist =
    positions.reduce((s, p) => s + distance(p, { x: avgX, y: avgY }), 0) /
    positions.length;

  const density = pedestrians.length / Math.max(avgDist, 1);
  const countScore = Math.min(pedestrians.length / 10, 1);
  const densityScore = Math.min(density / 0.1, 1);

  const signals: AnomalySignal[] = [
    { name: "Person Count", value: pedestrians.length, threshold: 8, passed: pedestrians.length > 8 },
    { name: "Density", value: densityScore, threshold: 0.5, passed: densityScore > 0.5 },
  ];

  const confidence = 0.3 * countScore + 0.3 * densityScore + 0.2 * 0.5 + 0.2 * 0.5;

  if (confidence > 0.3) {
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
  sceneChangeScore: number
): AnomalyResult[] {
  const results: AnomalyResult[] = [];

  const collision = detectVehicleCollision(objects, sceneChangeScore);
  if (collision) results.push(collision);

  const pedCollision = detectPedestrianCollision(objects, sceneChangeScore);
  if (pedCollision) results.push(pedCollision);

  const fall = detectPedestrianFall(objects);
  if (fall) results.push(fall);

  const crowd = detectCrowdAnomaly(objects);
  if (crowd) results.push(crowd);

  const speeding = detectSpeeding(objects);
  if (speeding) results.push(speeding);

  // Sort by confidence
  results.sort((a, b) => b.confidence - a.confidence);

  return results;
}

// Trajectory Prediction Engine
// Predicts where objects WILL BE and detects path intersections

import { TrackedEntity } from "../detection/kalman-tracker";
import { EnvMode } from "../detection/ttc-engine";

export interface TrajectoryPoint {
  x: number;
  y: number;
  time: number;
}

export interface PathIntersection {
  entityA: number;
  entityB: number;
  intersectFrame: number;
  minDistance: number;
  confidence: number;
  willCollide: boolean;
}

const PREDICTION_HORIZON = 20;

// Mode-specific collision distance thresholds
const COLLISION_DISTANCE: Record<EnvMode, number> = {
  isolated: 25,
  traffic: 35,
  marketplace: 20,
};

export function predictTrajectory(
  entity: TrackedEntity,
  frames: number = PREDICTION_HORIZON
): TrajectoryPoint[] {
  const trajectory: TrajectoryPoint[] = [];
  const k = entity.kalman.getState();

  for (let t = 1; t <= frames; t++) {
    const x = k.x + k.vx * t + 0.5 * k.ax * t * t;
    const y = k.y + k.vy * t + 0.5 * k.ay * t * t;
    trajectory.push({ x, y, time: t });
  }

  return trajectory;
}

export function findPathIntersection(
  a: TrackedEntity,
  b: TrackedEntity,
  envMode: EnvMode = "isolated"
): PathIntersection | null {
  const trajA = predictTrajectory(a);
  const trajB = predictTrajectory(b);

  const collisionDist = COLLISION_DISTANCE[envMode];
  let minDist = Infinity;
  let closestFrame = 0;

  for (let t = 0; t < Math.min(trajA.length, trajB.length); t++) {
    const dx = trajA[t].x - trajB[t].x;
    const dy = trajA[t].y - trajB[t].y;
    const d = Math.sqrt(dx * dx + dy * dy);

    if (d < minDist) {
      minDist = d;
      closestFrame = t + 1;
    }
  }

  const combinedSize = (Math.sqrt(a.w * a.h) + Math.sqrt(b.w * b.h)) / 2;
  const willCollide = minDist < combinedSize * 0.8;

  const proximityScore = minDist < combinedSize * 0.5 ? 1.0 :
    minDist < combinedSize * 1.0 ? 0.7 :
    minDist < combinedSize * 2.0 ? 0.3 : 0;

  if (proximityScore < 0.1) return null;

  return {
    entityA: a.id,
    entityB: b.id,
    intersectFrame: closestFrame,
    minDistance: minDist,
    confidence: proximityScore,
    willCollide,
  };
}

export function analyzeTrajectories(
  entities: TrackedEntity[],
  envMode: EnvMode = "isolated"
): PathIntersection[] {
  const intersections: PathIntersection[] = [];
  const valid = entities.filter(e => e.age >= 3);

  for (let i = 0; i < valid.length; i++) {
    for (let j = i + 1; j < valid.length; j++) {
      const a = valid[i];
      const b = valid[j];
      if (a.class === "person" && b.class === "person") continue;

      const intersection = findPathIntersection(a, b, envMode);
      if (intersection) {
        intersections.push(intersection);
      }
    }
  }

  intersections.sort((a, b) => b.confidence - a.confidence);
  return intersections;
}

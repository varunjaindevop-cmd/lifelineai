// Trajectory Prediction Engine
// Predicts where objects WILL BE and detects path intersections
// This is how real accident detection should work: predict, don't just react

import { TrackedEntity } from "../detection/kalman-tracker";

export interface TrajectoryPoint {
  x: number;
  y: number;
  time: number; // frames ahead
}

export interface PathIntersection {
  entityA: number;
  entityB: number;
  intersectFrame: number;      // how many frames until intersection
  minDistance: number;          // closest approach distance
  confidence: number;          // 0-1, how likely intersection is
  willCollide: boolean;        // intersection within collision threshold
}

const COLLISION_DISTANCE_PX = 30; // pixels - objects this close at intersection = collision
const PREDICTION_HORIZON = 20;     // frames to predict ahead

/**
 * Predict future positions of an entity using Kalman filter prediction
 */
export function predictTrajectory(
  entity: TrackedEntity,
  frames: number = PREDICTION_HORIZON
): TrajectoryPoint[] {
  const trajectory: TrajectoryPoint[] = [];
  const k = entity.kalman.getState();

  for (let t = 1; t <= frames; t++) {
    // Use kinematic equations: pos = pos0 + vel*t + 0.5*acc*t^2
    const x = k.x + k.vx * t + 0.5 * k.ax * t * t;
    const y = k.y + k.vy * t + 0.5 * k.ay * t * t;
    trajectory.push({ x, y, time: t });
  }

  return trajectory;
}

/**
 * Find where two trajectories will intersect
 */
export function findPathIntersection(
  a: TrackedEntity,
  b: TrackedEntity
): PathIntersection | null {
  const trajA = predictTrajectory(a);
  const trajB = predictTrajectory(b);

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

  // Intersection if predicted distance gets very small
  const willCollide = minDist < combinedSize * 0.8;

  // Confidence based on how close the intersection is
  const proximityScore = minDist < combinedSize * 0.5 ? 1.0 :
    minDist < combinedSize * 1.0 ? 0.7 :
    minDist < combinedSize * 2.0 ? 0.3 : 0;

  // Only report if there's a reasonable chance of intersection
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

/**
 * Analyze all entity pairs for trajectory intersections
 */
export function analyzeTrajectories(entities: TrackedEntity[]): PathIntersection[] {
  const intersections: PathIntersection[] = [];

  const valid = entities.filter(e => e.age >= 3);

  for (let i = 0; i < valid.length; i++) {
    for (let j = i + 1; j < valid.length; j++) {
      const a = valid[i];
      const b = valid[j];

      // Skip person-person
      if (a.class === "person" && b.class === "person") continue;

      const intersection = findPathIntersection(a, b);
      if (intersection) {
        intersections.push(intersection);
      }
    }
  }

  // Sort by confidence (most likely collisions first)
  intersections.sort((a, b) => b.confidence - a.confidence);

  return intersections;
}

// Time-to-Collision (TTC) Engine
// Predicts accidents BEFORE they happen using trajectory extrapolation

import { TrackedEntity } from "./kalman-tracker";

export interface TTCPair {
  a: TrackedEntity;
  b: TrackedEntity;
  ttc: number;           // seconds to collision (NaN = not converging)
  distance: number;      // current distance in pixels
  closingSpeed: number;  // speed of approach (positive = approaching)
  predictedOverlap: boolean; // will bounding boxes overlap?
  severity: "none" | "warning" | "critical" | "impact";
}

export interface AccidentEvidence {
  type: "ttc_critical" | "post_impact" | "trajectory_anomaly" | "sudden_stop" | "shape_change";
  confidence: number;
  objects: number[];
  details: string;
}

// Calculate Time-to-Collision between two tracked entities
export function computeTTC(a: TrackedEntity, b: TrackedEntity): TTCPair {
  const ax = a.kalman.getState().x;
  const ay = a.kalman.getState().y;
  const bx = b.kalman.getState().x;
  const by = b.kalman.getState().y;

  // Relative position
  const rx = bx - ax;
  const ry = by - ay;
  const dist = Math.sqrt(rx * rx + ry * ry);

  // Relative velocity (closing speed)
  const avx = a.kalman.getState().vx;
  const avy = a.kalman.getState().vy;
  const bvx = b.kalman.getState().vx;
  const bvy = b.kalman.getState().vy;
  const rvx = bvx - avx;
  const rvy = bvy - avy;

  // Closing speed (positive = approaching)
  const closingSpeed = -(rx * rvx + ry * rvy) / Math.max(dist, 1);

  // Combined "radius" (approximate from bounding boxes)
  const combinedR = (Math.sqrt(a.w * a.h) + Math.sqrt(b.w * b.h)) / 2;

  // TTC calculation
  let ttc = NaN;
  if (closingSpeed > 0.5) { // approaching at > 0.5 px/frame
    ttc = Math.max(0, (dist - combinedR) / closingSpeed);
  }

  // Predict overlap at TTC
  const predictedOverlap = !isNaN(ttc) && dist < combinedR * 2;

  // Determine severity
  let severity: TTCPair["severity"] = "none";
  if (!isNaN(ttc)) {
    if (ttc < 0.3) severity = "impact";
    else if (ttc < 1.0) severity = "critical";
    else if (ttc < 2.5) severity = "warning";
  }

  return { a, b, ttc, distance: dist, closingSpeed, predictedOverlap, severity };
}

// Find all TTC pairs for a set of tracked entities
export function findAllTTCPairs(entities: TrackedEntity[]): TTCPair[] {
  const pairs: TTCPair[] = [];
  const candidates = entities.filter(e => e.age >= 3); // need tracking history

  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i], b = candidates[j];
      // Skip person-person
      if (a.class === "person" && b.class === "person") continue;
      
      const pair = computeTTC(a, b);
      if (!isNaN(pair.ttc) && pair.ttc < 5) { // only interested in near-term collisions
        pairs.push(pair);
      }
    }
  }

  pairs.sort((a, b) => a.ttc - b.ttc);
  return pairs;
}

// Detect trajectory anomaly (object deviating from expected path)
export function detectTrajectoryAnomaly(entity: TrackedEntity): { anomalous: boolean; deviation: number } {
  if (entity.positions.length < 5) return { anomalous: false, deviation: 0 };

  const positions = entity.positions.slice(-5);
  
  // Fit linear trajectory to first 3 points
  const p0 = positions[0], p1 = positions[1], p2 = positions[2];
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  
  // Predict positions 3 and 4 based on linear trend
  const pred3 = { x: p0.x + dx * 3, y: p0.y + dy * 3 };
  const pred4 = { x: p0.x + dx * 4, y: p0.y + dy * 4 };
  
  const actual3 = positions[3];
  const actual4 = positions[4];
  
  const dev3 = Math.sqrt((pred3.x - actual3.x) ** 2 + (pred3.y - actual3.y) ** 2);
  const dev4 = Math.sqrt((pred4.x - actual4.x) ** 2 + (pred4.y - actual4.y) ** 2);
  const avgDev = (dev3 + dev4) / 2;
  
  // Speed-based threshold
  const speed = entity.speed;
  const threshold = Math.max(3, speed * 0.5); // at least 3px deviation or 50% of speed
  
  return { anomalous: avgDev > threshold, deviation: avgDev };
}

// Detect post-impact state (both objects stopped after being close)
export function detectPostImpact(entities: TrackedEntity[], ttcPairs: TTCPair[]): AccidentEvidence | null {
  // Look for pairs that were recently close (TTC was low) and are now both stopped
  for (const pair of ttcPairs) {
    if (pair.distance > 200) continue; // too far apart
    
    const speedA = pair.a.speed;
    const speedB = pair.b.speed;
    
    // Both must be nearly stopped
    if (speedA < 0.5 && speedB < 0.5) {
      // Check if they were recently moving
      const wasMovingA = pair.a.speedHistory.some(s => s > 1.5);
      const wasMovingB = pair.b.speedHistory.some(s => s > 1.5);
      
      if (wasMovingA && wasMovingB) {
        return {
          type: "post_impact",
          confidence: 0.85,
          objects: [pair.a.id, pair.b.id],
          details: `Both objects stopped after approach (dist: ${pair.distance.toFixed(0)}px)`,
        };
      }
    }
  }
  return null;
}

// Detect shape change (bike falling, vehicle rollover)
export function detectShapeChange(entity: TrackedEntity): AccidentEvidence | null {
  if (entity.positions.length < 5) return null;
  
  // Check if bounding box aspect ratio changed dramatically
  const currentAR = entity.w / Math.max(entity.h, 1);
  
  // Store aspect ratio history in a simple way
  // We track via the w/h ratio change
  const speed = entity.speed;
  const headingChange = entity.headingHistory.length >= 3 
    ? Math.abs(entity.headingHistory[entity.headingHistory.length - 1] - entity.headingHistory[entity.headingHistory.length - 3])
    : 0;
  
  // Large heading change at low speed = possible rollover/fall
  if (headingChange > Math.PI * 0.5 && speed < 1 && entity.age > 5) {
    return {
      type: "shape_change",
      confidence: 0.7,
      objects: [entity.id],
      details: `Sudden heading change (${(headingChange * 180 / Math.PI).toFixed(0)}°) at low speed`,
    };
  }
  
  return null;
}

// Main accident detection — combines all signals
export function detectAccidents(
  entities: TrackedEntity[],
  ttcPairs: TTCPair[],
  sceneChangeScore: number
): AccidentEvidence[] {
  const evidence: AccidentEvidence[] = [];
  
  // 1. TTC-based detection (primary)
  for (const pair of ttcPairs) {
    if (pair.severity === "impact") {
      evidence.push({
        type: "ttc_critical",
        confidence: Math.min(0.95, 0.6 + (1 / Math.max(pair.ttc, 0.1)) * 0.1),
        objects: [pair.a.id, pair.b.id],
        details: `TTC: ${pair.ttc.toFixed(2)}s, closing: ${pair.closingSpeed.toFixed(1)}px/f, dist: ${pair.distance.toFixed(0)}px`,
      });
    } else if (pair.severity === "critical") {
      evidence.push({
        type: "ttc_critical",
        confidence: Math.min(0.85, 0.4 + (1 / Math.max(pair.ttc, 0.1)) * 0.05),
        objects: [pair.a.id, pair.b.id],
        details: `TTC: ${pair.ttc.toFixed(2)}s (critical range)`,
      });
    }
  }
  
  // 2. Post-impact detection
  const postImpact = detectPostImpact(entities, ttcPairs);
  if (postImpact) evidence.push(postImpact);
  
  // 3. Trajectory anomalies
  for (const entity of entities) {
    const anomaly = detectTrajectoryAnomaly(entity);
    if (anomaly.anomalous) {
      evidence.push({
        type: "trajectory_anomaly",
        confidence: Math.min(0.8, 0.3 + anomaly.deviation * 0.02),
        objects: [entity.id],
        details: `Trajectory deviation: ${anomaly.deviation.toFixed(1)}px`,
      });
    }
    
    // 4. Shape change (bike fall)
    const shapeChange = detectShapeChange(entity);
    if (shapeChange) evidence.push(shapeChange);
  }
  
  // 5. Scene-level: sudden stop detection
  for (const entity of entities) {
    if (entity.speedHistory.length >= 4) {
      const recentAvg = (entity.speedHistory[entity.speedHistory.length - 1] + entity.speedHistory[entity.speedHistory.length - 2]) / 2;
      const prevAvg = (entity.speedHistory[0] + entity.speedHistory[1]) / 2;
      if (prevAvg > 2 && recentAvg < 0.3) {
        evidence.push({
          type: "sudden_stop",
          confidence: 0.6,
          objects: [entity.id],
          details: `Speed dropped from ${prevAvg.toFixed(1)} to ${recentAvg.toFixed(1)} px/frame`,
        });
      }
    }
  }
  
  // Sort by confidence
  evidence.sort((a, b) => b.confidence - a.confidence);
  
  // Remove duplicate object references
  const seen = new Set<string>();
  return evidence.filter(e => {
    const key = e.objects.sort().join(",");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

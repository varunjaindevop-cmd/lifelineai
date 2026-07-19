// Kalman Filter for smooth object tracking and velocity estimation
// Used for accurate speed calculation and trajectory prediction

export interface KalmanState {
  x: number; y: number;        // position
  vx: number; vy: number;      // velocity
  ax: number; ay: number;      // acceleration
  P: number[][];               // covariance matrix (6x6)
}

export class KalmanTracker {
  private state: KalmanState;
  private initialized = false;
  private Q: number;  // process noise
  private R: number;  // measurement noise

  constructor(initialX: number, initialY: number, processNoise = 0.03, measurementNoise = 0.1) {
    this.Q = processNoise;
    this.R = measurementNoise;
    this.state = {
      x: initialX, y: initialY,
      vx: 0, vy: 0,
      ax: 0, ay: 0,
      P: this.eye(6).map(row => row.map(v => v * 100)), // large initial uncertainty
    };
  }

  // Update state with new measurement
  update(measurementX: number, measurementY: number, dt: number = 1): KalmanState {
    if (!this.initialized) {
      this.state.x = measurementX;
      this.state.y = measurementY;
      this.initialized = true;
      return this.state;
    }

    const { x, y, vx, vy, ax, ay } = this.state;

    // Predict
    const predX = x + vx * dt + 0.5 * ax * dt * dt;
    const predY = y + vy * dt + 0.5 * ay * dt * dt;
    const predVx = vx + ax * dt;
    const predVy = vy + ay * dt;

    // Innovation
    const innovX = measurementX - predX;
    const innovY = measurementY - predY;

    // Simplified Kalman gain (scalar approximation for speed)
    const S = this.state.P[0][0] + this.R;
    const K = Math.max(0.1, Math.min(0.9, this.state.P[0][0] / S));

    // Update position
    this.state.x = predX + K * innovX;
    this.state.y = predY + K * innovY;

    // Update velocity from position change
    this.state.vx = predVx + K * (innovX / dt) * 0.5;
    this.state.vy = predVy + K * (innovY / dt) * 0.5;

    // Update acceleration
    this.state.ax = (this.state.vx - vx) / dt * 0.3;
    this.state.ay = (this.state.vy - vy) / dt * 0.3;

    // Update covariance (simplified)
    const pFactor = 1 - K;
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 6; j++) {
        this.state.P[i][j] *= pFactor;
        if (i === j) this.state.P[i][j] += this.Q;
      }
    }

    return this.state;
  }

  // Predict future position
  predict(dt: number): { x: number; y: number } {
    return {
      x: this.state.x + this.state.vx * dt + 0.5 * this.state.ax * dt * dt,
      y: this.state.y + this.state.vy * dt + 0.5 * this.state.ay * dt * dt,
    };
  }

  getSpeed(): number {
    return Math.sqrt(this.state.vx ** 2 + this.state.vy ** 2);
  }

  getHeading(): number {
    return Math.atan2(this.state.vy, this.state.vx);
  }

  getAcceleration(): number {
    return Math.sqrt(this.state.ax ** 2 + this.state.ay ** 2);
  }

  getState(): KalmanState {
    return { ...this.state };
  }

  private eye(n: number): number[][] {
    const m: number[][] = [];
    for (let i = 0; i < n; i++) {
      m[i] = [];
      for (let j = 0; j < n; j++) m[i][j] = i === j ? 1 : 0;
    }
    return m;
  }
}

// Multi-object tracker using Kalman filters
export interface TrackedEntity {
  id: number;
  class: string;
  confidence: number;
  kalman: KalmanTracker;
  lastSeen: number;
  age: number;           // frames tracked
  positions: { x: number; y: number }[];
  speedHistory: number[];
  headingHistory: number[];
  // Derived
  speed: number;         // Kalman-smoothed speed (pixels/frame)
  heading: number;
  acceleration: number;
  w: number; h: number;  // latest bounding box
}

export class MultiObjectTracker {
  private entities: Map<number, TrackedEntity> = new Map();
  private nextId = 1;
  private maxAge = 10; // frames before removing

  update(detections: { class: string; cx: number; cy: number; w: number; h: number; confidence: number }[], frame: number): TrackedEntity[] {
    const matched = new Set<number>();

    // Match detections to existing entities by class + proximity
    for (const entity of Array.from(this.entities.values())) {
      let bestDet = -1;
      let bestDist = 60; // max matching distance

      for (let i = 0; i < detections.length; i++) {
        if (matched.has(i)) continue;
        if (detections[i].class !== entity.class) continue;
        const lastPos = entity.positions[entity.positions.length - 1];
        const dist = Math.sqrt(
          (detections[i].cx - lastPos.x) ** 2 +
          (detections[i].cy - lastPos.y) ** 2
        );
        if (dist < bestDist) {
          bestDist = dist;
          bestDet = i;
        }
      }

      if (bestDet >= 0) {
        const det = detections[bestDet];
        entity.kalman.update(det.cx, det.cy);
        entity.w = det.w;
        entity.h = det.h;
        entity.confidence = det.confidence;
        entity.lastSeen = frame;
        entity.age++;
        
        const pos = { x: entity.kalman.getState().x, y: entity.kalman.getState().y };
        entity.positions.push(pos);
        if (entity.positions.length > 20) entity.positions.shift();
        
        entity.speed = entity.kalman.getSpeed();
        entity.heading = entity.kalman.getHeading();
        entity.acceleration = entity.kalman.getAcceleration();
        
        entity.speedHistory.push(entity.speed);
        if (entity.speedHistory.length > 10) entity.speedHistory.shift();
        entity.headingHistory.push(entity.heading);
        if (entity.headingHistory.length > 10) entity.headingHistory.shift();
        
        matched.add(bestDet);
      }
    }

    // Create new entities for unmatched detections
    for (let i = 0; i < detections.length; i++) {
      if (matched.has(i)) continue;
      const det = detections[i];
      const kalman = new KalmanTracker(det.cx, det.cy);
      const id = this.nextId++;
      const pos = { x: det.cx, y: det.cy };
      this.entities.set(id, {
        id, class: det.class, confidence: det.confidence,
        kalman, lastSeen: frame, age: 1,
        positions: [pos], speedHistory: [0], headingHistory: [0],
        speed: 0, heading: 0, acceleration: 0,
        w: det.w, h: det.h,
      });
    }

    // Remove stale entities
    for (const [id, entity] of Array.from(this.entities.entries())) {
      if (frame - entity.lastSeen > this.maxAge) {
        this.entities.delete(id);
      }
    }

    return Array.from(this.entities.values());
  }

  reset() {
    this.entities.clear();
    this.nextId = 1;
  }
}

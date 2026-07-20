// Kalman Filter for smooth object tracking and velocity estimation
// Used for accurate speed calculation and trajectory prediction

export interface KalmanState {
  x: number; y: number;
  vx: number; vy: number;
  ax: number; ay: number;
  P: number[][];
}

export class KalmanTracker {
  private state: KalmanState;
  private initialized = false;
  private Q: number;
  private R: number;

  constructor(initialX: number, initialY: number, processNoise = 0.08, measurementNoise = 0.05) {
    this.Q = processNoise;
    this.R = measurementNoise;
    this.state = {
      x: initialX, y: initialY,
      vx: 0, vy: 0, ax: 0, ay: 0,
      P: this.eye(6).map(row => row.map(v => v * 100)),
    };
  }

  update(mx: number, my: number, dt: number = 1): KalmanState {
    if (!this.initialized) {
      this.state.x = mx; this.state.y = my;
      this.initialized = true;
      return this.state;
    }
    const { x, y, vx, vy, ax, ay } = this.state;
    const predX = x + vx * dt + 0.5 * ax * dt * dt;
    const predY = y + vy * dt + 0.5 * ay * dt * dt;
    const predVx = vx + ax * dt;
    const predVy = vy + ay * dt;
    const innovX = mx - predX;
    const innovY = my - predY;
    const S = this.state.P[0][0] + this.R;
    const K = Math.max(0.1, Math.min(0.9, this.state.P[0][0] / S));
    this.state.x = predX + K * innovX;
    this.state.y = predY + K * innovY;
    this.state.vx = predVx + K * (innovX / dt) * 0.5;
    this.state.vy = predVy + K * (innovY / dt) * 0.5;
    this.state.ax = (this.state.vx - vx) / dt * 0.3;
    this.state.ay = (this.state.vy - vy) / dt * 0.3;
    const pFactor = 1 - K;
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 6; j++) {
        this.state.P[i][j] *= pFactor;
        if (i === j) this.state.P[i][j] += this.Q;
      }
    }
    return this.state;
  }

  getSpeed(): number { return Math.sqrt(this.state.vx ** 2 + this.state.vy ** 2); }
  getHeading(): number { return Math.atan2(this.state.vy, this.state.vx); }
  getAcceleration(): number { return Math.sqrt(this.state.ax ** 2 + this.state.ay ** 2); }
  getState(): KalmanState { return { ...this.state }; }

  predict(dt: number = 1): { x: number; y: number } {
    return {
      x: this.state.x + this.state.vx * dt + 0.5 * this.state.ax * dt * dt,
      y: this.state.y + this.state.vy * dt + 0.5 * this.state.ay * dt * dt,
    };
  }

  private eye(n: number): number[][] {
    const m: number[][] = [];
    for (let i = 0; i < n; i++) { m[i] = []; for (let j = 0; j < n; j++) m[i][j] = i === j ? 1 : 0; }
    return m;
  }
}

export interface TrackedEntity {
  id: number;
  class: string;
  confidence: number;
  kalman: KalmanTracker;
  lastSeen: number;
  age: number;
  positions: { x: number; y: number }[];
  speedHistory: number[];
  headingHistory: number[];
  aspectHistory: number[];
  speed: number;
  heading: number;
  acceleration: number;
  w: number; h: number;
  bbox: [number, number, number, number];
  confirmedFrames: number;
  isStale: boolean;
  lastMatchedFrame: number;
  rawX: number;           // raw detection X (no Kalman lag)
  rawY: number;           // raw detection Y (no Kalman lag)
  rawW: number;           // raw detection width
  rawH: number;           // raw detection height
}

// Two-wheeled vehicles can be misclassified between motorcycle/bicycle by COCO-SSD
const BIKE_FAMILY = new Set(["motorcycle", "bicycle"]);
function sameVehicleClass(a: string, b: string): boolean {
  if (a === b) return true;
  if (BIKE_FAMILY.has(a) && BIKE_FAMILY.has(b)) return true;
  return false;
}

export class MultiObjectTracker {
  private entities: Map<number, TrackedEntity> = new Map();
  private nextId = 1;
  private maxAge = 4; // 4 frames = 400ms at 100ms/frame — fast cleanup

  update(detections: { class: string; cx: number; cy: number; w: number; h: number; confidence: number }[], frame: number): TrackedEntity[] {
    const matched = new Set<number>();

    // First pass: mark ALL existing entities as stale + predict their next position
    for (const entity of this.entities.values()) {
      entity.isStale = true;
      // Predict forward so the position stays current between detections
      const predicted = entity.kalman.predict(1);
      entity.rawX = predicted.x;
      entity.rawY = predicted.y;
    }

    // Match detections to existing entities by class family + proximity
    for (const entity of Array.from(this.entities.values())) {
      let bestDet = -1;
      let bestDist = 80;

      for (let i = 0; i < detections.length; i++) {
        if (matched.has(i)) continue;
        if (!sameVehicleClass(detections[i].class, entity.class)) continue;
        const lastPos = entity.positions[entity.positions.length - 1];
        const d = Math.sqrt(
          (detections[i].cx - lastPos.x) ** 2 +
          (detections[i].cy - lastPos.y) ** 2
        );
        if (d < bestDist) {
          bestDist = d;
          bestDet = i;
        }
      }

      if (bestDet >= 0) {
        const det = detections[bestDet];
        entity.rawX = det.cx;
        entity.rawY = det.cy;
        entity.rawW = det.w;
        entity.rawH = det.h;
        entity.kalman.update(det.cx, det.cy);
        entity.w = det.w;
        entity.h = det.h;
        entity.confidence = det.confidence;
        entity.lastSeen = frame;
        entity.lastMatchedFrame = frame;
        entity.isStale = false; // freshly matched — NOT stale
        entity.age++;
        entity.confirmedFrames++;

        const kx = entity.kalman.getState().x;
        const ky = entity.kalman.getState().y;
        entity.bbox = [kx - det.w / 2, ky - det.h / 2, kx + det.w / 2, ky + det.h / 2];

        entity.positions.push({ x: det.cx, y: det.cy });
        if (entity.positions.length > 30) entity.positions.shift();

        entity.speed = entity.kalman.getSpeed();
        entity.heading = entity.kalman.getHeading();
        entity.acceleration = entity.kalman.getAcceleration();

        entity.speedHistory.push(entity.speed);
        if (entity.speedHistory.length > 15) entity.speedHistory.shift();
        entity.headingHistory.push(entity.heading);
        if (entity.headingHistory.length > 15) entity.headingHistory.shift();
        const ar = det.w / Math.max(det.h, 1);
        entity.aspectHistory.push(ar);
        if (entity.aspectHistory.length > 15) entity.aspectHistory.shift();

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
        kalman, lastSeen: frame, age: 1, confirmedFrames: 1,
        positions: [pos], speedHistory: [0], headingHistory: [0],
        aspectHistory: [det.w / Math.max(det.h, 1)],
        speed: 0, heading: 0, acceleration: 0,
        w: det.w, h: det.h,
        bbox: [det.cx - det.w / 2, det.cy - det.h / 2, det.cx + det.w / 2, det.cy + det.h / 2],
        isStale: false,
        lastMatchedFrame: frame,
        rawX: det.cx, rawY: det.cy, rawW: det.w, rawH: det.h,
      });
    }

    // Remove entities that haven't been matched for too long
    for (const [id, entity] of Array.from(this.entities.entries())) {
      if (frame - entity.lastMatchedFrame > this.maxAge) {
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

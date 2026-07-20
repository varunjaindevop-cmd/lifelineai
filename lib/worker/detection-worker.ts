// Detection Web Worker - Advanced multi-system detection
// Integrates: Kalman tracking + Velocity anomaly + Trajectory prediction + Energy analysis + Frame memory

import { MultiObjectTracker, TrackedEntity } from "../detection/kalman-tracker";
import { detectAccidents, AccidentEvidence } from "../detection/ttc-engine";
import { analyzeTrajectories, PathIntersection } from "../detection/trajectory-predictor";
import { analyzeEnergy, detectEnergyTransfer, EnergyAnalysis } from "../detection/energy-analyzer";
import { FrameMemory } from "../detection/frame-memory";
import { autoCalibrate } from "../detection/speed-estimator";
import type { EnvMode, WorkerOutput, SerializedEntity, SerializedEvidence } from "./message-types";

let tracker = new MultiObjectTracker();
let frameMemory = new FrameMemory();
let envMode: EnvMode = "isolated";
let pixelsPerMeter = 20;
let frameCount = 0;
let consecutiveAnomaly = 0;
let cooldown = 0;
let state = "monitoring";

const GRID_COLS = 10;
const GRID_ROWS = 8;
const prevGrid = new Float32Array(GRID_COLS * GRID_ROWS);
const accumGrid = new Float32Array(GRID_COLS * GRID_ROWS);

let offscreen: OffscreenCanvas | null = null;
let offCtx: OffscreenCanvasRenderingContext2D | null = null;

function serializeEntity(e: TrackedEntity): SerializedEntity {
  const k = e.kalman.getState();
  return {
    id: e.id, class: e.class, confidence: e.confidence,
    x: k.x, y: k.y, vx: k.vx, vy: k.vy, ax: k.ax, ay: k.ay,
    speed: e.speed, heading: e.heading, acceleration: e.acceleration,
    w: e.w, h: e.h, age: e.age,
    positions: [...e.positions], speedHistory: [...e.speedHistory],
    headingHistory: [...e.headingHistory], aspectHistory: [...e.aspectHistory],
  };
}

function serializeEvidence(ev: AccidentEvidence): SerializedEvidence {
  return { type: ev.type, confidence: ev.confidence, objects: [...ev.objects], details: ev.details };
}

function computeChangeGrid(bitmap: ImageBitmap): number[] {
  if (!offscreen || offscreen.width !== bitmap.width || offscreen.height !== bitmap.height) {
    offscreen = new OffscreenCanvas(bitmap.width, bitmap.height);
    offCtx = offscreen.getContext("2d", { willReadFrequently: true })!;
  }
  offCtx!.drawImage(bitmap, 0, 0);
  const data = offCtx!.getImageData(0, 0, bitmap.width, bitmap.height).data;
  const grid = new Float32Array(GRID_COLS * GRID_ROWS);
  const cw = Math.floor(bitmap.width / GRID_COLS);
  const ch = Math.floor(bitmap.height / GRID_ROWS);
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      let s = 0, n = 0;
      for (let dy = 0; dy < ch; dy += 4) for (let dx = 0; dx < cw; dx += 4) {
        const i = ((r * ch + dy) * bitmap.width + (c * cw + dx)) * 4;
        s += data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114; n++;
      }
      grid[r * GRID_COLS + c] = n > 0 ? s / n : 128;
    }
  }
  for (let i = 0; i < GRID_COLS * GRID_ROWS; i++) {
    const diff = prevGrid[i] ? Math.abs(grid[i] - prevGrid[i]) / 255 : 0;
    accumGrid[i] = accumGrid[i] * 0.92 + diff * 4;
    prevGrid[i] = grid[i];
  }
  return Array.from(accumGrid);
}

self.onmessage = (e: MessageEvent) => {
  const msg = e.data;

  switch (msg.type) {
    case "INIT": {
      envMode = msg.envMode || "isolated";
      pixelsPerMeter = autoCalibrate(640, 480, envMode);
      self.postMessage({ type: "READY" } satisfies WorkerOutput);
      break;
    }

    case "DETECTIONS": {
      const detections = msg.detections as { class: string; cx: number; cy: number; w: number; h: number; confidence: number }[];
      const frameNumber = msg.frame || 0;
      const bitmap = msg.bitmap as ImageBitmap | undefined;

      frameCount++;

      // 1. Kalman tracking
      const entities = tracker.update(detections, frameNumber);
      const validEntities = entities.filter(e => e.age >= 1);

      // 2. Store in frame memory for temporal analysis
      frameMemory.addFrame({
        frame: frameNumber,
        timestamp: Date.now(),
        entities: validEntities.map(e => ({
          id: e.id, class: e.class,
          x: e.kalman.getState().x, y: e.kalman.getState().y,
          speed: e.speed, heading: e.heading,
        })),
      });

      // 3. Change detection grid
      let changeGrid: number[] = Array.from(accumGrid);
      if (bitmap) {
        changeGrid = computeChangeGrid(bitmap);
        bitmap.close();
      }

      // 4. Run ALL detection systems
      if (cooldown > 0) cooldown--;

      // System 1: Core collision detection (velocity anomaly based)
      const collisionEvidence = detectAccidents(validEntities, [], envMode);

      // System 2: Trajectory prediction
      const intersections = analyzeTrajectories(validEntities);
      const criticalIntersections = intersections.filter(i => i.willCollide);

      // System 3: Energy analysis
      const energyData = analyzeEnergy(validEntities);
      const energyTransfers = detectEnergyTransfer(validEntities, energyData);

      // 5. Combine evidence from all systems
      let allEvidence: AccidentEvidence[] = [...collisionEvidence];

      // Add trajectory-based evidence
      for (const ix of criticalIntersections) {
        const existing = allEvidence.find(e =>
          e.objects.includes(ix.entityA) && e.objects.includes(ix.entityB)
        );
        if (!existing) {
          allEvidence.push({
            type: "collision",
            confidence: ix.confidence * 0.8,
            objects: [ix.entityA, ix.entityB],
            details: `Trajectory: intersect in ${ix.intersectFrame} frames, d=${ix.minDistance.toFixed(0)}px`,
          });
        }
      }

      // Add energy transfer evidence
      for (const et of energyTransfers) {
        const existing = allEvidence.find(e =>
          e.objects.includes(et.a) && e.objects.includes(et.b)
        );
        if (!existing) {
          allEvidence.push({
            type: "collision",
            confidence: et.severity * 0.9,
            objects: [et.a, et.b],
            details: `Energy transfer: severity=${et.severity.toFixed(2)}`,
          });
        }
      }

      // Sort by confidence
      allEvidence.sort((a, b) => b.confidence - a.confidence);

      // 6. State machine
      const hasCollision = allEvidence.length > 0;
      if (hasCollision) consecutiveAnomaly++;
      else consecutiveAnomaly = 0;

      let newState = state;
      if (hasCollision && consecutiveAnomaly >= 2) {
        newState = "alert";
      } else if (!hasCollision && consecutiveAnomaly === 0) {
        newState = "monitoring";
      }

      if (newState === "alert" && state !== "alert" && cooldown <= 0) {
        cooldown = 200;
        consecutiveAnomaly = 0;
      }
      state = newState;

      self.postMessage({
        type: "RESULTS",
        frame: frameNumber,
        entities: validEntities.map(serializeEntity),
        evidence: allEvidence.map(serializeEvidence),
        changeGrid,
        state,
        fps: 0,
        detectionCount: detections.length,
      } satisfies WorkerOutput);
      break;
    }

    case "SET_MODE": {
      envMode = msg.envMode;
      pixelsPerMeter = autoCalibrate(640, 480, envMode);
      break;
    }

    case "STOP": {
      tracker.reset();
      frameMemory.clear();
      accumGrid.fill(0);
      prevGrid.fill(0);
      frameCount = 0;
      consecutiveAnomaly = 0;
      cooldown = 0;
      state = "monitoring";
      break;
    }
  }
};

self.postMessage({ type: "READY" } satisfies WorkerOutput);

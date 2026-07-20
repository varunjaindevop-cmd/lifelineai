// Detection Web Worker - handles tracking, collision detection, and change detection
// TF.js COCO-SSD runs on main thread (needs DOM), results sent here for processing

import { MultiObjectTracker, TrackedEntity } from "../detection/kalman-tracker";
import { detectAccidents, AccidentEvidence } from "../detection/ttc-engine";
import { autoCalibrate } from "../detection/speed-estimator";
import type { EnvMode, WorkerOutput, SerializedEntity, SerializedEvidence } from "./message-types";

let tracker = new MultiObjectTracker();
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

// Offscreen canvas for change detection
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
        s += data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
        n++;
      }
      grid[r * GRID_COLS + c] = n > 0 ? s / n : 128;
    }
  }

  // Update accumulated grid
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

      const entities = tracker.update(detections, frameNumber);
      const validEntities = entities.filter(e => e.age >= 1);

      // Compute change grid from bitmap
      let changeGrid: number[] = Array.from(accumGrid);
      if (bitmap) {
        changeGrid = computeChangeGrid(bitmap);
        bitmap.close();
      }

      if (cooldown > 0) cooldown--;
      const evidence = detectAccidents(validEntities, [], envMode);

      const hasCollision = evidence.length > 0;
      if (hasCollision) consecutiveAnomaly++;
      else consecutiveAnomaly = 0;

      let newState = state;
      if (hasCollision && consecutiveAnomaly >= 2) {
        newState = "alert";
      } else if (!hasCollision && consecutiveAnomaly === 0) {
        newState = "monitoring";
      }

      if (newState === "alert" && state !== "alert" && cooldown <= 0) {
        cooldown = 200; // ~7 seconds at 30fps
        consecutiveAnomaly = 0;
      }
      state = newState;

      self.postMessage({
        type: "RESULTS",
        frame: frameNumber,
        entities: validEntities.map(serializeEntity),
        evidence: evidence.map(serializeEvidence),
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

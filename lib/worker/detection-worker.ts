// Detection Web Worker - Uses TensorFlow.js COCO-SSD
// Runs object detection, Kalman tracking, and TTC collision detection

import { initDetection, detectObjects, isDetectionReady } from "../detection/yolo-engine";
import { MultiObjectTracker, TrackedEntity } from "../detection/kalman-tracker";
import { detectAccidents, AccidentEvidence } from "../detection/ttc-engine";
import { autoCalibrate } from "../detection/speed-estimator";
import type { EnvMode, WorkerInput, WorkerOutput, SerializedEntity, SerializedEvidence } from "./message-types";

let tracker = new MultiObjectTracker();
let envMode: EnvMode = "isolated";
let pixelsPerMeter = 20;
let frameCount = 0;
let consecutiveAnomaly = 0;
let cooldown = 0;
let state = "monitoring";
let lastFrameTime = performance.now();

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

function computeChangeGrid(bitmap: ImageBitmap): Float32Array {
  if (!offscreen || offscreen.width !== bitmap.width) {
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
  return grid;
}

async function processFrame(bitmap: ImageBitmap, frameNumber: number) {
  const now = performance.now();
  const fps = now - lastFrameTime > 0 ? 1000 / (now - lastFrameTime) : 0;
  lastFrameTime = now;
  try {
    const detections = await detectObjects(bitmap as any);
    const detForTracker = detections.map(d => ({
      class: d.class, cx: d.cx, cy: d.cy, w: d.width, h: d.height, confidence: d.confidence,
    }));
    const entities = tracker.update(detForTracker, frameNumber);
    const valid = entities.filter(e => e.age >= 1);

    let changeGrid = Array.from(accumGrid);
    if (frameNumber % 15 === 0) {
      const ng = computeChangeGrid(bitmap);
      for (let i = 0; i < GRID_COLS * GRID_ROWS; i++) {
        const diff = prevGrid[i] ? Math.abs(ng[i] - prevGrid[i]) / 255 : 0;
        accumGrid[i] = accumGrid[i] * 0.95 + diff * 3;
        prevGrid[i] = ng[i];
      }
      changeGrid = Array.from(accumGrid);
    }

    if (cooldown > 0) cooldown--;
    const evidence = detectAccidents(valid, [], envMode);
    const hasCollision = evidence.length > 0;
    if (hasCollision) consecutiveAnomaly++; else consecutiveAnomaly = 0;
    let newState = state;
    if (hasCollision && consecutiveAnomaly >= 4) newState = "alert";
    else if (!hasCollision) newState = "monitoring";
    if (newState === "alert" && state !== "alert" && cooldown <= 0) {
      cooldown = 300; consecutiveAnomaly = 0;
    }
    state = newState;

    self.postMessage({
      type: "RESULTS", frame: frameNumber,
      entities: valid.map(serializeEntity),
      evidence: evidence.map(serializeEvidence),
      changeGrid, state, fps: Math.round(fps), detectionCount: detections.length,
    } satisfies WorkerOutput);
  } catch (err) {
    self.postMessage({ type: "ERROR", message: err instanceof Error ? err.message : String(err) } satisfies WorkerOutput);
  } finally { bitmap.close(); }
}

self.onmessage = async (e: MessageEvent<WorkerInput>) => {
  const msg = e.data;
  switch (msg.type) {
    case "INIT": {
      try {
        envMode = msg.envMode || "isolated";
        pixelsPerMeter = autoCalibrate(640, 480, envMode);
        if (!isDetectionReady()) await initDetection();
        self.postMessage({ type: "MODEL_LOADED", backend: "tfjs" } satisfies WorkerOutput);
      } catch (err) {
        self.postMessage({ type: "MODEL_ERROR", error: err instanceof Error ? err.message : String(err) } satisfies WorkerOutput);
      }
      break;
    }
    case "FRAME": { frameCount++; await processFrame(msg.bitmap, msg.frameNumber || frameCount); break; }
    case "SET_MODE": { envMode = msg.envMode; pixelsPerMeter = autoCalibrate(640, 480, envMode); break; }
    case "STOP": {
      tracker.reset(); accumGrid.fill(0); prevGrid.fill(0);
      frameCount = 0; consecutiveAnomaly = 0; cooldown = 0; state = "monitoring"; break;
    }
  }
};

self.postMessage({ type: "READY" } satisfies WorkerOutput);

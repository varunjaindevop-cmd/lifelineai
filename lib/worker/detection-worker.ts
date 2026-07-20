/**
 * Detection Web Worker — simplified collision detection.
 *
 * Pipeline:
 *   Frame → ONNX inference → Kalman tracking → IoU + speed-drop collision rules
 *   → State machine → post RESULTS back to main thread.
 *
 * Removed: TTC engine, energy analyzer, trajectory predictor, complex anomaly rules.
 * Kept: Kalman tracker, frame memory, state machine, change detection grid.
 */

import {
  loadModel,
  detect as onnxDetect,
  toPixelDetections,
  type Detection,
} from "../detection/onnx-engine";
import { MultiObjectTracker, type TrackedEntity } from "../detection/kalman-tracker";
import { FrameMemory } from "../detection/frame-memory";
import { autoCalibrate } from "../detection/speed-estimator";
import type { EnvMode, WorkerOutput, SerializedEntity, SerializedEvidence } from "./message-types";

// ── Runtime state ───────────────────────────────────────────────
let tracker = new MultiObjectTracker();
let frameMemory = new FrameMemory();
let envMode: EnvMode = "isolated";
let pixelsPerMeter = 20;
let frameCount = 0;
let cooldown = 0;
let state: "monitoring" | "watching" | "confirming" | "alert" = "monitoring";
let confirmStart = 0;       // timestamp when entering confirming
let alertCooldown = 0;      // frames to skip after alert

// Tunable thresholds (overridden from localStorage via debug page)
let iouThreshold = 0.2;
let speedDropPct = 0.40;     // 40% speed drop
let fallConfThreshold = 0.6;
let confirmDurationMs = 500;  // 0.5 seconds
let alertDurationMs = 1000;   // 1 second of continuous evidence
let cooldownMs = 5000;        // 5 seconds after alert

// Change detection grid
const GRID_COLS = 10;
const GRID_ROWS = 8;
const prevGrid = new Float32Array(GRID_COLS * GRID_ROWS);
const accumGrid = new Float32Array(GRID_COLS * GRID_ROWS);

// Offscreen canvas for bitmap → ImageData
let offscreen: OffscreenCanvas | null = null;
let offCtx: OffscreenCanvasRenderingContext2D | null = null;

// ── Helpers ─────────────────────────────────────────────────────

function serializeEntity(e: TrackedEntity): SerializedEntity {
  const k = e.kalman.getState();
  return {
    id: e.id,
    class: e.class,
    confidence: e.confidence,
    x: k.x,
    y: k.y,
    vx: k.vx,
    vy: k.vy,
    ax: k.ax,
    ay: k.ay,
    speed: e.speed,
    heading: e.heading,
    acceleration: e.acceleration,
    w: e.w,
    h: e.h,
    age: e.age,
    positions: [...e.positions],
    speedHistory: [...e.speedHistory],
    headingHistory: [...e.headingHistory],
    aspectHistory: [...e.aspectHistory],
  };
}

function serializeEvidence(ev: SerializedEvidence): SerializedEvidence {
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
      for (let dy = 0; dy < ch; dy += 4) {
        for (let dx = 0; dx < cw; dx += 4) {
          const i = ((r * ch + dy) * bitmap.width + (c * cw + dx)) * 4;
          s += data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
          n++;
        }
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

// ── Simplified collision detection ──────────────────────────────

interface CollisionEvidence {
  type: "collision" | "person_fall";
  confidence: number;
  objects: number[];
  details: string;
}

function IoU(
  ax: number, ay: number, aw: number, ah: number,
  bx: number, by: number, bw: number, bh: number
): number {
  const ix1 = Math.max(ax - aw / 2, bx - bw / 2);
  const iy1 = Math.max(ay - ah / 2, by - bh / 2);
  const ix2 = Math.min(ax + aw / 2, bx + bw / 2);
  const iy2 = Math.min(ay + ah / 2, by + bh / 2);
  const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
  const areaA = aw * ah;
  const areaB = bw * bh;
  return inter / (areaA + areaB - inter + 1e-6);
}

function detectCollisions(entities: TrackedEntity[]): CollisionEvidence[] {
  const evidence: CollisionEvidence[] = [];
  const now = Date.now();
  const vehicles = entities.filter(
    (e) => e.age >= 3 && (e.class === "car" || e.class === "truck" || e.class === "bus" || e.class === "motorcycle")
  );
  const people = entities.filter((e) => e.age >= 3 && e.class === "person");
  const all = [...vehicles, ...people];

  // ── Rule 1: IoU overlap + speed drop ──
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i];
      const b = all[j];
      // Skip person–person
      if (a.class === "person" && b.class === "person") continue;

      const iou = IoU(
        a.kalman.getState().x, a.kalman.getState().y, a.w, a.h,
        b.kalman.getState().x, b.kalman.getState().y, b.w, b.h
      );

      if (iou < iouThreshold) continue;

      // Check speed drop: average of last 5 frames vs average of frames 5–10 ago
      let aDropped = false;
      let bDropped = false;

      if (a.speedHistory.length >= 8) {
        const recentAvg = a.speedHistory.slice(0, 5).reduce((s, v) => s + v, 0) / 5;
        const olderAvg = a.speedHistory.slice(5, 10).reduce((s, v) => s + v, 0) / Math.min(5, a.speedHistory.length - 5);
        if (olderAvg > 0.5 && recentAvg < olderAvg * (1 - speedDropPct)) aDropped = true;
      }

      if (b.speedHistory.length >= 8) {
        const recentAvg = b.speedHistory.slice(0, 5).reduce((s, v) => s + v, 0) / 5;
        const olderAvg = b.speedHistory.slice(5, 10).reduce((s, v) => s + v, 0) / Math.min(5, b.speedHistory.length - 5);
        if (olderAvg > 0.5 && recentAvg < olderAvg * (1 - speedDropPct)) bDropped = true;
      }

      // At least one must have decelerated
      if (!aDropped && !bDropped) continue;

      // Filter: reject if overlapping for > 1 second (~30 frames at 3fps)
      // Check if they were overlapping at positions 30 frames ago
      if (a.positions.length > 30 && b.positions.length > 30) {
        const oldA = a.positions[a.positions.length - 30];
        const oldB = b.positions[b.positions.length - 30];
        const oldIou = IoU(oldA.x, oldA.y, a.w, a.h, oldB.x, oldB.y, b.w, b.h);
        if (oldIou > iouThreshold * 0.8) continue; // already overlapping long ago
      }

      const confidence = Math.min(0.95, 0.5 * iou + 0.3 * (aDropped ? 1 : 0.5) + 0.3 * (bDropped ? 1 : 0.5));
      evidence.push({
        type: "collision",
        confidence,
        objects: [a.id, b.id],
        details: `IoU=${iou.toFixed(2)} dropA=${aDropped} dropB=${bDropped}`,
      });
    }
  }

  // ── Rule 2: fallen_person class detection ──
  const fallEntities = entities.filter((e) => e.class === "fallen_person" && e.confidence >= fallConfThreshold);
  for (const e of fallEntities) {
    if (e.age < 3) continue;
    evidence.push({
      type: "person_fall",
      confidence: Math.min(0.9, e.confidence),
      objects: [e.id],
      details: `fallen_person conf=${e.confidence.toFixed(2)} age=${e.age}`,
    });
  }

  // ── Rule 3: person aspect-ratio flip (was standing → now lying) ──
  for (const e of people) {
    if (e.age < 5 || e.aspectHistory.length < 5) continue;
    const oldAR = e.aspectHistory.slice(0, 3).reduce((s, v) => s + v, 0) / 3;
    const curAR = e.aspectHistory[e.aspectHistory.length - 1];
    const wasStanding = oldAR < 0.6; // tall & narrow
    const nowLying = curAR > 0.9;    // wide

    if (wasStanding && nowLying) {
      const wasMoving = e.speedHistory.slice(0, 5).some((s) => s > 0.8);
      const isStill = e.speed < 0.3;
      if (wasMoving && isStill) {
        evidence.push({
          type: "person_fall",
          confidence: 0.8,
          objects: [e.id],
          details: `AR flip ${oldAR.toFixed(2)}→${curAR.toFixed(2)}`,
        });
      }
    }
  }

  evidence.sort((a, b) => b.confidence - a.confidence);
  return evidence;
}

// ── State machine ───────────────────────────────────────────────

function processStateMachine(evidence: CollisionEvidence[]): {
  state: typeof state;
  shouldAlert: boolean;
  alertType: string | null;
  alertConfidence: number;
} {
  const hasEvidence = evidence.length > 0;
  const topConfidence = hasEvidence ? evidence[0].confidence : 0;
  const topType = hasEvidence ? evidence[0].type : null;
  const now = Date.now();

  // Cooldown active → do nothing
  if (alertCooldown > 0) {
    alertCooldown--;
    return { state, shouldAlert: false, alertType: null, alertConfidence: 0 };
  }

  let newState = state;

  switch (state) {
    case "monitoring":
      if (hasEvidence && topConfidence > 0.7) {
        newState = "watching";
      }
      break;

    case "watching":
      if (!hasEvidence || topConfidence < 0.5) {
        newState = "monitoring";
      } else if (hasEvidence) {
        newState = "confirming";
        confirmStart = now;
      }
      break;

    case "confirming":
      if (!hasEvidence || topConfidence < 0.4) {
        newState = "monitoring";
      } else if (now - confirmStart >= confirmDurationMs) {
        newState = "alert";
      }
      break;

    case "alert":
      // Transitioned to alert this frame → fire
      break;
  }

  const shouldAlert = state !== "alert" && newState === "alert";
  if (shouldAlert) {
    alertCooldown = Math.round(cooldownMs / 200); // ~200ms per frame tick
    newState = "monitoring";
  }

  state = newState;
  return {
    state,
    shouldAlert,
    alertType: shouldAlert ? topType : null,
    alertConfidence: shouldAlert ? topConfidence : 0,
  };
}

// ── Message handler ─────────────────────────────────────────────

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;

  switch (msg.type) {
    case "INIT": {
      envMode = msg.envMode || "isolated";
      pixelsPerMeter = autoCalibrate(640, 480, envMode);

      try {
        await loadModel(msg.modelPath || "/models/best.onnx");
        self.postMessage({ type: "MODEL_LOADED", backend: "onnx" } satisfies WorkerOutput);
      } catch (err: any) {
        self.postMessage({ type: "MODEL_ERROR", error: err.message } satisfies WorkerOutput);
      }
      break;
    }

    case "FRAME": {
      const bitmap = msg.bitmap as ImageBitmap;
      const frameNumber = msg.frame ?? frameCount;
      frameCount++;

      // Convert ImageBitmap → ImageData for ONNX engine
      if (!offscreen || offscreen.width !== bitmap.width || offscreen.height !== bitmap.height) {
        offscreen = new OffscreenCanvas(bitmap.width, bitmap.height);
        offCtx = offscreen.getContext("2d", { willReadFrequently: true })!;
      }
      offCtx!.drawImage(bitmap, 0, 0);
      const imageData = offCtx!.getImageData(0, 0, bitmap.width, bitmap.height);
      bitmap.close();

      // 1. ONNX detection
      let detections: Detection[] = [];
      try {
        detections = await onnxDetect(imageData);
      } catch {
        // Model might not be loaded yet
      }

      // Convert to pixel-space for tracker
      const pixelDets = toPixelDetections(detections, bitmap.width, bitmap.height);

      // 2. Kalman tracking
      const entities = tracker.update(pixelDets, frameNumber);
      const validEntities = entities.filter((e) => e.age >= 1);

      // 3. Store in frame memory
      frameMemory.addFrame({
        frame: frameNumber,
        timestamp: Date.now(),
        entities: validEntities.map((e) => ({
          id: e.id,
          class: e.class,
          x: e.kalman.getState().x,
          y: e.kalman.getState().y,
          speed: e.speed,
          heading: e.heading,
        })),
      });

      // 4. Change detection grid
      let changeGrid: number[] = Array.from(accumGrid);

      // 5. Run simplified collision detection
      if (cooldown > 0) cooldown--;

      const evidence = detectCollisions(validEntities);

      // 6. State machine
      const smResult = processStateMachine(evidence);

      // 7. Post results
      self.postMessage({
        type: "RESULTS",
        frame: frameNumber,
        entities: validEntities.map(serializeEntity),
        evidence: evidence.map(serializeEvidence),
        changeGrid,
        state: smResult.state,
        fps: 0,
        detectionCount: detections.length,
      } satisfies WorkerOutput);
      break;
    }

    case "SET_THRESHOLDS": {
      // From debug page localStorage
      if (msg.iouThreshold !== undefined) iouThreshold = msg.iouThreshold;
      if (msg.speedDropPct !== undefined) speedDropPct = msg.speedDropPct;
      if (msg.fallConfThreshold !== undefined) fallConfThreshold = msg.fallConfThreshold;
      if (msg.confirmDurationMs !== undefined) confirmDurationMs = msg.confirmDurationMs;
      if (msg.alertDurationMs !== undefined) alertDurationMs = msg.alertDurationMs;
      if (msg.cooldownMs !== undefined) cooldownMs = msg.cooldownMs;
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
      cooldown = 0;
      alertCooldown = 0;
      state = "monitoring";
      break;
    }
  }
};

// Signal ready immediately
self.postMessage({ type: "READY" } satisfies WorkerOutput);

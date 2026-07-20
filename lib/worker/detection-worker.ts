/**
 * Detection Web Worker v6 — COCO-SSD + Kalman tracking (lightweight).
 * Falls back to COCO-SSD when ONNX model is unavailable.
 * Body state detection uses bounding box analysis (no heavy pose model).
 */

import { loadModel, detect as onnxDetect, toPixelDetections, type Detection } from "../detection/onnx-engine";
import { loadCocoModel, detectWithCoco, toPixelDetections as cocoToPixel } from "../detection/coco-engine";
import { MultiObjectTracker, type TrackedEntity } from "../detection/kalman-tracker";
import { FrameMemory } from "../detection/frame-memory";
import { detectAccidents, type AccidentEvidence, type EnvMode } from "../detection/ttc-engine";
import type { WorkerOutput } from "./message-types";

let tracker = new MultiObjectTracker();
let frameMemory = new FrameMemory();
let frameCount = 0;
let modelLoaded = false;
let cocoLoaded = false;
let envMode: EnvMode = "isolated";

let offscreen: OffscreenCanvas | null = null;
let offCtx: OffscreenCanvasRenderingContext2D | null = null;
let prevFrameData: Uint8ClampedArray | null = null;
const GRID_COLS = 10, GRID_ROWS = 8;
let pixelsPerMeter = 20;

// Track entities that were recently lost (disappeared from detection)
interface LostEntity {
  id: number;
  class: string;
  lastX: number;
  lastY: number;
  lastSpeed: number;
  lastHeading: number;
  lostAtFrame: number;
  wasMoving: boolean;
}
const lostEntities: LostEntity[] = [];
const MAX_LOST_AGE = 15;
const MAX_LOST_ENTITIES = 50;
let previousEntityIds = new Set<number>();

function updatePPM(mode: EnvMode) {
  const lanes = { isolated: 2, traffic: 3, marketplace: 1 };
  pixelsPerMeter = Math.max(8, Math.min(35, (320 * 0.35) / (lanes[mode] * 3.5)));
}

function getModeThreshold(mode: EnvMode): number {
  return mode === "isolated" ? 0.30 : mode === "traffic" ? 0.45 : 0.45; // lowered all thresholds
}
function getRequiredFrames(mode: EnvMode): number {
  return mode === "isolated" ? 2 : mode === "traffic" ? 3 : 3; // lowered from 4 for traffic
}

interface ConfirmationEntry { key: string; firstSeen: number; lastSeen: number; signalHistory: number[] }
const confirmBuffer = new Map<string, ConfirmationEntry>();

function checkConfirmation(evidence: AccidentEvidence, frame: number): boolean {
  const key = `${evidence.type}:${[...evidence.objects].sort().join(",")}`;
  const existing = confirmBuffer.get(key);
  const required = getRequiredFrames(envMode);
  if (!existing) {
    confirmBuffer.set(key, { key, firstSeen: frame, lastSeen: frame, signalHistory: [evidence.confidence] });
    return false;
  }
  existing.lastSeen = frame;
  existing.signalHistory.push(evidence.confidence);
  if (existing.signalHistory.length > 10) existing.signalHistory.shift();
  if (existing.lastSeen - existing.firstSeen < required) return false;
  const recent = existing.signalHistory.slice(-3);
  const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
  return avg > getModeThreshold(envMode);
}

function cleanConfirmBuffer(frame: number) {
  for (const [key, entry] of Array.from(confirmBuffer.entries())) {
    if (frame - entry.lastSeen > 30) confirmBuffer.delete(key);
  }
}

function computeChangeGrid(imageData: ImageData): number[] {
  const grid = new Array(GRID_COLS * GRID_ROWS).fill(0);
  const { data, width: w, height: h } = imageData;
  const cellW = Math.floor(w / GRID_COLS), cellH = Math.floor(h / GRID_ROWS);
  if (!prevFrameData) { prevFrameData = new Uint8ClampedArray(data); return grid; }
  for (let gy = 0; gy < GRID_ROWS; gy++) {
    for (let gx = 0; gx < GRID_COLS; gx++) {
      let diff = 0, cnt = 0;
      for (let y = gy * cellH; y < (gy + 1) * cellH; y += 4) {
        for (let x = gx * cellW; x < (gx + 1) * cellW; x += 4) {
          const idx = (y * w + x) * 4;
          const gray = data[idx] * 0.299 + data[idx + 1] * 0.587 + data[idx + 2] * 0.114;
          const pGray = prevFrameData[idx] * 0.299 + prevFrameData[idx + 1] * 0.587 + prevFrameData[idx + 2] * 0.114;
          diff += Math.abs(gray - pGray); cnt++;
        }
      }
      grid[gy * GRID_COLS + gx] = cnt > 0 ? diff / cnt / 255 : 0;
    }
  }
  prevFrameData = new Uint8ClampedArray(data);
  prevFrameData.set(data);
  return grid;
}

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;

  switch (msg.type) {
    case "INIT": {
      try {
        await loadModel(msg.modelPath || "/models/best.onnx");
        modelLoaded = true;
      } catch {
        modelLoaded = false;
        try { await loadCocoModel(); cocoLoaded = true; } catch { cocoLoaded = false; }
      }
      if (msg.envMode) { envMode = msg.envMode; updatePPM(envMode); }
      const backend = modelLoaded ? "onnx" : cocoLoaded ? "coco-ssd" : "demo";
      self.postMessage({ type: "MODEL_LOADED", backend } satisfies WorkerOutput);
      break;
    }

    case "FRAME": {
      const bitmap = msg.bitmap as ImageBitmap;
      const frameNumber = msg.frame ?? frameCount;
      frameCount++;

      if (!offscreen || offscreen.width !== bitmap.width || offscreen.height !== bitmap.height) {
        offscreen = new OffscreenCanvas(bitmap.width, bitmap.height);
        offCtx = offscreen.getContext("2d", { willReadFrequently: true })!;
      }
      offCtx!.drawImage(bitmap, 0, 0);
      const imageData = offCtx!.getImageData(0, 0, bitmap.width, bitmap.height);
      bitmap.close();

      let detections: Detection[] = [];
      if (modelLoaded) { try { detections = await onnxDetect(imageData); } catch {} }
      else if (cocoLoaded) { try { detections = await detectWithCoco(imageData); } catch {} }

      const pixelDets = modelLoaded
        ? toPixelDetections(detections, imageData.width, imageData.height)
        : cocoToPixel(detections, imageData.width, imageData.height);

      const entities = tracker.update(pixelDets, frameNumber);
      const validEntities = entities.filter(e => e.age >= 1);

      // Detect entities that disappeared since last frame
      const currentIds = new Set(validEntities.map(e => e.id));
      for (const prevId of Array.from(previousEntityIds)) {
        if (!currentIds.has(prevId)) {
          // This entity disappeared — find its last known state from frame memory
          const history = frameMemory.getHistory();
          for (let i = history.length - 1; i >= 0; i--) {
            const snapshot = history[i];
            const ent = snapshot.entities.find(e => e.id === prevId);
            if (ent) {
              const speed = Math.sqrt(ent.speed ** 2);
              console.log(`[Worker] Entity DISAPPEARED: ${ent.class}#${prevId} was at (${ent.x.toFixed(0)},${ent.y.toFixed(0)}) speed=${speed.toFixed(1)}px/f`);
              lostEntities.push({
                id: prevId,
                class: ent.class,
                lastX: ent.x,
                lastY: ent.y,
                lastSpeed: speed,
                lastHeading: ent.heading,
                lostAtFrame: frameNumber,
                wasMoving: speed > 0.5,
              });
              break;
            }
          }
        }
      }
      previousEntityIds = currentIds;

      // Clean old lost entities
      for (let i = lostEntities.length - 1; i >= 0; i--) {
        if (frameNumber - lostEntities[i].lostAtFrame > MAX_LOST_AGE) {
          lostEntities.splice(i, 1);
        }
      }

      // Limit array size to prevent memory issues
      while (lostEntities.length > MAX_LOST_ENTITIES) {
        lostEntities.shift();
      }

      // Speed in km/h
      for (const entity of validEntities) {
        if (entity.positions.length >= 2) {
          const last = entity.positions[entity.positions.length - 1];
          const prev = entity.positions[entity.positions.length - 2];
          const pixelDist = Math.sqrt((last.x - prev.x) ** 2 + (last.y - prev.y) ** 2);
          (entity as any).speedKmh = Math.round((pixelDist / pixelsPerMeter) * 3 * 3.6);
        } else { (entity as any).speedKmh = 0; }
      }

      frameMemory.addFrame({
        frame: frameNumber, timestamp: Date.now(),
        entities: validEntities.map(e => ({
          id: e.id, class: e.class,
          x: e.kalman.getState().x, y: e.kalman.getState().y,
          speed: e.speed, heading: e.heading,
        })),
      });

      const changeGrid = computeChangeGrid(imageData);
      const rawEvidence = detectAccidents(validEntities, envMode, lostEntities, changeGrid);

      // Debug logging
      if (validEntities.length > 0) {
        const entitySummary = validEntities.map(e => `${e.class}#${e.id}(spd=${(e as any).speedKmh ?? 0}km/h age=${e.age})`).join(", ");
        console.log(`[Worker] F${frameNumber}: ${validEntities.length} entities [${entitySummary}] lost=${lostEntities.length}`);
      }
      if (rawEvidence.length > 0) {
        console.log(`[Worker] F${frameNumber}: ${rawEvidence.length} raw evidence`);
      }

      const confirmedEvidence: AccidentEvidence[] = [];
      for (const ev of rawEvidence) {
        if (checkConfirmation(ev, frameNumber)) confirmedEvidence.push(ev);
      }
      cleanConfirmBuffer(frameNumber);

      const serializedEntities = validEntities.map(e => {
        const k = e.kalman.getState();
        // Filter: only send near-camera entities to UI
        // Traffic: bottom 45% only. Isolated/Marketplace: bottom 65%
        const normalizedY = k.y / (bitmap.height || 480);
        const nearThreshold = envMode === "traffic" ? 0.55 : 0.35;
        const isNear = normalizedY > nearThreshold;

        return {
          id: e.id, class: e.class, confidence: e.confidence,
          x: k.x, y: k.y, vx: k.vx, vy: k.vy, ax: k.ax, ay: k.ay,
          speed: (e as any).speedKmh ?? 0,
          heading: e.heading, acceleration: e.acceleration,
          w: e.w, h: e.h, age: e.age, confirmedFrames: e.confirmedFrames,
          positions: [...e.positions],
          speedHistory: [...e.speedHistory],
          headingHistory: [...e.headingHistory],
          aspectHistory: [...e.aspectHistory],
          isNear, // flag for overlay to decide whether to draw
        };
      });

      self.postMessage({
        type: "RESULTS",
        frame: frameNumber,
        entities: serializedEntities,
        evidence: confirmedEvidence.map(ev => ({
          type: ev.type, confidence: ev.confidence, objects: [...ev.objects],
          details: ev.details,
          signals: ev.signals.map(s => ({ name: s.name, value: s.value, weight: s.weight, passed: s.passed })),
          sceneContext: envMode,
        })),
        skeletons: [],
        changeGrid,
        state: confirmedEvidence.length > 0 ? "alert" : "monitoring",
        fps: 0,
        detectionCount: detections.length,
      } satisfies WorkerOutput);
      break;
    }

    case "SET_THRESHOLDS": break;

    case "SET_MODE": {
      envMode = msg.envMode;
      updatePPM(envMode);
      confirmBuffer.clear();
      break;
    }

    case "STOP": {
      tracker.reset();
      frameMemory.clear();
      confirmBuffer.clear();
      lostEntities.length = 0;
      previousEntityIds.clear();
      prevFrameData = null;
      frameCount = 0;
      break;
    }
  }
};

self.postMessage({ type: "READY" } satisfies WorkerOutput);

/**
 * Detection Web Worker — unified pipeline with COCO-SSD fallback.
 * ONNX inference → Kalman tracking → 5-signal collision detection → temporal confirmation.
 * Falls back to COCO-SSD (TensorFlow.js) when ONNX model is unavailable.
 */

import { loadModel, detect as onnxDetect, isModelReady, toPixelDetections, type Detection } from "../detection/onnx-engine";
import { loadCocoModel, detectWithCoco, isCocoReady, toPixelDetections as cocoToPixel } from "../detection/coco-engine";
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

// Offscreen canvas for bitmap → ImageData conversion
let offscreen: OffscreenCanvas | null = null;
let offCtx: OffscreenCanvasRenderingContext2D | null = null;

// Previous frame for change detection
let prevFrameData: Uint8ClampedArray | null = null;
const GRID_COLS = 10;
const GRID_ROWS = 8;

// Speed estimation: pixels per meter (auto-calibrated per mode)
let pixelsPerMeter = 20; // default, updated on mode change

function updatePPM(mode: EnvMode) {
  const assumptions = { isolated: 2, traffic: 3, marketplace: 1 };
  const laneWidth = 3.5;
  const roadWidthMeters = assumptions[mode] * laneWidth;
  // Assume road occupies ~35% of the shorter dimension
  const refPixels = 320; // half of 640
  const roadPixels = refPixels * 0.35;
  pixelsPerMeter = Math.max(8, Math.min(35, roadPixels / roadWidthMeters));
}

// Mode-specific thresholds
function getModeThreshold(mode: EnvMode): number {
  switch (mode) {
    case "isolated": return 0.35;
    case "traffic": return 0.60;
    case "marketplace": return 0.50;
  }
}

function getRequiredFrames(mode: EnvMode): number {
  switch (mode) {
    case "isolated": return 2; // fast confirmation for isolated
    case "traffic": return 4;
    case "marketplace": return 3;
  }
}

// ── Temporal confirmation buffer ──
interface ConfirmationEntry {
  key: string;
  firstSeen: number;
  lastSeen: number;
  maxConfidence: number;
  signalHistory: number[];
}

const confirmBuffer = new Map<string, ConfirmationEntry>();

function checkConfirmation(evidence: AccidentEvidence, frame: number): boolean {
  const key = `${evidence.type}:${[...evidence.objects].sort().join(",")}`;
  const existing = confirmBuffer.get(key);
  const requiredFrames = getRequiredFrames(envMode);

  if (!existing) {
    confirmBuffer.set(key, {
      key, firstSeen: frame, lastSeen: frame,
      maxConfidence: evidence.confidence,
      signalHistory: [evidence.confidence],
    });
    return false;
  }

  existing.lastSeen = frame;
  existing.maxConfidence = Math.max(existing.maxConfidence, evidence.confidence);
  existing.signalHistory.push(evidence.confidence);
  if (existing.signalHistory.length > 10) existing.signalHistory.shift();

  if (existing.lastSeen - existing.firstSeen < requiredFrames) {
    console.log(`[Confirm] ${evidence.type} frames=${existing.lastSeen - existing.firstSeen}/${requiredFrames} conf=${evidence.confidence.toFixed(3)}`);
    return false;
  }

  const recent = existing.signalHistory.slice(-3);
  const avgConf = recent.reduce((a, b) => a + b, 0) / recent.length;
  const threshold = getModeThreshold(envMode);
  console.log(`[Confirm] ${evidence.type} READY avg=${avgConf.toFixed(3)} threshold=${threshold} pass=${avgConf > threshold}`);
  return avgConf > threshold;
}

function cleanConfirmBuffer(frame: number) {
  const entries = Array.from(confirmBuffer.entries());
  for (const [key, entry] of entries) {
    if (frame - entry.lastSeen > 30) confirmBuffer.delete(key);
  }
}

// ── Change detection grid ──
function computeChangeGrid(imageData: ImageData): number[] {
  const grid = new Array(GRID_COLS * GRID_ROWS).fill(0);
  const data = imageData.data;
  const w = imageData.width;
  const h = imageData.height;
  const cellW = Math.floor(w / GRID_COLS);
  const cellH = Math.floor(h / GRID_ROWS);

  if (!prevFrameData) {
    prevFrameData = new Uint8ClampedArray(data);
    return grid;
  }

  let totalDiff = 0;
  let count = 0;

  for (let gy = 0; gy < GRID_ROWS; gy++) {
    for (let gx = 0; gx < GRID_COLS; gx++) {
      let cellDiff = 0;
      let cellCount = 0;

      // Sample every 4th pixel for speed
      for (let y = gy * cellH; y < (gy + 1) * cellH; y += 4) {
        for (let x = gx * cellW; x < (gx + 1) * cellW; x += 4) {
          const idx = (y * w + x) * 4;
          const gray = data[idx] * 0.299 + data[idx + 1] * 0.587 + data[idx + 2] * 0.114;
          const prevGray = prevFrameData[idx] * 0.299 + prevFrameData[idx + 1] * 0.587 + prevFrameData[idx + 2] * 0.114;
          cellDiff += Math.abs(gray - prevGray);
          cellCount++;
        }
      }

      const avgDiff = cellCount > 0 ? cellDiff / cellCount / 255 : 0;
      grid[gy * GRID_COLS + gx] = avgDiff;
      totalDiff += avgDiff;
      count++;
    }
  }

  // Save current frame for next comparison (subsample to save memory)
  prevFrameData = new Uint8ClampedArray(data.length);
  prevFrameData.set(data);

  return grid;
}

// ── Message handler ──

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;

  switch (msg.type) {
    case "INIT": {
      // Try ONNX first, then COCO-SSD as fallback
      try {
        await loadModel(msg.modelPath || "/models/best.onnx");
        modelLoaded = true;
        console.log("[Worker] ONNX model loaded successfully");
      } catch (err: any) {
        console.warn("[Worker] ONNX model load failed:", err.message);
        modelLoaded = false;

        // Try COCO-SSD fallback
        try {
          await loadCocoModel();
          cocoLoaded = true;
          console.log("[Worker] COCO-SSD loaded as fallback");
        } catch (err2: any) {
          console.warn("[Worker] COCO-SSD also failed:", err2.message);
          cocoLoaded = false;
        }
      }

      if (msg.envMode) {
        envMode = msg.envMode;
        updatePPM(envMode);
      }

      const backend = modelLoaded ? "onnx" : cocoLoaded ? "coco-ssd" : "demo";
      console.log(`[Worker] Backend: ${backend}`);
      self.postMessage({ type: "MODEL_LOADED", backend } satisfies WorkerOutput);
      break;
    }

    case "FRAME": {
      const bitmap = msg.bitmap as ImageBitmap;
      const frameNumber = msg.frame ?? msg.frameNumber ?? frameCount;
      frameCount++;

      // Convert bitmap → ImageData
      if (!offscreen || offscreen.width !== bitmap.width || offscreen.height !== bitmap.height) {
        offscreen = new OffscreenCanvas(bitmap.width, bitmap.height);
        offCtx = offscreen.getContext("2d", { willReadFrequently: true })!;
      }
      offCtx!.drawImage(bitmap, 0, 0);
      const imageData = offCtx!.getImageData(0, 0, bitmap.width, bitmap.height);
      bitmap.close();

      // Run inference with best available backend
      let detections: Detection[] = [];
      if (modelLoaded) {
        try {
          detections = await onnxDetect(imageData);
        } catch (err) {
          console.error("[Worker] ONNX inference error:", err);
        }
      } else if (cocoLoaded) {
        try {
          detections = await detectWithCoco(imageData);
        } catch (err) {
          console.error("[Worker] COCO inference error:", err);
        }
      }

      // Convert to pixel space for tracker
      const pixelDets = modelLoaded
        ? toPixelDetections(detections, imageData.width, imageData.height)
        : cocoToPixel(detections, imageData.width, imageData.height);

      // Kalman tracking
      const entities = tracker.update(pixelDets, frameNumber);
      const validEntities = entities.filter(e => e.age >= 1);

      // Compute real speed in km/h for each entity
      for (const entity of validEntities) {
        // Use position history for actual speed
        if (entity.positions.length >= 2) {
          const last = entity.positions[entity.positions.length - 1];
          const prev = entity.positions[entity.positions.length - 2];
          const dx = last.x - prev.x;
          const dy = last.y - prev.y;
          const pixelDist = Math.sqrt(dx * dx + dy * dy);
          // Convert: pixels/frame → meters/frame → meters/sec → km/h
          const metersPerFrame = pixelDist / pixelsPerMeter;
          const metersPerSec = metersPerFrame * 3; // ~3 FPS detection
          (entity as any).speedKmh = Math.round(metersPerSec * 3.6);
        } else {
          (entity as any).speedKmh = 0;
        }
      }

      // Store in frame memory
      frameMemory.addFrame({
        frame: frameNumber,
        timestamp: Date.now(),
        entities: validEntities.map(e => ({
          id: e.id, class: e.class,
          x: e.kalman.getState().x, y: e.kalman.getState().y,
          speed: e.speed, heading: e.heading,
        })),
      });

      // Compute change detection grid
      const changeGrid = computeChangeGrid(imageData);

      // UNIFIED detection pipeline
      const rawEvidence = detectAccidents(validEntities, envMode);

      // Temporal confirmation
      const confirmedEvidence: AccidentEvidence[] = [];
      for (const ev of rawEvidence) {
        if (checkConfirmation(ev, frameNumber)) {
          confirmedEvidence.push(ev);
        }
      }
      cleanConfirmBuffer(frameNumber);

      // Serialize entities with real speed
      const serializedEntities = validEntities.map(e => {
        const k = e.kalman.getState();
        return {
          id: e.id, class: e.class, confidence: e.confidence,
          x: k.x, y: k.y, vx: k.vx, vy: k.vy, ax: k.ax, ay: k.ay,
          speed: (entity => (entity as any).speedKmh ?? 0)(e),
          heading: e.heading, acceleration: e.acceleration,
          w: e.w, h: e.h, age: e.age, confirmedFrames: e.confirmedFrames,
          positions: [...e.positions],
          speedHistory: [...e.speedHistory],
          headingHistory: [...e.headingHistory],
          aspectHistory: [...e.aspectHistory],
        };
      });

      const serializedEvidence = confirmedEvidence.map(ev => ({
        type: ev.type,
        confidence: ev.confidence,
        objects: [...ev.objects],
        details: ev.details,
        signals: ev.signals.map(s => ({ name: s.name, value: s.value, weight: s.weight, passed: s.passed })),
        sceneContext: envMode,
      }));

      self.postMessage({
        type: "RESULTS",
        frame: frameNumber,
        entities: serializedEntities,
        evidence: serializedEvidence,
        changeGrid,
        state: confirmedEvidence.length > 0 ? "alert" : "monitoring",
        fps: 0,
        detectionCount: detections.length,
      } satisfies WorkerOutput);
      break;
    }

    case "SET_THRESHOLDS": {
      break;
    }

    case "SET_MODE": {
      envMode = msg.envMode;
      updatePPM(envMode);
      confirmBuffer.clear();
      console.log(`[Worker] Mode set to: ${envMode}, PPM: ${pixelsPerMeter.toFixed(1)}`);
      break;
    }

    case "STOP": {
      tracker.reset();
      frameMemory.clear();
      confirmBuffer.clear();
      prevFrameData = null;
      frameCount = 0;
      break;
    }
  }
};

self.postMessage({ type: "READY" } satisfies WorkerOutput);

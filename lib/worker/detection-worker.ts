/**
 * Detection Web Worker — unified pipeline.
 * ONNX inference → Kalman tracking → 5-signal collision detection → temporal confirmation.
 */

import { loadModel, detect as onnxDetect, toPixelDetections, type Detection } from "../detection/onnx-engine";
import { MultiObjectTracker, type TrackedEntity } from "../detection/kalman-tracker";
import { FrameMemory } from "../detection/frame-memory";
import { detectAccidents, type AccidentEvidence, type EnvMode } from "../detection/ttc-engine";
import type { WorkerOutput } from "./message-types";

let tracker = new MultiObjectTracker();
let frameMemory = new FrameMemory();
let frameCount = 0;
let modelLoaded = false;
let demoMode = false;
let envMode: EnvMode = "isolated";

// Offscreen canvas for bitmap → ImageData conversion
let offscreen: OffscreenCanvas | null = null;
let offCtx: OffscreenCanvasRenderingContext2D | null = null;

// ── Temporal confirmation buffer ──
interface ConfirmationEntry {
  key: string;
  firstSeen: number;
  lastSeen: number;
  maxConfidence: number;
  signalHistory: number[];
}

const confirmBuffer = new Map<string, ConfirmationEntry>();

// Mode-specific thresholds
function getModeThreshold(mode: EnvMode): number {
  switch (mode) {
    case "isolated": return 0.40;
    case "traffic": return 0.65;
    case "marketplace": return 0.55;
  }
}

function getRequiredFrames(mode: EnvMode): number {
  switch (mode) {
    case "isolated": return 3;
    case "traffic": return 5;
    case "marketplace": return 5;
  }
}

function checkConfirmation(evidence: AccidentEvidence, frame: number): boolean {
  const key = `${evidence.type}:${[...evidence.objects].sort().join(",")}`;
  const existing = confirmBuffer.get(key);
  const requiredFrames = getRequiredFrames(envMode);

  if (!existing) {
    confirmBuffer.set(key, {
      key,
      firstSeen: frame,
      lastSeen: frame,
      maxConfidence: evidence.confidence,
      signalHistory: [evidence.confidence],
    });
    return false;
  }

  existing.lastSeen = frame;
  existing.maxConfidence = Math.max(existing.maxConfidence, evidence.confidence);
  existing.signalHistory.push(evidence.confidence);
  if (existing.signalHistory.length > 10) existing.signalHistory.shift();

  // Must have enough frames
  if (existing.lastSeen - existing.firstSeen < requiredFrames) return false;

  // Confidence must be sustained (avg of last 3 frames > threshold)
  const recent = existing.signalHistory.slice(-3);
  const avgConf = recent.reduce((a, b) => a + b, 0) / recent.length;

  return avgConf > getModeThreshold(envMode);
}

// Clean old entries from confirmation buffer
function cleanConfirmBuffer(frame: number) {
  const entries = Array.from(confirmBuffer.entries());
  for (const [key, entry] of entries) {
    if (frame - entry.lastSeen > 30) {
      confirmBuffer.delete(key);
    }
  }
}

// ── Demo mode: synthetic detections for pipeline testing ──
function generateDemoDetections(frame: number, width: number, height: number): Detection[] {
  const t = frame * 0.05;
  const dets: Detection[] = [];

  // Vehicle moving left-to-right
  const carX = 0.1 + ((t * 0.02) % 0.8);
  const carY = 0.45 + Math.sin(t * 0.3) * 0.03;
  dets.push({
    bbox: [carX - 0.035, carY - 0.025, carX + 0.035, carY + 0.025],
    class: "car", classId: 1, confidence: 0.82 + Math.random() * 0.1,
    cx: carX, cy: carY, width: 0.07, height: 0.05,
  });

  // Person standing
  const personX = 0.68 + Math.sin(t * 0.08) * 0.015;
  dets.push({
    bbox: [personX - 0.012, 0.515, personX + 0.012, 0.585],
    class: "person", classId: 0, confidence: 0.75 + Math.random() * 0.1,
    cx: personX, cy: 0.55, width: 0.025, height: 0.07,
  });

  // Motorcycle approaching
  const motoX = 0.85 - ((t * 0.015) % 0.5);
  dets.push({
    bbox: [motoX - 0.018, 0.397, motoX + 0.018, 0.443],
    class: "motorcycle", classId: 2, confidence: 0.7 + Math.random() * 0.1,
    cx: motoX, cy: 0.42, width: 0.035, height: 0.045,
  });

  return dets;
}

// ── Message handler ──

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;

  switch (msg.type) {
    case "INIT": {
      try {
        await loadModel(msg.modelPath || "/models/best.onnx");
        modelLoaded = true;
        demoMode = false;
        console.log("[Worker] ONNX model loaded successfully");
      } catch (err: any) {
        console.warn("[Worker] Model load failed:", err.message, "— running in demo mode");
        modelLoaded = false;
        demoMode = true;
      }
      if (msg.envMode) envMode = msg.envMode;
      self.postMessage({ type: "MODEL_LOADED", backend: modelLoaded ? "onnx" : "demo" } satisfies WorkerOutput);
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

      // Run inference (or demo array if no model)
      let detections: Detection[] = [];
      if (modelLoaded) {
        try {
          detections = await onnxDetect(imageData);
        } catch (err) {
          console.error("[Worker] Inference error:", err);
        }
      } else if (demoMode) {
        detections = generateDemoDetections(frameNumber, imageData.width, imageData.height);
      }

      // Convert to pixel space for tracker
      const pixelDets = toPixelDetections(detections, imageData.width, imageData.height);

      // Kalman tracking
      const entities = tracker.update(pixelDets, frameNumber);
      const validEntities = entities.filter(e => e.age >= 1);

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

      // UNIFIED detection pipeline — uses ttc-engine with 5-signal scoring
      const rawEvidence = detectAccidents(validEntities, envMode);

      // Temporal confirmation — evidence must persist over multiple frames
      const confirmedEvidence: AccidentEvidence[] = [];
      for (const ev of rawEvidence) {
        if (checkConfirmation(ev, frameNumber)) {
          confirmedEvidence.push(ev);
        }
      }

      // Clean old buffer entries
      cleanConfirmBuffer(frameNumber);

      // Serialize and post back
      const serializedEntities = validEntities.map(e => {
        const k = e.kalman.getState();
        return {
          id: e.id, class: e.class, confidence: e.confidence,
          x: k.x, y: k.y, vx: k.vx, vy: k.vy, ax: k.ax, ay: k.ay,
          speed: e.speed, heading: e.heading, acceleration: e.acceleration,
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
        changeGrid: [],
        state: confirmedEvidence.length > 0 ? "alert" : "monitoring",
        fps: 0,
        detectionCount: detections.length,
      } satisfies WorkerOutput);
      break;
    }

    case "SET_THRESHOLDS": {
      // Thresholds are now built into the mode config
      break;
    }

    case "SET_MODE": {
      envMode = msg.envMode;
      // Clear confirmation buffer when mode changes
      confirmBuffer.clear();
      console.log(`[Worker] Mode set to: ${envMode}`);
      break;
    }

    case "STOP": {
      tracker.reset();
      frameMemory.clear();
      confirmBuffer.clear();
      frameCount = 0;
      break;
    }
  }
};

self.postMessage({ type: "READY" } satisfies WorkerOutput);

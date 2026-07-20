/**
 * Detection Web Worker v5 — COCO-SSD + MoveNet pose + Kalman tracking.
 * Detects objects, tracks them, estimates poses, and finds accidents.
 */

import { loadModel, detect as onnxDetect, toPixelDetections, type Detection } from "../detection/onnx-engine";
import { loadCocoModel, detectWithCoco, toPixelDetections as cocoToPixel } from "../detection/coco-engine";
import { MultiObjectTracker, type TrackedEntity } from "../detection/kalman-tracker";
import { FrameMemory } from "../detection/frame-memory";
import { detectAccidents, type AccidentEvidence, type EnvMode } from "../detection/ttc-engine";
import type { WorkerOutput, SerializedSkeleton } from "./message-types";

// MoveNet loading (dynamic import to avoid bundling issues)
let poseDetector: any = null;
let poseReady = false;

async function loadPoseModel() {
  try {
    const tf = await import("@tensorflow/tfjs");
    const poseDetection = await import("@tensorflow-models/pose-detection");
    await tf.ready();
    poseDetector = await poseDetection.createDetector(
      poseDetection.SupportedModels.MoveNet,
      { modelType: poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING, enableSmoothing: true }
    );
    poseReady = true;
    console.log("[Worker] MoveNet pose model loaded");
  } catch (err: any) {
    console.warn("[Worker] MoveNet failed:", err.message);
    poseReady = false;
  }
}

function analyzeKeypoints(keypoints: any[]): {
  bodyAngle: number; isUpright: boolean; isFallen: boolean; isSitting: boolean;
} {
  const nose = keypoints[0];
  const ls = keypoints[5], rs = keypoints[6]; // shoulders
  const lh = keypoints[11], rh = keypoints[12]; // hips
  const lk = keypoints[13], rk = keypoints[14]; // knees

  const shoulderY = (ls.y + rs.y) / 2;
  const hipY = (lh.y + rh.y) / 2;
  const kneeY = (lk.y + rk.y) / 2;

  const shoulderX = (ls.x + rs.x) / 2;
  const hipX = (lh.x + rh.x) / 2;

  // Body angle relative to vertical
  const dx = shoulderX - hipX;
  const dy = shoulderY - hipY;
  const bodyAngle = Math.abs(Math.atan2(dx, -dy) * 180 / Math.PI);

  const headAboveHips = nose.y < hipY;
  const isUpright = bodyAngle < 30 && headAboveHips;
  const isFallen = bodyAngle > 50 || (!headAboveHips && nose.y > kneeY);
  const isSitting = !isUpright && !isFallen && hipY > kneeY * 0.8;

  return { bodyAngle, isUpright, isFallen, isSitting };
}

async function detectPoses(imageData: ImageData): Promise<SerializedSkeleton[]> {
  if (!poseDetector || !poseReady) return [];

  try {
    const canvas = new OffscreenCanvas(imageData.width, imageData.height);
    const ctx = canvas.getContext("2d")!;
    ctx.putImageData(imageData, 0, 0);
    const bitmap = await createImageBitmap(canvas);
    const poses = await poseDetector.estimatePoses(bitmap as any);
    bitmap.close();

    const results: SerializedSkeleton[] = [];
    for (let i = 0; i < poses.length; i++) {
      const pose = poses[i];
      const kps = pose.keypoints.map((kp: any) => ({
        x: kp.x / imageData.width,
        y: kp.y / imageData.height,
        score: kp.score,
        name: ["nose","left_eye","right_eye","left_ear","right_ear","left_shoulder","right_shoulder","left_elbow","right_elbow","left_wrist","right_wrist","left_hip","right_hip","left_knee","right_knee","left_ankle","right_ankle"][kp.index] || `kp${kp.index}`,
      }));

      const avgScore = kps.reduce((s: number, k: any) => s + k.score, 0) / kps.length;
      if (avgScore < 0.25) continue;

      const analysis = analyzeKeypoints(kps);
      const validKps = kps.filter((k: any) => k.score > 0.3);
      if (validKps.length < 4) continue;

      const xs = validKps.map((k: any) => k.x);
      const ys = validKps.map((k: any) => k.y);
      const x1 = Math.min(...xs), y1 = Math.min(...ys);
      const x2 = Math.max(...xs), y2 = Math.max(...ys);

      results.push({
        id: i,
        keypoints: kps,
        bodyAngle: analysis.bodyAngle,
        isUpright: analysis.isUpright,
        isFallen: analysis.isFallen,
        isSitting: analysis.isSitting,
        confidence: avgScore,
        bbox: [x1, y1, x2, y2],
      });
    }
    return results;
  } catch {
    return [];
  }
}

// ── Worker state ──
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

function updatePPM(mode: EnvMode) {
  const lanes = { isolated: 2, traffic: 3, marketplace: 1 };
  const roadMeters = lanes[mode] * 3.5;
  pixelsPerMeter = Math.max(8, Math.min(35, (320 * 0.35) / roadMeters));
}

function getModeThreshold(mode: EnvMode): number {
  return mode === "isolated" ? 0.35 : mode === "traffic" ? 0.60 : 0.50;
}
function getRequiredFrames(mode: EnvMode): number {
  return mode === "isolated" ? 2 : mode === "traffic" ? 4 : 3;
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

// ── Message handler ──
self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;

  switch (msg.type) {
    case "INIT": {
      // Load object detection
      try {
        await loadModel(msg.modelPath || "/models/best.onnx");
        modelLoaded = true;
      } catch {
        modelLoaded = false;
        try { await loadCocoModel(); cocoLoaded = true; } catch { cocoLoaded = false; }
      }
      // Load pose detection in parallel (non-blocking)
      loadPoseModel();

      if (msg.envMode) { envMode = msg.envMode; updatePPM(envMode); }
      const backend = modelLoaded ? "onnx" : cocoLoaded ? "coco-ssd" : "demo";
      console.log(`[Worker] Backend: ${backend}, Pose: loading...`);
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

      // Object detection
      let detections: Detection[] = [];
      if (modelLoaded) { try { detections = await onnxDetect(imageData); } catch {} }
      else if (cocoLoaded) { try { detections = await detectWithCoco(imageData); } catch {} }

      const pixelDets = modelLoaded
        ? toPixelDetections(detections, imageData.width, imageData.height)
        : cocoToPixel(detections, imageData.width, imageData.height);

      // Kalman tracking
      const entities = tracker.update(pixelDets, frameNumber);
      const validEntities = entities.filter(e => e.age >= 1);

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

      // Pose detection (runs every frame, non-blocking)
      let skeletons: SerializedSkeleton[] = [];
      try { skeletons = await detectPoses(imageData); } catch {}

      // Use skeleton data to enhance person entities
      for (const entity of validEntities) {
        if (entity.class !== "person") continue;
        // Find the nearest skeleton to this person entity
        const ex = entity.kalman.getState().x / imageData.width;
        const ey = entity.kalman.getState().y / imageData.height;
        let bestSkeleton: SerializedSkeleton | null = null;
        let bestDist = 0.15; // max matching distance (normalized)
        for (const sk of skeletons) {
          const skX = (sk.bbox[0] + sk.bbox[2]) / 2;
          const skY = (sk.bbox[1] + sk.bbox[3]) / 2;
          const d = Math.sqrt((ex - skX) ** 2 + (ey - skY) ** 2);
          if (d < bestDist) { bestDist = d; bestSkeleton = sk; }
        }
        if (bestSkeleton) {
          // Attach pose data to entity for TTC engine
          (entity as any).skeleton = bestSkeleton;
          (entity as any).bodyAngle = bestSkeleton.bodyAngle;
          (entity as any).isFallen = bestSkeleton.isFallen;
        }
      }

      const changeGrid = computeChangeGrid(imageData);

      // Detection pipeline
      const rawEvidence = detectAccidents(validEntities, envMode);

      const confirmedEvidence: AccidentEvidence[] = [];
      for (const ev of rawEvidence) {
        if (checkConfirmation(ev, frameNumber)) confirmedEvidence.push(ev);
      }
      cleanConfirmBuffer(frameNumber);

      // Serialize
      const serializedEntities = validEntities.map(e => {
        const k = e.kalman.getState();
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
        skeletons,
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
      prevFrameData = null;
      frameCount = 0;
      break;
    }
  }
};

self.postMessage({ type: "READY" } satisfies WorkerOutput);

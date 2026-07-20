/**
 * Detection Web Worker — runs ONNX inference + Kalman tracking + collision detection.
 * Receives ImageBitmap frames from main thread, posts results back.
 */

import { loadModel, detect as onnxDetect, toPixelDetections, type Detection } from "../detection/onnx-engine";
import { MultiObjectTracker, type TrackedEntity } from "../detection/kalman-tracker";
import { FrameMemory } from "../detection/frame-memory";
import type { WorkerOutput } from "./message-types";

let tracker = new MultiObjectTracker();
let frameMemory = new FrameMemory();
let frameCount = 0;
let modelLoaded = false;
let demoMode = false;

// Thresholds (configurable from debug page via localStorage)
let iouThreshold = 0.2;
let speedDropPct = 0.40;
let fallConfThreshold = 0.6;

// Offscreen canvas for bitmap → ImageData conversion
let offscreen: OffscreenCanvas | null = null;
let offCtx: OffscreenCanvasRenderingContext2D | null = null;

// ── Demo mode: synthetic detections for pipeline testing ──
function generateDemoDetections(frame: number, width: number, height: number): Detection[] {
  const t = frame * 0.05;
  const dets: Detection[] = [];

  // Vehicle moving left-to-right across the road
  const carX = 0.1 + ((t * 0.02) % 0.8);
  const carY = 0.45 + Math.sin(t * 0.3) * 0.03;
  const carW = 0.07, carH = 0.05;
  dets.push({
    bbox: [carX - carW/2, carY - carH/2, carX + carW/2, carY + carH/2],
    class: "car", classId: 1, confidence: 0.82 + Math.random() * 0.1,
    cx: carX, cy: carY, width: carW, height: carH,
  });

  // Person standing near the right side of the road
  const personX = 0.68 + Math.sin(t * 0.08) * 0.015;
  const personY = 0.55;
  const personW = 0.025, personH = 0.07;
  dets.push({
    bbox: [personX - personW/2, personY - personH/2, personX + personW/2, personY + personH/2],
    class: "person", classId: 0, confidence: 0.75 + Math.random() * 0.1,
    cx: personX, cy: personY, width: personW, height: personH,
  });

  // Motorcycle approaching from the right
  const motoX = 0.85 - ((t * 0.015) % 0.5);
  const motoY = 0.42;
  const motoW = 0.035, motoH = 0.045;
  dets.push({
    bbox: [motoX - motoW/2, motoY - motoH/2, motoX + motoW/2, motoY + motoH/2],
    class: "motorcycle", classId: 2, confidence: 0.7 + Math.random() * 0.1,
    cx: motoX, cy: motoY, width: motoW, height: motoH,
  });

  return dets;
}

// ── IoU ──
function calcIoU(ax: number, ay: number, aw: number, ah: number, bx: number, by: number, bw: number, bh: number): number {
  const ix1 = Math.max(ax - aw / 2, bx - bw / 2), iy1 = Math.max(ay - ah / 2, by - bh / 2);
  const ix2 = Math.min(ax + aw / 2, bx + bw / 2), iy2 = Math.min(ay + ah / 2, by + bh / 2);
  const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
  return inter / (aw * ah + bw * bh - inter + 1e-6);
}

// ── Collision detection ──
interface CollisionEvidence { type: "collision" | "person_fall"; confidence: number; objects: number[]; details: string }

function detectCollisions(entities: TrackedEntity[]): CollisionEvidence[] {
  const evidence: CollisionEvidence[] = [];
  const vehicles = entities.filter(e => e.age >= 3 && ["car", "truck", "bus", "motorcycle"].includes(e.class));
  const people = entities.filter(e => e.age >= 3 && e.class === "person");
  const all = [...vehicles, ...people];

  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i], b = all[j];
      if (a.class === "person" && b.class === "person") continue;

      const iou = calcIoU(a.kalman.getState().x, a.kalman.getState().y, a.w, a.h, b.kalman.getState().x, b.kalman.getState().y, b.w, b.h);
      if (iou < iouThreshold) continue;

      let aDropped = false, bDropped = false;
      if (a.speedHistory.length >= 8) {
        const recent = a.speedHistory.slice(0, 5).reduce((s, v) => s + v, 0) / 5;
        const older = a.speedHistory.slice(5, 10).reduce((s, v) => s + v, 0) / Math.min(5, a.speedHistory.length - 5);
        if (older > 0.5 && recent < older * (1 - speedDropPct)) aDropped = true;
      }
      if (b.speedHistory.length >= 8) {
        const recent = b.speedHistory.slice(0, 5).reduce((s, v) => s + v, 0) / 5;
        const older = b.speedHistory.slice(5, 10).reduce((s, v) => s + v, 0) / Math.min(5, b.speedHistory.length - 5);
        if (older > 0.5 && recent < older * (1 - speedDropPct)) bDropped = true;
      }
      if (!aDropped && !bDropped) continue;

      // Reject parked vehicles (overlapping > 1 second)
      if (a.positions.length > 30 && b.positions.length > 30) {
        const oldA = a.positions[a.positions.length - 30], oldB = b.positions[b.positions.length - 30];
        if (calcIoU(oldA.x, oldA.y, a.w, a.h, oldB.x, oldB.y, b.w, b.h) > iouThreshold * 0.8) continue;
      }

      const confidence = Math.min(0.95, 0.5 * iou + 0.3 * (aDropped ? 1 : 0.5) + 0.3 * (bDropped ? 1 : 0.5));
      evidence.push({ type: "collision", confidence, objects: [a.id, b.id], details: `IoU=${iou.toFixed(2)} a=${aDropped} b=${bDropped}` });
    }
  }

  // fallen_person class
  for (const e of entities.filter(e => e.class === "fallen_person" && e.confidence >= fallConfThreshold && e.age >= 3)) {
    evidence.push({ type: "person_fall", confidence: Math.min(0.9, e.confidence), objects: [e.id], details: `fallen conf=${e.confidence.toFixed(2)}` });
  }

  // Person aspect ratio flip (was standing → now lying)
  for (const e of people) {
    if (e.age < 5 || e.aspectHistory.length < 5) continue;
    const oldAR = e.aspectHistory.slice(0, 3).reduce((s, v) => s + v, 0) / 3;
    const curAR = e.aspectHistory[e.aspectHistory.length - 1];
    if (oldAR < 0.6 && curAR > 0.9) {
      const wasMoving = e.speedHistory.slice(0, 5).some(s => s > 0.8);
      if (wasMoving && e.speed < 0.3) {
        evidence.push({ type: "person_fall", confidence: 0.8, objects: [e.id], details: `AR flip ${oldAR.toFixed(2)}→${curAR.toFixed(2)}` });
      }
    }
  }

  evidence.sort((a, b) => b.confidence - a.confidence);
  return evidence;
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
        // Demo mode: generate synthetic detections for testing the pipeline
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

      // Collision detection
      const evidence = detectCollisions(validEntities);

      // Serialize and post back
      const serializedEntities = validEntities.map(e => {
        const k = e.kalman.getState();
        return {
          id: e.id, class: e.class, confidence: e.confidence,
          x: k.x, y: k.y, vx: k.vx, vy: k.vy, ax: k.ax, ay: k.ay,
          speed: e.speed, heading: e.heading, acceleration: e.acceleration,
          w: e.w, h: e.h, age: e.age,
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
        evidence: evidence.map(ev => ({ type: ev.type, confidence: ev.confidence, objects: [...ev.objects], details: ev.details })),
        changeGrid: [],
        state: evidence.length > 0 ? "alert" : "monitoring",
        fps: 0,
        detectionCount: detections.length,
      } satisfies WorkerOutput);
      break;
    }

    case "SET_THRESHOLDS": {
      if (msg.iouThreshold !== undefined) iouThreshold = msg.iouThreshold;
      if (msg.speedDropPct !== undefined) speedDropPct = msg.speedDropPct;
      if (msg.fallConfThreshold !== undefined) fallConfThreshold = msg.fallConfThreshold;
      break;
    }

    case "SET_MODE": {
      break;
    }

    case "STOP": {
      tracker.reset();
      frameMemory.clear();
      frameCount = 0;
      break;
    }
  }
};

self.postMessage({ type: "READY" } satisfies WorkerOutput);

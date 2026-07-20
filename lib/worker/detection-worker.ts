// Detection Web Worker - handles tracking and collision detection ONLY
// TF.js COCO-SSD runs on main thread (needs DOM), results sent here for processing

import { MultiObjectTracker, TrackedEntity } from "../detection/kalman-tracker";
import { detectAccidents, AccidentEvidence } from "../detection/ttc-engine";
import { autoCalibrate, calculateRealSpeed, perspectiveCorrectedSpeed } from "../detection/speed-estimator";
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

function serializeEntity(e: TrackedEntity): SerializedEntity {
  const k = e.kalman.getState();
  const { current: speedKmh } = calculateRealSpeed(e, pixelsPerMeter);
  const corrected = perspectiveCorrectedSpeed(speedKmh, k.y, 480);
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

// Message handler - receives detection results from main thread
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
      // Receive pre-processed detections from main thread's TF.js COCO-SSD
      const detections = msg.detections as { class: string; cx: number; cy: number; w: number; h: number; confidence: number }[];
      const frameNumber = msg.frame || 0;
      const changeGridData = msg.changeGrid as number[] | undefined;

      frameCount++;

      // Kalman tracking
      const entities = tracker.update(detections, frameNumber);
      const validEntities = entities.filter(e => e.age >= 1);

      // Change detection grid
      let changeGrid = changeGridData || Array.from(accumGrid);

      // Collision detection
      if (cooldown > 0) cooldown--;
      const evidence = detectAccidents(validEntities, [], envMode);

      // State machine
      const hasCollision = evidence.length > 0;
      if (hasCollision) consecutiveAnomaly++;
      else consecutiveAnomaly = 0;

      let newState = state;
      if (hasCollision && consecutiveAnomaly >= 2) {
        newState = "alert";
      } else if (!hasCollision) {
        newState = "monitoring";
      }

      if (newState === "alert" && state !== "alert" && cooldown <= 0) {
        cooldown = 300; // 10 seconds
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

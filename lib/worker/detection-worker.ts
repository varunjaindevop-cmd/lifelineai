// Detection Web Worker
// Runs YOLO inference, Kalman tracking, TTC collision detection, and change detection
// ALL heavy computation happens here, off the main thread

import { initYOLO, detectWithYOLO, disposeYOLO, isYOLOReady } from "../detection/yolo-engine";
import { MultiObjectTracker, TrackedEntity } from "../detection/kalman-tracker";
import { detectAccidents, AccidentEvidence } from "../detection/ttc-engine";
import { autoCalibrate } from "../detection/speed-estimator";
import type { EnvMode, WorkerInput, WorkerOutput, SerializedEntity, SerializedEvidence } from "./message-types";

// Worker state
let tracker = new MultiObjectTracker();
let envMode: EnvMode = "isolated";
let pixelsPerMeter = 20;
let frameCount = 0;
let lastDetectTime = 0;
let consecutiveAnomaly = 0;
let cooldown = 0;
let state = "monitoring";
let lastFrameTime = performance.now();

// Change detection state
const GRID_COLS = 10;
const GRID_ROWS = 8;
const prevGrid = new Float32Array(GRID_COLS * GRID_ROWS);
const accumGrid = new Float32Array(GRID_COLS * GRID_ROWS);

// Serialize entity for postMessage (strips Kalman object)
function serializeEntity(e: TrackedEntity): SerializedEntity {
  const kState = e.kalman.getState();
  return {
    id: e.id,
    class: e.class,
    confidence: e.confidence,
    x: kState.x,
    y: kState.y,
    vx: kState.vx,
    vy: kState.vy,
    ax: kState.ax,
    ay: kState.ay,
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

function serializeEvidence(e: AccidentEvidence): SerializedEvidence {
  return {
    type: e.type,
    confidence: e.confidence,
    objects: [...e.objects],
    details: e.details,
  };
}

// Compute change detection grid from ImageBitmap
function computeChangeGrid(bitmap: ImageBitmap): Float32Array {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  const imgData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  const data = imgData.data;

  const grid = new Float32Array(GRID_COLS * GRID_ROWS);
  const cw = Math.floor(bitmap.width / GRID_COLS);
  const ch = Math.floor(bitmap.height / GRID_ROWS);

  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      let sum = 0, count = 0;
      for (let dy = 0; dy < ch; dy += 4) {
        for (let dx = 0; dx < cw; dx += 4) {
          const i = ((r * ch + dy) * bitmap.width + (c * cw + dx)) * 4;
          sum += data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
          count++;
        }
      }
      grid[r * GRID_COLS + c] = count > 0 ? sum / count : 128;
    }
  }
  return grid;
}

// Process a frame end-to-end
async function processFrame(bitmap: ImageBitmap, frameNumber: number) {
  const now = performance.now();
  const dt = now - lastFrameTime;
  lastFrameTime = now;
  const fps = dt > 0 ? 1000 / dt : 0;

  try {
    // 1. YOLO inference
    const detections = await detectWithYOLO(bitmap, {
      confidenceThreshold: 0.25,
      nmsThreshold: 0.45,
    });

    // 2. Kalman tracking
    const detForTracker = detections.map(d => ({
      class: d.className,
      cx: d.cx,
      cy: d.cy,
      w: d.width,
      h: d.height,
      confidence: d.confidence,
    }));

    const entities = tracker.update(detForTracker, frameNumber);
    const validEntities = entities.filter(e => e.age >= 1);

    // 3. Change detection (every 500ms)
    let changeGrid = Array.from(accumGrid);
    if (frameNumber % 15 === 0) { // ~every 500ms at 30fps
      const newGrid = computeChangeGrid(bitmap);
      for (let i = 0; i < GRID_COLS * GRID_ROWS; i++) {
        const prev = prevGrid[i];
        const diff = prev ? Math.abs(newGrid[i] - prev) / 255 : 0;
        accumGrid[i] = accumGrid[i] * 0.95 + diff * 3;
        prevGrid[i] = newGrid[i];
      }
      changeGrid = Array.from(accumGrid);
    }

    // 4. Collision detection
    if (cooldown > 0) cooldown--;

    const evidence = detectAccidents(validEntities, [], envMode);

    // 5. State machine
    const hasCollision = evidence.length > 0;
    if (hasCollision) consecutiveAnomaly++;
    else consecutiveAnomaly = 0;

    let newState = state;
    if (hasCollision && consecutiveAnomaly >= 4) {
      newState = "alert";
    } else if (!hasCollision) {
      newState = "monitoring";
    }

    if (newState === "alert" && state !== "alert" && cooldown <= 0) {
      cooldown = 300; // 10 seconds at 30fps - long cooldown to prevent false alerts
      consecutiveAnomaly = 0;
    }

    state = newState;

    // 6. Send results back (transferable data only, no Kalman objects)
    const msg: WorkerOutput = {
      type: "RESULTS",
      frame: frameNumber,
      entities: validEntities.map(serializeEntity),
      evidence: evidence.map(serializeEvidence),
      changeGrid,
      state,
      fps: Math.round(fps),
      detectionCount: detections.length,
    };

    self.postMessage(msg);
  } catch (err) {
    self.postMessage({
      type: "ERROR",
      message: err instanceof Error ? err.message : String(err),
    } satisfies WorkerOutput);
  } finally {
    bitmap.close();
  }
}

// Handle messages from main thread
self.onmessage = async (e: MessageEvent<WorkerInput>) => {
  const msg = e.data;

  switch (msg.type) {
    case "INIT": {
      try {
        envMode = msg.envMode || "isolated";
        pixelsPerMeter = autoCalibrate(640, 480, envMode);

        if (!isYOLOReady()) {
          await initYOLO({ modelPath: msg.modelPath });
        }

        self.postMessage({ type: "MODEL_LOADED", backend: "onnx" } satisfies WorkerOutput);
      } catch (err) {
        self.postMessage({
          type: "MODEL_ERROR",
          error: err instanceof Error ? err.message : String(err),
        } satisfies WorkerOutput);
      }
      break;
    }

    case "FRAME": {
      frameCount++;
      await processFrame(msg.bitmap, msg.frameNumber || frameCount);
      break;
    }

    case "SET_MODE": {
      envMode = msg.envMode;
      pixelsPerMeter = autoCalibrate(640, 480, envMode);
      break;
    }

    case "SET_PPM": {
      pixelsPerMeter = msg.pixelsPerMeter;
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

    case "DISPOSE": {
      disposeYOLO();
      self.postMessage({ type: "READY" } satisfies WorkerOutput);
      break;
    }
  }
};

// Signal that worker is ready
self.postMessage({ type: "READY" } satisfies WorkerOutput);

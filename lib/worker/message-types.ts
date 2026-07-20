// Message types for detection Web Worker communication

export type EnvMode = "isolated" | "traffic" | "marketplace";

// Messages FROM main thread TO worker
export type WorkerInput =
  | { type: "INIT"; modelPath?: string; envMode?: EnvMode }
  | { type: "FRAME"; bitmap: ImageBitmap; frameNumber: number }
  | { type: "SET_MODE"; envMode: EnvMode }
  | { type: "SET_PPM"; pixelsPerMeter: number }
  | {
      type: "SET_THRESHOLDS";
      iouThreshold?: number;
      speedDropPct?: number;
      fallConfThreshold?: number;
      confirmDurationMs?: number;
      alertDurationMs?: number;
      cooldownMs?: number;
    }
  | { type: "STOP" }
  | { type: "DISPOSE" };

// Messages FROM worker TO main thread
export type WorkerOutput =
  | { type: "READY" }
  | { type: "MODEL_LOADED"; backend: string }
  | { type: "MODEL_ERROR"; error: string }
  | {
      type: "RESULTS";
      frame: number;
      entities: SerializedEntity[];
      evidence: SerializedEvidence[];
      changeGrid: number[];
      state: string;
      fps: number;
      detectionCount: number;
      sceneContext?: EnvMode;
    }
  | { type: "ERROR"; message: string };

// Serializable entity for postMessage (no circular refs from Kalman)
export interface SerializedEntity {
  id: number;
  class: string;
  confidence: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  ax: number;
  ay: number;
  speed: number; // km/h (converted from pixel speed in worker)
  heading: number;
  acceleration: number;
  w: number;
  h: number;
  age: number;
  confirmedFrames: number;
  positions: { x: number; y: number }[];
  speedHistory: number[];
  headingHistory: number[];
  aspectHistory: number[];
}

export interface SerializedEvidence {
  type: "collision" | "person_fall" | "bike_off_track" | "vehicle_fall" | "bike_crash" | "person_ejected";
  confidence: number;
  objects: number[];
  details: string;
  signals: { name: string; value: number; weight: number; passed: boolean }[];
  sceneContext: EnvMode;
}

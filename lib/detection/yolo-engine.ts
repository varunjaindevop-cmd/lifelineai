// YOLOv8n ONNX Runtime inference engine
// Runs object detection via ONNX Runtime Web (WASM/WebGL backend)

import { YOLODetection, postprocess } from "./yolo-postprocess";

export interface YOLOEngineOptions {
  modelPath?: string;
  confidenceThreshold?: number;
  inputSize?: number;
}

let ortSession: any = null;
let ortModule: any = null;

/**
 * Initialize ONNX Runtime and load YOLOv8n model
 */
export async function initYOLO(options: YOLOEngineOptions = {}): Promise<void> {
  const {
    modelPath = "/models/yolov8n.onnx",
  } = options;

  if (!ortModule) {
    ortModule = await import("onnxruntime-web");
  }

  // Prefer WebGL for GPU acceleration, fallback to WASM
  const backendHints: Array<"webgl" | "wasm"> = ["webgl", "wasm"];
  let sessionCreated = false;

  for (const backend of backendHints) {
    try {
      ortSession = await ortModule.InferenceSession.create(modelPath, {
        executionProviders: [backend],
        graphOptimizationLevel: "all",
      });
      console.log(`[SAGE/YOLO] Model loaded with ${backend} backend`);
      sessionCreated = true;
      break;
    } catch (err) {
      console.warn(`[SAGE/YOLO] ${backend} backend failed, trying next...`, err);
    }
  }

  if (!sessionCreated || !ortSession) {
    throw new Error("Failed to load YOLO model with any backend");
  }
}

/**
 * Preprocess ImageBitmap for YOLO inference
 * Returns normalized Float32Array in NCHW format [1, 3, 640, 640]
 */
export function preprocessForYOLO(
  imageBitmap: ImageBitmap | HTMLCanvasElement | HTMLVideoElement,
  inputSize: number = 640
): { tensor: Float32Array; origWidth: number; origHeight: number } {
  const origWidth = imageBitmap.width;
  const origHeight = imageBitmap.height;

  // Create offscreen canvas for preprocessing
  const canvas = new OffscreenCanvas(inputSize, inputSize);
  const ctx = canvas.getContext("2d")!;

  // Fill with gray (114) for letterbox padding
  ctx.fillStyle = "#707070";
  ctx.fillRect(0, 0, inputSize, inputSize);

  // Calculate letterbox dimensions
  const scale = Math.min(inputSize / origWidth, inputSize / origHeight);
  const newWidth = Math.round(origWidth * scale);
  const newHeight = Math.round(origHeight * scale);
  const padX = (inputSize - newWidth) / 2;
  const padY = (inputSize - newHeight) / 2;

  // Draw image centered with padding
  ctx.drawImage(imageBitmap, padX, padY, newWidth, newHeight);

  // Get pixel data
  const imageData = ctx.getImageData(0, 0, inputSize, inputSize);
  const pixels = imageData.data;

  // Convert to Float32 NCHW format with normalization [0, 1]
  // YOLOv8 expects RGB, letterbox padding is 114
  const tensor = new Float32Array(3 * inputSize * inputSize);
  const pixelCount = inputSize * inputSize;

  for (let i = 0; i < pixelCount; i++) {
    const srcIdx = i * 4;
    // Normalize to [0, 1] and convert RGBA -> RGB channels in NCHW layout
    tensor[i] = pixels[srcIdx] / 255.0;                      // R -> channel 0
    tensor[pixelCount + i] = pixels[srcIdx + 1] / 255.0;     // G -> channel 1
    tensor[2 * pixelCount + i] = pixels[srcIdx + 2] / 255.0; // B -> channel 2
  }

  return { tensor, origWidth, origHeight };
}

/**
 * Run YOLOv8n inference on an image source
 */
export async function detectWithYOLO(
  imageSource: ImageBitmap | HTMLCanvasElement | HTMLVideoElement,
  options: {
    confidenceThreshold?: number;
    nmsThreshold?: number;
    inputSize?: number;
  } = {}
): Promise<YOLODetection[]> {
  if (!ortSession) {
    throw new Error("YOLO model not initialized. Call initYOLO() first.");
  }

  const {
    confidenceThreshold = 0.25,
    nmsThreshold = 0.45,
    inputSize = 640,
  } = options;

  // Preprocess
  const { tensor, origWidth, origHeight } = preprocessForYOLO(imageSource, inputSize);

  // Create ONNX tensor [1, 3, 640, 640]
  const inputTensor = new ortModule.Tensor("float32", tensor, [1, 3, inputSize, inputSize]);

  // Run inference
  const inputName = ortSession.inputNames[0];
  const results = await ortSession.run({ [inputName]: inputTensor });

  // Get output tensor
  const outputName = ortSession.outputNames[0];
  const outputTensor = results[outputName];
  const outputData = outputTensor.data as Float32Array;

  // Post-process
  return postprocess(outputData, origWidth, origHeight, {
    confidenceThreshold,
    nmsThreshold,
  });
}

/**
 * Check if YOLO model is loaded and ready
 */
export function isYOLOReady(): boolean {
  return ortSession !== null;
}

/**
 * Dispose of the ONNX session to free memory
 */
export function disposeYOLO(): void {
  if (ortSession) {
    ortSession.release?.();
    ortSession = null;
  }
}

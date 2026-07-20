/**
 * DEPRECATED — replaced by onnx-engine.ts.
 *
 * This file previously used TensorFlow.js COCO-SSD for object detection.
 * The project now uses a custom YOLOv8n ONNX model via onnxruntime-web.
 *
 * See: lib/detection/onnx-engine.ts
 */

export { loadModel as initDetection, detect as detectObjects, isModelReady as isDetectionReady } from "./onnx-engine";
export type { Detection } from "./onnx-engine";

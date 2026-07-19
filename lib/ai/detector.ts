import { Detection, TrackedObject, AnomalyResult, QualityMetrics } from "./types";
import { analyzeQuality, getAdaptiveConfig, preprocessImage, applyCLAHE, denoise, sharpen } from "../detection/preprocess";
import { trackObjects, createNewObjects } from "./object-tracker";
import { detectAnomalies, estimateSceneContext, SceneContext } from "./anomaly-rules";
import { DetectionStateMachine, getSeverity } from "./state-machine";

export class AccidentDetector {
  private trackedObjects: TrackedObject[] = [];
  private stateMachine: DetectionStateMachine;
  private previousFrame: ImageData | null = null;
  private quality: QualityMetrics | null = null;
  private adaptiveConfig: ReturnType<typeof getAdaptiveConfig> | null = null;
  private frameCount: number = 0;
  private pixelsPerMeter: number = 50;
  private fps: number = 5;

  constructor(pixelsPerMeter?: number, fps?: number) {
    this.stateMachine = new DetectionStateMachine();
    if (pixelsPerMeter) this.pixelsPerMeter = pixelsPerMeter;
    if (fps) this.fps = fps;
  }

  // Process a single frame and return results
  processFrame(imageData: ImageData): {
    detections: Detection[];
    trackedObjects: TrackedObject[];
    quality: QualityMetrics | null;
    adaptiveConfig: ReturnType<typeof getAdaptiveConfig> | null;
    state: string;
    alert: { triggered: boolean; type: string | null; confidence: number; severity: string } | null;
    sceneChangeScore: number;
  } {
    this.frameCount++;

    // Analyze quality
    this.quality = analyzeQuality(imageData);
    this.adaptiveConfig = getAdaptiveConfig(this.quality);

    // Preprocess image
    let processed = imageData;
    if (this.adaptiveConfig.enableCLAHE) {
      processed = applyCLAHE(processed);
    }
    if (this.adaptiveConfig.enableDenoise) {
      processed = denoise(processed);
    }
    if (this.adaptiveConfig.enableSharpen) {
      processed = sharpen(processed);
    }

    // Calculate scene change score
    let sceneChangeScore = 0;
    if (this.previousFrame) {
      sceneChangeScore = this.calculateSceneChange(this.previousFrame, processed);
    }
    this.previousFrame = processed;

    // Detect objects (simplified for demo - in production use YOLO ONNX)
    const detections = this.detectObjects(processed);

    // Track objects across frames
    const { tracked, unmatched } = trackObjects(detections, this.trackedObjects);
    this.trackedObjects = createNewObjects(unmatched, tracked);

    // Calculate speeds for vehicles
    for (const obj of this.trackedObjects) {
      if (obj.class === "car" || obj.class === "truck" || obj.class === "bus") {
        const lastTwo = obj.trajectory.slice(-2);
        if (lastTwo.length === 2) {
          const dx = lastTwo[1].x - lastTwo[0].x;
          const dy = lastTwo[1].y - lastTwo[0].y;
          const pixelDist = Math.sqrt(dx * dx + dy * dy);
          const metersPerFrame = pixelDist / this.pixelsPerMeter;
          obj.speed = Math.round(metersPerFrame * this.fps * 3.6);
        }
      }
    }

    // Detect anomalies with scene context
    const sceneContext = estimateSceneContext(this.trackedObjects);
    const anomalies = detectAnomalies(this.trackedObjects, sceneChangeScore, sceneContext);
    const topAnomaly = anomalies.length > 0 ? anomalies[0] : null;

    // Process through state machine
    const stateResult = this.stateMachine.processFrame(topAnomaly);

    let alert = null;
    if (stateResult.shouldAlert && stateResult.alertType) {
      alert = {
        triggered: true,
        type: stateResult.alertType,
        confidence: stateResult.confidence,
        severity: getSeverity(stateResult.confidence),
      };
    }

    return {
      detections,
      trackedObjects: this.trackedObjects,
      quality: this.quality,
      adaptiveConfig: this.adaptiveConfig,
      state: stateResult.state,
      alert,
      sceneChangeScore,
    };
  }

  // Simplified object detection (simulated for demo)
  private detectObjects(imageData: ImageData): Detection[] {
    const detections: Detection[] = [];
    const width = imageData.width;
    const height = imageData.height;

    // In production, this would run YOLO ONNX inference
    // For demo, simulate detections with realistic behavior
    const data = imageData.data;

    // Analyze regions for potential objects
    const gridSize = 64;
    for (let y = 0; y < height; y += gridSize) {
      for (let x = 0; x < width; x += gridSize) {
        // Sample region brightness and motion
        let brightness = 0;
        let pixelCount = 0;

        for (let dy = 0; dy < gridSize && y + dy < height; dy++) {
          for (let dx = 0; dx < gridSize && x + dx < width; dx++) {
            const idx = ((y + dy) * width + (x + dx)) * 4;
            brightness += data[idx] * 0.299 + data[idx + 1] * 0.587 + data[idx + 2] * 0.114;
            pixelCount++;
          }
        }
        brightness /= pixelCount;

        // Simulate detection based on brightness patterns
        if (brightness > 80 && brightness < 200 && Math.random() > 0.92) {
          const isPerson = Math.random() > 0.6;
          const confidence = 0.4 + Math.random() * 0.5;
          const bboxSize = isPerson ? 40 + Math.random() * 30 : 60 + Math.random() * 40;

          detections.push({
            class: isPerson ? "person" : "car",
            classId: isPerson ? 0 : 2,
            confidence,
            bbox: [
              x + Math.random() * 20,
              y + Math.random() * 20,
              x + bboxSize,
              y + bboxSize * (isPerson ? 2 : 1),
            ],
            centerX: x + bboxSize / 2,
            centerY: y + bboxSize / 2,
            width: bboxSize,
            height: bboxSize * (isPerson ? 2 : 1),
          });
        }
      }
    }

    return detections;
  }

  // Calculate frame-to-frame change
  private calculateSceneChange(prev: ImageData, curr: ImageData): number {
    let diff = 0;
    const pixels = prev.data.length / 4;
    const step = 16; // Sample every 16th pixel for speed

    for (let i = 0; i < prev.data.length; i += step * 4) {
      const prevGray = prev.data[i] * 0.299 + prev.data[i + 1] * 0.587 + prev.data[i + 2] * 0.114;
      const currGray = curr.data[i] * 0.299 + curr.data[i + 1] * 0.587 + curr.data[i + 2] * 0.114;
      diff += Math.abs(prevGray - currGray);
    }

    return diff / (pixels / step) / 255;
  }

  // Getters
  getQuality(): QualityMetrics | null {
    return this.quality;
  }

  getAdaptiveConfig() {
    return this.adaptiveConfig;
  }

  getState(): string {
    return this.stateMachine.getState();
  }

  reset(): void {
    this.trackedObjects = [];
    this.previousFrame = null;
    this.quality = null;
    this.frameCount = 0;
    this.stateMachine.reset();
  }
}

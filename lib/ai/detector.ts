/**
 * Simplified AccidentDetector — orchestrates the detection pipeline.
 *
 * This is the MAIN-THREAD counterpart to the Web Worker.
 * For the video-based pipeline, this class receives results from the worker
 * and manages state + alert dispatch to Supabase.
 *
 * Deleted: TTC engine, energy analyzer, trajectory predictor, anomaly rules matrix.
 * Kept: FrameMemory (temporal history), simple collision rules, state machine.
 */

import { FrameMemory } from "../detection/frame-memory";
import { DetectionStateMachine, getSeverity } from "./state-machine";
import { createIncident } from "../alerts/alert-service";
import { encodeClip, uploadClip, FrameBuffer } from "../detection/clip-capture";
import { createClient } from "../supabase/client";

export interface Detection {
  class: string;
  classId: number;
  confidence: number;
  bbox: [number, number, number, number];
  cx: number;
  cy: number;
  width: number;
  height: number;
}

export interface TrackedObject {
  id: number;
  class: string;
  confidence: number;
  speed: number;
  heading: number;
  w: number;
  h: number;
  age: number;
  positions: { x: number; y: number }[];
  speedHistory: number[];
}

export interface AlertResult {
  triggered: boolean;
  type: string | null;
  confidence: number;
  severity: string;
}

export interface ProcessFrameResult {
  detections: Detection[];
  trackedObjects: TrackedObject[];
  state: string;
  alert: AlertResult | null;
  evidenceType: string | null;
}

export class AccidentDetector {
  private stateMachine: DetectionStateMachine;
  private frameBuffer: FrameBuffer;
  private frameCount = 0;
  private cameraId: string;
  private latitude: number;
  private longitude: number;

  constructor(cameraId: string, latitude: number, longitude: number) {
    this.cameraId = cameraId;
    this.latitude = latitude;
    this.longitude = longitude;
    this.stateMachine = new DetectionStateMachine();
    this.frameBuffer = new FrameBuffer(5, 15); // 5fps, 15s pre-roll
  }

  /**
   * Process results from the Web Worker.
   * The worker already did ONNX inference + Kalman tracking + collision detection.
   * This method runs the state machine and dispatches alerts.
   */
  processWorkerResults(workerResults: {
    entities: any[];
    evidence: any[];
    state: string;
  }): ProcessFrameResult {
    this.frameCount++;

    const topEvidence = workerResults.evidence.length > 0 ? workerResults.evidence[0] : null;

    // Feed evidence into state machine
    const smResult = this.stateMachine.processFrame(
      topEvidence
        ? { type: topEvidence.type, confidence: topEvidence.confidence }
        : null
    );

    let alert: AlertResult | null = null;
    if (smResult.shouldAlert && smResult.alertType) {
      alert = {
        triggered: true,
        type: smResult.alertType,
        confidence: smResult.confidence,
        severity: getSeverity(smResult.confidence),
      };
    }

    return {
      detections: [],
      trackedObjects: workerResults.entities.map((e: any) => ({
        id: e.id,
        class: e.class,
        confidence: e.confidence,
        speed: e.speed,
        heading: e.heading,
        w: e.w,
        h: e.h,
        age: e.age,
        positions: e.positions || [],
        speedHistory: e.speedHistory || [],
      })),
      state: smResult.state,
      alert,
      evidenceType: topEvidence?.type || null,
    };
  }

  /**
   * Handle a triggered alert — create incident in Supabase and upload clip.
   */
  async handleAlert(
    alert: AlertResult,
    videoElement: HTMLVideoElement
  ): Promise<string | null> {
    if (!alert.triggered || !alert.type) return null;

    // Capture clip from frame buffer
    const preFrames = this.frameBuffer.getPreRollFrames();
    let videoClipUrl: string | undefined;

    if (preFrames.length > 0) {
      const clipBlob = await encodeClip(preFrames, [], 640, 480);
      if (clipBlob) {
        const supabase = createClient();
        const tempId = `clip-${Date.now()}`;
        videoClipUrl = (await uploadClip(supabase, tempId, clipBlob)) || undefined;
      }
    }

    // Create incident
    const incidentId = await createIncident({
      severity: alert.severity,
      incidentType: alert.type,
      latitude: this.latitude,
      longitude: this.longitude,
      cameraId: this.cameraId,
      videoClipUrl,
      detectionConfidence: alert.confidence,
      detectionData: { source: "worker", frame: this.frameCount },
    });

    return incidentId;
  }

  /**
   * Add a frame to the evidence buffer (called from the main thread when
   * capturing frames from a <video> element).
   */
  addFrame(frame: ImageData): void {
    this.frameBuffer.addFrame(frame);
  }

  getState(): string {
    return this.stateMachine.getState();
  }

  reset(): void {
    this.frameCount = 0;
    this.stateMachine.reset();
    this.frameBuffer.clear();
  }

  getFrameBuffer(): FrameBuffer {
    return this.frameBuffer;
  }
}

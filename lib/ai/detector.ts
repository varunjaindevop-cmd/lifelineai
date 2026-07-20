/**
 * Simplified AccidentDetector — wraps the state machine and alert dispatch.
 * The actual detection runs in the Web Worker; this handles main-thread concerns.
 */

import { DetectionStateMachine, getSeverity } from "./state-machine";
import { createIncident } from "../alerts/alert-service";
import { encodeClip, uploadClip, FrameBuffer } from "../detection/clip-capture";
import { createClient } from "../supabase/client";

export interface AlertResult {
  triggered: boolean;
  type: string | null;
  confidence: number;
  severity: string;
}

export class AccidentDetector {
  private stateMachine: DetectionStateMachine;
  private frameBuffer: FrameBuffer;
  private cameraId: string;
  private latitude: number;
  private longitude: number;

  constructor(cameraId: string, latitude: number, longitude: number) {
    this.cameraId = cameraId;
    this.latitude = latitude;
    this.longitude = longitude;
    this.stateMachine = new DetectionStateMachine();
    this.frameBuffer = new FrameBuffer(5, 15);
  }

  processWorkerResults(workerResults: { evidence: any[] }): AlertResult | null {
    const topEvidence = workerResults.evidence.length > 0 ? workerResults.evidence[0] : null;
    const smResult = this.stateMachine.processFrame(
      topEvidence ? { type: topEvidence.type, confidence: topEvidence.confidence } : null
    );

    if (smResult.shouldAlert && smResult.alertType) {
      return {
        triggered: true,
        type: smResult.alertType,
        confidence: smResult.confidence,
        severity: getSeverity(smResult.confidence),
      };
    }
    return null;
  }

  async handleAlert(alert: AlertResult, videoElement: HTMLVideoElement): Promise<string | null> {
    if (!alert.triggered || !alert.type) return null;
    const preFrames = this.frameBuffer.getPreRollFrames();
    let videoClipUrl: string | undefined;
    if (preFrames.length > 0) {
      const clipBlob = await encodeClip(preFrames, [], 640, 480);
      if (clipBlob) {
        const supabase = createClient();
        videoClipUrl = (await uploadClip(supabase, `clip-${Date.now()}`, clipBlob)) || undefined;
      }
    }
    return createIncident({
      severity: alert.severity, incidentType: alert.type,
      latitude: this.latitude, longitude: this.longitude,
      cameraId: this.cameraId, videoClipUrl,
      detectionConfidence: alert.confidence,
      detectionData: { source: "worker" },
    });
  }

  addFrame(frame: ImageData): void { this.frameBuffer.addFrame(frame); }
  getState(): string { return this.stateMachine.getState(); }
  reset(): void { this.stateMachine.reset(); this.frameBuffer.clear(); }
}

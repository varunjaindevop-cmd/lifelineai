/**
 * Simplified Detection State Machine.
 * idle → watching → confirming → alert, then cooldown.
 */

export type DetectionState = "monitoring" | "watching" | "confirming" | "alert";

export interface StateResult {
  state: DetectionState;
  shouldAlert: boolean;
  alertType: string | null;
  confidence: number;
}

export class DetectionStateMachine {
  private state: DetectionState = "monitoring";
  private watchStartTime = 0;
  private confirmStartTime = 0;
  private lastAlertTime = 0;
  private lastEventType: string | null = null;

  private watchThreshold = 0.7;
  private watchDurationMs = 500;
  private confirmDurationMs = 1000;
  private cooldownMs = 5000;

  getState(): DetectionState { return this.state; }

  processFrame(evidence: { type: string; confidence: number } | null): StateResult {
    const now = Date.now();
    const hasEvidence = evidence !== null && evidence.confidence > 0;
    const confidence = evidence?.confidence ?? 0;
    const eventType = evidence?.type ?? null;

    if (now - this.lastAlertTime < this.cooldownMs) {
      return { state: this.state, shouldAlert: false, alertType: null, confidence: 0 };
    }

    switch (this.state) {
      case "monitoring":
        if (hasEvidence && confidence > this.watchThreshold) {
          this.state = "watching";
          this.watchStartTime = now;
          this.lastEventType = eventType;
        }
        break;
      case "watching":
        if (!hasEvidence || confidence < 0.4) { this.state = "monitoring"; }
        else if (now - this.watchStartTime >= this.watchDurationMs) {
          this.state = "confirming";
          this.confirmStartTime = now;
        }
        break;
      case "confirming":
        if (!hasEvidence || confidence < 0.3) { this.state = "monitoring"; }
        else if (now - this.confirmStartTime >= this.confirmDurationMs) {
          this.state = "alert";
          this.lastAlertTime = now;
          return { state: this.state, shouldAlert: true, alertType: this.lastEventType, confidence };
        }
        break;
      case "alert":
        this.state = "monitoring";
        break;
    }

    return { state: this.state, shouldAlert: false, alertType: null, confidence };
  }

  reset(): void { this.state = "monitoring"; this.watchStartTime = 0; this.confirmStartTime = 0; this.lastAlertTime = 0; this.lastEventType = null; }

  setThresholds(opts: { watchThreshold?: number; watchDurationMs?: number; confirmDurationMs?: number; cooldownMs?: number }) {
    if (opts.watchThreshold !== undefined) this.watchThreshold = opts.watchThreshold;
    if (opts.watchDurationMs !== undefined) this.watchDurationMs = opts.watchDurationMs;
    if (opts.confirmDurationMs !== undefined) this.confirmDurationMs = opts.confirmDurationMs;
    if (opts.cooldownMs !== undefined) this.cooldownMs = opts.cooldownMs;
  }
}

export function getSeverity(confidence: number): "critical" | "major" | "minor" | "suspicious" {
  if (confidence > 0.8) return "critical";
  if (confidence > 0.6) return "major";
  if (confidence > 0.4) return "minor";
  return "suspicious";
}

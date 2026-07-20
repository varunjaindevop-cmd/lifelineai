/**
 * Detection State Machine — gates alert generation.
 *
 * States:
 *   monitoring → watching → confirming → alert → (cooldown) → monitoring
 *
 * Thresholds:
 *   monitoring → watching : one event with confidence > 0.7
 *   watching  → confirming: continuous event for 0.5s (real time)
 *   confirming → alert    : continuous evidence for 1 full second
 *   Any state → monitoring: signal lost or confidence drops
 *
 * Cooldown: 5 seconds after alert fires, ignore new events.
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

  // Tunable thresholds
  private watchThreshold = 0.7;
  private watchDurationMs = 500;    // 0.5 seconds
  private confirmDurationMs = 1000; // 1 second
  private cooldownMs = 5000;        // 5 seconds

  getState(): DetectionState {
    return this.state;
  }

  processFrame(
    evidence: { type: string; confidence: number } | null
  ): StateResult {
    const now = Date.now();
    const hasEvidence = evidence !== null && evidence.confidence > 0;
    const confidence = evidence?.confidence ?? 0;
    const eventType = evidence?.type ?? null;

    // Cooldown check
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
        if (!hasEvidence || confidence < 0.4) {
          // Signal lost — back to monitoring
          this.state = "monitoring";
        } else if (now - this.watchStartTime >= this.watchDurationMs) {
          // Held long enough — advance to confirming
          this.state = "confirming";
          this.confirmStartTime = now;
          this.lastEventType = eventType;
        }
        // else: still watching, keep accumulating
        break;

      case "confirming":
        if (!hasEvidence || confidence < 0.3) {
          // Signal lost during confirmation
          this.state = "monitoring";
        } else if (now - this.confirmStartTime >= this.confirmDurationMs) {
          // Full confirmation period elapsed — fire alert
          this.state = "alert";
          this.lastAlertTime = now;
          return {
            state: this.state,
            shouldAlert: true,
            alertType: this.lastEventType,
            confidence,
          };
        }
        // else: still confirming, keep accumulating
        break;

      case "alert":
        // Should not stay in alert — immediately return to monitoring
        this.state = "monitoring";
        break;
    }

    return {
      state: this.state,
      shouldAlert: false,
      alertType: null,
      confidence,
    };
  }

  reset(): void {
    this.state = "monitoring";
    this.watchStartTime = 0;
    this.confirmStartTime = 0;
    this.lastAlertTime = 0;
    this.lastEventType = null;
  }

  /** Override thresholds (e.g. from debug page). */
  setThresholds(opts: {
    watchThreshold?: number;
    watchDurationMs?: number;
    confirmDurationMs?: number;
    cooldownMs?: number;
  }) {
    if (opts.watchThreshold !== undefined) this.watchThreshold = opts.watchThreshold;
    if (opts.watchDurationMs !== undefined) this.watchDurationMs = opts.watchDurationMs;
    if (opts.confirmDurationMs !== undefined) this.confirmDurationMs = opts.confirmDurationMs;
    if (opts.cooldownMs !== undefined) this.cooldownMs = opts.cooldownMs;
  }
}

// Get severity from confidence
export function getSeverity(confidence: number): "critical" | "major" | "minor" | "suspicious" {
  if (confidence > 0.8) return "critical";
  if (confidence > 0.6) return "major";
  if (confidence > 0.4) return "minor";
  return "suspicious";
}

import { DetectionState, AnomalyResult } from "./types";

interface StateTransition {
  from: DetectionState;
  to: DetectionState;
  condition: (anomaly: AnomalyResult | null, frameCount: number) => boolean;
}

const transitions: StateTransition[] = [
  // Monitoring -> Watching: single detection signal
  {
    from: "monitoring",
    to: "watching",
    condition: (anomaly) => anomaly !== null && anomaly.confidence > 0.2,
  },
  // Watching -> Confirming: multiple signals persist
  {
    from: "watching",
    to: "confirming",
    condition: (anomaly) => anomaly !== null && anomaly.confidence > 0.4,
  },
  // Confirming -> Alert: evidence threshold met
  {
    from: "confirming",
    to: "alert",
    condition: (anomaly) => anomaly !== null && anomaly.confidence > 0.6,
  },
  // Watching -> Monitoring: signal decays
  {
    from: "watching",
    to: "monitoring",
    condition: (anomaly) => anomaly === null || anomaly.confidence < 0.15,
  },
  // Confirming -> Watching: signal weakens
  {
    from: "confirming",
    to: "watching",
    condition: (anomaly) => anomaly === null || anomaly.confidence < 0.3,
  },
];

export class DetectionStateMachine {
  private state: DetectionState = "monitoring";
  private frameCount: number = 0;
  private alertCooldown: number = 0;
  private stateStartTime: number = Date.now();

  getState(): DetectionState {
    return this.state;
  }

  getFrameCount(): number {
    return this.frameCount;
  }

  getTimeInState(): number {
    return Date.now() - this.stateStartTime;
  }

  // Process a frame with anomaly detection result
  processFrame(anomaly: AnomalyResult | null): {
    state: DetectionState;
    shouldAlert: boolean;
    alertType: string | null;
    confidence: number;
  } {
    this.frameCount++;

    // Check cooldown
    if (this.alertCooldown > 0) {
      this.alertCooldown--;
      return {
        state: this.state,
        shouldAlert: false,
        alertType: null,
        confidence: 0,
      };
    }

    // Try state transitions
    let transitioned = false;
    for (const transition of transitions) {
      if (this.state === transition.from && transition.condition(anomaly, this.frameCount)) {
        this.state = transition.to;
        this.stateStartTime = Date.now();
        transitioned = true;
        break;
      }
    }

    // Check if we should trigger an alert
    const shouldAlert = this.state === "alert" && transitioned;
    let alertType: string | null = null;
    let confidence = 0;

    if (shouldAlert && anomaly) {
      alertType = anomaly.type;
      confidence = anomaly.confidence;
      // Set cooldown (60 frames = ~12 seconds at 5fps)
      this.alertCooldown = 60;
      // Reset state after alert
      this.state = "monitoring";
      this.stateStartTime = Date.now();
    }

    return {
      state: this.state,
      shouldAlert,
      alertType,
      confidence,
    };
  }

  reset(): void {
    this.state = "monitoring";
    this.frameCount = 0;
    this.alertCooldown = 0;
    this.stateStartTime = Date.now();
  }
}

// Get severity from confidence
export function getSeverity(confidence: number): "critical" | "major" | "minor" | "suspicious" {
  if (confidence > 0.7) return "critical";
  if (confidence > 0.5) return "major";
  if (confidence > 0.3) return "minor";
  return "suspicious";
}

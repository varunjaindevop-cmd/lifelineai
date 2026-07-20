// Frame Memory - Stores detection history for temporal analysis
// Like a human watching CCTV: you remember what happened 5 seconds ago
// and compare it to what's happening now

export interface FrameSnapshot {
  frame: number;
  timestamp: number;
  entities: {
    id: number;
    class: string;
    x: number;
    y: number;
    speed: number;
    heading: number;
  }[];
}

const MAX_HISTORY = 30; // Store last 30 frames (~10 seconds at 3 FPS)

export class FrameMemory {
  private history: FrameSnapshot[] = [];

  addFrame(snapshot: FrameSnapshot): void {
    this.history.push(snapshot);
    if (this.history.length > MAX_HISTORY) {
      this.history.shift();
    }
  }

  /**
   * Get frames from N seconds ago
   */
  getPastFrames(secondsAgo: number, fps: number = 3): FrameSnapshot[] {
    const framesAgo = Math.round(secondsAgo * fps);
    const cutoff = this.history.length - framesAgo;
    if (cutoff <= 0) return [];
    return this.history.slice(0, cutoff);
  }

  /**
   * Get recent frames (last N seconds)
   */
  getRecentFrames(seconds: number = 2, fps: number = 3): FrameSnapshot[] {
    const frameCount = Math.round(seconds * fps);
    return this.history.slice(-frameCount);
  }

  /**
   * Detect if an entity's behavior changed (e.g., was walking, now lying)
   */
  detectBehaviorChange(entityId: number): {
    wasMoving: boolean;
    isMoving: boolean;
    wasUpright: boolean;
    isUpright: boolean;
    changed: boolean;
  } | null {
    if (this.history.length < 5) return null;

    const recent = this.history[this.history.length - 1];
    const past = this.history[Math.max(0, this.history.length - 5)];

    const recentEntity = recent.entities.find(e => e.id === entityId);
    const pastEntity = past.entities.find(e => e.id === entityId);

    if (!recentEntity || !pastEntity) return null;

    const wasMoving = pastEntity.speed > 0.5;
    const isMoving = recentEntity.speed > 0.5;

    // Rough upright detection: if speed dropped and entity is person, might have fallen
    const wasUpright = wasMoving || recentEntity.class !== "person";
    const isUpright = isMoving || recentEntity.class !== "person";

    return {
      wasMoving,
      isMoving,
      wasUpright,
      isUpright,
      changed: wasUpright !== isUpright || (wasMoving && !isMoving),
    };
  }

  /**
   * Get the speed trend for an entity (accelerating, decelerating, constant)
   */
  getSpeedTrend(entityId: number): "accelerating" | "decelerating" | "constant" | "unknown" {
    if (this.history.length < 3) return "unknown";

    const speeds: number[] = [];
    for (const frame of this.history.slice(-5)) {
      const entity = frame.entities.find(e => e.id === entityId);
      if (entity) speeds.push(entity.speed);
    }

    if (speeds.length < 3) return "unknown";

    const avgFirst = (speeds[0] + speeds[1]) / 2;
    const avgLast = (speeds[speeds.length - 2] + speeds[speeds.length - 1]) / 2;

    if (avgLast > avgFirst * 1.3) return "accelerating";
    if (avgLast < avgFirst * 0.7) return "decelerating";
    return "constant";
  }

  /**
   * Check if scene has changed significantly
   */
  hasSceneChanged(threshold: number = 0.3): boolean {
    if (this.history.length < 2) return false;

    const current = this.history[this.history.length - 1];
    const prev = this.history[this.history.length - 2];

    // Compare entity positions
    let totalMovement = 0;
    let count = 0;

    for (const curr of current.entities) {
      const prevEnt = prev.entities.find(e => e.id === curr.id);
      if (prevEnt) {
        const dx = curr.x - prevEnt.x;
        const dy = curr.y - prevEnt.y;
        totalMovement += Math.sqrt(dx * dx + dy * dy);
        count++;
      }
    }

    if (count === 0) return false;
    const avgMovement = totalMovement / count;
    return avgMovement > threshold * 100; // Scale threshold
  }

  getHistory(): FrameSnapshot[] {
    return [...this.history];
  }

  clear(): void {
    this.history = [];
  }
}

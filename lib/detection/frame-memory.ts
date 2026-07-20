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

const MAX_HISTORY = 60; // Store last 60 frames (~20 seconds at 3 FPS)

export class FrameMemory {
  private history: FrameSnapshot[] = [];

  addFrame(snapshot: FrameSnapshot): void {
    this.history.push(snapshot);
    if (this.history.length > MAX_HISTORY) {
      this.history.shift();
    }
  }

  getPastFrames(secondsAgo: number, fps: number = 3): FrameSnapshot[] {
    const framesAgo = Math.round(secondsAgo * fps);
    const cutoff = this.history.length - framesAgo;
    if (cutoff <= 0) return [];
    return this.history.slice(0, cutoff);
  }

  getRecentFrames(seconds: number = 2, fps: number = 3): FrameSnapshot[] {
    const frameCount = Math.round(seconds * fps);
    return this.history.slice(-frameCount);
  }

  /**
   * Get speed history for a specific entity over the last N frames.
   */
  getEntitySpeedHistory(entityId: number, frames: number = 10): number[] {
    const speeds: number[] = [];
    const start = Math.max(0, this.history.length - frames);
    for (let i = start; i < this.history.length; i++) {
      const entity = this.history[i].entities.find(e => e.id === entityId);
      speeds.push(entity?.speed ?? 0);
    }
    return speeds;
  }

  /**
   * Get position delta for an entity over N frames.
   */
  getEntityPositionDelta(entityId: number, framesAgo: number): { dx: number; dy: number } | null {
    if (this.history.length < framesAgo + 1) return null;

    const current = this.history[this.history.length - 1];
    const past = this.history[this.history.length - 1 - framesAgo];

    const currEntity = current.entities.find(e => e.id === entityId);
    const pastEntity = past.entities.find(e => e.id === entityId);

    if (!currEntity || !pastEntity) return null;

    return {
      dx: currEntity.x - pastEntity.x,
      dy: currEntity.y - pastEntity.y,
    };
  }

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

  hasSceneChanged(threshold: number = 0.3): boolean {
    if (this.history.length < 2) return false;

    const current = this.history[this.history.length - 1];
    const prev = this.history[this.history.length - 2];

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
    return avgMovement > threshold * 100;
  }

  getHistory(): FrameSnapshot[] {
    return [...this.history];
  }

  clear(): void {
    this.history = [];
  }
}

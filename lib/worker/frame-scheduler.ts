// Frame scheduler for detection worker
// Captures video frames as ImageBitmap and sends to worker with adaptive throttling

export interface FrameSchedulerOptions {
  targetFPS?: number;      // Target detection FPS (default 3-5)
  maxFrameSkip?: number;   // Max frames to skip under load
}

export class FrameScheduler {
  private worker: Worker | null = null;
  private video: HTMLVideoElement | null = null;
  private rafId = 0;
  private frameCount = 0;
  private lastSendTime = 0;
  private isRunning = false;

  private targetFPS: number;
  private maxFrameSkip: number;
  private minInterval: number; // ms between sends

  constructor(options: FrameSchedulerOptions = {}) {
    this.targetFPS = options.targetFPS ?? 4;
    this.maxFrameSkip = options.maxFrameSkip ?? 3;
    this.minInterval = 1000 / this.targetFPS;
  }

  /**
   * Start capturing frames from video and sending to worker
   */
  start(worker: Worker, video: HTMLVideoElement): void {
    this.worker = worker;
    this.video = video;
    this.frameCount = 0;
    this.lastSendTime = 0;
    this.isRunning = true;
    this.scheduleNext();
  }

  /**
   * Stop frame capture
   */
  stop(): void {
    this.isRunning = false;
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }

  /**
   * Adaptive RAF loop - captures and sends frames
   */
  private scheduleNext = (): void => {
    if (!this.isRunning) return;

    this.rafId = requestAnimationFrame(async () => {
      if (!this.isRunning || !this.worker || !this.video) return;

      const now = performance.now();
      const elapsed = now - this.lastSendTime;

      // Throttle: only send if enough time has passed
      if (elapsed >= this.minInterval) {
        const video = this.video;
        if (video.paused || video.ended || video.readyState < 2) {
          this.scheduleNext();
          return;
        }

        try {
          // Create ImageBitmap from video (async, non-blocking)
          const bitmap = await createImageBitmap(video, {
            resizeWidth: video.videoWidth,
            resizeHeight: video.videoHeight,
            resizeQuality: "low", // Fastest
          });

          // Transfer bitmap to worker (zero-copy transferable)
          this.worker.postMessage(
            { type: "FRAME", bitmap, frameNumber: this.frameCount },
            [bitmap as unknown as Transferable]
          );

          this.frameCount++;
          this.lastSendTime = now;
        } catch (err) {
          console.warn("[FrameScheduler] Failed to capture frame:", err);
        }
      }

      this.scheduleNext();
    });
  };
}

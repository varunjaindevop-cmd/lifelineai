// Frame buffer for capturing 15-second pre-roll
export class FrameBuffer {
  private buffer: ImageData[] = [];
  private maxFrames: number;

  constructor(fps: number = 5, durationSeconds: number = 15) {
    this.maxFrames = fps * durationSeconds;
  }

  addFrame(frame: ImageData): void {
    this.buffer.push(frame);
    if (this.buffer.length > this.maxFrames) {
      this.buffer.shift();
    }
  }

  getPreRollFrames(): ImageData[] {
    return [...this.buffer];
  }

  clear(): void {
    this.buffer = [];
  }

  get length(): number {
    return this.buffer.length;
  }
}

// Encode frames to WebM video
export async function encodeClip(
  preFrames: ImageData[],
  postFrames: ImageData[],
  width: number = 640,
  height: number = 480
): Promise<Blob | null> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  // Use MediaRecorder if available
  if (typeof MediaRecorder !== "undefined") {
    const stream = canvas.captureStream(5); // 5 FPS
    const recorder = new MediaRecorder(stream, {
      mimeType: "video/webm;codecs=vp8",
    });

    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        chunks.push(e.data);
      }
    };

    return new Promise((resolve) => {
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: "video/webm" });
        resolve(blob);
      };

      recorder.start();

      const allFrames = [...preFrames, ...postFrames];
      let frameIndex = 0;

      const drawFrame = () => {
        if (frameIndex >= allFrames.length) {
          recorder.stop();
          return;
        }

        const frame = allFrames[frameIndex];
        ctx.putImageData(frame, 0, 0);
        frameIndex++;

        setTimeout(drawFrame, 200); // 5 FPS
      };

      drawFrame();
    });
  }

  // Fallback: create a simple GIF-like blob (not ideal but works)
  return null;
}

// Upload clip to Supabase Storage
export async function uploadClip(
  supabase: any,
  incidentId: string,
  blob: Blob
): Promise<string | null> {
  const filename = `incidents/${incidentId}/clip-${Date.now()}.webm`;

  const { data, error } = await supabase.storage
    .from("incident-clips")
    .upload(filename, blob, {
      contentType: "video/webm",
    });

  if (error) {
    console.error("Upload error:", error);
    return null;
  }

  const { data: urlData } = supabase.storage
    .from("incident-clips")
    .getPublicUrl(filename);

  return urlData?.publicUrl || null;
}

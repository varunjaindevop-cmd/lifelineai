import { QualityMetrics } from "../ai/types";

// Canvas for image processing
let processingCanvas: HTMLCanvasElement | null = null;
let processingCtx: CanvasRenderingContext2D | null = null;

function getCanvas(width: number, height: number): HTMLCanvasElement {
  if (!processingCanvas) {
    processingCanvas = document.createElement("canvas");
    processingCtx = processingCanvas.getContext("2d");
  }
  processingCanvas.width = width;
  processingCanvas.height = height;
  return processingCanvas;
}

// Analyze image quality metrics
export function analyzeQuality(imageData: ImageData): QualityMetrics {
  const data = imageData.data;
  const pixels = data.length / 4;
  let sum = 0;
  let sumSq = 0;
  let min = 255;
  let max = 0;

  for (let i = 0; i < data.length; i += 4) {
    const gray = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
    sum += gray;
    sumSq += gray * gray;
    min = Math.min(min, gray);
    max = Math.max(max, gray);
  }

  const mean = sum / pixels;
  const variance = sumSq / pixels - mean * mean;

  // Estimate sharpness using Laplacian variance (simplified)
  let laplacianSum = 0;
  let laplacianCount = 0;
  const width = imageData.width;
  for (let y = 1; y < imageData.height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = (y * width + x) * 4;
      const center = data[idx];
      const top = data[((y - 1) * width + x) * 4];
      const bottom = data[((y + 1) * width + x) * 4];
      const left = data[(y * width + (x - 1)) * 4];
      const right = data[(y * width + (x + 1)) * 4];
      const laplacian = Math.abs(4 * center - top - bottom - left - right);
      laplacianSum += laplacian;
      laplacianCount++;
    }
  }

  // Estimate noise using high-frequency analysis
  let noiseSum = 0;
  let noiseCount = 0;
  for (let y = 1; y < imageData.height - 1; y += 2) {
    for (let x = 1; x < width - 1; x += 2) {
      const idx = (y * width + x) * 4;
      const center = data[idx];
      const neighbors = [
        data[((y - 1) * width + x) * 4],
        data[((y + 1) * width + x) * 4],
        data[(y * width + (x - 1)) * 4],
        data[(y * width + (x + 1)) * 4],
      ];
      const avg = neighbors.reduce((a, b) => a + b, 0) / 4;
      noiseSum += Math.abs(center - avg);
      noiseCount++;
    }
  }

  return {
    brightness: mean,
    contrast: Math.sqrt(variance),
    sharpness: laplacianCount > 0 ? laplacianSum / laplacianCount : 0,
    noise: noiseCount > 0 ? noiseSum / noiseCount : 0,
  };
}

// Get adaptive preprocessing config based on quality
export function getAdaptiveConfig(metrics: QualityMetrics) {
  return {
    confidenceThreshold: metrics.sharpness < 50 ? 0.12 : 0.20,
    preprocessingIntensity:
      metrics.noise > 30 || metrics.contrast < 30 ? "high" : "normal",
    frameSkip: metrics.brightness < 40 ? 8 : 5,
    useEnhancedPreprocessing:
      metrics.contrast < 30 || metrics.brightness < 50,
    enableCLAHE: metrics.brightness < 50 || metrics.contrast < 30,
    enableDenoise: metrics.noise > 25,
    enableSharpen: metrics.sharpness < 60,
  };
}

// Preprocess image for YOLO inference
export function preprocessImage(
  imageData: ImageData,
  targetSize: number = 640
): ImageData {
  const canvas = getCanvas(targetSize, targetSize);
  const ctx = processingCtx!;

  // Create temporary canvas with original image
  const srcCanvas = getCanvas(imageData.width, imageData.height);
  const srcCtx = srcCanvas.getContext("2d")!;
  srcCtx.putImageData(imageData, 0, 0);

  // Clear and fill with black (letterbox)
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, targetSize, targetSize);

  // Calculate letterbox dimensions
  const scale = Math.min(
    targetSize / imageData.width,
    targetSize / imageData.height
  );
  const newWidth = imageData.width * scale;
  const newHeight = imageData.height * scale;
  const offsetX = (targetSize - newWidth) / 2;
  const offsetY = (targetSize - newHeight) / 2;

  // Draw scaled image
  ctx.drawImage(srcCanvas, offsetX, offsetY, newWidth, newHeight);

  // Get processed image data
  return ctx.getImageData(0, 0, targetSize, targetSize);
}

// Apply CLAHE-like contrast enhancement (simplified)
export function applyCLAHE(imageData: ImageData): ImageData {
  const data = imageData.data;
  const pixels = data.length / 4;

  // Calculate histogram
  const histogram = new Array(256).fill(0);
  for (let i = 0; i < data.length; i += 4) {
    const gray = Math.round(
      data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114
    );
    histogram[gray]++;
  }

  // Calculate CDF
  const cdf = new Array(256).fill(0);
  cdf[0] = histogram[0];
  for (let i = 1; i < 256; i++) {
    cdf[i] = cdf[i - 1] + histogram[i];
  }

  // Find min non-zero CDF
  const cdfMin = cdf.find((v) => v > 0) || 0;

  // Apply equalization
  for (let i = 0; i < data.length; i += 4) {
    const gray = Math.round(
      data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114
    );
    const newValue = Math.round(((cdf[gray] - cdfMin) / (pixels - cdfMin)) * 255);
    const ratio = newValue / Math.max(gray, 1);
    data[i] = Math.min(255, data[i] * ratio);
    data[i + 1] = Math.min(255, data[i + 1] * ratio);
    data[i + 2] = Math.min(255, data[i + 2] * ratio);
  }

  return imageData;
}

// Denoise image (simple box blur)
export function denoise(imageData: ImageData): ImageData {
  const data = imageData.data;
  const width = imageData.width;
  const height = imageData.height;
  const output = new Uint8ClampedArray(data);

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const idx = ((y + dy) * width + (x + dx)) * 4 + c;
            sum += data[idx];
          }
        }
        output[(y * width + x) * 4 + c] = sum / 9;
      }
    }
  }

  return new ImageData(output, width, height);
}

// Sharpen image (unsharp mask)
export function sharpen(imageData: ImageData): ImageData {
  const data = imageData.data;
  const width = imageData.width;
  const height = imageData.height;
  const output = new Uint8ClampedArray(data);

  const kernel = [0, -1, 0, -1, 5, -1, 0, -1, 0];

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        let ki = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const idx = ((y + dy) * width + (x + dx)) * 4 + c;
            sum += data[idx] * kernel[ki++];
          }
        }
        output[(y * width + x) * 4 + c] = Math.min(255, Math.max(0, sum));
      }
    }
  }

  return new ImageData(output, width, height);
}

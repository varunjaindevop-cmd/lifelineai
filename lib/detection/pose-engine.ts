/**
 * MoveNet Pose Detection Engine
 * Detects 2D human skeletons (17 keypoints) for accident detection.
 * Uses TensorFlow.js MoveNet Lightning for fast browser inference.
 */

import * as tf from "@tensorflow/tfjs";
import * as poseDetection from "@tensorflow-models/pose-detection";

// MoveNet keypoint indices
export const KEYPOINT_INDICES: Record<string, number> = {
  nose: 0,
  left_eye: 1,
  right_eye: 2,
  left_ear: 3,
  right_ear: 4,
  left_shoulder: 5,
  right_shoulder: 6,
  left_elbow: 7,
  right_elbow: 8,
  left_wrist: 9,
  right_wrist: 10,
  left_hip: 11,
  right_hip: 12,
  left_knee: 13,
  right_knee: 14,
  left_ankle: 15,
  right_ankle: 16,
};

export interface Keypoint {
  x: number; // normalized 0-1
  y: number; // normalized 0-1
  score: number; // confidence 0-1
  name: string;
}

export interface PoseResult {
  keypoints: Keypoint[];
  score: number; // overall pose confidence
  // Derived metrics
  bodyAngle: number; // 0 = standing upright, 90 = horizontal (fallen)
  isUpright: boolean;
  isFallen: boolean;
  isSitting: boolean;
  headAboveHips: boolean;
  bbox: { x: number; y: number; w: number; h: number }; // body bounding box
}

export interface PersonSkeleton {
  id: number;
  pose: PoseResult;
  bbox: [number, number, number, number]; // [x1, y1, x2, y2] normalized
  confidence: number;
  centerX: number;
  centerY: number;
  // Tracking
  previousPoses: PoseResult[];
  poseChanged: boolean; // did pose change significantly
}

let detector: poseDetection.PoseDetector | null = null;
let loading = false;

export async function loadPoseModel(): Promise<void> {
  if (detector || loading) return;
  loading = true;

  console.log("[PoseNet] Loading MoveNet...");
  const t0 = performance.now();

  try {
    await tf.ready();
    detector = await poseDetection.createDetector(
      poseDetection.SupportedModels.MoveNet,
      {
        modelType: poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING,
        enableSmoothing: true,
        multiPoseMaxDimension: 256,
        enableTracking: false,
      }
    );
    const elapsed = (performance.now() - t0).toFixed(0);
    console.log(`[PoseNet] MoveNet loaded in ${elapsed}ms`);
  } catch (err: any) {
    console.error("[PoseNet] Failed to load:", err.message);
    detector = null;
    throw err;
  } finally {
    loading = false;
  }
}

export function isPoseReady(): boolean {
  return detector !== null;
}

/**
 * Analyze a single pose to determine body orientation.
 */
function analyzePose(keypoints: Keypoint[]): PoseResult {
  const nose = keypoints[0];
  const leftShoulder = keypoints[5];
  const rightShoulder = keypoints[6];
  const leftHip = keypoints[11];
  const rightHip = keypoints[12];
  const leftKnee = keypoints[13];
  const rightKnee = keypoints[14];
  const leftAnkle = keypoints[15];
  const rightAnkle = keypoints[16];

  // Average left/right for center points
  const shoulderY = (leftShoulder.y + rightShoulder.y) / 2;
  const hipY = (leftHip.y + rightHip.y) / 2;
  const kneeY = (leftKnee.y + rightKnee.y) / 2;
  const ankleY = (leftAnkle.y + rightAnkle.y) / 2;

  const shoulderX = (leftShoulder.x + rightShoulder.x) / 2;
  const hipX = (leftHip.x + rightHip.x) / 2;

  // Body angle: angle of torso relative to vertical
  // 0 = standing upright, 90 = horizontal
  const torsoDx = shoulderX - hipX;
  const torsoDy = shoulderY - hipY; // note: y increases downward
  const bodyAngle = Math.abs(Math.atan2(torsoDx, -torsoDy) * 180 / Math.PI);

  // Head above hips = upright (in image coords, lower y = higher in frame)
  const headAboveHips = nose.y < hipY;

  // Upright: body angle < 30 degrees, head above hips
  const isUpright = bodyAngle < 30 && headAboveHips;

  // Fallen: body angle > 50 degrees (horizontal) OR head below knees
  const isFallen = bodyAngle > 50 || (nose.y > kneeY && headAboveHips === false);

  // Sitting: hips low, knees bent (knees below hips but ankles below knees)
  const isSitting = !isUpright && !isFallen && hipY > kneeY * 0.8;

  // Bounding box from keypoints
  const validKps = keypoints.filter(kp => kp.score > 0.3);
  if (validKps.length < 4) {
    return {
      keypoints, score: 0, bodyAngle, isUpright: true, isFallen: false, isSitting: false,
      headAboveHips: true, bbox: { x: 0, y: 0, w: 0, h: 0 },
    };
  }

  const xs = validKps.map(kp => kp.x);
  const ys = validKps.map(kp => kp.y);
  const x1 = Math.min(...xs);
  const y1 = Math.min(...ys);
  const x2 = Math.max(...xs);
  const y2 = Math.max(...ys);

  const avgScore = validKps.reduce((sum, kp) => sum + kp.score, 0) / validKps.length;

  return {
    keypoints,
    score: avgScore,
    bodyAngle,
    isUpright,
    isFallen,
    isSitting,
    headAboveHips,
    bbox: { x: x1, y: y1, w: x2 - x1, h: y2 - y1 },
  };
}

/**
 * Detect poses in an image and return person skeletons.
 */
export async function detectPoses(imageData: ImageData): Promise<PersonSkeleton[]> {
  if (!detector) throw new Error("Pose model not loaded");

  const t0 = performance.now();

  // Create canvas for pose detection
  const canvas = new OffscreenCanvas(imageData.width, imageData.height);
  const ctx = canvas.getContext("2d")!;
  ctx.putImageData(imageData, 0, 0);

  const bitmap = await createImageBitmap(canvas);
  const poses = await detector.estimatePoses(bitmap as any);
  bitmap.close();

  const results: PersonSkeleton[] = [];

  for (let i = 0; i < poses.length; i++) {
    const pose = poses[i];

    // Filter to high-confidence keypoints
    const keypoints: Keypoint[] = pose.keypoints.map((kp, idx) => ({
      x: kp.x / imageData.width,
      y: kp.y / imageData.height,
      score: kp.score ?? 0,
      name: Object.keys(KEYPOINT_INDICES)[idx] || `kp_${idx}`,
    }));

    const overallScore = keypoints.reduce((sum, kp) => sum + kp.score, 0) / keypoints.length;
    if (overallScore < 0.3) continue; // skip low confidence poses

    const poseResult = analyzePose(keypoints);

    results.push({
      id: i,
      pose: poseResult,
      bbox: [
        poseResult.bbox.x,
        poseResult.bbox.y,
        poseResult.bbox.x + poseResult.bbox.w,
        poseResult.bbox.y + poseResult.bbox.h,
      ],
      confidence: overallScore,
      centerX: poseResult.bbox.x + poseResult.bbox.w / 2,
      centerY: poseResult.bbox.y + poseResult.bbox.h / 2,
      previousPoses: [],
      poseChanged: false,
    });
  }

  const elapsed = (performance.now() - t0).toFixed(1);
  console.log(`[PoseNet] Inference: ${elapsed}ms, poses=${results.length}`);

  return results;
}

/**
 * Draw skeleton overlay on canvas.
 */
export function drawSkeleton(
  ctx: CanvasRenderingContext2D,
  skeleton: PersonSkeleton,
  scaleX: number,
  scaleY: number,
  offsetX: number,
  offsetY: number
) {
  const { pose, confidence } = skeleton;
  const kps = pose.keypoints;

  // Skeleton connections (pairs of keypoint indices)
  const SKELETON_CONNECTIONS: [number, number][] = [
    [0, 1], [0, 2], // nose to eyes
    [1, 3], [2, 4], // eyes to ears
    [5, 6], // shoulders
    [5, 7], [7, 9], // left arm
    [6, 8], [8, 10], // right arm
    [5, 11], [6, 12], // torso
    [11, 12], // hips
    [11, 13], [13, 15], // left leg
    [12, 14], [14, 16], // right leg
  ];

  // Color based on pose state
  let color = "#22c55e"; // green = standing
  if (pose.isFallen) color = "#ef4444"; // red = fallen
  else if (pose.isSitting) color = "#f59e0b"; // yellow = sitting
  else if (!pose.isUpright) color = "#f97316"; // orange = tilted

  // Draw connections
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  for (const [i, j] of SKELETON_CONNECTIONS) {
    const kpA = kps[i];
    const kpB = kps[j];
    if (kpA.score < 0.3 || kpB.score < 0.3) continue;

    const x1 = offsetX + kpA.x * scaleX;
    const y1 = offsetY + kpA.y * scaleY;
    const x2 = offsetX + kpB.x * scaleX;
    const y2 = offsetY + kpB.y * scaleY;

    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  // Draw keypoints as dots
  for (const kp of kps) {
    if (kp.score < 0.3) continue;
    const x = offsetX + kp.x * scaleX;
    const y = offsetY + kp.y * scaleY;

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  // Draw body angle indicator
  const centerX = offsetX + skeleton.centerX * scaleX;
  const centerY = offsetY + skeleton.centerY * scaleY;
  ctx.fillStyle = "rgba(0,0,0,0.7)";
  ctx.fillRect(centerX - 30, centerY - 30, 60, 18);
  ctx.fillStyle = color;
  ctx.font = "10px monospace";
  ctx.fillText(`${Math.round(pose.bodyAngle)}° ${pose.isFallen ? "FALL" : pose.isSitting ? "SIT" : "OK"}`, centerX - 28, centerY - 17);
}

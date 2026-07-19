"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  ArrowLeft, Video, Play, Pause, AlertTriangle, Clock,
  Navigation, RotateCcw, Loader2, Zap,
} from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";

// ========== TYPES ==========
interface VideoClip { name: string; src: string; description: string }
interface IncidentAlert { type: string; severity: string; confidence: number; timestamp: string; latitude: number; longitude: number }

interface TrackedBlob {
  id: number; cx: number; cy: number; w: number; h: number;
  vx: number; vy: number; frames: number; lastSeen: number;
  class: string; positions: { x: number; y: number }[];
  area: number;
  // Physics
  speed: number;           // pixels/frame
  acceleration: number;    // change in speed per frame
  heading: number;         // angle in radians
  headingChange: number;   // angular velocity
  aspectRatio: number;     // w/h
  aspectHistory: number[]; // track shape changes (bike falling = ratio change)
  speedHistory: number[];
  decelFrames: number;     // consecutive frames of deceleration
  _near?: number;          // sustained closeness counter
}

interface FlowAnomaly {
  type: string; confidence: number; cx: number; cy: number; evidence: string;
}

const VIDEO_CLIPS: VideoClip[] = [
  { name: "accident_sample.mp4", src: "/videos/accident_sample.mp4", description: "Vehicle collision" },
  { name: "camera2_demo.mp4", src: "/videos/camera2_demo.mp4", description: "Traffic monitoring" },
  { name: "camera4_demo.mp4", src: "/videos/camera4_demo.mp4", description: "Intersection monitoring" },
  { name: "checking.mp4", src: "/videos/checking.mp4", description: "System check" },
];

const LAT = 22.7196, LNG = 75.8577;
const W = 320, H = 240;
const GRID_COLS = 10, GRID_ROWS = 8;
const CELL_W = W / GRID_COLS, CELL_H = H / GRID_ROWS;

let nextId = 1;

export default function VideoAnalysisPage() {
  const [selectedClip, setSelectedClip] = useState<VideoClip | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [videoReady, setVideoReady] = useState(false);
  const [incidents, setIncidents] = useState<IncidentAlert[]>([]);
  const [state, setState] = useState("monitoring");
  const [demoMode, setDemoMode] = useState(false);
  const [objectCount, setObjectCount] = useState(0);
  const [analysisMode, setAnalysisMode] = useState<"normal" | "traffic">("normal");
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tmpCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number>(0);
  const blobsRef = useRef<TrackedBlob[]>([]);
  const stateRef = useRef("monitoring");
  const frameRef = useRef(0);
  const stateFrameRef = useRef(0);
  const cooldownRef = useRef(0);
  const accumRef = useRef<Float32Array>(new Float32Array(GRID_COLS * GRID_ROWS));
  const prevGridRef = useRef<Float32Array | null>(null);
  const consecutiveAnomalyRef = useRef(0);
  const anomalyHeatmapRef = useRef<Float32Array>(new Float32Array(GRID_COLS * GRID_ROWS));
  const supabase = createClient();

  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);
  useEffect(() => { setVideoReady(false); const t = setTimeout(() => setVideoReady(true), 8000); return () => clearTimeout(t); }, [selectedClip]);

  const getTmp = useCallback(() => {
    if (!tmpCanvasRef.current) tmpCanvasRef.current = document.createElement("canvas");
    return tmpCanvasRef.current;
  }, []);

  // ========== BLOB DETECTION (Frame Differencing) ==========
  const findBlobs = (curr: Uint8ClampedArray, prev: Uint8ClampedArray, w: number, h: number) => {
    const diff = new Uint8Array(w * h);
    for (let i = 0; i < diff.length; i++) {
      const j = i * 4;
      const g1 = curr[j] * 0.299 + curr[j + 1] * 0.587 + curr[j + 2] * 0.114;
      const g2 = prev[j] * 0.299 + prev[j + 1] * 0.587 + prev[j + 2] * 0.114;
      diff[i] = Math.abs(g1 - g2) > 20 ? 1 : 0;
    }
    const dil = new Uint8Array(w * h);
    const K = 4;
    for (let y = K; y < h - K; y++) for (let x = K; x < w - K; x++) {
      let mx = 0;
      for (let dy = -K; dy <= K; dy += 2) for (let dx = -K; dx <= K; dx += 2)
        if (diff[(y + dy) * w + (x + dx)] > mx) mx = diff[(y + dy) * w + (x + dx)];
      dil[y * w + x] = mx;
    }
    const vis = new Uint8Array(w * h);
    const blobs: { cx: number; cy: number; w: number; h: number; mass: number }[] = [];
    for (let y = K; y < h - K; y += 3) for (let x = K; x < w - K; x += 3) {
      if (vis[y * w + x] || !dil[y * w + x]) continue;
      let x0 = x, x1 = x, y0 = y, y1 = y, sx = 0, sy = 0, n = 0;
      const q = [x, y]; vis[y * w + x] = 1;
      while (q.length) {
        const qx = q.shift()!, qy = q.shift()!;
        sx += qx; sy += qy; n++;
        if (qx < x0) x0 = qx; if (qx > x1) x1 = qx; if (qy < y0) y0 = qy; if (qy > y1) y1 = qy;
        for (const [ddx, ddy] of [[-3, 0], [3, 0], [0, -3], [0, 3]]) {
          const nx = qx + ddx, ny = qy + ddy;
          if (nx >= 0 && nx < w && ny >= 0 && ny < h && !vis[ny * w + nx] && dil[ny * w + nx]) { vis[ny * w + nx] = 1; q.push(nx, ny); }
        }
      }
      const bw = x1 - x0, bh = y1 - y0, area = bw * bh;
      if (n < 25 || area < 300) continue;
      blobs.push({ cx: sx / n, cy: sy / n, w: bw, h: bh, mass: area });
    }
    // Merge overlapping
    const merged: typeof blobs = [];
    const used = new Set<number>();
    for (let i = 0; i < blobs.length; i++) {
      if (used.has(i)) continue;
      let b = blobs[i];
      for (let j = i + 1; j < blobs.length; j++) {
        if (used.has(j)) continue;
        const d = Math.sqrt((b.cx - blobs[j].cx) ** 2 + (b.cy - blobs[j].cy) ** 2);
        if (d < Math.max(b.w, blobs[j].w) * 1.5) {
          const tm = b.mass + blobs[j].mass;
          b = { cx: (b.cx * b.mass + blobs[j].cx * blobs[j].mass) / tm, cy: (b.cy * b.mass + blobs[j].cy * blobs[j].mass) / tm, w: Math.max(b.w, blobs[j].w), h: Math.max(b.h, blobs[j].h), mass: tm };
          used.add(j);
        }
      }
      merged.push(b);
      used.add(i);
    }
    return merged;
  };

  // ========== OBJECT CLASSIFICATION ==========
  // Uses area + aspect ratio + Y-position + SPEED (fast objects on road = vehicle)
  // Blob area alone is unreliable (faster = bigger motion trail)
  const classifyBlob = (w: number, h: number, cy: number, speed: number): string => {
    const area = w * h;
    const aspect = w / Math.max(h, 1);
    const onRoad = cy > H * 0.35; // lower 65% of frame = road level

    // Very small blobs = noise or distant person
    if (area < 300) return "person";

    // Large blob = vehicle (cars, trucks, auto-rickshaws)
    if (area > 2000) return "car";

    // Fast + on road = almost certainly a vehicle (bike or car)
    if (speed > 2.5 && onRoad) {
      // Wide blob = car, narrow = bike
      return aspect > 0.9 ? "car" : "bike";
    }

    // Medium blob + on road + moving = vehicle
    if (area > 800 && onRoad && speed > 1) {
      return aspect > 0.8 ? "car" : "bike";
    }

    // Wide + medium area = car (even if slow)
    if (area > 600 && aspect > 1.0) return "car";

    // Tall + narrow + on road = bike or person walking
    if (aspect < 0.6 && onRoad) {
      // Larger = bike, smaller = person
      return area > 500 ? "bike" : "person";
    }

    // Tall + narrow + off road = person
    if (aspect < 0.6 && !onRoad) return "person";

    // Default: use area + speed heuristic
    if (area > 1000 && speed > 1) return "car";
    if (area > 500) return "bike";
    return "person";
  };

  // ========== TRACKING WITH PHYSICS ==========
  const trackBlobs = (detections: { cx: number; cy: number; w: number; h: number; mass: number }[], frame: number): TrackedBlob[] => {
    const tracked = blobsRef.current;
    const matched = new Set<number>();
    for (const blob of tracked) {
      let best = -1, bestD = 50;
      for (let i = 0; i < detections.length; i++) {
        if (matched.has(i)) continue;
        const d = Math.sqrt((blob.cx - detections[i].cx) ** 2 + (blob.cy - detections[i].cy) ** 2);
        if (d < bestD) { bestD = d; best = i; }
      }
      if (best >= 0) {
        const det = detections[best];
        const newVx = det.cx - blob.cx;
        const newVy = det.cy - blob.cy;
        const newSpeed = Math.sqrt(newVx * newVx + newVy * newVy);
        const newHeading = Math.atan2(newVy, newVx);

        // Physics: acceleration and heading change
        const prevSpeed = blob.speed;
        blob.acceleration = newSpeed - prevSpeed;
        blob.decelFrames = blob.acceleration < -0.5 ? blob.decelFrames + 1 : 0;

        let hdgDiff = Math.abs(newHeading - blob.heading);
        if (hdgDiff > Math.PI) hdgDiff = 2 * Math.PI - hdgDiff;
        blob.headingChange = hdgDiff;

        blob.vx = newVx; blob.vy = newVy;
        blob.cx = det.cx; blob.cy = det.cy;
        blob.w = det.w; blob.h = det.h;
        blob.area = det.w * det.h;
        blob.speed = newSpeed;
        blob.heading = newHeading;
        blob.aspectRatio = det.w / Math.max(det.h, 1);
        blob.aspectHistory.push(blob.aspectRatio);
        if (blob.aspectHistory.length > 8) blob.aspectHistory.shift();
        blob.speedHistory.push(newSpeed);
        if (blob.speedHistory.length > 8) blob.speedHistory.shift();
        blob.frames++;
        blob.lastSeen = frame;
        blob.positions.push({ x: det.cx, y: det.cy });
        if (blob.positions.length > 10) blob.positions.shift();
        if (blob.frames >= 3) blob.class = classifyBlob(det.w, det.h, det.cy, blob.speed);
        matched.add(best);
      }
    }
    for (let i = 0; i < detections.length; i++) {
      if (matched.has(i)) continue;
      const d = detections[i];
      tracked.push({
        id: nextId++, cx: d.cx, cy: d.cy, w: d.w, h: d.h,
        vx: 0, vy: 0, frames: 1, lastSeen: frame,
        class: classifyBlob(d.w, d.h, d.cy, 0),
        positions: [{ x: d.cx, y: d.cy }],
        area: d.w * d.h,
        speed: 0, acceleration: 0, heading: 0, headingChange: 0,
        aspectRatio: d.w / Math.max(d.h, 1),
        aspectHistory: [d.w / Math.max(d.h, 1)],
        speedHistory: [0], decelFrames: 0,
      });
    }
    blobsRef.current = tracked.filter(b => frame - b.lastSeen < 5);
    return blobsRef.current;
  };

  // ========== PHYSICS-BASED COLLISION DETECTION ==========
  // REQUIRES STRONG EVIDENCE — proximity alone is NOT enough (traffic is always close)
  // Must have: (hard deceleration OR sudden stop OR shape change) + convergence + proximity
  const detectPhysicsCollision = (blobs: TrackedBlob[]): { confidence: number; a: TrackedBlob; b: TrackedBlob; evidence: string } | null => {
    const minFrames = 3;
    const candidates = blobs.filter(b => b.frames >= minFrames);
    if (candidates.length < 2) return null;

    let best: { confidence: number; a: TrackedBlob; b: TrackedBlob; evidence: string } | null = null;

    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        const a = candidates[i], b = candidates[j];
        if (a.class === "person" && b.class === "person") continue;

        const dist = Math.sqrt((a.cx - b.cx) ** 2 + (a.cy - b.cy) ** 2);
        const combinedR = Math.sqrt(a.area) + Math.sqrt(b.area);
        // Hard distance gate: must be VERY close to even consider
        if (dist > combinedR * 0.8) continue;

        // ===== STRONG EVIDENCE REQUIRED =====
        // At least ONE of these must be true:
        let strongSignals = 0;
        const evidenceParts: string[] = [];

        // Signal 1: HARD DECELERATION (either object braking for 3+ frames)
        const decelA = a.decelFrames >= 3;
        const decelB = b.decelFrames >= 3;
        if (decelA || decelB) { strongSignals++; evidenceParts.push("hard_brake"); }

        // Signal 2: SUDDEN SPEED DROP (impact signature)
        let suddenDrop = false;
        for (const obj of [a, b]) {
          if (obj.speedHistory.length >= 4) {
            const prevAvg = (obj.speedHistory[0] + obj.speedHistory[1]) / 2;
            const curr = obj.speedHistory[obj.speedHistory.length - 1];
            if (prevAvg > 2 && curr < prevAvg * 0.25) { suddenDrop = true; break; }
          }
        }
        if (suddenDrop) { strongSignals++; evidenceParts.push("sudden_stop"); }

        // Signal 3: SHAPE CHANGE (bike falling, vehicle rollover)
        let shapeChange = false;
        for (const obj of [a, b]) {
          if (obj.aspectHistory.length >= 4) {
            const prevAR = (obj.aspectHistory[0] + obj.aspectHistory[1]) / 2;
            const currAR = obj.aspectHistory[obj.aspectHistory.length - 1];
            if (Math.abs(currAR - prevAR) / Math.max(prevAR, 0.1) > 0.5) { shapeChange = true; break; }
          }
        }
        if (shapeChange) { strongSignals++; evidenceParts.push("shape_change"); }

        // Signal 4: BOTH objects heading toward each other (not just one)
        const dx = b.cx - a.cx, dy = b.cy - a.cy;
        const dotA = a.vx * dx + a.vy * dy;
        const dotB = b.vx * (-dx) + b.vy * (-dy);
        const bothConverging = dotA > 0 && dotB > 0;
        if (bothConverging) { strongSignals++; evidenceParts.push("mutual_converge"); }

        // Signal 5: Speed differential (one fast, one slow/stopped = potential impact)
        const speedA = a.speed;
        const speedB = b.speed;
        const speedDiff = Math.abs(speedA - speedB);
        if (speedDiff > 2 && Math.max(speedA, speedB) > 2) {
          strongSignals++; evidenceParts.push("speed_diff");
        }

        // REJECT if no strong signals — this is just traffic being close
        if (strongSignals < 2) continue;

        // Parallel check (same direction = normal traffic)
        const angleDiff = Math.abs(a.heading - b.heading);
        const wrapped = angleDiff > Math.PI ? 2 * Math.PI - angleDiff : angleDiff;
        if (wrapped < Math.PI * 0.3 && speedDiff < 1.5) continue; // parallel + similar speed = traffic

        // Proximity within hard gate
        const proximity = 1 - Math.min(dist / (combinedR * 0.8), 1);

        // Sustained closeness
        const closeThresh = combinedR * 0.8;
        if (dist < closeThresh) {
          a._near = (a._near || 0) + 1;
          b._near = (b._near || 0) + 1;
        } else {
          a._near = Math.max(0, (a._near || 0) - 1);
          b._near = Math.max(0, (b._near || 0) - 1);
        }
        const near = Math.min(a._near || 0, b._near || 0);

        const conf = Math.min(0.95,
          0.30 * proximity +
          0.25 * Math.min(near / 3, 1) +
          0.25 * (strongSignals / 5) +
          0.20 * (bothConverging ? 1 : 0.2)
        );

        if (conf > 0.4 && (!best || conf > best.confidence)) {
          best = { confidence: conf, a, b, evidence: evidenceParts.join("+") };
        }
      }
    }
    return best;
  };

  // ========== FLOW HEATMAP (Scene-level backup) ==========
  const toGrayGrid = (data: Uint8ClampedArray, w: number, h: number): Float32Array => {
    const g = new Float32Array(GRID_COLS * GRID_ROWS);
    const cw = Math.floor(w / GRID_COLS), ch = Math.floor(h / GRID_ROWS);
    for (let r = 0; r < GRID_ROWS; r++) for (let c = 0; c < GRID_COLS; c++) {
      let s = 0, n = 0;
      for (let dy = 0; dy < ch; dy += 2) for (let dx = 0; dx < cw; dx += 2) {
        const i = ((r * ch + dy) * w + (c * cw + dx)) * 4;
        s += data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114; n++;
      }
      g[r * GRID_COLS + c] = n > 0 ? s / n : 128;
    }
    return g;
  };

  const updateFlowHeatmap = (blobs: TrackedBlob[]): boolean => {
    const heatmap = anomalyHeatmapRef.current;
    const totalCells = GRID_COLS * GRID_ROWS;

    // Mark cells with anomalous blob behavior
    const anomalousCells = new Set<number>();
    for (const blob of blobs) {
      if (blob.frames < 3) continue;
      const gc = Math.min(Math.floor(blob.cx / CELL_W), GRID_COLS - 1);
      const gr = Math.min(Math.floor(blob.cy / CELL_H), GRID_ROWS - 1);
      const idx = gr * GRID_COLS + gc;

      let cellAnomaly = false;
      // Hard deceleration
      if (blob.decelFrames >= 3) cellAnomaly = true;
      // Sudden speed drop
      if (blob.speedHistory.length >= 4) {
        const prev = (blob.speedHistory[0] + blob.speedHistory[1]) / 2;
        const curr = blob.speedHistory[blob.speedHistory.length - 1];
        if (prev > 2 && curr < prev * 0.3) cellAnomaly = true;
      }
      // Shape change (bike falling)
      if (blob.aspectHistory.length >= 4) {
        const prevAR = (blob.aspectHistory[0] + blob.aspectHistory[1]) / 2;
        const currAR = blob.aspectHistory[blob.aspectHistory.length - 1];
        if (Math.abs(currAR - prevAR) / Math.max(prevAR, 0.1) > 0.4) cellAnomaly = true;
      }

      if (cellAnomaly) anomalousCells.add(idx);
    }

    // Update heatmap — require HARD deceleration (3+ frames) to increment
    for (let i = 0; i < totalCells; i++) {
      if (anomalousCells.has(i)) {
        heatmap[i] = Math.min(heatmap[i] + 1, 30);
      } else {
        heatmap[i] = Math.max(0, heatmap[i] - 0.5); // faster decay
      }
    }

    // Check for persistent clusters — need higher threshold
    let maxClusterHeat = 0;
    let clusterCount = 0;
    const visited = new Uint8Array(totalCells);
    for (let i = 0; i < totalCells; i++) {
      if (visited[i] || heatmap[i] < 6) continue; // raised from 4 to 6
      // BFS cluster
      let cells = 0, totalHeat = 0;
      const queue = [i];
      visited[i] = 1;
      while (queue.length) {
        const ci = queue.shift()!;
        cells++;
        totalHeat += heatmap[ci];
        const cr = Math.floor(ci / GRID_COLS), cc = ci % GRID_COLS;
        for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          const nr = cr + dr, nc = cc + dc;
          if (nr < 0 || nr >= GRID_ROWS || nc < 0 || nc >= GRID_COLS) continue;
          const ni = nr * GRID_COLS + nc;
          if (!visited[ni] && heatmap[ni] >= 4) { visited[ni] = 1; queue.push(ni); }
        }
      }
      if (cells >= 3) {
        clusterCount++;
        const avgHeat = totalHeat / cells;
        if (avgHeat > maxClusterHeat) maxClusterHeat = avgHeat;
      }
    }

    return maxClusterHeat >= 12 && clusterCount >= 1;
  };

  // ========== DRAW ==========
  const drawBoxes = (tracked: TrackedBlob[], collision: ReturnType<typeof detectPhysicsCollision>) => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const sx = canvas.width / W, sy = canvas.height / H;

    // Draw heatmap overlay
    const heatmap = anomalyHeatmapRef.current;
    for (let r = 0; r < GRID_ROWS; r++) for (let c = 0; c < GRID_COLS; c++) {
      const heat = heatmap[r * GRID_COLS + c];
      if (heat > 2) {
        const intensity = Math.min(heat / 20, 1);
        ctx.fillStyle = `rgba(255, 0, 0, ${intensity * 0.25})`;
        ctx.fillRect(c * CELL_W * sx, r * CELL_H * sy, CELL_W * sx, CELL_H * sy);
      }
    }

    // Draw ESP boxes for each tracked object
    for (const blob of tracked) {
      if (blob.frames < 3) continue;
      const x = (blob.cx - blob.w / 2) * sx;
      const y = (blob.cy - blob.h / 2) * sy;
      const w = blob.w * sx;
      const h = blob.h * sy;

      const isCollision = collision && (collision.a.id === blob.id || collision.b.id === blob.id);
      const color = isCollision ? "#ef4444"
        : blob.class === "car" ? "#22c55e"
        : blob.class === "bike" ? "#f59e0b"
        : "#3b82f6";

      // Bounding box
      ctx.strokeStyle = color;
      ctx.lineWidth = isCollision ? 3 : 2;
      ctx.strokeRect(x, y, w, h);

      // Heading arrow (physics axis)
      const arrowLen = 15;
      const ax = blob.cx * sx;
      const ay = blob.cy * sy;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(ax + Math.cos(blob.heading) * arrowLen, ay + Math.sin(blob.heading) * arrowLen);
      ctx.strokeStyle = isCollision ? "#ef4444" : "#ffffff";
      ctx.lineWidth = 2;
      ctx.stroke();

      // ESP info box
      const speedKmh = Math.round(blob.speed * 5); // approximate km/h
      const accelLabel = blob.acceleration < -0.5 ? "BRAKING" : blob.acceleration > 0.5 ? "ACCEL" : "";
      const label = `${blob.class} | ${speedKmh}km/h${accelLabel ? " | " + accelLabel : ""}`;
      ctx.font = "bold 10px Arial";
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = isCollision ? "#ef4444" : "rgba(0,0,0,0.7)";
      ctx.fillRect(x, y - 16, tw + 8, 16);
      ctx.fillStyle = "white";
      ctx.fillText(label, x + 4, y - 4);
    }

    // Bottom bar
    const score = accumRef.current.reduce((a, b) => a + b, 0) / (GRID_COLS * GRID_ROWS);
    const barY = canvas.height - 22;
    ctx.fillStyle = "rgba(0,0,0,0.7)";
    ctx.fillRect(0, barY, canvas.width, 22);
    ctx.fillStyle = score > 0.04 ? "#ef4444" : score > 0.02 ? "#f59e0b" : "#22c55e";
    ctx.fillRect(0, barY, Math.min(score * canvas.width * 5, canvas.width), 22);
    ctx.fillStyle = "white";
    ctx.font = "11px Arial";
    const modeLabel = analysisMode === "traffic" ? "TRAFFIC" : "NORMAL";
    const collisionLabel = collision ? ` | COLLISION: ${collision.evidence}` : "";
    ctx.fillText(`${modeLabel} | Objects: ${tracked.filter(b => b.frames >= 3).length}${collisionLabel}`, 8, barY + 15);
  };

  const createIncident = async (alert: IncidentAlert) => {
    const { data: inc } = await supabase.from("incidents").insert({
      severity: alert.severity, incident_type: alert.type,
      latitude: alert.latitude, longitude: alert.longitude,
      location_name: `Video Analysis: ${selectedClip?.name}`,
      detection_confidence: alert.confidence,
      detection_data: { source: "physics_tracking", clip: selectedClip?.name },
      video_clip_url: selectedClip?.src || null,
      status: "detected",
    }).select().single();

    setIncidents(prev => [...prev, alert]);
    toast.error(`ACCIDENT: ${alert.type.replace(/_/g, " ")} (${alert.severity})`);

    if (inc) {
      supabase.channel("alerts:ambulance").send({
        type: "broadcast", event: "new_incident",
        payload: {
          incident_id: inc.id, severity: alert.severity, incident_type: alert.type,
          latitude: alert.latitude, longitude: alert.longitude, video_clip_url: selectedClip?.src,
          message: `ACCIDENT: ${alert.type.replace(/_/g, " ")}`,
        },
      });
    }
  };

  // ========== MAIN LOOP ==========
  const startAnalysis = async () => {
    if (!videoRef.current || !selectedClip) return;
    const video = videoRef.current;
    try { await video.play(); } catch {
      video.muted = false;
      try { await video.play(); } catch { toast.error("Cannot play video"); return; }
    }

    blobsRef.current = [];
    prevGridRef.current = null;
    accumRef.current.fill(0);
    anomalyHeatmapRef.current.fill(0);
    frameRef.current = 0;
    stateFrameRef.current = 0;
    cooldownRef.current = 0;
    consecutiveAnomalyRef.current = 0;
    stateRef.current = "monitoring";
    nextId = 1;

    setVideoReady(true);
    setIsAnalyzing(true);
    setIncidents([]);
    setState("monitoring");
    setObjectCount(0);

    let prevFrameData: Uint8ClampedArray | null = null;

    const loop = () => {
      try {
        if (!videoRef.current || videoRef.current.paused || videoRef.current.ended) return;

        const tmp = getTmp();
        tmp.width = W; tmp.height = H;
        const ctx = tmp.getContext("2d")!;
        ctx.drawImage(video, 0, 0, W, H);
        const imgData = ctx.getImageData(0, 0, W, H);
        const data = imgData.data;

        frameRef.current++;
        if (cooldownRef.current > 0) cooldownRef.current--;

        // Detect blobs + track with physics
        let tracked: TrackedBlob[] = [];
        if (prevFrameData) {
          const detections = findBlobs(data, prevFrameData, W, H);
          tracked = trackBlobs(detections, frameRef.current);
        }
        prevFrameData = new Uint8ClampedArray(data);

        // Accumulated change
        const grid = toGrayGrid(data, W, H);
        const prev = prevGridRef.current;
        let totalChange = 0;
        for (let i = 0; i < GRID_COLS * GRID_ROWS; i++) {
          const diff = prev ? Math.abs(grid[i] - prev[i]) / 255 : 0;
          accumRef.current[i] = accumRef.current[i] * 0.95 + diff * 3;
          totalChange += accumRef.current[i];
        }
        prevGridRef.current = grid;

        // Physics-based collision detection (runs in BOTH modes)
        const collision = detectPhysicsCollision(tracked);

        // Flow heatmap (traffic mode backup)
        const flowDisruption = analysisMode === "traffic" ? updateFlowHeatmap(tracked) : false;

        const validTracked = tracked.filter(b => b.frames >= 3);
        setObjectCount(validTracked.length);

        // ========== ANOMALY EVIDENCE ==========
        let hasAnomaly = false;
        let anomalyConfidence = 0;
        let anomalyType = "";
        let isCollisionSignal = false; // true only for actual collision evidence (not pre-accident)

        if (collision) {
          // Direct collision: highest priority
          hasAnomaly = true;
          anomalyConfidence = collision.confidence;
          anomalyType = "collision";
          // Check if collision has IMPACT evidence (not just proximity)
          const hasImpact = collision.evidence.includes("sudden_stop") ||
            collision.evidence.includes("shape_change") ||
            collision.evidence.includes("hard_brake");
          isCollisionSignal = hasImpact;
        } else if (flowDisruption && analysisMode === "traffic") {
          hasAnomaly = true;
          anomalyConfidence = 0.6;
          anomalyType = "flow_disruption";
          isCollisionSignal = true; // persistent flow disruption = real event
        } else if (analysisMode === "normal") {
          const avgChange = totalChange / (GRID_COLS * GRID_ROWS);
          if (avgChange > 0.04) {
            hasAnomaly = true;
            anomalyConfidence = Math.min(0.8, avgChange * 8);
            anomalyType = "change";
            isCollisionSignal = avgChange > 0.08; // high change = real event
          }
        }

        const isHighConf = anomalyConfidence > 0.5;

        // Draw
        drawBoxes(tracked, collision);

        // Consecutive tracking — separate counters for general anomaly vs collision signal
        if (hasAnomaly) {
          consecutiveAnomalyRef.current++;
        } else {
          consecutiveAnomalyRef.current = Math.max(0, consecutiveAnomalyRef.current - 1);
        }

        // ========== STATE MACHINE ==========
        // KEY: monitoring→watching→confirming can use ANY anomaly (deceleration, proximity)
        // BUT confirming→alert REQUIRES collision-specific evidence (impact, shape change)
        stateFrameRef.current++;
        let st = stateRef.current;

        if (hasAnomaly && consecutiveAnomalyRef.current >= 3) {
          if (st === "monitoring") st = "watching";
          else if (st === "watching" && consecutiveAnomalyRef.current >= 6) st = "confirming";
          // ALERT: ONLY with collision signal (impact evidence) — not just deceleration
          else if (st === "confirming" && isCollisionSignal && consecutiveAnomalyRef.current >= 8) st = "alert";
        } else if (!demoMode && frameRef.current % 5 === 0) {
          st = st === "alert" ? "confirming" : st === "confirming" ? "watching" : "monitoring";
        }

        if (demoMode) {
          const sf = stateFrameRef.current;
          if (sf === 15 && st === "monitoring") st = "watching";
          if (sf === 25 && st === "watching") st = "confirming";
          if (sf >= 35 && st === "confirming") st = "alert";
        }

        // Fire alert
        if (st === "alert" && stateRef.current !== "alert" && cooldownRef.current <= 0) {
          cooldownRef.current = analysisMode === "traffic" ? 120 : 40;
          consecutiveAnomalyRef.current = 0;
          anomalyHeatmapRef.current.fill(0);

          let incidentType = "vehicle_collision";
          let severity = "major";

          if (collision) {
            const isPed = collision.a.class === "person" || collision.b.class === "person";
            incidentType = isPed ? "pedestrian_collision" : "vehicle_collision";
            severity = collision.confidence > 0.7 ? "critical" : collision.confidence > 0.5 ? "major" : "minor";
          } else if (flowDisruption) {
            incidentType = "traffic_disruption";
            severity = "major";
          } else {
            incidentType = "";
          }

          if (incidentType) {
            createIncident({
              type: incidentType, severity,
              confidence: anomalyConfidence || 0.6,
              timestamp: new Date().toISOString(),
              latitude: LAT + (Math.random() - 0.5) * 0.01,
              longitude: LNG + (Math.random() - 0.5) * 0.01,
            });
            setTimeout(() => { stateRef.current = "monitoring"; stateFrameRef.current = 0; setState("monitoring"); }, 8000);
          } else {
            stateRef.current = "monitoring";
            stateFrameRef.current = 0;
            setState("monitoring");
          }
        }

        stateRef.current = st;
        setState(st);
      } catch (e) { console.error(e); }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
  };

  const stopAnalysis = () => {
    cancelAnimationFrame(rafRef.current);
    if (videoRef.current) { videoRef.current.pause(); videoRef.current.currentTime = 0; }
    setIsAnalyzing(false);
    setState("monitoring");
    stateRef.current = "monitoring";
  };

  const resetClip = () => {
    stopAnalysis();
    setIncidents([]);
    blobsRef.current = [];
    prevGridRef.current = null;
    accumRef.current.fill(0);
    anomalyHeatmapRef.current.fill(0);
    frameRef.current = 0;
    stateFrameRef.current = 0;
    cooldownRef.current = 0;
    consecutiveAnomalyRef.current = 0;
    setObjectCount(0);
  };

  const stateColors: Record<string, string> = {
    monitoring: "bg-green-500/20 text-green-500",
    watching: "bg-yellow-500/20 text-yellow-500",
    confirming: "bg-orange-500/20 text-orange-500",
    alert: "bg-red-500/20 text-red-500 animate-pulse",
  };

  return (
    <div className="space-y-6">
      <Link href="/admin" className="inline-flex items-center gap-2 text-muted-foreground hover:text-foreground">
        <ArrowLeft size={16} /> Back to Admin
      </Link>
      <div>
        <h1 className="text-2xl font-bold">Video Analysis</h1>
        <p className="text-muted-foreground">Physics-based object tracking + ESP vehicle telemetry</p>
      </div>

      {!selectedClip ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {VIDEO_CLIPS.map(clip => (
            <button key={clip.name} onClick={() => setSelectedClip(clip)}
              className="bg-card p-5 rounded-xl border border-border hover:border-primary/50 transition-colors text-left">
              <div className="flex items-start gap-4">
                <div className="w-16 h-16 bg-background rounded-lg flex items-center justify-center shrink-0">
                  <Video className="w-8 h-8 text-primary" />
                </div>
                <div>
                  <h3 className="font-semibold">{clip.name}</h3>
                  <p className="text-sm text-muted-foreground mt-1">{clip.description}</p>
                </div>
              </div>
            </button>
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          <button onClick={() => { resetClip(); setSelectedClip(null); setVideoReady(false); }}
            className="text-sm text-primary hover:underline">&larr; Choose different clip</button>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2">
              <div className="bg-card rounded-xl border border-border overflow-hidden">
                <div className="aspect-video bg-black relative">
                  <video ref={videoRef} src={selectedClip.src} className="w-full h-full object-contain"
                    playsInline muted loop onLoadedData={() => setVideoReady(true)} onCanPlay={() => setVideoReady(true)} />
                  <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" style={{ pointerEvents: "none" }} />
                  {!videoReady && <div className="absolute inset-0 flex items-center justify-center bg-black/50">
                    <div className="flex items-center gap-2 text-white"><Loader2 className="w-5 h-5 animate-spin" /> Loading...</div>
                  </div>}
                  {isAnalyzing && <div className="absolute top-4 left-4 flex items-center gap-2">
                    <div className="w-3 h-3 bg-red-500 rounded-full animate-pulse" />
                    <span className="text-sm font-medium bg-black/60 px-2 py-1 rounded">Tracking {objectCount} objects</span>
                  </div>}
                </div>
                <div className="p-4 border-t border-border flex items-center gap-3 flex-wrap">
                  {!isAnalyzing ? (
                    <button onClick={startAnalysis} disabled={!videoReady}
                      className="px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors flex items-center gap-2 disabled:opacity-50">
                      {videoReady ? <><Play size={16} /> Start Analysis</> : <><Loader2 size={16} className="animate-spin" /> Loading...</>}
                    </button>
                  ) : (
                    <>
                      <button onClick={stopAnalysis} className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors flex items-center gap-2"><Pause size={16} /> Stop</button>
                      <button onClick={resetClip} className="px-4 py-2 bg-card border border-border rounded-lg hover:bg-background transition-colors flex items-center gap-2"><RotateCcw size={16} /> Reset</button>
                    </>
                  )}
                  <label className="flex items-center gap-2 text-sm cursor-pointer select-none ml-auto">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${demoMode ? "bg-yellow-500/20 text-yellow-500" : "bg-green-500/20 text-green-500"}`}>{demoMode ? "DEMO" : "REAL"}</span>
                    <div onClick={() => setDemoMode(!demoMode)} className={`w-10 h-5 rounded-full transition-colors relative cursor-pointer ${demoMode ? "bg-yellow-500" : "bg-green-600"}`}>
                      <div className={`w-4 h-4 bg-white rounded-full absolute top-0.5 transition-transform ${demoMode ? "translate-x-5" : "translate-x-0.5"}`} />
                    </div>
                    <span className="text-muted-foreground">|</span>
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${analysisMode === "traffic" ? "bg-orange-500/20 text-orange-500" : "bg-blue-500/20 text-blue-500"}`}>
                      {analysisMode === "traffic" ? "TRAFFIC" : "NORMAL"}
                    </span>
                    <div onClick={() => setAnalysisMode(analysisMode === "normal" ? "traffic" : "normal")}
                      className={`w-10 h-5 rounded-full transition-colors relative cursor-pointer ${analysisMode === "traffic" ? "bg-orange-500" : "bg-blue-600"}`}>
                      <div className={`w-4 h-4 bg-white rounded-full absolute top-0.5 transition-transform ${analysisMode === "traffic" ? "translate-x-5" : "translate-x-0.5"}`} />
                    </div>
                    <span className="text-muted-foreground">{selectedClip.name}</span>
                  </label>
                </div>
              </div>
            </div>

            <div className="space-y-4">
              {/* State Machine */}
              <div className="bg-card p-4 rounded-xl border border-border">
                <h3 className="font-semibold mb-3 flex items-center gap-2"><AlertTriangle size={16} /> Detection State</h3>
                <div className="space-y-2">
                  {["monitoring", "watching", "confirming", "alert"].map(s => (
                    <div key={s} className={`flex items-center gap-2 p-2 rounded ${state === s ? stateColors[s] : "text-muted-foreground"}`}>
                      <div className={`w-2 h-2 rounded-full ${state === s ? "bg-current animate-pulse" : "bg-border"}`} />
                      <span className="text-sm capitalize">{s}</span>
                    </div>
                  ))}
                </div>
                {cooldownRef.current > 0 && (
                  <div className="mt-2 text-xs text-muted-foreground">Cooldown: {cooldownRef.current} frames</div>
                )}
              </div>

              {/* Change Detection Grid */}
              <div className="bg-card p-4 rounded-xl border border-border">
                <h3 className="font-semibold mb-3 flex items-center gap-2">
                  <Zap size={16} /> Change Detection
                </h3>
                <p className="text-xs text-muted-foreground mb-2">Region-level pixel change (accumulated)</p>
                <div className="grid gap-px" style={{ gridTemplateColumns: `repeat(${GRID_COLS}, 1fr)` }}>
                  {Array.from(accumRef.current).map((v, i) => (
                    <div key={i} className="aspect-square rounded-sm" style={{
                      backgroundColor: v > 0.08 ? `rgb(${Math.min(255, Math.floor(v * 2000))},0,0)` :
                        v > 0.03 ? `rgb(${Math.min(255, Math.floor(v * 1500))},${Math.floor(v * 500)},0)` :
                          `rgb(0,${Math.min(255, Math.floor(v * 3000))},0)`
                    }} />
                  ))}
                </div>
                <div className="flex justify-between text-xs text-muted-foreground mt-1">
                  <span>Green = calm</span>
                  <span>Red = high change</span>
                </div>
              </div>

              {/* Anomaly Heatmap */}
              <div className="bg-card p-4 rounded-xl border border-border">
                <h3 className="font-semibold mb-3 flex items-center gap-2">
                  <AlertTriangle size={16} /> Anomaly Heatmap
                </h3>
                <p className="text-xs text-muted-foreground mb-2">Persistent anomaly cells (red = sustained anomaly)</p>
                <div className="grid gap-px" style={{ gridTemplateColumns: `repeat(${GRID_COLS}, 1fr)` }}>
                  {Array.from(anomalyHeatmapRef.current).map((v, i) => (
                    <div key={i} className="aspect-square rounded-sm" style={{
                      backgroundColor: v > 8 ? `rgba(255,0,0,${Math.min(v / 15, 1)})` :
                        v > 4 ? `rgba(255,165,0,${v / 10})` :
                          v > 1 ? `rgba(255,255,0,${v / 5})` : "rgba(255,255,255,0.05)"
                    }} />
                  ))}
                </div>
                <div className="flex justify-between text-xs text-muted-foreground mt-1">
                  <span>Threshold: 6 frames</span>
                  <span>Cluster: 3+ cells</span>
                </div>
              </div>

              {/* Collision Status */}
              <div className="bg-card p-4 rounded-xl border border-border">
                <h3 className="font-semibold mb-3 flex items-center gap-2">
                  <AlertTriangle size={16} /> Collision Detection
                </h3>
                {(() => {
                  const collision = detectPhysicsCollision(blobsRef.current);
                  if (!collision) return <p className="text-sm text-green-400">No collision detected</p>;
                  return (
                    <div className="space-y-2">
                      <div className="p-2 bg-red-500/10 border border-red-500/30 rounded">
                        <div className="text-sm font-medium text-red-400">COLLISION DETECTED</div>
                        <div className="text-xs text-muted-foreground mt-1">
                          Confidence: {(collision.confidence * 100).toFixed(0)}%
                        </div>
                        <div className="text-xs text-muted-foreground">
                          Evidence: {collision.evidence}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          Objects: #{collision.a.id} ({collision.a.class}) + #{collision.b.id} ({collision.b.class})
                        </div>
                      </div>
                    </div>
                  );
                })()}
              </div>

              {/* ESP Vehicle Telemetry */}
              <div className="bg-card p-4 rounded-xl border border-border">
                <h3 className="font-semibold mb-3 flex items-center gap-2"><Zap size={16} /> Vehicle ESP</h3>
                <div className="space-y-2 max-h-60 overflow-y-auto">
                  {(() => {
                    const valid = blobsRef.current.filter(b => b.frames >= 3);
                    if (valid.length === 0) return <p className="text-sm text-muted-foreground">{isAnalyzing ? "Scanning..." : "Start analysis"}</p>;
                    return valid.map(b => {
                      const speedKmh = Math.round(b.speed * 5);
                      const accelLabel = b.acceleration < -0.5 ? "BRAKE" : b.acceleration > 0.5 ? "ACC" : "CRUISE";
                      const accelColor = b.acceleration < -0.5 ? "text-red-400" : b.acceleration > 0.5 ? "text-green-400" : "text-gray-400";
                      return (
                        <div key={b.id} className="p-2 bg-background rounded text-xs space-y-1">
                          <div className="flex items-center justify-between">
                            <span className={`font-medium ${b.class === "car" ? "text-green-400" : b.class === "bike" ? "text-yellow-400" : "text-blue-400"}`}>{b.class} #{b.id}</span>
                            <span className={accelColor}>{accelLabel}</span>
                          </div>
                          <div className="flex gap-3 text-muted-foreground">
                            <span>{speedKmh} km/h</span>
                            <span>a:{b.acceleration.toFixed(1)}</span>
                            <span>θ:{Math.round(b.heading * 180 / Math.PI)}°</span>
                          </div>
                          <div className="flex gap-3 text-muted-foreground">
                            <span>AR:{b.aspectRatio.toFixed(2)}</span>
                            <span>brake:{b.decelFrames}f</span>
                            <span>pos:({Math.round(b.cx)},{Math.round(b.cy)})</span>
                          </div>
                        </div>
                      );
                    });
                  })()}
                </div>
              </div>

              {/* Incidents */}
              <div className="bg-card p-4 rounded-xl border border-border">
                <h3 className="font-semibold mb-3">Incidents</h3>
                {incidents.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{isAnalyzing ? "Monitoring..." : "None"}</p>
                ) : incidents.map((inc, i) => (
                  <div key={i} className={`p-3 rounded-lg border-l-4 mb-2 ${inc.severity === "critical" ? "border-red-500 bg-red-500/10" : "border-orange-500 bg-orange-500/10"}`}>
                    <div className="flex items-center gap-2">
                      <AlertTriangle size={14} className="text-red-500" />
                      <span className="text-sm font-medium capitalize">{inc.type.replace(/_/g, " ")}</span>
                    </div>
                    <div className="flex gap-3 mt-1 text-xs text-muted-foreground">
                      <span>{(inc.confidence * 100).toFixed(0)}%</span>
                      <span className="flex items-center gap-1"><Clock size={10} />{new Date(inc.timestamp).toLocaleTimeString()}</span>
                    </div>
                    <Link href="/ambulance" className="mt-1 inline-flex items-center gap-1 text-xs text-primary hover:underline">
                      <Navigation size={10} /> Ambulance Dashboard
                    </Link>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

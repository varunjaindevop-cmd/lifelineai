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

// Per-cell flow data
interface FlowCell {
  vx: number; vy: number; speed: number;
  magHistory: number[];     // last N magnitudes for deceleration detection
  angleHistory: number[];   // last N angles for direction change
  stagnation: number;       // frames this cell has been near-zero
}

// Detection result from flow analysis
interface FlowAnomaly {
  type: "collision" | "pile_up" | "sudden_stop" | "direction_chaos";
  confidence: number;
  cx: number; cy: number;   // center of anomaly in grid coords
  evidence: string;
}

const VIDEO_CLIPS: VideoClip[] = [
  { name: "accident_sample.mp4", src: "/videos/accident_sample.mp4", description: "Vehicle collision" },
  { name: "camera2_demo.mp4", src: "/videos/camera2_demo.mp4", description: "Traffic monitoring" },
  { name: "camera4_demo.mp4", src: "/videos/camera4_demo.mp4", description: "Intersection monitoring" },
  { name: "checking.mp4", src: "/videos/checking.mp4", description: "System check" },
];

const LAT = 22.7196, LNG = 75.8577;
const W = 320, H = 240;
// Flow grid dimensions — 10x8 = 80 cells for dense motion analysis
const GRID_COLS = 10, GRID_ROWS = 8;
const CELL_W = W / GRID_COLS, CELL_H = H / GRID_ROWS;
const HISTORY_LEN = 8; // frames of velocity history per cell

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
  const stateRef = useRef("monitoring");
  const frameRef = useRef(0);
  const stateFrameRef = useRef(0);
  const cooldownRef = useRef(0);
  const prevGridRef = useRef<Float32Array | null>(null);
  const accumRef = useRef<Float32Array>(new Float32Array(GRID_COLS * GRID_ROWS));
  const consecutiveAnomalyRef = useRef(0);
  const supabase = createClient();

  // ========== OPTICAL FLOW GRID ==========
  // Persistent flow state across frames
  const flowGridRef = useRef<FlowCell[][]>([]);

  const initFlowGrid = () => {
    const grid: FlowCell[][] = [];
    for (let r = 0; r < GRID_ROWS; r++) {
      grid[r] = [];
      for (let c = 0; c < GRID_COLS; c++) {
        grid[r][c] = {
          vx: 0, vy: 0, speed: 0,
          magHistory: [], angleHistory: [], stagnation: 0,
        };
      }
    }
    flowGridRef.current = grid;
  };

  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);
  useEffect(() => { setVideoReady(false); const t = setTimeout(() => setVideoReady(true), 8000); return () => clearTimeout(t); }, [selectedClip]);

  const getTmp = useCallback(() => {
    if (!tmpCanvasRef.current) tmpCanvasRef.current = document.createElement("canvas");
    return tmpCanvasRef.current;
  }, []);

  // ========== DENSE OPTICAL FLOW (Block Matching) ==========
  // For each grid cell, find the best matching region in the previous frame
  // within a search window. Returns velocity vector (vx, vy).
  const computeFlowGrid = (
    currGray: Float32Array, prevGray: Float32Array, w: number, h: number
  ): { vx: number; vy: number; mag: number }[][] => {
    const result: { vx: number; vy: number; mag: number }[][] = [];
    const searchR = 8; // search window radius in pixels
    const blockSize = 4; // compare blocks of 4x4

    for (let r = 0; r < GRID_ROWS; r++) {
      result[r] = [];
      for (let c = 0; c < GRID_COLS; c++) {
        const cx = Math.floor((c + 0.5) * CELL_W);
        const cy = Math.floor((r + 0.5) * CELL_H);

        // Sample block around cell center from current frame
        let bestDx = 0, bestDy = 0, bestErr = Infinity;

        for (let dy = -searchR; dy <= searchR; dy += 2) {
          for (let dx = -searchR; dx <= searchR; dx += 2) {
            let err = 0, count = 0;
            for (let by = -blockSize; by <= blockSize; by += 2) {
              for (let bx = -blockSize; bx <= blockSize; bx += 2) {
                const sx = cx + bx, sy = cy + by;
                const tx = sx + dx, ty = sy + dy;
                if (sx < 0 || sx >= w || sy < 0 || sy >= h) continue;
                if (tx < 0 || tx >= w || ty < 0 || ty >= h) continue;
                const si = sy * w + sx;
                const ti = ty * w + tx;
                const diff = currGray[si] - prevGray[ti];
                err += diff * diff;
                count++;
              }
            }
            if (count > 0) {
              err /= count;
              if (err < bestErr) {
                bestErr = err;
                bestDx = dx;
                bestDy = dy;
              }
            }
          }
        }

        const mag = Math.sqrt(bestDx * bestDx + bestDy * bestDy);
        result[r][c] = { vx: bestDx, vy: bestDy, mag };
      }
    }
    return result;
  };

  // Convert frame to grayscale grid (for flow computation and change detection)
  const toGrayGrid = (data: Uint8ClampedArray, w: number, h: number): Float32Array => {
    const g = new Float32Array(GRID_COLS * GRID_ROWS);
    const cw = Math.floor(w / GRID_COLS), ch = Math.floor(h / GRID_ROWS);
    for (let r = 0; r < GRID_ROWS; r++) {
      for (let c = 0; c < GRID_COLS; c++) {
        let s = 0, n = 0;
        for (let dy = 0; dy < ch; dy += 2) {
          for (let dx = 0; dx < cw; dx += 2) {
            const i = ((r * ch + dy) * w + (c * cw + dx)) * 4;
            s += data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
            n++;
          }
        }
        g[r * GRID_COLS + c] = n > 0 ? s / n : 128;
      }
    }
    return g;
  };

  // ========== FLOW-BASED ANOMALY DETECTION ==========
  // The core engine: analyzes the motion field to detect accidents.
  // No object classification needed — pure motion mathematics.
  const analyzeFlowAnomalies = (
    flow: { vx: number; vy: number; mag: number }[][],
    tracked: { cx: number; cy: number; w: number; h: number; frames: number }[]
  ): FlowAnomaly[] => {
    const anomalies: FlowAnomaly[] = [];
    const grid = flowGridRef.current;
    const totalCells = GRID_COLS * GRID_ROWS;

    // Update per-cell history
    let totalMag = 0, movingCells = 0, stoppedCells = 0;
    for (let r = 0; r < GRID_ROWS; r++) {
      for (let c = 0; c < GRID_COLS; c++) {
        const cell = grid[r][c];
        const f = flow[r][c];
        cell.vx = f.vx;
        cell.vy = f.vy;
        cell.speed = f.mag;
        cell.magHistory.push(f.mag);
        if (cell.magHistory.length > HISTORY_LEN) cell.magHistory.shift();
        cell.angleHistory.push(Math.atan2(f.vy, f.vx));
        if (cell.angleHistory.length > HISTORY_LEN) cell.angleHistory.shift();

        // Track stagnation
        if (f.mag < 0.8) {
          cell.stagnation = Math.min(cell.stagnation + 1, 30);
        } else {
          cell.stagnation = Math.max(0, cell.stagnation - 1);
        }

        totalMag += f.mag;
        if (f.mag > 1.5) movingCells++;
        if (f.mag < 0.5) stoppedCells++;
      }
    }

    const avgMag = totalMag / totalCells;
    if (avgMag < 0.3 || movingCells < 3) return anomalies; // too little motion to analyze

    // ===== ANOMALY 1: CONVERGENCE ZONE =====
    // Cells where neighbors' flow vectors point TOWARD this cell
    // = vehicles crashing into each other
    let maxConvergeScore = 0;
    let convergeR = 0, convergeC = 0;
    for (let r = 1; r < GRID_ROWS - 1; r++) {
      for (let c = 1; c < GRID_COLS - 1; c++) {
        const cell = grid[r][c];
        if (cell.speed > 2) continue; // this cell is moving fast, not a collision point
        let convergeScore = 0;
        let neighborsWithMotion = 0;

        for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[-1,1],[1,-1],[1,1]]) {
          const nr = r + dr, nc = c + dc;
          if (nr < 0 || nr >= GRID_ROWS || nc < 0 || nc >= GRID_COLS) continue;
          const neighbor = grid[nr][nc];
          if (neighbor.speed < 0.8) continue; // static neighbor, ignore
          neighborsWithMotion++;

          // Does this neighbor's velocity point toward cell (r,c)?
          const toCenterX = (c - nc) * CELL_W;
          const toCenterY = (r - nr) * CELL_H;
          const toCenterMag = Math.sqrt(toCenterX * toCenterX + toCenterY * toCenterY);
          if (toCenterMag < 1) continue;
          const dot = neighbor.vx * toCenterX + neighbor.vy * toCenterY;
          const cosAngle = dot / (neighbor.speed * toCenterMag);
          if (cosAngle > 0.3) convergeScore += cosAngle;
        }

        // Need multiple neighbors pointing inward AND this cell should be slow/stopped
        if (convergeScore > maxConvergeScore && neighborsWithMotion >= 2 && cell.speed < avgMag * 0.5) {
          maxConvergeScore = convergeScore;
          convergeR = r; convergeC = c;
        }
      }
    }
    if (maxConvergeScore > 1.5 && movingCells >= 4) {
      const conf = Math.min(0.95, 0.3 + maxConvergeScore * 0.15 + (movingCells > 6 ? 0.1 : 0));
      anomalies.push({
        type: "collision", confidence: conf,
        cx: convergeC, cy: convergeR,
        evidence: `Convergence score: ${maxConvergeScore.toFixed(1)}, moving cells: ${movingCells}`,
      });
    }

    // ===== ANOMALY 2: SUDDEN STOP (Deceleration Ring) =====
    // Cells that were moving fast recently but are now stopped
    // = vehicles that just crashed and stopped
    let suddenStopCount = 0;
    let stopR = 0, stopC = 0;
    for (let r = 0; r < GRID_ROWS; r++) {
      for (let c = 0; c < GRID_COLS; c++) {
        const cell = grid[r][c];
        if (cell.magHistory.length < 4) continue;
        const recentAvg = (cell.magHistory[cell.magHistory.length - 1] + cell.magHistory[cell.magHistory.length - 2]) / 2;
        const prevAvg = (cell.magHistory[0] + cell.magHistory[1]) / 2;
        // Was moving (prevAvg > 2), now stopped (recentAvg < 0.8)
        if (prevAvg > 2.0 && recentAvg < 0.8) {
          suddenStopCount++;
          if (suddenStopCount === 1 || cell.stagnation > grid[stopR][stopC].stagnation) {
            stopR = r; stopC = c;
          }
        }
      }
    }
    if (suddenStopCount >= 2) {
      const conf = Math.min(0.9, 0.25 + suddenStopCount * 0.12);
      anomalies.push({
        type: "sudden_stop", confidence: conf,
        cx: stopC, cy: stopR,
        evidence: `${suddenStopCount} cells decelerated suddenly`,
      });
    }

    // ===== ANOMALY 3: FLOW DISCONTINUITY =====
    // Sharp boundary between fast-moving and stopped regions
    // = accident blocking part of the road while traffic flows around it
    let maxDiscontinuity = 0;
    let discR = 0, discC = 0;
    for (let r = 1; r < GRID_ROWS - 1; r++) {
      for (let c = 1; c < GRID_COLS - 1; c++) {
        const cell = grid[r][c];
        let maxNeighborDiff = 0;
        for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]]) {
          const nr = r + dr, nc = c + dc;
          const neighbor = grid[nr][nc];
          const diff = Math.abs(cell.speed - neighbor.speed);
          // Also check direction opposition
          const dot = cell.vx * neighbor.vx + cell.vy * neighbor.vy;
          const isOpposite = dot < 0 && cell.speed > 1 && neighbor.speed > 1;
          const effectiveDiff = isOpposite ? diff + 3 : diff; // boost score for opposite directions
          if (effectiveDiff > maxNeighborDiff) maxNeighborDiff = effectiveDiff;
        }
        if (maxNeighborDiff > maxDiscontinuity) {
          maxDiscontinuity = maxNeighborDiff;
          discR = r; discC = c;
        }
      }
    }
    if (maxDiscontinuity > 5 && movingCells >= 3 && stoppedCells >= 2) {
      const conf = Math.min(0.85, 0.2 + maxDiscontinuity * 0.08);
      anomalies.push({
        type: "pile_up", confidence: conf,
        cx: discC, cy: discR,
        evidence: `Flow discontinuity: ${maxDiscontinuity.toFixed(1)}, stopped: ${stoppedCells}`,
      });
    }

    // ===== ANOMALY 4: DIRECTION CHAOS =====
    // High variance in flow directions across the grid
    // = vehicles scattering in different directions (post-accident panic)
    let angleVariance = 0;
    let fastCellAngles: number[] = [];
    for (let r = 0; r < GRID_ROWS; r++) {
      for (let c = 0; c < GRID_COLS; c++) {
        const cell = grid[r][c];
        if (cell.speed > 1.5 && cell.angleHistory.length >= 3) {
          // Check direction stability — is this cell suddenly changing direction?
          const recentAngle = cell.angleHistory[cell.angleHistory.length - 1];
          const prevAngle = cell.angleHistory[cell.angleHistory.length - 3];
          let angleDiff = Math.abs(recentAngle - prevAngle);
          if (angleDiff > Math.PI) angleDiff = 2 * Math.PI - angleDiff;
          if (angleDiff > Math.PI * 0.5) angleVariance += angleDiff;
          fastCellAngles.push(recentAngle);
        }
      }
    }
    // Also check spatial angle variance (are nearby fast cells going in opposite directions?)
    let spatialChaos = 0;
    for (let r = 0; r < GRID_ROWS; r++) {
      for (let c = 0; c < GRID_COLS; c++) {
        const cell = grid[r][c];
        if (cell.speed < 1.5) continue;
        for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]]) {
          const nr = r + dr, nc = c + dc;
          if (nr < 0 || nr >= GRID_ROWS || nc < 0 || nc >= GRID_COLS) continue;
          const neighbor = grid[nr][nc];
          if (neighbor.speed < 1.5) continue;
          const dot = cell.vx * neighbor.vx + cell.vy * neighbor.vy;
          const mag = cell.speed * neighbor.speed;
          if (mag > 0 && dot / mag < -0.3) spatialChaos++;
        }
      }
    }
    if ((angleVariance > 3.0 || spatialChaos >= 3) && fastCellAngles.length >= 3) {
      const conf = Math.min(0.85, 0.2 + (angleVariance * 0.08) + (spatialChaos * 0.05));
      anomalies.push({
        type: "direction_chaos", confidence: conf,
        cx: Math.floor(GRID_COLS / 2), cy: Math.floor(GRID_ROWS / 2),
        evidence: `Angle variance: ${angleVariance.toFixed(1)}, spatial chaos: ${spatialChaos}`,
      });
    }

    // Sort by confidence
    anomalies.sort((a, b) => b.confidence - a.confidence);
    return anomalies;
  };

  // ========== NORMAL MODE: ACCUMULATED CHANGE ==========
  // Simple grid-based change detection for isolated roads
  const computeAccumChange = (grid: Float32Array): { score: number; anomalies: FlowAnomaly[] } => {
    const prev = prevGridRef.current;
    let totalChange = 0;
    for (let i = 0; i < GRID_COLS * GRID_ROWS; i++) {
      const diff = prev ? Math.abs(grid[i] - prev[i]) / 255 : 0;
      accumRef.current[i] = accumRef.current[i] * 0.95 + diff * 3;
      totalChange += accumRef.current[i];
    }
    prevGridRef.current = grid;
    const score = totalChange / (GRID_COLS * GRID_ROWS);

    const anomalies: FlowAnomaly[] = [];
    if (score > 0.04) {
      // Find the cell with highest accumulated change
      let maxCell = 0, maxVal = 0;
      for (let i = 0; i < GRID_COLS * GRID_ROWS; i++) {
        if (accumRef.current[i] > maxVal) { maxVal = accumRef.current[i]; maxCell = i; }
      }
      anomalies.push({
        type: "collision", confidence: Math.min(0.8, score * 8),
        cx: maxCell % GRID_COLS, cy: Math.floor(maxCell / GRID_COLS),
        evidence: `Accumulated change: ${(score * 100).toFixed(1)}%`,
      });
    }
    return { score, anomalies };
  };

  // Draw flow visualization on canvas
  const drawFlowViz = (
    flow: { vx: number; vy: number; mag: number }[][] | null,
    anomalies: FlowAnomaly[]
  ) => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const sx = canvas.width / W, sy = canvas.height / H;

    if (flow && analysisMode === "traffic") {
      // Draw flow arrows
      for (let r = 0; r < GRID_ROWS; r++) {
        for (let c = 0; c < GRID_COLS; c++) {
          const f = flow[r][c];
          if (f.mag < 0.5) continue;
          const cx = (c + 0.5) * CELL_W * sx;
          const cy = (r + 0.5) * CELL_H * sy;
          const scale = 3;
          const ex = cx + f.vx * scale;
          const ey = cy + f.vy * scale;

          // Color by speed: green=fast, yellow=medium, red=slow/stopped
          const speedRatio = Math.min(f.mag / 5, 1);
          const hue = speedRatio * 120; // 0=red, 120=green
          ctx.strokeStyle = `hsla(${hue}, 80%, 50%, 0.6)`;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(ex, ey);
          ctx.stroke();
        }
      }
    }

    // Highlight anomaly cells
    for (const a of anomalies) {
      const x = a.cx * CELL_W * sx;
      const y = a.cy * CELL_H * sy;
      const w = CELL_W * sx;
      const h = CELL_H * sy;
      const color = a.type === "collision" ? "#ef4444"
        : a.type === "sudden_stop" ? "#f59e0b"
        : a.type === "pile_up" ? "#f97316"
        : "#8b5cf6";
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.strokeRect(x, y, w, h);
      ctx.fillStyle = `${color}33`;
      ctx.fillRect(x, y, w, h);
    }

    // Score bar
    const score = accumRef.current.reduce((a, b) => a + b, 0) / (GRID_COLS * GRID_ROWS);
    const barY = canvas.height - 22;
    ctx.fillStyle = "rgba(0,0,0,0.7)";
    ctx.fillRect(0, barY, canvas.width, 22);
    ctx.fillStyle = score > 0.04 ? "#ef4444" : score > 0.02 ? "#f59e0b" : "#22c55e";
    ctx.fillRect(0, barY, Math.min(score * canvas.width * 5, canvas.width), 22);
    ctx.fillStyle = "white";
    ctx.font = "11px Arial";
    const modeLabel = analysisMode === "traffic" ? "TRAFFIC" : "NORMAL";
    const anomalyLabel = anomalies.length > 0 ? ` | ${anomalies[0].type.toUpperCase()}` : "";
    ctx.fillText(`${modeLabel} | Objects: ${objectCount} | Change: ${(score * 100).toFixed(1)}%${anomalyLabel}`, 8, barY + 15);
  };

  const createIncident = async (alert: IncidentAlert) => {
    const { data: inc } = await supabase.from("incidents").insert({
      severity: alert.severity, incident_type: alert.type,
      latitude: alert.latitude, longitude: alert.longitude,
      location_name: `Video Analysis: ${selectedClip?.name}`,
      detection_confidence: alert.confidence,
      detection_data: { source: "optical_flow", clip: selectedClip?.name },
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

  // ========== MAIN ANALYSIS LOOP ==========
  const startAnalysis = async () => {
    if (!videoRef.current || !selectedClip) return;
    const video = videoRef.current;
    try { await video.play(); } catch {
      video.muted = false;
      try { await video.play(); } catch { toast.error("Cannot play video"); return; }
    }

    // Reset all state
    prevGridRef.current = null;
    accumRef.current.fill(0);
    frameRef.current = 0;
    stateFrameRef.current = 0;
    cooldownRef.current = 0;
    consecutiveAnomalyRef.current = 0;
    stateRef.current = "monitoring";
    initFlowGrid();

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

        // Convert to grayscale for flow computation
        const currGray = toGrayGrid(data, W, H);

        // Compute dense optical flow
        let flow: { vx: number; vy: number; mag: number }[][] | null = null;
        let anomalies: FlowAnomaly[] = [];

        if (prevFrameData) {
          const prevGray = toGrayGrid(new Uint8ClampedArray(
            // Convert prev frame data to grayscale grid
            (() => {
              const prev = prevFrameData!;
              const g = new Float32Array(GRID_COLS * GRID_ROWS);
              const cw = Math.floor(W / GRID_COLS), ch = Math.floor(H / GRID_ROWS);
              for (let r = 0; r < GRID_ROWS; r++) for (let c = 0; c < GRID_COLS; c++) {
                let s = 0, n = 0;
                for (let dy = 0; dy < ch; dy += 2) for (let dx = 0; dx < cw; dx += 2) {
                  const i = ((r * ch + dy) * W + (c * cw + dx)) * 4;
                  s += prev[i] * 0.299 + prev[i + 1] * 0.587 + prev[i + 2] * 0.114; n++;
                }
                g[r * GRID_COLS + c] = n > 0 ? s / n : 128;
              }
              return g;
            })()
          ), W, H);

          flow = computeFlowGrid(currGray, prevGray, W, H);

          if (analysisMode === "traffic") {
            // Traffic mode: use optical flow anomaly detection
            anomalies = analyzeFlowAnomalies(flow, []);
          } else {
            // Normal mode: use accumulated change
            const { anomalies: accAnomalies } = computeAccumChange(currGray);
            anomalies = accAnomalies;
          }
        }
        prevFrameData = new Uint8ClampedArray(data);

        // Count moving objects (cells with motion)
        let movingCount = 0;
        if (flow) {
          for (let r = 0; r < GRID_ROWS; r++)
            for (let c = 0; c < GRID_COLS; c++)
              if (flow[r][c].mag > 1.5) movingCount++;
        }
        setObjectCount(movingCount);

        // Draw visualization
        drawFlowViz(flow, anomalies);

        // ========== STATE MACHINE ==========
        const hasAnomaly = anomalies.length > 0 && anomalies[0].confidence > 0.3;
        const topConfidence = anomalies.length > 0 ? anomalies[0].confidence : 0;
        const isHighConf = topConfidence > 0.5;

        if (hasAnomaly) {
          consecutiveAnomalyRef.current++;
        } else {
          consecutiveAnomalyRef.current = Math.max(0, consecutiveAnomalyRef.current - 1);
        }

        stateFrameRef.current++;
        let st = stateRef.current;

        // Unified state machine — works for both modes
        // The difference is in thresholds, not logic
        if (hasAnomaly && consecutiveAnomalyRef.current >= 3) {
          if (st === "monitoring") st = "watching";
          else if (st === "watching" && consecutiveAnomalyRef.current >= (isHighConf ? 3 : 6)) st = "confirming";
          else if (st === "confirming" && consecutiveAnomalyRef.current >= (isHighConf ? 6 : 12)) st = "alert";
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
          cooldownRef.current = analysisMode === "traffic" ? 80 : 40;
          consecutiveAnomalyRef.current = 0;

          const topAnomaly = anomalies[0];
          let incidentType = "vehicle_collision";
          let severity = "major";

          if (topAnomaly) {
            switch (topAnomaly.type) {
              case "collision":
                incidentType = "vehicle_collision";
                severity = topAnomaly.confidence > 0.7 ? "critical" : "major";
                break;
              case "sudden_stop":
                incidentType = "vehicle_collision";
                severity = "major";
                break;
              case "pile_up":
                incidentType = "vehicle_collision";
                severity = topAnomaly.confidence > 0.6 ? "critical" : "major";
                break;
              case "direction_chaos":
                incidentType = "traffic_disruption";
                severity = "major";
                break;
            }
          }

          createIncident({
            type: incidentType, severity,
            confidence: topConfidence || 0.6,
            timestamp: new Date().toISOString(),
            latitude: LAT + (Math.random() - 0.5) * 0.01,
            longitude: LNG + (Math.random() - 0.5) * 0.01,
          });
          setTimeout(() => { stateRef.current = "monitoring"; stateFrameRef.current = 0; setState("monitoring"); }, 8000);
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
    prevGridRef.current = null;
    accumRef.current.fill(0);
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
        <p className="text-muted-foreground">Optical flow analysis + motion field anomaly detection</p>
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
                    <span className="text-sm font-medium bg-black/60 px-2 py-1 rounded">Tracking {objectCount} regions</span>
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
              <div className="bg-card p-4 rounded-xl border border-border">
                <h3 className="font-semibold mb-3 flex items-center gap-2"><AlertTriangle size={16} /> State</h3>
                <div className="space-y-2">
                  {["monitoring", "watching", "confirming", "alert"].map(s => (
                    <div key={s} className={`flex items-center gap-2 p-2 rounded ${state === s ? stateColors[s] : "text-muted-foreground"}`}>
                      <div className={`w-2 h-2 rounded-full ${state === s ? "bg-current animate-pulse" : "bg-border"}`} />
                      <span className="text-sm capitalize">{s}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="bg-card p-4 rounded-xl border border-border">
                <h3 className="font-semibold mb-3 flex items-center gap-2">
                  <Zap size={16} />
                  {analysisMode === "traffic" ? "Flow Analysis" : "Change Detection"}
                </h3>
                {analysisMode === "traffic" ? (
                  <div className="text-sm text-muted-foreground space-y-1">
                    <p>Dense optical flow with block matching</p>
                    <p className="text-xs">Detects: convergence zones, sudden stops, flow discontinuities, direction chaos</p>
                    <p className="text-xs mt-1">Green arrows = fast, Red = slow/stopped, Highlighted cells = anomaly</p>
                  </div>
                ) : (
                  <div className="text-sm text-muted-foreground space-y-1">
                    <p>Grid-based accumulated change detection</p>
                    <p className="text-xs">Best for isolated roads with less motion</p>
                  </div>
                )}
                <div className="grid gap-px mt-2" style={{ gridTemplateColumns: `repeat(${GRID_COLS}, 1fr)` }}>
                  {Array.from(accumRef.current).map((v, i) => (
                    <div key={i} className="aspect-square rounded-sm" style={{
                      backgroundColor: v > 0.08 ? `rgb(${Math.min(255, Math.floor(v * 2000))},0,0)` :
                        v > 0.03 ? `rgb(${Math.min(255, Math.floor(v * 1500))},${Math.floor(v * 500)},0)` :
                          `rgb(0,${Math.min(255, Math.floor(v * 3000))},0)`
                    }} />
                  ))}
                </div>
              </div>

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

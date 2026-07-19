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
  const accumRef = useRef<Float32Array>(new Float32Array(GRID_COLS * GRID_ROWS));
  const consecutiveAnomalyRef = useRef(0);
  const supabase = createClient();

  // ========== ANOMALY PERSISTENCE HEATMAP ==========
  // Tracks how many consecutive frames each cell has been anomalous.
  // A real accident stays in one spot; normal traffic anomalies move around.
  const anomalyHeatmapRef = useRef<Float32Array>(new Float32Array(GRID_COLS * GRID_ROWS));
  const ANOMALY_PERSIST_THRESHOLD = 5; // cell must be anomalous for 5+ consecutive frames

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
    const searchR = 6; // search window radius in pixels
    const blockSize = 3; // compare blocks of 6x6

    for (let r = 0; r < GRID_ROWS; r++) {
      result[r] = [];
      for (let c = 0; c < GRID_COLS; c++) {
        const cx = Math.floor((c + 0.5) * CELL_W);
        const cy = Math.floor((r + 0.5) * CELL_H);

        let bestDx = 0, bestDy = 0, bestErr = Infinity;

        for (let dy = -searchR; dy <= searchR; dy += 2) {
          for (let dx = -searchR; dx <= searchR; dx += 2) {
            let err = 0, count = 0;
            for (let by = -blockSize; by <= blockSize; by++) {
              for (let bx = -blockSize; bx <= blockSize; bx++) {
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

  // Full-resolution grayscale (for optical flow) — returns W*H Float32Array
  const toFullGray = (data: Uint8ClampedArray, w: number, h: number): Float32Array => {
    const g = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const j = i * 4;
      g[i] = data[j] * 0.299 + data[j + 1] * 0.587 + data[j + 2] * 0.114;
    }
    return g;
  };

  // Grid-level grayscale (for accumulated change detection) — returns GRID_COLS*GRID_ROWS
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
  // Uses a persistence heatmap: a cell must be anomalous for N consecutive frames
  // before it counts. This eliminates false positives from normal traffic variation.
  const analyzeFlowAnomalies = (
    flow: { vx: number; vy: number; mag: number }[][],
  ): FlowAnomaly[] => {
    const rawAnomalies: FlowAnomaly[] = [];
    const grid = flowGridRef.current;
    const heatmap = anomalyHeatmapRef.current;
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
        if (f.mag < 0.8) cell.stagnation = Math.min(cell.stagnation + 1, 30);
        else cell.stagnation = Math.max(0, cell.stagnation - 1);
        totalMag += f.mag;
        if (f.mag > 1.5) movingCells++;
        if (f.mag < 0.5) stoppedCells++;
      }
    }

    const avgMag = totalMag / totalCells;
    if (avgMag < 0.5 || movingCells < 4) {
      // Too little motion — decay heatmap
      for (let i = 0; i < totalCells; i++) heatmap[i] *= 0.7;
      return [];
    }

    // ===== PER-CELL ANOMALY SCORING =====
    // Instead of separate detectors, score each cell on multiple dimensions
    // and combine into a single anomaly score per cell.
    const cellScores = new Float32Array(totalCells);

    for (let r = 1; r < GRID_ROWS - 1; r++) {
      for (let c = 1; c < GRID_COLS - 1; c++) {
        const idx = r * GRID_COLS + c;
        const cell = grid[r][c];
        let score = 0;

        // Factor 1: CONVERGENCE — neighbors pointing toward this cell
        let convergeScore = 0;
        let fastNeighbors = 0;
        for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[-1,1],[1,-1],[1,1]]) {
          const nr = r + dr, nc = c + dc;
          const neighbor = grid[nr][nc];
          if (neighbor.speed < 1.0) continue;
          fastNeighbors++;
          const toCenterX = (c - nc) * CELL_W;
          const toCenterY = (r - nr) * CELL_H;
          const toCenterMag = Math.sqrt(toCenterX * toCenterX + toCenterY * toCenterY);
          if (toCenterMag < 1) continue;
          const dot = neighbor.vx * toCenterX + neighbor.vy * toCenterY;
          const cosAngle = dot / (neighbor.speed * toCenterMag);
          if (cosAngle > 0.4) convergeScore += cosAngle;
        }
        // Require slow center + fast converging neighbors
        if (cell.speed < avgMag * 0.4 && fastNeighbors >= 3) {
          score += Math.min(convergeScore * 0.3, 1.0);
        }

        // Factor 2: SUDDEN DECELERATION — was fast, now slow
        if (cell.magHistory.length >= 4) {
          const prevAvg = (cell.magHistory[0] + cell.magHistory[1]) / 2;
          const recentAvg = (cell.magHistory[cell.magHistory.length - 1] + cell.magHistory[cell.magHistory.length - 2]) / 2;
          if (prevAvg > 2.5 && recentAvg < 1.0) {
            score += Math.min((prevAvg - recentAvg) / prevAvg, 1.0) * 0.5;
          }
        }

        // Factor 3: FLOW DISCONTINUITY — sharp speed difference with neighbors
        let maxNeighborDiff = 0;
        for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]]) {
          const nr = r + dr, nc = c + dc;
          const neighbor = grid[nr][nc];
          const diff = Math.abs(cell.speed - neighbor.speed);
          if (diff > maxNeighborDiff) maxNeighborDiff = diff;
        }
        if (maxNeighborDiff > 3) {
          score += Math.min(maxNeighborDiff * 0.1, 0.8);
        }

        // Factor 4: DIRECTION CHANGE — this cell suddenly changed direction
        if (cell.angleHistory.length >= 4) {
          const recentAngle = cell.angleHistory[cell.angleHistory.length - 1];
          const prevAngle = cell.angleHistory[cell.angleHistory.length - 4];
          let angleDiff = Math.abs(recentAngle - prevAngle);
          if (angleDiff > Math.PI) angleDiff = 2 * Math.PI - angleDiff;
          if (angleDiff > Math.PI * 0.5 && cell.speed > 1.5) {
            score += Math.min(angleDiff / Math.PI, 1.0) * 0.4;
          }
        }

        cellScores[idx] = Math.min(score, 1.0);
      }
    }

    // ===== UPDATE HEATMAP =====
    // Cells with high anomaly score increment, others decay
    for (let i = 0; i < totalCells; i++) {
      if (cellScores[i] > 0.4) {
        heatmap[i] = Math.min(heatmap[i] + cellScores[i], 20);
      } else {
        heatmap[i] = Math.max(0, heatmap[i] - 0.5);
      }
    }

    // ===== FIND PERSISTENT ANOMALY CLUSTERS =====
    // Look for cells where heatmap exceeds threshold — sustained anomaly
    const visited = new Uint8Array(totalCells);
    for (let r = 1; r < GRID_ROWS - 1; r++) {
      for (let c = 1; c < GRID_COLS - 1; c++) {
        const idx = r * GRID_COLS + c;
        if (visited[idx] || heatmap[idx] < ANOMALY_PERSIST_THRESHOLD) continue;

        // BFS to find cluster of persistent anomaly cells
        let clusterCells = 0;
        let totalHeat = 0;
        let maxR = r, maxC = c, maxHeat = 0;
        const queue = [r, c];
        visited[idx] = 1;

        while (queue.length) {
          const cr = queue.shift()!;
          const cc = queue.shift()!;
          const ci = cr * GRID_COLS + cc;
          clusterCells++;
          totalHeat += heatmap[ci];
          if (heatmap[ci] > maxHeat) { maxHeat = heatmap[ci]; maxR = cr; maxC = cc; }

          for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]]) {
            const nr = cr + dr, nc = cc + dc;
            if (nr < 0 || nr >= GRID_ROWS || nc < 0 || nc >= GRID_COLS) continue;
            const ni = nr * GRID_COLS + nc;
            if (!visited[ni] && heatmap[ni] >= ANOMALY_PERSIST_THRESHOLD * 0.7) {
              visited[ni] = 1;
              queue.push(nr, nc);
            }
          }
        }

        if (clusterCells >= 2) {
          const avgHeat = totalHeat / clusterCells;
          const conf = Math.min(0.95, 0.3 + avgHeat * 0.03 + clusterCells * 0.05);

          // Determine type based on cell characteristics
          const centerCell = grid[maxR][maxC];
          let type: FlowAnomaly["type"] = "collision";
          if (centerCell.speed < 0.5 && stoppedCells > movingCells * 0.3) type = "pile_up";
          else if (centerCell.magHistory.length >= 4) {
            const prevAvg = (centerCell.magHistory[0] + centerCell.magHistory[1]) / 2;
            const recentAvg = (centerCell.magHistory[centerCell.magHistory.length - 1]);
            if (prevAvg > 2.5 && recentAvg < 1.0) type = "sudden_stop";
          }

          rawAnomalies.push({
            type, confidence: conf,
            cx: maxC, cy: maxR,
            evidence: `Persistent cluster: ${clusterCells} cells, heat: ${avgHeat.toFixed(1)}`,
          });
        }
      }
    }

    rawAnomalies.sort((a, b) => b.confidence - a.confidence);
    return rawAnomalies;
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

    // Show heatmap as subtle overlay on ALL cells
    const heatmap = anomalyHeatmapRef.current;
    for (let r = 0; r < GRID_ROWS; r++) {
      for (let c = 0; c < GRID_COLS; c++) {
        const heat = heatmap[r * GRID_COLS + c];
        if (heat > 1) {
          const x = c * CELL_W * sx, y = r * CELL_H * sy;
          const w = CELL_W * sx, h = CELL_H * sy;
          const intensity = Math.min(heat / 15, 1);
          ctx.fillStyle = `rgba(255, 0, 0, ${intensity * 0.3})`;
          ctx.fillRect(x, y, w, h);
        }
      }
    }

    // Highlight confirmed anomaly clusters
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
      ctx.fillStyle = `${color}44`;
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
    accumRef.current.fill(0);
    frameRef.current = 0;
    stateFrameRef.current = 0;
    cooldownRef.current = 0;
    consecutiveAnomalyRef.current = 0;
    stateRef.current = "monitoring";
    initFlowGrid();
    anomalyHeatmapRef.current.fill(0);

    setVideoReady(true);
    setIsAnalyzing(true);
    setIncidents([]);
    setState("monitoring");
    setObjectCount(0);

    // Store previous frames: full-res for flow, grid for change detection
    let prevFullGray: Float32Array | null = null;
    let prevGridGray: Float32Array | null = null;

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

        // Full-res grayscale for optical flow
        const currFullGray = toFullGray(data, W, H);
        // Grid-level grayscale for change detection
        const currGridGray = toGrayGrid(data, W, H);

        // Compute anomalies
        let flow: { vx: number; vy: number; mag: number }[][] | null = null;
        let anomalies: FlowAnomaly[] = [];

        if (prevFullGray) {
          flow = computeFlowGrid(currFullGray, prevFullGray, W, H);

          if (analysisMode === "traffic") {
            anomalies = analyzeFlowAnomalies(flow);
          } else {
            // Normal mode: accumulated change on grid
            let totalChange = 0;
            for (let i = 0; i < GRID_COLS * GRID_ROWS; i++) {
              const diff = prevGridGray ? Math.abs(currGridGray[i] - prevGridGray[i]) / 255 : 0;
              accumRef.current[i] = accumRef.current[i] * 0.95 + diff * 3;
              totalChange += accumRef.current[i];
            }
            const score = totalChange / (GRID_COLS * GRID_ROWS);
            if (score > 0.04) {
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
          }
        }

        prevFullGray = currFullGray;
        prevGridGray = currGridGray;

        // Count moving regions
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

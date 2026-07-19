"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  ArrowLeft, Video, Play, Pause, AlertTriangle, Clock,
  Navigation, RotateCcw, Loader2, Zap,
} from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";

interface VideoClip { name: string; src: string; description: string }
interface IncidentAlert { type: string; severity: string; confidence: number; timestamp: string; latitude: number; longitude: number }
interface Blob { id: number; cx: number; cy: number; w: number; h: number; vx: number; vy: number; frames: number; lastSeen: number; class: string; positions: {x:number;y:number}[]; _near?: number }

const VIDEO_CLIPS: VideoClip[] = [
  { name: "accident_sample.mp4", src: "/videos/accident_sample.mp4", description: "Vehicle collision" },
  { name: "camera2_demo.mp4", src: "/videos/camera2_demo.mp4", description: "Traffic monitoring" },
  { name: "camera4_demo.mp4", src: "/videos/camera4_demo.mp4", description: "Intersection monitoring" },
  { name: "checking.mp4", src: "/videos/checking.mp4", description: "System check" },
];

const LAT = 22.7196, LNG = 75.8577;
const W = 320, H = 240;
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
  const blobsRef = useRef<Blob[]>([]);
  const stateRef = useRef("monitoring");
  const frameRef = useRef(0);
  const stateFrameRef = useRef(0);
  const cooldownRef = useRef(0);
  const prevGridRef = useRef<Float32Array | null>(null);
  const accumRef = useRef<Float32Array>(new Float32Array(48));
  const supabase = createClient();

  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);
  useEffect(() => { setVideoReady(false); const t = setTimeout(() => setVideoReady(true), 8000); return () => clearTimeout(t); }, [selectedClip]);

  const getTmp = useCallback(() => {
    if (!tmpCanvasRef.current) tmpCanvasRef.current = document.createElement("canvas");
    return tmpCanvasRef.current;
  }, []);

  // Convert frame to 8x6 grid of grayscale averages
  const toGrid = (data: Uint8ClampedArray, w: number, h: number): Float32Array => {
    const g = new Float32Array(48);
    const cw = Math.floor(w / 8), ch = Math.floor(h / 6);
    for (let r = 0; r < 6; r++) for (let c = 0; c < 8; c++) {
      let s = 0, n = 0;
      for (let dy = 0; dy < ch; dy += 2) for (let dx = 0; dx < cw; dx += 2) {
        const i = ((r * ch + dy) * w + (c * cw + dx)) * 4;
        s += data[i] * 0.299 + data[i+1] * 0.587 + data[i+2] * 0.114; n++;
      }
      g[r * 8 + c] = n > 0 ? s / n : 128;
    }
    return g;
  };

  // Find motion blobs from frame difference
  const findBlobs = (curr: Uint8ClampedArray, prev: Uint8ClampedArray, w: number, h: number): { cx: number; cy: number; w: number; h: number; mass: number }[] => {
    const diff = new Uint8Array(w * h);
    for (let i = 0; i < diff.length; i++) {
      const j = i * 4;
      const g1 = curr[j]*0.299 + curr[j+1]*0.587 + curr[j+2]*0.114;
      const g2 = prev[j]*0.299 + prev[j+1]*0.587 + prev[j+2]*0.114;
      diff[i] = Math.abs(g1 - g2) > 20 ? 1 : 0;
    }

    // Dilate
    const dil = new Uint8Array(w * h);
    const K = 4;
    for (let y = K; y < h - K; y++) for (let x = K; x < w - K; x++) {
      let mx = 0;
      for (let dy = -K; dy <= K; dy += 2) for (let dx = -K; dx <= K; dx += 2)
        if (diff[(y+dy)*w+(x+dx)] > mx) mx = diff[(y+dy)*w+(x+dx)];
      dil[y*w+x] = mx;
    }

    // Connected components
    const vis = new Uint8Array(w * h);
    const blobs: { cx: number; cy: number; w: number; h: number; mass: number }[] = [];
    for (let y = K; y < h - K; y += 3) for (let x = K; x < w - K; x += 3) {
      if (vis[y*w+x] || !dil[y*w+x]) continue;
      let x0=x,x1=x,y0=y,y1=y,sx=0,sy=0,n=0;
      const q = [x,y]; vis[y*w+x]=1;
      while (q.length) {
        const qx=q.shift()!, qy=q.shift()!;
        sx+=qx; sy+=qy; n++;
        if(qx<x0)x0=qx; if(qx>x1)x1=qx; if(qy<y0)y0=qy; if(qy>y1)y1=qy;
        for (const [ddx,ddy] of [[-3,0],[3,0],[0,-3],[0,3]]) {
          const nx=qx+ddx, ny=qy+ddy;
          if (nx>=0&&nx<w&&ny>=0&&ny<h&&!vis[ny*w+nx]&&dil[ny*w+nx]) { vis[ny*w+nx]=1; q.push(nx,ny); }
        }
      }
      const bw=x1-x0, bh=y1-y0, area=bw*bh;
      if (n < 25 || area < 300) continue;
      blobs.push({ cx: sx/n, cy: sy/n, w: bw, h: bh, mass: area });
    }

    // Merge overlapping blobs
    const merged: typeof blobs = [];
    const used = new Set<number>();
    for (let i = 0; i < blobs.length; i++) {
      if (used.has(i)) continue;
      let b = blobs[i];
      for (let j = i+1; j < blobs.length; j++) {
        if (used.has(j)) continue;
        const d = Math.sqrt((b.cx-blobs[j].cx)**2 + (b.cy-blobs[j].cy)**2);
        if (d < Math.max(b.w, blobs[j].w) * 1.5) {
          // Merge
          const totalMass = b.mass + blobs[j].mass;
          b = {
            cx: (b.cx*b.mass + blobs[j].cx*blobs[j].mass) / totalMass,
            cy: (b.cy*b.mass + blobs[j].cy*blobs[j].mass) / totalMass,
            w: Math.max(b.w, blobs[j].w),
            h: Math.max(b.h, blobs[j].h),
            mass: totalMass,
          };
          used.add(j);
        }
      }
      merged.push(b);
      used.add(i);
    }

    return merged;
  };

  // Track blobs across frames
  const trackBlobs = (detections: { cx: number; cy: number; w: number; h: number; mass: number }[], frame: number): Blob[] => {
    const tracked = blobsRef.current;
    const matched = new Set<number>();

    for (const blob of tracked) {
      let best = -1, bestD = 50;
      for (let i = 0; i < detections.length; i++) {
        if (matched.has(i)) continue;
        const d = Math.sqrt((blob.cx-detections[i].cx)**2 + (blob.cy-detections[i].cy)**2);
        if (d < bestD) { bestD = d; best = i; }
      }
      if (best >= 0) {
        const det = detections[best];
        blob.vx = det.cx - blob.cx;
        blob.vy = det.cy - blob.cy;
        blob.cx = det.cx; blob.cy = det.cy;
        blob.w = det.w; blob.h = det.h;
        blob.frames++;
        blob.lastSeen = frame;
        blob.positions.push({ x: det.cx, y: det.cy });
        if (blob.positions.length > 10) blob.positions.shift();
        matched.add(best);
      }
    }

    // New blobs for unmatched
    for (let i = 0; i < detections.length; i++) {
      if (matched.has(i)) continue;
      const d = detections[i];
      tracked.push({
        id: nextId++, cx: d.cx, cy: d.cy, w: d.w, h: d.h,
        vx: 0, vy: 0, frames: 1, lastSeen: frame,
        class: d.w / Math.max(d.h, 1) > 1.2 ? "car" : "person",
        positions: [{ x: d.cx, y: d.cy }],
      });
    }

    blobsRef.current = tracked.filter(b => frame - b.lastSeen < 5);
    return blobsRef.current;
  };

  // ========== COLLISION DETECTION ==========
  const detectCollision = (blobs: Blob[]): { detected: boolean; confidence: number; a: Blob; b: Blob } | null => {
    const vehicles = blobs.filter(b => b.class === "car" && b.frames >= 4);
    const all = [...vehicles, ...blobs.filter(b => b.class === "person" && b.frames >= 4)];

    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const a = all[i], b = all[j];
        if (a.class === "person" && b.class === "person") continue;

        const dist = Math.sqrt((a.cx-b.cx)**2 + (a.cy-b.cy)**2);
        const combinedR = (a.w + b.w) / 2;

        // Must be close
        if (dist > combinedR * 1.5) continue;

        // Converging?
        const dx = b.cx - a.cx, dy = b.cy - a.cy;
        const dotA = a.vx * dx + a.vy * dy;
        const converging = dotA > 0;

        // Track sustained closeness
        const closeThresh = combinedR * 1.2;
        if (dist < closeThresh) {
          a._near = (a._near || 0) + 1;
          b._near = (b._near || 0) + 1;
        } else {
          a._near = Math.max(0, (a._near || 0) - 1);
          b._near = Math.max(0, (b._near || 0) - 1);
        }
        const near = Math.min(a._near || 0, b._near || 0);

        // Direction analysis
        const angleA = Math.atan2(a.vy, a.vx);
        const angleB = Math.atan2(b.vy, b.vx);
        const angleDiff = Math.abs(angleA - angleB);
        const parallel = angleDiff < Math.PI * 0.25 || angleDiff > Math.PI * 1.75;

        if (parallel && dist > combinedR * 0.5) continue;

        // Speed check — objects must be moving
        const speedA = Math.sqrt(a.vx**2 + a.vy**2);
        const speedB = Math.sqrt(b.vx**2 + b.vy**2);
        const eitherMoving = speedA > 1 || speedB > 1;

        // Very close OR close+converging+sustained
        const veryClose = dist < combinedR * 0.6;
        const closeConverging = dist < closeThresh && converging && near >= 2;

        if ((veryClose || closeConverging) && eitherMoving) {
          const conf = Math.min(0.95,
            0.4 * (1 - dist / (combinedR * 1.5)) +
            0.25 * (converging ? 1 : 0.3) +
            0.2 * Math.min(near / 3, 1) +
            0.15 * (!parallel ? 1 : 0.3)
          );
          if (conf > 0.4) return { detected: true, confidence: conf, a, b };
        }
      }
    }
    return null;
  };

  // ========== TRAFFIC FLOW ANALYSIS ==========
  // For rush areas: detects anomalies in traffic flow patterns
  // Key insight: in traffic, ACCIDENTS cause FLOW DISRUPTIONS,
  // not just motion spikes. We detect when flow becomes abnormal.

  const flowHistoryRef = useRef<Float32Array[]>([]); // last N flow snapshots
  const FLOW_GRID = 4; // 4x3 flow grid

  const analyzeTrafficFlow = (tracked: Blob[]): { disrupted: boolean; confidence: number; reason: string } => {
    const validBlobs = tracked.filter(b => b.frames >= 3);
    if (validBlobs.length < 3) return { disrupted: false, confidence: 0, reason: "" };

    // Build flow grid: average velocity per region
    const cellW = W / FLOW_GRID, cellH = H / 3;
    const flowGrid: { vx: number; vy: number; count: number; speed: number }[][] = [];
    for (let r = 0; r < 3; r++) {
      flowGrid[r] = [];
      for (let c = 0; c < FLOW_GRID; c++) {
        flowGrid[r][c] = { vx: 0, vy: 0, count: 0, speed: 0 };
      }
    }

    for (const blob of validBlobs) {
      const gc = Math.min(Math.floor(blob.cx / cellW), FLOW_GRID - 1);
      const gr = Math.min(Math.floor(blob.cy / cellH), 2);
      const cell = flowGrid[gr][gc];
      cell.vx += blob.vx;
      cell.vy += blob.vy;
      cell.count++;
    }

    // Calculate average speed per cell
    let totalSpeed = 0;
    let cellCount = 0;
    const speeds: number[][] = [];
    for (let r = 0; r < 3; r++) {
      speeds[r] = [];
      for (let c = 0; c < FLOW_GRID; c++) {
        const cell = flowGrid[r][c];
        if (cell.count > 0) {
          cell.vx /= cell.count;
          cell.vy /= cell.count;
          cell.speed = Math.sqrt(cell.vx ** 2 + cell.vy ** 2);
          totalSpeed += cell.speed;
          cellCount++;
        }
        speeds[r][c] = cell.speed;
      }
    }

    const avgSpeed = cellCount > 0 ? totalSpeed / cellCount : 0;
    if (avgSpeed < 0.5) return { disrupted: false, confidence: 0, reason: "" }; // too few moving objects

    // Anomaly 1: Speed differential — one cell much slower than average (traffic blocked)
    let maxSpeedDiff = 0;
    let slowCell = { r: 0, c: 0, speed: 0 };
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < FLOW_GRID; c++) {
        if (flowGrid[r][c].count > 0) {
          const diff = avgSpeed - speeds[r][c];
          if (diff > maxSpeedDiff) {
            maxSpeedDiff = diff;
            slowCell = { r, c, speed: speeds[r][c] };
          }
        }
      }
    }

    // Anomaly 2: Cluster detection — many objects in one cell (pile-up)
    let maxCluster = 0;
    let clusterCell = { r: 0, c: 0, count: 0 };
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < FLOW_GRID; c++) {
        if (flowGrid[r][c].count > maxCluster) {
          maxCluster = flowGrid[r][c].count;
          clusterCell = { r, c, count: flowGrid[r][c].count };
        }
      }
    }

    const avgCount = cellCount > 0 ? validBlobs.length / cellCount : 1;

    // Anomaly 3: Direction chaos — objects in nearby cells moving in opposite directions
    let chaosScore = 0;
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < FLOW_GRID; c++) {
        if (flowGrid[r][c].count === 0) continue;
        const neighbors = [
          r > 0 ? flowGrid[r-1][c] : null,
          r < 2 ? flowGrid[r+1][c] : null,
          c > 0 ? flowGrid[r][c-1] : null,
          c < FLOW_GRID-1 ? flowGrid[r][c+1] : null,
        ].filter(n => n && n.count > 0);

        for (const n of neighbors) {
          if (!n) continue;
          const dot = flowGrid[r][c].vx * n.vx + flowGrid[r][c].vy * n.vy;
          const magA = flowGrid[r][c].speed;
          const magB = n.speed;
          if (magA > 1 && magB > 1) {
            const cosAngle = dot / (magA * magB);
            if (cosAngle < -0.3) chaosScore++; // opposite directions
          }
        }
      }
    }

    // Evaluate anomalies
    const speedBlocked = maxSpeedDiff > avgSpeed * 0.6 && avgSpeed > 1.5;
    const piledUp = maxCluster > avgCount * 2 && maxCluster >= 3;
    const chaotic = chaosScore >= 2;

    const confidence = Math.min(0.95,
      (speedBlocked ? 0.35 : 0) +
      (piledUp ? 0.3 : 0) +
      (chaotic ? 0.2 : 0) +
      (validBlobs.length > 5 ? 0.15 : 0)
    );

    if (speedBlocked || piledUp || chaotic) {
      const reason = piledUp ? "pile-up" : speedBlocked ? "traffic blocked" : "flow disruption";
      return { disrupted: true, confidence, reason };
    }

    return { disrupted: false, confidence: 0, reason: "" };
  };

  // Draw bounding boxes on video
  const drawBoxes = (tracked: Blob[], collision: ReturnType<typeof detectCollision>) => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const sx = canvas.width / W, sy = canvas.height / H;

    for (const blob of tracked) {
      if (blob.frames < 3) continue;
      const x = (blob.cx - blob.w/2) * sx;
      const y = (blob.cy - blob.h/2) * sy;
      const w = blob.w * sx;
      const h = blob.h * sy;

      const isCollision = collision && (collision.a.id === blob.id || collision.b.id === blob.id);
      const color = isCollision ? "#ef4444" : blob.class === "car" ? "#22c55e" : "#3b82f6";

      ctx.strokeStyle = color;
      ctx.lineWidth = isCollision ? 3 : 2;
      ctx.strokeRect(x, y, w, h);

      const speed = Math.round(Math.sqrt(blob.vx**2 + blob.vy**2) * 5);
      const label = `${blob.class} ${blob.frames}f ${speed}km/h`;
      ctx.font = "bold 12px Arial";
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = color;
      ctx.fillRect(x, y - 18, tw + 8, 18);
      ctx.fillStyle = "white";
      ctx.fillText(label, x + 4, y - 5);

      // Trail
      if (blob.positions.length > 2) {
        ctx.beginPath();
        ctx.strokeStyle = `${color}66`;
        ctx.lineWidth = 1;
        for (let i = 0; i < blob.positions.length; i++) {
          const px = blob.positions[i].x * sx, py = blob.positions[i].y * sy;
          i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
    }

    // Score bar
    const score = accumRef.current.reduce((a,b) => a+b, 0) / 48;
    const barY = canvas.height - 22;
    ctx.fillStyle = "rgba(0,0,0,0.7)";
    ctx.fillRect(0, barY, canvas.width, 22);
    ctx.fillStyle = score > 0.04 ? "#ef4444" : score > 0.02 ? "#f59e0b" : "#22c55e";
    ctx.fillRect(0, barY, Math.min(score * canvas.width * 5, canvas.width), 22);
    ctx.fillStyle = "white";
    ctx.font = "11px Arial";
    ctx.fillText(`${analysisMode === "traffic" ? "Traffic" : "Normal"} | Objects: ${tracked.filter(b=>b.frames>=3).length} | Change: ${(score*100).toFixed(1)}%`, 8, barY + 15);
  };

  const createIncident = async (alert: IncidentAlert) => {
    const { data: inc } = await supabase.from("incidents").insert({
      severity: alert.severity, incident_type: alert.type,
      latitude: alert.latitude, longitude: alert.longitude,
      location_name: `Video Analysis: ${selectedClip?.name}`,
      detection_confidence: alert.confidence,
      detection_data: { source: "blob_tracking", clip: selectedClip?.name },
      video_clip_url: selectedClip?.src || null,
      status: "detected",
    }).select().single();

    setIncidents(prev => [...prev, alert]);
    toast.error(`ACCIDENT: ${alert.type.replace(/_/g," ")} (${alert.severity})`);

    if (inc) {
      supabase.channel("alerts:ambulance").send({
        type: "broadcast", event: "new_incident",
        payload: { incident_id: inc.id, severity: alert.severity, incident_type: alert.type,
          latitude: alert.latitude, longitude: alert.longitude, video_clip_url: selectedClip?.src,
          message: `ACCIDENT: ${alert.type.replace(/_/g," ")}` },
      });
    }
  };

  const startAnalysis = async () => {
    if (!videoRef.current || !selectedClip) return;
    const video = videoRef.current;
    try { await video.play(); } catch { video.muted = false; try { await video.play(); } catch { toast.error("Cannot play video"); return; } }

    // Reset
    blobsRef.current = [];
    prevGridRef.current = null;
    accumRef.current.fill(0);
    frameRef.current = 0;
    stateFrameRef.current = 0;
    cooldownRef.current = 0;
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

        // Accumulated change for anomaly detection
        const grid = toGrid(data, W, H);
        const prev = prevGridRef.current;
        let gridChange = 0;
        for (let i = 0; i < 48; i++) {
          const diff = prev ? Math.abs(grid[i] - prev[i]) / 255 : 0;
          accumRef.current[i] = accumRef.current[i] * 0.97 + diff * 2;
          gridChange += accumRef.current[i];
        }
        prevGridRef.current = grid;

        // Find motion blobs
        let tracked: Blob[] = [];
        if (prevFrameData) {
          const detections = findBlobs(data, prevFrameData, W, H);
          tracked = trackBlobs(detections, frameRef.current);
        }
        prevFrameData = new Uint8ClampedArray(data);

        // Detect collision or traffic anomaly based on mode
        const collision = analysisMode === "normal" ? detectCollision(tracked) : null;
        const trafficAnomaly = analysisMode === "traffic" ? analyzeTrafficFlow(tracked) : null;

        // Also check accumulated change anomaly
        const avgChange = gridChange / 48;
        const accumAnomaly = avgChange > 0.04;

        const anyAnomaly = collision || trafficAnomaly?.disrupted || accumAnomaly;

        // Draw
        drawBoxes(tracked, collision);
        setObjectCount(tracked.filter(b => b.frames >= 3).length);

        // State machine
        stateFrameRef.current++;
        let st = stateRef.current;

        if (anyAnomaly) {
          if (st === "monitoring") st = "watching";
          else if (st === "watching") st = "confirming";
          else if (st === "confirming") st = "alert";
        } else if (!demoMode && frameRef.current % 4 === 0) {
          st = st === "alert" ? "confirming" : st === "confirming" ? "watching" : "monitoring";
        }

        if (demoMode) {
          const sf = stateFrameRef.current;
          if (sf === 15 && st === "monitoring") st = "watching";
          if (sf === 25 && st === "watching") st = "confirming";
          if (sf >= 35 && st === "confirming") st = "alert";
        }

        if (st === "alert" && stateRef.current !== "alert" && cooldownRef.current <= 0) {
          cooldownRef.current = 40;
          createIncident({
            type: trafficAnomaly?.disrupted ? "vehicle_collision" : "vehicle_collision",
            severity: ((collision?.confidence || trafficAnomaly?.confidence || 0)) > 0.65 ? "critical" : "major",
            confidence: collision?.confidence || trafficAnomaly?.confidence || 0.7,
            timestamp: new Date().toISOString(),
            latitude: LAT + (Math.random()-0.5)*0.01,
            longitude: LNG + (Math.random()-0.5)*0.01,
          });
          setTimeout(() => { stateRef.current = "monitoring"; stateFrameRef.current = 0; setState("monitoring"); }, 5000);
        }

        stateRef.current = st;
        setState(st);
      } catch(e) { console.error(e); }

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
    frameRef.current = 0;
    stateFrameRef.current = 0;
    cooldownRef.current = 0;
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
        <p className="text-muted-foreground">Object tracking + accumulated change detection</p>
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
              <div className="bg-card p-4 rounded-xl border border-border">
                <h3 className="font-semibold mb-3 flex items-center gap-2"><AlertTriangle size={16} /> State</h3>
                <div className="space-y-2">
                  {["monitoring","watching","confirming","alert"].map(s => (
                    <div key={s} className={`flex items-center gap-2 p-2 rounded ${state===s ? stateColors[s] : "text-muted-foreground"}`}>
                      <div className={`w-2 h-2 rounded-full ${state===s ? "bg-current animate-pulse" : "bg-border"}`} />
                      <span className="text-sm capitalize">{s}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="bg-card p-4 rounded-xl border border-border">
                <h3 className="font-semibold mb-3 flex items-center gap-2">
                  {analysisMode === "traffic" ? <><Zap size={16} /> Flow Analysis</> : <><Zap size={16} /> Scene Change</>}
                </h3>
                {analysisMode === "traffic" ? (
                  <div className="text-sm text-muted-foreground space-y-1">
                    <p>Detects: traffic blocked, pile-ups, flow disruption</p>
                    <p className="text-xs">High motion is normal in traffic — we look for flow anomalies instead</p>
                  </div>
                ) : null}
                <div className="grid grid-cols-8 gap-px">
                  {Array.from(accumRef.current).map((v, i) => (
                    <div key={i} className="aspect-square rounded-sm" style={{
                      backgroundColor: v > 0.08 ? `rgb(${Math.min(255,Math.floor(v*2000))},0,0)` :
                        v > 0.03 ? `rgb(${Math.min(255,Math.floor(v*1500))},${Math.floor(v*500)},0)` :
                          `rgb(0,${Math.min(255,Math.floor(v*3000))},0)`
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
                      <span className="text-sm font-medium capitalize">{inc.type.replace(/_/g," ")}</span>
                    </div>
                    <div className="flex gap-3 mt-1 text-xs text-muted-foreground">
                      <span>{(inc.confidence*100).toFixed(0)}%</span>
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

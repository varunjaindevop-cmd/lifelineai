"use client";

import { useRef, useEffect, useCallback } from "react";

interface Entity {
  id: number;
  class: string;
  confidence: number;
  x: number;
  y: number;
  w: number;
  h: number;
  speed: number;
  heading: number;
  acceleration: number;
  age: number;
  confirmedFrames: number;
  positions?: { x: number; y: number }[];
}

interface Evidence {
  type: string;
  confidence: number;
  objects: number[];
  details: string;
  signals: { name: string; value: number; weight: number; passed: boolean }[];
  sceneContext: string;
}

interface DetectionOverlayProps {
  videoRef: React.RefObject<HTMLVideoElement>;
  entities: Entity[];
  evidence: Evidence[];
  isAnalyzing: boolean;
  fps?: number;
}

const CLASS_COLORS: Record<string, string> = {
  car: "#22c55e",
  motorcycle: "#f59e0b",
  person: "#3b82f6",
  bus: "#8b5cf6",
  truck: "#ec4899",
  bicycle: "#06b6d4",
  fallen_person: "#ef4444",
};

function severityColor(confidence: number): string {
  if (confidence > 0.85) return "#ef4444";
  if (confidence > 0.65) return "#f97316";
  if (confidence > 0.45) return "#eab308";
  return "#6b7280";
}

export default function DetectionOverlay({
  videoRef,
  entities,
  evidence,
  isAnalyzing,
  fps = 0,
}: DetectionOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Bypass React render cycle: store latest data in refs, read every frame
  const dataRef = useRef({ entities, evidence });
  const rafRef = useRef(0);

  // Update ref synchronously on every props change — no render delay
  dataRef.current = { entities, evidence };

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const rect = video.getBoundingClientRect();
    const dw = Math.round(rect.width);
    const dh = Math.round(rect.height);
    if (canvas.width !== dw || canvas.height !== dh) {
      canvas.width = dw;
      canvas.height = dh;
    }

    const vw = video.videoWidth || 640;
    const vh = video.videoHeight || 480;
    const sx = dw / vw;
    const sy = dh / vh;

    const { entities: ents, evidence: evs } = dataRef.current;

    ctx.clearRect(0, 0, dw, dh);

    // Evidence alert overlays
    for (const ev of evs) {
      for (const oid of ev.objects) {
        const ent = ents.find(e => e.id === oid);
        if (!ent || ent.age < 1) continue;
        const bx = (ent.x - ent.w / 2) * sx;
        const by = (ent.y - ent.h / 2) * sy;
        const bw = ent.w * sx;
        const bh = ent.h * sy;
        const sc = severityColor(ev.confidence);
        ctx.strokeStyle = sc;
        ctx.lineWidth = 3;
        ctx.setLineDash([5, 3]);
        ctx.strokeRect(bx - 2, by - 2, bw + 4, bh + 4);
        ctx.setLineDash([]);
        const ct = `${(ev.confidence * 100).toFixed(0)}%`;
        ctx.font = `bold ${Math.max(10, 10 * sx)}px monospace`;
        const tw = ctx.measureText(ct).width;
        ctx.fillStyle = sc;
        ctx.fillRect(bx + bw - tw - 8, by - 18, tw + 8, 16);
        ctx.fillStyle = "#fff";
        ctx.fillText(ct, bx + bw - tw - 4, by - 5);
      }
    }

    // Entity ESP boxes — drawn at raw detection position (no Kalman lag)
    for (const ent of ents) {
      if (ent.age < 1) continue;
      const involved = evs.some(e => e.objects.includes(ent.id));
      const base = CLASS_COLORS[ent.class] || "#22c55e";
      const col = involved ? severityColor(evs.find(e => e.objects.includes(ent.id))?.confidence || 0) : base;

      const bx = (ent.x - ent.w / 2) * sx;
      const by = (ent.y - ent.h / 2) * sy;
      const bw = ent.w * sx;
      const bh = ent.h * sy;

      // Main box
      ctx.strokeStyle = col;
      ctx.lineWidth = involved ? 3 : 2;
      ctx.strokeRect(bx, by, bw, bh);

      // Corner brackets
      const cl = Math.min(8, bw * 0.15, bh * 0.15);
      ctx.lineWidth = 3;
      ctx.strokeStyle = col;
      for (const [x1, y1, x2, y2, x3, y3] of [
        [bx, by + cl, bx, by, bx + cl, by] as const,
        [bx + bw - cl, by, bx + bw, by, bx + bw, by + cl] as const,
        [bx, by + bh - cl, bx, by + bh, bx + cl, by + bh] as const,
        [bx + bw - cl, by + bh, bx + bw, by + bh, bx + bw, by + bh - cl] as const,
      ]) {
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.lineTo(x3, y3);
        ctx.stroke();
      }

      // Heading arrow
      if (ent.speed > 0.3) {
        const arrowLen = Math.min(30, bw * 0.6);
        const ax = bx + bw / 2;
        const ay = by + bh / 2;
        const ex = ax + Math.cos(ent.heading) * arrowLen;
        const ey = ay + Math.sin(ent.heading) * arrowLen;
        ctx.beginPath();
        ctx.strokeStyle = "#facc15";
        ctx.lineWidth = 2;
        ctx.moveTo(ax, ay);
        ctx.lineTo(ex, ey);
        ctx.stroke();
        // Arrowhead
        const aSize = 5;
        const aAngle = Math.atan2(ey - ay, ex - ax);
        ctx.beginPath();
        ctx.moveTo(ex, ey);
        ctx.lineTo(ex - aSize * Math.cos(aAngle - 0.5), ey - aSize * Math.sin(aAngle - 0.5));
        ctx.moveTo(ex, ey);
        ctx.lineTo(ex - aSize * Math.cos(aAngle + 0.5), ey - aSize * Math.sin(aAngle + 0.5));
        ctx.stroke();
      }

      // Track trail
      if (ent.positions && ent.positions.length > 1) {
        ctx.beginPath();
        ctx.strokeStyle = `${col}66`;
        ctx.lineWidth = 1;
        const trail = ent.positions.slice(-5);
        trail.forEach((p, i) => {
          if (i === 0) ctx.moveTo(p.x * sx, p.y * sy);
          else ctx.lineTo(p.x * sx, p.y * sy);
        });
        ctx.stroke();
      }

      // Label: class + speed
      const speedKmh = ent.speed;
      const label = `${ent.class} ${speedKmh.toFixed(0)}km/h`;
      ctx.font = `bold ${Math.max(10, 10 * sx)}px monospace`;
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = "rgba(0,0,0,0.85)";
      ctx.fillRect(bx, by - 20, tw + 8, 18);
      ctx.fillStyle = "#22c55e";
      ctx.fillText(label, bx + 4, by - 6);

      // ID tag
      const idT = `#${ent.id}`;
      ctx.fillStyle = "rgba(0,0,0,0.85)";
      ctx.fillRect(bx + tw + 12, by - 20, ctx.measureText(idT).width + 8, 18);
      ctx.fillStyle = "#facc15";
      ctx.fillText(idT, bx + tw + 16, by - 6);
    }

    // Status bar
    ctx.fillStyle = "rgba(0,0,0,0.75)";
    ctx.fillRect(0, dh - 22, dw, 22);
    ctx.fillStyle = "#fff";
    ctx.font = `${Math.max(11, 11 * sx)}px Arial`;
    ctx.fillText(
      `Objects: ${ents.filter(e => e.age >= 1).length} | Alerts: ${evs.length} | FPS: ${fps}`,
      8, dh - 7
    );
  }, [videoRef, fps]);

  useEffect(() => {
    if (!isAnalyzing) return;
    const loop = () => {
      draw();
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [isAnalyzing, draw]);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 w-full h-full pointer-events-none"
    />
  );
}

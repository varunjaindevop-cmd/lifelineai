"use client";
import { useRef, useEffect } from "react";

/*
 * ESP Box Overlay v2 — clean rebuild.
 *
 * Design:
 *  - Canvas runs on rAF, reads entity positions from a plain JS object (no React state).
 *  - Boxes drawn at EXACT COCO-SSD coordinates. Zero smoothing. Zero prediction.
 *  - Every detected object gets a box. No filtering by age, stale, or near/far.
 *  - If detection stops for an object, box disappears on next frame.
 */

interface EspEntity {
  id: number;
  cls: string;
  conf: number;
  x: number;   // center x in video pixels
  y: number;   // center y in video pixels
  w: number;   // width in video pixels
  h: number;   // height in video pixels
  speed: number; // km/h
  heading: number; // radians
}

interface EspAlert {
  objs: number[];
  conf: number;
  type: string;
}

interface Props {
  videoRef: React.RefObject<HTMLVideoElement>;
  entities: EspEntity[];
  alerts: EspAlert[];
  active: boolean;
}

const COLORS: Record<string, string> = {
  car: "#22c55e",
  motorcycle: "#f59e0b",
  bicycle: "#06b6d4",
  person: "#3b82f6",
  bus: "#8b5cf6",
  truck: "#ec4899",
};

export default function DetectionOverlay({ videoRef, entities, alerts, active }: Props) {
  const cvs = useRef<HTMLCanvasElement>(null);
  // Bypass React render: update a plain object, canvas reads it every frame
  const buf = useRef({ entities, alerts });
  buf.current = { entities, alerts };

  useEffect(() => {
    if (!active) return;
    let raf = 0;

    const paint = () => {
      const c = cvs.current;
      const v = videoRef.current;
      if (!c || !v) { raf = requestAnimationFrame(paint); return; }

      const ctx = c.getContext("2d");
      if (!ctx) { raf = requestAnimationFrame(paint); return; }

      // Match canvas to video display size
      const r = v.getBoundingClientRect();
      const dw = Math.round(r.width);
      const dh = Math.round(r.height);
      if (c.width !== dw || c.height !== dh) { c.width = dw; c.height = dh; }

      const vw = v.videoWidth || 640;
      const vh = v.videoHeight || 480;
      const sx = dw / vw;
      const sy = dh / vh;

      ctx.clearRect(0, 0, dw, dh);

      const { entities: ents, alerts: al } = buf.current;

      // --- Alert overlays (dashed red border on involved objects) ---
      for (const a of al) {
        for (const oid of a.objs) {
          const e = ents.find(x => x.id === oid);
          if (!e) continue;
          const bx = (e.x - e.w / 2) * sx;
          const by = (e.y - e.h / 2) * sy;
          const bw = e.w * sx;
          const bh = e.h * sy;
          ctx.strokeStyle = a.conf > 0.7 ? "#ef4444" : "#f97316";
          ctx.lineWidth = 3;
          ctx.setLineDash([6, 3]);
          ctx.strokeRect(bx - 3, by - 3, bw + 6, bh + 6);
          ctx.setLineDash([]);
          // Confidence badge
          const txt = `${(a.conf * 100).toFixed(0)}%`;
          ctx.font = `bold 11px monospace`;
          const tw = ctx.measureText(txt).width;
          ctx.fillStyle = ctx.strokeStyle;
          ctx.fillRect(bx + bw - tw - 10, by - 20, tw + 10, 16);
          ctx.fillStyle = "#fff";
          ctx.fillText(txt, bx + bw - tw - 5, by - 7);
        }
      }

      // --- Entity ESP boxes ---
      for (const e of ents) {
        const bx = (e.x - e.w / 2) * sx;
        const by = (e.y - e.h / 2) * sy;
        const bw = e.w * sx;
        const bh = e.h * sy;
        const col = COLORS[e.cls] || "#22c55e";

        // Box
        ctx.strokeStyle = col;
        ctx.lineWidth = 2;
        ctx.strokeRect(bx, by, bw, bh);

        // Corner brackets
        const cl = Math.min(10, bw * 0.2, bh * 0.2);
        ctx.lineWidth = 3;
        const corners = [
          [bx, by + cl, bx, by, bx + cl, by],
          [bx + bw - cl, by, bx + bw, by, bx + bw, by + cl],
          [bx, by + bh - cl, bx, by + bh, bx + cl, by + bh],
          [bx + bw - cl, by + bh, bx + bw, by + bh, bx + bw, by + bh - cl],
        ] as [number, number, number, number, number, number][];
        for (const [x1, y1, x2, y2, x3, y3] of corners) {
          ctx.beginPath();
          ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.lineTo(x3, y3);
          ctx.stroke();
        }

        // Heading arrow
        if (e.speed > 0.5) {
          const cx = bx + bw / 2;
          const cy = by + bh / 2;
          const len = Math.min(25, bw * 0.5);
          const ex = cx + Math.cos(e.heading) * len;
          const ey = cy + Math.sin(e.heading) * len;
          ctx.strokeStyle = "#facc15";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(cx, cy); ctx.lineTo(ex, ey);
          ctx.stroke();
          // Arrow tip
          const tip = Math.atan2(ey - cy, ex - cx);
          const ts = 5;
          ctx.beginPath();
          ctx.moveTo(ex, ey);
          ctx.lineTo(ex - ts * Math.cos(tip - 0.5), ey - ts * Math.sin(tip - 0.5));
          ctx.moveTo(ex, ey);
          ctx.lineTo(ex - ts * Math.cos(tip + 0.5), ey - ts * Math.sin(tip + 0.5));
          ctx.stroke();
        }

        // Label background
        const label = `${e.cls} ${e.speed.toFixed(0)}km/h`;
        ctx.font = "bold 10px monospace";
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = "rgba(0,0,0,0.85)";
        ctx.fillRect(bx, by - 18, tw + 8, 16);
        ctx.fillStyle = col;
        ctx.fillText(label, bx + 4, by - 5);

        // ID
        const id = `#${e.id}`;
        const iw = ctx.measureText(id).width;
        ctx.fillStyle = "rgba(0,0,0,0.85)";
        ctx.fillRect(bx + tw + 12, by - 18, iw + 8, 16);
        ctx.fillStyle = "#facc15";
        ctx.fillText(id, bx + tw + 16, by - 5);
      }

      // Status bar
      ctx.fillStyle = "rgba(0,0,0,0.7)";
      ctx.fillRect(0, dh - 20, dw, 20);
      ctx.fillStyle = "#fff";
      ctx.font = "11px Arial";
      ctx.fillText(`Objects: ${ents.length} | Alerts: ${al.length}`, 8, dh - 6);

      raf = requestAnimationFrame(paint);
    };

    raf = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(raf);
  }, [active, videoRef]);

  return <canvas ref={cvs} className="absolute inset-0 w-full h-full pointer-events-none" />;
}

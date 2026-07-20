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
  isStale?: boolean;
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

function getSeverityColor(confidence: number): string {
  if (confidence > 0.85) return "#ef4444"; // critical - red
  if (confidence > 0.65) return "#f97316"; // major - orange
  if (confidence > 0.45) return "#eab308"; // minor - yellow
  return "#6b7280"; // suspicious - gray
}

export default function DetectionOverlay({
  videoRef,
  entities,
  evidence,
  isAnalyzing,
  fps = 0,
}: DetectionOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const entitiesRef = useRef<Entity[]>([]);
  const evidenceRef = useRef<Evidence[]>([]);
  const rafRef = useRef(0);

  entitiesRef.current = entities;
  evidenceRef.current = evidence;

  const drawFrame = useCallback(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const rect = video.getBoundingClientRect();
    const displayW = Math.round(rect.width);
    const displayH = Math.round(rect.height);
    if (canvas.width !== displayW || canvas.height !== displayH) {
      canvas.width = displayW;
      canvas.height = displayH;
    }

    const currentEntities = entitiesRef.current;
    const currentEvidence = evidenceRef.current;

    ctx.clearRect(0, 0, displayW, displayH);

    const videoW = video.videoWidth || 640;
    const videoH = video.videoHeight || 480;
    const scaleX = displayW / videoW;
    const scaleY = displayH / videoH;

    // Draw evidence alerts (red overlay on involved entities)
    for (const ev of currentEvidence) {
      for (const objId of ev.objects) {
        const entity = currentEntities.find(e => e.id === objId);
        if (!entity || entity.age < 0) continue;

        const bx = (entity.x - entity.w / 2) * scaleX;
        const by = (entity.y - entity.h / 2) * scaleY;
        const bw = entity.w * scaleX;
        const bh = entity.h * scaleY;

        // Pulsing red border for alert
        const severityColor = getSeverityColor(ev.confidence);
        ctx.strokeStyle = severityColor;
        ctx.lineWidth = 3;
        ctx.setLineDash([5, 3]);
        ctx.strokeRect(bx - 2, by - 2, bw + 4, bh + 4);
        ctx.setLineDash([]);

        // Confidence badge
        const confText = `${(ev.confidence * 100).toFixed(0)}%`;
        ctx.font = `bold ${Math.max(10, 10 * scaleX)}px monospace`;
        const tw = ctx.measureText(confText).width;
        ctx.fillStyle = severityColor;
        ctx.fillRect(bx + bw - tw - 8, by - 18, tw + 8, 16);
        ctx.fillStyle = "#fff";
        ctx.fillText(confText, bx + bw - tw - 4, by - 5);
      }
    }

    // Draw entity bounding boxes — ALL detected objects, stale ones get faded
    for (const entity of currentEntities) {
      if (entity.age < 0) continue;

      const isStale = entity.isStale;
      const isInvolved = currentEvidence.some(e => e.objects.includes(entity.id));
      const baseColor = CLASS_COLORS[entity.class] || "#22c55e";
      const color = isInvolved ? getSeverityColor(currentEvidence.find(e => e.objects.includes(entity.id))?.confidence || 0) : baseColor;

      const bx = (entity.x - entity.w / 2) * scaleX;
      const by = (entity.y - entity.h / 2) * scaleY;
      const bw = entity.w * scaleX;
      const bh = entity.h * scaleY;

      // Bounding box — faded for stale entities
      ctx.globalAlpha = isStale ? 0.5 : 1.0;
      ctx.strokeStyle = color;
      ctx.lineWidth = isStale ? 1 : (isInvolved ? 3 : 2);
      ctx.strokeRect(bx, by, bw, bh);

      // Corner markers
      const cl = Math.min(8, bw * 0.15, bh * 0.15);
      ctx.lineWidth = 3;
      ctx.strokeStyle = color;
      const corners: [number, number, number, number, number, number][] = [
        [bx, by + cl, bx, by, bx + cl, by],
        [bx + bw - cl, by, bx + bw, by, bx + bw, by + cl],
        [bx, by + bh - cl, bx, by + bh, bx + cl, by + bh],
        [bx + bw - cl, by + bh, bx + bw, by + bh, bx + bw, by + bh - cl],
      ];
      for (const [x1, y1, x2, y2, x3, y3] of corners) {
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.lineTo(x3, y3);
        ctx.stroke();
      }

      // Track path trail
      if (entity.positions && entity.positions.length > 1) {
        ctx.beginPath();
        ctx.strokeStyle = `${color}66`;
        ctx.lineWidth = 1;
        const trail = entity.positions.slice(-5);
        trail.forEach((p, i) => {
          if (i === 0) ctx.moveTo(p.x * scaleX, p.y * scaleY);
          else ctx.lineTo(p.x * scaleX, p.y * scaleY);
        });
        ctx.stroke();
      }

      // Class label + confidence above box
      const label = `${entity.class} ${(entity.confidence * 100).toFixed(0)}%`;
      ctx.font = `bold ${Math.max(10, 10 * scaleX)}px monospace`;
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = "rgba(0,0,0,0.8)";
      ctx.fillRect(bx, by - 20, tw + 8, 18);
      ctx.fillStyle = isInvolved ? getSeverityColor(0.7) : "#22c55e";
      ctx.fillText(label, bx + 4, by - 6);

      // Track ID
      const idLabel = `#${entity.id}`;
      ctx.fillStyle = "rgba(0,0,0,0.8)";
      ctx.fillRect(bx + tw + 12, by - 20, ctx.measureText(idLabel).width + 8, 18);
      ctx.fillStyle = "#facc15";
      ctx.fillText(idLabel, bx + tw + 16, by - 6);

      ctx.globalAlpha = 1.0; // reset for next entity
    }

    // Bottom status bar
    const barH = 22;
    const barY = displayH - barH;
    ctx.fillStyle = "rgba(0,0,0,0.75)";
    ctx.fillRect(0, barY, displayW, barH);
    ctx.fillStyle = "#fff";
    ctx.font = `${Math.max(11, 11 * scaleX)}px Arial`;
    ctx.fillText(
      `Objects: ${currentEntities.filter(e => e.age >= 0).length} | Alerts: ${currentEvidence.length} | FPS: ${fps}`,
      8,
      barY + 15
    );
  }, [videoRef, fps]);

  useEffect(() => {
    if (!isAnalyzing) return;
    let lastDraw = 0;
    const draw = (timestamp: number) => {
      if (timestamp - lastDraw > 66) {
        lastDraw = timestamp;
        drawFrame();
      }
      rafRef.current = requestAnimationFrame(draw);
    };
    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, [isAnalyzing, drawFrame]);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 w-full h-full pointer-events-none"
    />
  );
}

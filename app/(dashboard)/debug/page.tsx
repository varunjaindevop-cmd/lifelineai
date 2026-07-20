"use client";

import { useState, useEffect } from "react";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";

const STORAGE_KEY = "sage_debug_thresholds";

const DEFAULTS = {
  iouThreshold: 0.2,
  speedDropPct: 0.40,
  fallConfThreshold: 0.6,
  confirmDurationMs: 500,
  cooldownMs: 5000,
};

export default function DebugPage() {
  const [values, setValues] = useState(DEFAULTS);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) setValues({ ...DEFAULTS, ...JSON.parse(raw) });
    } catch {}
  }, []);

  const update = (key: keyof typeof values, val: number) => {
    setValues(prev => {
      const next = { ...prev, [key]: val };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  };

  return (
    <div className="min-h-screen bg-background p-6">
      <Link href="/admin" className="inline-flex items-center gap-2 text-muted-foreground hover:text-foreground mb-4">
        <ArrowLeft size={16} /> Back
      </Link>
      <h1 className="text-2xl font-bold mb-6">Debug — Detection Calibration</h1>
      <p className="text-sm text-muted-foreground mb-6">Adjust thresholds below. Values save to localStorage and are read by the detection worker at runtime.</p>

      <div className="max-w-xl space-y-6">
        <div className="bg-card p-4 rounded-xl border border-border space-y-4">
          <h3 className="font-semibold">Collision Detection</h3>

          <div>
            <label className="text-sm text-muted-foreground">IoU Threshold: {values.iouThreshold.toFixed(2)}</label>
            <input type="range" min={0.05} max={0.5} step={0.01} value={values.iouThreshold}
              onChange={e => update("iouThreshold", parseFloat(e.target.value))} className="w-full" />
            <p className="text-xs text-muted-foreground">Minimum overlap ratio between two objects to consider a collision candidate.</p>
          </div>

          <div>
            <label className="text-sm text-muted-foreground">Speed Drop %: {(values.speedDropPct * 100).toFixed(0)}%</label>
            <input type="range" min={0.1} max={0.8} step={0.05} value={values.speedDropPct}
              onChange={e => update("speedDropPct", parseFloat(e.target.value))} className="w-full" />
            <p className="text-xs text-muted-foreground">Minimum speed reduction (compared to average of previous frames) to flag as deceleration.</p>
          </div>

          <div>
            <label className="text-sm text-muted-foreground">Fall Confidence: {values.fallConfThreshold.toFixed(2)}</label>
            <input type="range" min={0.3} max={0.95} step={0.05} value={values.fallConfThreshold}
              onChange={e => update("fallConfThreshold", parseFloat(e.target.value))} className="w-full" />
            <p className="text-xs text-muted-foreground">Minimum confidence for a fallen_person detection to count.</p>
          </div>
        </div>

        <div className="bg-card p-4 rounded-xl border border-border space-y-4">
          <h3 className="font-semibold">State Machine</h3>

          <div>
            <label className="text-sm text-muted-foreground">Confirm Duration: {values.confirmDurationMs}ms</label>
            <input type="range" min={200} max={3000} step={100} value={values.confirmDurationMs}
              onChange={e => update("confirmDurationMs", parseInt(e.target.value))} className="w-full" />
            <p className="text-xs text-muted-foreground">How long an event must persist before firing an alert.</p>
          </div>

          <div>
            <label className="text-sm text-muted-foreground">Cooldown: {values.cooldownMs}ms</label>
            <input type="range" min={1000} max={15000} step={500} value={values.cooldownMs}
              onChange={e => update("cooldownMs", parseInt(e.target.value))} className="w-full" />
            <p className="text-xs text-muted-foreground">Time to ignore new events after an alert fires.</p>
          </div>
        </div>

        <div className="bg-card p-4 rounded-xl border border-border">
          <h3 className="font-semibold mb-2">Current Values (JSON)</h3>
          <pre className="text-xs text-muted-foreground bg-background p-3 rounded overflow-x-auto">{JSON.stringify(values, null, 2)}</pre>
        </div>
      </div>
    </div>
  );
}

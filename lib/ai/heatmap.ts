/**
 * Safety heatmap generation for Leaflet maps.
 * Accumulates incident GPS coordinates and produces a heat layer.
 * Supports temporal decay and mode-specific intensity weighting.
 */

export interface HeatPoint {
  lat: number;
  lng: number;
  intensity: number;
  timestamp: number;
  mode: string;
}

const SEVERITY_WEIGHT: Record<string, number> = {
  critical: 1.0,
  major: 0.7,
  minor: 0.4,
  suspicious: 0.2,
};

// Mode-specific weight multipliers
const MODE_WEIGHT: Record<string, number> = {
  isolated: 1.0,    // isolated incidents are significant
  traffic: 0.85,    // traffic incidents slightly less weighted (more false positives)
  marketplace: 0.9, // marketplace incidents moderate weight
};

// Decay: incidents lose intensity over time (half-life: 24 hours)
const HALF_LIFE_MS = 24 * 60 * 60 * 1000;

/**
 * Convert an incident to a heat point with appropriate intensity.
 */
export function incidentToHeatPoint(incident: {
  latitude: number;
  longitude: number;
  severity: string;
  mode?: string;
  timestamp?: number;
}): HeatPoint {
  return {
    lat: incident.latitude,
    lng: incident.longitude,
    intensity: SEVERITY_WEIGHT[incident.severity] ?? 0.3,
    timestamp: incident.timestamp ?? Date.now(),
    mode: incident.mode ?? "isolated",
  };
}

/**
 * Apply temporal decay to a heat point.
 */
function applyDecay(point: HeatPoint, now: number): number {
  const age = now - point.timestamp;
  const decayFactor = Math.pow(0.5, age / HALF_LIFE_MS);
  const modeWeight = MODE_WEIGHT[point.mode] ?? 1.0;
  return point.intensity * decayFactor * modeWeight;
}

/**
 * Build a Leaflet heat layer from an array of heat points.
 */
export function createHeatLayer(
  points: HeatPoint[],
  map: L.Map
): L.Layer | null {
  if (!points.length) return null;

  const L = typeof window !== "undefined" ? require("leaflet") : null;
  if (!L || !L.heatLayer) return null;

  const now = Date.now();
  const latLngs = points
    .map((p) => [p.lat, p.lng, applyDecay(p, now)] as [number, number, number])
    .filter(([, , intensity]) => intensity > 0.05); // filter negligible points

  if (!latLngs.length) return null;

  return L.heatLayer(latLngs, {
    radius: 30,
    blur: 20,
    maxZoom: 17,
    max: 1.0,
    gradient: {
      0.0: "#22c55e",
      0.3: "#eab308",
      0.6: "#f97316",
      0.8: "#ef4444",
      1.0: "#7f1d1d",
    },
  });
}

/**
 * Grid-based heatmap with decay support.
 */
export function buildGridHeatmap(
  points: HeatPoint[],
  bounds: { latMin: number; latMax: number; lngMin: number; lngMax: number },
  gridSize: number = 10
): number[][] {
  const grid: number[][] = Array.from({ length: gridSize }, () =>
    new Array(gridSize).fill(0)
  );

  const latRange = bounds.latMax - bounds.latMin || 0.01;
  const lngRange = bounds.lngMax - bounds.lngMin || 0.01;
  const now = Date.now();

  for (const p of points) {
    const intensity = applyDecay(p, now);
    if (intensity < 0.05) continue;

    const row = Math.min(gridSize - 1, Math.max(0, Math.floor(((p.lat - bounds.latMin) / latRange) * gridSize)));
    const col = Math.min(gridSize - 1, Math.max(0, Math.floor(((p.lng - bounds.lngMin) / lngRange) * gridSize)));
    grid[row][col] += intensity;
  }

  const maxVal = Math.max(1, ...grid.flat());
  return grid.map((row) => row.map((v) => Math.min(1, v / maxVal)));
}

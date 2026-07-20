/**
 * Safety heatmap generation for Leaflet maps.
 * Accumulates incident GPS coordinates and produces a heat layer.
 */

export interface HeatPoint {
  lat: number;
  lng: number;
  intensity: number; // 0-1, higher = more severe
}

const SEVERITY_WEIGHT: Record<string, number> = {
  critical: 1.0,
  major: 0.7,
  minor: 0.4,
  suspicious: 0.2,
};

/**
 * Convert an incident to a heat point with appropriate intensity.
 */
export function incidentToHeatPoint(incident: {
  latitude: number;
  longitude: number;
  severity: string;
}): HeatPoint {
  return {
    lat: incident.latitude,
    lng: incident.longitude,
    intensity: SEVERITY_WEIGHT[incident.severity] ?? 0.3,
  };
}

/**
 * Build a Leaflet heat layer from an array of heat points.
 * Uses leaflet.heat plugin (L.heatLayer).
 */
export function createHeatLayer(
  points: HeatPoint[],
  map: L.Map
): L.Layer | null {
  if (!points.length) return null;

  const L = typeof window !== "undefined" ? require("leaflet") : null;
  if (!L || !L.heatLayer) return null;

  const latLngs = points.map((p) => [p.lat, p.lng, p.intensity] as [number, number, number]);

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
 * Grid-based heatmap: divide area into cells and count incidents per cell.
 * Useful for non-Leaflet rendering (e.g., Canvas-based heatmap).
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

  for (const p of points) {
    const row = Math.min(gridSize - 1, Math.max(0, Math.floor(((p.lat - bounds.latMin) / latRange) * gridSize)));
    const col = Math.min(gridSize - 1, Math.max(0, Math.floor(((p.lng - bounds.lngMin) / lngRange) * gridSize)));
    grid[row][col] += p.intensity;
  }

  // Normalize to 0-1
  const maxVal = Math.max(1, ...grid.flat());
  return grid.map((row) => row.map((v) => Math.min(1, v / maxVal)));
}

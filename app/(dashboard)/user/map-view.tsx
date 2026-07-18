"use client";

import { useEffect, useState, useCallback } from "react";
import { MapContainer, TileLayer, Marker, Popup, Circle, Polyline, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png",
  iconUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png",
  shadowUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png",
});

interface Incident {
  id: string;
  severity: string;
  incident_type: string;
  latitude: number;
  longitude: number;
  status: string;
  created_at: string;
}

interface RouteInfo {
  coordinates: [number, number][];
  distance: string;
  duration: string;
}

interface Props {
  center: { lat: number; lng: number };
  incidents: Incident[];
  onNavigate?: (incident: Incident) => void;
}

// Fetch route from OSRM (free, no API key)
async function fetchRoute(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number }
): Promise<RouteInfo | null> {
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson&steps=true`;
    const res = await fetch(url);
    const data = await res.json();

    if (data.code !== "Ok" || !data.routes.length) return null;

    const route = data.routes[0];
    const coords = route.geometry.coordinates.map(
      (c: [number, number]) => [c[1], c[0]] as [number, number]
    );

    const distKm = (route.distance / 1000).toFixed(1);
    const mins = Math.round(route.duration / 60);

    return {
      coordinates: coords,
      distance: `${distKm} km`,
      duration: mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)}h ${mins % 60}m`,
    };
  } catch {
    return null;
  }
}

// Auto-fit map to show route
function FitRoute({ route }: { route: RouteInfo | null }) {
  const map = useMap();

  useEffect(() => {
    if (route && route.coordinates.length > 0) {
      const bounds = L.latLngBounds(route.coordinates);
      map.fitBounds(bounds, { padding: [40, 40] });
    }
  }, [route, map]);

  return null;
}

// Center on user location
function CenterOnUser({ position }: { position: { lat: number; lng: number } }) {
  const map = useMap();

  useEffect(() => {
    map.setView([position.lat, position.lng], 14);
  }, [position.lat, position.lng, map]);

  return null;
}

export default function MapView({ center, incidents }: Props) {
  const [activeRoute, setActiveRoute] = useState<RouteInfo | null>(null);
  const [routeTo, setRouteTo] = useState<Incident | null>(null);
  const [loadingRoute, setLoadingRoute] = useState(false);

  const handleGetRoute = useCallback(
    async (incident: Incident) => {
      setLoadingRoute(true);
      setRouteTo(incident);
      const route = await fetchRoute(center, {
        lat: incident.latitude,
        lng: incident.longitude,
      });
      setActiveRoute(route);
      setLoadingRoute(false);
    },
    [center]
  );

  const clearRoute = () => {
    setActiveRoute(null);
    setRouteTo(null);
  };

  const getIncidentIcon = (severity: string) => {
    const colors: Record<string, string> = {
      critical: "#EF4444",
      major: "#F97316",
      minor: "#EAB308",
      suspicious: "#8B5CF6",
    };
    const color = colors[severity] || "#64748B";
    return L.divIcon({
      className: "incident-marker",
      html: `<div style="
        width: 28px; height: 28px;
        background: ${color};
        border-radius: 50%;
        border: 3px solid white;
        box-shadow: 0 2px 8px rgba(0,0,0,0.3);
        display: flex; align-items: center; justify-content: center;
      "><svg width="14" height="14" viewBox="0 0 24 24" fill="white"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg></div>`,
      iconSize: [28, 28],
      iconAnchor: [14, 14],
    });
  };

  return (
    <div className="relative h-full">
      <MapContainer
        center={[center.lat, center.lng]}
        zoom={14}
        style={{ height: "100%", width: "100%", background: "#0F172A" }}
        zoomControl={false}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />

        <CenterOnUser position={center} />

        {/* User Location Marker */}
        <Marker
          position={[center.lat, center.lng]}
          icon={L.divIcon({
            className: "user-marker",
            html: `<div style="
              width: 20px; height: 20px;
              background: #3B82F6;
              border-radius: 50%;
              border: 3px solid white;
              box-shadow: 0 0 15px rgba(59,130,246,0.6);
            "></div>`,
            iconSize: [20, 20],
            iconAnchor: [10, 10],
          })}
        />

        {/* Incident Zones */}
        {incidents.map((inc) => (
          <div key={inc.id}>
            <Circle
              center={[inc.latitude, inc.longitude]}
              radius={inc.severity === "critical" ? 500 : inc.severity === "major" ? 300 : 150}
              pathOptions={{
                color: inc.severity === "critical" ? "#EF4444" : inc.severity === "major" ? "#F97316" : "#EAB308",
                fillColor: inc.severity === "critical" ? "#EF4444" : inc.severity === "major" ? "#F97316" : "#EAB308",
                fillOpacity: 0.15,
                weight: 1,
              }}
            />
            <Marker
              position={[inc.latitude, inc.longitude]}
              icon={getIncidentIcon(inc.severity)}
            >
              <Popup>
                <div className="text-sm min-w-[160px]">
                  <strong className="capitalize">{inc.incident_type.replace(/_/g, " ")}</strong>
                  <br />
                  <span className="text-gray-500 text-xs">{inc.severity} severity</span>
                  <br />
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleGetRoute(inc);
                    }}
                    className="mt-2 px-3 py-1 bg-blue-500 text-white rounded text-xs hover:bg-blue-600 w-full"
                  >
                    {loadingRoute && routeTo?.id === inc.id ? "Finding route..." : "Show Route"}
                  </button>
                </div>
              </Popup>
            </Marker>
          </div>
        ))}

        {/* Route Line */}
        {activeRoute && (
          <>
            <FitRoute route={activeRoute} />
            <Polyline
              positions={activeRoute.coordinates}
              pathOptions={{
                color: "#3B82F6",
                weight: 5,
                opacity: 0.8,
                dashArray: "10, 6",
              }}
            />
            {/* Destination marker */}
            {routeTo && (
              <Marker
                position={[routeTo.latitude, routeTo.longitude]}
                icon={L.divIcon({
                  className: "dest-marker",
                  html: `<div style="
                    width: 32px; height: 32px;
                    background: #22C55E;
                    border-radius: 50%;
                    border: 3px solid white;
                    box-shadow: 0 2px 8px rgba(0,0,0,0.3);
                    display: flex; align-items: center; justify-content: center;
                  "><svg width="16" height="16" viewBox="0 0 24 24" fill="white"><path d="M21.71 11.29l-9-9a1 1 0 00-1.42 0l-9 9a1 1 0 000 1.42l9 9a1 1 0 001.42 0l9-9a1 1 0 000-1.42zM14 14.5V12h-4v3H8v-4a1 1 0 011-1h5V7.5l3.5 3.5-3.5 3.5z"/></svg></div>`,
                  iconSize: [32, 32],
                  iconAnchor: [16, 16],
                })}
              />
            )}
          </>
        )}
      </MapContainer>

      {/* Route Info Panel */}
      {activeRoute && (
        <div className="absolute bottom-3 left-3 right-3 z-[1000]">
          <div className="bg-card/95 backdrop-blur-sm border border-border rounded-xl p-4 shadow-lg">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 bg-primary/20 rounded-lg flex items-center justify-center">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="#3B82F4" className="rotate-180"><path d="M21.71 11.29l-9-9a1 1 0 00-1.42 0l-9 9a1 1 0 000 1.42l9 9a1 1 0 001.42 0l9-9a1 1 0 000-1.42zM14 14.5V12h-4v3H8v-4a1 1 0 011-1h5V7.5l3.5 3.5-3.5 3.5z"/></svg>
                </div>
                <div>
                  <p className="font-semibold text-sm">
                    {activeRoute.distance} • {activeRoute.duration}
                  </p>
                  <p className="text-xs text-muted-foreground capitalize">
                    To {routeTo?.incident_type.replace(/_/g, " ")}
                  </p>
                </div>
              </div>
              <button
                onClick={clearRoute}
                className="px-3 py-1.5 bg-severity-critical/20 text-severity-critical rounded-lg text-xs font-medium"
              >
                Clear
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

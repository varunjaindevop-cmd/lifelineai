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

interface Construction {
  id: string;
  lat: number;
  lng: number;
  label: string;
}

interface RouteInfo {
  coordinates: [number, number][];
  distance: string;
  duration: string;
}

interface Props {
  center: { lat: number; lng: number };
  incidents: Incident[];
  destination?: { lat: number; lng: number; name: string } | null;
  constructionZones?: Construction[];
}

async function fetchRoute(from: { lat: number; lng: number }, to: { lat: number; lng: number }): Promise<RouteInfo | null> {
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.code !== "Ok" || !data.routes.length) return null;
    const route = data.routes[0];
    const coords = route.geometry.coordinates.map((c: [number, number]) => [c[1], c[0]] as [number, number]);
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

function FitView({ route, destination, center }: { route: RouteInfo | null; destination: Props["destination"]; center: { lat: number; lng: number } }) {
  const map = useMap();
  useEffect(() => {
    if (route && route.coordinates.length > 0) {
      map.fitBounds(L.latLngBounds(route.coordinates), { padding: [40, 40] });
    } else if (destination) {
      map.fitBounds([[center.lat, center.lng], [destination.lat, destination.lng]], { padding: [60, 60] });
    }
  }, [route, destination, center, map]);
  return null;
}

function CenterOnUser({ position }: { position: { lat: number; lng: number } }) {
  const map = useMap();
  useEffect(() => {
    map.setView([position.lat, position.lng], 14);
  }, [position.lat, position.lng, map]);
  return null;
}

export default function MapView({ center, incidents, destination, constructionZones = [] }: Props) {
  const [activeRoute, setActiveRoute] = useState<RouteInfo | null>(null);
  const [routeLoading, setRouteLoading] = useState(false);

  // Auto-route when destination changes
  useEffect(() => {
    if (!destination) { setActiveRoute(null); return; }
    let cancelled = false;
    const getRoute = async () => {
      setRouteLoading(true);
      const route = await fetchRoute(center, { lat: destination.lat, lng: destination.lng });
      if (!cancelled) { setActiveRoute(route); setRouteLoading(false); }
    };
    getRoute();
    return () => { cancelled = true; };
  }, [destination, center]);

  const getIncidentIcon = (severity: string) => {
    const color = severity === "critical" ? "#EF4444" : severity === "major" ? "#F97316" : severity === "minor" ? "#EAB308" : "#8B5CF6";
    return L.divIcon({
      className: "incident-marker",
      html: `<div style="width:28px;height:28px;background:${color};border-radius:50%;border:3px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center;"><svg width="14" height="14" viewBox="0 0 24 24" fill="white"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg></div>`,
      iconSize: [28, 28],
      iconAnchor: [14, 14],
    });
  };

  return (
    <div className="relative h-full">
      <MapContainer center={[center.lat, center.lng]} zoom={14} style={{ height: "100%", width: "100%", background: "#0F172A" }} zoomControl={false}>
        <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />

        <CenterOnUser position={center} />

        {/* User Marker */}
        <Marker position={[center.lat, center.lng]} icon={L.divIcon({
          className: "user-marker",
          html: `<div style="width:20px;height:20px;background:#3B82F6;border-radius:50%;border:3px solid white;box-shadow:0 0 15px rgba(59,130,246,0.6);"></div>`,
          iconSize: [20, 20], iconAnchor: [10, 10],
        })} />

        {/* Construction Zones */}
        {constructionZones.map((zone) => (
          <div key={zone.id}>
            <Circle center={[zone.lat, zone.lng]} radius={200} pathOptions={{ color: "#F97316", fillColor: "#F97316", fillOpacity: 0.2, weight: 2, dashArray: "5,5" }} />
            <Marker position={[zone.lat, zone.lng]} icon={L.divIcon({
              className: "construction-marker",
              html: `<div style="width:24px;height:24px;background:#F97316;border-radius:4px;border:2px solid white;display:flex;align-items:center;justify-content:center;"><svg width="12" height="12" viewBox="0 0 24 24" fill="white"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg></div>`,
              iconSize: [24, 24], iconAnchor: [12, 12],
            })}>
              <Popup><div className="text-sm"><strong>Road Work</strong><br />{zone.label}</div></Popup>
            </Marker>
          </div>
        ))}

        {/* Incidents */}
        {incidents.map((inc) => (
          <div key={inc.id}>
            <Circle center={[inc.latitude, inc.longitude]} radius={inc.severity === "critical" ? 500 : inc.severity === "major" ? 300 : 150}
              pathOptions={{
                color: inc.severity === "critical" ? "#EF4444" : inc.severity === "major" ? "#F97316" : "#EAB308",
                fillColor: inc.severity === "critical" ? "#EF4444" : inc.severity === "major" ? "#F97316" : "#EAB308",
                fillOpacity: 0.15, weight: 1,
              }} />
            <Marker position={[inc.latitude, inc.longitude]} icon={getIncidentIcon(inc.severity)}>
              <Popup>
                <div className="text-sm min-w-[140px]">
                  <strong className="capitalize">{inc.incident_type.replace(/_/g, " ")}</strong><br />
                  <span className="text-gray-500 text-xs">{inc.severity}</span>
                </div>
              </Popup>
            </Marker>
          </div>
        ))}

        {/* Route */}
        {activeRoute && (
          <>
            <FitView route={activeRoute} destination={destination} center={center} />
            <Polyline positions={activeRoute.coordinates} pathOptions={{ color: "#3B82F6", weight: 5, opacity: 0.8, dashArray: "10,6" }} />
            {destination && (
              <Marker position={[destination.lat, destination.lng]} icon={L.divIcon({
                className: "dest-marker",
                html: `<div style="width:32px;height:32px;background:#22C55E;border-radius:50%;border:3px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center;"><svg width="16" height="16" viewBox="0 0 24 24" fill="white"><path d="M21.71 11.29l-9-9a1 1 0 00-1.42 0l-9 9a1 1 0 000 1.42l9 9a1 1 0 001.42 0l9-9a1 1 0 000-1.42zM14 14.5V12h-4v3H8v-4a1 1 0 011-1h5V7.5l3.5 3.5-3.5 3.5z"/></svg></div>`,
                iconSize: [32, 32], iconAnchor: [16, 16],
              })} />
            )}
          </>
        )}
      </MapContainer>

      {/* Route Info Panel */}
      {destination && (
        <div className="absolute bottom-3 left-3 right-3 z-[1000]">
          <div className="bg-card/95 backdrop-blur-sm border border-border rounded-xl p-3 shadow-lg flex items-center justify-between">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-8 h-8 bg-primary/20 rounded-lg flex items-center justify-center flex-shrink-0">
                <Navigation size={16} className="text-primary" />
              </div>
              <div className="min-w-0">
                {routeLoading ? (
                  <p className="text-sm text-muted-foreground">Finding safe route...</p>
                ) : activeRoute ? (
                  <>
                    <p className="font-semibold text-sm">{activeRoute.distance} • {activeRoute.duration}</p>
                    <p className="text-xs text-muted-foreground truncate">{destination.name}</p>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">No route found</p>
                )}
              </div>
            </div>
            <button onClick={() => {}} className="px-3 py-1.5 bg-severity-critical/20 text-severity-critical rounded-lg text-xs font-medium flex-shrink-0">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

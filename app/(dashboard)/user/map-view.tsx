"use client";

import { useEffect, useMemo } from "react";
import { MapContainer, TileLayer, Marker, Popup, Circle, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import Link from "next/link";

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

interface Props {
  center: { lat: number; lng: number };
  incidents: Incident[];
}

function UserMarker({ position }: { position: { lat: number; lng: number } }) {
  const map = useMap();

  useEffect(() => {
    map.setView([position.lat, position.lng], 14);
  }, [position.lat, position.lng]);

  return (
    <Marker
      position={[position.lat, position.lng]}
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
  );
}

export default function MapView({ center, incidents }: Props) {
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

      <UserMarker position={center} />

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
              <div className="text-sm">
                <strong className="capitalize">{inc.incident_type.replace(/_/g, " ")}</strong>
                <br />
                <span className="text-gray-500">{inc.severity}</span>
                <br />
                <a
                  href={`https://www.google.com/maps/dir/?api=1&destination=${inc.latitude},${inc.longitude}`}
                  target="_blank"
                  className="text-blue-500 hover:underline"
                >
                  Get Directions
                </a>
              </div>
            </Popup>
          </Marker>
        </div>
      ))}
    </MapContainer>
  );
}

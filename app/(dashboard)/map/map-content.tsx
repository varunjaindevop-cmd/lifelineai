"use client";

import { useEffect, useState, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { MapContainer, TileLayer, Marker, Popup, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { AlertTriangle, Camera, Building2 } from "lucide-react";
import Link from "next/link";

delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl:
    "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png",
  iconUrl:
    "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png",
  shadowUrl:
    "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png",
});

interface Camera {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  is_active: boolean;
}

interface Incident {
  id: string;
  severity: string;
  incident_type: string;
  latitude: number;
  longitude: number;
  status: string;
  created_at: string;
}

interface Hospital {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  available_beds: number;
}

function MapEvents() {
  const map = useMap();
  const searchParams = useSearchParams();

  useEffect(() => {
    const lat = searchParams.get("lat");
    const lng = searchParams.get("lng");
    if (lat && lng) {
      map.setView([parseFloat(lat), parseFloat(lng)], 15);
    }
  }, [searchParams, map]);

  return null;
}

export default function MapContent() {
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [hospitals, setHospitals] = useState<Hospital[]>([]);
  const [showCameras, setShowCameras] = useState(true);
  const [showIncidents, setShowIncidents] = useState(true);
  const [showHospitals, setShowHospitals] = useState(true);
  const supabase = createClient();

  useEffect(() => {
    const fetchData = async () => {
      const [camerasData, incidentsData, hospitalsData] = await Promise.all([
        supabase.from("cameras").select("*"),
        supabase
          .from("incidents")
          .select("*")
          .in("status", ["detected", "acknowledged", "responding"])
          .order("created_at", { ascending: false }),
        supabase.from("hospitals").select("*").eq("is_active", true),
      ]);

      if (camerasData.data) setCameras(camerasData.data);
      if (incidentsData.data) setIncidents(incidentsData.data);
      if (hospitalsData.data) setHospitals(hospitalsData.data);
    };

    fetchData();

    const channel = supabase
      .channel("map-updates")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "incidents" },
        () => fetchData()
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const center = useMemo(() => {
    if (cameras.length > 0) {
      return [cameras[0].latitude, cameras[0].longitude] as [number, number];
    }
    if (incidents.length > 0) {
      return [incidents[0].latitude, incidents[0].longitude] as [number, number];
    }
    return [28.6139, 77.209] as [number, number];
  }, [cameras, incidents]);

  const getIncidentIcon = (severity: string) => {
    const colors: Record<string, string> = {
      critical: "#EF4444",
      major: "#F97316",
      minor: "#EAB308",
      suspicious: "#8B5CF6",
    };
    const color = colors[severity] || "#64748B";

    return L.divIcon({
      className: "custom-marker",
      html: `<div style="
        width: 24px; height: 24px; 
        background: ${color}; 
        border-radius: 50%; 
        border: 3px solid white;
        box-shadow: 0 0 10px ${color};
        animation: pulse 1.5s infinite;
      "></div>`,
      iconSize: [24, 24],
      iconAnchor: [12, 12],
    });
  };

  return (
    <div className="h-[calc(100vh-8rem)] flex flex-col">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold">Live Map</h1>
        <div className="flex gap-2">
          <button
            onClick={() => setShowCameras(!showCameras)}
            className={`px-3 py-1.5 rounded-lg text-sm flex items-center gap-2 ${
              showCameras
                ? "bg-primary text-white"
                : "bg-card border border-border text-muted-foreground"
            }`}
          >
            <Camera size={14} />
            Cameras ({cameras.length})
          </button>
          <button
            onClick={() => setShowIncidents(!showIncidents)}
            className={`px-3 py-1.5 rounded-lg text-sm flex items-center gap-2 ${
              showIncidents
                ? "bg-severity-critical text-white"
                : "bg-card border border-border text-muted-foreground"
            }`}
          >
            <AlertTriangle size={14} />
            Incidents ({incidents.length})
          </button>
          <button
            onClick={() => setShowHospitals(!showHospitals)}
            className={`px-3 py-1.5 rounded-lg text-sm flex items-center gap-2 ${
              showHospitals
                ? "bg-green-500 text-white"
                : "bg-card border border-border text-muted-foreground"
            }`}
          >
            <Building2 size={14} />
            Hospitals ({hospitals.length})
          </button>
        </div>
      </div>

      <div className="flex-1 rounded-xl overflow-hidden border border-border">
        <MapContainer
          center={center}
          zoom={12}
          style={{ height: "100%", width: "100%", background: "#0F172A" }}
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <MapEvents />

          {showCameras &&
            cameras.map((camera) => (
              <Marker
                key={`cam-${camera.id}`}
                position={[camera.latitude, camera.longitude]}
                icon={L.divIcon({
                  className: "custom-marker",
                  html: `<div style="
                    width: 20px; height: 20px; 
                    background: #3B82F6; 
                    border-radius: 4px; 
                    border: 2px solid white;
                    display: flex; align-items: center; justify-content: center;
                  "><svg width="12" height="12" viewBox="0 0 24 24" fill="white"><path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/></svg></div>`,
                  iconSize: [20, 20],
                  iconAnchor: [10, 10],
                })}
              >
                <Popup>
                  <div>
                    <strong>{camera.name}</strong>
                    <br />
                    Status: {camera.is_active ? "Active" : "Inactive"}
                    <br />
                    <Link
                      href={`/cameras/${camera.id}`}
                      className="text-primary hover:underline"
                    >
                      View Feed
                    </Link>
                  </div>
                </Popup>
              </Marker>
            ))}

          {showIncidents &&
            incidents.map((incident) => (
              <Marker
                key={`inc-${incident.id}`}
                position={[incident.latitude, incident.longitude]}
                icon={getIncidentIcon(incident.severity)}
              >
                <Popup>
                  <div>
                    <strong>{incident.incident_type.replace(/_/g, " ")}</strong>
                    <br />
                    Severity: {incident.severity}
                    <br />
                    Status: {incident.status}
                    <br />
                    <Link
                      href={`/incidents/${incident.id}`}
                      className="text-primary hover:underline"
                    >
                      View Details
                    </Link>
                  </div>
                </Popup>
              </Marker>
            ))}

          {showHospitals &&
            hospitals.map((hospital) => (
              <Marker
                key={`hosp-${hospital.id}`}
                position={[hospital.latitude, hospital.longitude]}
                icon={L.divIcon({
                  className: "custom-marker",
                  html: `<div style="
                    width: 24px; height: 24px; 
                    background: #22C55E; 
                    border-radius: 50%; 
                    border: 2px solid white;
                    display: flex; align-items: center; justify-content: center;
                    font-size: 12px; color: white; font-weight: bold;
                  ">H</div>`,
                  iconSize: [24, 24],
                  iconAnchor: [12, 12],
                })}
              >
                <Popup>
                  <div>
                    <strong>{hospital.name}</strong>
                    <br />
                    Available Beds: {hospital.available_beds}
                  </div>
                </Popup>
              </Marker>
            ))}
        </MapContainer>
      </div>

      <div className="mt-4 flex items-center gap-6 text-sm text-muted-foreground">
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 bg-severity-critical rounded-full" />
          Critical
        </div>
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 bg-severity-major rounded-full" />
          Major
        </div>
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 bg-severity-minor rounded-full" />
          Minor
        </div>
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 bg-severity-suspicious rounded-full" />
          Suspicious
        </div>
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 bg-primary rounded" />
          Camera
        </div>
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 bg-green-500 rounded-full" />
          Hospital
        </div>
      </div>
    </div>
  );
}

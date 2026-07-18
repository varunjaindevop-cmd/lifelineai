"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import {
  ArrowLeft,
  MapPin,
  Clock,
  Video,
  AlertTriangle,
  Building2,
} from "lucide-react";
import Link from "next/link";

interface Incident {
  id: string;
  severity: string;
  incident_type: string;
  latitude: number;
  longitude: number;
  status: string;
  created_at: string;
  video_clip_url?: string;
  detection_confidence?: number;
  detection_data?: any;
  description?: string;
  location_name?: string;
  camera_id?: string;
}

interface Hospital {
  name: string;
  distance_km: number;
  available_beds: number;
}

export default function IncidentDetailPage() {
  const params = useParams();
  const [incident, setIncident] = useState<Incident | null>(null);
  const [nearestHospitals, setNearestHospitals] = useState<Hospital[]>([]);
  const [loading, setLoading] = useState(true);
  const supabase = createClient();

  useEffect(() => {
    const fetchIncident = async () => {
      const { data } = await supabase
        .from("incidents")
        .select("*")
        .eq("id", params.id)
        .single();

      if (data) {
        setIncident(data);

        // Find nearest hospitals
        const { data: hospitals } = await supabase.rpc("find_nearest_hospital", {
          incident_lat: data.latitude,
          incident_lon: data.longitude,
        });

        if (hospitals) {
          setNearestHospitals(hospitals);
        }
      }
      setLoading(false);
    };

    fetchIncident();
  }, [params.id]);

  if (loading) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        Loading incident details...
      </div>
    );
  }

  if (!incident) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        Incident not found
      </div>
    );
  }

  const getSeverityColor = (severity: string) => {
    const colors: Record<string, string> = {
      critical: "bg-severity-critical",
      major: "bg-severity-major",
      minor: "bg-severity-minor",
      suspicious: "bg-severity-suspicious",
    };
    return colors[severity] || "bg-muted";
  };

  return (
    <div className="space-y-6 max-w-4xl">
      <Link
        href="/incidents"
        className="inline-flex items-center gap-2 text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft size={16} />
        Back to Incidents
      </Link>

      {/* Header */}
      <div className="bg-card p-6 rounded-xl border border-border">
        <div className="flex items-start justify-between">
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <div
                className={`w-3 h-3 rounded-full ${getSeverityColor(
                  incident.severity
                )}`}
              />
              <h1 className="text-2xl font-bold">
                {incident.incident_type.replace(/_/g, " ")}
              </h1>
            </div>
            <div className="flex items-center gap-4 text-sm text-muted-foreground">
              <span className="flex items-center gap-1">
                <MapPin size={14} />
                {incident.location_name ||
                  `${incident.latitude.toFixed(4)}, ${incident.longitude.toFixed(
                    4
                  )}`}
              </span>
              <span className="flex items-center gap-1">
                <Clock size={14} />
                {new Date(incident.created_at).toLocaleString()}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={`px-3 py-1 rounded text-sm font-medium ${
                incident.severity === "critical"
                  ? "bg-severity-critical/20 text-severity-critical"
                  : incident.severity === "major"
                  ? "bg-severity-major/20 text-severity-major"
                  : "bg-severity-minor/20 text-severity-minor"
              }`}
            >
              {incident.severity}
            </span>
            <span
              className={`px-3 py-1 rounded text-sm font-medium ${
                incident.status === "resolved"
                  ? "bg-green-500/20 text-green-500"
                  : "bg-primary/20 text-primary"
              }`}
            >
              {incident.status}
            </span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Video Evidence */}
        <div className="bg-card rounded-xl border border-border overflow-hidden">
          <div className="p-4 border-b border-border">
            <h2 className="font-semibold flex items-center gap-2">
              <Video size={18} />
              Video Evidence
            </h2>
          </div>
          {incident.video_clip_url ? (
            <div className="aspect-video bg-background">
              <video
                src={incident.video_clip_url}
                controls
                className="w-full h-full"
              />
            </div>
          ) : (
            <div className="aspect-video bg-background flex items-center justify-center text-muted-foreground">
              No video clip available
            </div>
          )}
          <div className="p-4 text-sm text-muted-foreground">
            30-second clip (15s before + 15s after detection)
          </div>
        </div>

        {/* Detection Details */}
        <div className="space-y-6">
          <div className="bg-card p-6 rounded-xl border border-border">
            <h2 className="font-semibold mb-4 flex items-center gap-2">
              <AlertTriangle size={18} />
              Detection Details
            </h2>
            <div className="space-y-3">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Confidence</span>
                <span className="font-medium">
                  {incident.detection_confidence
                    ? `${Math.round(incident.detection_confidence * 100)}%`
                    : "N/A"}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Type</span>
                <span className="font-medium">
                  {incident.incident_type.replace(/_/g, " ")}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Location</span>
                <span className="font-medium">
                  {incident.latitude.toFixed(4)}, {incident.longitude.toFixed(4)}
                </span>
              </div>
              {incident.description && (
                <div className="pt-2 border-t border-border">
                  <p className="text-sm text-muted-foreground mb-1">
                    Description
                  </p>
                  <p className="text-sm">{incident.description}</p>
                </div>
              )}
            </div>
          </div>

          {/* Nearest Hospitals */}
          <div className="bg-card p-6 rounded-xl border border-border">
            <h2 className="font-semibold mb-4 flex items-center gap-2">
              <Building2 size={18} />
              Nearest Hospitals
            </h2>
            {nearestHospitals.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Calculating nearest hospitals...
              </p>
            ) : (
              <div className="space-y-3">
                {nearestHospitals.slice(0, 3).map((hospital, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between p-3 bg-background rounded-lg"
                  >
                    <div>
                      <p className="font-medium">{hospital.name}</p>
                      <p className="text-sm text-muted-foreground">
                        {hospital.distance_km.toFixed(1)} km away
                      </p>
                    </div>
                    <div className="text-right">
                      <p
                        className={`font-medium ${
                          hospital.available_beds > 0
                            ? "text-green-500"
                            : "text-severity-critical"
                        }`}
                      >
                        {hospital.available_beds} beds
                      </p>
                      <p className="text-xs text-muted-foreground">available</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Map */}
      <div className="bg-card rounded-xl border border-border overflow-hidden">
        <div className="p-4 border-b border-border">
          <h2 className="font-semibold flex items-center gap-2">
            <MapPin size={18} />
            Location
          </h2>
        </div>
        <div className="h-64 bg-background flex items-center justify-center">
          <Link
            href={`/map?lat=${incident.latitude}&lng=${incident.longitude}`}
            className="text-primary hover:underline"
          >
            View on Live Map →
          </Link>
        </div>
      </div>
    </div>
  );
}

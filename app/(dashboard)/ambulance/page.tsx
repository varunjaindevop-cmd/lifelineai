"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { AlertTriangle, MapPin, Clock, Navigation, Video, Play } from "lucide-react";
import { toast } from "sonner";
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
  location_name?: string;
  camera_id?: string;
}

export default function AmbulanceDashboard() {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [loading, setLoading] = useState(true);
  const [playingClip, setPlayingClip] = useState<string | null>(null);
  const supabase = createClient();

  useEffect(() => {
    const fetchIncidents = async () => {
      const { data } = await supabase
        .from("incidents")
        .select("*")
        .in("incident_type", [
          "vehicle_collision",
          "pedestrian_collision",
          "pedestrian_fall",
          "fire_smoke",
        ])
        .in("status", ["detected", "acknowledged", "responding"])
        .order("created_at", { ascending: false });

      if (data) setIncidents(data);
      setLoading(false);
    };

    fetchIncidents();

    const channel = supabase
      .channel("ambulance-alerts")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "incidents" },
        (payload) => {
          const inc = payload.new as Incident;
          const accidentTypes = [
            "vehicle_collision",
            "pedestrian_collision",
            "pedestrian_fall",
            "fire_smoke",
          ];
          if (accidentTypes.includes(inc.incident_type)) {
            setIncidents((prev) => [inc, ...prev]);
            toast.error(
              `NEW ${inc.severity.toUpperCase()} ${inc.incident_type.replace(/_/g, " ")}`
            );
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const handleRespond = async (incidentId: string) => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;

    await supabase.from("incident_responses").insert({
      incident_id: incidentId,
      responder_id: user.id,
      response_type: "dispatched",
    });

    await supabase
      .from("incidents")
      .update({ status: "responding" })
      .eq("id", incidentId);

    setIncidents((prev) =>
      prev.map((i) => (i.id === incidentId ? { ...i, status: "responding" } : i))
    );

    toast.success("Response dispatched!");
  };

  const critical = incidents.filter((i) => i.severity === "critical").length;
  const major = incidents.filter((i) => i.severity === "major").length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Ambulance Dashboard</h1>
        <p className="text-muted-foreground">
          Accident incidents requiring medical response
        </p>
      </div>

      {/* Quick Stats */}
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-card p-4 rounded-xl border border-border text-center">
          <p className="text-3xl font-bold text-severity-critical">{critical}</p>
          <p className="text-sm text-muted-foreground">Critical</p>
        </div>
        <div className="bg-card p-4 rounded-xl border border-border text-center">
          <p className="text-3xl font-bold text-severity-major">{major}</p>
          <p className="text-sm text-muted-foreground">Major</p>
        </div>
      </div>

      {/* Incident Cards */}
      {loading ? (
        <div className="text-center py-12 text-muted-foreground">Loading incidents...</div>
      ) : incidents.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          No active incidents. All clear!
        </div>
      ) : (
        <div className="space-y-4">
          {incidents.map((incident) => (
            <div
              key={incident.id}
              className={`bg-card p-5 rounded-xl border-l-4 ${
                incident.severity === "critical"
                  ? "border-severity-critical"
                  : "border-severity-major"
              }`}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-3 flex-1">
                  {/* Title */}
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="w-5 h-5" />
                    <h3 className="font-semibold text-lg capitalize">
                      {incident.incident_type.replace(/_/g, " ")}
                    </h3>
                    <span
                      className={`px-2 py-0.5 rounded text-xs font-medium ${
                        incident.severity === "critical"
                          ? "bg-severity-critical/20 text-severity-critical"
                          : "bg-severity-major/20 text-severity-major"
                      }`}
                    >
                      {incident.severity}
                    </span>
                  </div>

                  {/* Time & Location */}
                  <div className="flex items-center gap-4 text-sm text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <MapPin size={14} />
                      {incident.location_name ||
                        `${incident.latitude.toFixed(4)}, ${incident.longitude.toFixed(4)}`}
                    </span>
                    <span className="flex items-center gap-1">
                      <Clock size={14} />
                      {new Date(incident.created_at).toLocaleTimeString()}
                    </span>
                  </div>

                  {/* 30-Second Clip */}
                  {incident.video_clip_url ? (
                    <div className="bg-background rounded-lg overflow-hidden">
                      <video
                        src={incident.video_clip_url}
                        controls
                        preload="none"
                        className="w-full max-h-48"
                      />
                      <div className="px-3 py-2 text-xs text-muted-foreground flex items-center gap-1">
                        <Video size={12} />
                        30-second incident clip (15s before + 15s after detection)
                      </div>
                    </div>
                  ) : (
                    <div className="bg-background rounded-lg p-4 text-center text-sm text-muted-foreground">
                      <Video size={20} className="mx-auto mb-1 opacity-50" />
                      {incident.location_name?.startsWith("Demo Clip:")
                        ? "Video analysis incident — view details in Admin > Video Analysis"
                        : "Clip processing..."}
                    </div>
                  )}

                  {/* Actions */}
                  <div className="flex gap-2">
                    <Link
                      href={`https://www.google.com/maps/dir/?api=1&destination=${incident.latitude},${incident.longitude}`}
                      target="_blank"
                      className="px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors text-sm flex items-center gap-2"
                    >
                      <Navigation size={14} />
                      Navigate
                    </Link>
                    {incident.status !== "responding" && (
                      <button
                        onClick={() => handleRespond(incident.id)}
                        className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors text-sm"
                      >
                        Respond
                      </button>
                    )}
                    {incident.status === "responding" && (
                      <span className="px-4 py-2 bg-primary/20 text-primary rounded-lg text-sm font-medium">
                        En Route
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

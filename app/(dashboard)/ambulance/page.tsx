"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { AlertTriangle, MapPin, Clock, Navigation } from "lucide-react";
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
  detection_data: any;
}

export default function AmbulanceDashboard() {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [loading, setLoading] = useState(true);
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

      if (data) {
        setIncidents(data);
      }
      setLoading(false);
    };

    fetchIncidents();

    // Real-time subscription for new incidents
    const channel = supabase
      .channel("ambulance-incidents")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "incidents" },
        (payload) => {
          const incident = payload.new as Incident;
          // Only show accident-type incidents
          const accidentTypes = [
            "vehicle_collision",
            "pedestrian_collision",
            "pedestrian_fall",
            "fire_smoke",
          ];
          if (accidentTypes.includes(incident.incident_type)) {
            setIncidents((prev) => [incident, ...prev]);
            toast.error(
              `🚨 NEW ${incident.severity.toUpperCase()} ${
                incident.incident_type
              } — Immediate response required!`
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
      prev.map((i) =>
        i.id === incidentId ? { ...i, status: "responding" } : i
      )
    );

    toast.success("Response dispatched!");
  };

  const getSeverityColor = (severity: string) => {
    const colors: Record<string, string> = {
      critical: "border-severity-critical bg-severity-critical/10",
      major: "border-severity-major bg-severity-major/10",
      minor: "border-severity-minor bg-severity-minor/10",
    };
    return colors[severity] || "border-border bg-card";
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Ambulance Dashboard</h1>
        <p className="text-muted-foreground">
          Active incidents requiring medical response
        </p>
      </div>

      {/* Quick Stats */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-card p-4 rounded-xl border border-border text-center">
          <p className="text-3xl font-bold text-severity-critical">
            {incidents.filter((i) => i.severity === "critical").length}
          </p>
          <p className="text-sm text-muted-foreground">Critical</p>
        </div>
        <div className="bg-card p-4 rounded-xl border border-border text-center">
          <p className="text-3xl font-bold text-severity-major">
            {incidents.filter((i) => i.severity === "major").length}
          </p>
          <p className="text-sm text-muted-foreground">Major</p>
        </div>
        <div className="bg-card p-4 rounded-xl border border-border text-center">
          <p className="text-3xl font-bold text-primary">
            {incidents.filter((i) => i.status === "responding").length}
          </p>
          <p className="text-sm text-muted-foreground">Responding</p>
        </div>
      </div>

      {/* Incident List */}
      <div className="space-y-4">
        {loading ? (
          <div className="text-center py-12 text-muted-foreground">
            Loading incidents...
          </div>
        ) : incidents.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            No active incidents. All clear!
          </div>
        ) : (
          incidents.map((incident) => (
            <div
              key={incident.id}
              className={`bg-card p-6 rounded-xl border-l-4 ${getSeverityColor(
                incident.severity
              )}`}
            >
              <div className="flex items-start justify-between">
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="w-5 h-5" />
                    <h3 className="font-semibold text-lg">
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
                  <div className="flex items-center gap-4 text-sm text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <MapPin size={14} />
                      {incident.latitude.toFixed(4)},{" "}
                      {incident.longitude.toFixed(4)}
                    </span>
                    <span className="flex items-center gap-1">
                      <Clock size={14} />
                      {new Date(incident.created_at).toLocaleTimeString()}
                    </span>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Link
                    href={`/map?lat=${incident.latitude}&lng=${incident.longitude}`}
                    className="px-3 py-2 bg-card border border-border rounded-lg hover:bg-background transition-colors text-sm"
                  >
                    <Navigation size={14} className="inline mr-1" />
                    Navigate
                  </Link>
                  {incident.status !== "responding" && (
                    <button
                      onClick={() => handleRespond(incident.id)}
                      className="px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors text-sm font-medium"
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
          ))
        )}
      </div>
    </div>
  );
}

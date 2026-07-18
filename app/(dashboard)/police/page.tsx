"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { AlertTriangle, MapPin, Clock, CheckCircle, XCircle } from "lucide-react";
import { toast } from "sonner";

interface Incident {
  id: string;
  severity: string;
  incident_type: string;
  latitude: number;
  longitude: number;
  status: string;
  created_at: string;
  video_clip_url?: string;
}

export default function PoliceDashboard() {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [loading, setLoading] = useState(true);
  const supabase = createClient();

  useEffect(() => {
    const fetchIncidents = async () => {
      const { data } = await supabase
        .from("incidents")
        .select("*")
        .in("status", ["detected", "acknowledged", "responding"])
        .order("created_at", { ascending: false });

      if (data) {
        setIncidents(data);
      }
      setLoading(false);
    };

    fetchIncidents();

    // Real-time subscription
    const channel = supabase
      .channel("police-incidents")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "incidents" },
        (payload) => {
          const incident = payload.new as Incident;
          setIncidents((prev) => [incident, ...prev]);
          toast.error(
            `🚨 NEW ${incident.severity.toUpperCase()} ${
              incident.incident_type
            }`
          );
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const handleStatusUpdate = async (
    incidentId: string,
    newStatus: string
  ) => {
    await supabase
      .from("incidents")
      .update({ status: newStatus })
      .eq("id", incidentId);

    setIncidents((prev) =>
      prev.map((i) => (i.id === incidentId ? { ...i, status: newStatus } : i))
    );

    toast.success(`Incident marked as ${newStatus}`);
  };

  const getSeverityColor = (severity: string) => {
    const colors: Record<string, string> = {
      critical: "border-severity-critical",
      major: "border-severity-major",
      minor: "border-severity-minor",
      suspicious: "border-severity-suspicious",
    };
    return colors[severity] || "border-border";
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Police Dashboard</h1>
        <p className="text-muted-foreground">
          All detected incidents and suspicious activity
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4">
        <div className="bg-card p-4 rounded-xl border border-border text-center">
          <p className="text-3xl font-bold text-severity-critical">
            {
              incidents.filter(
                (i) => i.severity === "critical" && i.status === "detected"
              ).length
            }
          </p>
          <p className="text-sm text-muted-foreground">New Critical</p>
        </div>
        <div className="bg-card p-4 rounded-xl border border-border text-center">
          <p className="text-3xl font-bold text-severity-suspicious">
            {
              incidents.filter(
                (i) =>
                  i.incident_type.includes("loitering") ||
                  i.incident_type.includes("suspicious") ||
                  i.incident_type.includes("crowd")
              ).length
            }
          </p>
          <p className="text-sm text-muted-foreground">Suspicious</p>
        </div>
        <div className="bg-card p-4 rounded-xl border border-border text-center">
          <p className="text-3xl font-bold text-primary">
            {incidents.filter((i) => i.status === "responding").length}
          </p>
          <p className="text-sm text-muted-foreground">Responding</p>
        </div>
        <div className="bg-card p-4 rounded-xl border border-border text-center">
          <p className="text-3xl font-bold text-green-500">
            {incidents.filter((i) => i.status === "resolved").length}
          </p>
          <p className="text-sm text-muted-foreground">Resolved</p>
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
            No active incidents
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
                          : incident.severity === "suspicious"
                          ? "bg-severity-suspicious/20 text-severity-suspicious"
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
                  {incident.video_clip_url && (
                    <a
                      href={incident.video_clip_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-primary hover:underline"
                    >
                      📹 View Evidence Clip
                    </a>
                  )}
                </div>
                <div className="flex gap-2">
                  {incident.status === "detected" && (
                    <button
                      onClick={() =>
                        handleStatusUpdate(incident.id, "acknowledged")
                      }
                      className="px-3 py-2 bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors text-sm"
                    >
                      Acknowledge
                    </button>
                  )}
                  {incident.status === "acknowledged" && (
                    <button
                      onClick={() =>
                        handleStatusUpdate(incident.id, "responding")
                      }
                      className="px-3 py-2 bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors text-sm"
                    >
                      Respond
                    </button>
                  )}
                  {incident.status === "responding" && (
                    <button
                      onClick={() =>
                        handleStatusUpdate(incident.id, "resolved")
                      }
                      className="px-3 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors text-sm"
                    >
                      <CheckCircle size={14} className="inline mr-1" />
                      Resolve
                    </button>
                  )}
                  <button
                    onClick={() =>
                      handleStatusUpdate(incident.id, "false_positive")
                    }
                    className="px-3 py-2 bg-card border border-border rounded-lg hover:bg-background transition-colors text-sm text-muted-foreground"
                  >
                    <XCircle size={14} className="inline mr-1" />
                    False +ve
                  </button>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

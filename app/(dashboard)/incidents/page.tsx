"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  AlertTriangle,
  MapPin,
  Clock,
  Video,
  Filter,
  Search,
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
  location_name?: string;
}

export default function IncidentsPage() {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const supabase = createClient();

  useEffect(() => {
    const fetchIncidents = async () => {
      let query = supabase
        .from("incidents")
        .select("*")
        .order("created_at", { ascending: false });

      if (filter !== "all") {
        query = query.eq("severity", filter);
      }

      const { data } = await query;

      if (data) {
        setIncidents(data);
      }
      setLoading(false);
    };

    fetchIncidents();

    // Real-time subscription
    const channel = supabase
      .channel("incidents-list")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "incidents" },
        () => {
          fetchIncidents();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [filter]);

  const filteredIncidents = incidents.filter(
    (i) =>
      i.incident_type.toLowerCase().includes(search.toLowerCase()) ||
      i.location_name?.toLowerCase().includes(search.toLowerCase())
  );

  const getSeverityBadge = (severity: string) => {
    const colors: Record<string, string> = {
      critical: "bg-severity-critical/20 text-severity-critical",
      major: "bg-severity-major/20 text-severity-major",
      minor: "bg-severity-minor/20 text-severity-minor",
      suspicious: "bg-severity-suspicious/20 text-severity-suspicious",
    };
    return colors[severity] || "bg-muted/20 text-muted";
  };

  const getStatusBadge = (status: string) => {
    const colors: Record<string, string> = {
      detected: "bg-severity-critical/20 text-severity-critical",
      acknowledged: "bg-severity-major/20 text-severity-major",
      responding: "bg-primary/20 text-primary",
      resolved: "bg-green-500/20 text-green-500",
      false_positive: "bg-muted/20 text-muted",
    };
    return colors[status] || "bg-muted/20 text-muted";
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Incidents</h1>
        <p className="text-muted-foreground">
          All detected incidents and their status
        </p>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search incidents..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2 bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </div>
        <div className="flex gap-2">
          {["all", "critical", "major", "minor", "suspicious"].map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                filter === f
                  ? "bg-primary text-white"
                  : "bg-card border border-border text-muted-foreground hover:text-foreground"
              }`}
            >
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* Incidents List */}
      <div className="space-y-3">
        {loading ? (
          <div className="text-center py-12 text-muted-foreground">
            Loading incidents...
          </div>
        ) : filteredIncidents.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            No incidents found
          </div>
        ) : (
          filteredIncidents.map((incident) => (
            <Link
              key={incident.id}
              href={`/incidents/${incident.id}`}
              className="block bg-card p-4 rounded-xl border border-border hover:border-primary/50 transition-colors"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div
                    className={`w-3 h-3 rounded-full ${
                      incident.severity === "critical"
                        ? "bg-severity-critical animate-severity-pulse"
                        : incident.severity === "major"
                        ? "bg-severity-major"
                        : incident.severity === "minor"
                        ? "bg-severity-minor"
                        : "bg-severity-suspicious"
                    }`}
                  />
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="font-medium">
                        {incident.incident_type.replace(/_/g, " ")}
                      </h3>
                      <span
                        className={`px-2 py-0.5 rounded text-xs font-medium ${getSeverityBadge(
                          incident.severity
                        )}`}
                      >
                        {incident.severity}
                      </span>
                      <span
                        className={`px-2 py-0.5 rounded text-xs font-medium ${getStatusBadge(
                          incident.status
                        )}`}
                      >
                        {incident.status}
                      </span>
                    </div>
                    <div className="flex items-center gap-4 text-sm text-muted-foreground mt-1">
                      <span className="flex items-center gap-1">
                        <MapPin size={12} />
                        {incident.location_name ||
                          `${incident.latitude.toFixed(
                            4
                          )}, ${incident.longitude.toFixed(4)}`}
                      </span>
                      <span className="flex items-center gap-1">
                        <Clock size={12} />
                        {new Date(incident.created_at).toLocaleString()}
                      </span>
                      {incident.detection_confidence && (
                        <span>
                          Confidence:{" "}
                          {Math.round(incident.detection_confidence * 100)}%
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {incident.video_clip_url && (
                    <span className="px-2 py-1 bg-primary/20 text-primary rounded text-xs flex items-center gap-1">
                      <Video size={12} />
                      Clip
                    </span>
                  )}
                </div>
              </div>
            </Link>
          ))
        )}
      </div>
    </div>
  );
}

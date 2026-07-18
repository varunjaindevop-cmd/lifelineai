"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  Camera,
  AlertTriangle,
  Building2,
  Users,
  TrendingUp,
  Clock,
} from "lucide-react";
import { toast } from "sonner";
import Link from "next/link";

interface Stats {
  totalCameras: number;
  activeIncidents: number;
  totalHospitals: number;
  totalUsers: number;
  resolvedToday: number;
}

interface RecentIncident {
  id: string;
  severity: string;
  incident_type: string;
  location_name: string;
  status: string;
  created_at: string;
}

export default function AdminDashboard() {
  const [stats, setStats] = useState<Stats>({
    totalCameras: 0,
    activeIncidents: 0,
    totalHospitals: 0,
    totalUsers: 0,
    resolvedToday: 0,
  });
  const [recentIncidents, setRecentIncidents] = useState<RecentIncident[]>([]);
  const [loading, setLoading] = useState(true);
  const supabase = createClient();

  useEffect(() => {
    const fetchStats = async () => {
      const [cameras, incidents, hospitals, users] = await Promise.all([
        supabase.from("cameras").select("id", { count: "exact", head: true }),
        supabase
          .from("incidents")
          .select("id", { count: "exact", head: true })
          .in("status", ["detected", "acknowledged", "responding"]),
        supabase
          .from("hospitals")
          .select("id", { count: "exact", head: true })
          .eq("is_active", true),
        supabase.from("profiles").select("id", { count: "exact", head: true }),
      ]);

      setStats({
        totalCameras: cameras.count || 0,
        activeIncidents: incidents.count || 0,
        totalHospitals: hospitals.count || 0,
        totalUsers: users.count || 0,
        resolvedToday: 0,
      });
    };

    const fetchRecentIncidents = async () => {
      const { data } = await supabase
        .from("incidents")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(5);

      if (data) {
        setRecentIncidents(data);
      }
    };

    Promise.all([fetchStats(), fetchRecentIncidents()]).then(() =>
      setLoading(false)
    );

    // Real-time subscription for incidents
    const channel = supabase
      .channel("admin-incidents")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "incidents" },
        (payload) => {
          const incident = payload.new as RecentIncident;
          setRecentIncidents((prev) => [incident, ...prev.slice(0, 4)]);
          setStats((prev) => ({
            ...prev,
            activeIncidents: prev.activeIncidents + 1,
          }));
          toast.error(
            `New ${incident.severity} incident: ${incident.incident_type}`
          );
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const statCards = [
    {
      label: "Active Cameras",
      value: stats.totalCameras,
      icon: Camera,
      color: "text-primary",
    },
    {
      label: "Active Incidents",
      value: stats.activeIncidents,
      icon: AlertTriangle,
      color: "text-severity-critical",
    },
    {
      label: "Hospitals Online",
      value: stats.totalHospitals,
      icon: Building2,
      color: "text-green-500",
    },
    {
      label: "Total Users",
      value: stats.totalUsers,
      icon: Users,
      color: "text-severity-suspicious",
    },
  ];

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
    };
    return colors[status] || "bg-muted/20 text-muted";
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Admin Dashboard</h1>
          <p className="text-muted-foreground">
            Overview of all emergency response systems
          </p>
        </div>
        <Link
          href="/map"
          className="px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors"
        >
          View Live Map
        </Link>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {statCards.map((card) => {
          const Icon = card.icon;
          return (
            <div key={card.label} className="bg-card p-6 rounded-xl border border-border">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">{card.label}</p>
                  <p className="text-3xl font-bold mt-1">{card.value}</p>
                </div>
                <Icon className={`w-8 h-8 ${card.color}`} />
              </div>
            </div>
          );
        })}
      </div>

      {/* Recent Incidents */}
      <div className="bg-card rounded-xl border border-border">
        <div className="p-6 border-b border-border flex items-center justify-between">
          <h2 className="text-lg font-semibold">Recent Incidents</h2>
          <Link href="/incidents" className="text-sm text-primary hover:underline">
            View All
          </Link>
        </div>
        <div className="divide-y divide-border">
          {loading ? (
            <div className="p-6 text-center text-muted-foreground">
              Loading incidents...
            </div>
          ) : recentIncidents.length === 0 ? (
            <div className="p-6 text-center text-muted-foreground">
              No incidents detected yet
            </div>
          ) : (
            recentIncidents.map((incident) => (
              <div key={incident.id} className="p-4 hover:bg-background/50">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div
                      className={`w-2 h-2 rounded-full ${
                        incident.severity === "critical"
                          ? "bg-severity-critical animate-severity-pulse"
                          : getSeverityBadge(incident.severity).includes("major")
                          ? "bg-severity-major"
                          : "bg-severity-minor"
                      }`}
                    />
                    <div>
                      <p className="font-medium">{incident.incident_type}</p>
                      <p className="text-sm text-muted-foreground">
                        {incident.location_name || "Unknown location"}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span
                      className={`px-2 py-1 rounded text-xs font-medium ${getSeverityBadge(
                        incident.severity
                      )}`}
                    >
                      {incident.severity}
                    </span>
                    <span
                      className={`px-2 py-1 rounded text-xs font-medium ${getStatusBadge(
                        incident.status
                      )}`}
                    >
                      {incident.status}
                    </span>
                    <span className="text-xs text-muted-foreground flex items-center gap-1">
                      <Clock size={12} />
                      {new Date(incident.created_at).toLocaleTimeString()}
                    </span>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Quick Actions */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Link
          href="/cameras"
          className="bg-card p-6 rounded-xl border border-border hover:border-primary/50 transition-colors"
        >
          <Camera className="w-8 h-8 text-primary mb-3" />
          <h3 className="font-semibold">Manage Cameras</h3>
          <p className="text-sm text-muted-foreground mt-1">
            Add, edit, or remove CCTV camera feeds
          </p>
        </Link>
        <Link
          href="/incidents"
          className="bg-card p-6 rounded-xl border border-border hover:border-primary/50 transition-colors"
        >
          <AlertTriangle className="w-8 h-8 text-severity-major mb-3" />
          <h3 className="font-semibold">View Incidents</h3>
          <p className="text-sm text-muted-foreground mt-1">
            Review all detected incidents and evidence
          </p>
        </Link>
        <Link
          href="/map"
          className="bg-card p-6 rounded-xl border border-border hover:border-primary/50 transition-colors"
        >
          <TrendingUp className="w-8 h-8 text-green-500 mb-3" />
          <h3 className="font-semibold">Live Map</h3>
          <p className="text-sm text-muted-foreground mt-1">
            Real-time view of all cameras and incidents
          </p>
        </Link>
      </div>
    </div>
  );
}

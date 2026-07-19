"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Camera, AlertTriangle, Building2, Users, TrendingUp, Clock, Video } from "lucide-react";
import { toast } from "sonner";
import Link from "next/link";

interface Stats {
  totalCameras: number;
  activeIncidents: number;
  totalHospitals: number;
  totalUsers: number;
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
  });
  const [recentIncidents, setRecentIncidents] = useState<RecentIncident[]>([]);
  const [loading, setLoading] = useState(true);
  const supabase = createClient();

  useEffect(() => {
    const fetchAll = async () => {
      const [cameras, incidents, hospitals, users, recent] = await Promise.all([
        supabase.from("cameras").select("id", { count: "exact", head: true }),
        supabase.from("incidents").select("id", { count: "exact", head: true }).in("status", ["detected", "acknowledged", "responding"]),
        supabase.from("hospitals").select("id", { count: "exact", head: true }).eq("is_active", true),
        supabase.from("profiles").select("id", { count: "exact", head: true }),
        supabase.from("incidents").select("*").order("created_at", { ascending: false }).limit(5),
      ]);

      setStats({
        totalCameras: cameras.count || 0,
        activeIncidents: incidents.count || 0,
        totalHospitals: hospitals.count || 0,
        totalUsers: users.count || 0,
      });

      if (recent.data) setRecentIncidents(recent.data);
      setLoading(false);
    };

    fetchAll();

    const channel = supabase
      .channel("admin-incidents")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "incidents" }, (payload) => {
        const inc = payload.new as RecentIncident;
        setRecentIncidents((prev) => [inc, ...prev.slice(0, 4)]);
        setStats((prev) => ({ ...prev, activeIncidents: prev.activeIncidents + 1 }));
        toast.error(`New ${inc.severity} incident: ${inc.incident_type}`);
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const statCards = [
    { label: "Cameras", value: stats.totalCameras, icon: Camera, color: "text-primary" },
    { label: "Active Incidents", value: stats.activeIncidents, icon: AlertTriangle, color: "text-severity-critical" },
    { label: "Hospitals", value: stats.totalHospitals, icon: Building2, color: "text-green-500" },
    { label: "Users", value: stats.totalUsers, icon: Users, color: "text-severity-suspicious" },
  ];

  const sevColor = (s: string) => ({
    critical: "bg-severity-critical/20 text-severity-critical",
    major: "bg-severity-major/20 text-severity-major",
    minor: "bg-severity-minor/20 text-severity-minor",
    suspicious: "bg-severity-suspicious/20 text-severity-suspicious",
  }[s] || "bg-muted/20 text-muted");

  const statColor = (s: string) => ({
    detected: "bg-severity-critical/20 text-severity-critical",
    acknowledged: "bg-severity-major/20 text-severity-major",
    responding: "bg-primary/20 text-primary",
    resolved: "bg-green-500/20 text-green-500",
  }[s] || "bg-muted/20 text-muted");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Admin Dashboard</h1>
          <p className="text-muted-foreground">Emergency response overview</p>
        </div>
        <Link href="/map" className="px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors">
          Live Map
        </Link>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {statCards.map((c) => {
          const Icon = c.icon;
          return (
            <div key={c.label} className="bg-card p-5 rounded-xl border border-border">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">{c.label}</p>
                  <p className="text-3xl font-bold mt-1">{c.value}</p>
                </div>
                <Icon className={`w-8 h-8 ${c.color}`} />
              </div>
            </div>
          );
        })}
      </div>

      <div className="bg-card rounded-xl border border-border">
        <div className="p-5 border-b border-border flex items-center justify-between">
          <h2 className="font-semibold">Recent Incidents</h2>
          <Link href="/incidents" className="text-sm text-primary hover:underline">View All</Link>
        </div>
        <div className="divide-y divide-border">
          {loading ? (
            <div className="p-6 text-center text-muted-foreground">Loading...</div>
          ) : recentIncidents.length === 0 ? (
            <div className="p-6 text-center text-muted-foreground">No incidents yet</div>
          ) : (
            recentIncidents.map((inc) => (
              <div key={inc.id} className="p-4 hover:bg-background/50 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className={`w-2 h-2 rounded-full ${inc.severity === "critical" ? "bg-severity-critical animate-severity-pulse" : "bg-severity-major"}`} />
                  <div>
                    <p className="font-medium capitalize">{inc.incident_type.replace(/_/g, " ")}</p>
                    <p className="text-sm text-muted-foreground">{inc.location_name || "Unknown"}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className={`px-2 py-1 rounded text-xs font-medium ${sevColor(inc.severity)}`}>{inc.severity}</span>
                  <span className={`px-2 py-1 rounded text-xs font-medium ${statColor(inc.status)}`}>{inc.status}</span>
                  <span className="text-xs text-muted-foreground flex items-center gap-1">
                    <Clock size={12} />
                    {new Date(inc.created_at).toLocaleTimeString()}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Link href="/cameras" className="bg-card p-5 rounded-xl border border-border hover:border-primary/50 transition-colors">
          <Camera className="w-7 h-7 text-primary mb-2" />
          <h3 className="font-semibold">Cameras</h3>
          <p className="text-sm text-muted-foreground">Manage CCTV feeds</p>
        </Link>
        <Link href="/admin/videos" className="bg-card p-5 rounded-xl border border-border hover:border-primary/50 transition-colors">
          <Video className="w-7 h-7 text-severity-major mb-2" />
          <h3 className="font-semibold">Video Analysis</h3>
          <p className="text-sm text-muted-foreground">AI clip analysis &amp; detection</p>
        </Link>
        <Link href="/incidents" className="bg-card p-5 rounded-xl border border-border hover:border-primary/50 transition-colors">
          <AlertTriangle className="w-7 h-7 text-severity-major mb-2" />
          <h3 className="font-semibold">Incidents</h3>
          <p className="text-sm text-muted-foreground">Review all detections</p>
        </Link>
        <Link href="/map" className="bg-card p-5 rounded-xl border border-border hover:border-primary/50 transition-colors">
          <TrendingUp className="w-7 h-7 text-green-500 mb-2" />
          <h3 className="font-semibold">Live Map</h3>
          <p className="text-sm text-muted-foreground">Real-time view</p>
        </Link>
      </div>
    </div>
  );
}

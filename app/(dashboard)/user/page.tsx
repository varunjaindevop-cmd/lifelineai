"use client";

import { useEffect, useState, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  MapPin, AlertTriangle, Shield, Bell, Navigation, 
  ChevronUp, ChevronDown, Phone, X, Plus, Send
} from "lucide-react";
import { toast } from "sonner";
import dynamic from "next/dynamic";

const MapView = dynamic(() => import("./map-view"), { ssr: false });

interface Incident {
  id: string;
  severity: string;
  incident_type: string;
  latitude: number;
  longitude: number;
  status: string;
  created_at: string;
  location_name?: string;
}

interface NearbyIncident extends Incident {
  distance: number;
}

export default function UserDashboard() {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [nearby, setNearby] = useState<NearbyIncident[]>([]);
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [showReport, setShowReport] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const [reportType, setReportType] = useState("accident");
  const [reportDesc, setReportDesc] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const supabase = createClient();

  // Get user location
  useEffect(() => {
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          setUserLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        },
        () => {
          // Default to Indore
          setUserLocation({ lat: 22.7196, lng: 75.8577 });
        }
      );
    } else {
      setUserLocation({ lat: 22.7196, lng: 75.8577 });
    }
  }, []);

  // Fetch incidents
  useEffect(() => {
    const fetchIncidents = async () => {
      const { data } = await supabase
        .from("incidents")
        .select("*")
        .in("status", ["detected", "acknowledged", "responding"])
        .order("created_at", { ascending: false })
        .limit(50);

      if (data) {
        setIncidents(data);
        if (userLocation) {
          const withDist = data.map((inc) => ({
            ...inc,
            distance: calcDistance(userLocation.lat, userLocation.lng, inc.latitude, inc.longitude),
          }));
          withDist.sort((a, b) => a.distance - b.distance);
          setNearby(withDist.filter((i) => i.distance < 10)); // Within 10km
        }
      }
    };

    fetchIncidents();

    const channel = supabase
      .channel("user-incidents")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "incidents" }, (payload) => {
        const inc = payload.new as Incident;
        setIncidents((prev) => [inc, ...prev]);
        if (userLocation) {
          const dist = calcDistance(userLocation.lat, userLocation.lng, inc.latitude, inc.longitude);
          if (dist < 5) {
            toast.error(`Incident nearby: ${inc.incident_type.replace(/_/g, " ")}`, { duration: 8000 });
          }
        }
      })
      .subscribe();

    return () => supabase.removeChannel(channel);
  }, [userLocation]);

  // Recalculate nearby when location changes
  useEffect(() => {
    if (userLocation && incidents.length > 0) {
      const withDist = incidents.map((inc) => ({
        ...inc,
        distance: calcDistance(userLocation.lat, userLocation.lng, inc.latitude, inc.longitude),
      }));
      withDist.sort((a, b) => a.distance - b.distance);
      setNearby(withDist.filter((i) => i.distance < 10));
    }
  }, [userLocation, incidents]);

  const calcDistance = (lat1: number, lon1: number, lat2: number, lon2: number) => {
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  };

  const handleReport = async () => {
    if (!userLocation) return;
    setSubmitting(true);

    const { data: { user } } = await supabase.auth.getUser();

    await supabase.from("incidents").insert({
      severity: "minor",
      incident_type: reportType === "accident" ? "vehicle_collision" : "suspicious_activity",
      latitude: userLocation.lat,
      longitude: userLocation.lng,
      description: reportDesc,
      status: "detected",
      detection_confidence: 0.5,
      detection_data: { reported_by: user?.id, source: "user_report" },
    });

    toast.success("Incident reported! Authorities have been notified.");
    setShowReport(false);
    setReportDesc("");
    setSubmitting(false);
  };

  const sevColor = (s: string) => {
    if (s === "critical") return "#EF4444";
    if (s === "major") return "#F97316";
    if (s === "minor") return "#EAB308";
    return "#8B5CF6";
  };

  return (
    <div className="h-screen flex flex-col bg-background">
      {/* Top Bar */}
      <div className="bg-card border-b border-border px-4 py-3 flex items-center justify-between z-20">
        <div className="flex items-center gap-2">
          <Shield className="w-6 h-6 text-primary" />
          <span className="font-bold text-lg">LifelineAI</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowNotifications(!showNotifications)}
            className="relative p-2 rounded-lg hover:bg-background transition-colors"
          >
            <Bell size={20} />
            {nearby.length > 0 && (
              <span className="absolute -top-1 -right-1 w-5 h-5 bg-severity-critical text-white text-xs rounded-full flex items-center justify-center">
                {nearby.length}
              </span>
            )}
          </button>
          <button
            onClick={() => setShowReport(true)}
            className="p-2 bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors"
          >
            <Plus size={20} />
          </button>
        </div>
      </div>

      {/* Notifications Panel */}
      {showNotifications && (
        <div className="absolute top-14 right-0 left-0 bg-card border-b border-border z-30 max-h-80 overflow-auto shadow-lg">
          <div className="p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold">Nearby Incidents</h3>
              <button onClick={() => setShowNotifications(false)}>
                <X size={18} />
              </button>
            </div>
            {nearby.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">
                No incidents nearby. You are safe!
              </p>
            ) : (
              <div className="space-y-2">
                {nearby.map((inc) => (
                  <div
                    key={inc.id}
                    className="p-3 bg-background rounded-lg flex items-center gap-3"
                  >
                    <div
                      className="w-3 h-3 rounded-full flex-shrink-0"
                      style={{ backgroundColor: sevColor(inc.severity) }}
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium capitalize truncate">
                        {inc.incident_type.replace(/_/g, " ")}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {inc.distance.toFixed(1)} km away • {new Date(inc.created_at).toLocaleTimeString()}
                      </p>
                    </div>
                    <a
                      href={`https://www.google.com/maps/dir/?api=1&destination=${inc.latitude},${inc.longitude}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="p-2 bg-primary/20 text-primary rounded-lg"
                    >
                      <Navigation size={14} />
                    </a>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Map */}
      <div className="flex-1 relative">
        <MapView
          center={userLocation || { lat: 22.7196, lng: 75.8577 }}
          incidents={incidents}
        />

        {/* Safety Status Bar */}
        <div className="absolute bottom-4 left-4 right-4 z-10">
          <div className="bg-card/95 backdrop-blur-sm border border-border rounded-xl p-4 shadow-lg">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className={`w-3 h-3 rounded-full ${nearby.length > 0 ? "bg-severity-major animate-pulse" : "bg-green-500"}`} />
                <div>
                  <p className="font-semibold">
                    {nearby.length > 0
                      ? `${nearby.length} incident${nearby.length > 1 ? "s" : ""} nearby`
                      : "Area looks safe"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {userLocation
                      ? `${userLocation.lat.toFixed(4)}, ${userLocation.lng.toFixed(4)}`
                      : "Getting location..."}
                  </p>
                </div>
              </div>
              <a
                href={`https://www.google.com/maps/@${userLocation?.lat || 22.7196},${userLocation?.lng || 75.8577},14z`}
                target="_blank"
                rel="noopener noreferrer"
                className="px-3 py-1.5 bg-primary text-white rounded-lg text-sm flex items-center gap-1"
              >
                <Navigation size={14} />
                Open Maps
              </a>
            </div>
          </div>
        </div>
      </div>

      {/* Report Modal */}
      {showReport && (
        <div className="absolute inset-0 bg-black/50 z-40 flex items-end">
          <div className="bg-card w-full rounded-t-2xl p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-lg">Report Incident</h3>
              <button onClick={() => setShowReport(false)}>
                <X size={20} />
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="text-sm font-medium mb-1 block">Type</label>
                <select
                  value={reportType}
                  onChange={(e) => setReportType(e.target.value)}
                  className="w-full px-4 py-2.5 bg-background border border-border rounded-lg"
                >
                  <option value="accident">Accident</option>
                  <option value="fire">Fire</option>
                  <option value="medical">Medical Emergency</option>
                  <option value="suspicious">Suspicious Activity</option>
                  <option value="other">Other</option>
                </select>
              </div>

              <div>
                <label className="text-sm font-medium mb-1 block">Description (optional)</label>
                <textarea
                  value={reportDesc}
                  onChange={(e) => setReportDesc(e.target.value)}
                  className="w-full px-4 py-2.5 bg-background border border-border rounded-lg resize-none"
                  rows={3}
                  placeholder="What happened?"
                />
              </div>

              <p className="text-xs text-muted-foreground">
                Your current location will be shared with authorities.
              </p>

              <button
                onClick={handleReport}
                disabled={submitting}
                className="w-full py-3 bg-severity-critical text-white rounded-lg font-semibold flex items-center justify-center gap-2 disabled:opacity-50"
              >
                <Send size={16} />
                {submitting ? "Reporting..." : "Report Now"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Emergency Call */}
      <a
        href="tel:112"
        className="fixed bottom-24 right-4 z-20 w-14 h-14 bg-severity-critical rounded-full flex items-center justify-center shadow-lg hover:bg-severity-critical/90 transition-colors"
      >
        <Phone size={24} className="text-white" />
      </a>
    </div>
  );
}

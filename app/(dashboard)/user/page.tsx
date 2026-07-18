"use client";

import { useEffect, useState, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  MapPin, AlertTriangle, Shield, Bell, Navigation, X, Plus, Send, Phone, Search, Loader2, Construction
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

interface SearchResult {
  display_name: string;
  lat: string;
  lon: string;
  type: string;
}

interface Construction {
  id: string;
  lat: number;
  lng: number;
  label: string;
}

export default function UserDashboard() {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [nearby, setNearby] = useState<NearbyIncident[]>([]);
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [showReport, setShowReport] = useState(false);
  const [reportType, setReportType] = useState("accident");
  const [reportDesc, setReportDesc] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Search state
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [selectedDestination, setSelectedDestination] = useState<{ lat: number; lng: number; name: string } | null>(null);

  // Construction zones
  const [constructionZones, setConstructionZones] = useState<Construction[]>([]);

  const supabase = createClient();

  // Get user location
  useEffect(() => {
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => setUserLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
        () => setUserLocation({ lat: 22.7196, lng: 75.8577 })
      );
    } else {
      setUserLocation({ lat: 22.7196, lng: 75.8577 });
    }
  }, []);

  // Fetch incidents + construction zones
  useEffect(() => {
    const fetchAll = async () => {
      // Fetch incidents
      const { data: incData } = await supabase
        .from("incidents")
        .select("*")
        .in("status", ["detected", "acknowledged", "responding"])
        .order("created_at", { ascending: false })
        .limit(50);

      if (incData) {
        setIncidents(incData.filter((i: any) => i.latitude != null && i.longitude != null));
        if (userLocation) {
          const withDist = incData.filter((i: any) => i.latitude != null && i.longitude != null).map((inc: any) => ({
            ...inc,
            distance: calcDistance(userLocation.lat, userLocation.lng, inc.latitude, inc.longitude),
          }));
          withDist.sort((a, b) => a.distance - b.distance);
          setNearby(withDist.filter((i) => i.distance < 10));
        }
      }

      // Fetch construction zones separately (table may not exist)
      try {
        const { data: czData } = await supabase
          .from("construction_zones")
          .select("*")
          .eq("is_active", true);
        if (czData) setConstructionZones(czData);
      } catch {
        // Table doesn't exist yet, ignore
      }
    };

    fetchAll();

    const channel = supabase
      .channel("user-incidents")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "incidents" }, (payload) => {
        const inc = payload.new as Incident;
        if (inc.latitude == null || inc.longitude == null) return;
        setIncidents((prev) => [inc, ...prev]);
        if (userLocation) {
          const dist = calcDistance(userLocation.lat, userLocation.lng, inc.latitude, inc.longitude);
          if (dist < 5) {
            toast.error(`Nearby: ${inc.incident_type.replace(/_/g, " ")}`, { duration: 8000 });
          }
        }
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [userLocation]);

  // Recalculate nearby
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

  // Search locations using Nominatim (free, no API key)
  const handleSearch = useCallback(async (query: string) => {
    if (query.length < 3) { setSearchResults([]); return; }
    setSearching(true);
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query + " Indore")}&format=json&limit=5&addressdetails=1`,
        { headers: { "User-Agent": "LifelineAI/1.0" } }
      );
      const data = await res.json();
      setSearchResults(data);
    } catch {
      setSearchResults([]);
    }
    setSearching(false);
  }, []);

  // Debounced search
  useEffect(() => {
    const timer = setTimeout(() => handleSearch(searchQuery), 400);
    return () => clearTimeout(timer);
  }, [searchQuery, handleSearch]);

  const selectSearchResult = (result: SearchResult) => {
    setSelectedDestination({
      lat: parseFloat(result.lat),
      lng: parseFloat(result.lon),
      name: result.display_name.split(",")[0],
    });
    setSearchResults([]);
    setSearchQuery(result.display_name.split(",")[0]);
  };

  const calcDistance = (lat1: number, lon1: number, lat2: number, lon2: number) => {
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  };

  const handleReport = async () => {
    if (!userLocation) return;
    setSubmitting(true);
    const { data: { user } } = await supabase.auth.getUser();
    await supabase.from("incidents").insert({
      severity: "minor",
      incident_type: reportType === "accident" ? "vehicle_collision" : reportType === "fire" ? "fire_smoke" : "suspicious_activity",
      latitude: userLocation.lat,
      longitude: userLocation.lng,
      description: reportDesc,
      status: "detected",
      detection_confidence: 0.5,
      detection_data: { reported_by: user?.id, source: "user_report" },
    });
    toast.success("Incident reported! Authorities notified.");
    setShowReport(false);
    setReportDesc("");
    setSubmitting(false);
  };

  const sevColor = (s: string) => s === "critical" ? "#EF4444" : s === "major" ? "#F97316" : s === "minor" ? "#EAB308" : "#8B5CF6";

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Top Bar */}
      <div className="bg-card border-b border-border px-4 py-3 flex items-center justify-between z-20 flex-shrink-0">
        <div className="flex items-center gap-2">
          <Shield className="w-6 h-6 text-primary" />
          <span className="font-bold text-lg">LifelineAI</span>
        </div>
        <div className="flex items-center gap-2">
          <a href="tel:112" className="p-2 bg-severity-critical/20 text-severity-critical rounded-lg">
            <Phone size={18} />
          </a>
          <button onClick={() => setShowReport(true)} className="p-2 bg-primary text-white rounded-lg">
            <Plus size={18} />
          </button>
        </div>
      </div>

      {/* Map Container */}
      <div className="h-[45vh] relative flex-shrink-0">
        {/* Search Bar - Floating on Map */}
        <div className="absolute top-3 left-3 right-3 z-[1000]">
          <div className="bg-card/95 backdrop-blur-sm border border-border rounded-xl shadow-lg">
            <div className="flex items-center gap-2 px-3 py-2">
              <Search size={18} className="text-muted-foreground flex-shrink-0" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => { setSearchQuery(e.target.value); setSelectedDestination(null); }}
                placeholder="Search location in Indore..."
                className="flex-1 bg-transparent text-sm outline-none"
              />
              {searching && <Loader2 size={16} className="animate-spin text-muted-foreground" />}
              {searchQuery && (
                <button onClick={() => { setSearchQuery(""); setSearchResults([]); setSelectedDestination(null); }}>
                  <X size={16} className="text-muted-foreground" />
                </button>
              )}
            </div>

            {/* Search Results */}
            {searchResults.length > 0 && (
              <div className="border-t border-border max-h-48 overflow-auto">
                {searchResults.map((result, i) => (
                  <button
                    key={i}
                    onClick={() => selectSearchResult(result)}
                    className="w-full px-4 py-2.5 text-left hover:bg-background transition-colors flex items-center gap-2 text-sm"
                  >
                    <MapPin size={14} className="text-muted-foreground flex-shrink-0" />
                    <span className="truncate">{result.display_name.split(",").slice(0, 3).join(", ")}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <MapView
          center={userLocation || { lat: 22.7196, lng: 75.8577 }}
          incidents={incidents}
          destination={selectedDestination}
          constructionZones={constructionZones}
        />

        {/* Safety Badge */}
        <div className="absolute bottom-3 left-3 right-3 z-10">
          <div className="bg-card/95 backdrop-blur-sm border border-border rounded-xl px-4 py-3 shadow-lg flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className={`w-3 h-3 rounded-full ${nearby.length > 0 ? "bg-severity-major animate-pulse" : "bg-green-500"}`} />
              <div>
                <p className="font-semibold text-sm">
                  {nearby.length > 0 ? `${nearby.length} incident${nearby.length > 1 ? "s" : ""} nearby` : "Area looks safe"}
                </p>
                <p className="text-xs text-muted-foreground">
                  {userLocation ? `${userLocation.lat.toFixed(4)}, ${userLocation.lng.toFixed(4)}` : "Getting location..."}
                </p>
              </div>
            </div>
            {constructionZones.length > 0 && (
              <span className="px-2 py-1 bg-severity-major/20 text-severity-major rounded text-xs flex items-center gap-1">
                <Construction size={12} />
                {constructionZones.length} road work
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Scrollable Content */}
      <div className="flex-1 overflow-auto p-4 space-y-4">
        {/* Quick Actions */}
        <div className="grid grid-cols-3 gap-3">
          <button onClick={() => setShowReport(true)} className="bg-card p-3 rounded-xl border border-border flex flex-col items-center gap-1 hover:border-primary/50 transition-colors">
            <AlertTriangle className="w-5 h-5 text-severity-critical" />
            <p className="text-xs font-medium">Report</p>
          </button>
          <button className="bg-card p-3 rounded-xl border border-border flex flex-col items-center gap-1 hover:border-primary/50 transition-colors">
            <Shield className="w-5 h-5 text-green-500" />
            <p className="text-xs font-medium">Safe Zones</p>
          </button>
          <button className="bg-card p-3 rounded-xl border border-border flex flex-col items-center gap-1 hover:border-primary/50 transition-colors">
            <Construction className="w-5 h-5 text-severity-major" />
            <p className="text-xs font-medium">Road Work</p>
          </button>
        </div>

        {/* Map Legend */}
        <div className="bg-card p-3 rounded-xl border border-border">
          <p className="text-xs font-medium mb-2 text-muted-foreground">MAP LEGEND</p>
          <div className="flex flex-wrap gap-3 text-xs">
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-full bg-severity-critical" /> Critical</span>
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-full bg-severity-major" /> Major</span>
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-full bg-severity-minor" /> Minor</span>
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-full bg-primary" /> You</span>
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-severity-major" style={{ borderRadius: "2px" }} /> Road Work</span>
          </div>
        </div>

        {/* Nearby Incidents */}
        <div>
          <h3 className="font-semibold mb-3">Nearby Incidents</h3>
          {nearby.length === 0 ? (
            <div className="bg-card p-6 rounded-xl border border-border text-center">
              <Shield className="w-8 h-8 text-green-500 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">No incidents nearby. Stay safe!</p>
            </div>
          ) : (
            <div className="space-y-2">
              {nearby.slice(0, 5).map((inc) => (
                <div key={inc.id} className="bg-card p-3 rounded-xl border border-border flex items-center gap-3">
                  <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: sevColor(inc.severity) }} />
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm capitalize truncate">{inc.incident_type.replace(/_/g, " ")}</p>
                    <p className="text-xs text-muted-foreground">
                      {inc.distance.toFixed(1)} km away • {new Date(inc.created_at).toLocaleTimeString()}
                    </p>
                  </div>
                  <button
                    onClick={() => setSelectedDestination({ lat: inc.latitude, lng: inc.longitude, name: inc.incident_type.replace(/_/g, " ") })}
                    className="px-3 py-1.5 bg-primary/20 text-primary rounded-lg text-xs flex items-center gap-1 flex-shrink-0"
                  >
                    <Navigation size={12} />
                    Route
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Report Modal */}
      {showReport && (
        <div className="fixed inset-0 bg-black/50 z-40 flex items-end">
          <div className="bg-card w-full rounded-t-2xl p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-lg">Report Incident</h3>
              <button onClick={() => setShowReport(false)}><X size={20} /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="text-sm font-medium mb-1 block">Type</label>
                <select value={reportType} onChange={(e) => setReportType(e.target.value)} className="w-full px-4 py-2.5 bg-background border border-border rounded-lg">
                  <option value="accident">Accident</option>
                  <option value="fire">Fire</option>
                  <option value="medical">Medical Emergency</option>
                  <option value="suspicious">Suspicious Activity</option>
                  <option value="construction">Road Work / Construction</option>
                </select>
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block">Description</label>
                <textarea value={reportDesc} onChange={(e) => setReportDesc(e.target.value)} className="w-full px-4 py-2.5 bg-background border border-border rounded-lg resize-none" rows={3} placeholder="What happened?" />
              </div>
              <p className="text-xs text-muted-foreground">Your location will be shared with authorities.</p>
              <button onClick={handleReport} disabled={submitting} className="w-full py-3 bg-severity-critical text-white rounded-lg font-semibold flex items-center justify-center gap-2 disabled:opacity-50">
                <Send size={16} />
                {submitting ? "Reporting..." : "Report Now"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

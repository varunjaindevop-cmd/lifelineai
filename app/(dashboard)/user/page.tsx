"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  MapPin, AlertTriangle, Shield, Bell, Navigation, X, Plus, Send, Phone, Search, Loader2, Construction, Home, User, Info, LogOut, ChevronRight
} from "lucide-react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
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
}

interface Construction {
  id: string;
  lat: number;
  lng: number;
  label: string;
}

type Tab = "home" | "report" | "alerts" | "profile";

export default function UserDashboard() {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [nearby, setNearby] = useState<NearbyIncident[]>([]);
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [showReport, setShowReport] = useState(false);
  const [reportType, setReportType] = useState("accident");
  const [reportDesc, setReportDesc] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>("home");
  const [userName, setUserName] = useState("User");
  const router = useRouter();

  // Search
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [selectedDestination, setSelectedDestination] = useState<{ lat: number; lng: number; name: string } | null>(null);

  const [constructionZones, setConstructionZones] = useState<Construction[]>([]);
  const supabase = createClient();

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

  useEffect(() => {
    const init = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const name = user.user_metadata?.full_name || user.user_metadata?.name || user.email?.split("@")[0] || "User";
        setUserName(name);
      }

      const { data: incData } = await supabase
        .from("incidents")
        .select("*")
        .in("status", ["detected", "acknowledged", "responding"])
        .order("created_at", { ascending: false })
        .limit(50);

      if (incData) {
        setIncidents(incData.filter((i: any) => i.latitude != null && i.longitude != null));
      }

      try {
        const { data: czData } = await supabase.from("construction_zones").select("*").eq("is_active", true);
        if (czData) setConstructionZones(czData);
      } catch {}
    };

    init();

    // Throttle realtime updates
    let lastUpdateTime = 0;
    const throttledHandler = (payload: any) => {
      const now = Date.now();
      if (now - lastUpdateTime < 500) return; // Max once per 500ms
      lastUpdateTime = now;

      const inc = payload.new as Incident;
      if (inc.latitude == null || inc.longitude == null) return;
      setIncidents((prev) => [inc, ...prev]);
      if (userLocation) {
        const dist = calcDistance(userLocation.lat, userLocation.lng, inc.latitude, inc.longitude);
        if (dist < 5) toast.error(`Nearby: ${inc.incident_type.replace(/_/g, " ")}`, { duration: 8000 });
      }
    };

    const channel = supabase
      .channel("user-incidents")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "incidents" }, throttledHandler)
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [userLocation]);

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

  // Search with Nominatim (with AbortController for stale request cancellation)
  useEffect(() => {
    if (searchQuery.length < 3) { setSearchResults([]); return; }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(searchQuery + " Indore")}&format=json&limit=5`, {
          headers: { "User-Agent": "LifelineAI/1.0" },
          signal: controller.signal,
        });
        setSearchResults(await res.json());
      } catch { if (!controller.signal.aborted) setSearchResults([]); }
      setSearching(false);
    }, 400);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [searchQuery]);

  const selectSearchResult = (result: SearchResult) => {
    setSelectedDestination({ lat: parseFloat(result.lat), lng: parseFloat(result.lon), name: result.display_name.split(",")[0] });
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
      incident_type: reportType === "accident" ? "vehicle_collision" : reportType === "fire" ? "fire_smoke" : reportType === "construction" ? "vehicle_anomaly" : "suspicious_activity",
      latitude: userLocation.lat, longitude: userLocation.lng,
      description: reportDesc, status: "detected", detection_confidence: 0.5,
      detection_data: { reported_by: user?.id, source: "user_report" },
    });
    toast.success("Incident reported! Authorities notified.");
    setShowReport(false); setReportDesc(""); setSubmitting(false);
    setActiveTab("home");
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    router.push("/login");
  };

  const sevColor = (s: string) => s === "critical" ? "#EF4444" : s === "major" ? "#F97316" : s === "minor" ? "#EAB308" : "#8B5CF6";

  const tabs = [
    { key: "home" as Tab, icon: Home, label: "Home" },
    { key: "report" as Tab, icon: AlertTriangle, label: "Report" },
    { key: "alerts" as Tab, icon: Bell, label: "Alerts" },
    { key: "profile" as Tab, icon: User, label: "Profile" },
  ];

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Top Bar */}
      <div className="bg-card border-b border-border px-4 py-3 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-2">
          <Shield className="w-6 h-6 text-primary" />
          <span className="font-bold text-lg">LifelineAI</span>
        </div>
        <div className="flex items-center gap-2">
          <a href="tel:112" className="p-2 bg-severity-critical/20 text-severity-critical rounded-lg">
            <Phone size={18} />
          </a>
        </div>
      </div>

      {/* HOME TAB */}
      {activeTab === "home" && (
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="h-[45vh] relative flex-shrink-0">
            {/* Search Bar */}
            <div className="absolute top-3 left-3 right-3 z-[1000]">
              <div className="bg-card/95 backdrop-blur-sm border border-border rounded-xl shadow-lg">
                <div className="flex items-center gap-2 px-3 py-2">
                  <Search size={18} className="text-muted-foreground flex-shrink-0" />
                  <input type="text" value={searchQuery} onChange={(e) => { setSearchQuery(e.target.value); setSelectedDestination(null); }}
                    placeholder="Search location in Indore..." className="flex-1 bg-transparent text-sm outline-none" />
                  {searching && <Loader2 size={16} className="animate-spin text-muted-foreground" />}
                  {searchQuery && <button onClick={() => { setSearchQuery(""); setSearchResults([]); setSelectedDestination(null); }}><X size={16} className="text-muted-foreground" /></button>}
                </div>
                {searchResults.length > 0 && (
                  <div className="border-t border-border max-h-48 overflow-auto">
                    {searchResults.map((r, i) => (
                      <button key={i} onClick={() => selectSearchResult(r)} className="w-full px-4 py-2.5 text-left hover:bg-background flex items-center gap-2 text-sm">
                        <MapPin size={14} className="text-muted-foreground flex-shrink-0" />
                        <span className="truncate">{r.display_name.split(",").slice(0, 3).join(", ")}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <MapView center={userLocation || { lat: 22.7196, lng: 75.8577 }} incidents={incidents} destination={selectedDestination} constructionZones={constructionZones} />

            {/* Safety Badge */}
            <div className="absolute bottom-3 left-3 right-3 z-10">
              <div className="bg-card/95 backdrop-blur-sm border border-border rounded-xl px-4 py-3 shadow-lg flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className={`w-3 h-3 rounded-full ${nearby.length > 0 ? "bg-severity-major animate-pulse" : "bg-green-500"}`} />
                  <div>
                    <p className="font-semibold text-sm">{nearby.length > 0 ? `${nearby.length} incident${nearby.length > 1 ? "s" : ""} nearby` : "Area looks safe"}</p>
                    <p className="text-xs text-muted-foreground">{userLocation ? `${userLocation.lat.toFixed(4)}, ${userLocation.lng.toFixed(4)}` : "Getting location..."}</p>
                  </div>
                </div>
                {constructionZones.length > 0 && (
                  <span className="px-2 py-1 bg-severity-major/20 text-severity-major rounded text-xs flex items-center gap-1">
                    <Construction size={12} /> {constructionZones.length} road work
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Scrollable Content */}
          <div className="flex-1 overflow-auto p-4 space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <button onClick={() => setActiveTab("report")} className="bg-card p-4 rounded-xl border border-border flex items-center gap-3 hover:border-primary/50">
                <div className="w-10 h-10 bg-severity-critical/20 rounded-lg flex items-center justify-center"><AlertTriangle className="w-5 h-5 text-severity-critical" /></div>
                <div className="text-left"><p className="font-medium text-sm">Report</p><p className="text-xs text-muted-foreground">Alert authorities</p></div>
              </button>
              <button onClick={() => setActiveTab("alerts")} className="bg-card p-4 rounded-xl border border-border flex items-center gap-3 hover:border-primary/50">
                <div className="w-10 h-10 bg-primary/20 rounded-lg flex items-center justify-center"><Bell className="w-5 h-5 text-primary" /></div>
                <div className="text-left"><p className="font-medium text-sm">Alerts</p><p className="text-xs text-muted-foreground">{nearby.length} nearby</p></div>
              </button>
            </div>

            <div className="bg-card p-3 rounded-xl border border-border">
              <p className="text-xs font-medium mb-2 text-muted-foreground">LEGEND</p>
              <div className="flex flex-wrap gap-3 text-xs">
                <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-full bg-severity-critical" /> Critical</span>
                <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-full bg-severity-major" /> Major</span>
                <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-full bg-severity-minor" /> Minor</span>
                <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-full bg-primary" /> You</span>
                <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-severity-major" style={{ borderRadius: "2px" }} /> Road Work</span>
              </div>
            </div>

            {nearby.length > 0 && (
              <div>
                <h3 className="font-semibold mb-3">Nearby Incidents</h3>
                <div className="space-y-2">
                  {nearby.slice(0, 5).map((inc) => (
                    <div key={inc.id} className="bg-card p-3 rounded-xl border border-border flex items-center gap-3">
                      <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: sevColor(inc.severity) }} />
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-sm capitalize truncate">{inc.incident_type.replace(/_/g, " ")}</p>
                        <p className="text-xs text-muted-foreground">{inc.distance.toFixed(1)} km away • {new Date(inc.created_at).toLocaleTimeString()}</p>
                      </div>
                      <button onClick={() => setSelectedDestination({ lat: inc.latitude, lng: inc.longitude, name: inc.incident_type.replace(/_/g, " ") })}
                        className="px-3 py-1.5 bg-primary/20 text-primary rounded-lg text-xs flex items-center gap-1 flex-shrink-0">
                        <Navigation size={12} /> Route
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* REPORT TAB */}
      {activeTab === "report" && (
        <div className="flex-1 overflow-auto p-4 space-y-4">
          <h2 className="text-xl font-bold">Report Incident</h2>
          <p className="text-sm text-muted-foreground">Your location will be shared with authorities.</p>
          <div className="space-y-3">
            <div>
              <label className="text-sm font-medium mb-1 block">Type</label>
              <select value={reportType} onChange={(e) => setReportType(e.target.value)} className="w-full px-4 py-2.5 bg-card border border-border rounded-lg">
                <option value="accident">Accident</option>
                <option value="fire">Fire</option>
                <option value="medical">Medical Emergency</option>
                <option value="suspicious">Suspicious Activity</option>
                <option value="construction">Road Work / Construction</option>
              </select>
            </div>
            <div>
              <label className="text-sm font-medium mb-1 block">Description</label>
              <textarea value={reportDesc} onChange={(e) => setReportDesc(e.target.value)} className="w-full px-4 py-2.5 bg-card border border-border rounded-lg resize-none" rows={4} placeholder="What happened?" />
            </div>
            <div className="bg-background rounded-xl p-4 text-center">
              <MapPin className="w-6 h-6 text-primary mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">
                {userLocation ? `${userLocation.lat.toFixed(4)}, ${userLocation.lng.toFixed(4)}` : "Getting your location..."}
              </p>
            </div>
            <button onClick={handleReport} disabled={submitting} className="w-full py-3 bg-severity-critical text-white rounded-lg font-semibold flex items-center justify-center gap-2 disabled:opacity-50">
              <Send size={16} /> {submitting ? "Reporting..." : "Report Now"}
            </button>
          </div>
        </div>
      )}

      {/* ALERTS TAB */}
      {activeTab === "alerts" && (
        <div className="flex-1 overflow-auto p-4 space-y-4">
          <h2 className="text-xl font-bold">Nearby Alerts</h2>
          {nearby.length === 0 ? (
            <div className="bg-card p-8 rounded-xl border border-border text-center">
              <Shield className="w-10 h-10 text-green-500 mx-auto mb-3" />
              <p className="font-semibold">No alerts nearby</p>
              <p className="text-sm text-muted-foreground mt-1">Your area is safe right now</p>
            </div>
          ) : (
            <div className="space-y-3">
              {nearby.map((inc) => (
                <div key={inc.id} className="bg-card p-4 rounded-xl border border-border">
                  <div className="flex items-start gap-3">
                    <div className="w-3 h-3 rounded-full mt-1 flex-shrink-0" style={{ backgroundColor: sevColor(inc.severity) }} />
                    <div className="flex-1">
                      <p className="font-semibold capitalize">{inc.incident_type.replace(/_/g, " ")}</p>
                      <p className="text-sm text-muted-foreground">{inc.distance.toFixed(1)} km away</p>
                      <p className="text-xs text-muted-foreground mt-1">{new Date(inc.created_at).toLocaleString()}</p>
                      <button onClick={() => { setActiveTab("home"); setSelectedDestination({ lat: inc.latitude, lng: inc.longitude, name: inc.incident_type }); }}
                        className="mt-3 px-4 py-2 bg-primary text-white rounded-lg text-sm flex items-center gap-2">
                        <Navigation size={14} /> Get Route
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* PROFILE TAB */}
      {activeTab === "profile" && (
        <div className="flex-1 overflow-auto p-4 space-y-4">
          <h2 className="text-xl font-bold">Profile</h2>
          <div className="bg-card p-6 rounded-xl border border-border text-center space-y-4">
            <div className="w-16 h-16 bg-primary/20 rounded-full flex items-center justify-center mx-auto">
              <User className="w-8 h-8 text-primary" />
            </div>
            <div>
              <p className="font-semibold text-lg">{userName}</p>
              <p className="text-sm text-muted-foreground">Citizen • Indore</p>
            </div>
          </div>
          <div className="space-y-2">
            <div className="bg-card p-4 rounded-xl border border-border flex items-center justify-between">
              <div className="flex items-center gap-3"><Info size={18} className="text-muted-foreground" /><span className="text-sm">About LifelineAI</span></div>
              <ChevronRight size={16} className="text-muted-foreground" />
            </div>
            <div className="bg-card p-4 rounded-xl border border-border flex items-center justify-between">
              <div className="flex items-center gap-3"><Shield size={18} className="text-muted-foreground" /><span className="text-sm">Safety Tips</span></div>
              <ChevronRight size={16} className="text-muted-foreground" />
            </div>
            <button onClick={handleLogout} className="w-full bg-card p-4 rounded-xl border border-border flex items-center gap-3 text-severity-critical">
              <LogOut size={18} /><span className="text-sm font-medium">Sign Out</span>
            </button>
          </div>
        </div>
      )}

      {/* Bottom Navigation */}
      <div className="bg-card border-t border-border flex-shrink-0">
        <div className="flex items-center justify-around py-2">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.key;
            return (
              <button key={tab.key} onClick={() => setActiveTab(tab.key)}
                className={`flex flex-col items-center gap-1 px-4 py-2 rounded-lg transition-colors ${isActive ? "text-primary" : "text-muted-foreground"}`}>
                <Icon size={20} />
                <span className="text-xs font-medium">{tab.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Report Modal (from map floating button) */}
      {showReport && (
        <div className="fixed inset-0 bg-black/50 z-40 flex items-end">
          <div className="bg-card w-full rounded-t-2xl p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-lg">Report Incident</h3>
              <button onClick={() => setShowReport(false)}><X size={20} /></button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  AlertTriangle, MapPin, Clock, Navigation, Video, CheckCircle, XCircle, Phone,
  ClipboardCheck, RotateCcw,
} from "lucide-react";
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
  const [completedIncidents, setCompletedIncidents] = useState<Incident[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"active" | "completed">("active");
  const supabase = createClient();

  useEffect(() => {
    const fetchIncidents = async () => {
      const [activeRes, completedRes] = await Promise.all([
        supabase
          .from("incidents")
          .select("*")
          .in("incident_type", ["vehicle_collision", "pedestrian_collision", "pedestrian_fall", "fire_smoke"])
          .in("status", ["detected", "acknowledged", "responding"])
          .order("created_at", { ascending: false }),
        supabase
          .from("incidents")
          .select("*")
          .in("incident_type", ["vehicle_collision", "pedestrian_collision", "pedestrian_fall", "fire_smoke"])
          .in("status", ["resolved", "completed"])
          .order("created_at", { ascending: false })
          .limit(20),
      ]);

      if (activeRes.data) setIncidents(activeRes.data);
      if (completedRes.data) setCompletedIncidents(completedRes.data);
      setLoading(false);
    };

    fetchIncidents();

    // Listen for new incidents via realtime
    const channel = supabase
      .channel("ambulance-alerts")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "incidents" },
        (payload) => {
          const inc = payload.new as Incident;
          const accidentTypes = ["vehicle_collision", "pedestrian_collision", "pedestrian_fall", "fire_smoke"];
          if (accidentTypes.includes(inc.incident_type)) {
            setIncidents((prev) => [inc, ...prev]);
            toast.error(`NEW ${inc.severity.toUpperCase()} ${inc.incident_type.replace(/_/g, " ")}`);
          }
        }
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "incidents" },
        (payload) => {
          const inc = payload.new as Incident;
          // If status changed to resolved/completed, move to completed list
          if (inc.status === "resolved" || inc.status === "completed") {
            setIncidents((prev) => prev.filter((i) => i.id !== inc.id));
            setCompletedIncidents((prev) => [inc, ...prev].slice(0, 20));
          } else {
            // Update in active list
            setIncidents((prev) => prev.map((i) => (i.id === inc.id ? inc : i)));
          }
        }
      )
      .on("broadcast", { event: "clip_ready" }, (payload) => {
        const { incident_id, video_clip_url } = payload.payload as { incident_id: string; video_clip_url: string };
        setIncidents((prev) =>
          prev.map((i) => (i.id === incident_id ? { ...i, video_clip_url } : i))
        );
        toast.success("Video clip attached to incident");
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const handleAccept = async (incidentId: string) => {
    await supabase.from("incidents").update({ status: "acknowledged" }).eq("id", incidentId);
    setIncidents((prev) => prev.map((i) => (i.id === incidentId ? { ...i, status: "acknowledged" } : i)));
    toast.success("Incident accepted — dispatching ambulance");
  };

  const handleDeny = async (incidentId: string) => {
    await supabase.from("incidents").update({ status: "resolved" }).eq("id", incidentId);
    const denied = incidents.find((i) => i.id === incidentId);
    setIncidents((prev) => prev.filter((i) => i.id !== incidentId));
    if (denied) setCompletedIncidents((prev) => [{ ...denied, status: "resolved" }, ...prev].slice(0, 20));
    toast.success("Incident dismissed");
  };

  const handleDispatch = async (incidentId: string) => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    await supabase.from("incident_responses").insert({
      incident_id: incidentId,
      responder_id: user.id,
      response_type: "dispatched",
    });

    await supabase.from("incidents").update({ status: "responding" }).eq("id", incidentId);
    setIncidents((prev) => prev.map((i) => (i.id === incidentId ? { ...i, status: "responding" } : i)));
    toast.success("Ambulance dispatched!");
  };

  const handleComplete = async (incidentId: string) => {
    await supabase.from("incidents").update({ status: "resolved", updated_at: new Date().toISOString() }).eq("id", incidentId);
    const done = incidents.find((i) => i.id === incidentId);
    setIncidents((prev) => prev.filter((i) => i.id !== incidentId));
    if (done) setCompletedIncidents((prev) => [{ ...done, status: "resolved" }, ...prev].slice(0, 20));
    toast.success("Incident marked as completed");
  };

  const critical = incidents.filter((i) => i.severity === "critical").length;
  const major = incidents.filter((i) => i.severity === "major").length;
  const pending = incidents.filter((i) => i.status === "detected").length;

  const renderIncident = (incident: Incident, isCompleted: boolean = false) => (
    <div
      key={incident.id}
      className={`bg-card p-5 rounded-xl border-l-4 ${
        isCompleted ? "border-gray-500 opacity-80" :
        incident.severity === "critical" ? "border-severity-critical" : "border-severity-major"
      }`}
    >
      <div className="space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <AlertTriangle className="w-5 h-5" />
          <h3 className="font-semibold text-lg capitalize">
            {incident.incident_type.replace(/_/g, " ")}
          </h3>
          <span className={`px-2 py-0.5 rounded text-xs font-medium ${
            incident.severity === "critical" ? "bg-severity-critical/20 text-severity-critical"
            : "bg-severity-major/20 text-severity-major"
          }`}>
            {incident.severity}
          </span>
          <span className={`px-2 py-0.5 rounded text-xs font-medium ${
            incident.status === "detected" ? "bg-yellow-500/20 text-yellow-500"
            : incident.status === "acknowledged" ? "bg-blue-500/20 text-blue-500"
            : incident.status === "responding" ? "bg-green-500/20 text-green-500"
            : "bg-gray-500/20 text-gray-400"
          }`}>
            {incident.status === "resolved" ? "completed" : incident.status}
          </span>
        </div>

        <div className="flex items-center gap-4 text-sm text-muted-foreground">
          <span className="flex items-center gap-1">
            <MapPin size={14} />
            {incident.location_name || `${incident.latitude.toFixed(4)}, ${incident.longitude.toFixed(4)}`}
          </span>
          <span className="flex items-center gap-1">
            <Clock size={14} />
            {new Date(incident.created_at).toLocaleTimeString()}
          </span>
        </div>

        {/* Video Clip — works for both source video URLs and uploaded clips */}
        {incident.video_clip_url ? (
          <div className="bg-background rounded-lg overflow-hidden">
            {incident.video_clip_url.endsWith(".jpg") || incident.video_clip_url.endsWith(".jpeg") ? (
              // Frame capture composite image
              <div>
                <img
                  src={incident.video_clip_url}
                  alt="Accident frames"
                  className="w-full max-h-64 object-contain"
                />
                <div className="px-3 py-2 text-xs text-muted-foreground flex items-center gap-1">
                  <Video size={12} />
                  Captured frames — review before dispatch
                </div>
              </div>
            ) : (
              // Video file (source or uploaded clip)
              <div>
                <video
                  src={incident.video_clip_url}
                  controls
                  preload="none"
                  className="w-full max-h-48"
                />
                <div className="px-3 py-2 text-xs text-muted-foreground flex items-center gap-1">
                  <Video size={12} />
                  Incident footage — review before dispatch
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="bg-background rounded-lg p-4 text-center text-sm text-muted-foreground flex items-center justify-center gap-2">
            <Video size={16} className="opacity-50" />
            {incident.location_name?.startsWith("Video Analysis:")
              ? "Clip processing..."
              : "No video clip available"}
          </div>
        )}

        {/* Actions */}
        {!isCompleted && (
          <div className="flex flex-wrap gap-2">
            {incident.status === "detected" && (
              <>
                <button onClick={() => handleAccept(incident.id)}
                  className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors text-sm flex items-center gap-2">
                  <CheckCircle size={14} /> Accept
                </button>
                <button onClick={() => handleDeny(incident.id)}
                  className="px-4 py-2 bg-red-600/20 text-red-400 rounded-lg hover:bg-red-600/30 transition-colors text-sm flex items-center gap-2">
                  <XCircle size={14} /> Dismiss
                </button>
              </>
            )}
            {incident.status === "acknowledged" && (
              <button onClick={() => handleDispatch(incident.id)}
                className="px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors text-sm flex items-center gap-2">
                <Phone size={14} /> Dispatch Ambulance
              </button>
            )}
            {incident.status === "responding" && (
              <button onClick={() => handleComplete(incident.id)}
                className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors text-sm flex items-center gap-2">
                <ClipboardCheck size={14} /> Mark Completed
              </button>
            )}
            <Link href={`https://www.google.com/maps/dir/?api=1&destination=${incident.latitude},${incident.longitude}`}
              target="_blank"
              className="px-4 py-2 bg-card border border-border rounded-lg hover:bg-background transition-colors text-sm flex items-center gap-2">
              <Navigation size={14} /> Navigate
            </Link>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Ambulance Dashboard</h1>
        <p className="text-muted-foreground">Accident incidents requiring medical response</p>
      </div>

      {/* Quick Stats */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-card p-4 rounded-xl border border-border text-center">
          <p className="text-3xl font-bold text-severity-critical">{critical}</p>
          <p className="text-sm text-muted-foreground">Critical</p>
        </div>
        <div className="bg-card p-4 rounded-xl border border-border text-center">
          <p className="text-3xl font-bold text-severity-major">{major}</p>
          <p className="text-sm text-muted-foreground">Major</p>
        </div>
        <div className="bg-card p-4 rounded-xl border border-border text-center">
          <p className="text-3xl font-bold text-green-500">{completedIncidents.length}</p>
          <p className="text-sm text-muted-foreground">Completed</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 border-b border-border pb-2">
        <button
          onClick={() => setActiveTab("active")}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            activeTab === "active"
              ? "bg-primary text-white"
              : "text-muted-foreground hover:bg-background"
          }`}
        >
          Active ({incidents.length})
        </button>
        <button
          onClick={() => setActiveTab("completed")}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            activeTab === "completed"
              ? "bg-primary text-white"
              : "text-muted-foreground hover:bg-background"
          }`}
        >
          Completed ({completedIncidents.length})
        </button>
      </div>

      {/* Content */}
      {loading ? (
        <div className="text-center py-12 text-muted-foreground">Loading incidents...</div>
      ) : activeTab === "active" ? (
        incidents.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">No active incidents. All clear!</div>
        ) : (
          <div className="space-y-4">{incidents.map((inc) => renderIncident(inc))}</div>
        )
      ) : (
        completedIncidents.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">No completed incidents yet</div>
        ) : (
          <div className="space-y-4">{completedIncidents.map((inc) => renderIncident(inc, true))}</div>
        )
      )}
    </div>
  );
}

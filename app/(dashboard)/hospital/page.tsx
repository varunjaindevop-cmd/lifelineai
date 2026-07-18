"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Building2, Bed, AlertTriangle, TrendingUp } from "lucide-react";
import { toast } from "sonner";

interface Hospital {
  id: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  total_beds: number;
  available_beds: number;
  has_icu: boolean;
  has_trauma: boolean;
}

interface IncomingAlert {
  id: string;
  severity: string;
  incident_type: string;
  created_at: string;
  nearest_hospital?: string;
}

export default function HospitalDashboard() {
  const [hospital, setHospital] = useState<Hospital | null>(null);
  const [incomingAlerts, setIncomingAlerts] = useState<IncomingAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const supabase = createClient();

  useEffect(() => {
    const fetchData = async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return;

      // Get hospital associated with this user (for demo, use first hospital)
      const { data: hospitals } = await supabase
        .from("hospitals")
        .select("*")
        .eq("is_active", true)
        .limit(1)
        .single();

      if (hospitals) {
        setHospital(hospitals);
      }

      // Fetch incoming patient alerts
      const { data: alerts } = await supabase
        .from("incidents")
        .select("*")
        .in("incident_type", [
          "vehicle_collision",
          "pedestrian_collision",
          "pedestrian_fall",
          "fire_smoke",
        ])
        .in("status", ["detected", "responding"])
        .order("created_at", { ascending: false })
        .limit(5);

      if (alerts) {
        setIncomingAlerts(alerts);
      }

      setLoading(false);
    };

    fetchData();

    // Real-time subscription for incoming alerts
    const channel = supabase
      .channel("hospital-alerts")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "incidents" },
        (payload) => {
          const incident = payload.new as IncomingAlert;
          const accidentTypes = [
            "vehicle_collision",
            "pedestrian_collision",
            "pedestrian_fall",
            "fire_smoke",
          ];
          if (accidentTypes.includes(incident.incident_type)) {
            setIncomingAlerts((prev) => [incident, ...prev.slice(0, 4)]);
            toast.error(
              `🏥 Incoming patient: ${incident.incident_type.replace(
                /_/g,
                " "
              )}`
            );
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const updateBeds = async (change: number) => {
    if (!hospital) return;

    const newAvailable = Math.max(
      0,
      Math.min(hospital.total_beds, hospital.available_beds + change)
    );

    await supabase
      .from("hospitals")
      .update({ available_beds: newAvailable })
      .eq("id", hospital.id);

    setHospital({ ...hospital, available_beds: newAvailable });
    toast.success(
      `Bed count updated: ${newAvailable}/${hospital.total_beds} available`
    );
  };

  if (loading) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        Loading hospital data...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Hospital Dashboard</h1>
        <p className="text-muted-foreground">
          Bed management and incoming patient alerts
        </p>
      </div>

      {hospital ? (
        <>
          {/* Bed Status */}
          <div className="bg-card p-6 rounded-xl border border-border">
            <div className="flex items-center gap-3 mb-4">
              <Building2 className="w-6 h-6 text-primary" />
              <div>
                <h2 className="text-lg font-semibold">{hospital.name}</h2>
                <p className="text-sm text-muted-foreground">
                  {hospital.address}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {/* Bed Counter */}
              <div className="text-center p-6 bg-background rounded-xl">
                <Bed className="w-10 h-10 text-primary mx-auto mb-2" />
                <p className="text-4xl font-bold">
                  {hospital.available_beds}
                </p>
                <p className="text-sm text-muted-foreground">
                  of {hospital.total_beds} beds available
                </p>
                <div className="flex gap-2 mt-4 justify-center">
                  <button
                    onClick={() => updateBeds(-1)}
                    className="px-4 py-2 bg-severity-critical/20 text-severity-critical rounded-lg hover:bg-severity-critical/30 transition-colors"
                  >
                    -1 Bed
                  </button>
                  <button
                    onClick={() => updateBeds(1)}
                    className="px-4 py-2 bg-green-500/20 text-green-500 rounded-lg hover:bg-green-500/30 transition-colors"
                  >
                    +1 Bed
                  </button>
                </div>
              </div>

              {/* Capacity Bar */}
              <div className="p-6 bg-background rounded-xl">
                <h3 className="text-sm font-medium mb-3">Capacity</h3>
                <div className="space-y-2">
                  <div className="flex justify-between text-sm">
                    <span>Occupied</span>
                    <span>
                      {hospital.total_beds - hospital.available_beds}/
                      {hospital.total_beds}
                    </span>
                  </div>
                  <div className="w-full bg-card rounded-full h-3">
                    <div
                      className="h-3 rounded-full transition-all"
                      style={{
                        width: `${
                          ((hospital.total_beds - hospital.available_beds) /
                            hospital.total_beds) *
                          100
                        }%`,
                        backgroundColor:
                          hospital.available_beds < 3
                            ? "#EF4444"
                            : hospital.available_beds < 10
                            ? "#F97316"
                            : "#22C55E",
                      }}
                    />
                  </div>
                </div>
                <div className="mt-4 space-y-1 text-sm">
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded bg-green-500" />
                    <span>Available: {hospital.available_beds}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded bg-primary" />
                    <span>
                      Occupied: {hospital.total_beds - hospital.available_beds}
                    </span>
                  </div>
                </div>
              </div>

              {/* Facilities */}
              <div className="p-6 bg-background rounded-xl">
                <h3 className="text-sm font-medium mb-3">Facilities</h3>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm">Emergency</span>
                    <span className="text-green-500 text-sm">✓ Available</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm">ICU</span>
                    <span
                      className={`text-sm ${
                        hospital.has_icu ? "text-green-500" : "text-muted-foreground"
                      }`}
                    >
                      {hospital.has_icu ? "✓ Available" : "✗ Not Available"}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm">Trauma Center</span>
                    <span
                      className={`text-sm ${
                        hospital.has_trauma
                          ? "text-green-500"
                          : "text-muted-foreground"
                      }`}
                    >
                      {hospital.has_trauma
                        ? "✓ Available"
                        : "✗ Not Available"}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Incoming Alerts */}
          <div className="bg-card rounded-xl border border-border">
            <div className="p-6 border-b border-border">
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <AlertTriangle className="w-5 h-5 text-severity-major" />
                Incoming Patient Alerts
              </h2>
            </div>
            <div className="divide-y divide-border">
              {incomingAlerts.length === 0 ? (
                <div className="p-6 text-center text-muted-foreground">
                  No incoming alerts
                </div>
              ) : (
                incomingAlerts.map((alert) => (
                  <div key={alert.id} className="p-4 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div
                        className={`w-2 h-2 rounded-full ${
                          alert.severity === "critical"
                            ? "bg-severity-critical animate-severity-pulse"
                            : "bg-severity-major"
                        }`}
                      />
                      <div>
                        <p className="font-medium">
                          {alert.incident_type.replace(/_/g, " ")}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          {new Date(alert.created_at).toLocaleTimeString()}
                        </p>
                      </div>
                    </div>
                    <span
                      className={`px-2 py-1 rounded text-xs font-medium ${
                        alert.severity === "critical"
                          ? "bg-severity-critical/20 text-severity-critical"
                          : "bg-severity-major/20 text-severity-major"
                      }`}
                    >
                      {alert.severity}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </>
      ) : (
        <div className="text-center py-12 text-muted-foreground">
          No hospital data found. Please contact admin.
        </div>
      )}
    </div>
  );
}

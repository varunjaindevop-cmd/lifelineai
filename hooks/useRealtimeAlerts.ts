"use client";

import { useEffect, useState, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";

interface Alert {
  incident_id: string;
  severity: string;
  incident_type: string;
  latitude: number;
  longitude: number;
  video_clip_url?: string;
  message: string;
  camera_id: string;
  nearest_hospital?: any;
  vehicle_speed?: number;
}

export function useRealtimeAlerts(role: string) {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [connected, setConnected] = useState(false);
  const supabase = createClient();

  useEffect(() => {
    const channel = supabase
      .channel(`alerts:${role}`)
      .on("broadcast", { event: "new_incident" }, (payload) => {
        const alert = payload.payload as Alert;
        setAlerts((prev) => [alert, ...prev.slice(0, 19)]); // Keep last 20

        // Play alert sound for critical/major incidents
        if (alert.severity === "critical" || alert.severity === "major") {
          playAlertSound();
        }

        // Vibrate on mobile
        if (navigator.vibrate && alert.severity === "critical") {
          navigator.vibrate([200, 100, 200]);
        }
      })
      .subscribe((status) => {
        setConnected(status === "SUBSCRIBED");
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [role]);

  const clearAlerts = useCallback(() => {
    setAlerts([]);
  }, []);

  return { alerts, connected, clearAlerts };
}

function playAlertSound() {
  try {
    const audio = new Audio("/sounds/alert.mp3");
    audio.volume = 0.5;
    audio.play().catch(() => {
      // Autoplay blocked, ignore
    });
  } catch {
    // Audio not available
  }
}

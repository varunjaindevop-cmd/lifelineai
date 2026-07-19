// Alert service for Sage
import { createClient } from "../supabase/client";
import { getNotifyRoles, generateAlertMessage } from "./notification-rules";

interface IncidentData {
  severity: string;
  incidentType: string;
  latitude: number;
  longitude: number;
  cameraId: string;
  locationName?: string;
  vehicleSpeed?: number;
  videoClipUrl?: string;
  detectionConfidence: number;
  detectionData: any;
}

// Create incident and send alerts
export async function createIncident(data: IncidentData): Promise<string | null> {
  const supabase = createClient();

  // Create incident record
  const { data: incident, error } = await supabase
    .from("incidents")
    .insert({
      severity: data.severity,
      incident_type: data.incidentType,
      latitude: data.latitude,
      longitude: data.longitude,
      location_name: data.locationName,
      camera_id: data.cameraId,
      detection_confidence: data.detectionConfidence,
      detection_data: data.detectionData,
      vehicle_speed: data.vehicleSpeed,
      video_clip_url: data.videoClipUrl,
      status: "detected",
    })
    .select()
    .single();

  if (error || !incident) {
    console.error("Failed to create incident:", error);
    return null;
  }

  // Find nearest hospital for accident types
  let nearestHospital = null;
  const accidentTypes = [
    "vehicle_collision",
    "pedestrian_collision",
    "pedestrian_fall",
    "fire_smoke",
    "traffic_disruption",
  ];

  if (accidentTypes.includes(data.incidentType)) {
    const { data: hospitals } = await supabase.rpc("find_nearest_hospital", {
      incident_lat: data.latitude,
      incident_lon: data.longitude,
    });

    if (hospitals && hospitals.length > 0) {
      nearestHospital = hospitals[0];
    }
  }

  // Send role-based alerts
  const notifyRoles = getNotifyRoles(data.incidentType);
  const message = generateAlertMessage(
    data.severity,
    data.incidentType,
    data.locationName,
    data.vehicleSpeed
  );

  for (const role of notifyRoles) {
    // Create alert record
    await supabase.from("alerts").insert({
      incident_id: incident.id,
      recipient_role: role,
      message,
    });

    // Broadcast via Supabase Realtime
    supabase.channel(`alerts:${role}`).send({
      type: "broadcast",
      event: "new_incident",
      payload: {
        incident_id: incident.id,
        severity: data.severity,
        incident_type: data.incidentType,
        latitude: data.latitude,
        longitude: data.longitude,
        video_clip_url: data.videoClipUrl,
        message,
        camera_id: data.cameraId,
        nearest_hospital: nearestHospital,
        vehicle_speed: data.vehicleSpeed,
      },
    });
  }

  return incident.id;
}

// Update incident status
export async function updateIncidentStatus(
  incidentId: string,
  status: string
): Promise<boolean> {
  const supabase = createClient();

  const { error } = await supabase
    .from("incidents")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", incidentId);

  return !error;
}

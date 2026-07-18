// Role-based alert routing for Sage
import { AnomalyResult } from "../ai/types";

export type IncidentType =
  | "vehicle_collision"
  | "pedestrian_collision"
  | "pedestrian_fall"
  | "fire_smoke"
  | "crowd_anomaly"
  | "vehicle_anomaly"
  | "loitering"
  | "suspicious_activity"
  | "speeding";

// Which roles get notified for each incident type
export const NOTIFICATION_RULES: Record<IncidentType, string[]> = {
  vehicle_collision: ["admin", "ambulance", "police", "hospital"],
  pedestrian_collision: ["admin", "ambulance", "police", "hospital"],
  pedestrian_fall: ["admin", "ambulance", "police", "hospital"],
  fire_smoke: ["admin", "ambulance", "police", "hospital"],
  crowd_anomaly: ["admin", "police"],
  vehicle_anomaly: ["admin", "police"],
  loitering: ["admin", "police"],
  suspicious_activity: ["admin", "police"],
  speeding: ["admin", "police"],
};

// Get roles that should be notified for an incident type
export function getNotifyRoles(incidentType: string): string[] {
  return NOTIFICATION_RULES[incidentType as IncidentType] || ["admin"];
}

// Generate alert message
export function generateAlertMessage(
  severity: string,
  incidentType: string,
  locationName?: string,
  vehicleSpeed?: number
): string {
  const type = incidentType.replace(/_/g, " ");
  const location = locationName || "Unknown location";

  if (severity === "critical") {
    return `CRITICAL ${type} detected at ${location}. Immediate response required. Video evidence available.`;
  }

  let message = `[${severity.toUpperCase()}] ${type} detected at ${location}.`;

  if (vehicleSpeed) {
    message += ` Vehicle speed: ${vehicleSpeed} km/h.`;
  }

  message += " Video clip attached.";

  return message;
}

// Check if incident type is accident (needs ambulance + hospital)
export function isAccidentType(incidentType: string): boolean {
  const accidentTypes = [
    "vehicle_collision",
    "pedestrian_collision",
    "pedestrian_fall",
    "fire_smoke",
  ];
  return accidentTypes.includes(incidentType);
}

// Check if incident type is anomaly (police only)
export function isAnomalyType(incidentType: string): boolean {
  const anomalyTypes = [
    "crowd_anomaly",
    "vehicle_anomaly",
    "loitering",
    "suspicious_activity",
    "speeding",
  ];
  return anomalyTypes.includes(incidentType);
}

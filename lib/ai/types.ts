// YOLO Detection Types
export interface Detection {
  class: string;
  classId: number;
  confidence: number;
  bbox: [number, number, number, number]; // x1, y1, x2, y2
  centerX: number;
  centerY: number;
  width: number;
  height: number;
}

export interface TrackedObject {
  id: number;
  class: string;
  detections: Detection[];
  currentPosition: { x: number; y: number };
  velocity: { vx: number; vy: number };
  speed: number; // km/h
  trajectory: { x: number; y: number }[];
  lastSeen: number;
}

export type DetectionState = 'monitoring' | 'watching' | 'confirming' | 'alert';

export interface IncidentData {
  severity: 'critical' | 'major' | 'minor' | 'suspicious';
  incidentType: string;
  confidence: number;
  latitude: number;
  longitude: number;
  cameraId: string;
  videoClipUrl?: string;
  vehicleSpeed?: number;
  detectionData: any;
}

export interface QualityMetrics {
  brightness: number;
  contrast: number;
  sharpness: number;
  noise: number;
}

export interface AnomalySignal {
  name: string;
  value: number;
  threshold: number;
  passed: boolean;
}

export interface AnomalyResult {
  type: string;
  confidence: number;
  signals: AnomalySignal[];
  severity: 'critical' | 'major' | 'minor' | 'suspicious';
  sceneContext?: 'isolated_road' | 'traffic' | 'marketplace';
}

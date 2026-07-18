-- Sage Database Schema
-- Run this in Supabase SQL Editor

-- Enable PostGIS for geospatial queries
CREATE EXTENSION IF NOT EXISTS postgis;

-- Profiles (extends Supabase Auth)
CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'ambulance', 'police', 'hospital', 'viewer')),
  phone TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Cameras
CREATE TABLE IF NOT EXISTS cameras (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  location_name TEXT,
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  stream_url TEXT,
  stream_type TEXT CHECK (stream_type IN ('browser', 'rtsp', 'rtmp', 'file', 'mjpeg')),
  calibration_data JSONB,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Incidents
CREATE TABLE IF NOT EXISTS incidents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  camera_id UUID REFERENCES cameras(id) ON DELETE SET NULL,
  severity TEXT NOT NULL CHECK (severity IN ('critical', 'major', 'minor', 'suspicious')),
  incident_type TEXT NOT NULL,
  description TEXT,
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  location_name TEXT,
  detection_confidence FLOAT,
  detection_data JSONB,
  vehicle_speed INT,
  video_clip_url TEXT,
  clip_duration INT DEFAULT 30,
  status TEXT DEFAULT 'detected' CHECK (status IN ('detected', 'acknowledged', 'responding', 'resolved', 'false_positive')),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Hospitals
CREATE TABLE IF NOT EXISTS hospitals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  address TEXT,
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  phone TEXT,
  total_beds INT NOT NULL DEFAULT 0,
  available_beds INT NOT NULL DEFAULT 0,
  has_icu BOOLEAN DEFAULT false,
  has_trauma BOOLEAN DEFAULT false,
  has_emergency BOOLEAN DEFAULT true,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Emergency Vehicles
CREATE TABLE IF NOT EXISTS emergency_vehicles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_number TEXT NOT NULL,
  vehicle_type TEXT CHECK (vehicle_type IN ('ambulance', 'police', 'fire')),
  assigned_user_id UUID REFERENCES profiles(id),
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  is_available BOOLEAN DEFAULT true,
  current_incident_id UUID REFERENCES incidents(id),
  last_location_update TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Incident Responses
CREATE TABLE IF NOT EXISTS incident_responses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id UUID REFERENCES incidents(id) ON DELETE CASCADE,
  responder_id UUID REFERENCES profiles(id),
  vehicle_id UUID REFERENCES emergency_vehicles(id),
  hospital_id UUID REFERENCES hospitals(id),
  response_type TEXT CHECK (response_type IN ('dispatched', 'arrived', 'transporting', 'completed')),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Alerts
CREATE TABLE IF NOT EXISTS alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id UUID REFERENCES incidents(id) ON DELETE CASCADE,
  recipient_role TEXT NOT NULL,
  message TEXT NOT NULL,
  is_read BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status);
CREATE INDEX IF NOT EXISTS idx_incidents_created ON incidents(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_incidents_severity ON incidents(severity);
CREATE INDEX IF NOT EXISTS idx_cameras_active ON cameras(is_active);
CREATE INDEX IF NOT EXISTS idx_hospitals_active ON hospitals(is_active);

-- Function to find nearest hospital with available beds
CREATE OR REPLACE FUNCTION find_nearest_hospital(
  incident_lat DOUBLE PRECISION,
  incident_lon DOUBLE PRECISION,
  required_beds INT DEFAULT 1
)
RETURNS TABLE (
  hospital_id UUID,
  hospital_name TEXT,
  distance_km DOUBLE PRECISION,
  available_beds INT
) AS $$
BEGIN
  RETURN QUERY
  SELECT h.id, h.name,
    (6371 * acos(cos(radians(incident_lat)) * cos(radians(h.latitude)) *
    cos(radians(h.longitude) - radians(incident_lon)) +
    sin(radians(incident_lat)) * sin(radians(h.latitude))))::DOUBLE PRECISION AS distance,
    h.available_beds
  FROM hospitals h
  WHERE h.is_active = true AND h.available_beds >= required_beds
  ORDER BY distance ASC
  LIMIT 5;
END;
$$ LANGUAGE plpgsql;

-- Row Level Security

-- Profiles
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own profile" ON profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY "Users insert own profile" ON profiles FOR INSERT WITH CHECK (auth.uid() = id);
CREATE POLICY "Users update own profile" ON profiles FOR UPDATE USING (auth.uid() = id);
CREATE POLICY "Admins read all profiles" ON profiles FOR SELECT USING (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
);

-- Cameras
ALTER TABLE cameras ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users read cameras" ON cameras FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Admins manage cameras" ON cameras FOR ALL USING (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
);

-- Incidents
ALTER TABLE incidents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users read incidents" ON incidents FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Authenticated users create incidents" ON incidents FOR INSERT WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "Authenticated users update incidents" ON incidents FOR UPDATE USING (auth.role() = 'authenticated');

-- Hospitals
ALTER TABLE hospitals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users read hospitals" ON hospitals FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Admins manage hospitals" ON hospitals FOR UPDATE USING (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
);
CREATE POLICY "Hospital staff update beds" ON hospitals FOR UPDATE USING (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'hospital')
);

-- Emergency Vehicles
ALTER TABLE emergency_vehicles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users read vehicles" ON emergency_vehicles FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Assigned users update vehicles" ON emergency_vehicles FOR UPDATE USING (auth.uid() = assigned_user_id);

-- Incident Responses
ALTER TABLE incident_responses ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users read responses" ON incident_responses FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Authenticated users create responses" ON incident_responses FOR INSERT WITH CHECK (auth.role() = 'authenticated');

-- Alerts
ALTER TABLE alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users read alerts" ON alerts FOR SELECT USING (auth.role() = 'authenticated');

-- Enable Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE incidents;
ALTER PUBLICATION supabase_realtime ADD TABLE alerts;
ALTER PUBLICATION supabase_realtime ADD TABLE emergency_vehicles;

-- QUICK FIX: Run this in Supabase SQL Editor to fix profile creation
-- This drops old policies and recreates them with INSERT permission

-- Drop existing profile policies
DROP POLICY IF EXISTS "Users read own profile" ON profiles;
DROP POLICY IF EXISTS "Users update own profile" ON profiles;
DROP POLICY IF EXISTS "Admins read all profiles" ON profiles;

-- Recreate with INSERT permission
CREATE POLICY "Users read own profile" ON profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY "Users insert own profile" ON profiles FOR INSERT WITH CHECK (auth.uid() = id);
CREATE POLICY "Users update own profile" ON profiles FOR UPDATE USING (auth.uid() = id);
CREATE POLICY "Admins read all profiles" ON profiles FOR SELECT USING (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
);

-- Also ensure all other policies are correct
-- Cameras
DROP POLICY IF EXISTS "Authenticated users read cameras" ON cameras;
DROP POLICY IF EXISTS "Admins manage cameras" ON cameras;
CREATE POLICY "Authenticated users read cameras" ON cameras FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Authenticated users insert cameras" ON cameras FOR INSERT WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "Authenticated users update cameras" ON cameras FOR UPDATE USING (auth.role() = 'authenticated');
CREATE POLICY "Authenticated users delete cameras" ON cameras FOR DELETE USING (auth.role() = 'authenticated');

-- Incidents  
DROP POLICY IF EXISTS "Authenticated users read incidents" ON incidents;
DROP POLICY IF EXISTS "Authenticated users create incidents" ON incidents;
DROP POLICY IF EXISTS "Authenticated users update incidents" ON incidents;
CREATE POLICY "Authenticated users read incidents" ON incidents FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Authenticated users create incidents" ON incidents FOR INSERT WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "Authenticated users update incidents" ON incidents FOR UPDATE USING (auth.role() = 'authenticated');

-- Hospitals
DROP POLICY IF EXISTS "Authenticated users read hospitals" ON hospitals;
DROP POLICY IF EXISTS "Admins manage hospitals" ON hospitals;
DROP POLICY IF EXISTS "Hospital staff update beds" ON hospitals;
CREATE POLICY "Authenticated users read hospitals" ON hospitals FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Authenticated users update hospitals" ON hospitals FOR UPDATE USING (auth.role() = 'authenticated');

-- Alerts
DROP POLICY IF EXISTS "Authenticated users read alerts" ON alerts;
CREATE POLICY "Authenticated users read alerts" ON alerts FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Authenticated users create alerts" ON alerts FOR INSERT WITH CHECK (auth.role() = 'authenticated');

-- Incident Responses
DROP POLICY IF EXISTS "Authenticated users read responses" ON incident_responses;
DROP POLICY IF EXISTS "Authenticated users create responses" ON incident_responses;
CREATE POLICY "Authenticated users read responses" ON incident_responses FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Authenticated users create responses" ON incident_responses FOR INSERT WITH CHECK (auth.role() = 'authenticated');

-- Emergency Vehicles
DROP POLICY IF EXISTS "Authenticated users read vehicles" ON emergency_vehicles;
DROP POLICY IF EXISTS "Assigned users update vehicles" ON emergency_vehicles;
CREATE POLICY "Authenticated users read vehicles" ON emergency_vehicles FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Authenticated users update vehicles" ON emergency_vehicles FOR UPDATE USING (auth.role() = 'authenticated');

-- Enable realtime on all key tables
ALTER PUBLICATION supabase_realtime ADD TABLE incidents;
ALTER PUBLICATION supabase_realtime ADD TABLE alerts;
ALTER PUBLICATION supabase_realtime ADD TABLE emergency_vehicles;
ALTER PUBLICATION supabase_realtime ADD TABLE cameras;

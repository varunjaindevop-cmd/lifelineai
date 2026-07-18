-- Run this in Supabase SQL Editor to add construction zones support

CREATE TABLE IF NOT EXISTS construction_zones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label TEXT NOT NULL,
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  radius INT DEFAULT 200,
  is_active BOOLEAN DEFAULT true,
  created_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE construction_zones ENABLE ROW LEVEL SECURITY;
CREATE POLICY "czone_read" ON construction_zones FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "czone_insert" ON construction_zones FOR INSERT WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "czone_update" ON construction_zones FOR UPDATE USING (auth.role() = 'authenticated');
CREATE POLICY "czone_delete" ON construction_zones FOR DELETE USING (auth.role() = 'authenticated');

-- Seed: some construction zones in Indore
INSERT INTO construction_zones (label, latitude, longitude) VALUES
('Road repair near Vijay Nagar Square', 22.7510, 75.8560),
('Pipeline work on AB Road', 22.7210, 75.8790),
('Bridge maintenance near Rajwada', 22.7190, 75.8540),
('Metro construction Palasia', 22.7310, 75.8610),
('Drainage work Ring Road', 22.7360, 75.8510);

ALTER PUBLICATION supabase_realtime ADD TABLE construction_zones;

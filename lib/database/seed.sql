-- Seed Data for Sage — Indore, India
-- Run this after schema.sql

-- Hospitals in Indore
INSERT INTO hospitals (name, address, latitude, longitude, phone, total_beds, available_beds, has_icu, has_trauma) VALUES
('MY Hospital', 'AH-43, Vijay Nagar, Indore', 22.7500, 75.8570, '+91-731-2527486', 500, 42, true, true),
('Bombay Hospital', ' Scheme No 94, Indore', 22.7380, 75.8680, '+91-731-2420655', 350, 28, true, true),
('CHL Hospital', ' AB Road, Indore', 22.7200, 75.8800, '+91-731-4001100', 300, 22, true, false),
('Medanta Hospital', ' Scheme No 113, Indore', 22.7600, 75.8700, '+91-731-4111111', 400, 35, true, true),
('CH Rawat Hospital', ' Palasia, Indore', 22.7300, 75.8600, '+91-731-2555555', 200, 15, false, false),
('Greater Kailash Hospital', ' Vijay Nagar, Indore', 22.7550, 75.8620, '+91-731-4222222', 180, 12, true, false),
('Satya Sai Hospital', ' Palasia, Indore', 22.7250, 75.8650, '+91-731-4003333', 150, 10, false, false),
('Asian Heart Hospital', ' AB Road, Indore', 22.7150, 75.8750, '+91-731-4114444', 250, 18, true, true),
('Appollo Hospital', ' Scheme No 74, Indore', 22.7450, 75.8800, '+91-731-4225555', 280, 20, true, false),
('Care Hospital', ' Ring Road, Indore', 22.7350, 75.8500, '+91-731-4006666', 220, 16, true, false),
('Leo Medicare Hospital', ' Rajendra Nagar, Indore', 22.7200, 75.8450, '+91-731-2557777', 120, 8, false, false),
('Ideal Hospital', ' Bhawarkuan, Indore', 22.7100, 75.8550, '+91-731-4008888', 100, 6, false, false),
('Vandana Hospital', ' Sapna Sangeeta, Indore', 22.7400, 75.8530, '+91-731-4229999', 160, 11, false, false),
('Shreeji Hospital', ' Lasudia, Indore', 22.7500, 75.8400, '+91-731-2550000', 140, 9, false, false),
('Choithram Hospital', ' Manik Bagh, Indore', 22.7150, 75.8650, '+91-731-4001111', 190, 14, true, false);

-- Cameras in Indore
INSERT INTO cameras (name, location_name, latitude, longitude, stream_type, is_active) VALUES
('Vijay Nagar Square', 'Vijay Nagar Square, Indore', 22.7500, 75.8570, 'browser', true),
('Palasia Junction', 'Palasia Square, Indore', 22.7300, 75.8600, 'browser', true),
('AB Road Camera', 'AB Road Near Medanta, Indore', 22.7200, 75.8800, 'browser', true),
('Rajwada Camera', 'Rajwada Palace Area, Indore', 22.7180, 75.8550, 'browser', true),
('IT Park Camera', 'IT Park Square, Indore', 22.7600, 75.8700, 'browser', true),
('Ring Road Camera', 'Ring Road Junction, Indore', 22.7350, 75.8500, 'browser', true),
('Sarwate Bazaar Camera', 'Sarwate Bazaar, Indore', 22.7250, 75.8620, 'browser', true),
('Mhow Naka Camera', 'Mhow Naka, Indore', 22.7100, 75.8450, 'browser', true);

-- Sample Incidents for Demo
INSERT INTO incidents (camera_id, severity, incident_type, latitude, longitude, location_name, detection_confidence, status) VALUES
((SELECT id FROM cameras WHERE name = 'Vijay Nagar Square' LIMIT 1), 'critical', 'vehicle_collision', 22.7500, 75.8570, 'Vijay Nagar Square', 0.87, 'detected'),
((SELECT id FROM cameras WHERE name = 'Palasia Junction' LIMIT 1), 'major', 'pedestrian_fall', 22.7300, 75.8600, 'Palasia Square', 0.72, 'acknowledged'),
((SELECT id FROM cameras WHERE name = 'AB Road Camera' LIMIT 1), 'suspicious', 'crowd_anomaly', 22.7200, 75.8800, 'AB Road Near Medanta', 0.65, 'detected'),
((SELECT id FROM cameras WHERE name = 'Ring Road Camera' LIMIT 1), 'minor', 'vehicle_anomaly', 22.7350, 75.8500, 'Ring Road Junction', 0.58, 'resolved');

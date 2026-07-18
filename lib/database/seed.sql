-- Seed Data for Sage
-- Run this after schema.sql

-- Seed Hospitals (Delhi, India area)
INSERT INTO hospitals (name, address, latitude, longitude, phone, total_beds, available_beds, has_icu, has_trauma) VALUES
('AIIMS Delhi', 'Sri Aurobindo Marg, New Delhi', 28.5672, 77.2100, '+91-11-26588500', 2000, 150, true, true),
('Safdarjung Hospital', 'Ansari Nagar, New Delhi', 28.5692, 77.2080, '+91-11-26707328', 1500, 120, true, true),
('Ram Manohar Lohia Hospital', 'Baba Kharak Singh Marg, New Delhi', 28.6308, 77.2318, '+91-11-23365525', 800, 65, true, false),
('LNJP Hospital', 'Ansari Nagar, New Delhi', 28.5680, 77.2060, '+91-11-26706383', 1000, 85, true, true),
('Guru Tegh Bahadur Hospital', 'Dilshad Garden, Delhi', 28.6820, 77.2920, '+91-11-22586262', 900, 70, true, false),
('Lok Nayak Hospital', 'Jawaharlal Nehru Marg, Delhi', 28.6380, 77.2430, '+91-11-23234567', 600, 45, false, true),
('Deen Dayal Upadhyay Hospital', 'Hari Nagar, Delhi', 28.6450, 77.1300, '+91-11-25494464', 500, 35, false, false),
('Baba Saheb Ambedkar Hospital', 'Rohini Sector 6, Delhi', 28.7200, 77.1100, '+91-11-27901562', 400, 30, true, false),
('Hindu Rao Hospital', 'Malka Ganj, Delhi', 28.6780, 77.2100, '+91-11-23917373', 350, 25, false, false),
('GTB Hospital', 'Dilshad Garden, Delhi', 28.6830, 77.2940, '+91-11-22582277', 850, 60, true, true),
('Sanjay Gandhi Memorial Hospital', 'Mandakini Colony, Delhi', 28.5700, 77.3100, '+91-11-22283456', 300, 20, false, false),
('Charak Palika Hospital', 'Moti Bagh, Delhi', 28.5800, 77.1700, '+91-11-26101546', 200, 15, false, false),
('Ambedkar Nagar Hospital', 'Dr. Ambedkar Nagar, Delhi', 28.5200, 77.2800, '+91-11-26912345', 250, 18, false, false),
('Satyawadi Rajan Babu Hospital', 'Saraswati Vihar, Delhi', 28.7000, 77.1500, '+91-11-27345678', 150, 10, false, false),
('ESI Hospital, Basaidarapur', 'Ring Road, Delhi', 28.6500, 77.1900, '+91-11-25105678', 400, 28, true, false);

-- Seed Cameras
INSERT INTO cameras (name, location_name, latitude, longitude, stream_type, is_active) VALUES
('Main Junction Camera', 'Connaught Place Junction', 28.6315, 77.2167, 'browser', true),
('Highway Monitor', 'NH-44 Entry Point', 28.5800, 77.2500, 'browser', true),
('Market Area Camera', 'Chandni Chowk Main Road', 28.6507, 77.2303, 'browser', true),
('Hospital Zone Camera', 'Near AIIMS', 28.5670, 77.2100, 'browser', true),
('School Zone Camera', 'Vasant Kunj School Area', 28.5200, 77.1600, 'browser', true),
('Metro Station Camera', 'Rajiv Chowk Metro', 28.6328, 77.2197, 'browser', true),
('Traffic Signal Camera', 'ITO Crossing', 28.6290, 77.2410, 'browser', true),
('Residential Area Camera', 'Dwarka Sector 10', 28.5800, 77.0500, 'browser', true);

-- Sample Incidents for Demo
INSERT INTO incidents (camera_id, severity, incident_type, latitude, longitude, location_name, detection_confidence, status) VALUES
((SELECT id FROM cameras WHERE name = 'Main Junction Camera' LIMIT 1), 'critical', 'vehicle_collision', 28.6315, 77.2167, 'Connaught Place Junction', 0.87, 'detected'),
((SELECT id FROM cameras WHERE name = 'Highway Monitor' LIMIT 1), 'major', 'pedestrian_fall', 28.5800, 77.2500, 'NH-44 Entry Point', 0.72, 'acknowledged'),
((SELECT id FROM cameras WHERE name = 'Market Area Camera' LIMIT 1), 'suspicious', 'crowd_anomaly', 28.6507, 77.2303, 'Chandni Chowk Main Road', 0.65, 'detected'),
((SELECT id FROM cameras WHERE name = 'Traffic Signal Camera' LIMIT 1), 'minor', 'vehicle_anomaly', 28.6290, 77.2410, 'ITO Crossing', 0.58, 'resolved');

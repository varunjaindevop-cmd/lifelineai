# Sage — AI-Powered CCTV Accident Detection & Emergency Alert System

## Overview

Sage is an intelligent accident detection and emergency response system that processes live CCTV camera feeds through an AI pipeline, detects accidents and anomalies in real-time, captures 30-second evidence clips, and simultaneously alerts the right emergency responders based on incident type.

## Key Features

- **Real-Time AI Detection** — YOLOv8 object detection running in the browser
- **Bad Footage Resilience** — Auto-enhances dark, blurry, grainy CCTV video
- **Smart Alert Routing** — Accidents notify everyone, suspicious activity only notifies police
- **30-Second Evidence Clips** — Captures 15s before + 15s after every incident
- **Multi-Role Dashboards** — Admin, ambulance, police, hospital each see their own view
- **Real-Time Map** — Live view of all cameras, incidents, and emergency vehicles
- **Vehicle Speed Estimation** — Calculates speed from camera footage using perspective geometry
- **State Machine Reasoning** — Shows the AI "thinking" as it analyzes footage

## Tech Stack

- **Frontend:** Next.js 14+ (App Router) + TypeScript
- **Styling:** Tailwind CSS + shadcn/ui
- **Maps:** Leaflet + react-leaflet
- **Backend:** Supabase (Auth, Postgres, Realtime, Storage)
- **AI:** YOLOv8n (ONNX) via onnxruntime-web
- **Charts:** Recharts

## Getting Started

### 1. Install Dependencies

```bash
npm install
```

### 2. Set Up Supabase

1. Create a new Supabase project at [supabase.com](https://supabase.com)
2. Run the SQL in `lib/database/schema.sql` in the SQL Editor
3. Run the SQL in `lib/database/seed.sql` to add sample data
4. Create a Storage bucket named `incident-clips`

### 3. Configure Environment

Copy `.env.local.example` to `.env.local` and fill in your Supabase credentials:

```
NEXT_PUBLIC_SUPABASE_URL=your-supabase-url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-supabase-anon-key
```

### 4. Run Development Server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

### 5. Deploy to Vercel

```bash
vercel deploy
```

## Demo Accounts

After running the seed SQL, create accounts with these roles:
- **Admin:** Full system access
- **Ambulance:** See accident incidents only
- **Police:** See all incidents
- **Hospital:** Bed management

## Project Structure

```
sage/
├── app/                    # Next.js App Router pages
│   ├── (auth)/            # Login & Register
│   └── (dashboard)/       # Role-based dashboards
│       ├── admin/         # Admin overview
│       ├── ambulance/     # Ambulance responder view
│       ├── police/        # Police responder view
│       ├── hospital/      # Hospital bed management
│       ├── cameras/       # Camera management + AI feed
│       ├── incidents/     # Incident list & details
│       └── map/           # Live map
├── components/            # React components
├── hooks/                 # Custom React hooks
├── lib/                   # Core libraries
│   ├── ai/               # AI detection engine
│   ├── alerts/           # Alert routing service
│   ├── database/         # SQL schemas
│   ├── detection/        # Image processing & speed estimation
│   └── supabase/         # Supabase clients
└── public/               # Static assets
```

## Detection Types

| Type | Alerts | Description |
|------|--------|-------------|
| Vehicle Collision | Admin, Ambulance, Police, Hospital | Two vehicles colliding |
| Pedestrian Collision | Admin, Ambulance, Police, Hospital | Vehicle hitting person |
| Pedestrian Fall | Admin, Ambulance, Police, Hospital | Person falling down |
| Fire/Smoke | Admin, Ambulance, Police, Hospital | Fire or smoke detected |
| Crowd Anomaly | Admin, Police | Unusual crowd gathering |
| Vehicle Anomaly | Admin, Police | Erratic driving |
| Loitering | Admin, Police | Suspicious following behavior |
| Speeding | Admin, Police | Vehicle exceeding speed limit |

## License

MIT

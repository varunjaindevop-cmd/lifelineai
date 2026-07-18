import Link from "next/link";
import { Shield, Map, AlertTriangle, Navigation, Phone, Users } from "lucide-react";

export default function Home() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-background px-4">
      <div className="max-w-2xl text-center space-y-8">
        <div className="flex items-center justify-center gap-3">
          <div className="p-3 bg-primary/20 rounded-xl">
            <Shield className="w-10 h-10 text-primary" />
          </div>
          <h1 className="text-5xl font-bold tracking-tight">LifelineAI</h1>
        </div>

        <p className="text-xl text-muted-foreground">
          AI-Powered Safety Ecosystem — Detect. Alert. Protect.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-8">
          <div className="bg-card p-6 rounded-xl border border-border">
            <Map className="w-8 h-8 text-primary mb-3" />
            <h3 className="font-semibold mb-1">Live Safety Map</h3>
            <p className="text-sm text-muted-foreground">
              Real-time incident mapping with safe zone navigation for citizens
            </p>
          </div>
          <div className="bg-card p-6 rounded-xl border border-border">
            <AlertTriangle className="w-8 h-8 text-severity-major mb-3" />
            <h3 className="font-semibold mb-1">AI Detection</h3>
            <p className="text-sm text-muted-foreground">
              CCTV feeds analyzed 24/7 for accidents, anomalies, and emergencies
            </p>
          </div>
          <div className="bg-card p-6 rounded-xl border border-border">
            <Phone className="w-8 h-8 text-severity-critical mb-3" />
            <h3 className="font-semibold mb-1">Instant Alerts</h3>
            <p className="text-sm text-muted-foreground">
              Ambulance, police, and hospitals notified simultaneously with evidence clips
            </p>
          </div>
        </div>

        <div className="flex gap-4 justify-center mt-8">
          <Link
            href="/login"
            className="px-8 py-3 bg-primary text-white rounded-lg font-semibold hover:bg-primary/90 transition-colors"
          >
            Sign In
          </Link>
          <Link
            href="/register"
            className="px-8 py-3 bg-card border border-border rounded-lg font-semibold hover:bg-card/80 transition-colors"
          >
            Get Started
          </Link>
        </div>

        <div className="mt-8 text-sm text-muted-foreground">
          <p>Indore Smart City — Making every route safer with AI</p>
        </div>
      </div>
    </div>
  );
}

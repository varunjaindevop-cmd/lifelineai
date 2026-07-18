import Link from "next/link";
import { Shield, Eye, Zap } from "lucide-react";

export default function Home() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-background px-4">
      <div className="max-w-2xl text-center space-y-8">
        {/* Logo */}
        <div className="flex items-center justify-center gap-3">
          <div className="p-3 bg-primary/20 rounded-xl">
            <Shield className="w-10 h-10 text-primary" />
          </div>
          <h1 className="text-5xl font-bold tracking-tight">Sage</h1>
        </div>

        {/* Tagline */}
        <p className="text-xl text-muted-foreground">
          AI-Powered CCTV Accident Detection & Emergency Alert System
        </p>

        {/* Features */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-8">
          <div className="bg-card p-6 rounded-xl border border-border">
            <Eye className="w-8 h-8 text-primary mb-3" />
            <h3 className="font-semibold mb-1">Real-Time Detection</h3>
            <p className="text-sm text-muted-foreground">
              AI analyzes every frame from CCTV feeds to detect accidents,
              anomalies, and emergencies
            </p>
          </div>
          <div className="bg-card p-6 rounded-xl border border-border">
            <Zap className="w-8 h-8 text-severity-major mb-3" />
            <h3 className="font-semibold mb-1">Instant Alerts</h3>
            <p className="text-sm text-muted-foreground">
              Simultaneous notifications to ambulance, police, and nearest
              hospital with 30-second evidence clips
            </p>
          </div>
          <div className="bg-card p-6 rounded-xl border border-border">
            <Shield className="w-8 h-8 text-severity-critical mb-3" />
            <h3 className="font-semibold mb-1">Smart Routing</h3>
            <p className="text-sm text-muted-foreground">
              Accidents alert all responders. Suspicious activity alerts only
              police. Nearest hospital auto-assigned
            </p>
          </div>
        </div>

        {/* CTA */}
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
            Create Account
          </Link>
        </div>
      </div>
    </div>
  );
}

"use client";

import dynamic from "next/dynamic";

const MapContent = dynamic(() => import("./map-content"), {
  ssr: false,
  loading: () => (
    <div className="h-[calc(100vh-8rem)] flex items-center justify-center bg-card rounded-xl border border-border">
      <p className="text-muted-foreground">Loading map...</p>
    </div>
  ),
});

export default function MapPage() {
  return <MapContent />;
}

"use client";

import { useEffect, useState, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  Camera,
  Plus,
  Trash2,
  MapPin,
  ToggleLeft,
  ToggleRight,
  Play,
  Pause,
  Video,
} from "lucide-react";
import { toast } from "sonner";
import Link from "next/link";

interface Camera {
  id: string;
  name: string;
  location_name: string;
  latitude: number;
  longitude: number;
  stream_url: string;
  stream_type: string;
  is_active: boolean;
}

// Demo video clips mapped to cameras
const DEMO_CLIPS: Record<string, { src: string; label: string }> = {
  accident_sample: { src: "/videos/accident_sample.mp4", label: "Accident Sample" },
  camera2_demo: { src: "/videos/camera2_demo.mp4", label: "Camera 2 Demo" },
  camera4_demo: { src: "/videos/camera4_demo.mp4", label: "Camera 4 Demo" },
  checking: { src: "/videos/checking.mp4", label: "System Check" },
};

const DEMO_CLIP_KEYS = Object.keys(DEMO_CLIPS);

function CameraCard({ camera, clipIndex }: { camera: Camera; clipIndex: number }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const clip = DEMO_CLIPS[DEMO_CLIP_KEYS[clipIndex % DEMO_CLIP_KEYS.length]];

  const togglePlay = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!videoRef.current) return;
    if (isPlaying) {
      videoRef.current.pause();
      setIsPlaying(false);
    } else {
      videoRef.current.play();
      setIsPlaying(true);
    }
  };

  return (
    <div className="bg-card rounded-xl border border-border overflow-hidden">
      {/* Video preview */}
      <div className="aspect-video bg-black relative group">
        <video
          ref={videoRef}
          src={clip.src}
          className="w-full h-full object-cover"
          muted
          loop
          playsInline
          preload="metadata"
          onMouseEnter={() => {
            if (videoRef.current) videoRef.current.play();
            setIsPlaying(true);
          }}
          onMouseLeave={() => {
            if (videoRef.current) {
              videoRef.current.pause();
              videoRef.current.currentTime = 0;
            }
            setIsPlaying(false);
          }}
        />
        {/* Play/Pause overlay */}
        <button
          onClick={togglePlay}
          className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover:bg-black/30 transition-colors"
        >
          <div className={`w-12 h-12 rounded-full bg-black/50 flex items-center justify-center transition-opacity ${isPlaying ? "opacity-0 group-hover:opacity-100" : "opacity-100"}`}>
            {isPlaying ? (
              <Pause className="w-5 h-5 text-white" />
            ) : (
              <Play className="w-5 h-5 text-white ml-0.5" />
            )}
          </div>
        </button>
        {/* Clip badge */}
        <div className="absolute top-2 left-2 flex items-center gap-1 bg-black/60 px-2 py-1 rounded text-xs text-white">
          <Video size={10} />
          {clip.label}
        </div>
        {!camera.is_active && (
          <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
            <span className="px-3 py-1 bg-severity-critical/20 text-severity-critical rounded text-sm">
              Offline
            </span>
          </div>
        )}
      </div>

      {/* Info */}
      <div className="p-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="font-semibold">{camera.name}</h3>
          <button
            className={camera.is_active ? "text-green-500" : "text-muted-foreground"}
          >
            {camera.is_active ? <ToggleRight size={24} /> : <ToggleLeft size={24} />}
          </button>
        </div>
        <p className="text-sm text-muted-foreground flex items-center gap-1 mb-3">
          <MapPin size={12} />
          {camera.location_name || "No location set"}
        </p>
        <div className="flex items-center justify-between">
          <span className="px-2 py-1 bg-card border border-border rounded text-xs">
            {camera.stream_type.toUpperCase()}
          </span>
          <div className="flex gap-2">
            <Link
              href={`/cameras/${camera.id}`}
              className="px-3 py-1 bg-primary/20 text-primary rounded text-sm hover:bg-primary/30"
            >
              View Feed
            </Link>
            <Link
              href={`/admin/videos`}
              className="px-3 py-1 bg-green-500/20 text-green-500 rounded text-sm hover:bg-green-500/30"
            >
              AI Analysis
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function CamerasPage() {
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [newCamera, setNewCamera] = useState({
    name: "",
    location_name: "",
    latitude: 28.6139,
    longitude: 77.209,
    stream_url: "",
    stream_type: "browser",
  });
  const supabase = createClient();

  useEffect(() => {
    fetchCameras();
  }, []);

  const fetchCameras = async () => {
    const { data } = await supabase
      .from("cameras")
      .select("*")
      .order("created_at", { ascending: false });

    if (data) {
      setCameras(data);
    }
    setLoading(false);
  };

  const handleAddCamera = async (e: React.FormEvent) => {
    e.preventDefault();

    const { error } = await supabase.from("cameras").insert({
      name: newCamera.name,
      location_name: newCamera.location_name,
      latitude: newCamera.latitude,
      longitude: newCamera.longitude,
      stream_url: newCamera.stream_url,
      stream_type: newCamera.stream_type,
    });

    if (error) {
      toast.error("Failed to add camera");
      return;
    }

    toast.success("Camera added successfully");
    setShowAddModal(false);
    setNewCamera({
      name: "",
      location_name: "",
      latitude: 28.6139,
      longitude: 77.209,
      stream_url: "",
      stream_type: "browser",
    });
    fetchCameras();
  };

  const deleteCamera = async (id: string) => {
    if (!confirm("Are you sure you want to delete this camera?")) return;

    await supabase.from("cameras").delete().eq("id", id);
    setCameras((prev) => prev.filter((c) => c.id !== id));
    toast.success("Camera deleted");
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Camera Management</h1>
          <p className="text-muted-foreground">
            Manage CCTV camera feeds and their locations
          </p>
        </div>
        <button
          onClick={() => setShowAddModal(true)}
          className="px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors flex items-center gap-2"
        >
          <Plus size={16} />
          Add Camera
        </button>
      </div>

      {/* Camera Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {loading ? (
          <div className="col-span-full text-center py-12 text-muted-foreground">
            Loading cameras...
          </div>
        ) : cameras.length === 0 ? (
          <div className="col-span-full text-center py-12 text-muted-foreground">
            No cameras configured. Add your first camera!
          </div>
        ) : (
          cameras.map((camera, index) => (
            <CameraCard key={camera.id} camera={camera} clipIndex={index} />
          ))
        )}
      </div>

      {/* Add Camera Modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-card rounded-xl border border-border w-full max-w-md">
            <div className="p-6 border-b border-border">
              <h2 className="text-lg font-semibold">Add New Camera</h2>
            </div>
            <form onSubmit={handleAddCamera} className="p-6 space-y-4">
              <div>
                <label className="text-sm font-medium mb-1 block">
                  Camera Name
                </label>
                <input
                  type="text"
                  value={newCamera.name}
                  onChange={(e) =>
                    setNewCamera({ ...newCamera, name: e.target.value })
                  }
                  className="w-full px-4 py-2 bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary"
                  placeholder="Main Street Camera"
                  required
                />
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block">
                  Location Name
                </label>
                <input
                  type="text"
                  value={newCamera.location_name}
                  onChange={(e) =>
                    setNewCamera({
                      ...newCamera,
                      location_name: e.target.value,
                    })
                  }
                  className="w-full px-4 py-2 bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary"
                  placeholder="Main Street & 5th Avenue"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-sm font-medium mb-1 block">
                    Latitude
                  </label>
                  <input
                    type="number"
                    step="any"
                    value={newCamera.latitude}
                    onChange={(e) =>
                      setNewCamera({
                        ...newCamera,
                        latitude: parseFloat(e.target.value),
                      })
                    }
                    className="w-full px-4 py-2 bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium mb-1 block">
                    Longitude
                  </label>
                  <input
                    type="number"
                    step="any"
                    value={newCamera.longitude}
                    onChange={(e) =>
                      setNewCamera({
                        ...newCamera,
                        longitude: parseFloat(e.target.value),
                      })
                    }
                    className="w-full px-4 py-2 bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary"
                  />
                </div>
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block">
                  Stream Type
                </label>
                <select
                  value={newCamera.stream_type}
                  onChange={(e) =>
                    setNewCamera({
                      ...newCamera,
                      stream_type: e.target.value,
                    })
                  }
                  className="w-full px-4 py-2 bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary"
                >
                  <option value="browser">Browser Camera</option>
                  <option value="file">Video File</option>
                  <option value="rtsp">RTSP Stream</option>
                  <option value="rtmp">RTMP Stream</option>
                  <option value="mjpeg">MJPEG URL</option>
                </select>
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block">
                  Stream URL (optional)
                </label>
                <input
                  type="text"
                  value={newCamera.stream_url}
                  onChange={(e) =>
                    setNewCamera({ ...newCamera, stream_url: e.target.value })
                  }
                  className="w-full px-4 py-2 bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary"
                  placeholder="rtsp://... or http://..."
                />
              </div>
              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="flex-1 px-4 py-2 bg-card border border-border rounded-lg hover:bg-background transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="flex-1 px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors"
                >
                  Add Camera
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

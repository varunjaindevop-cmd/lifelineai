"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  Camera,
  Plus,
  Edit,
  Trash2,
  MapPin,
  ToggleLeft,
  ToggleRight,
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

  const toggleCamera = async (id: string, currentState: boolean) => {
    await supabase.from("cameras").update({ is_active: !currentState }).eq("id", id);
    setCameras((prev) =>
      prev.map((c) => (c.id === id ? { ...c, is_active: !c.is_active } : c))
    );
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
          cameras.map((camera) => (
            <div
              key={camera.id}
              className="bg-card rounded-xl border border-border overflow-hidden"
            >
              {/* Preview placeholder */}
              <div className="aspect-video bg-background flex items-center justify-center relative">
                <Camera className="w-12 h-12 text-muted-foreground" />
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
                    onClick={() => toggleCamera(camera.id, camera.is_active)}
                    className={
                      camera.is_active
                        ? "text-green-500"
                        : "text-muted-foreground"
                    }
                  >
                    {camera.is_active ? (
                      <ToggleRight size={24} />
                    ) : (
                      <ToggleLeft size={24} />
                    )}
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
                    <button
                      onClick={() => deleteCamera(camera.id)}
                      className="px-3 py-1 bg-severity-critical/20 text-severity-critical rounded text-sm hover:bg-severity-critical/30"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              </div>
            </div>
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

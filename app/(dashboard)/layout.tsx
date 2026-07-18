"use client";

import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import {
  Shield, Map, AlertTriangle, Camera, LogOut, Menu, X, Home, Phone
} from "lucide-react";
import { cn } from "@/lib/utils";

interface UserProfile {
  full_name: string;
  role: string;
}

const NAV_ITEMS: Record<string, { label: string; href: string; icon: any }[]> = {
  user: [
    { label: "Home", href: "/user", icon: Home },
  ],
  ambulance: [
    { label: "Dashboard", href: "/ambulance", icon: Home },
    { label: "Incidents", href: "/incidents", icon: AlertTriangle },
  ],
  admin: [
    { label: "Dashboard", href: "/admin", icon: Home },
    { label: "Cameras", href: "/cameras", icon: Camera },
    { label: "Incidents", href: "/incidents", icon: AlertTriangle },
    { label: "Live Map", href: "/map", icon: Map },
  ],
  police: [
    { label: "Dashboard", href: "/admin", icon: Home },
    { label: "Incidents", href: "/incidents", icon: AlertTriangle },
    { label: "Live Map", href: "/map", icon: Map },
  ],
  hospital: [
    { label: "Dashboard", href: "/hospital", icon: Home },
    { label: "Incidents", href: "/incidents", icon: AlertTriangle },
  ],
};

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const router = useRouter();
  const pathname = usePathname();
  const supabase = createClient();

  useEffect(() => {
    const getProfile = async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) { router.push("/login"); return; }

        const { data, error } = await supabase
          .from("profiles")
          .select("full_name, role")
          .eq("id", user.id)
          .single();

        if (data) {
          setProfile(data);
        } else {
          // Profile doesn't exist — create one
          const name = user.user_metadata?.full_name || user.user_metadata?.name || user.email?.split("@")[0] || "User";
          const { error: insertErr } = await supabase.from("profiles").insert({
            id: user.id,
            full_name: name,
            role: "user",
          });
          if (!insertErr) {
            setProfile({ full_name: name, role: "user" });
          } else {
            // Insert failed — show with email as fallback
            setProfile({ full_name: user.email || "User", role: "user" });
          }
        }
      } catch {
        // Graceful fallback
        setProfile({ full_name: "User", role: "user" });
      }
    };
    getProfile();
  }, []);

  const handleLogout = async () => {
    await supabase.auth.signOut();
    router.push("/login");
  };

  const navItems = profile ? NAV_ITEMS[profile.role] || NAV_ITEMS.user : [];
  const isUser = profile?.role === "user";

  // Users get full-screen map, no sidebar
  if (isUser) {
    return <>{children}</>;
  }

  return (
    <div className="min-h-screen bg-background flex">
      {sidebarOpen && (
        <div className="fixed inset-0 bg-black/50 z-40 lg:hidden" onClick={() => setSidebarOpen(false)} />
      )}

      <aside className={cn(
        "fixed lg:static inset-y-0 left-0 z-50 w-64 bg-card border-r border-border flex flex-col transition-transform lg:translate-x-0",
        sidebarOpen ? "translate-x-0" : "-translate-x-full"
      )}>
        <div className="p-5 flex items-center gap-2 border-b border-border">
          <Shield className="w-7 h-7 text-primary" />
          <span className="text-lg font-bold">LifelineAI</span>
          <span className="ml-auto px-2 py-0.5 bg-primary/20 text-primary text-xs rounded capitalize">{profile?.role}</span>
        </div>

        <nav className="flex-1 p-3 space-y-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setSidebarOpen(false)}
                className={cn(
                  "flex items-center gap-3 px-4 py-2.5 rounded-lg transition-colors",
                  isActive ? "bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground hover:bg-background"
                )}
              >
                <Icon size={18} />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="p-4 border-t border-border">
          <div className="flex items-center justify-between">
            <div className="min-w-0">
              <p className="text-sm font-medium truncate">{profile?.full_name || "Loading..."}</p>
              <p className="text-xs text-muted-foreground capitalize">{profile?.role}</p>
            </div>
            <button onClick={handleLogout} className="p-2 text-muted-foreground hover:text-foreground rounded-lg hover:bg-background">
              <LogOut size={18} />
            </button>
          </div>
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <header className="lg:hidden p-4 bg-card border-b border-border flex items-center gap-4">
          <button onClick={() => setSidebarOpen(true)} className="text-muted-foreground hover:text-foreground">
            {sidebarOpen ? <X size={24} /> : <Menu size={24} />}
          </button>
          <div className="flex items-center gap-2">
            <Shield className="w-6 h-6 text-primary" />
            <span className="font-bold">LifelineAI</span>
          </div>
        </header>
        <main className="flex-1 p-6 overflow-auto">{children}</main>
      </div>
    </div>
  );
}

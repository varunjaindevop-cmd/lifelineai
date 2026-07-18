"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Shield } from "lucide-react";

export default function AuthCallbackPage() {
  const router = useRouter();
  const supabase = createClient();

  useEffect(() => {
    const handleCallback = async () => {
      const { data, error } = await supabase.auth.getSession();

      if (error || !data.session) {
        router.push("/login");
        return;
      }

      const user = data.session.user;

      const { data: profile } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", user.id)
        .single();

      if (!profile) {
        await supabase.from("profiles").insert({
          id: user.id,
          full_name: user.user_metadata?.full_name || user.user_metadata?.name || "User",
          role: "user",
        });
        router.push("/user");
      } else {
        const routeMap: Record<string, string> = {
          user: "/user",
          ambulance: "/ambulance",
          admin: "/admin",
          police: "/admin",
          hospital: "/hospital",
        };
        router.push(routeMap[profile.role] || "/user");
      }

      router.refresh();
    };

    handleCallback();
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="text-center space-y-4">
        <Shield className="w-10 h-10 text-primary mx-auto animate-pulse" />
        <p className="text-muted-foreground">Signing you in...</p>
      </div>
    </div>
  );
}

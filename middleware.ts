import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options?: any }[]) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const pathname = request.nextUrl.pathname;

  const publicRoutes = ["/login", "/register", "/", "/forgot-password", "/auth/callback"];
  if (publicRoutes.includes(pathname)) {
    if (user) {
      const role = await getRole(supabase, user.id);
      return NextResponse.redirect(new URL(`/${role}`, request.url));
    }
    return supabaseResponse;
  }

  if (!user) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  const role = await getRole(supabase, user.id);

  const roleDefaultPage: Record<string, string> = {
    user: "/user",
    ambulance: "/ambulance",
    admin: "/admin",
    police: "/admin",
    hospital: "/hospital",
  };

  const roleRoutes: Record<string, string[]> = {
    user: ["/user"],
    ambulance: ["/ambulance", "/incidents"],
    admin: ["/admin", "/cameras", "/incidents", "/map"],
    police: ["/admin", "/incidents", "/map"],
    hospital: ["/hospital", "/incidents"],
  };

  const allowedRoutes = roleRoutes[role] || ["/user"];
  const isAllowed = allowedRoutes.some((route) => pathname.startsWith(route));

  if (!isAllowed) {
    return NextResponse.redirect(new URL(roleDefaultPage[role] || "/user", request.url));
  }

  return supabaseResponse;
}

async function getRole(supabase: any, userId: string): Promise<string> {
  try {
    const { data, error } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", userId)
      .single();

    if (error || !data) {
      // Profile doesn't exist — check if user email matches known roles
      const { data: { user } } = await supabase.auth.getUser();
      const email = user?.email || "";

      // Create profile with default role
      await supabase.from("profiles").insert({
        id: userId,
        full_name: user?.user_metadata?.full_name || user?.user_metadata?.name || email.split("@")[0],
        role: "user",
      }).catch(() => {});

      return "user";
    }

    return data.role || "user";
  } catch {
    return "user";
  }
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};

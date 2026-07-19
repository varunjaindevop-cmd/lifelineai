import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Known admin/ambulance emails (fallback if profile query fails)
const ADMIN_EMAILS = ["varunjaindevop@gmail.com"];
const AMBULANCE_EMAILS = ["varunnnnjain@gmail.com"];

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
      const role = await getRole(supabase, user);
      return NextResponse.redirect(new URL(`/${role}`, request.url));
    }
    return supabaseResponse;
  }

  if (!user) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  const role = await getRole(supabase, user);

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

async function getRole(supabase: any, user: any): Promise<string> {
  const email = user.email || "";

  // Try to get role from profiles table
  try {
    const { data, error } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .maybeSingle();

    if (!error && data?.role) {
      return data.role;
    }
  } catch {}

  // Fallback: check known emails
  if (ADMIN_EMAILS.includes(email)) return "admin";
  if (AMBULANCE_EMAILS.includes(email)) return "ambulance";

  return "user";
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|mp4|webm|ogg)$).*)",
  ],
};

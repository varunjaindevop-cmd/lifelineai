import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDistance(km: number): string {
  if (km < 1) return `${Math.round(km * 1000)}m`;
  return `${km.toFixed(1)}km`;
}

export function formatTime(date: Date | string): string {
  return new Date(date).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function getSeverityColor(severity: string): string {
  const colors: Record<string, string> = {
    critical: "bg-severity-critical",
    major: "bg-severity-major",
    minor: "bg-severity-minor",
    suspicious: "bg-severity-suspicious",
  };
  return colors[severity] || "bg-muted";
}

export function getSeverityTextColor(severity: string): string {
  const colors: Record<string, string> = {
    critical: "text-severity-critical",
    major: "text-severity-major",
    minor: "text-severity-minor",
    suspicious: "text-severity-suspicious",
  };
  return colors[severity] || "text-muted-foreground";
}

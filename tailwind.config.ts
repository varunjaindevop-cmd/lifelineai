import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        background: "#0F172A",
        card: "#1E293B",
        border: "#334155",
        primary: {
          DEFAULT: "#3B82F6",
          foreground: "#F8FAFC",
        },
        destructive: {
          DEFAULT: "#EF4444",
          foreground: "#F8FAFC",
        },
        muted: {
          DEFAULT: "#64748B",
          foreground: "#94A3B8",
        },
        severity: {
          critical: "#EF4444",
          major: "#F97316",
          minor: "#EAB308",
          suspicious: "#8B5CF6",
        },
      },
      animation: {
        "pulse-slow": "pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        "alert-glow": "alert-glow 1s ease-in-out infinite alternate",
        "slide-in": "slide-in 0.3s ease-out",
      },
      keyframes: {
        "alert-glow": {
          "0%": { boxShadow: "0 0 5px rgba(239, 68, 68, 0.5)" },
          "100%": { boxShadow: "0 0 20px rgba(239, 68, 68, 0.8)" },
        },
        "slide-in": {
          "0%": { transform: "translateY(-100%)", opacity: "0" },
          "100%": { transform: "translateY(0)", opacity: "1" },
        },
      },
    },
  },
  plugins: [],
};
export default config;

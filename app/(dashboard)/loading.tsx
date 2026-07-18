import { Shield } from "lucide-react";

export default function Loading() {
  return (
    <div className="flex items-center justify-center h-64">
      <div className="text-center space-y-3">
        <Shield className="w-8 h-8 text-primary mx-auto animate-pulse" />
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    </div>
  );
}

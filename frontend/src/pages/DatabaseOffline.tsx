import { useState } from "react";
import { Database, RefreshCw, Phone, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function DatabaseOffline() {
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState(false);

  const retryConnection = async () => {
    setChecking(true);
    setChecked(false);
    await new Promise(r => setTimeout(r, 2000));
    setChecking(false);
    setChecked(true);
    window.location.reload();
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-6"
      style={{ background: "linear-gradient(135deg, #0f1923 0%, #1a2a3a 100%)" }}>
      <div className="max-w-lg w-full text-center">
        {/* Icon */}
        <div className="w-20 h-20 rounded-2xl flex items-center justify-center mx-auto mb-6"
          style={{ background: "rgba(239,68,68,0.15)", border: "1px solid rgba(239,68,68,0.3)" }}>
          <Database size={36} className="text-red-400" />
        </div>

        {/* Status Badge */}
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full mb-6"
          style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)" }}>
          <div className="w-2 h-2 rounded-full bg-red-500" />
          <span className="text-red-400 text-xs font-bold uppercase tracking-wide">Database Unavailable</span>
        </div>

        <h1 className="text-2xl font-black text-white mb-3">
          Database Server Offline
        </h1>
        <p className="text-white/50 text-sm leading-relaxed mb-8">
          Database server is currently unavailable. Data cannot be retrieved at the moment.
          Please contact the system administration team and refresh the application once the database server is available.
        </p>

        {/* Actions */}
        <div className="flex flex-col sm:flex-row gap-3 justify-center mb-8">
          <Button
            onClick={retryConnection}
            disabled={checking}
            className="gap-2"
            style={{ background: "linear-gradient(135deg, #3b82f6, #6366f1)", border: "none" }}
          >
            <RefreshCw size={16} className={checking ? "animate-spin" : ""} />
            {checking ? "Checking Connection…" : "Retry Connection"}
          </Button>
          <Button
            variant="outline"
            className="gap-2"
            style={{ border: "1px solid rgba(255,255,255,0.2)", color: "white", background: "transparent" }}
            onClick={() => window.location.href = "tel:+919876543210"}
          >
            <Phone size={16} />
            Contact Administrator
          </Button>
        </div>

        {checked && (
          <div className="flex items-center gap-2 justify-center text-red-400 text-xs mb-6">
            <AlertTriangle size={13} />
            Database still unreachable. Please contact IT support.
          </div>
        )}

        {/* System Info */}
        <div className="rounded-xl p-4 text-left text-xs space-y-2"
          style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}>
          <p className="font-bold text-white/50 uppercase tracking-wide text-[10px] mb-3">System Information</p>
          <div className="flex items-center justify-between text-white/40">
            <span>Application</span>
            <span className="font-medium text-white/70">UKTextiles HR & ERP</span>
          </div>
          <div className="flex items-center justify-between text-white/40">
            <span>Database</span>
            <span className="font-medium text-white/70">PostgreSQL (On-Premise)</span>
          </div>
          <div className="flex items-center justify-between text-white/40">
            <span>Status</span>
            <span className="font-medium text-red-400">Unreachable</span>
          </div>
          <div className="flex items-center justify-between text-white/40">
            <span>Checked at</span>
            <span className="font-medium text-white/70">{new Date().toLocaleTimeString("en-IN")}</span>
          </div>
        </div>

        <p className="text-white/20 text-xs mt-6">
          UKTextiles Enterprise Platform · On-Premise Infrastructure
        </p>
      </div>
    </div>
  );
}

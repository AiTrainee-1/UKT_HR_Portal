import { useLocation } from "wouter";
import { CheckCircle2, Loader2, RefreshCw, X } from "lucide-react";
import { useBiometricSync } from "@/contexts/BiometricSyncContext";

// Floating indicator that keeps the biometric sync visible while the user
// browses other pages. Hidden on the attendance pages themselves, since
// those already render the full inline BiometricSyncPipeline for the same
// shared state — this avoids showing the same progress twice.
export default function GlobalSyncBanner() {
  const [pathname] = useLocation();
  const { showPipeline, isSyncing, progress, dismiss } = useBiometricSync();

  if (!showPipeline || pathname.startsWith("/hr/attendance")) return null;

  const devices = progress?.devices ?? [];
  const completedCount = devices.filter(d => d.status === "completed" || d.status === "failed").length;
  const total = devices.length;

  return (
    <div className="fixed bottom-5 right-5 z-[100] w-80 rounded-2xl border border-cyan-100 bg-white/95 backdrop-blur-xl shadow-[0_16px_48px_-12px_rgba(15,40,80,0.35)] p-4 animate-in fade-in slide-in-from-bottom-4 duration-300">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          {isSyncing ? (
            <Loader2 size={15} className="text-cyan-600 animate-spin" />
          ) : (
            <CheckCircle2 size={15} className="text-green-600" />
          )}
          <p className="text-sm font-bold text-gray-800">
            {isSyncing ? "Syncing biometric devices…" : "Sync complete"}
          </p>
        </div>
        <button onClick={dismiss} className="p-1 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100" title="Dismiss">
          <X size={13} />
        </button>
      </div>

      {total > 0 && (
        <>
          <div className="h-1.5 w-full rounded-full bg-cyan-100/70 overflow-hidden mb-2">
            <div
              className="h-full rounded-full bg-gradient-to-r from-cyan-400 via-blue-500 to-indigo-500 transition-all duration-500 ease-out"
              style={{ width: `${Math.round((completedCount / total) * 100)}%` }}
            />
          </div>
          <p className="text-xs text-gray-500">
            {completedCount} / {total} devices done
            {!isSyncing && <span className="text-green-600 font-semibold"> — running in the background is finished</span>}
          </p>
          <div className="flex flex-wrap gap-1 mt-2">
            {devices.map(d => (
              <span
                key={d.id}
                className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full flex items-center gap-1 ${
                  d.status === "completed" ? "bg-green-100 text-green-700"
                  : d.status === "failed" ? "bg-red-100 text-red-700"
                  : d.status === "syncing" ? "bg-cyan-100 text-cyan-700"
                  : "bg-gray-100 text-gray-400"
                }`}
              >
                {d.status === "syncing" && <RefreshCw size={9} className="animate-spin" />}
                {d.label}
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

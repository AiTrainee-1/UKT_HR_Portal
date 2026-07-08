import { CheckCircle2, Loader2, PlayCircle, XCircle, X } from "lucide-react";
import type { SyncDeviceStatus, SyncProgress } from "@/lib/api-client/custom-hooks";

// Visual-only pipeline for the biometric sync flow: Start -> one node per
// configured device -> Completed. Purely reflects the `data` prop (sourced
// from BiometricSyncContext, which owns the actual polling) — this component
// never drives the sync itself.
export default function BiometricSyncPipeline({ active, data, onDismiss }: {
  active: boolean;
  data: SyncProgress | undefined;
  onDismiss: () => void;
}) {
  if (!active) return null;

  const devices = data?.devices ?? [];
  const overallDone = data?.stage === "completed";
  const completedCount = devices.filter(d => d.status === "completed" || d.status === "failed").length;
  const pct = devices.length > 0 ? Math.round((completedCount / devices.length) * 100) : 0;

  return (
    <div className="rounded-2xl border border-cyan-100 bg-gradient-to-br from-cyan-50/80 via-white to-blue-50/60 p-4 sm:p-5 shadow-sm animate-in fade-in slide-in-from-top-2 duration-300">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className={`relative flex h-2.5 w-2.5 ${overallDone ? "" : ""}`}>
            {!overallDone && (
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75" />
            )}
            <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${overallDone ? "bg-green-500" : "bg-cyan-500"}`} />
          </span>
          <p className="text-sm font-bold text-gray-800">
            {overallDone ? "Sync complete" : "Synchronizing biometric devices…"}
          </p>
        </div>
        <button onClick={onDismiss} className="p-1 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-white/70" title="Dismiss">
          <X size={14} />
        </button>
      </div>

      {/* Progress bar */}
      <div className="h-1.5 w-full rounded-full bg-cyan-100/70 overflow-hidden mb-4">
        <div
          className="h-full rounded-full bg-gradient-to-r from-cyan-400 via-blue-500 to-indigo-500 transition-all duration-500 ease-out"
          style={{ width: `${overallDone ? 100 : pct}%` }}
        />
      </div>

      {/* Pipeline nodes */}
      <div className="flex items-center overflow-x-auto pb-1 gap-0">
        <PipelineNode label="Start" state="completed" icon={<PlayCircle size={14} />} />
        {devices.map((d) => (
          <PipelineEdge key={`edge-${d.id}`} active={d.status === "completed"} />
        ))}
        {devices.map((d) => (
          <PipelineNode
            key={d.id}
            label={d.label}
            state={mapDeviceState(d.status)}
            icon={deviceIcon(d.status)}
          />
        ))}
        <PipelineEdge active={overallDone} />
        <PipelineNode
          label="Completed"
          state={overallDone ? "completed" : "waiting"}
          icon={overallDone ? <CheckCircle2 size={14} /> : <span className="w-2 h-2 rounded-full bg-slate-300 inline-block" />}
        />
      </div>
    </div>
  );
}

type NodeState = "completed" | "active" | "failed" | "waiting";

function mapDeviceState(status: SyncDeviceStatus): NodeState {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "syncing") return "active";
  return "waiting";
}

function deviceIcon(status: SyncDeviceStatus) {
  if (status === "completed") return <CheckCircle2 size={14} />;
  if (status === "failed") return <XCircle size={14} />;
  if (status === "syncing") return <Loader2 size={14} className="animate-spin" />;
  return <span className="w-2 h-2 rounded-full bg-slate-300 inline-block" />;
}

function PipelineNode({ label, state, icon }: { label: string; state: NodeState; icon: React.ReactNode }) {
  const styles: Record<NodeState, { bg: string; text: string; border: string; ring?: string }> = {
    completed: { bg: "#059669", text: "white", border: "#059669" },
    active:    { bg: "#0891b2", text: "white", border: "#0891b2", ring: "ring-4 ring-cyan-200 animate-pulse" },
    failed:    { bg: "#dc2626", text: "white", border: "#dc2626" },
    waiting:   { bg: "#f0f4f8", text: "#94a3b8", border: "#cbd5e1" },
  };
  const s = styles[state];
  return (
    <div className="flex flex-col items-center gap-1 shrink-0 w-16">
      <div
        className={`flex items-center justify-center w-8 h-8 rounded-full transition-all duration-300 ${s.ring ?? ""} ${state === "completed" ? "scale-105" : ""}`}
        style={{ background: s.bg, color: s.text, border: `2px solid ${s.border}` }}
      >
        {icon}
      </div>
      <span
        className="text-[9.5px] font-semibold text-center leading-tight truncate w-full"
        style={{ color: state === "waiting" ? "#94a3b8" : s.border }}
        title={label}
      >
        {label}
      </span>
    </div>
  );
}

function PipelineEdge({ active }: { active: boolean }) {
  return (
    <div className="flex-1 min-w-[16px] h-0.5 mb-[18px] relative overflow-hidden rounded-full bg-slate-200">
      <div
        className={`absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-cyan-400 to-emerald-500 transition-all duration-500 ease-out ${active ? "w-full" : "w-0"}`}
      />
    </div>
  );
}

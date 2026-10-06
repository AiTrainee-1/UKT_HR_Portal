import { Activity, AlertTriangle, CheckCircle2, Fingerprint, Network, XCircle } from "lucide-react";
import type { DeviceStatusPayload } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { TONE_CLASSES, type StatusFilter, type Tone } from "./logic";

type Card = {
  filter: StatusFilter;
  label: string;
  value: number;
  hint: string;
  tone: Tone;
  icon: typeof Fingerprint;
};

/** The headline numbers. Each one is also a filter for the device list below. */
export default function SummaryCards({
  summary,
  active,
  onPick,
}: {
  summary: DeviceStatusPayload["summary"];
  active: StatusFilter;
  onPick: (filter: StatusFilter) => void;
}) {
  const cards: Card[] = [
    {
      filter: "all",
      label: "Devices configured",
      value: summary.configured,
      hint: `${summary.enabled} switched on`,
      tone: "muted",
      icon: Fingerprint,
    },
    {
      filter: "connected",
      label: "Connected",
      value: summary.connected,
      hint: "sending to the server now",
      tone: "good",
      icon: CheckCircle2,
    },
    {
      filter: "disconnected",
      label: "Disconnected",
      value: summary.disconnected,
      hint: summary.neverConnected > 0 ? `${summary.neverConnected} never connected` : "silent right now",
      tone: "bad",
      icon: XCircle,
    },
    {
      filter: "error",
      label: "Errors",
      value: summary.error,
      hint: "a problem was recorded",
      tone: "warn",
      icon: AlertTriangle,
    },
    {
      filter: "unreachable",
      label: "Unreachable",
      value: summary.unreachable,
      hint: "server cannot reach them",
      tone: "info",
      icon: Network,
    },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6" data-testid="device-summary">
      {cards.map((c) => {
        const Icon = c.icon;
        const selected = active === c.filter;
        const tone = TONE_CLASSES[c.tone];
        return (
          <button
            key={c.filter}
            type="button"
            onClick={() => onPick(selected && c.filter !== "all" ? "all" : c.filter)}
            aria-pressed={selected}
            data-testid={`device-summary-${c.filter}`}
            className={cn(
              "clay-card rounded-2xl p-4 text-left transition-all hover:-translate-y-0.5",
              selected && `ring-2 ${tone.ring}`,
            )}
          >
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-bold uppercase tracking-wide text-slate-400">{c.label}</span>
              <span className={cn("rounded-lg p-1.5", tone.chip)}>
                <Icon size={14} />
              </span>
            </div>
            <p
              className={cn(
                "mt-2 text-3xl font-black leading-none",
                c.value > 0 || c.filter === "all" ? tone.text : "text-slate-300",
              )}
            >
              {c.value}
            </p>
            <p className="mt-1.5 text-[11px] text-slate-500">{c.hint}</p>
          </button>
        );
      })}
      <div className="clay-card rounded-2xl p-4" data-testid="device-summary-punches">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-bold uppercase tracking-wide text-slate-400">Punches today</span>
          <span className={cn("rounded-lg p-1.5", TONE_CLASSES.busy.chip)}>
            <Activity size={14} />
          </span>
        </div>
        <p className="mt-2 text-3xl font-black leading-none text-sky-700">{summary.punchesToday}</p>
        <p className="mt-1.5 text-[11px] text-slate-500">received from devices</p>
      </div>
    </div>
  );
}

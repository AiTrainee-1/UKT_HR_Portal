import { useState, type ReactNode } from "react";
import { Check, CheckCircle2, Copy, HelpCircle, Loader2, MinusCircle, AlertTriangle, XCircle } from "lucide-react";
import type { DeviceReach, DeviceStatusState, LayerState } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { LAYER_STATE_LABEL, LAYER_TONE, REACH_TONE, STATUS_TONE, TONE_CLASSES, type Tone } from "./logic";

const STATUS_ICON: Record<DeviceStatusState, typeof CheckCircle2> = {
  connected: CheckCircle2,
  disconnected: XCircle,
  error: AlertTriangle,
  disabled: MinusCircle,
};

export function TonePill({ tone, children, className }: { tone: Tone; children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold whitespace-nowrap",
        TONE_CLASSES[tone].chip,
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Connected / Disconnected / Error / Disabled: what the server sees of the device. While a check is running the
 *  device shows Pinging instead. */
export function StatusChip({
  status,
  label,
  pinging,
}: {
  status: DeviceStatusState;
  label: string;
  pinging?: boolean;
}) {
  if (pinging) {
    return (
      <TonePill tone="busy" className="animate-pulse">
        <Loader2 size={11} className="animate-spin" /> Pinging…
      </TonePill>
    );
  }
  const Icon = STATUS_ICON[status];
  return (
    <TonePill tone={STATUS_TONE[status]}>
      <Icon size={11} /> {label}
    </TonePill>
  );
}

/** Reachable / Unreachable / Port closed / Not checked: what this server can reach. */
export function ReachChip({ reach, label }: { reach: DeviceReach; label: string }) {
  return (
    <TonePill tone={REACH_TONE[reach]}>
      <span className={cn("h-1.5 w-1.5 rounded-full", TONE_CLASSES[REACH_TONE[reach]].dot)} />
      {label}
    </TonePill>
  );
}

const LAYER_ICON: Record<LayerState, typeof CheckCircle2> = {
  ok: CheckCircle2,
  warn: AlertTriangle,
  problem: XCircle,
  unknown: HelpCircle,
  na: MinusCircle,
};

export function LayerStateBadge({ state }: { state: LayerState }) {
  const Icon = LAYER_ICON[state];
  return (
    <TonePill tone={LAYER_TONE[state]}>
      <Icon size={11} /> {LAYER_STATE_LABEL[state]}
    </TonePill>
  );
}

/** A small labelled figure on a device card. */
export function Tile({
  label,
  value,
  sub,
  tone = "muted",
  testId,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: Tone;
  testId?: string;
}) {
  return (
    <div className="rounded-xl bg-slate-50/80 px-3 py-2.5 min-w-0" data-testid={testId}>
      <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400">{label}</p>
      <p
        className={cn(
          "mt-0.5 text-sm font-black leading-tight truncate",
          tone === "muted" ? "text-slate-700" : TONE_CLASSES[tone].text,
        )}
      >
        {value}
      </p>
      {sub != null && <p className="mt-0.5 text-[11px] leading-snug text-slate-500">{sub}</p>}
    </div>
  );
}

/** Copy a value (an address the devices must be set to) with a moment of confirmation. */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={`Copy ${label}`}
      title={`Copy ${label}`}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          },
          () => undefined,
        );
      }}
      className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
    >
      {copied ? <Check size={13} className="text-emerald-600" /> : <Copy size={13} />}
    </button>
  );
}

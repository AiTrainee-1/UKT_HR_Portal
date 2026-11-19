// The pieces of the gate monitor console: the top bar's clock / connection / scanner / voice, the scan card, the big
// result banner, today's counters and the latest scans. Flat cards (a 1px border, no shadow, no gradient, no blur) so the
// Clean theme has nothing to undo; touch targets are at least 44 px.

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Coffee,
  DoorOpen,
  History,
  Keyboard,
  LogIn,
  MapPin,
  ScanLine,
  ShieldCheck,
  ShieldX,
  Usb,
  UserCheck,
  Volume2,
  VolumeX,
  WifiOff,
  XCircle,
} from "lucide-react";
import type { GateMonitorRecord, GateMonitorSummary, GateScanResult } from "@/lib/api-client/custom-hooks/gate-monitor";
import { cn } from "@/lib/utils";
import { PersonCell } from "@/pages/hr/outpass-visitors/kit/PersonCell";
import { StatTile } from "@/pages/hr/outpass-visitors/kit/StatTile";
import { StatusChip } from "@/pages/hr/outpass-visitors/kit/StatusChip";
import { fmtDateTime, fmtTime, fmtWhen } from "@/pages/hr/outpass-visitors/kit/fmt";
import { describeScan, formatApprover, recordTypeShort, type ScanTone } from "./scan-result";
import { setVoiceEnabled, voiceEnabled, type ScannerStatus } from "./scanner";

export const CARD = "rounded-2xl border border-slate-200 bg-white";

// ── top bar ──────────────────────────────────────────────────────────────────────────────────────────────────────

export function LiveClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 5_000);
    return () => clearInterval(id);
  }, []);
  return (
    <span
      className="inline-flex h-11 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold tabular-nums text-slate-800"
      title={fmtDateTime(now, { year: true })}
      data-testid="gate-clock"
    >
      <Clock3 size={15} className="text-slate-500" aria-hidden="true" />
      <time dateTime={now.toISOString()}>{fmtTime(now)}</time>
    </span>
  );
}

export function ConnectionDot({ online }: { online: boolean }) {
  return (
    <span
      role="status"
      className={cn(
        "inline-flex h-11 items-center gap-2 rounded-lg border px-3 text-xs font-semibold",
        online ? "border-teal-200 bg-teal-50 text-teal-800" : "border-rose-200 bg-rose-50 text-rose-700",
      )}
      data-testid="gate-connection"
      data-online={online ? "yes" : "no"}
    >
      {online ? (
        <span className="size-2 rounded-full bg-teal-500" aria-hidden="true" />
      ) : (
        <WifiOff size={14} aria-hidden="true" />
      )}
      {online ? "Connected" : "No connection"}
    </span>
  );
}

export function ScannerBadge({ status, onPair }: { status: ScannerStatus; onPair: () => void }) {
  const base = "hidden h-11 items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold sm:inline-flex";
  if (status === "connected") {
    return (
      <span className={cn(base, "border-teal-200 bg-teal-50 text-teal-800")} data-testid="scanner-badge">
        <Usb size={14} aria-hidden="true" /> Scanner connected
      </span>
    );
  }
  if (status === "disconnected") {
    return (
      <button
        type="button"
        onClick={onPair}
        className={cn(base, "border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100")}
        title="Pair a scanner. Some scanners are not listed here (they look like a keyboard) and still scan fine."
        data-testid="scanner-badge"
      >
        <Usb size={14} aria-hidden="true" /> Pair scanner
      </button>
    );
  }
  return (
    <span className={cn(base, "border-slate-200 bg-white text-slate-600")} data-testid="scanner-badge">
      <ScanLine size={14} aria-hidden="true" /> Scanner ready
    </span>
  );
}

export function VoiceToggle() {
  const [on, setOn] = useState(voiceEnabled);
  const toggle = () => {
    setVoiceEnabled(!on);
    setOn(!on);
  };
  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={on}
      aria-label={on ? "Voice on. Turn the voice off" : "Voice off. Turn the voice on"}
      title={on ? "Voice on" : "Voice off"}
      className="inline-flex size-11 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
      data-testid="voice-toggle"
    >
      {on ? <Volume2 size={17} aria-hidden="true" /> : <VolumeX size={17} aria-hidden="true" />}
    </button>
  );
}

// ── scan card ────────────────────────────────────────────────────────────────────────────────────────────────────

const ZONE_TONE: Record<ScanTone | "idle" | "busy", string> = {
  idle: "border-slate-300 bg-slate-50 text-slate-700",
  busy: "border-primary/50 bg-primary/5 text-slate-800",
  teal: "border-teal-400 bg-teal-50 text-teal-800",
  amber: "border-amber-400 bg-amber-50 text-amber-800",
  rose: "border-rose-400 bg-rose-50 text-rose-700",
  slate: "border-slate-400 bg-slate-100 text-slate-700",
};

export function takesLabel(allowOutpass: boolean, allowTeaBreak: boolean): string {
  if (allowOutpass && allowTeaBreak) return "Gate passes and tea breaks";
  if (allowOutpass) return "Gate passes only";
  if (allowTeaBreak) return "Tea breaks only";
  return "Nothing is set up to scan here";
}

export function ScanCard({
  flash,
  busy,
  takes,
  onSubmitCode,
}: {
  /** The tone of the last answer for a moment after a scan, else idle. */
  flash: ScanTone | "idle";
  busy: boolean;
  /** What this gate takes: "Gate passes and tea breaks". */
  takes: string;
  onSubmitCode: (code: string) => void;
}) {
  const [code, setCode] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const value = code.trim();
    if (!value || busy) return;
    onSubmitCode(value);
    setCode("");
  };
  const tone = busy ? "busy" : flash;
  return (
    <section aria-labelledby="gate-scan-title" className={cn(CARD, "p-4 sm:p-5")} data-testid="scan-card">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <ScanLine size={20} className="text-primary" aria-hidden="true" />
        <h2 id="gate-scan-title" className="text-lg font-bold text-slate-900">
          Scan a pass
        </h2>
        <span className="ml-auto rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs font-medium text-slate-600">
          {takes}
        </span>
      </div>
      <div
        className={cn(
          "mt-4 flex min-h-[150px] flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-6 text-center transition-colors",
          ZONE_TONE[tone],
        )}
        data-testid="scan-zone"
        data-state={tone}
      >
        <span className="flex size-12 items-center justify-center rounded-full border border-current/20 bg-white">
          {tone === "teal" ? (
            <CheckCircle2 size={24} aria-hidden="true" />
          ) : tone === "rose" ? (
            <XCircle size={24} aria-hidden="true" />
          ) : tone === "amber" ? (
            <Coffee size={24} aria-hidden="true" />
          ) : (
            <ScanLine size={24} aria-hidden="true" className={tone === "busy" ? "animate-pulse" : undefined} />
          )}
        </span>
        <p className="text-base font-semibold">
          {busy ? "Checking the code…" : "Ready - scan a gate pass or tea-break QR"}
        </p>
        <p className="text-sm opacity-80">Hold the QR code under the scanner. The result shows below.</p>
      </div>
      <form onSubmit={submit} className="mt-4 flex gap-2" data-testid="code-form">
        <label htmlFor="gate-code" className="sr-only">
          Type the pass code
        </label>
        <div className="relative min-w-0 flex-1">
          <Keyboard
            size={17}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
            aria-hidden="true"
          />
          <input
            id="gate-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="Or type the pass code"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            className="h-12 w-full min-w-0 rounded-lg border border-slate-200 bg-white pl-10 pr-3 font-mono text-base text-slate-900 outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring/50"
            data-testid="code-input"
          />
        </div>
        <button
          type="submit"
          disabled={busy || !code.trim()}
          className="h-12 shrink-0 rounded-lg bg-primary px-5 text-base font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-60"
          data-testid="code-check"
        >
          Check
        </button>
      </form>
    </section>
  );
}

// ── result banner ────────────────────────────────────────────────────────────────────────────────────────────────

const BANNER_TONE: Record<ScanTone, { box: string; title: string; icon: typeof CheckCircle2 }> = {
  teal: { box: "border-teal-300 bg-teal-50", title: "text-teal-800", icon: ShieldCheck },
  amber: { box: "border-amber-300 bg-amber-50", title: "text-amber-800", icon: Coffee },
  rose: { box: "border-rose-300 bg-rose-50", title: "text-rose-700", icon: ShieldX },
  slate: { box: "border-slate-300 bg-slate-50", title: "text-slate-800", icon: AlertTriangle },
};

function Field({ icon: Icon, label, children }: { icon?: typeof MapPin; label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 rounded-lg border border-white bg-white/80 px-3 py-2">
      <p className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        {Icon && <Icon size={12} aria-hidden="true" />}
        {label}
      </p>
      <p className="mt-0.5 truncate text-sm font-semibold text-slate-900">{children}</p>
    </div>
  );
}

export function ResultBanner({
  result,
  at,
  onDone,
}: {
  result: GateScanResult | null;
  /** When the scan was answered. */
  at: Date | null;
  onDone: () => void;
}) {
  if (!result) {
    return (
      <section
        className="flex min-h-[120px] flex-col items-center justify-center gap-1 rounded-2xl border-2 border-dashed border-slate-200 px-4 py-8 text-center text-slate-500"
        aria-live="polite"
        data-testid="scan-result-empty"
      >
        <ScanLine size={22} aria-hidden="true" />
        <p className="text-sm">The result of the next scan shows here.</p>
      </section>
    );
  }
  const view = describeScan(result);
  const tone = BANNER_TONE[view.tone];
  const Icon = tone.icon;
  const emp = result.employee;
  const approver = formatApprover(result.approverRole, result.approvedBy);
  const details: { key: string; icon?: typeof MapPin; label: string; value: ReactNode }[] = [];
  if (result.destination) details.push({ key: "dest", icon: MapPin, label: "Destination", value: result.destination });
  if (result.reason) details.push({ key: "reason", label: "Reason", value: result.reason });
  if (approver) details.push({ key: "appr", icon: UserCheck, label: "Approved by", value: approver });
  if (result.expiresAt && !result.exitedAt) {
    details.push({ key: "exp", icon: Clock3, label: "Valid till", value: fmtDateTime(result.expiresAt) });
  }
  if (result.exitedAt) {
    const where = result.gateName ? ` · ${result.gateName}` : "";
    details.push({ key: "out", icon: DoorOpen, label: "Went out", value: `${fmtDateTime(result.exitedAt)}${where}` });
  }
  if (result.enteredAt) {
    const where = result.entryGateName ? ` · ${result.entryGateName}` : "";
    details.push({ key: "in", icon: LogIn, label: "Came back", value: `${fmtDateTime(result.enteredAt)}${where}` });
  }
  return (
    <section
      className={cn("rounded-2xl border-2 p-4 sm:p-5", tone.box)}
      aria-live="assertive"
      data-testid="scan-result"
      data-result={result.result}
      data-tone={view.tone}
    >
      <div className="flex flex-wrap items-start gap-3">
        <Icon size={28} className={cn("mt-0.5 shrink-0", tone.title)} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className={cn("text-xl font-bold leading-tight sm:text-2xl", tone.title)} data-testid="scan-result-title">
            {view.title}
          </p>
          <p className="mt-1 text-sm text-slate-700" data-testid="scan-result-message">
            {result.message}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {view.kindLabel && (
            <span className="rounded-md border border-slate-200 bg-white px-2 py-0.5 text-xs font-bold uppercase tracking-wide text-slate-700">
              {view.kindLabel}
            </span>
          )}
          {at && <span className="text-xs tabular-nums text-slate-500">at {fmtTime(at)}</span>}
        </div>
      </div>
      {emp && (
        <div className="mt-4 flex min-w-0 items-center gap-3 rounded-xl bg-white/80 p-3">
          <PersonCell name={emp.name} code={emp.employeeCode} sub={emp.department} photoUrl={emp.photoUrl} size={64} />
        </div>
      )}
      {details.length > 0 && (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {details.map((d) => (
            <Field key={d.key} icon={d.icon} label={d.label}>
              {d.value}
            </Field>
          ))}
        </div>
      )}
      <button
        type="button"
        onClick={onDone}
        className="mt-4 inline-flex h-11 items-center rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50"
        data-testid="scan-result-done"
      >
        Done
      </button>
    </section>
  );
}

// ── today at this gate ───────────────────────────────────────────────────────────────────────────────────────────

export function TodayCounters({ summary, loading }: { summary: GateMonitorSummary | undefined; loading: boolean }) {
  const denied = summary?.denied ?? 0;
  return (
    <div className="grid grid-cols-2 gap-2" data-testid="today-counters">
      <StatTile
        label="Exits"
        value={summary?.exits}
        icon={DoorOpen}
        tone="teal"
        loading={loading}
        testId="today-exits"
      />
      <StatTile
        label="Returns"
        value={summary?.returns}
        icon={LogIn}
        tone="teal"
        loading={loading}
        testId="today-returns"
      />
      <StatTile
        label="Tea breaks"
        value={summary?.teaOut}
        icon={Coffee}
        tone="amber"
        loading={loading}
        testId="today-tea"
        hint={summary && summary.teaOutNow > 0 ? `${summary.teaOutNow} on break` : undefined}
      />
      <StatTile
        label="Denied"
        value={summary?.denied}
        icon={ShieldX}
        tone="rose"
        emphasis={denied > 0}
        loading={loading}
        testId="today-denied"
      />
    </div>
  );
}

// ── latest scans ─────────────────────────────────────────────────────────────────────────────────────────────────

const TYPE_CHIP: Record<string, string> = {
  exit: "border-sky-200 bg-sky-50 text-sky-800",
  return: "border-indigo-200 bg-indigo-50 text-indigo-700",
  tea_out: "border-amber-200 bg-amber-50 text-amber-800",
  tea_in: "border-amber-200 bg-amber-50 text-amber-800",
};

export function LatestScans({
  rows,
  loading,
  error,
  onSeeAll,
}: {
  rows: GateMonitorRecord[] | undefined;
  loading: boolean;
  error: string | null;
  onSeeAll: () => void;
}) {
  return (
    <section aria-labelledby="gate-latest-title" className={cn(CARD, "p-4")} data-testid="latest-scans">
      <div className="flex items-center gap-2">
        <History size={18} className="text-primary" aria-hidden="true" />
        <h2 id="gate-latest-title" className="text-base font-bold text-slate-900">
          Latest scans
        </h2>
        <button
          type="button"
          onClick={onSeeAll}
          className="ml-auto inline-flex h-11 items-center rounded-lg px-2 text-sm font-semibold text-primary hover:bg-primary/10"
        >
          See all records
        </button>
      </div>
      {error ? (
        <p className="mt-3 text-sm text-rose-700">{error}</p>
      ) : loading && !rows ? (
        <p className="mt-3 text-sm text-slate-500">Loading…</p>
      ) : !rows || rows.length === 0 ? (
        <p className="mt-3 rounded-lg border border-dashed border-slate-200 px-3 py-6 text-center text-sm text-slate-500">
          Nothing scanned at this gate today yet.
        </p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {rows.map((r) => {
            const { time } = fmtWhen(r.at);
            const denied = r.result === "denied";
            const detail = denied ? r.reasonLabel || r.message : r.destination || r.message;
            return (
              <li
                key={r.id}
                className="flex min-w-0 items-center gap-3 rounded-xl border border-slate-100 bg-slate-50 px-3 py-2"
                data-testid="latest-row"
              >
                <span className="w-12 shrink-0 text-sm font-semibold tabular-nums text-slate-700">{time}</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-slate-900" title={r.employee?.name ?? undefined}>
                    {r.employee?.name ?? "Unknown code"}
                    {r.employee?.employeeCode && (
                      <span className="ml-1.5 font-mono text-xs font-normal text-slate-500">
                        {r.employee.employeeCode}
                      </span>
                    )}
                  </p>
                  <p className="flex min-w-0 items-center gap-1.5 text-xs text-slate-600">
                    <span
                      className={cn(
                        "shrink-0 rounded border px-1.5 py-px text-[11px] font-semibold",
                        TYPE_CHIP[r.type] ?? "border-slate-200 bg-white text-slate-600",
                      )}
                    >
                      {recordTypeShort(r)}
                    </span>
                    <span className="truncate" title={detail ?? undefined}>
                      {detail}
                    </span>
                  </p>
                </div>
                <StatusChip tone={denied ? "rose" : "teal"}>{denied ? "Denied" : "Allowed"}</StatusChip>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

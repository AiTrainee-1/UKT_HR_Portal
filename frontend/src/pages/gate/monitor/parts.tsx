// The pieces of the gate monitor console around the scanner: the top bar's clock / connection / scanner / voice, today's
// counters, the latest scans and the person block. Drawn for the kiosk's deep slate page (gate-kiosk.css): quiet glass
// panels, light words, colour only where it means something. Touch targets are at least 44 px.

import { useEffect, useState, type ReactNode } from "react";
import {
  CheckCircle2,
  Clock3,
  Coffee,
  DoorOpen,
  History,
  LogIn,
  ScanLine,
  ShieldX,
  Usb,
  Volume2,
  VolumeX,
  WifiOff,
} from "lucide-react";
import type { GateMonitorRecord, GateMonitorSummary } from "@/lib/api-client/custom-hooks/gate-monitor";
import { initials } from "@/components/payroll/kit/format";
import { cn } from "@/lib/utils";
import { fmtCount, fmtDate, fmtDateTime, fmtTime, fmtWhen, NONE } from "@/pages/hr/outpass-visitors/kit/fmt";
import { recordTypeShort } from "./scan-result";
import { setVoiceEnabled, voiceEnabled, type ScannerStatus } from "./scanner";

/** A light card (the Gate records sheet). */
export const CARD = "rounded-2xl border border-slate-200 bg-white";
/** A glass panel on the kiosk's dark page. */
export const PANEL = "gk-panel";
/** A pill of the top bar: 44 px high, quiet on the dark page. */
export const PILL =
  "inline-flex h-11 items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-3 text-sm font-semibold " +
  "text-slate-200 outline-none focus-visible:ring-2 focus-visible:ring-sky-300/70";

// ── top bar ──────────────────────────────────────────────────────────────────────────────────────────────────────

export function LiveClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 5_000);
    return () => clearInterval(id);
  }, []);
  return (
    <span className={cn(PILL, "tabular-nums")} title={fmtDateTime(now, { year: true })} data-testid="gate-clock">
      <Clock3 size={15} className="text-slate-400" aria-hidden="true" />
      <time dateTime={now.toISOString()} className="text-base font-bold text-white">
        {fmtTime(now)}
      </time>
      <span className="hidden text-xs font-medium text-slate-400 md:inline">{fmtDate(now)}</span>
    </span>
  );
}

export function ConnectionDot({ online }: { online: boolean }) {
  return (
    <span
      role="status"
      className={cn(
        PILL,
        "text-xs",
        online ? "border-emerald-400/25 text-emerald-200" : "border-rose-400/35 bg-rose-500/10 text-rose-200",
      )}
      data-testid="gate-connection"
      data-online={online ? "yes" : "no"}
    >
      {online ? (
        <span className="gk-live-dot size-2 rounded-full bg-emerald-400 text-emerald-400" aria-hidden="true" />
      ) : (
        <WifiOff size={14} aria-hidden="true" />
      )}
      {online ? "Connected" : "No connection"}
    </span>
  );
}

export function ScannerBadge({ status, onPair }: { status: ScannerStatus; onPair: () => void }) {
  const base = cn(PILL, "hidden text-xs sm:inline-flex");
  if (status === "connected") {
    return (
      <span className={cn(base, "border-emerald-400/25 text-emerald-200")} data-testid="scanner-badge">
        <Usb size={14} aria-hidden="true" /> Scanner connected
      </span>
    );
  }
  if (status === "disconnected") {
    return (
      <button
        type="button"
        onClick={onPair}
        className={cn(base, "hover:bg-white/[0.09] hover:text-white")}
        title="Pair a scanner. Some scanners are not listed here (they look like a keyboard) and still scan fine."
        data-testid="scanner-badge"
      >
        <Usb size={14} aria-hidden="true" /> Pair scanner
      </button>
    );
  }
  return (
    <span className={base} data-testid="scanner-badge">
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
      className={cn(
        PILL,
        "gk-voice w-11 justify-center px-0 hover:bg-white/[0.09] hover:text-white",
        !on && "text-slate-400",
      )}
      data-testid="voice-toggle"
    >
      {on ? <Volume2 size={17} aria-hidden="true" /> : <VolumeX size={17} aria-hidden="true" />}
    </button>
  );
}

export function takesLabel(allowOutpass: boolean, allowTeaBreak: boolean): string {
  if (allowOutpass && allowTeaBreak) return "Gate passes and tea breaks";
  if (allowOutpass) return "Gate passes only";
  if (allowTeaBreak) return "Tea breaks only";
  return "Nothing is set up to scan here";
}

// ── a person on the dark page ────────────────────────────────────────────────────────────────────────────────────

/** The photo (or the initials when there is none or it does not load), the name, the code and the department. */
export function KioskPerson({
  name,
  code,
  sub,
  photoUrl,
  size = 72,
}: {
  name: string | null | undefined;
  code?: string | null;
  sub?: string | null;
  photoUrl?: string | null;
  size?: number;
}) {
  const [broken, setBroken] = useState<string | null>(null);
  const showPhoto = !!photoUrl && broken !== photoUrl;
  const label = name?.trim() || "Unknown";
  return (
    <div className="flex min-w-0 items-center gap-4">
      {showPhoto ? (
        <img
          src={photoUrl!}
          alt=""
          onError={() => setBroken(photoUrl!)}
          className="shrink-0 rounded-2xl border border-white/[0.15] bg-slate-800 object-cover"
          style={{ width: size, height: size }}
        />
      ) : (
        <span
          className="inline-flex shrink-0 items-center justify-center rounded-2xl border border-white/10 bg-slate-800 text-xl font-bold text-slate-200"
          style={{ width: size, height: size }}
          aria-hidden="true"
        >
          {initials(label)}
        </span>
      )}
      <div className="min-w-0 leading-tight">
        <p className="truncate text-lg font-bold text-white sm:text-xl" title={label}>
          {label}
        </p>
        {(code || sub) && (
          <p className="mt-1 truncate text-sm text-slate-400" title={[code, sub].filter(Boolean).join(" · ")}>
            {code && <span className="font-mono text-slate-300">{code}</span>}
            {code && sub ? " · " : ""}
            {sub}
          </p>
        )}
      </div>
    </div>
  );
}

// ── today at this gate ───────────────────────────────────────────────────────────────────────────────────────────

type StatTone = "green" | "return" | "red";

function KioskStat({
  label,
  value,
  icon: Icon,
  tone,
  loading,
  emphasis = false,
  hint,
  testId,
}: {
  label: string;
  value: number | undefined;
  icon: typeof DoorOpen;
  tone: StatTone;
  loading: boolean;
  emphasis?: boolean;
  hint?: ReactNode;
  testId: string;
}) {
  return (
    <div
      className={cn(
        "min-w-0 rounded-2xl border bg-white/[0.03] p-3 sm:p-4",
        emphasis ? "border-red-400/35" : "border-white/[0.07]",
      )}
      data-testid={testId}
    >
      <div className="flex items-start justify-between gap-2">
        <p
          className="min-w-0 truncate text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400"
          data-testid={`${testId}-label`}
        >
          {label}
        </p>
        <span
          className="gk-tone-tile inline-flex size-8 shrink-0 items-center justify-center rounded-xl"
          data-gk-tone={tone}
          aria-hidden="true"
        >
          <Icon size={16} />
        </span>
      </div>
      <p
        className={cn(
          "mt-1 text-3xl font-bold leading-none tabular-nums sm:text-[2rem]",
          emphasis ? "text-red-300" : "text-white",
        )}
        data-testid={`${testId}-value`}
      >
        {loading && value === undefined ? (
          <span className="inline-block h-7 w-12 animate-pulse rounded-md bg-white/10" aria-label="Loading" />
        ) : value === undefined ? (
          NONE
        ) : (
          fmtCount(value)
        )}
      </p>
      {hint && <p className="mt-1.5 truncate text-xs font-medium text-slate-400">{hint}</p>}
    </div>
  );
}

export function TodayCounters({ summary, loading }: { summary: GateMonitorSummary | undefined; loading: boolean }) {
  const denied = summary?.denied ?? 0;
  return (
    <div className="grid grid-cols-2 gap-2.5" data-testid="today-counters">
      <KioskStat
        label="Exits"
        value={summary?.exits}
        icon={DoorOpen}
        tone="green"
        loading={loading}
        testId="today-exits"
      />
      <KioskStat
        label="Returns"
        value={summary?.returns}
        icon={LogIn}
        tone="green"
        loading={loading}
        testId="today-returns"
      />
      <KioskStat
        label="Tea breaks"
        value={summary?.teaOut}
        icon={Coffee}
        tone="return"
        loading={loading}
        testId="today-tea"
        hint={summary && summary.teaOutNow > 0 ? `${summary.teaOutNow} on break now` : undefined}
      />
      <KioskStat
        label="Denied"
        value={summary?.denied}
        icon={ShieldX}
        tone="red"
        emphasis={denied > 0}
        loading={loading}
        testId="today-denied"
      />
    </div>
  );
}

// ── latest scans ─────────────────────────────────────────────────────────────────────────────────────────────────

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
    <section aria-labelledby="gate-latest-title" className={cn(PANEL, "p-4 sm:p-5")} data-testid="latest-scans">
      <div className="flex items-center gap-2">
        <History size={18} className="text-sky-300" aria-hidden="true" />
        <h2 id="gate-latest-title" className="text-base font-bold text-white">
          Latest scans
        </h2>
        <button
          type="button"
          onClick={onSeeAll}
          className="ml-auto inline-flex h-11 items-center rounded-xl px-3 text-sm font-semibold text-sky-300 outline-none hover:bg-white/[0.06] hover:text-sky-200 focus-visible:ring-2 focus-visible:ring-sky-300/70"
        >
          See all records
        </button>
      </div>
      {error ? (
        <p className="mt-3 text-sm text-rose-300">{error}</p>
      ) : loading && !rows ? (
        <p className="mt-3 text-sm text-slate-400">Loading…</p>
      ) : !rows || rows.length === 0 ? (
        <p className="mt-3 rounded-2xl border border-dashed border-white/10 px-3 py-6 text-center text-sm text-slate-400">
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
                className="flex min-w-0 items-center gap-3 rounded-2xl border border-white/[0.06] bg-white/[0.03] px-3 py-2.5"
                data-testid="latest-row"
              >
                <span className="w-11 shrink-0 text-sm font-bold tabular-nums text-slate-200">{time}</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-white" title={r.employee?.name ?? undefined}>
                    {r.employee?.name ?? "Unknown code"}
                    {r.employee?.employeeCode && (
                      <span className="ml-1.5 font-mono text-xs font-normal text-slate-400">
                        {r.employee.employeeCode}
                      </span>
                    )}
                  </p>
                  <p className="flex min-w-0 items-center gap-1.5 text-xs text-slate-400">
                    <span className="shrink-0 rounded-md border border-white/10 bg-white/[0.05] px-1.5 py-px text-[11px] font-semibold text-slate-200">
                      {recordTypeShort(r)}
                    </span>
                    <span className="truncate" title={detail ?? undefined}>
                      {detail}
                    </span>
                  </p>
                </div>
                <span
                  className={cn(
                    "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-xs font-semibold",
                    denied ? "bg-red-500/15 text-red-200" : "bg-emerald-500/15 text-emerald-200",
                  )}
                >
                  {denied ? <ShieldX size={13} aria-hidden="true" /> : <CheckCircle2 size={13} aria-hidden="true" />}
                  {denied ? "Denied" : "Allowed"}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

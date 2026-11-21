// The two cards a gate operator reads: the scanner card (the big one: ready with its QR frame, "Checking", or for a few
// seconds after a scan the answer's colour with an animated icon and the answer in large words) and the result card (the
// latest scan's full detail, kept until the next scan or Done). The motion lives in gate-kiosk.css; with reduced motion
// everything only fades.

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  CircleHelp,
  Clock3,
  Coffee,
  DoorOpen,
  Hourglass,
  Keyboard,
  Loader2,
  LogIn,
  MapPin,
  QrCode,
  ScanLine,
  Undo2,
  UserCheck,
  WifiOff,
  XCircle,
} from "lucide-react";
import type { GateScanResult } from "@/lib/api-client/custom-hooks/gate-monitor";
import { cn } from "@/lib/utils";
import { fmtDateTime, fmtMinutes, fmtTime } from "@/pages/hr/outpass-visitors/kit/fmt";
import { KioskPerson, PANEL } from "./parts";
import {
  cooldownDeadline,
  describeScan,
  fmtCountdown,
  formatApprover,
  type ScanGlyph,
  type ScanTone,
  type ScanView,
} from "./scan-result";

/** The answer the page is lit with: its tone, which scan it was (a new scan replays the motion), and whether it still glows. */
export type ScanGlow = { tone: ScanTone; seq: number; on: boolean };

// ── the animated icon ────────────────────────────────────────────────────────────────────────────────────────────

const STROKE = 2.3;

/** The answer's icon, drawn so its strokes can animate (pathLength 1: the dash runs from 1 to 0). */
function Glyph({ glyph }: { glyph: ScanGlyph }) {
  if (glyph === "offline") return <WifiOff size={56} strokeWidth={2} aria-hidden="true" />;
  if (glyph === "unknown") return <CircleHelp size={56} strokeWidth={2} aria-hidden="true" />;
  return (
    <svg viewBox="0 0 24 24" className="gk-glyph size-16 sm:size-[4.5rem]" strokeWidth={STROKE} aria-hidden="true">
      {glyph === "check" && <path data-draw="1" pathLength={1} d="M6.2 12.6 10.4 16.8 17.9 8.3" />}
      {glyph === "cross" && (
        <>
          <path data-draw="1" pathLength={1} d="M7.6 7.6 16.4 16.4" />
          <path data-draw="2" pathLength={1} d="M16.4 7.6 7.6 16.4" />
        </>
      )}
      {glyph === "warn" && (
        <>
          <path data-draw="1" pathLength={1} d="M12 3.6 21.3 19.6H2.7Z" />
          <path data-draw="2" pathLength={1} d="M12 9.6v4.2" />
          <circle cx="12" cy="16.7" r="1.15" fill="currentColor" stroke="none" />
        </>
      )}
      {glyph === "wait" && (
        <>
          <circle data-draw="1" pathLength={1} cx="12" cy="12" r="8.6" />
          <path d="M12 12l3.4 2" />
          <path className="gk-hand" d="M12 12V6.4" />
        </>
      )}
      {glyph === "return" && (
        <>
          <path data-draw="1" pathLength={1} d="M3.5 12a8.5 8.5 0 1 0 8.5-8.5 9.2 9.2 0 0 0-6.36 2.59L3.5 8.2" />
          <path data-draw="3" pathLength={1} d="M3.5 3.5v4.7h4.7" />
        </>
      )}
    </svg>
  );
}

function AnswerDisc({ glyph }: { glyph: ScanGlyph }) {
  return (
    <div className="gk-disc-wrap relative" data-glyph={glyph} data-testid="scan-glyph">
      <div className="gk-disc">
        <span className="gk-ripple" aria-hidden="true" />
        {glyph === "return" && <span className="gk-sweep" aria-hidden="true" />}
        <Glyph glyph={glyph} />
      </div>
    </div>
  );
}

/** The small icon of an answer in the result card's tile. */
export const GLYPH_ICON: Record<ScanGlyph, typeof CheckCircle2> = {
  check: CheckCircle2,
  warn: AlertTriangle,
  wait: Hourglass,
  cross: XCircle,
  return: Undo2,
  offline: WifiOff,
  unknown: CircleHelp,
};

// ── the scanner card ─────────────────────────────────────────────────────────────────────────────────────────────

function QrFrame({ busy, dim }: { busy: boolean; dim: boolean }) {
  return (
    <div className="gk-frame" data-busy={busy ? "true" : undefined} data-dim={dim ? "true" : undefined}>
      {(["tl", "tr", "bl", "br"] as const).map((at) => (
        <span key={at} className="gk-corner" data-at={at} aria-hidden="true" />
      ))}
      <span className="absolute inset-0 flex items-center justify-center text-white/25" aria-hidden="true">
        {busy ? (
          <Loader2 size={44} className="animate-spin text-sky-200" />
        ) : dim ? (
          <WifiOff size={44} />
        ) : (
          <QrCode size={52} strokeWidth={1.5} />
        )}
      </span>
      <span className="gk-scanline" aria-hidden="true" />
    </div>
  );
}

export function ScanCard({
  glow,
  view,
  person,
  busy,
  online,
  takes,
  onSubmitCode,
}: {
  /** The answer the card shows while `glow.on`; null before the first scan. */
  glow: ScanGlow | null;
  /** How the latest answer reads (describeScan). */
  view: ScanView | null;
  /** The latest answer's employee, shown under the answer. */
  person: { name: string; employeeCode?: string | null } | null;
  busy: boolean;
  online: boolean;
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
  const showing = !busy && !!glow?.on && !!view;
  const state = busy ? "busy" : showing ? glow!.tone : "idle";
  return (
    <section
      aria-labelledby="gate-scan-title"
      className="gk-scanner flex min-h-[360px] flex-col p-4 sm:min-h-[420px] sm:p-6 lg:min-h-[460px]"
      data-gk-tone={glow?.tone ?? "neutral"}
      data-on={showing ? "true" : "false"}
      data-testid="scan-card"
    >
      <span className="gk-scanner-tone" aria-hidden="true" />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="inline-flex size-9 items-center justify-center rounded-xl bg-white/10 text-white">
          <ScanLine size={18} aria-hidden="true" />
        </span>
        <h2 id="gate-scan-title" className="text-lg font-bold text-white">
          Scan a pass
        </h2>
        <span className="ml-auto max-w-full truncate rounded-full border border-white/[0.15] bg-white/[0.06] px-3 py-1 text-xs font-semibold text-slate-200">
          {takes}
        </span>
      </div>

      <div
        className="flex flex-1 flex-col items-center justify-center gap-4 px-2 py-6 text-center"
        data-testid="scan-zone"
        data-state={state}
      >
        {showing ? (
          <div key={`answer-${glow!.seq}`} className="gk-enter flex flex-col items-center gap-4">
            <AnswerDisc glyph={view!.glyph} />
            <div className="flex max-w-xl flex-col items-center gap-2">
              <p className="text-balance text-2xl font-bold leading-tight text-white sm:text-4xl">{view!.title}</p>
              {(person || view!.kindLabel) && (
                <p className="flex flex-wrap items-center justify-center gap-2 text-base text-white/85 sm:text-lg">
                  {person && <span className="font-semibold">{person.name}</span>}
                  {person?.employeeCode && (
                    <span className="font-mono text-sm text-white/70">{person.employeeCode}</span>
                  )}
                  {view!.kindLabel && (
                    <span className="rounded-full bg-black/[0.2] px-2.5 py-0.5 text-xs font-bold uppercase tracking-wider text-white">
                      {view!.kindLabel}
                    </span>
                  )}
                </p>
              )}
              {view!.note && (
                <p
                  className={cn(
                    "mt-1 inline-flex items-center gap-2 rounded-xl px-3 py-1.5 text-sm font-semibold sm:text-base",
                    view!.note.warn ? "bg-orange-500/90 text-white" : "bg-black/[0.2] text-white",
                  )}
                  data-testid="scan-zone-note"
                >
                  {view!.note.warn && <AlertTriangle size={16} aria-hidden="true" />}
                  {view!.note.text}
                </p>
              )}
            </div>
          </div>
        ) : (
          <div key={busy ? "busy" : "ready"} className="gk-enter flex flex-col items-center gap-5">
            <QrFrame busy={busy} dim={!online && !busy} />
            <div className="flex flex-col items-center gap-1.5">
              <p className="text-xl font-bold text-white sm:text-2xl">
                {busy
                  ? "Checking the code…"
                  : online
                    ? "Ready - scan a gate pass or tea-break QR"
                    : "No connection - scans cannot be checked"}
              </p>
              <p className="max-w-md text-sm text-slate-400">
                {online || busy
                  ? "Hold the QR code under the scanner. The result shows below."
                  : "Scans are checked again as soon as the connection is back."}
              </p>
            </div>
          </div>
        )}
      </div>

      <form onSubmit={submit} className="flex gap-2" data-testid="code-form">
        <label htmlFor="gate-code" className="sr-only">
          Type the pass code
        </label>
        <div className="relative min-w-0 flex-1">
          <Keyboard
            size={17}
            className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400"
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
            className="h-12 w-full min-w-0 rounded-xl border border-white/[0.15] bg-black/[0.25] pl-10 pr-3 font-mono text-base text-white outline-none placeholder:font-sans placeholder:text-white/[0.5] focus-visible:border-sky-300/70 focus-visible:ring-2 focus-visible:ring-sky-300/40"
            data-testid="code-input"
          />
        </div>
        <button
          type="submit"
          disabled={busy || !code.trim()}
          className="h-12 shrink-0 rounded-xl bg-white px-5 text-base font-bold text-slate-900 outline-none hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-sky-300/70 disabled:opacity-50"
          data-testid="code-check"
        >
          Check
        </button>
      </form>
    </section>
  );
}

// ── the result card ──────────────────────────────────────────────────────────────────────────────────────────────

function secondsUntil(deadline: number | null): number | null {
  return deadline === null ? null : Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
}

/** Seconds left until `deadline` (a time on this kiosk's clock), counted down once a second; null without a deadline. */
export function useCountdown(deadline: number | null): number | null {
  const [seconds, setSeconds] = useState(() => secondsUntil(deadline));
  useEffect(() => {
    setSeconds(secondsUntil(deadline));
    if (deadline === null) return;
    const id = setInterval(() => {
      const next = secondsUntil(deadline);
      setSeconds(next);
      if (next === 0) clearInterval(id);
    }, 1000);
    return () => clearInterval(id);
  }, [deadline]);
  return seconds;
}

function Field({ icon: Icon, label, children }: { icon?: typeof MapPin; label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 rounded-xl border border-white/[0.06] bg-white/[0.04] px-3 py-2">
      <p className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-[0.1em] text-slate-400">
        {Icon && <Icon size={12} aria-hidden="true" />}
        {label}
      </p>
      <p className="mt-0.5 truncate text-sm font-semibold text-slate-100">{children}</p>
    </div>
  );
}

function Countdown({ deadline }: { deadline: number | null }) {
  const seconds = useCountdown(deadline);
  if (seconds === null) return null;
  return seconds > 0 ? (
    <p
      className="gk-tone-tile inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold"
      data-gk-tone="orange"
      data-testid="scan-result-countdown"
    >
      <Hourglass size={16} aria-hidden="true" />
      Scan again in <span className="text-base font-bold tabular-nums">{fmtCountdown(seconds)}</span>
    </p>
  ) : (
    <p
      className="gk-tone-tile inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold"
      data-gk-tone="green"
      data-testid="scan-result-countdown"
    >
      <CheckCircle2 size={16} aria-hidden="true" /> Can scan again now
    </p>
  );
}

export function ResultBanner({
  result,
  at,
  seq,
  onDone,
}: {
  result: GateScanResult | null;
  /** When the scan was answered (on this kiosk's clock). */
  at: Date | null;
  /** Which scan this is: a new one replays the card's entrance. */
  seq: number;
  onDone: () => void;
}) {
  if (!result) {
    return (
      <section
        className="flex min-h-[132px] flex-col items-center justify-center gap-2 rounded-3xl border-2 border-dashed border-white/10 px-4 py-8 text-center text-slate-400"
        data-testid="scan-result-empty"
      >
        <ScanLine size={22} aria-hidden="true" />
        <p className="text-sm">The result of the next scan shows here, and stays until the next one.</p>
      </section>
    );
  }
  const view = describeScan(result);
  const Icon = GLYPH_ICON[view.glyph];
  const emp = result.employee;
  const cooldown = result.result === "cooldown";
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
  if (result.action === "in" && typeof result.takenMinutes === "number") {
    details.push({ key: "taken", icon: Coffee, label: "Time on break", value: fmtMinutes(result.takenMinutes) });
    if (typeof result.allowedMinutes === "number") {
      details.push({ key: "allowed", icon: Clock3, label: "Allowed", value: fmtMinutes(result.allowedMinutes) });
    }
  }
  // the cooldown's own line ("Already scanned at 10:05 - tea break started. Scan again after 10:10.") takes the message's place
  const message = cooldown && view.note ? view.note.text : result.message;
  const warning = view.note?.warn ? view.note.text : null;
  return (
    <section
      key={seq}
      className={cn(PANEL, "gk-result gk-enter p-4 sm:p-5")}
      data-gk-tone={view.tone}
      data-testid="scan-result"
      data-result={result.result}
      data-tone={view.tone}
    >
      <div className="flex flex-wrap items-start gap-3 sm:flex-nowrap">
        <span className="gk-tone-tile inline-flex size-12 shrink-0 items-center justify-center rounded-2xl">
          <Icon size={26} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="gk-tone-ink text-xl font-bold leading-tight sm:text-2xl" data-testid="scan-result-title">
            {view.title}
          </p>
          {message && (
            <p className="mt-1 text-sm text-slate-300" data-testid="scan-result-message">
              {message}
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-row items-center gap-2 sm:flex-col sm:items-end sm:gap-1">
          {view.kindLabel && (
            <span className="rounded-full border border-white/10 bg-white/[0.06] px-2.5 py-0.5 text-xs font-bold uppercase tracking-wider text-slate-100">
              {view.kindLabel}
            </span>
          )}
          {at && <span className="text-xs tabular-nums text-slate-400">at {fmtTime(at)}</span>}
        </div>
      </div>

      {(warning || cooldown) && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {warning && (
            <p
              className="gk-tone-tile inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold"
              data-gk-tone="orange"
              data-testid="scan-result-warning"
            >
              <AlertTriangle size={16} aria-hidden="true" /> {warning}
            </p>
          )}
          {cooldown && <Countdown deadline={cooldownDeadline(result, at)} />}
        </div>
      )}

      {emp && (
        <div className="mt-4 rounded-2xl border border-white/[0.06] bg-white/[0.03] p-3">
          <KioskPerson name={emp.name} code={emp.employeeCode} sub={emp.department} photoUrl={emp.photoUrl} />
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
        className="mt-4 inline-flex h-11 items-center rounded-xl border border-white/[0.15] bg-white/[0.05] px-4 text-sm font-semibold text-slate-100 outline-none hover:bg-white/[0.1] focus-visible:ring-2 focus-visible:ring-sky-300/70"
        data-testid="scan-result-done"
      >
        Done
      </button>
    </section>
  );
}

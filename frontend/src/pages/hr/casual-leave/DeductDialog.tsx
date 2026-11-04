import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { ArrowRight, ChevronDown, ChevronLeft, ChevronRight, Loader2, MinusCircle, Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { DetectResult, IdleHint, Scanner, useDetectPhase, type Phase } from "./DetectPanel";
import { useDetection } from "./api";
import {
  MAX_LIMIT,
  REASON_MAX,
  assignLabel,
  balanceSegments,
  daysNumber,
  parseLimit,
  pickLines,
  pickerMonth,
  reasonError,
  togglePick,
  type CarryRow,
  type ClAdjustProblem,
  type PickLine,
  type SegmentPart,
} from "./carry-forward";

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const PART: Record<SegmentPart, string> = {
  used: "bg-slate-400",
  pending: "bg-amber-400",
  picked: "bg-sky-500",
  left: "bg-emerald-400",
};

const nameOf = (r: CarryRow) => r.employeeName ?? r.employeeCode ?? `#${r.employeeId}`;

/** The year's 12 days as segments (used, waiting, picked now, left) with "12 → 10 left" beside them. */
function BalanceMeter({ line, year }: { line: PickLine; year: number }) {
  const b = line.row.balance;
  const segments = balanceSegments(b, line.picked.length);
  return (
    <div className="rounded-2xl border border-gray-100 bg-white p-3 shadow-sm" data-testid="cf-meter">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-xs font-semibold text-gray-600">Casual Leave {year}</p>
        <p
          className="inline-flex items-center gap-1 text-sm font-black tabular-nums text-gray-900"
          data-testid="cf-preview"
        >
          {daysNumber(line.before)}
          {line.picked.length > 0 && (
            <>
              <ArrowRight size={13} className="text-gray-400" aria-hidden />
              <motion.span
                key={line.after}
                initial={{ y: -4, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                className="text-sky-700"
              >
                {daysNumber(line.after)}
              </motion.span>
            </>
          )}{" "}
          <span className="text-xs font-semibold text-gray-500">of {daysNumber(b.total)} left</span>
        </p>
      </div>
      <div
        className="mt-2 grid gap-1"
        style={{ gridTemplateColumns: `repeat(${segments.length}, minmax(0, 1fr))` }}
        aria-hidden
      >
        {segments.map((parts, i) => (
          <span key={i} className="flex h-2.5 overflow-hidden rounded-full bg-slate-100">
            {parts.map((p, j) => (
              <motion.span
                key={`${p.part}-${j}`}
                layout
                className={cn("h-full", PART[p.part], p.part === "picked" && "motion-safe:animate-pulse")}
                style={{ width: `${p.share * 100}%` }}
              />
            ))}
          </span>
        ))}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-3 text-[10px] text-gray-500">
        <span>{daysNumber(b.used)} used</span>
        {b.pending > 0 && <span>{daysNumber(b.pending)} waiting</span>}
        {line.picked.length > 0 && <span className="font-semibold text-sky-700">{line.picked.length} picked now</span>}
        <span>Fixed at {daysNumber(b.total)} a year</span>
      </div>
    </div>
  );
}

/** − [ 3 ] + : the most dates that may be picked. */
function DaysStepper({
  id,
  value,
  max,
  onChange,
  invalid,
  testId,
  compact,
  label,
}: {
  id: string;
  value: string;
  max: number;
  onChange: (v: string) => void;
  invalid?: boolean;
  testId: string;
  compact?: boolean;
  label: string;
}) {
  const n = parseLimit(value).limit ?? 0;
  const step = (by: number) => onChange(String(Math.min(Math.max(1, n + by), Math.max(1, max))));
  return (
    <div className="inline-flex items-center rounded-xl border border-gray-200 bg-white shadow-sm">
      <button
        type="button"
        onClick={() => step(-1)}
        disabled={n <= 1}
        className={cn(
          "flex items-center justify-center text-gray-500 hover:text-gray-900 disabled:opacity-30",
          compact ? "h-8 w-7" : "h-10 w-9",
        )}
        aria-label={`One day fewer for ${label}`}
      >
        <Minus size={14} />
      </button>
      <Input
        id={id}
        inputMode="numeric"
        className={cn(
          "border-0 text-center font-black tabular-nums shadow-none focus-visible:ring-0",
          compact ? "h-8 w-10 text-sm" : "h-10 w-14 text-lg",
        )}
        placeholder="0"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={invalid}
        aria-label={`Days for ${label}`}
        data-testid={testId}
      />
      <button
        type="button"
        onClick={() => step(1)}
        disabled={n >= Math.min(MAX_LIMIT, max)}
        className={cn(
          "flex items-center justify-center text-gray-500 hover:text-gray-900 disabled:opacity-30",
          compact ? "h-8 w-7" : "h-10 w-9",
        )}
        aria-label={`One day more for ${label}`}
      >
        <Plus size={14} />
      </button>
    </div>
  );
}

function StepTitle({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <p className="flex items-center gap-2 text-sm font-bold text-gray-900">
      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#006496] text-[11px] font-black text-white">
        {n}
      </span>
      {children}
    </p>
  );
}

/**
 * Deduct days (owner 2026-11-04): turn the days an employee was marked Absent or On Leave into Casual Leave from the fixed
 * 12 days of the year. 1) the most days to pick; 2) the system detects the month's absent and on-leave days (with a short
 * animation) and HR ticks up to that many; 3) a reason. Only the ticked dates become Casual Leave. Several employees ticked
 * on the list: one number for everyone (each line can differ) and a section per employee to pick their dates.
 */
export default function DeductDialog({
  targets,
  year,
  month,
  today,
  saving,
  problem,
  problems,
  onClose,
  onAssign,
}: {
  targets: CarryRow[] | null;
  year: number;
  month: number;
  today: { year: number; month: number };
  saving: boolean;
  problem: string | null;
  problems: ClAdjustProblem[];
  onClose: () => void;
  onAssign: (input: { reason: string; items: { employeeId: number; limit: number; dates: string[] }[] }) => void;
}) {
  const open = targets !== null && targets.length > 0;
  const rows = useMemo(() => targets ?? [], [targets]);
  const single = rows.length === 1;
  const [common, setCommon] = useState("");
  const [own, setOwn] = useState<Record<number, string>>({});
  const [picks, setPicks] = useState<Record<number, string[]>>({});
  const [reason, setReason] = useState("");
  const [tried, setTried] = useState(false);
  const [when, setWhen] = useState(() => pickerMonth(year, month, today));
  const [expanded, setExpanded] = useState<number | null>(null);

  useEffect(() => {
    if (!open) return;
    setCommon("");
    setOwn({});
    setPicks({});
    setReason("");
    setTried(false);
    setWhen(pickerMonth(year, month, today));
    setExpanded(rows[0]?.employeeId ?? null);
    // a new set of people opens a fresh form; typing never resets it
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, targets]);

  const inputOf = (r: CarryRow) => own[r.employeeId] ?? common;
  const anyNumber = rows.some((r) => parseLimit(inputOf(r)).limit !== null);
  const ids = useMemo(() => rows.map((r) => r.employeeId), [rows]);
  const detection = useDetection(ids, when.month, when.year, open && anyNumber);
  const phase: Phase = useDetectPhase(open && anyNumber, `${ids.join(",")}|${when.year}-${when.month}`, detection);
  const monthLabel = `${MONTHS[when.month - 1]} ${when.year}`;
  const found = useMemo(
    () => new Map((phase === "done" ? (detection.data?.employees ?? []) : []).map((e) => [e.employeeId, e])),
    [phase, detection.data],
  );

  const lines = useMemo(
    () =>
      pickLines(
        rows,
        inputOf,
        (r) => found.get(r.employeeId)?.dates ?? [],
        (r) => picks[r.employeeId] ?? [],
        monthLabel,
      ),
    [rows, own, common, found, picks, monthLabel], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const serverError = useMemo(() => new Map(problems.map((p) => [p.employeeId, p.error])), [problems]);
  const badReason = reasonError(reason);
  const blocked = phase !== "done" || lines.some((l) => l.error !== null) || badReason !== null;
  const nothingPicked = lines.every((l) => l.picked.length === 0);

  // a lower number drops the last picks beyond it
  const trim = (next: Record<number, string>, nextCommon: string) =>
    setPicks((all) => {
      const out: Record<number, string[]> = {};
      for (const r of rows) {
        const lim = parseLimit(next[r.employeeId] ?? nextCommon).limit ?? 0;
        out[r.employeeId] = (all[r.employeeId] ?? []).slice(0, lim);
      }
      return out;
    });
  const setAll = (value: string) => {
    setCommon(value);
    setOwn({});
    trim({}, value);
  };
  const setOne = (id: number, value: string) => {
    const next = { ...own, [id]: value };
    setOwn(next);
    trim(next, common);
  };
  const toggle = (line: PickLine, date: string) =>
    setPicks((all) => ({
      ...all,
      [line.row.employeeId]: togglePick(all[line.row.employeeId] ?? [], date, line.limit),
    }));
  const moveMonth = (step: number) => {
    setWhen({ year: when.year, month: when.month + step });
    setPicks({}); // one month at a time: the picks were of the other month
  };

  const save = () => {
    setTried(true);
    if (blocked) return;
    onAssign({
      reason: reason.trim(),
      items: lines.map((l) => ({ employeeId: l.row.employeeId, limit: l.limit!, dates: [...l.picked].sort() })),
    });
  };

  const lineError = (l: PickLine) => {
    // a line waits quietly for its number and dates until a save is tried; "nothing found" is the panel's own message
    const quiet =
      (!tried && (l.error === "Enter the days" || l.error === "Pick at least one date")) ||
      (single && !!l.error?.startsWith("No absent"));
    const shown = (tried || l.input.trim() !== "") && !quiet && (phase === "done" || !l.error?.startsWith("No absent"));
    return (shown ? l.error : null) ?? serverError.get(l.row.employeeId) ?? null;
  };

  const first = rows[0];
  const maxFor = (r: CarryRow) => Math.max(0, Math.floor(r.balance.remaining));
  const totalPicked = lines.reduce((n, l) => n + l.picked.length, 0);

  const monthNav = (
    <div className="flex items-center justify-between gap-2 rounded-xl border border-gray-100 bg-slate-50/80 px-1.5 py-1">
      <button
        type="button"
        onClick={() => moveMonth(-1)}
        disabled={when.month <= 1 || phase === "detecting"}
        className="rounded-lg p-1.5 text-gray-600 hover:bg-white hover:text-gray-900 disabled:opacity-30"
        aria-label="Previous month"
        data-testid="cf-month-prev"
      >
        <ChevronLeft size={16} />
      </button>
      <p className="text-xs font-bold text-gray-800" data-testid="cf-month">
        {monthLabel}
      </p>
      <button
        type="button"
        onClick={() => moveMonth(1)}
        disabled={(when.year === today.year && when.month >= today.month) || phase === "detecting"}
        className="rounded-lg p-1.5 text-gray-600 hover:bg-white hover:text-gray-900 disabled:opacity-30"
        aria-label="Next month"
        data-testid="cf-month-next"
      >
        <ChevronRight size={16} />
      </button>
    </div>
  );

  const detectionBody = (l: PickLine) => {
    const e = found.get(l.row.employeeId);
    if (!e) return null;
    return (
      <DetectResult
        who={nameOf(l.row)}
        monthLabel={monthLabel}
        line={l}
        absent={e.absent}
        onLeave={e.onLeave}
        calendar={e.calendar}
        onToggle={(d) => toggle(l, d)}
      />
    );
  };

  const errorBox = phase === "error" && (
    <p className="rounded-xl border border-red-100 bg-red-50 p-3 text-sm text-red-700" role="alert">
      Could not detect the attendance.{" "}
      <button type="button" className="font-semibold underline" onClick={() => void detection.refetch()}>
        Try again
      </button>
    </p>
  );

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !saving && onClose()}>
      <DialogContent className="max-h-[94vh] max-w-xl overflow-y-auto" data-testid="cf-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-rose-600 text-white shadow-sm">
              <MinusCircle size={16} aria-hidden />
            </span>
            {single ? `Deduct days · ${first ? nameOf(first) : ""}` : `Deduct days · ${rows.length} employees`}
          </DialogTitle>
          <DialogDescription>
            Turn the days {single ? "this employee was" : "these employees were"} marked Absent or On Leave into Casual
            Leave. Only the dates you pick are used; the balance stays 12 a year and goes down by them.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-1">
          {single && lines[0] && <BalanceMeter line={lines[0]} year={year} />}

          <section className="space-y-2">
            <StepTitle n={1}>{single ? "How many days at most?" : "How many days at most, for each?"}</StepTitle>
            <div className="flex flex-wrap items-center gap-3">
              <DaysStepper
                id="cf-days"
                value={common}
                max={single && first ? maxFor(first) : MAX_LIMIT}
                onChange={setAll}
                invalid={tried && lines[0]?.error !== null}
                testId="cf-days"
                label={single && first ? nameOf(first) : "everyone"}
              />
              <p className="max-w-xs text-[11px] leading-snug text-gray-500">
                The most dates you can pick{single ? "" : " for each employee (change any line below)"}. Nothing is
                deducted by this number itself.
              </p>
            </div>
            {single && lines[0] && lineError(lines[0]) && (
              <p className="text-xs font-semibold text-rose-700" role="alert" data-testid="cf-line-error">
                {lineError(lines[0])}
              </p>
            )}
          </section>

          <section className="space-y-2">
            <StepTitle n={2}>Detect and pick the dates</StepTitle>
            {monthNav}
            {phase === "idle" && (
              <IdleHint who={single && first ? nameOf(first) : "each employee"} monthLabel={monthLabel} />
            )}
            {phase === "detecting" && (
              <Scanner monthLabel={monthLabel} who={single && first ? nameOf(first) : `${rows.length} employees`} />
            )}
            {errorBox}
            {phase === "done" && single && lines[0] && detectionBody(lines[0])}
            {phase === "done" && !single && (
              <ul className="space-y-2" aria-label="Each employee" data-testid="cf-lines">
                {lines.map((l) => {
                  const id = l.row.employeeId;
                  const e = found.get(id);
                  const open = expanded === id;
                  const err = lineError(l);
                  return (
                    <li
                      key={id}
                      className={cn(
                        "rounded-2xl border bg-white transition-shadow",
                        open ? "border-sky-200 shadow-md" : "border-gray-100",
                      )}
                      data-testid={`cf-line-${id}`}
                    >
                      <div className="flex items-center gap-3 p-3">
                        <button
                          type="button"
                          onClick={() => setExpanded(open ? null : id)}
                          className="flex min-w-0 flex-1 items-center gap-2 text-left"
                          aria-expanded={open}
                          data-testid={`cf-line-toggle-${id}`}
                        >
                          <ChevronDown
                            size={16}
                            className={cn(
                              "shrink-0 text-gray-400 transition-transform duration-200",
                              open && "rotate-180",
                            )}
                          />
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-bold text-gray-900">{nameOf(l.row)}</span>
                            <span className="block truncate text-[11px] text-gray-500">
                              {e ? `${e.absent.length} absent · ${e.onLeave.length} on leave` : ""} ·{" "}
                              {daysNumber(l.before)} left
                              {l.picked.length ? ` · ${l.picked.length} picked` : ""}
                            </span>
                          </span>
                        </button>
                        <DaysStepper
                          id={`cf-line-days-${id}`}
                          value={l.input}
                          max={maxFor(l.row)}
                          onChange={(v) => setOne(id, v)}
                          invalid={err !== null}
                          testId={`cf-line-days-${id}`}
                          compact
                          label={nameOf(l.row)}
                        />
                      </div>
                      {err && (
                        <p className="px-3 pb-2 text-[11px] font-semibold text-rose-700" role="alert">
                          {err}
                        </p>
                      )}
                      {open && <div className="border-t border-gray-50 p-3">{detectionBody(l)}</div>}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="space-y-2">
            <StepTitle n={3}>Reason</StepTitle>
            <Textarea
              id="cf-reason"
              rows={2}
              maxLength={REASON_MAX}
              placeholder="e.g. Absent days covered by unused Casual Leave"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              aria-invalid={tried && badReason !== null}
              aria-label="Reason"
              data-testid="cf-reason"
            />
            <Label
              htmlFor="cf-reason"
              className={cn(
                "text-[11px] font-normal",
                tried && badReason ? "font-semibold text-rose-700" : "text-gray-500",
              )}
            >
              {tried && badReason
                ? badReason
                : "Kept with the change and shown in the employee's Casual Leave history."}
            </Label>
          </section>

          {problem && (
            <p
              className="rounded-xl border border-red-100 bg-red-50 p-3 text-sm text-red-700"
              role="alert"
              data-testid="cf-problem"
            >
              {problem}
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-gray-100 pt-3">
          <p className="text-xs text-gray-500" data-testid="cf-footer-note">
            {totalPicked
              ? `${totalPicked} date${totalPicked === 1 ? "" : "s"} will become Casual Leave (paid).`
              : "Pick the dates to convert."}
          </p>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button
              onClick={save}
              disabled={saving || nothingPicked}
              className="bg-sky-600 hover:bg-sky-700"
              data-testid="cf-save"
            >
              {saving && <Loader2 size={14} className="mr-1 animate-spin" />}
              {assignLabel(lines)}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

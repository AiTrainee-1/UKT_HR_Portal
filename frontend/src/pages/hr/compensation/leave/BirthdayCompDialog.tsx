import { useState, type ReactNode } from "react";
import { Link } from "wouter";
import { ArrowRight, Cake, Check, Gift, Info, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import {
  useBirthdayCompensation,
  usePlaceBirthdayCompensation,
  useWithdrawBirthdayCompensation,
  type BirthdayCompDay,
  type BirthdayCompEntitlement,
  type BirthdayCompPortion,
  type BirthdayCompUse,
  type BirthdayRow,
} from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { StatusChip as KitChip } from "@/pages/hr/outpass-visitors/kit";
import { dateLong, errorMessage } from "../logic";
import { ErrorNotice, Notice, useSingleFlight } from "../ui";
import { usePlaceRight } from "../visible";
import {
  DAY_MARK,
  PORTIONS,
  PORTION_DAYS,
  PORTION_TEXT,
  REASON_MAX,
  canPick,
  dayProblem,
  daysNumber,
  daysWord,
  defaultPortion,
  leftToPlace,
  monthWeeks,
  placedMark,
  portionProblem,
  requestsLink,
  placementRaisedText,
  placementStatusText,
  placementTone,
  waitsForHr,
} from "./birthday-comp-logic";

/** What the dialog does: "place" = choose a date for the employee; "view" = what was placed (and withdraw HR's own). */
export type BirthdayCompMode = "place" | "view";

/**
 * Birthday Compensation on a chosen date, for one employee (owner 2026-11-25). "Choose date for employee": the birthday
 * month as a calendar (Monday first) where every working day the server allows can be picked, with the parts of the day it
 * takes (Full day / First half / Second half); a day that cannot be chosen is greyed out and says why when it is pressed.
 * The balance shows what is left of the 1.00 day (less what waits and what was approved), an optional reason goes with the
 * request, and Send passes it to the Department Head, then HR. Below, every placement of this birthday with its status; a
 * waiting one HR placed can be withdrawn here, and one waiting for HR opens in Requests.
 */
export function BirthdayCompDialog({
  row,
  mode,
  onClose,
}: {
  row: BirthdayRow | null;
  mode: BirthdayCompMode;
  onClose: () => void;
}) {
  return (
    <Dialog open={row !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[94vh] max-w-xl overflow-y-auto" data-testid="bc-dialog">
        {row && (
          <DialogBody key={`${row.employeeId}-${row.birthday}-${mode}`} row={row} mode={mode} onClose={onClose} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function DialogBody({ row, mode, onClose }: { row: BirthdayRow; mode: BirthdayCompMode; onClose: () => void }) {
  const year = Number(row.birthday.slice(0, 4)) || null;
  const query = useBirthdayCompensation(row.employeeId, year);
  const ent = query.data;
  const monthLabel = ent?.month?.label ?? "the birthday month";
  const placing = mode === "place";

  return (
    <div className="space-y-4">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-rose-600 text-white shadow-sm">
            <Gift size={16} aria-hidden />
          </span>
          {placing ? `Choose date for ${row.employeeName}` : `Birthday compensation of ${row.employeeName}`}
        </DialogTitle>
        <DialogDescription>
          <span className="font-mono">{row.employeeCode}</span> worked on their birthday, {dateLong(row.birthday)}: 1.00
          day of birthday compensation to place on working days of {monthLabel}, as a full day or a first and a second
          half (on two different dates if you like). What is not placed by the end of the month lapses.
        </DialogDescription>
      </DialogHeader>

      {query.isLoading && (
        <p className="flex items-center gap-2 py-6 text-sm text-slate-600" role="status" data-testid="bc-loading">
          <Loader2 size={16} className="animate-spin" aria-hidden /> Reading {monthLabel}…
        </p>
      )}
      {query.isError && !ent && (
        <div className="space-y-2">
          <ErrorNotice testId="bc-load-error">
            Could not read the birthday month. {errorMessage(query.error, "Check the connection and try again.")}
          </ErrorNotice>
          <Button type="button" variant="outline" size="sm" onClick={() => void query.refetch()}>
            Try again
          </Button>
        </div>
      )}
      {ent && <Loaded row={row} ent={ent} placing={placing} monthLabel={monthLabel} onClose={onClose} />}
    </div>
  );
}

function Loaded({
  row,
  ent,
  placing,
  monthLabel,
  onClose,
}: {
  row: BirthdayRow;
  ent: BirthdayCompEntitlement;
  placing: boolean;
  monthLabel: string;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const place = usePlaceBirthdayCompensation();
  const { reason: rightProblem } = usePlaceRight();
  const once = useSingleFlight();
  const days = ent.days ?? { total: 0, held: 0, used: 0, available: 0, lapsed: 0 };
  const left = leftToPlace(days);
  const [pick, setPick] = useState<{ date: string; portion: BirthdayCompPortion } | null>(null);
  const [inspect, setInspect] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const byDate = new Map(ent.eligibleDates.map((d) => [d.date, d]));
  const picked = pick ? byDate.get(pick.date) : undefined;
  // a pick the month no longer allows (it was read again) is dropped
  const valid = !!picked && !!pick && !portionProblem(picked, pick.portion, left);
  const pickedDays = valid && pick ? PORTION_DAYS[pick.portion] : 0;
  const shown = inspect ? byDate.get(inspect) : picked;
  const text = reason.trim();
  const reasonProblem = text.length > REASON_MAX ? `The reason can be at most ${REASON_MAX} characters.` : null;
  const canSend = placing && ent.canPlace && valid && !reasonProblem && !rightProblem && !place.isPending;

  const choose = (day: BirthdayCompDay) => {
    setInspect(null);
    setError(null);
    if (!canPick(day, left)) {
      setInspect(day.date);
      return;
    }
    if (pick?.date === day.date) {
      setPick(null);
      return;
    }
    const portion = defaultPortion(day, left);
    setPick(portion ? { date: day.date, portion } : null);
  };

  const send = () =>
    once(async () => {
      if (!canSend || !pick) return;
      setError(null);
      try {
        await place.mutateAsync({
          employeeId: row.employeeId,
          useDate: pick.date,
          portion: pick.portion,
          reason: text,
        });
        toast({
          title: "Birthday compensation placed",
          description: `${row.employeeName}: ${dateLong(pick.date)}, ${PORTION_TEXT[pick.portion].toLowerCase()} (${daysWord(
            PORTION_DAYS[pick.portion],
          )}). It waits for the Department Head, then HR.`,
        });
        onClose();
      } catch (err) {
        setError(errorMessage(err, "It could not be placed. Check the connection and try again."));
      }
    });

  return (
    <>
      <Balance days={days} left={left} picked={pickedDays} lapsesOn={ent.lapsesOn ?? null} />

      {placing && !ent.canPlace && (
        <Notice accent="amber" testId="bc-cannot-place">
          <p>{ent.placeMessage || ent.message || "Nothing can be placed for this birthday now."}</p>
        </Notice>
      )}
      {!placing && ent.message && (
        <Notice accent="slate" testId="bc-message">
          <p>{ent.message}</p>
        </Notice>
      )}

      {placing && ent.canPlace && (
        <form
          className="space-y-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <section className="space-y-2">
            <Step n={1}>Pick a day of {monthLabel}</Step>
            <MonthGrid
              days={ent.eligibleDates}
              left={left}
              pick={valid ? pick : null}
              today={ent.today ?? null}
              onDay={choose}
            />
            {shown && <DayInfo day={shown} left={left} refused={!canPick(shown, left)} />}
          </section>

          {valid && picked && pick && (
            <section className="space-y-2">
              <Step n={2}>Part of the day</Step>
              <PortionPicker
                day={picked}
                left={left}
                value={pick.portion}
                onChange={(p) => setPick({ ...pick, portion: p })}
              />
            </section>
          )}

          <section className="space-y-1.5">
            <Step n={valid ? 3 : 2}>Reason (optional)</Step>
            <Textarea
              id="bc-reason"
              rows={2}
              value={reason}
              maxLength={REASON_MAX + 50}
              placeholder="e.g. Placed for the employee at their request"
              onChange={(e) => {
                setReason(e.target.value);
                setError(null);
              }}
              aria-label="Reason (optional)"
              aria-invalid={!!reasonProblem}
              data-testid="bc-reason"
            />
            <p className={cn("text-[11px]", reasonProblem ? "font-semibold text-rose-700" : "text-slate-500")}>
              {reasonProblem ?? `${text.length} / ${REASON_MAX}. The Department Head and HR read it before deciding.`}
            </p>
          </section>

          {error && <ErrorNotice testId="bc-error">{error}</ErrorNotice>}

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-3">
            <p className="max-w-xs text-xs text-slate-500" data-testid="bc-footer-note">
              {valid && pick
                ? `${dateLong(pick.date)}, ${PORTION_TEXT[pick.portion].toLowerCase()} (${daysWord(PORTION_DAYS[pick.portion])}): it waits for the Department Head, then HR. HR's approval pays it like Casual Leave.`
                : "Pick a day and the part of it to place."}
            </p>
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={onClose} disabled={place.isPending}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={!canSend}
                title={rightProblem ?? undefined}
                className="bg-sky-600 hover:bg-sky-700"
                data-testid="bc-send"
              >
                {place.isPending && <Loader2 size={14} className="mr-1 animate-spin" />}
                Send to the Department Head
              </Button>
            </div>
          </div>
          {ent.approvalPath && (
            <p className="text-[11px] text-slate-500" data-testid="bc-approval-path">
              Approval: {ent.approvalPath}.
            </p>
          )}
        </form>
      )}

      <UsesList uses={ent.uses} employeeName={row.employeeName} placing={placing} />

      {!placing && (
        <div className="flex justify-end border-t border-slate-100 pt-3">
          <Button type="button" onClick={onClose} data-view-safe="">
            Close
          </Button>
        </div>
      )}
    </>
  );
}

function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <p className="flex items-center gap-2 text-sm font-bold text-slate-900">
      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#006496] text-[11px] font-black text-white">
        {n}
      </span>
      {children}
    </p>
  );
}

/** The 1.00 day as a bar: approved, waiting, picked now and left, with "1.00 → 0.50 left". */
function Balance({
  days,
  left,
  picked,
  lapsesOn,
}: {
  days: { total: number; held: number; used: number; lapsed: number };
  left: number;
  picked: number;
  lapsesOn: string | null;
}) {
  const total = days.total > 0 ? days.total : 1;
  const parts = [
    { key: "used", value: days.used, tone: "bg-teal-500" },
    { key: "held", value: days.held, tone: "bg-amber-400" },
    { key: "picked", value: picked, tone: "bg-sky-500 motion-safe:animate-pulse" },
    { key: "left", value: Math.max(0, left - picked), tone: "bg-slate-200" },
  ];
  return (
    <div className="rounded-2xl border border-slate-100 bg-white p-3 shadow-sm" data-testid="bc-balance">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-xs font-semibold text-slate-600">Birthday compensation</p>
        <p className="inline-flex items-center gap-1 text-sm font-black tabular-nums text-slate-900">
          <span data-testid="bc-left">{daysNumber(left)}</span>
          {picked > 0 && (
            <>
              <ArrowRight size={13} className="text-slate-400" aria-hidden />
              <span className="text-sky-700" data-testid="bc-left-after">
                {daysNumber(Math.max(0, left - picked))}
              </span>
            </>
          )}
          <span className="text-xs font-semibold text-slate-500">of {daysWord(days.total)} left to place</span>
        </p>
      </div>
      <div className="mt-2 flex h-2.5 overflow-hidden rounded-full bg-slate-100" aria-hidden>
        {parts.map((p) =>
          p.value > 0 ? (
            <span key={p.key} className={cn("h-full", p.tone)} style={{ width: `${(p.value / total) * 100}%` }} />
          ) : null,
        )}
      </div>
      <p className="mt-1.5 flex flex-wrap gap-x-3 text-[11px] text-slate-500" data-testid="bc-balance-parts">
        <span>{daysNumber(days.used)} approved</span>
        <span>{daysNumber(days.held)} waiting</span>
        {picked > 0 && <span className="font-semibold text-sky-700">{daysNumber(picked)} picked now</span>}
        {days.lapsed > 0 && <span className="font-semibold text-rose-700">{daysNumber(days.lapsed)} lapsed</span>}
        {lapsesOn && <span>Lapses after {dateLong(lapsesOn)}</span>}
      </p>
    </div>
  );
}

const CELL: Record<string, string> = {
  future: "border-slate-200 bg-white text-slate-800 hover:border-sky-400 hover:bg-sky-50",
  today: "border-sky-300 bg-white text-slate-900 hover:border-sky-500 hover:bg-sky-50",
  absent: "border-rose-200 bg-rose-50 text-rose-800 hover:border-rose-400 hover:bg-rose-100",
  on_leave: "border-violet-200 bg-violet-50 text-violet-800 hover:border-violet-400 hover:bg-violet-100",
  half_shift: "border-amber-200 bg-amber-50 text-amber-800 hover:border-amber-400 hover:bg-amber-100",
};
const REFUSED = "border-transparent bg-slate-100 text-slate-400";
const BIRTHDAY_CELL = "border-pink-200 bg-pink-50 text-pink-700";

/** A picked cell: solid for a full day, the picked half filled (left = first half, right = second) for a half. */
const PICKED_FILL: Record<BirthdayCompPortion, string> = {
  full: "border-sky-600 bg-sky-600 text-white shadow-md shadow-sky-900/20",
  first_half:
    "border-sky-600 bg-[linear-gradient(90deg,#0284c7_50%,#e0f2fe_50%)] text-sky-950 shadow-md shadow-sky-900/20",
  second_half:
    "border-sky-600 bg-[linear-gradient(90deg,#e0f2fe_50%,#0284c7_50%)] text-sky-950 shadow-md shadow-sky-900/20",
};

/** The birthday month, Monday first: a day the server allows can be picked; any other is greyed out and says why. */
function MonthGrid({
  days,
  left,
  pick,
  today,
  onDay,
}: {
  days: BirthdayCompDay[];
  left: number;
  pick: { date: string; portion: BirthdayCompPortion } | null;
  today: string | null;
  onDay: (day: BirthdayCompDay) => void;
}) {
  return (
    <div className="rounded-2xl border border-slate-100 bg-white p-2.5 shadow-sm" data-testid="bc-calendar">
      <div className="grid grid-cols-7 gap-1 pb-1 text-center text-[10px] font-bold uppercase tracking-wider text-[#006496]/60">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
          <span key={d}>{d}</span>
        ))}
      </div>
      <div className="space-y-1">
        {monthWeeks(days).map((week, w) => (
          <div key={w} className="grid grid-cols-7 gap-1">
            {week.map((day, i) => {
              if (!day) return <span key={`blank-${w}-${i}`} />;
              const n = Number(day.date.slice(8, 10));
              const ok = canPick(day, left);
              const on = pick?.date === day.date ? pick.portion : null;
              const placed = placedMark(day);
              const mark = on
                ? on === "full"
                  ? "BC"
                  : on === "first_half"
                    ? "½ BC"
                    : "BC ½"
                : (placed ?? DAY_MARK[day.status] ?? "");
              const why = ok ? null : dayProblem(day, left);
              return (
                <button
                  key={day.date}
                  type="button"
                  onClick={() => onDay(day)}
                  aria-pressed={ok ? on !== null : undefined}
                  aria-disabled={ok ? undefined : true}
                  aria-label={`${dateLong(day.date)}, ${day.label}${placed ? ", birthday compensation placed" : ""}${on ? `, ${PORTION_TEXT[on]} picked` : ""}${why ? `. Cannot be chosen: ${why}` : ""}`}
                  title={why ?? day.label}
                  className={cn(
                    "relative flex aspect-[5/4] flex-col items-center justify-center rounded-lg border-2 text-xs font-bold tabular-nums transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400",
                    on
                      ? PICKED_FILL[on]
                      : ok
                        ? (CELL[day.status] ?? CELL.future)
                        : day.status === "birthday"
                          ? BIRTHDAY_CELL
                          : cn(REFUSED, "cursor-not-allowed"),
                    today === day.date && !on && "ring-1 ring-sky-400",
                  )}
                  data-testid={`bc-day-${day.date}`}
                  data-selectable={ok ? "true" : "false"}
                  data-portion={on ?? undefined}
                >
                  {on && (
                    <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-white text-sky-600 shadow">
                      <Check size={10} strokeWidth={3.5} aria-hidden />
                    </span>
                  )}
                  <span className={cn(on && on !== "full" && "rounded bg-white/80 px-1")}>{n}</span>
                  {day.status === "birthday" && !on ? (
                    <Cake size={11} aria-hidden className="text-pink-600" />
                  ) : (
                    mark && (
                      <span
                        className={cn(
                          "max-w-full truncate px-0.5 text-[9px] font-bold leading-none",
                          on === "full"
                            ? "text-sky-100"
                            : on
                              ? "rounded bg-white/80 px-1 text-sky-800"
                              : placed
                                ? "text-rose-600"
                                : "opacity-80",
                        )}
                      >
                        {mark}
                      </span>
                    )
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 border-t border-slate-50 pt-2 text-[10px] text-slate-500">
        {[
          ["bg-white ring-1 ring-slate-300", "Still to come"],
          ["bg-rose-400", "Absent"],
          ["bg-violet-400", "On Leave"],
          ["bg-amber-400", "Half Day"],
          ["bg-sky-600", "Picked (half filled = half day)"],
          ["bg-slate-300", "Cannot be chosen (press it to see why)"],
        ].map(([dot, text]) => (
          <span key={text} className="inline-flex items-center gap-1">
            <span className={cn("h-2 w-2 rounded-full", dot)} aria-hidden />
            {text}
          </span>
        ))}
      </div>
    </div>
  );
}

/** The day picked (or pressed): what it is, and why it cannot be chosen or why only some parts. */
function DayInfo({ day, left, refused }: { day: BirthdayCompDay; left: number; refused: boolean }) {
  const why = refused ? dayProblem(day, left) : day.reason;
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-xl border px-3 py-2 text-xs",
        refused ? "border-amber-200 bg-amber-50 text-amber-900" : "border-sky-100 bg-sky-50/70 text-sky-950",
      )}
      role={refused ? "note" : undefined}
      data-testid="bc-day-info"
    >
      <Info size={14} className="mt-0.5 shrink-0" aria-hidden />
      <div className="min-w-0 space-y-0.5">
        <p className="font-semibold">
          {dateLong(day.date)} · {day.label}
          {day.firstPunch ? ` (${day.firstPunch}${day.lastPunch ? ` - ${day.lastPunch}` : ""})` : ""}
        </p>
        {why && <p data-testid="bc-day-reason">{why}</p>}
        {!refused && day.status === "half_shift" && day.worked && (
          <p>
            The {day.worked === "morning" ? "morning" : "evening"} was worked: the{" "}
            {day.worked === "morning" ? "second" : "first"} half covers the rest of the day.
          </p>
        )}
      </div>
    </div>
  );
}

/** Full day / First half / Second half: only what the day takes (within what is left) can be pressed. */
function PortionPicker({
  day,
  left,
  value,
  onChange,
}: {
  day: BirthdayCompDay;
  left: number;
  value: BirthdayCompPortion;
  onChange: (portion: BirthdayCompPortion) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={`Part of ${dateLong(day.date)}`}
      className="inline-flex flex-wrap rounded-xl bg-slate-100 p-1"
      data-testid="bc-portions"
    >
      {PORTIONS.map((portion) => {
        const problem = portionProblem(day, portion, left);
        const on = value === portion;
        const clock =
          portion === "first_half" ? day.halves?.first : portion === "second_half" ? day.halves?.second : null;
        return (
          <button
            key={portion}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={!!problem}
            onClick={() => onChange(portion)}
            title={
              problem ?? `${PORTION_TEXT[portion]} (${daysWord(PORTION_DAYS[portion])})${clock ? `, ${clock}` : ""}`
            }
            className={cn(
              "flex min-h-11 flex-col items-center justify-center rounded-lg px-3 py-1 text-xs font-bold leading-tight transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 sm:min-h-0",
              on ? "bg-sky-600 text-white shadow-sm" : "text-slate-700 hover:bg-white",
              problem && "cursor-not-allowed opacity-40",
            )}
            data-testid={`bc-portion-${portion}`}
          >
            <span>{PORTION_TEXT[portion]}</span>
            <span className={cn("text-[10px] font-semibold", on ? "text-sky-100" : "text-slate-500")}>
              {clock ?? daysWord(PORTION_DAYS[portion])}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Every placement of this birthday, with its status; a waiting one HR placed can be withdrawn. */
function UsesList({
  uses,
  employeeName,
  placing,
}: {
  uses: BirthdayCompUse[];
  employeeName: string;
  placing: boolean;
}) {
  const { toast } = useToast();
  const withdraw = useWithdrawBirthdayCompensation();
  const { reason: rightProblem } = usePlaceRight();
  const [confirming, setConfirming] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const once = useSingleFlight();

  if (uses.length === 0) {
    return placing ? null : (
      <p className="text-sm text-slate-500" data-testid="bc-uses-empty">
        Nothing is placed for this birthday yet.
      </p>
    );
  }

  const confirm = (use: BirthdayCompUse) =>
    once(async () => {
      setError(null);
      try {
        await withdraw.mutateAsync(use.id);
        toast({
          title: "Birthday compensation withdrawn",
          description: `${employeeName}: ${dateLong(use.useDate)}, ${use.portionLabel.toLowerCase()}. That part is free to place again.`,
        });
        setConfirming(null);
      } catch (err) {
        setError(errorMessage(err, "It could not be withdrawn. Check the connection and try again."));
      }
    });

  return (
    <section className="space-y-2" data-testid="bc-uses">
      <p className="text-sm font-bold text-slate-900">Placed so far</p>
      <ul className="space-y-2">
        {uses.map((u) => (
          <li
            key={u.id}
            className="space-y-1 rounded-xl border border-slate-100 bg-white px-3 py-2 shadow-sm"
            data-testid={`bc-use-${u.id}`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-semibold text-slate-900">
                {dateLong(u.useDate)} · {u.portionLabel} ({daysWord(u.days)})
              </p>
              <KitChip tone={placementTone(u)} testId={`bc-use-status-${u.id}`}>
                {placementStatusText(u)}
              </KitChip>
            </div>
            <p className="text-[11px] text-slate-500">
              Placed by {placementRaisedText(u)}
              {u.reason ? ` · “${u.reason}”` : ""}
            </p>
            {u.reviewComment && u.status !== "pending" && (
              <p className="text-[11px] italic text-slate-600">
                {u.reviewedBy ? `${u.reviewedBy}: ` : ""}“{u.reviewComment}”
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              {waitsForHr(u) && (
                <Link
                  href={requestsLink(u.id)}
                  className="inline-flex min-h-11 items-center gap-1 text-xs font-semibold text-indigo-700 underline-offset-2 hover:underline sm:min-h-0"
                  data-testid={`bc-use-decide-${u.id}`}
                >
                  Decide it in Requests <ArrowRight size={12} aria-hidden />
                </Link>
              )}
              {u.canWithdraw &&
                (confirming === u.id ? (
                  <span className="flex flex-wrap items-center gap-2 text-xs text-slate-700">
                    Withdraw this day? It leaves the Department Head&apos;s queue.
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive"
                      className="h-11 sm:h-7"
                      disabled={withdraw.isPending}
                      onClick={() => void confirm(u)}
                      data-testid={`bc-use-withdraw-confirm-${u.id}`}
                    >
                      Withdraw
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-11 sm:h-7"
                      disabled={withdraw.isPending}
                      onClick={() => setConfirming(null)}
                    >
                      Keep it
                    </Button>
                  </span>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-11 sm:h-7"
                    disabled={!!rightProblem}
                    title={rightProblem ?? "Withdraw: remove this placement from the Department Head's queue"}
                    onClick={() => {
                      setError(null);
                      setConfirming(u.id);
                    }}
                    data-testid={`bc-use-withdraw-${u.id}`}
                  >
                    Withdraw
                  </Button>
                ))}
            </div>
          </li>
        ))}
      </ul>
      {error && <ErrorNotice testId="bc-withdraw-error">{error}</ErrorNotice>}
    </section>
  );
}

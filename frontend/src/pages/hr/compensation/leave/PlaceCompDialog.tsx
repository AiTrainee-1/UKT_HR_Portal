import { useState, type ReactNode } from "react";
import { Link } from "wouter";
import { ArrowRight, CalendarPlus, Check, ChevronLeft, ChevronRight, Info, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import {
  usePlaceCompensation,
  usePlacementCalendar,
  useWithdrawCompensationClaim,
  type PlacementCalendar,
  type PlacementDay,
  type PlacementItem,
  type PlacementSource,
  type ShiftsValue,
} from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { StatusChip as KitChip } from "@/pages/hr/outpass-visitors/kit";
import { dateLong, errorMessage } from "../logic";
import { ErrorNotice, Notice, ShiftsPicker, useSingleFlight } from "../ui";
import { useClaimRight } from "../visible";
import {
  AMOUNT_TEXT,
  DAY_MARK,
  REASON_MAX_DEFAULT,
  WORKFLOW_OFF,
  amountProblem,
  amountsFor,
  blockReason,
  canPick,
  capOf,
  dayProblem,
  defaultAmount,
  monthWeeks,
  placedByText,
  placedMark,
  placementRequestsLink,
  placementStatusText,
  placementTone,
  restText,
  shiftNumber,
  shiftWord,
  sourceFiguresText,
  sourceKeyOfCalendar,
  summaryText,
  waitsForHr,
} from "./place-comp-logic";

/** Who, and what is placed: the source in its string form ("overtime:12", "holiday_work:2026-11-22", "claim:40",
 *  "balance"). */
export type PlaceCompTarget = {
  employeeId: number;
  employeeName: string;
  employeeCode?: string | null;
  source: string;
};

/**
 * Compensation on a date HR chooses (owner brief 2026-11-28), for one employee and one source: Shift compensation (a Type 2
 * OT record), Sunday / Holiday work compensation (a day off worked, with the credit HR gives it), an approved credit, or
 * the balance as a whole. Modelled on Birthday Compensation's "Choose date for employee": a month as a calendar (Monday
 * first, with the months before and after while they are in the window) where every day the server allows can be picked
 * with the amounts it takes; a day that cannot be chosen is greyed out and says why when it is pressed. An optional reason
 * goes with it, and Send passes it to the Department Head, then HR. Below, the employee's open compensation days, with
 * Withdraw for one still waiting.
 */
export function PlaceCompDialog({ target, onClose }: { target: PlaceCompTarget | null; onClose: () => void }) {
  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[94vh] max-w-xl overflow-y-auto" data-testid="pc-dialog">
        {target && <DialogBody key={`${target.employeeId}-${target.source}`} target={target} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function DialogBody({ target, onClose }: { target: PlaceCompTarget; onClose: () => void }) {
  const [month, setMonth] = useState<string | null>(null);
  const query = usePlacementCalendar({ employeeId: target.employeeId, month, source: target.source });
  const cal = query.data;
  const code = cal?.employee.employeeCode || target.employeeCode;

  return (
    <div className="space-y-4">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2 pr-6 text-left">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-sky-600 text-white shadow-sm">
            <CalendarPlus size={16} aria-hidden />
          </span>
          <span data-testid="pc-title">
            {cal ? `${cal.source.compTypeLabel} for ${target.employeeName}` : `Choose date for ${target.employeeName}`}
          </span>
        </DialogTitle>
        <DialogDescription>
          {code && <span className="font-mono">{code} · </span>}
          Choose a working day up to {cal?.window.backDays ?? 45} days back (when the day can still take part of a
          shift) or {cal?.window.aheadDays ?? 90} days ahead. It goes to the Department Head, then HR. Nothing lapses:
          what is not placed stays in the balance.
        </DialogDescription>
      </DialogHeader>

      {query.isLoading && (
        <p className="flex items-center gap-2 py-6 text-sm text-slate-600" role="status" data-testid="pc-loading">
          <Loader2 size={16} className="animate-spin" aria-hidden /> Reading the calendar…
        </p>
      )}
      {query.isError && !cal && (
        <div className="space-y-2">
          <ErrorNotice testId="pc-load-error">
            Could not read the calendar. {errorMessage(query.error, "Check the connection and try again.")}
          </ErrorNotice>
          <Button type="button" variant="outline" size="sm" onClick={() => void query.refetch()}>
            Try again
          </Button>
        </div>
      )}
      {cal && (
        <Loaded
          target={target}
          cal={cal}
          fetching={query.isFetching}
          onMonth={setMonth}
          onRefresh={() => void query.refetch()}
          onClose={onClose}
        />
      )}
    </div>
  );
}

function Loaded({
  target,
  cal,
  fetching,
  onMonth,
  onRefresh,
  onClose,
}: {
  target: PlaceCompTarget;
  cal: PlacementCalendar;
  fetching: boolean;
  onMonth: (month: string) => void;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const place = usePlaceCompensation();
  const { reason: rightProblem } = useClaimRight();
  const once = useSingleFlight();
  const source = cal.source;
  const reasonMax = cal.reasonMax || REASON_MAX_DEFAULT;
  const [credit, setCredit] = useState<ShiftsValue>(1);
  const [pick, setPick] = useState<{ date: string; amount: number } | null>(null);
  const [inspect, setInspect] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const cap = capOf(source, credit);
  const byDate = new Map(cal.days.map((d) => [d.date, d]));
  const picked = pick ? byDate.get(pick.date) : undefined;
  // a pick the month no longer allows (it was read again, or the credit went down) is dropped
  const valid = !!picked && !!pick && amountProblem(picked, pick.amount, cap) === null;
  const shown = inspect ? byDate.get(inspect) : valid ? picked : undefined;
  const text = reason.trim();
  const reasonProblem = text.length > reasonMax ? `The reason can be at most ${reasonMax} characters.` : null;
  const blocked = blockReason(cal, rightProblem);
  const canSend = valid && !blocked && !reasonProblem && !place.isPending;

  const choose = (day: PlacementDay) => {
    setInspect(null);
    setError(null);
    if (!canPick(day, cap)) {
      setInspect(day.date);
      return;
    }
    if (pick?.date === day.date && valid) {
      setPick(null);
      return;
    }
    const amount = defaultAmount(day, cap);
    setPick(amount !== null ? { date: day.date, amount } : null);
  };

  const goMonth = (key: string | null) => {
    if (!key) return;
    setPick(null);
    setInspect(null);
    setError(null);
    onMonth(key);
  };

  const changeCredit = (next: ShiftsValue) => {
    setCredit(next);
    setError(null);
    // the day keeps its pick when it still fits the new credit, else it takes what fits
    if (pick && picked && pick.amount > next + 1e-9) {
      const amount = defaultAmount(picked, capOf(source, next));
      setPick(amount !== null ? { date: pick.date, amount } : null);
    }
  };

  const send = () =>
    once(async () => {
      if (!canSend || !pick) return;
      setError(null);
      try {
        const res = await place.mutateAsync({
          employeeId: target.employeeId,
          source: sourceKeyOfCalendar(source),
          useDate: pick.date,
          shifts: pick.amount,
          ...(source.creditFixed ? {} : { creditShifts: credit }),
          reason: text,
        });
        toast({
          title: "Sent to the Department Head",
          description:
            res.message ??
            `${target.employeeName}: ${shiftWord(pick.amount)} off on ${dateLong(pick.date)}. HR approves it after the Department Head.`,
        });
        onClose();
      } catch (err) {
        setError(errorMessage(err, "It could not be sent. Check the connection and try again."));
        // the day may have changed meanwhile (a punch, a leave, another placement): read the month again
        onRefresh();
      }
    });

  return (
    <>
      <SourceBlock source={source} credit={credit} onCredit={changeCredit} />

      {!cal.workflowOn && (
        <Notice accent="amber" testId="pc-workflow-off">
          <p>
            {WORKFLOW_OFF}{" "}
            <Link href="/hr/user-management?tab=approvals" className="font-semibold underline">
              Open Approval Workflow Control
            </Link>
          </p>
        </Notice>
      )}
      {source.refusal && (
        <Notice accent="amber" testId="pc-refusal">
          <p>{source.refusal}</p>
        </Notice>
      )}
      {cal.hodProblem && (
        <Notice accent="amber" testId="pc-hod-problem">
          <p>{cal.hodProblem}</p>
        </Notice>
      )}

      <form
        className="space-y-4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <section className="space-y-2">
          <Step n={1}>Pick a day</Step>
          <MonthGrid
            cal={cal}
            cap={cap}
            pick={valid ? pick : null}
            fetching={fetching}
            onDay={choose}
            onMonth={goMonth}
          />
          {shown && <DayInfo day={shown} cap={cap} refused={!canPick(shown, cap)} />}
        </section>

        {valid && picked && pick && (
          <section className="space-y-2">
            <Step n={2}>How much of the day</Step>
            <AmountPicker
              day={picked}
              amounts={cal.amounts}
              cap={cap}
              value={pick.amount}
              onChange={(amount) => setPick({ ...pick, amount })}
            />
          </section>
        )}

        <section className="space-y-1.5">
          <Step n={valid ? 3 : 2}>Reason (optional)</Step>
          <Textarea
            id="pc-reason"
            rows={2}
            value={reason}
            maxLength={reasonMax + 50}
            placeholder="e.g. Placed for the employee at their request"
            onChange={(e) => {
              setReason(e.target.value);
              setError(null);
            }}
            aria-label="Reason (optional)"
            aria-invalid={!!reasonProblem}
            data-testid="pc-reason"
          />
          <p className={cn("text-[11px]", reasonProblem ? "font-semibold text-rose-700" : "text-slate-500")}>
            {reasonProblem ?? `${text.length} / ${reasonMax}. The Department Head and HR read it before deciding.`}
          </p>
        </section>

        {valid && pick && (
          <Notice accent="slate" testId="pc-summary">
            <p>{summaryText(target.employeeName, pick.amount, pick.date)}</p>
            {restText(source, credit, pick.amount) && <p>{restText(source, credit, pick.amount)}</p>}
          </Notice>
        )}

        {error && <ErrorNotice testId="pc-error">{error}</ErrorNotice>}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-3">
          <p className="max-w-xs text-xs text-slate-500" data-testid="pc-footer-note">
            {blocked && blocked !== rightProblem
              ? "Nothing can be sent from here now: see the note above."
              : valid
                ? "HR approves it after the Department Head; then the day is given."
                : "Pick a day and how much of it to place."}
          </p>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={place.isPending}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!canSend}
              title={blocked ?? undefined}
              className="bg-sky-600 hover:bg-sky-700"
              data-testid="pc-send"
            >
              {place.isPending && <Loader2 size={14} className="mr-1 animate-spin" />}
              Send to the Department Head
            </Button>
          </div>
        </div>
        {cal.approvalPath && (
          <p className="text-[11px] text-slate-500" data-testid="pc-approval-path">
            Approval: {cal.approvalPath.replace(/\bHOD\b/g, "Department Head")}.
          </p>
        )}
      </form>

      <PlacementsList placements={cal.placements} employeeName={target.employeeName} />
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

/** What is placed: its title and figures; for a day off worked, the credit HR gives it (0.25 to 1.00, 1.00 by default). */
function SourceBlock({
  source,
  credit,
  onCredit,
}: {
  source: PlacementSource;
  credit: ShiftsValue;
  onCredit: (credit: ShiftsValue) => void;
}) {
  const choosesCredit = !source.creditFixed && source.canPlace;
  const figures = choosesCredit
    ? `Credit ${shiftNumber(credit)}`
    : source.canPlace || source.total > 0
      ? sourceFiguresText(source)
      : null;
  return (
    <div className="space-y-2 rounded-2xl border border-slate-100 bg-white p-3 shadow-sm" data-testid="pc-source">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="min-w-0 text-sm font-semibold text-slate-900" data-testid="pc-source-title">
          {source.title}
        </p>
        {figures && (
          <p className="text-xs tabular-nums text-slate-500" data-testid="pc-source-figures">
            {figures}
          </p>
        )}
      </div>
      {choosesCredit && (
        <div className="space-y-1">
          <p className="text-xs font-semibold text-slate-700">Credit for the day worked</p>
          <ShiftsPicker value={credit} label="Credit for the day worked" onChange={onCredit} testId="pc-credit" />
          <p className="text-[11px] text-slate-500">
            1.00 by default. The day you pick below takes up to this much; the rest stays in the balance.
          </p>
        </div>
      )}
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
const PICKED = "border-sky-600 bg-sky-600 text-white shadow-md shadow-sky-900/20";
const NAV_BUTTON = "size-11 sm:size-8";

/** The month, Monday first, with the months before / after while they are in the window. */
function MonthGrid({
  cal,
  cap,
  pick,
  fetching,
  onDay,
  onMonth,
}: {
  cal: PlacementCalendar;
  cap: number;
  pick: { date: string; amount: number } | null;
  fetching: boolean;
  onDay: (day: PlacementDay) => void;
  onMonth: (key: string | null) => void;
}) {
  return (
    <div className="rounded-2xl border border-slate-100 bg-white p-2.5 shadow-sm" data-testid="pc-calendar">
      <div className="flex items-center justify-between gap-2 pb-2">
        <Button
          type="button"
          variant="outline"
          size="icon"
          className={NAV_BUTTON}
          disabled={!cal.month.prev}
          onClick={() => onMonth(cal.month.prev)}
          aria-label="Previous month"
          title={cal.month.prev ? "Previous month" : "Earlier days are too far back"}
          data-testid="pc-month-prev"
        >
          <ChevronLeft size={15} />
        </Button>
        <p className="flex items-center gap-1.5 text-sm font-bold text-slate-900" data-testid="pc-month">
          {cal.month.label}
          {fetching && <Loader2 size={13} className="animate-spin text-slate-400" aria-label="Reading the month" />}
        </p>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className={NAV_BUTTON}
          disabled={!cal.month.next}
          onClick={() => onMonth(cal.month.next)}
          aria-label="Next month"
          title={cal.month.next ? "Next month" : "Later days are too far ahead"}
          data-testid="pc-month-next"
        >
          <ChevronRight size={15} />
        </Button>
      </div>
      <div className="grid grid-cols-7 gap-1 pb-1 text-center text-[10px] font-bold uppercase tracking-wider text-[#006496]/60">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
          <span key={d}>{d}</span>
        ))}
      </div>
      <div className="space-y-1">
        {monthWeeks(cal.days).map((week, w) => (
          <div key={w} className="grid grid-cols-7 gap-1">
            {week.map((day, i) => {
              if (!day) return <span key={`blank-${w}-${i}`} />;
              const n = Number(day.date.slice(8, 10));
              const ok = canPick(day, cap);
              const on = pick?.date === day.date ? pick.amount : null;
              const placed = placedMark(day);
              const mark = on !== null ? shiftNumber(on) : (placed ?? DAY_MARK[day.status] ?? "");
              const why = ok ? null : dayProblem(day, cap);
              return (
                <button
                  key={day.date}
                  type="button"
                  onClick={() => onDay(day)}
                  aria-pressed={ok ? on !== null : undefined}
                  aria-disabled={ok ? undefined : true}
                  aria-label={`${dateLong(day.date)}, ${day.label}${placed ? ", compensation placed" : ""}${on !== null ? `, ${shiftWord(on)} picked` : ""}${why ? `. Cannot be chosen: ${why}` : ""}`}
                  title={why ?? day.label}
                  className={cn(
                    "relative flex aspect-[5/4] flex-col items-center justify-center rounded-lg border-2 text-xs font-bold tabular-nums transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400",
                    on !== null ? PICKED : ok ? (CELL[day.status] ?? CELL.future) : cn(REFUSED, "cursor-not-allowed"),
                    cal.today === day.date && on === null && "ring-1 ring-sky-400",
                  )}
                  data-testid={`pc-day-${day.date}`}
                  data-selectable={ok ? "true" : "false"}
                  data-picked={on !== null ? "true" : undefined}
                >
                  {on !== null && (
                    <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-white text-sky-600 shadow">
                      <Check size={10} strokeWidth={3.5} aria-hidden />
                    </span>
                  )}
                  <span>{n}</span>
                  {mark && (
                    <span
                      className={cn(
                        "max-w-full truncate px-0.5 text-[9px] font-bold leading-none",
                        on !== null ? "text-sky-100" : placed ? "text-rose-600" : "opacity-80",
                      )}
                    >
                      {mark}
                    </span>
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
          ["bg-sky-600", "Picked"],
          ["bg-slate-300", "Cannot be chosen (press it to see why)"],
        ].map(([dot, label]) => (
          <span key={label} className="inline-flex items-center gap-1">
            <span className={cn("h-2 w-2 rounded-full", dot)} aria-hidden />
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}

/** The day picked (or pressed): what it is, its punches, and why it cannot be chosen or why only some amounts. */
function DayInfo({ day, cap, refused }: { day: PlacementDay; cap: number; refused: boolean }) {
  const why = refused ? dayProblem(day, cap) : day.reason;
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-xl border px-3 py-2 text-xs",
        refused ? "border-amber-200 bg-amber-50 text-amber-900" : "border-sky-100 bg-sky-50/70 text-sky-950",
      )}
      role={refused ? "note" : undefined}
      data-testid="pc-day-info"
    >
      <Info size={14} className="mt-0.5 shrink-0" aria-hidden />
      <div className="min-w-0 space-y-0.5">
        <p className="font-semibold">
          {dateLong(day.date)} · {day.label}
          {day.firstPunch ? ` (${day.firstPunch}${day.lastPunch ? ` - ${day.lastPunch}` : ""})` : ""}
        </p>
        {why && <p data-testid="pc-day-reason">{why}</p>}
      </div>
    </div>
  );
}

/** 0.25 / 0.50 / 0.75 / 1.00: only what the day takes (within what is left) can be pressed; the suggestion is preselected. */
function AmountPicker({
  day,
  amounts,
  cap,
  value,
  onChange,
}: {
  day: PlacementDay;
  amounts: number[];
  cap: number;
  value: number;
  onChange: (amount: number) => void;
}) {
  const choices = amounts.length > 0 ? amounts : [0.25, 0.5, 0.75, 1];
  const fits = amountsFor(day, cap);
  return (
    <div
      role="radiogroup"
      aria-label={`How much of ${dateLong(day.date)}`}
      className="inline-flex flex-wrap rounded-xl bg-slate-100 p-1"
      data-testid="pc-amounts"
    >
      {choices.map((amount) => {
        const problem = amountProblem(day, amount, cap);
        const on = Math.abs(value - amount) < 1e-9;
        const key = shiftNumber(amount);
        const suggested = day.suggested !== null && Math.abs(day.suggested - amount) < 1e-9 && fits.length > 1;
        return (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={!!problem}
            onClick={() => onChange(amount)}
            title={problem ?? `${shiftWord(amount)}${suggested ? " (as much as the day takes)" : ""}`}
            className={cn(
              "flex min-h-11 flex-col items-center justify-center rounded-lg px-3 py-1 text-xs font-bold leading-tight transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 sm:min-h-0",
              on ? "bg-sky-600 text-white shadow-sm" : "text-slate-700 hover:bg-white",
              problem && "cursor-not-allowed opacity-40",
            )}
            data-testid={`pc-amount-${key}`}
          >
            <span className="tabular-nums">{key}</span>
            <span className={cn("text-[10px] font-semibold", on ? "text-sky-100" : "text-slate-500")}>
              {AMOUNT_TEXT[key] ?? "shift"}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** The employee's open compensation days in the window (any source, whoever placed them); a waiting one can be withdrawn. */
function PlacementsList({ placements, employeeName }: { placements: PlacementItem[]; employeeName: string }) {
  const { toast } = useToast();
  const withdraw = useWithdrawCompensationClaim();
  const { reason: rightProblem } = useClaimRight();
  const [confirming, setConfirming] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const once = useSingleFlight();

  if (placements.length === 0) return null;

  const confirm = (p: PlacementItem) =>
    once(async () => {
      setError(null);
      try {
        await withdraw.mutateAsync(p.id);
        toast({
          title: "Compensation day withdrawn",
          description: `${employeeName}: ${dateLong(p.date)}, ${shiftWord(p.shifts)}. The day is free to choose again.`,
        });
        setConfirming(null);
      } catch (err) {
        setError(errorMessage(err, "It could not be withdrawn. Check the connection and try again."));
      }
    });

  return (
    <section className="space-y-2 border-t border-slate-100 pt-3" data-testid="pc-placements">
      <p className="text-sm font-bold text-slate-900">Open compensation days of {employeeName}</p>
      <ul className="space-y-2">
        {placements.map((p) => (
          <li
            key={p.id}
            className="space-y-1 rounded-xl border border-slate-100 bg-white px-3 py-2 shadow-sm"
            data-testid={`pc-placement-${p.id}`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-semibold text-slate-900">
                {dateLong(p.date)} · {shiftWord(p.shifts)}
              </p>
              <KitChip tone={placementTone(p)} testId={`pc-placement-status-${p.id}`}>
                {placementStatusText(p)}
              </KitChip>
            </div>
            <p className="text-[11px] text-slate-500">
              {p.compTypeLabel} · placed by {placedByText(p)}
              {p.reason ? ` · “${p.reason}”` : ""}
            </p>
            {(waitsForHr(p) || (p.canWithdraw && p.status === "pending")) && (
              <div className="flex flex-wrap items-center gap-2">
                {waitsForHr(p) && (
                  <Link
                    href={placementRequestsLink(p.id)}
                    className="inline-flex min-h-11 items-center gap-1 text-xs font-semibold text-indigo-700 underline-offset-2 hover:underline sm:min-h-0"
                    data-testid={`pc-placement-decide-${p.id}`}
                  >
                    Decide it in Requests <ArrowRight size={12} aria-hidden />
                  </Link>
                )}
                {p.canWithdraw &&
                  p.status === "pending" &&
                  (confirming === p.id ? (
                    <span className="flex flex-wrap items-center gap-2 text-xs text-slate-700">
                      Withdraw this day? It leaves the approval queue.
                      <Button
                        type="button"
                        size="sm"
                        variant="destructive"
                        className="h-11 sm:h-7"
                        disabled={withdraw.isPending}
                        onClick={() => void confirm(p)}
                        data-testid={`pc-placement-withdraw-confirm-${p.id}`}
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
                      title={rightProblem ?? "Withdraw: remove this day from the approval queue"}
                      onClick={() => {
                        setError(null);
                        setConfirming(p.id);
                      }}
                      data-testid={`pc-placement-withdraw-${p.id}`}
                    >
                      Withdraw
                    </Button>
                  ))}
              </div>
            )}
          </li>
        ))}
      </ul>
      {error && <ErrorNotice testId="pc-withdraw-error">{error}</ErrorNotice>}
    </section>
  );
}

import { useEffect, useMemo, useState, type ComponentType, type ReactNode } from "react";
import { Link } from "wouter";
import {
  AlarmClock,
  Check,
  CircleDot,
  ClipboardCheck,
  Clock3,
  Fingerprint,
  Hourglass,
  Loader2,
  LogOut,
  MapPin,
  Navigation,
  PenLine,
  Send,
  ShieldCheck,
  Upload,
  UserCog,
  UserRound,
  UserX,
} from "lucide-react";
import { ApprovalTrail, WaitingChip } from "@/components/ApprovalTrail";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { dateLong } from "@/components/payroll/kit/format";
import { useToast } from "@/hooks/use-toast";
import {
  useAttendanceEditContext,
  useSubmitAttendanceEdit,
  type AttendanceEditContext,
  type AttendanceEditGroup,
  type DayPunch,
} from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import type { Accent } from "./accent";
import {
  buildProposal,
  clBalanceDetail,
  clBalanceText,
  clUseText,
  editGroups,
  findTile,
  groupLook,
  groupNote,
  groupTiles,
  isClassicGroup,
  pickOf,
  sendBlocker,
  serverSentence,
  showsPunches,
  tileTitle,
  type EditPick,
  type EditTile,
} from "./edit-options";
import { HrEditStageLine } from "./HrEditMark";

type Icon = ComponentType<{ size?: number; className?: string }>;

// ── where a punch came from ─────────────────────────────────────────────────────────────────────────────────────────

const SOURCE_ICON: Record<string, Icon> = {
  Biometric: Fingerprint,
  "Geo Punch": MapPin,
  "On-Duty": Navigation,
  "HR Entry": UserRound,
  "Missing Punch": ClipboardCheck,
  "Punch View": Upload,
};

const toMinutes = (t: string): number => {
  const [h, m, s] = t.split(":").map(Number);
  return h * 60 + m + (s || 0) / 60;
};

const span = (minutes: number): string => {
  const total = Math.round(minutes);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
};

const timeText = (t: string | null | undefined): string => (t ? t.slice(0, 5) : "");

const initials = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("");

/** Every punch of the day, in the order they happened, joined by a line that says how long it was between them. */
function PunchTimeline({ punches }: { punches: DayPunch[] }) {
  const first = punches[0];
  const last = punches[punches.length - 1];
  const worked = punches.length > 1 ? toMinutes(last.time) - toMinutes(first.time) : null;
  return (
    <section
      className="rounded-xl border border-slate-200 bg-white p-4"
      data-testid="pd-day-punches"
      aria-label="Punches on this day"
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-100 text-slate-600">
          <Fingerprint size={16} />
        </span>
        <div>
          <h4 className="text-sm font-bold text-slate-900">Punches on this day</h4>
          <p className="text-xs text-slate-500">
            {punches.length === 0
              ? "Nothing recorded"
              : `${punches.length} punch${punches.length === 1 ? "" : "es"}${worked !== null ? ` · ${span(worked)} from the first to the last` : ""}`}
          </p>
        </div>
      </header>

      {punches.length === 0 ? (
        <p
          className="mt-3 rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 py-4 text-center text-xs text-slate-500"
          data-testid="pd-day-punches-empty"
        >
          No punch was recorded for this day.
        </p>
      ) : (
        // left to right in time order; a long day scrolls sideways inside the card
        <ol className="-mx-1 mt-4 flex overflow-x-auto px-1 pb-2" aria-label="Punches in order">
          {punches.map((p, i) => {
            const Src = SOURCE_ICON[p.sourceLabel] ?? CircleDot;
            const isLast = i === punches.length - 1;
            const gap = isLast ? 0 : toMinutes(punches[i + 1].time) - toMinutes(p.time);
            return (
              <li
                key={p.id}
                data-testid="pd-day-punch"
                className={cn("shrink-0", isLast ? "min-w-[9rem]" : "min-w-[12.5rem]")}
              >
                {/* the dot of this punch, and the line to the next with the time between them */}
                <div className="flex items-center">
                  <span
                    className={cn(
                      "h-3 w-3 shrink-0 rounded-full border-2 border-white shadow-sm ring-1",
                      p.type === "IN" ? "bg-emerald-500 ring-emerald-300" : "bg-orange-500 ring-orange-300",
                    )}
                    aria-hidden
                  />
                  {!isLast && (
                    <span className="relative mx-1 h-px flex-1 bg-slate-200" aria-hidden>
                      <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap bg-white px-1.5 text-[11px] text-slate-400">
                        {gap >= 1 ? `${span(gap)} later` : "same minute"}
                      </span>
                    </span>
                  )}
                </div>
                <div className="mt-2 space-y-1.5 pr-3">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-base font-bold tabular-nums text-slate-900">{p.time}</span>
                    <span
                      className={cn(
                        "rounded-md px-1.5 py-0.5 text-[11px] font-bold",
                        p.type === "IN" ? "bg-emerald-50 text-emerald-700" : "bg-orange-50 text-orange-700",
                      )}
                    >
                      {p.type === "IN" ? "In" : "Out"}
                    </span>
                  </div>
                  <span
                    className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs text-slate-700"
                    title={p.source}
                  >
                    <Src size={12} className="text-slate-500" />
                    {p.sourceLabel}
                    {p.device && <span className="font-semibold text-slate-900">· {p.device}</span>}
                  </span>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

/** Who a change goes to: the employee's own Department Head (named, or a plain warning when there is none), then HR. */
function ApprovalRoute({ hod, employeeName }: { hod: AttendanceEditContext["hod"]; employeeName: string }) {
  return (
    <section
      className="rounded-xl border border-slate-200 bg-white p-4"
      data-testid="pd-day-edit-route"
      aria-label="Who approves a change"
    >
      <header className="flex items-center gap-3">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600">
          <ShieldCheck size={16} />
        </span>
        <div>
          <h4 className="text-sm font-bold text-slate-900">Who approves a change</h4>
          <p className="text-xs text-slate-500">Both must approve. The day stays as it is until then.</p>
        </div>
      </header>

      <ol className="mt-4 grid gap-y-5 sm:grid-cols-2 lg:grid-cols-[1fr_1.5fr_1fr_1fr]">
        <RouteStep icon={PenLine} tone="done" last={false}>
          <p className="text-sm font-semibold text-slate-800">You propose it</p>
          <p className="text-xs text-slate-500">With the reason you write below.</p>
        </RouteStep>

        <RouteStep icon={hod ? UserCog : UserX} tone={hod ? "active" : "missing"} last={false}>
          {hod ? (
            <div className="flex items-center gap-3" data-testid="pd-day-edit-hod">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-xs font-bold text-white">
                {initials(hod.name)}
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-bold text-slate-900">{hod.name}</p>
                <p className="text-xs text-slate-500">
                  Department Head of {employeeName} <span className="font-mono">· {hod.code}</span>
                </p>
                <p className="mt-0.5 text-xs font-semibold text-indigo-700">Approves first</p>
              </div>
            </div>
          ) : (
            <div
              className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-900"
              data-testid="pd-day-edit-no-hod"
            >
              <p className="text-sm font-bold">No Department Head assigned</p>
              <p className="mt-1 leading-relaxed">
                {employeeName} has no Department Head who can approve this, so a change cannot be sent. Assign one
                first.
              </p>
              <Link
                href="/hr/user-management"
                className="mt-2 inline-block font-semibold text-red-800 underline underline-offset-2"
              >
                Assign in User Management
              </Link>
            </div>
          )}
          {hod && !hod.canApprove && (
            <p
              className="mt-2 rounded-lg bg-amber-50 px-2.5 py-1.5 text-xs text-amber-900"
              data-testid="pd-day-edit-hod-off"
            >
              Attendance approval is switched off on {hod.name}&apos;s profile, so they cannot approve yet. Switch it on
              in HOD Assignment.
            </p>
          )}
        </RouteStep>

        <RouteStep icon={ShieldCheck} tone="next" last={false}>
          <p className="text-sm font-semibold text-slate-800">HR approves second</p>
          <p className="text-xs text-slate-500">
            In{" "}
            <Link
              href="/hr/requests?kind=attendance_correction"
              className="font-semibold text-indigo-700 underline underline-offset-2"
            >
              Requests &gt; Attendance correction
            </Link>
            .
          </p>
        </RouteStep>

        <RouteStep icon={Check} tone="end" last>
          <p className="text-sm font-semibold text-slate-800">Attendance is updated</p>
          <p className="text-xs text-slate-500">Only after both approvals.</p>
        </RouteStep>
      </ol>
    </section>
  );
}

const ROUTE_TONE = {
  done: "bg-emerald-50 text-emerald-600 ring-emerald-200",
  active: "bg-indigo-600 text-white ring-indigo-200",
  missing: "bg-red-100 text-red-600 ring-red-200",
  next: "bg-slate-100 text-slate-500 ring-slate-200",
  end: "bg-slate-100 text-slate-400 ring-slate-200",
} as const;

function RouteStep({
  icon: Ico,
  tone,
  last,
  children,
}: {
  icon: Icon;
  tone: keyof typeof ROUTE_TONE;
  last: boolean;
  children: ReactNode;
}) {
  return (
    <li className="min-w-0 pr-4">
      {/* the step's mark, and the line on to the next step (a wide screen only: narrower ones wrap into rows) */}
      <div className="flex items-center">
        <span className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-full ring-4", ROUTE_TONE[tone])}>
          <Ico size={13} />
        </span>
        {!last && <span className="ml-2 hidden h-px flex-1 bg-slate-200 lg:block" aria-hidden />}
      </div>
      <div className="mt-2.5 min-w-0">{children}</div>
    </li>
  );
}

type Look = ReturnType<typeof groupLook>;

/** One choice of the form: an attendance type, or a sub-choice of a newer option (a permission type, Mark / Unmark Late, a
 *  Casual Leave portion). A tile the server says cannot be chosen for this day is greyed out and says why. */
function OptionTile({
  tile,
  look,
  chosen,
  onChoose,
}: {
  tile: EditTile;
  look: Look;
  chosen: boolean;
  onChoose: () => void;
}) {
  const off = !tile.available;
  return (
    <button
      type="button"
      aria-pressed={chosen}
      data-testid={tile.testId}
      data-available={off ? "false" : "true"}
      onClick={onChoose}
      disabled={off}
      title={off ? (tile.reason ?? tile.item.unavailableReason ?? tile.description) : tile.description}
      className={cn(
        "relative flex min-h-[3.5rem] flex-col items-start justify-between gap-1.5 rounded-xl border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400",
        off ? "cursor-not-allowed border-dashed border-slate-200 bg-slate-50" : chosen ? look.on : look.tile,
      )}
    >
      <span className={cn("pr-4 text-sm font-bold", off ? "text-slate-400" : "text-slate-900")}>{tile.label}</span>
      {tile.chip && (
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums",
            off ? "bg-slate-100 text-slate-400" : look.chip,
          )}
        >
          {tile.chip}
        </span>
      )}
      {tile.reason && (
        <span className="text-[11px] leading-snug text-slate-500" data-testid={`${tile.testId}-reason`}>
          {tile.reason}
        </span>
      )}
      {chosen && (
        <span className="absolute right-2 top-2 flex h-4 w-4 items-center justify-center rounded-full bg-slate-900 text-white">
          <Check size={10} />
        </span>
      )}
    </button>
  );
}

/** A group of the form: its title and short line (Casual Leave adds the employee's balance), then its tiles. Also used by
 *  the Attendance Edit page for the newer options. */
export function OptionGroup({
  group,
  pick,
  clBalance,
  wide,
  onChoose,
}: {
  group: AttendanceEditGroup;
  pick: EditPick | null;
  clBalance: AttendanceEditContext["clBalance"];
  /** The first three groups run across the whole form; the newer ones sit two to a row on a wide screen. */
  wide: boolean;
  onChoose: (tile: EditTile) => void;
}) {
  const look = groupLook(group);
  const tiles = groupTiles(group);
  const note = groupNote(group);
  const balance = group.key === "casual_leave" ? clBalanceText(clBalance) : null;
  const balanceDetail = group.key === "casual_leave" ? clBalanceDetail(clBalance) : null;
  return (
    <div role="group" aria-label={look.title} data-testid={`pd-edit-group-${group.key}`}>
      <div className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h5 className="text-sm font-bold text-slate-800">{look.title}</h5>
        <span className="text-xs text-slate-500" title={group.description}>
          {look.hint}
        </span>
        {balance && (
          <span
            className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums", look.chip)}
            title={balanceDetail ?? undefined}
            data-testid="pd-edit-cl-balance"
          >
            {balance}
          </span>
        )}
      </div>
      {note && (
        <p
          className="mb-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600"
          data-testid={`pd-edit-group-note-${group.key}`}
        >
          {note}
        </p>
      )}
      <div className={cn("grid grid-cols-2 gap-2", wide ? "sm:grid-cols-3 xl:grid-cols-5" : "sm:grid-cols-3")}>
        {tiles.map((t) => (
          <OptionTile
            key={t.id}
            tile={t}
            look={look}
            chosen={!!pick && pick.itemKey === t.item.key && (pick.choice ?? null) === (t.choice?.value ?? null)}
            onChoose={() => onChoose(t)}
          />
        ))}
      </div>
    </div>
  );
}

function ToggleMark({
  on,
  onToggle,
  icon: Ico,
  label,
  testId,
}: {
  on: boolean;
  onToggle: () => void;
  icon: Icon;
  label: string;
  testId: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      data-testid={testId}
      onClick={onToggle}
      className={cn(
        "flex items-center justify-between gap-2 rounded-xl border px-3 py-2.5 text-left text-sm font-semibold transition-colors",
        on ? "border-red-300 bg-red-50 text-red-700" : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50",
      )}
    >
      <span className="flex items-center gap-2">
        <Ico size={15} className={on ? "text-red-500" : "text-slate-400"} />
        {label}
      </span>
      <span
        className={cn("h-5 w-9 rounded-full p-0.5 transition-colors", on ? "bg-red-500" : "bg-slate-300")}
        aria-hidden
      >
        <span
          className={cn("block h-4 w-4 rounded-full bg-white shadow transition-transform", on && "translate-x-4")}
        />
      </span>
    </button>
  );
}

/**
 * What the Attendance this month card adds under a chosen day: every punch of that day with where it came from, who approves a
 * change (the employee's Department Head by name, or that there is none), and the Attendance Edit form inline. A change is only
 * proposed here: the Department Head approves it first, then HR, and the attendance record is written only after both (the
 * same pipeline as the Attendance page's edit page). The form draws the server's option catalogue: Worked / Compensation /
 * Not worked as always, then Permission, Late, Casual Leave and On-Duty, each greyed out with the server's reason when it
 * cannot be chosen for the day. Shows nothing for a login that has no access to Attendance.
 */
export function DayAttendanceEdit({ employeeId, date, accent }: { employeeId: number; date: string; accent: Accent }) {
  const { toast } = useToast();
  const ctx = useAttendanceEditContext(employeeId, date);
  const submit = useSubmitAttendanceEdit();
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState<EditPick | null>(null);
  const [shifts, setShifts] = useState("1.00");
  const [firstIn, setFirstIn] = useState("");
  const [lastOut, setLastOut] = useState("");
  const [late, setLate] = useState(false);
  const [earlyOut, setEarlyOut] = useState(false);
  const [note, setNote] = useState("");
  const [destination, setDestination] = useState("");
  // the server's own sentence when it refused the last try ("02 Nov 2026 is already marked Late.")
  const [problem, setProblem] = useState<string | null>(null);

  const data = ctx.data;
  const groups = useMemo(() => (data ? editGroups(data) : []), [data]);
  const tile = useMemo(() => findTile(groups, pick), [groups, pick]);
  const selected = tile?.item ?? null;
  const day = data?.day;

  // a different day starts with a closed, empty form
  useEffect(() => {
    setOpen(false);
    setPick(null);
    setNote("");
    setDestination("");
    setProblem(null);
  }, [employeeId, date]);
  // the form starts from the day as it stands
  useEffect(() => {
    if (!day) return;
    setFirstIn(day.firstPunch ?? "");
    setLastOut(day.lastPunch ?? "");
    setLate(day.isLate);
    setEarlyOut(!!day.earlyLeave);
  }, [day?.date, day?.firstPunch, day?.lastPunch, day?.isLate, day?.earlyLeave]); // eslint-disable-line react-hooks/exhaustive-deps

  if (ctx.isLoading) {
    return (
      <p
        className="mt-4 flex items-center gap-2 border-t border-slate-200 pt-4 text-xs text-slate-500"
        data-testid="pd-day-edit-loading"
      >
        <Loader2 size={13} className="animate-spin" /> Loading the punches and the approvers…
      </p>
    );
  }
  if (ctx.isError || !data) return null; // no access to Attendance: the rest of the panel is all this login sees

  const pending = data.requests.find((r) => r.status === "pending");
  const noHod = !data.hod;
  const reasonOk = note.trim().length >= 3;
  const blocker = sendBlocker({ noHod, future: data.future, tile, note });
  const canSend = blocker === null && !submit.isPending;
  const classic = groups.filter((g) => isClassicGroup(g.key));
  const extra = groups.filter((g) => !isClassicGroup(g.key));
  const clUse = selected?.group === "casual_leave" ? clUseText(data.clBalance, tile?.choice?.days) : null;

  const choose = (t: EditTile) => {
    setPick(pickOf(t));
    if (t.item.shifts) setShifts(t.item.shifts);
    setProblem(null);
  };

  const send = async () => {
    if (!tile || blocker) return;
    const what = tileTitle(tile);
    try {
      await submit.mutateAsync(
        buildProposal({ employeeId, date, tile, note, shifts, firstIn, lastOut, late, earlyOut, destination }),
      );
      toast({
        title: "Sent for approval",
        description: `${what} for ${dateLong(date)} goes to ${data.hod?.name ?? "the Department Head"} first, then to HR. The attendance does not change until both approve.`,
      });
      setOpen(false);
      setPick(null);
      setNote("");
      setDestination("");
      setProblem(null);
    } catch (e) {
      const sentence = serverSentence(e);
      setProblem(sentence);
      toast({ title: "Could not send", description: sentence, variant: "destructive" });
    }
  };

  return (
    <div className="mt-4 space-y-4 border-t border-slate-200 pt-4" data-testid="pd-day-edit">
      <div className="space-y-4">
        <PunchTimeline punches={data.punches} />
        <ApprovalRoute hod={data.hod} employeeName={data.employee.name} />
      </div>

      {/* ── a change already waiting ── */}
      {pending && (
        <div
          className="space-y-2 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"
          data-testid="pd-day-edit-pending"
        >
          <p className="flex flex-wrap items-center gap-2 font-bold">
            <Hourglass size={15} /> A change for this day is waiting: {pending.typeLabel ?? "attendance edit"}
            <WaitingChip approval={pending.approval} />
          </p>
          {pending.approval && <ApprovalTrail approval={pending.approval} submittedBy="HR" />}
          <p className="text-xs">The day has not changed. Sending another change replaces this one.</p>
        </div>
      )}

      {/* ── edit ── */}
      {data.canEdit && !open && (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            className={cn("gap-2", accent.solid)}
            onClick={() => setOpen(true)}
            data-testid="pd-day-edit-open"
          >
            <PenLine size={15} /> Edit attendance
          </Button>
          <span className="text-xs text-slate-500">Propose a different status for {dateLong(date)}.</span>
        </div>
      )}

      {data.canEdit && open && (
        <section
          className="rounded-xl border border-slate-200 bg-white"
          data-testid="pd-day-edit-form"
          aria-label="Edit attendance"
        >
          <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
            <div className="flex items-center gap-3">
              <span className={cn("flex h-8 w-8 items-center justify-center rounded-lg", accent.soft, accent.text)}>
                <PenLine size={16} />
              </span>
              <div>
                <h4 className="text-sm font-bold text-slate-900">Edit attendance</h4>
                <p className="text-xs text-slate-500">
                  {data.employee.name} · {dateLong(date)}
                </p>
              </div>
            </div>
            {noHod && (
              <span className="rounded-full bg-red-50 px-2.5 py-1 text-xs font-semibold text-red-700">
                No Department Head: cannot send
              </span>
            )}
            {data.future && (
              <span className="rounded-full bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-800">
                This day has not come yet
              </span>
            )}
          </header>

          <div className="space-y-5 p-4">
            {/* 0. where the day's last HR edit stands */}
            {data.hrEdit && <HrEditStageLine edit={data.hrEdit} />}

            {/* 1. what the day should be: the three groups it always had, then the newer options */}
            {classic.map((g) => (
              <OptionGroup key={g.key} group={g} pick={pick} clBalance={data.clBalance} wide onChoose={choose} />
            ))}
            {extra.length > 0 && (
              <div className="grid gap-5 lg:grid-cols-2" data-testid="pd-edit-more-options">
                {extra.map((g) => (
                  <OptionGroup
                    key={g.key}
                    group={g}
                    pick={pick}
                    clBalance={data.clBalance}
                    wide={false}
                    onChoose={choose}
                  />
                ))}
              </div>
            )}

            {/* 2. the details of the chosen option */}
            {tile && selected && (
              <div className="space-y-4 rounded-xl bg-slate-50 p-4" data-testid="pd-day-edit-details">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-bold text-slate-900">{tileTitle(tile)}</span>
                  <span className="text-xs text-slate-500">{tile.description}</span>
                </div>

                {selected.shiftChoices.length > 0 && (
                  <div>
                    <p className="mb-1.5 text-sm font-semibold text-slate-800">How much is the day worth?</p>
                    <div
                      className="inline-flex rounded-xl bg-white p-1 ring-1 ring-slate-200"
                      role="group"
                      aria-label="Shift value"
                    >
                      {selected.shiftChoices.map((c) => (
                        <button
                          key={c}
                          type="button"
                          aria-pressed={shifts === c}
                          data-testid={`pd-edit-shifts-${c}`}
                          onClick={() => setShifts(c)}
                          className={cn(
                            "rounded-lg px-3.5 py-1.5 text-sm font-semibold tabular-nums transition-colors",
                            shifts === c ? "bg-violet-600 text-white shadow-sm" : "text-slate-600 hover:bg-slate-100",
                          )}
                        >
                          {c}
                        </button>
                      ))}
                    </div>
                    <span className="ml-2 text-xs text-slate-500">shift</span>
                  </div>
                )}

                {showsPunches(selected) && (
                  <>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className="block">
                        <span className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold text-slate-800">
                          <Clock3 size={14} className="text-slate-400" /> First in
                        </span>
                        <Input
                          type="time"
                          value={timeText(firstIn)}
                          onChange={(e) => setFirstIn(e.target.value)}
                          className="bg-white"
                          data-testid="pd-edit-first-in"
                        />
                      </label>
                      <label className="block">
                        <span className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold text-slate-800">
                          <Clock3 size={14} className="text-slate-400" /> Last out
                        </span>
                        <Input
                          type="time"
                          value={timeText(lastOut)}
                          onChange={(e) => setLastOut(e.target.value)}
                          className="bg-white"
                          data-testid="pd-edit-last-out"
                        />
                      </label>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <ToggleMark
                        on={late}
                        onToggle={() => setLate(!late)}
                        icon={AlarmClock}
                        label="Came in late"
                        testId="pd-edit-late"
                      />
                      <ToggleMark
                        on={earlyOut}
                        onToggle={() => setEarlyOut(!earlyOut)}
                        icon={LogOut}
                        label="Left early"
                        testId="pd-edit-early-out"
                      />
                    </div>
                  </>
                )}

                {selected.group === "permission" && (
                  <p className="text-xs leading-relaxed text-slate-600" data-testid="pd-edit-permission-note">
                    Once approved it is an approved permission like any other: it uses {data.employee.name}&apos;s
                    monthly permission allowance, and one beyond the allowance counts as an excess permission.
                  </p>
                )}

                {clUse && (
                  <p className="text-xs leading-relaxed text-slate-600" data-testid="pd-edit-cl-use">
                    {clUse}
                  </p>
                )}

                {selected.group === "on_duty" && (
                  <label className="block">
                    <span className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold text-slate-800">
                      <MapPin size={14} className="text-slate-400" /> Where was the employee?
                      <span className="font-normal text-slate-400">(optional)</span>
                    </span>
                    <Input
                      value={destination}
                      maxLength={200}
                      onChange={(e) => setDestination(e.target.value)}
                      placeholder="e.g. Customer visit, Tiruppur"
                      className="bg-white"
                      data-testid="pd-edit-destination"
                    />
                  </label>
                )}
              </div>
            )}

            {/* 3. the reason */}
            <label className="block">
              <span className="mb-1.5 flex items-baseline justify-between gap-2">
                <span className="text-sm font-bold text-slate-900">Reason</span>
                <span className={cn("text-xs", reasonOk ? "text-emerald-600" : "text-slate-400")}>
                  {reasonOk ? "The Department Head and HR will read this" : "A few words, required"}
                </span>
              </span>
              <Textarea
                rows={2}
                value={note}
                onChange={(e) => {
                  setNote(e.target.value);
                  setProblem(null);
                }}
                placeholder="e.g. CCTV verified: the device missed the punch"
                data-testid="pd-edit-reason"
              />
            </label>
          </div>

          <footer className="flex flex-wrap items-center gap-3 border-t border-slate-100 bg-slate-50/60 px-4 py-3">
            {problem && (
              <p
                role="alert"
                className="w-full rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-800"
                data-testid="pd-day-edit-error"
              >
                {problem}
              </p>
            )}
            <Button
              type="button"
              className={cn("gap-2", accent.solid)}
              disabled={!canSend}
              onClick={send}
              data-testid="pd-day-edit-send"
            >
              {submit.isPending ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
              Send for approval
            </Button>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <p className="min-w-0 flex-1 text-xs text-slate-500" aria-live="polite" data-testid="pd-day-edit-hint">
              {blocker ??
                `Goes to ${data.hod?.name} first, then to HR. The payroll is not recalculated: generate it again once approved.`}
            </p>
          </footer>
        </section>
      )}
    </div>
  );
}

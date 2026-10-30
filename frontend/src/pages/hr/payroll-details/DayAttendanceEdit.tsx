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
  type AttendanceEditType,
  type DayPunch,
} from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import type { Accent } from "./accent";

type Icon = ComponentType<{ size?: number; className?: string }>;

// ── the three groups of attendance types ────────────────────────────────────────────────────────────────────────────

const GROUPS: {
  key: AttendanceEditType["group"];
  title: string;
  hint: string;
  tile: string; // the tile at rest
  on: string; // the chosen tile
  chip: string; // the shift value on it
}[] = [
  {
    key: "Attendance",
    title: "Worked",
    hint: "How much of the day was worked",
    tile: "border-slate-200 bg-white hover:border-indigo-300 hover:bg-indigo-50/40",
    on: "border-indigo-500 bg-indigo-50 ring-2 ring-indigo-200",
    chip: "bg-indigo-100 text-indigo-800",
  },
  {
    key: "Compensation",
    title: "Compensation",
    hint: "A paid day given in return for extra work",
    tile: "border-slate-200 bg-white hover:border-violet-300 hover:bg-violet-50/40",
    on: "border-violet-500 bg-violet-50 ring-2 ring-violet-200",
    chip: "bg-violet-100 text-violet-800",
  },
  {
    key: "Other",
    title: "Not worked",
    hint: "Absent, on leave or a holiday",
    tile: "border-slate-200 bg-white hover:border-slate-400 hover:bg-slate-50",
    on: "border-slate-600 bg-slate-100 ring-2 ring-slate-300",
    chip: "bg-slate-200 text-slate-700",
  },
];

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
        <ol className="mt-4" aria-label="Punches in order">
          {punches.map((p, i) => {
            const Src = SOURCE_ICON[p.sourceLabel] ?? CircleDot;
            const gap = i > 0 ? toMinutes(p.time) - toMinutes(punches[i - 1].time) : 0;
            return (
              <li key={p.id} data-testid="pd-day-punch" className="relative pl-7">
                {i > 0 && (
                  <p className="-mt-0.5 mb-1 ml-0.5 text-[11px] text-slate-400">
                    {gap >= 1 ? `${span(gap)} later` : "same minute"}
                  </p>
                )}
                {/* the line, and the dot of this punch */}
                {i < punches.length - 1 && (
                  <span className="absolute bottom-[-0.75rem] left-[0.6rem] top-5 w-px bg-slate-200" aria-hidden />
                )}
                <span
                  className={cn(
                    "absolute left-1 top-[0.15rem] h-3 w-3 rounded-full border-2 border-white shadow-sm ring-1",
                    p.type === "IN" ? "bg-emerald-500 ring-emerald-300" : "bg-orange-500 ring-orange-300",
                    i > 0 && "top-[1.45rem]",
                  )}
                  aria-hidden
                />
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pb-3">
                  <span className="font-mono text-base font-bold tabular-nums text-slate-900">{p.time}</span>
                  <span
                    className={cn(
                      "rounded-md px-1.5 py-0.5 text-[11px] font-bold",
                      p.type === "IN" ? "bg-emerald-50 text-emerald-700" : "bg-orange-50 text-orange-700",
                    )}
                  >
                    {p.type === "IN" ? "In" : "Out"}
                  </span>
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

      <ol className="mt-4 space-y-0">
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
    <li className="relative flex gap-3 pb-4 last:pb-0">
      {!last && <span className="absolute bottom-0 left-[0.9rem] top-8 w-px bg-slate-200" aria-hidden />}
      <span
        className={cn("z-[1] flex h-7 w-7 shrink-0 items-center justify-center rounded-full ring-4", ROUTE_TONE[tone])}
      >
        <Ico size={13} />
      </span>
      <div className="min-w-0 flex-1 pt-0.5">{children}</div>
    </li>
  );
}

function TypeTile({
  t,
  group,
  chosen,
  onChoose,
}: {
  t: AttendanceEditType;
  group: (typeof GROUPS)[number];
  chosen: boolean;
  onChoose: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={chosen}
      data-testid={`pd-edit-type-${t.key}`}
      onClick={onChoose}
      title={t.description}
      className={cn(
        "relative flex min-h-[3.5rem] flex-col items-start justify-between gap-1.5 rounded-xl border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400",
        chosen ? group.on : group.tile,
      )}
    >
      <span className="text-sm font-bold text-slate-900">{t.label}</span>
      <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums", group.chip)}>
        {t.shiftChoices.length ? "0.25 to 1.00 shift" : `${t.shifts} shift`}
      </span>
      {chosen && (
        <span className="absolute right-2 top-2 flex h-4 w-4 items-center justify-center rounded-full bg-slate-900 text-white">
          <Check size={10} />
        </span>
      )}
    </button>
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
 * same pipeline as the Attendance page's edit page). Shows nothing for a login that has no access to Attendance.
 */
export function DayAttendanceEdit({ employeeId, date, accent }: { employeeId: number; date: string; accent: Accent }) {
  const { toast } = useToast();
  const ctx = useAttendanceEditContext(employeeId, date);
  const submit = useSubmitAttendanceEdit();
  const [open, setOpen] = useState(false);
  const [typeKey, setTypeKey] = useState<string | null>(null);
  const [shifts, setShifts] = useState("1.00");
  const [firstIn, setFirstIn] = useState("");
  const [lastOut, setLastOut] = useState("");
  const [late, setLate] = useState(false);
  const [earlyOut, setEarlyOut] = useState(false);
  const [note, setNote] = useState("");

  const data = ctx.data;
  const types = useMemo(() => data?.types ?? [], [data]);
  const selected = types.find((t) => t.key === typeKey) ?? null;
  const day = data?.day;

  // a different day starts with a closed, empty form
  useEffect(() => {
    setOpen(false);
    setTypeKey(null);
    setNote("");
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
  const canSend = !!selected && reasonOk && !noHod && !data.future && !submit.isPending;

  const choose = (t: AttendanceEditType) => {
    setTypeKey(t.key);
    setShifts(t.shifts);
  };

  const send = async () => {
    if (!selected) return;
    try {
      await submit.mutateAsync({
        employeeId,
        date,
        type: selected.key,
        note: note.trim(),
        shifts: selected.shiftChoices.length ? shifts : undefined,
        firstPunch: selected.worked ? firstIn || null : null,
        lastPunch: selected.worked ? lastOut || null : null,
        isLate: selected.worked ? late : false,
        isEarlyOut: selected.worked ? earlyOut : false,
      });
      toast({
        title: "Sent for approval",
        description: `${selected.label} for ${date} goes to ${data.hod?.name ?? "the Department Head"} first, then to HR. The attendance does not change until both approve.`,
      });
      setOpen(false);
      setTypeKey(null);
      setNote("");
    } catch (e) {
      toast({
        title: "Could not send",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    }
  };

  return (
    <div className="mt-4 space-y-4 border-t border-slate-200 pt-4" data-testid="pd-day-edit">
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
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
            {/* 1. what the day should be */}
            {GROUPS.map((g) => {
              const items = types.filter((t) => t.group === g.key);
              if (items.length === 0) return null;
              return (
                <div key={g.key} role="group" aria-label={g.title}>
                  <div className="mb-2 flex flex-wrap items-baseline gap-x-2">
                    <h5 className="text-sm font-bold text-slate-800">{g.title}</h5>
                    <span className="text-xs text-slate-500">{g.hint}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
                    {items.map((t) => (
                      <TypeTile key={t.key} t={t} group={g} chosen={typeKey === t.key} onChoose={() => choose(t)} />
                    ))}
                  </div>
                </div>
              );
            })}

            {/* 2. the details of the chosen type */}
            {selected && (
              <div className="space-y-4 rounded-xl bg-slate-50 p-4" data-testid="pd-day-edit-details">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-bold text-slate-900">{selected.label}</span>
                  <span className="text-xs text-slate-500">{selected.description}</span>
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

                {selected.worked && (
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
                onChange={(e) => setNote(e.target.value)}
                placeholder="e.g. CCTV verified: the device missed the punch"
                data-testid="pd-edit-reason"
              />
            </label>
          </div>

          <footer className="flex flex-wrap items-center gap-3 border-t border-slate-100 bg-slate-50/60 px-4 py-3">
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
            <p className="min-w-0 flex-1 text-xs text-slate-500" aria-live="polite">
              {noHod
                ? "Assign a Department Head to send this."
                : !selected
                  ? "Choose what the day should be."
                  : !reasonOk
                    ? "Write the reason to send it."
                    : `Goes to ${data.hod?.name} first, then to HR. The payroll is not recalculated: generate it again once approved.`}
            </p>
          </footer>
        </section>
      )}
    </div>
  );
}

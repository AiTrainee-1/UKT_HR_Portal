import { useState } from "react";
import { Award, CalendarDays, FileCheck, LogOut, TrendingUp, UserPlus, type LucideIcon } from "lucide-react";
import AskAiButton from "@/components/md/kit/AskAiButton";
import ProvenanceButton from "@/components/md/kit/ProvenanceButton";
import { CircleLoader } from "@/components/ui/CircleLoader";
import { ErrorBanner } from "@/components/md/kit/states";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { describeMdError, useMdQuery } from "@/lib/api-client/custom-hooks/md";
import { dayLong, num, pct } from "@/lib/md/format";
import { cn } from "@/lib/utils";
import { attendanceTone, personQuestion } from "./logic";
import { Chip, Fact, PersonAvatar, StatusChip } from "./parts";
import type { EmployeeProfile, ProfileEvent } from "./types";

const EVENT_ICON: Record<ProfileEvent["type"], { icon: LucideIcon; tone: string }> = {
  joined: { icon: UserPlus, tone: "bg-emerald-100 text-emerald-700" },
  promotion: { icon: Award, tone: "bg-amber-100 text-amber-700" },
  increment: { icon: TrendingUp, tone: "bg-blue-100 text-blue-700" },
  exit: { icon: LogOut, tone: "bg-gray-200 text-gray-700" },
};

const TONE_TEXT = { good: "text-emerald-700", warn: "text-amber-700", bad: "text-red-700", none: "text-gray-500" };

function Tile({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-xl bg-[#006496]/[0.05] px-3 py-2">
      <p className={cn("text-lg font-black leading-tight text-[#1a3a4a]", tone)}>{value}</p>
      <p className="text-[10.5px] font-medium text-[#006496]/60">{label}</p>
    </div>
  );
}

function Body({ data }: { data: EmployeeProfile }) {
  const { profile: p, attendance: a, history, leaveBalance, documents } = data;
  const tone = attendanceTone(a.attendancePct);
  const typeLabel = p.type ? p.type[0].toUpperCase() + p.type.slice(1) : null;
  return (
    <div className="space-y-5" data-testid="md-employees-profile">
      <div className="flex items-start gap-3 pr-6">
        <PersonAvatar name={p.name} size="lg" />
        <div className="min-w-0 flex-1">
          <SheetTitle className="truncate text-xl font-black">{p.name}</SheetTitle>
          <SheetDescription className="mt-0.5 truncate text-[13px]">
            {[p.code, p.designation].filter(Boolean).join(" · ")}
          </SheetDescription>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <StatusChip status={p.status} />
            {typeLabel && <Chip className="border-blue-200 bg-blue-50 text-blue-700">{typeLabel}</Chip>}
            {p.leavingReason && <Chip className="border-amber-200 bg-amber-50 text-amber-800">{p.leavingReason}</Chip>}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-2xl border bg-white/70 p-4">
        <Fact label="Department">{p.department ?? "—"}</Fact>
        <Fact label="Unit">{p.unit ?? "—"}</Fact>
        <Fact label="Joined" testId="md-employees-profile-joined">
          {dayLong(p.joinDate)}
        </Fact>
        <Fact label={p.leftOn ? "Stayed" : "With us"} testId="md-employees-profile-tenure">
          {p.tenure ?? "—"}
        </Fact>
        {p.leftOn && <Fact label={p.exitApproximate ? "Left (approx.)" : "Left"}>{dayLong(p.leftOn)}</Fact>}
        {p.reportsTo && <Fact label="Reports to">{p.reportsTo}</Fact>}
        {p.ageBand && <Fact label="Age">{p.ageBand}</Fact>}
        {p.probationEnd && (
          <Fact label="Probation ends">
            {dayLong(p.probationEnd)}
            {p.confirmedOn ? " · confirmed" : ""}
          </Fact>
        )}
      </div>

      {p.leavingReasonText && (
        <div className="rounded-xl bg-amber-50 p-3 text-xs text-amber-900" data-testid="md-employees-profile-reason">
          <p className="mb-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-800/70">In their own words</p>
          {p.leavingReasonText}
        </div>
      )}

      <section data-testid="md-employees-profile-attendance">
        <h4 className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-[#006496]/60">
          <CalendarDays size={13} /> Attendance, 90 days
          <span className="font-medium normal-case tracking-normal text-[#006496]/45">
            {dayLong(a.from)} to {dayLong(a.to)}
          </span>
        </h4>
        {a.recordedDays === 0 ? (
          <p className="rounded-xl bg-gray-50 p-3 text-xs text-muted-foreground">
            No attendance has been recorded for this person in these 90 days.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-2">
              <Tile label="Attendance" value={pct(a.attendancePct)} tone={TONE_TEXT[tone]} />
              <Tile label="Present" value={num(a.presentDays)} />
              <Tile label="Half days" value={num(a.halfDays)} />
              <Tile label="Absent" value={num(a.absentDays)} />
              <Tile label="On leave" value={num(a.leaveDays)} />
              <Tile label="Late" value={num(a.lateDays)} />
            </div>
            {a.coveragePct != null && a.coveragePct < 90 && (
              <p className="mt-2 text-[11px] text-amber-800">
                Only {pct(a.coveragePct, 0)} of these days have an attendance record, so this reads low on days counted.
              </p>
            )}
          </>
        )}
      </section>

      {leaveBalance.length > 0 && (
        <section data-testid="md-employees-profile-leave">
          <h4 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-[#006496]/60">Leave balance</h4>
          <ul className="divide-y rounded-xl border bg-white/70 text-[13px]">
            {leaveBalance.map((b) => (
              <li key={b.type} className="flex items-center justify-between gap-2 px-3 py-2">
                <span className="font-medium text-[#1a3a4a]">{b.type}</span>
                <span className="text-[#006496]/70">
                  <b className="text-[#1a3a4a]">{num(b.remaining, 1)}</b> left of {num(b.allocated, 1)} · used{" "}
                  {num(b.used, 1)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section data-testid="md-employees-profile-documents">
        <h4 className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-[#006496]/60">
          <FileCheck size={13} /> Documents on file
        </h4>
        <p className="text-[13px] text-[#1a3a4a]">
          <b>{num(documents.onFile)}</b> of {num(documents.required)} required documents
        </p>
        {documents.missing.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {documents.missing.map((name) => (
              <Chip key={name} className="border-amber-200 bg-amber-50 text-amber-800">
                Missing: {name}
              </Chip>
            ))}
          </div>
        )}
      </section>

      <section data-testid="md-employees-profile-history">
        <h4 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-[#006496]/60">Their story here</h4>
        <ol className="space-y-3">
          {history.map((e, i) => {
            const { icon: Icon, tone: box } = EVENT_ICON[e.type];
            return (
              <li key={`${e.type}-${e.date}-${i}`} className="flex gap-3">
                <span className={cn("mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full", box)}>
                  <Icon size={14} />
                </span>
                <div className="min-w-0">
                  <p className="text-[13px] font-semibold text-[#1a3a4a]">{e.title}</p>
                  <p className="text-[11px] text-[#006496]/60">
                    {dayLong(e.date)}
                    {e.detail ? ` · ${e.detail}` : ""}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      </section>

      <div className="flex flex-wrap items-center gap-2 border-t pt-3">
        <AskAiButton question={personQuestion(p.name, p.code)} label={`Ask AI about ${p.name.split(" ")[0]}`} />
        <ProvenanceButton provenance={data.provenance} label="How is this worked out?" className="ml-auto" />
      </div>
    </div>
  );
}

/** One person, read-only, in a side sheet: basics, tenure, attendance, leave and their story. No pay is shown. */
export default function ProfileSheet({ employeeId, onClose }: { employeeId: number | null; onClose: () => void }) {
  // the sheet keeps showing the last person while it slides closed, instead of flashing a loader
  const [shown, setShown] = useState(employeeId);
  if (employeeId != null && employeeId !== shown) setShown(employeeId);
  const query = useMdQuery<EmployeeProfile>(`employees/employee/${shown}`, undefined, { enabled: shown != null });
  return (
    <Sheet open={employeeId != null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg" data-testid="md-employees-sheet">
        {query.isError ? (
          <div className="space-y-3 pt-6">
            <SheetTitle>Employee</SheetTitle>
            <SheetDescription className="sr-only">The employee could not be loaded.</SheetDescription>
            <ErrorBanner message={describeMdError(query.error)} onRetry={() => query.refetch()} />
          </div>
        ) : !query.data || query.isPlaceholderData ? (
          <div
            className="flex min-h-[200px] flex-col items-center justify-center gap-2"
            data-testid="md-employees-sheet-loading"
          >
            <SheetTitle className="sr-only">Employee</SheetTitle>
            <SheetDescription className="sr-only">Loading the employee.</SheetDescription>
            <CircleLoader texts={["UK Textiles", "Employee", "Loading"]} />
          </div>
        ) : (
          <Body data={query.data} />
        )}
      </SheetContent>
    </Sheet>
  );
}

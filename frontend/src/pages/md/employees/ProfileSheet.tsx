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

/** The tone of each moment in a person's story (see md-theme/areas/analytics.css): joining is good news, the rest are marks. */
const EVENT_ICON: Record<ProfileEvent["type"], { icon: LucideIcon; tone: string }> = {
  joined: { icon: UserPlus, tone: "md-analytics-tone-good" },
  promotion: { icon: Award, tone: "md-analytics-tone-watch" },
  increment: { icon: TrendingUp, tone: "md-analytics-tone-info" },
  exit: { icon: LogOut, tone: "md-analytics-tone-neutral" },
};

/** The tone a share of days present reads in: sage, ochre, crimson, and plain when it is unknown. */
const TONE_CLASS = {
  good: "md-analytics-tone-good",
  warn: "md-analytics-tone-watch",
  bad: "md-analytics-tone-bad",
  none: "",
};

function Tile({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className={cn("md-analytics-stat", tone)}>
      <p className="md-analytics-stat-value">{value}</p>
      <p className="md-analytics-stat-label">{label}</p>
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
            {typeLabel && <Chip tone="info">{typeLabel}</Chip>}
            {p.leavingReason && <Chip tone="watch">{p.leavingReason}</Chip>}
          </div>
        </div>
      </div>

      <div className="md-panel grid grid-cols-2 gap-x-4 gap-y-3 p-4">
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
        <div
          className="md-analytics-callout md-analytics-callout-block md-analytics-tone-watch"
          data-testid="md-employees-profile-reason"
        >
          <p className="mb-0.5 text-[10.5px] font-bold uppercase tracking-wider">In their own words</p>
          {p.leavingReasonText}
        </div>
      )}

      <section data-testid="md-employees-profile-attendance">
        <h4 className="md-analytics-subhead flex items-center gap-1.5">
          <CalendarDays size={13} /> Attendance, 90 days
          <span className="font-medium normal-case tracking-normal text-md-ink-soft">
            {dayLong(a.from)} to {dayLong(a.to)}
          </span>
        </h4>
        {a.recordedDays === 0 ? (
          <p className="md-panel p-3 text-xs text-md-ink-soft">
            No attendance has been recorded for this person in these 90 days.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-2">
              <Tile label="Attendance" value={pct(a.attendancePct)} tone={TONE_CLASS[tone]} />
              <Tile label="Present" value={num(a.presentDays)} />
              <Tile label="Half days" value={num(a.halfDays)} />
              <Tile label="Absent" value={num(a.absentDays)} />
              <Tile label="On leave" value={num(a.leaveDays)} />
              <Tile label="Late" value={num(a.lateDays)} />
            </div>
            {a.coveragePct != null && a.coveragePct < 90 && (
              <p className="md-analytics-callout md-analytics-tone-watch">
                Only {pct(a.coveragePct, 0)} of these days have an attendance record, so this reads low on days counted.
              </p>
            )}
          </>
        )}
      </section>

      {leaveBalance.length > 0 && (
        <section data-testid="md-employees-profile-leave">
          <h4 className="md-analytics-subhead">Leave balance</h4>
          <ul className="md-panel divide-y divide-md-line text-[13px]">
            {leaveBalance.map((b) => (
              <li key={b.type} className="flex items-center justify-between gap-2 px-3 py-2">
                <span className="font-medium text-md-ink">{b.type}</span>
                <span className="text-md-ink-soft">
                  <b className="text-md-ink">{num(b.remaining, 1)}</b> left of {num(b.allocated, 1)} · used{" "}
                  {num(b.used, 1)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section data-testid="md-employees-profile-documents">
        <h4 className="md-analytics-subhead flex items-center gap-1.5">
          <FileCheck size={13} /> Documents on file
        </h4>
        <p className="text-[13px] text-md-ink">
          <b>{num(documents.onFile)}</b> of {num(documents.required)} required documents
        </p>
        {documents.missing.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {documents.missing.map((name) => (
              <Chip key={name} tone="watch">
                Missing: {name}
              </Chip>
            ))}
          </div>
        )}
      </section>

      <section data-testid="md-employees-profile-history">
        <h4 className="md-analytics-subhead">Their story here</h4>
        <ol className="md-analytics-timeline space-y-3">
          {history.map((e, i) => {
            const { icon: Icon, tone: box } = EVENT_ICON[e.type];
            return (
              <li key={`${e.type}-${e.date}-${i}`} className="flex gap-3">
                <span
                  className={cn(
                    "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[color:var(--tone-edge)] bg-[color:var(--tone-wash)] text-[color:var(--tone-ink)]",
                    box,
                  )}
                >
                  <Icon size={14} />
                </span>
                <div className="min-w-0">
                  <p className="text-[13px] font-semibold text-md-ink">{e.title}</p>
                  <p className="text-[11px] text-md-ink-soft">
                    {dayLong(e.date)}
                    {e.detail ? ` · ${e.detail}` : ""}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      </section>

      <div className="flex flex-wrap items-center gap-2 border-t border-md-line pt-4">
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
      <SheetContent className="md-analytics-sheet w-full overflow-y-auto sm:max-w-lg" data-testid="md-employees-sheet">
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

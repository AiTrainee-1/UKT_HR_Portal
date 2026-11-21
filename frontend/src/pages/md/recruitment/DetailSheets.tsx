import { Link } from "wouter";
import { ArrowUpRight, Check, Clock, X } from "lucide-react";
import { ErrorBanner, SkeletonBlock } from "@/components/md/kit/states";
import { describeMdError, useMdQuery } from "@/lib/api-client/custom-hooks/md";
import { dayLong, num } from "@/lib/md/format";
import { cn } from "@/lib/utils";
import { DetailsSheet, Fact } from "../approvals/parts";
import { daysLeftText, daysText, plural } from "./logic";
import { Chip, MixBar, MixKey } from "./parts";
import type { GapRow, OpenPosition, ResignationDetail, ResignationStep } from "./types";

const ROLE = { hod: "Department Head", hr: "HR" } as const;

/** Where the MD opens an employee: the MD's copy of the HR employee page. */
export const employeeHref = (id: number) => `/md/employees/${id}`;

/** "21 Nov 2026, 9:50:08 am" from the server's wall-clock time (no time zone: it is already the factory's). */
function momentText(iso: string | null | undefined): string {
  if (!iso) return "Not recorded";
  const [day, time = ""] = iso.split("T");
  const [h, m, s = "00"] = time.split(":");
  if (!h) return dayLong(day);
  const hour = Number(h);
  return `${dayLong(day)}, ${hour % 12 || 12}:${m}:${s.slice(0, 2)} ${hour < 12 ? "am" : "pm"}`;
}

function Steps({ steps }: { steps: ResignationStep[] }) {
  if (steps.length === 0) return <p className="text-xs text-md-ink-soft">No approval steps recorded.</p>;
  return (
    <ol className="space-y-2" data-testid="md-recruitment-resignation-steps">
      {steps.map((st, i) => {
        const Icon = st.state === "approved" ? Check : st.state === "rejected" ? X : Clock;
        const name = st.label || st.roles.map((r) => ROLE[r as keyof typeof ROLE] ?? r).join(" or ") || "Step";
        return (
          <li key={i} className="flex gap-2.5 rounded-xl bg-white/60 px-3 py-2 text-xs">
            <span
              className={cn(
                "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full",
                st.state === "approved" && "bg-md-success-600/15 text-md-success-700",
                st.state === "rejected" && "bg-md-danger-600/15 text-md-danger-700",
                st.state !== "approved" && st.state !== "rejected" && "bg-md-ink/5 text-md-ink-soft",
              )}
            >
              <Icon size={13} aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <p className="font-bold text-md-ink">
                {name}{" "}
                <span className="font-semibold text-md-ink-soft">
                  · {st.state === "pending" ? "waiting now" : st.state}
                </span>
              </p>
              {(st.by || st.at) && (
                <p className="text-md-ink-soft">
                  {st.by && `by ${st.by}`}
                  {st.at && ` · ${dayLong(st.at.slice(0, 10))}`}
                </p>
              )}
              {st.comment && <p className="mt-0.5 text-md-ink">“{st.comment}”</p>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** One resignation in full: who, when it was raised (to the second), the last working day and notice, where it stands,
 *  every approval step with its remark, and the group of the employee's reason (never their own words). */
export function ResignationSheet({ id, onClose }: { id: number | null; onClose: () => void }) {
  const q = useMdQuery<ResignationDetail>(`recruitment/resignations/${id ?? 0}`, undefined, { enabled: id != null });
  const r = q.data?.resignation;
  return (
    <DetailsSheet
      open={id != null}
      onClose={onClose}
      title={r ? `Resignation · ${r.employeeName}` : "Resignation"}
      subtitle={r ? [r.department, r.designation].filter(Boolean).join(" · ") : undefined}
      testId="md-recruitment-resignation-sheet"
    >
      {q.isError ? (
        <ErrorBanner message={describeMdError(q.error)} onRetry={() => q.refetch()} />
      ) : !r ? (
        <SkeletonBlock rows={4} />
      ) : (
        <div className="space-y-4" data-testid="md-recruitment-resignation">
          <div className="flex flex-wrap items-center gap-2">
            <Chip tone={r.status === "approved" ? "green" : r.status === "rejected" ? "red" : "amber"}>
              {r.status === "pending"
                ? `Waiting for ${r.waitingForText}`
                : r.status === "approved"
                  ? "Approved"
                  : "Rejected"}
            </Chip>
            {r.daysWaiting != null && <Chip>waiting {daysText(r.daysWaiting)}</Chip>}
          </div>
          <div className="grid grid-cols-2 gap-3 rounded-2xl border border-white/80 bg-white/55 p-3.5">
            <Fact label="Request date">{dayLong(r.requestedOn)}</Fact>
            <Fact label="Last working day">
              {r.lastWorkingDate ? dayLong(r.lastWorkingDate) : "Not given"}
              {r.daysToLastDay != null && r.daysToLastDay >= 0 && (
                <span className="block text-xs font-medium text-md-ink-soft">{daysLeftText(r.daysToLastDay)}</span>
              )}
            </Fact>
            <Fact label="Submitted at" wide>
              <span className="tabular-nums">{momentText(r.submittedAt)}</span>
            </Fact>
            <Fact label="Notice given">{r.noticeDays != null ? plural(r.noticeDays, "day") : "—"}</Fact>
            <Fact label="Service">
              {r.serviceDays != null ? daysText(r.serviceDays) : "—"}
              {r.joinDate && (
                <span className="block text-xs font-medium text-md-ink-soft">joined {dayLong(r.joinDate)}</span>
              )}
            </Fact>
            <Fact label="Reason (group)" wide>
              {r.reasonGroup.label}
              <span className="block text-xs font-medium text-md-ink-soft">
                The employee's own words are kept on HR's Resignations page.
              </span>
            </Fact>
          </div>
          {r.decision && (
            <p
              className={cn(
                "rounded-lg px-3 py-2 text-xs leading-relaxed",
                r.decision.status === "rejected"
                  ? "bg-md-danger-600/[0.06] text-md-danger-800"
                  : "bg-md-success-600/[0.06] text-md-success-800",
              )}
              data-testid="md-recruitment-resignation-decision"
            >
              <b>
                {r.decision.status === "rejected" ? "Rejected" : "Approved"}
                {r.decision.decidedBy ? ` by ${r.decision.decidedBy}` : ""} ({r.decision.stage})
                {r.decision.decidedOn ? `, ${dayLong(r.decision.decidedOn)}` : ""}
              </b>
              {r.decision.remark ? ` · “${r.decision.remark}”` : ""}
            </p>
          )}
          <div>
            <p className="mb-2 text-[11px] font-bold uppercase tracking-wide text-md-ink-soft">Approval steps</p>
            <Steps steps={r.steps} />
          </div>
          <Link href={employeeHref(r.employeeId)} className="md-btn md-btn-soft md-btn-sm">
            Open {r.employeeName.split(" ")[0]}'s employee page <ArrowUpRight size={13} aria-hidden="true" />
          </Link>
        </div>
      )}
    </DetailsSheet>
  );
}

/** One open position: its department and unit, how long it has been open, its applicants by stage, the salary range,
 *  and the department's staffing gap against the plan. Everything comes from the positions answer already on screen. */
export function PositionSheet({
  position,
  gap,
  staleAfter,
  onClose,
}: {
  position: OpenPosition | null;
  gap: GapRow | undefined;
  staleAfter: number;
  onClose: () => void;
}) {
  const p = position;
  return (
    <DetailsSheet
      open={!!p}
      onClose={onClose}
      title={p ? p.title : "Position"}
      subtitle={p ? [p.department, p.unit].filter(Boolean).join(" · ") || "No department" : undefined}
      testId="md-recruitment-position-sheet"
    >
      {p && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 rounded-2xl border border-white/80 bg-white/55 p-3.5">
            <Fact label="Posted">{dayLong(p.postedOn)}</Fact>
            <Fact label="Open for">
              {daysText(p.daysOpen)} {p.stale && <Chip tone="red">Stale</Chip>}
              <span className="block text-xs font-medium text-md-ink-soft">stale after {staleAfter} days</span>
            </Fact>
            <Fact label="Applicants">{num(p.applicants)}</Fact>
            <Fact label="Salary range">{p.salaryRange || "Not given"}</Fact>
            <Fact label="Applicants by stage" wide>
              <span className="mt-1 block">
                <MixBar mix={p.stageMix} />
              </span>
              <span className="mt-1.5 block text-xs font-medium text-md-ink-soft">
                {num(p.stageMix.applied)} applied · {num(p.stageMix.attended)} interviewed · {num(p.stageMix.selected)}{" "}
                selected · {num(p.stageMix.rejected)} rejected
              </span>
            </Fact>
          </div>
          <MixKey />
          {gap ? (
            <div
              className="rounded-2xl border border-white/80 bg-white/55 p-3.5 text-xs"
              data-testid="md-recruitment-position-gap"
            >
              <p className="font-bold text-md-ink">{gap.department} against the staffing plan</p>
              <p className="mt-1 text-md-ink-soft">
                {num(gap.current)} of {num(gap.required)} required staff
                {gap.vacancy > 0 ? ` · ${plural(gap.vacancy, "vacancy", "vacancies")}` : " · fully staffed"}
                {gap.openJobs ? ` · ${plural(gap.openJobs, "open posting")}` : ""}
              </p>
            </div>
          ) : (
            <p className="text-xs text-md-ink-soft">No staffing plan is set for this position's department.</p>
          )}
        </div>
      )}
    </DetailsSheet>
  );
}

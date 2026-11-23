import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  BadgeCheck,
  CheckCircle2,
  CircleDashed,
  Landmark,
  Loader2,
  SearchX,
  UserX,
  Wallet,
  X,
  type LucideIcon,
} from "lucide-react";
import { Chip, EmptyNote } from "@/components/payroll/kit/parts";
import { dateShort, dateTime, inr } from "@/components/payroll/kit/format";
import { Button } from "@/components/ui/button";
import type { Tone } from "@/lib/statusTones";
import type { MissedCategory, MissedKind, MissedRow, MissedStatus } from "@/lib/api-client/custom-hooks/missed-payroll";
import { Panel } from "../salary-slip-center/parts";
import { STATUS_LABEL, employeeCount, isActive, leftOutByReason, type EmptyInfo, type ResultReport } from "./logic";
import type { BankReview } from "./useMissedJobs";

export const CATEGORY_TONE: Record<MissedCategory, Tone> = {
  not_generated: "info",
  no_salary: "warning",
  on_hold: "caution",
  new_joiner: "accent",
  not_cleared: "neutral",
  inactive: "neutral",
};

/** Why the payroll missed the row, as a pill. */
export function CategoryChip({ category, label }: { category: MissedCategory; label: string }) {
  return (
    <Chip tone={CATEGORY_TONE[category] ?? "neutral"} className="px-1.5 py-0 text-[10px] uppercase tracking-wide">
      {label}
    </Chip>
  );
}

export const STATUS_TONE: Record<MissedStatus, Tone> = {
  generated: "info",
  cleared: "accent",
  done: "success",
  paid: "success",
};

const STATUS_ICON: Record<MissedStatus, LucideIcon> = {
  generated: CircleDashed,
  cleared: CheckCircle2,
  done: BadgeCheck,
  paid: Wallet,
};

/** Generated / Cleared / Done / Paid. */
export function StatusChip({ status, title }: { status: MissedStatus; title?: string }) {
  return (
    <Chip tone={STATUS_TONE[status] ?? "neutral"} icon={STATUS_ICON[status]} title={title}>
      {STATUS_LABEL[status] ?? status}
    </Chip>
  );
}

/** INACTIVE beside a name in the views that are not only inactive employees. */
export function RowBadges({ row }: { row: MissedRow }) {
  return !isActive(row) ? (
    <Chip tone="neutral" icon={UserX} title="Inactive employee" className="px-1.5 py-0 text-[10px]">
      INACTIVE
    </Chip>
  ) : null;
}

/** "₹25,000 / month" or "₹650 / shift"; amber "Not set" when the profile has no salary. */
export function SalaryCell({ row, kind }: { row: MissedRow; kind: MissedKind }) {
  if (!row.salary) {
    return (
      <Chip tone="warning" icon={AlertTriangle} title="No salary on the profile: nothing can be worked out">
        Not set
      </Chip>
    );
  }
  return (
    <span className="whitespace-nowrap tabular-nums">
      <span className="font-semibold text-gray-900">{inr(row.salary, Number.isInteger(row.salary) ? 0 : 2)}</span>
      <span className="text-xs text-gray-400"> / {kind === "production" ? "shift" : "month"}</span>
    </span>
  );
}

/** Ready for a bank file, or what keeps them out of it. */
export function BankCell({ row }: { row: MissedRow }) {
  if (row.bankIssue) {
    return (
      <Chip tone="danger" icon={Landmark} title={`${row.bankIssue}: left out of the bank file`}>
        {row.bankIssue}
      </Chip>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700">
      <CheckCircle2 size={12} /> Bank details set
    </span>
  );
}

/** Production: the days no payroll pays yet, and how many of them were worked. */
export function PayDaysCell({ row }: { row: MissedRow }) {
  const entryRanges = row.entry?.payRanges ?? [];
  if (!row.payDays && entryRanges.length === 0) return <span className="text-gray-400">—</span>;
  const text = row.payDays?.text || entryRanges.map(([a, b]) => `${dateShort(a)} - ${dateShort(b)}`).join(", ");
  return (
    <div className="min-w-0 leading-tight">
      <p className="text-xs text-gray-800">{text || "No days"}</p>
      {row.payDays && (
        <p className="text-[11px] text-gray-500">
          {row.payDays.days} day{row.payDays.days === 1 ? "" : "s"} · worked {row.payDays.worked}
        </p>
      )}
    </div>
  );
}

/** Who moved the entry along, for the status chip's hover text. */
export function entryTrail(row: MissedRow): string {
  const e = row.entry;
  if (!e) return "";
  const step = (label: string, at: string | null, by: string | null) =>
    at ? `${label} ${dateTime(at)}${by ? ` by ${by}` : ""}` : "";
  return [
    step("Generated", e.generatedAt, e.generatedBy),
    step("Cleared", e.clearedAt, e.clearedBy),
    step("Done", e.doneAt, e.doneBy),
    e.paidOn ? `Paid on ${dateShort(e.paidOn)}${e.paidBy ? ` (marked by ${e.paidBy})` : ""}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** The entry's status and Net; or Not generated, with why it cannot be when it cannot. */
export function EntryCell({ row }: { row: MissedRow }) {
  if (row.entry) {
    return (
      <div className="flex flex-col items-start gap-1">
        <StatusChip status={row.entry.status} title={entryTrail(row)} />
        <p className="text-sm font-bold tabular-nums text-gray-900">
          {inr(row.entry.net)} <span className="text-[11px] font-medium text-gray-400">net</span>
        </p>
        {row.entry.status === "paid" && row.entry.paidOn && (
          <p className="text-[11px] text-gray-500">Paid on {dateShort(row.entry.paidOn)}</p>
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-col items-start gap-1">
      <span className="inline-flex items-center gap-1 text-xs font-medium text-gray-500">
        <CircleDashed size={12} /> Not generated
      </span>
      {!row.canGenerate && row.cannotGenerate && (
        <p className="max-w-[220px] text-[11px] leading-snug text-amber-800">{row.cannotGenerate}</p>
      )}
    </div>
  );
}

/** Why the list is empty, with the way out. */
export function EmptyState({
  info,
  onClear,
  onPrevious,
}: {
  info: EmptyInfo;
  onClear: () => void;
  onPrevious: () => void;
}) {
  const action =
    info.action === "clear" ? (
      <Button variant="outline" size="sm" className="mt-1" onClick={onClear}>
        Clear filters
      </Button>
    ) : info.action === "previous" ? (
      <Button variant="outline" size="sm" className="mt-1" onClick={onPrevious}>
        Open the previous month
      </Button>
    ) : null;
  return (
    <EmptyNote
      icon={info.action === "clear" ? SearchX : BadgeCheck}
      title={info.title}
      hint={info.hint}
      action={action}
      className="bg-white"
      testId="mp-empty"
    />
  );
}

/** Who an action did not change and why (the server's own reasons), and whether it stopped early. */
export function ResultPanel({ report, onClose }: { report: ResultReport; onClose: () => void }) {
  return (
    <Panel tone="amber" testId="mp-result">
      <div className="flex items-start gap-2" role="status" aria-live="polite">
        <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-600" />
        <div className="min-w-0 flex-1 space-y-1.5">
          {report.items.length > 0 && (
            <p className="text-sm font-semibold text-amber-950" data-testid="mp-result-title">
              {report.title}
            </p>
          )}
          {report.failed && (
            <p className="text-sm text-red-800" data-testid="mp-result-failed">
              Stopped early{report.notRun > 0 ? ` (${employeeCount(report.notRun)} not done)` : ""}: {report.failed}
            </p>
          )}
          {report.items.length > 0 && (
            <ul className="max-h-48 space-y-1 overflow-y-auto pr-1 text-xs text-amber-950">
              {report.items.map((s, i) => (
                <li key={`${s.employeeId}-${i}`} className="flex flex-wrap gap-x-2" data-testid="mp-result-item">
                  <span className="font-mono text-amber-800">{s.employeeCode}</span>
                  <span className="font-semibold">{s.name}</span>
                  <span className="text-amber-800">— {s.reason}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={onClose} aria-label="Close this list">
          <X size={14} />
        </Button>
      </div>
    </Panel>
  );
}

/**
 * The bank check, in the page: who the bank file pays (Done, not yet paid, with bank details) and its total, and who it
 * leaves out and why. Nothing is downloaded until "Download bank file" is pressed.
 */
export function BankReviewPanel({
  review,
  period,
  busy,
  onConfirm,
  onCancel,
}: {
  review: BankReview;
  period: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { check } = review;
  const ref = useRef<HTMLDivElement>(null);
  const [showAll, setShowAll] = useState(false);
  const reasons = leftOutByReason(check);
  const included = check.included.length;
  const listed = showAll ? check.leftOut : check.leftOut.slice(0, 8);

  useEffect(() => {
    ref.current?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
  }, []);

  return (
    <div ref={ref}>
      <Panel tone={included > 0 ? "emerald" : "red"} testId="mp-bank-review">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 rounded-xl bg-white/70 p-2 text-emerald-700">
            <Landmark size={16} />
          </span>
          <div className="min-w-0 flex-1 space-y-2">
            <div>
              <p className="text-sm font-bold text-gray-900">Missed payroll bank file for {period}</p>
              {included > 0 ? (
                <p className="text-sm text-gray-700" data-testid="mp-bank-included">
                  <CheckCircle2 size={13} className="mr-1 inline text-emerald-600" />
                  {employeeCount(included)} will be paid by bank transfer, total{" "}
                  <span className="font-bold tabular-nums text-gray-900">{inr(check.total, 2)}</span>. After the bank
                  pays them, mark them Paid here.
                </p>
              ) : (
                <p className="text-sm font-semibold text-red-800" data-testid="mp-bank-none">
                  Nobody in this selection can be paid yet: only employees marked Done (not yet paid) with bank details
                  are in the bank file.
                </p>
              )}
            </div>

            {check.leftOut.length > 0 && (
              <div className="space-y-1.5 rounded-xl bg-white/70 p-2.5" data-testid="mp-bank-left-out">
                <p className="text-xs font-semibold text-gray-800">
                  {employeeCount(check.leftOut.length)} left out:{" "}
                  <span className="font-normal text-gray-600">
                    {reasons.map((r) => `${r.reason} (${r.count})`).join(" · ")}
                  </span>
                </p>
                <ul className="max-h-48 space-y-0.5 overflow-y-auto pr-1 text-xs text-gray-700">
                  {listed.map((row) => (
                    <li key={row.employeeId} className="flex flex-wrap gap-x-2">
                      <span className="font-mono text-gray-500">{row.code}</span>
                      <span className="font-medium">{row.name}</span>
                      <span className="text-gray-500">— {row.reason}</span>
                    </li>
                  ))}
                </ul>
                {check.leftOut.length > listed.length && (
                  <button
                    type="button"
                    className="text-xs font-semibold text-indigo-600 hover:underline"
                    onClick={() => setShowAll(true)}
                  >
                    Show all {check.leftOut.length}
                  </button>
                )}
              </div>
            )}

            <div className="flex flex-wrap gap-2 pt-1">
              <Button
                size="sm"
                className="gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700"
                disabled={busy || included === 0}
                onClick={onConfirm}
                data-testid="mp-bank-confirm"
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Landmark size={14} />}
                Download bank file ({employeeCount(included)})
              </Button>
              <Button size="sm" variant="outline" className="bg-white" onClick={onCancel} disabled={busy}>
                Cancel
              </Button>
            </div>
          </div>
        </div>
      </Panel>
    </div>
  );
}

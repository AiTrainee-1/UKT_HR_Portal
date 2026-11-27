import { useMemo, useState } from "react";
import { Link } from "wouter";
import {
  AlertOctagon,
  AlertTriangle,
  ArrowRight,
  Banknote,
  CheckCircle2,
  Hourglass,
  Inbox,
  Landmark,
  Plus,
  Settings2,
  XCircle,
} from "lucide-react";
import HrLayout from "@/components/HrLayout";
import { useUrlParams } from "@/components/payroll/kit/url-state";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useSettlementOverview,
  type SettlementAdvanceType,
  type SettlementOverviewType,
} from "@/lib/api-client/custom-hooks/settlement-automation";
import { cn } from "@/lib/utils";
import NewRequestDialog from "../NewRequestDialog";
import PageHeading from "../PageHeading";
import { EmptyState } from "../parts";
import { loanAdvancePath } from "../routes";
import { formatMoney } from "../shared";
import { monthFromUrl, monthText, monthToUrl, type MonthRef } from "./logic";
import MonthSwitcher from "./MonthSwitcher";
import { roundedTotalOf } from "./rounding";
import { CompactTracker } from "./Tracker";

/** The address: the month ("" = this month in India). Module-level: useUrlParams needs one identity. */
const URL_DEFAULTS = { month: "", year: "" };

const TYPE_ICON: Record<SettlementAdvanceType, typeof Banknote> = { general: Banknote, term: Landmark };
const TYPE_TONE: Record<SettlementAdvanceType, string> = {
  general: "bg-emerald-50 text-emerald-700",
  term: "bg-violet-50 text-violet-700",
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** One small figure of a panel: a link to the type's page with those requests listed (owner 2026-11-27). */
function Figure({
  label,
  value,
  icon: Icon,
  tone,
  testId,
  href,
}: {
  label: string;
  value: string | number;
  icon: typeof Inbox;
  tone: string;
  testId: string;
  href: string;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "flex items-center gap-2 rounded-xl px-3 py-2 transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300",
        tone,
      )}
      title={`Show the ${label.toLowerCase()} requests`}
      data-testid={testId}
    >
      <Icon size={14} className="shrink-0" aria-hidden />
      <div className="min-w-0">
        <p className="text-[11px] font-medium leading-tight opacity-75">{label}</p>
        <p className="text-lg font-black leading-tight" data-testid={`${testId}-value`}>
          {value}
        </p>
      </div>
    </Link>
  );
}

/** One type's month at a glance: its current batch's stage, what to do next, the tracker, the counts and amounts, and the
 *  way to its own page (where the work is done). */
function TypePanel({ t, period }: { t: SettlementOverviewType; period: MonthRef }) {
  const b = t.currentBatch;
  const Icon = TYPE_ICON[t.advanceType];
  const month = monthToUrl(period);
  const href = `${loanAdvancePath(t.advanceType)}${month.month ? `?month=${month.month}&year=${month.year}` : ""}`;
  // a figure or a tracker stage opens the type's page with those requests listed under its tracker
  const focusHref = (focus: string) => {
    const q = new URLSearchParams({ ...(month.month ? { month: month.month, year: month.year } : {}), focus });
    return `${loanAdvancePath(t.advanceType)}?${q.toString()}`;
  };
  const id = t.advanceType;
  const next = b?.nextAction || t.tracker.find((s) => s.state === "current")?.action || "";
  const flags = b ? b.counts.critical + b.counts.warning : 0;
  return (
    <Card className="flex flex-col rounded-2xl" data-testid={`overview-panel-${id}`}>
      <CardContent className="flex flex-1 flex-col gap-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <span className={cn("rounded-xl p-2", TYPE_TONE[t.advanceType])}>
              <Icon size={18} aria-hidden />
            </span>
            <div>
              <h3 className="text-base font-black text-slate-900">{t.label}</h3>
              <p className="text-xs text-slate-500" data-testid={`overview-month-${id}`}>
                {plural(t.received, "request")} in {monthText(period)} · {plural(t.batchCount, "batch", "batches")} ·{" "}
                {t.completed} completed · {t.waitingForMd} waiting for the MD
              </p>
            </div>
          </div>
          <span
            className={cn(
              "rounded-full border px-2.5 py-0.5 text-[11px] font-bold",
              !b
                ? "border-slate-200 bg-slate-50 text-slate-500"
                : b.stage === "completed"
                  ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                  : "border-indigo-200 bg-indigo-50 text-indigo-700",
            )}
            data-testid={`overview-stage-${id}`}
          >
            {b ? `${b.label} · ${b.stage === "completed" ? "Completed" : b.stageLabel}` : "No requests yet"}
          </span>
        </div>

        {b ? (
          <>
            {next && (
              <p
                className="rounded-xl border border-indigo-100 bg-indigo-50 px-3 py-2 text-[13px] text-indigo-900"
                data-testid={`overview-next-${id}`}
              >
                <b>What to do next: </b>
                {next}
              </p>
            )}
            <CompactTracker
              steps={t.tracker}
              label={`${t.label} workflow`}
              testId={`overview-tracker-${id}`}
              linkOf={focusHref}
            />
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Figure
                label="Received"
                value={b.counts.total}
                icon={Inbox}
                tone="bg-slate-100 text-slate-800"
                testId={`overview-received-${id}`}
                href={focusHref("all")}
              />
              <Figure
                label="Approved"
                value={b.counts.approved}
                icon={CheckCircle2}
                tone="bg-green-50 text-green-800"
                testId={`overview-approved-${id}`}
                href={focusHref("approved")}
              />
              <Figure
                label="Rejected"
                value={b.counts.rejected}
                icon={XCircle}
                tone="bg-red-50 text-red-800"
                testId={`overview-rejected-${id}`}
                href={focusHref("rejected")}
              />
              <Figure
                label="Pending"
                value={b.counts.undecided}
                icon={Hourglass}
                tone="bg-amber-50 text-amber-800"
                testId={`overview-pending-${id}`}
                href={focusHref("pending")}
              />
            </div>
            <Link
              href={focusHref("leave")}
              className={cn(
                "flex w-fit items-center gap-1.5 rounded-lg text-xs font-semibold hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300",
                b.counts.critical > 0 ? "text-red-700" : b.counts.warning > 0 ? "text-orange-700" : "text-slate-500",
              )}
              data-testid={`overview-leave-${id}`}
            >
              {b.counts.critical > 0 ? <AlertOctagon size={13} aria-hidden /> : <AlertTriangle size={13} aria-hidden />}
              {flags === 0
                ? "No leave flags"
                : `Leave flags: ${b.counts.critical} critical · ${b.counts.warning} warning`}
            </Link>
            <dl
              className="grid grid-cols-3 gap-2 rounded-xl bg-slate-50 p-3 text-xs"
              data-testid={`overview-amounts-${id}`}
            >
              <div>
                <dt className="text-slate-500">Requested</dt>
                <dd className="font-bold text-slate-900">{formatMoney(b.amounts.requested)}</dd>
                {roundedTotalOf(b) != null && (
                  <dd className="text-[11px] text-slate-500" data-testid={`overview-rounded-${id}`}>
                    Rounded total {formatMoney(roundedTotalOf(b))}
                  </dd>
                )}
              </div>
              <div>
                <dt className="text-slate-500">MD approved</dt>
                <dd className="font-bold text-violet-800">{formatMoney(b.amounts.mdApproved)}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Final approved</dt>
                <dd className="font-bold text-emerald-800">{formatMoney(b.amounts.finalApproved)}</dd>
              </div>
            </dl>
          </>
        ) : (
          <p className="rounded-xl bg-slate-50 p-3 text-sm text-slate-600" data-testid={`overview-empty-${id}`}>
            No {t.label} request raised in {monthText(period)} is in the workflow yet. Each one joins the month&apos;s
            open {t.label} batch as it arrives.
          </p>
        )}

        <div className="mt-auto flex justify-end">
          <Button asChild variant="outline" className="h-9 gap-1.5" data-view-safe>
            <Link href={href} data-testid={`overview-open-${id}`}>
              Open {t.label} <ArrowRight size={14} aria-hidden />
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Loan & Advance, Automation Method, the main page (owner 2026-11-27): Salary Advance and Term Loan run their own
 * workflows, so this is where both stand in the month, side by side, with the way to each type's own page (from the
 * sidebar too). No tabs: one panel per type. The month is a select (this month in India by default).
 */
export default function AutomationOverview() {
  const [url, setUrl] = useUrlParams(URL_DEFAULTS);
  const period = useMemo(() => monthFromUrl(url.month, url.year), [url.month, url.year]);
  const { data, isLoading, isError, refetch, isFetching } = useSettlementOverview(period.month, period.year);
  const [showNew, setShowNew] = useState(false);

  return (
    <HrLayout>
      <div className="min-w-0 space-y-5" data-ui-area="payroll" data-testid="settlement-automation-overview">
        <PageHeading
          page="overview"
          automation
          actions={
            <>
              <Link
                href="/hr/settings?tab=settlement"
                className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                data-testid="auto-settings-link"
              >
                <Settings2 size={14} aria-hidden /> Method and e-mails
              </Link>
              <Button className="h-9 gap-2" onClick={() => setShowNew(true)} data-testid="new-advance">
                <Plus size={15} /> New request
              </Button>
            </>
          }
        >
          Salary Advances and Term Loans each go through their own workflow: HR review, the MD&apos;s approval,
          HR&apos;s final settlement, the auditor and the bank file for Accounts. Here is where both stand; open a type
          to work on it.
        </PageHeading>

        <div className="flex flex-wrap items-center gap-3" data-testid="overview-filters">
          <MonthSwitcher value={period} onChange={(next) => setUrl(monthToUrl(next))} />
          {isFetching && !isLoading && <span className="text-[11px] text-slate-400">Refreshing…</span>}
        </div>

        {isLoading ? (
          <div className="grid gap-4 xl:grid-cols-2" data-testid="overview-loading">
            <Skeleton className="h-80 w-full rounded-2xl" />
            <Skeleton className="h-80 w-full rounded-2xl" />
          </div>
        ) : isError || !data ? (
          <Card className="rounded-2xl">
            <CardContent className="p-0">
              <EmptyState
                icon={AlertTriangle}
                tone="bg-red-50 text-red-600"
                title="The Loan & Advance overview could not be loaded"
                text="Check your connection and try again."
                testId="overview-error"
              >
                <Button variant="outline" onClick={() => void refetch()}>
                  Retry
                </Button>
              </EmptyState>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 xl:grid-cols-2" data-testid="overview-panels">
            {data.types.map((t) => (
              <TypePanel key={t.advanceType} t={t} period={period} />
            ))}
          </div>
        )}

        {/* a new request joins this month's open batch of its type: the overview then shows this month */}
        <NewRequestDialog
          open={showNew}
          onClose={() => setShowNew(false)}
          fixedType={null}
          onCreated={() => setUrl({ month: "", year: "" })}
        />
      </div>
    </HrLayout>
  );
}

import { useEffect } from "react";
import { ClipboardList, HandCoins, History, Inbox, LayoutDashboard } from "lucide-react";
import MdPageHeader from "@/components/md/kit/MdPageHeader";
import { MonthPicker, monthLabel, parseMonthKey, type MonthKey } from "@/components/md/kit/MonthPicker";
import { EmptyBlock, ErrorBanner, NoteBanner, SkeletonBlock } from "@/components/md/kit/states";
import MdLayout from "@/components/md/MdLayout";
import { describeMdError } from "@/lib/api-client/custom-hooks/md";
import { usePublishAssistantContext } from "@/lib/md/assistant-store";
import { useUrlParams } from "@/lib/md/url-filters";
import { useSettlementMonth, useSettlementWaiting } from "./settlement/api";
import BatchView from "./settlement/BatchView";
import {
  batchOptionLabel,
  batchTitle,
  defaultType,
  istMonthKey,
  monthFromQuery,
  money,
  pickBatch,
  TYPE_LABEL,
  typeFromQuery,
  typeOptions,
  viewFromQuery,
  waitingElsewhere,
  waitingInMonth,
  type SettlementView,
} from "./settlement/logic";
import { PageTabs, SelectField, type PageTab } from "./settlement/parts";
import type { SettlementBatch } from "./settlement/types";
import WaitingBanner from "./settlement/WaitingBanner";

const VIEW_LABEL: Record<SettlementView, string> = { requests: "Requests", overview: "Overview", history: "History" };

function tabsFor(batch: SettlementBatch): PageTab<SettlementView>[] {
  return [
    { value: "requests", label: VIEW_LABEL.requests, icon: ClipboardList, count: batch.counts.total },
    { value: "overview", label: VIEW_LABEL.overview, icon: LayoutDashboard },
    { value: "history", label: VIEW_LABEL.history, icon: History, count: batch.history?.length ?? 0 },
  ];
}

/**
 * Loan & Advance (owner briefs 2026-11-26 / 27; was "Settlement"): the MD's step of the Settlement Automation Method. HR
 * forwards a batch of a month's requests of one type - Salary Advance and Term Loan run independent workflows - and here
 * the MD reads every request (salary earned in the 1st-20th and its 50 % limit, the leave check of the 1st-20th, HR's
 * notes), approves it, approves a smaller amount or rejects it (both with a remark), adds instructions for HR, reviews every
 * decision and clicks Confirm & Proceed to send the batch back to HR.
 *
 * Layout (owner 2026-11-27): the month picker and the Type and Batch dropdowns in the header, the banners, then ONE row of
 * tabs - Requests (default), Overview, History - each showing only its own section; nothing nested. The month, the type,
 * the batch and the tab live in the address (?month=, ?type=general|term, ?batch=, ?view=); with no type the page opens
 * on the type that has requests waiting for the MD. The rules are api/settlement_automation/service.py.
 */
export default function MdSettlement() {
  const [params, update] = useUrlParams();
  const max = istMonthKey();
  const month = monthFromQuery(params.get("month"), max) ?? max;
  const wanted = Number(params.get("batch")) || null;
  const view = viewFromQuery(params.get("view"));
  const { year, month: m } = parseMonthKey(month);

  const waiting = useSettlementWaiting();
  const asked = typeFromQuery(params.get("type"));
  // no type in the address: the one waiting for the MD, once the waiting list is in (a failed list: Salary Advance)
  const type = asked ?? (waiting.data || waiting.isError ? defaultType(waiting.data, month) : null);
  const monthQuery = useSettlementMonth(month, type);
  // the month and type on screen (not the previous ones, still shown while the new ones load)
  const data =
    monthQuery.data &&
    monthQuery.data.month === m &&
    monthQuery.data.year === year &&
    (monthQuery.data.advanceType ?? "general") === type
      ? monthQuery.data
      : undefined;
  const batches = data?.batches ?? [];
  const batch = pickBatch(batches, wanted);
  const elsewhere = waitingElsewhere(waiting.data, month, type);
  const typeCounts = data?.waitingByType ?? waitingInMonth(waiting.data, month);
  const typeLabel = type ? TYPE_LABEL[type] : "Loan & Advance";

  // the type the page chose goes into the address, so it stays put when the waiting counts change (after a confirm)
  useEffect(() => {
    if (!asked && type) update({ type });
  }, [asked, type, update]);

  const setMonth = (next: MonthKey) => update({ month: next === max ? null : next, batch: null });
  const setView = (next: SettlementView) => update({ view: next === "requests" ? null : next });

  usePublishAssistantContext({
    page: "settlement",
    title: "Loan & Advance",
    filters: {
      Month: monthLabel(month),
      Type: typeLabel,
      Batch: batch ? batchTitle(batch) : "none",
      Tab: VIEW_LABEL[view],
    },
    summary: batch
      ? {
          Stage: batch.stageLabel,
          Requests: batch.counts.total,
          Decided: batch.counts.mdDecided,
          Approved: batch.counts.approved,
          Rejected: batch.counts.rejected,
          "Leave warnings": batch.counts.warning,
          "Frequent leave": batch.counts.critical,
          Requested: money(batch.amounts.requested),
          "Approved amount": money(batch.amounts.mdApproved),
        }
      : {
          "Waiting for the MD": waiting.data?.count ?? 0,
          "Salary Advance waiting": waiting.data?.byType?.general ?? 0,
          "Term Loan waiting": waiting.data?.byType?.term ?? 0,
        },
  });

  return (
    <MdLayout>
      <div className="mx-auto max-w-[1200px] space-y-5 pb-6 @container" data-testid="md-settlement-page">
        <MdPageHeader
          icon={HandCoins}
          title="Loan & Advance"
          subtitle="Salary Advance and Term Loan requests HR has forwarded to you, each type on its own. Approve, reduce or reject each one, then Confirm & Proceed to send them back to HR."
          actions={
            <>
              <MonthPicker value={month} onChange={setMonth} max={max} label="Month" />
              {type && (
                <SelectField
                  label="Type"
                  hideLabel
                  value={type}
                  options={typeOptions(typeCounts)}
                  onChange={(next) => {
                    const t = typeFromQuery(next);
                    if (t) update({ type: t, batch: null });
                  }}
                  className="w-full @lg:w-56"
                  testId="md-settlement-type-select"
                />
              )}
              {batch && (
                <SelectField
                  label="Batch"
                  hideLabel
                  value={String(batch.id)}
                  options={batches.map((b) => ({ value: String(b.id), label: batchOptionLabel(b) }))}
                  onChange={(id) => update({ batch: id })}
                  className="w-full @lg:w-72"
                  testId="md-settlement-batch-select"
                />
              )}
            </>
          }
        />

        <WaitingBanner
          groups={elsewhere}
          onOpen={(w) => update({ month: w.key === max ? null : w.key, type: w.type, batch: w.firstBatchId })}
        />

        {monthQuery.isError && !data ? (
          <ErrorBanner message={describeMdError(monthQuery.error)} onRetry={() => monthQuery.refetch()} />
        ) : !data ? (
          <div className="md-card p-5">
            <SkeletonBlock rows={4} />
          </div>
        ) : (
          <>
            {data.method === "normal" && (
              <NoteBanner>
                Loan & Advance is in the <b>Normal Method</b>: HR approves Salary Advances and Term Loans on its own
                Loan & Advance page, so nothing new is forwarded to you. HR can switch to the Automation Method in
                Settings.
              </NoteBanner>
            )}
            {data.waitingForHr && batches.length > 0 && (
              <NoteBanner>
                HR is still reviewing more {typeLabel} requests of {monthLabel(month)} (raised after the last batch was
                forwarded). They come here as the next batch when HR forwards them.
              </NoteBanner>
            )}

            {!batch ? (
              <div className="md-card" data-testid="md-settlement-empty">
                <EmptyBlock icon={Inbox} title={`No ${typeLabel} requests forwarded to you for ${monthLabel(month)}`}>
                  {data.waitingForHr
                    ? `HR is still reviewing this month's ${typeLabel} requests. They appear here when HR clicks Forward to MD.`
                    : `When HR forwards a batch of ${typeLabel} requests, it appears here.`}
                </EmptyBlock>
              </div>
            ) : (
              <>
                <PageTabs
                  label="Loan & Advance sections"
                  idBase="md-settlement"
                  tabs={tabsFor(batch)}
                  value={view}
                  onChange={setView}
                />
                <div role="tabpanel" id="md-settlement-panel" aria-labelledby={`md-settlement-tab-${view}`}>
                  <BatchView key={batch.id} batch={batch} view={view} />
                </div>
              </>
            )}
          </>
        )}
      </div>
    </MdLayout>
  );
}

import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp, UserRound } from "lucide-react";
import { describeMdError, useMdQuery } from "@/lib/api-client/custom-hooks/md";
import { inr, num } from "@/lib/md/format";
import { cn } from "@/lib/utils";
import DetailSheet from "../shared/DetailSheet";
import { employeeAddress, useOpenInPage } from "../shared/jump";
import { requestedText, requestsAddress, stampText, standingText } from "./logic";
import type { Drill, RqList, RqListItem } from "./types";

const OUTCOME_TONE: Record<RqListItem["outcome"], string> = {
  waiting: "md-analytics-tone-watch",
  approved: "md-analytics-tone-good",
  rejected: "md-analytics-tone-bad",
  other: "md-analytics-tone-neutral",
};

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-semibold uppercase tracking-wide text-md-ink-soft">{label}</dt>
      <dd className="text-[13px] text-md-ink [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

/** One request of the list: who, what and for when; opened, everything the MD would ask about it. */
function Row({ item, open, onToggle }: { item: RqListItem; open: boolean; onToggle: () => void }) {
  const openIn = useOpenInPage();
  const when = requestedText(item.requested);
  return (
    <li data-testid={`md-requests-item-${item.key}`}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors hover:bg-md-wine/5"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold text-md-ink">
            {item.employee.name}
            {item.employee.code ? <span className="font-medium text-md-ink-soft"> · {item.employee.code}</span> : null}
          </span>
          <span className="block truncate text-xs text-md-ink-soft">
            {item.what}
            {when ? ` · ${when}` : ""}
          </span>
          <span className={cn("mt-1 inline-block md-chip md-analytics-chip-sm", OUTCOME_TONE[item.outcome])}>
            {standingText(item)}
          </span>
        </span>
        {open ? (
          <ChevronUp size={16} className="mt-1 shrink-0 text-md-ink-soft" aria-hidden />
        ) : (
          <ChevronDown size={16} className="mt-1 shrink-0 text-md-ink-soft" aria-hidden />
        )}
      </button>
      {open && (
        <div className="space-y-3 px-3 pb-3" data-testid={`md-requests-item-${item.key}-detail`}>
          <dl className="grid grid-cols-1 gap-x-4 gap-y-2.5 sm:grid-cols-2">
            <Fact label="Kind">{item.kindLabel}</Fact>
            <Fact label="Department">
              {[item.employee.department, item.employee.unit].filter(Boolean).join(", ") || "—"}
            </Fact>
            {item.requested && <Fact label={item.requested.label}>{when}</Fact>}
            <Fact label="Submitted">{stampText(item.submittedAt)}</Fact>
            {item.outcome === "waiting" ? (
              <Fact label="Waiting on">{item.holderLabel ?? "—"}</Fact>
            ) : (
              <Fact label="Decided">
                {stampText(item.decidedAt)}
                {item.decidedBy ? ` by ${item.decidedBy}` : ""}
                {item.decidedByRole ? ` (${item.decidedByRole})` : ""}
              </Fact>
            )}
            {item.amount != null && (
              <Fact label="Amount">
                {inr(item.amount)}
                {item.partial && item.requestedAmount != null ? ` of ${inr(item.requestedAmount)} asked` : ""}
              </Fact>
            )}
            {item.reason && <Fact label={item.reasonLabel}>{item.reason}</Fact>}
            {item.outcome === "rejected" && (
              <Fact label="Reason for rejecting">
                {item.decisionRemark ?? "Not recorded (rejected before reasons were required)"}
              </Fact>
            )}
            {item.outcome === "approved" && item.decisionRemark && <Fact label="Note">{item.decisionRemark}</Fact>}
          </dl>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="md-btn inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold"
              onClick={() => openIn(employeeAddress(item.employee.id))}
              data-testid={`md-requests-item-${item.key}-employee`}
            >
              <UserRound size={14} aria-hidden /> Employee record
            </button>
            <button
              type="button"
              className="md-btn inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold"
              onClick={() => openIn(requestsAddress(item.kind, item.id))}
              data-testid={`md-requests-item-${item.key}-open`}
            >
              Open in Requests
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

/** The requests behind a figure the MD clicked, a page at a time, with each one's full story on a click. */
export default function DrillSheet({
  drill,
  params,
  onClose,
}: {
  drill: Drill | null;
  /** The tab's filters (month, unit, department, kind): the drill's own filters are laid over them. */
  params: Record<string, string>;
  onClose: () => void;
}) {
  const [page, setPage] = useState(1);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [shown, setShown] = useState<Drill | null>(drill);
  if (drill && drill !== shown) {
    setShown(drill);
    setPage(1);
    setOpenKey(null);
  }
  const query = useMdQuery<RqList>(
    "requests/list",
    { ...params, ...(shown?.params ?? {}), page, pageSize: 25 },
    {
      enabled: !!drill,
    },
  );
  const data = query.data;
  const openIn = useOpenInPage();
  const kind = shown?.params.kind ?? params.kind;

  return (
    <DetailSheet
      open={!!drill}
      onClose={onClose}
      title={shown?.title ?? "Requests"}
      subtitle={
        data
          ? `${shown?.subtitle ? `${shown.subtitle}. ` : ""}${num(data.total)} ${data.total === 1 ? "request" : "requests"}`
          : shown?.subtitle
      }
      loading={query.isPending}
      error={query.isError ? describeMdError(query.error) : null}
      onRetry={() => void query.refetch()}
      empty={data && data.total === 0 ? "No requests match this figure." : null}
      ask={shown?.ask}
      openLabel="Open in Requests"
      onOpen={() => openIn(requestsAddress(kind))}
      testId="md-requests-drill"
      wide
    >
      {data && (
        <div className="space-y-3">
          <ul className="md-panel divide-y divide-md-line" data-testid="md-requests-drill-list">
            {data.items.map((item) => (
              <Row
                key={item.key}
                item={item}
                open={openKey === item.key}
                onToggle={() => setOpenKey((k) => (k === item.key ? null : item.key))}
              />
            ))}
          </ul>
          {data.pages > 1 && (
            <div className="flex items-center justify-between gap-2 text-xs text-md-ink-soft">
              <button
                type="button"
                className="md-btn h-9 rounded-lg px-3 font-semibold disabled:opacity-40"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
                data-testid="md-requests-drill-prev"
              >
                Previous
              </button>
              <span data-testid="md-requests-drill-page">
                Page {num(data.page)} of {num(data.pages)}
              </span>
              <button
                type="button"
                className="md-btn h-9 rounded-lg px-3 font-semibold disabled:opacity-40"
                disabled={page >= data.pages}
                onClick={() => setPage((p) => p + 1)}
                data-testid="md-requests-drill-next"
              >
                Next
              </button>
            </div>
          )}
        </div>
      )}
    </DetailSheet>
  );
}

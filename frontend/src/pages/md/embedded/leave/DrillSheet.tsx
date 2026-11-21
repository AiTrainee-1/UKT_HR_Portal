import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp, UserRound } from "lucide-react";
import { describeMdError, useMdQuery } from "@/lib/api-client/custom-hooks/md";
import { dayLong, num } from "@/lib/md/format";
import { cn } from "@/lib/utils";
import DetailSheet from "../shared/DetailSheet";
import { employeeAddress, useOpenInPage } from "../shared/jump";
import { LEAVE_TAB_FOR, daysText, leaveAddress, rowDetail, rowValue } from "./logic";
import type { Drill, LvList, LvListItem, LvWhat } from "./types";

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-semibold uppercase tracking-wide text-md-ink-soft">{label}</dt>
      <dd className="text-[13px] text-md-ink [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

/** One row: who and what; opened, the request's story (applied, reason, the approver's reason) and the employee's record. */
function Row({ item, open, onToggle }: { item: LvListItem; open: boolean; onToggle: () => void }) {
  const openIn = useOpenInPage();
  const value = rowValue(item);
  return (
    <li data-testid={`md-leave-item-${item.key}`}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors hover:bg-md-wine/5"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold text-md-ink">
            {item.employeeName}
            <span className="font-medium text-md-ink-soft"> · {item.employeeCode}</span>
          </span>
          <span className="block truncate text-xs text-md-ink-soft">{rowDetail(item)}</span>
        </span>
        {value && <span className={cn("shrink-0 md-chip md-analytics-chip-sm", value.tone)}>{value.text}</span>}
        {open ? (
          <ChevronUp size={16} className="mt-1 shrink-0 text-md-ink-soft" aria-hidden />
        ) : (
          <ChevronDown size={16} className="mt-1 shrink-0 text-md-ink-soft" aria-hidden />
        )}
      </button>
      {open && (
        <div className="space-y-3 px-3 pb-3" data-testid={`md-leave-item-${item.key}-detail`}>
          <dl className="grid grid-cols-1 gap-x-4 gap-y-2.5 sm:grid-cols-2">
            <Fact label="Department">{[item.department, item.unit].filter(Boolean).join(", ")}</Fact>
            {item.appliedOn && <Fact label="Applied on">{dayLong(item.appliedOn)}</Fact>}
            {item.noticeDays != null && (
              <Fact label="Notice">
                {item.noticeDays <= 0 ? "On or after the first day" : `${daysText(item.noticeDays)} before`}
              </Fact>
            )}
            {(item.reasonCategory || item.reasonGroup) && (
              <Fact label="Reason picked">{item.reasonCategory ?? item.reasonGroup}</Fact>
            )}
            {item.reason && <Fact label="In their words">{item.reason}</Fact>}
            {item.stage && <Fact label="Where it stands">{item.stage}</Fact>}
            {item.status === "rejected" && (
              <Fact label="Reason for rejecting">
                {item.remark ?? "Not recorded (rejected before reasons were required)"}
              </Fact>
            )}
            {item.decidedBy && <Fact label="Decided by">{item.decidedBy}</Fact>}
            {item.used != null && (
              <Fact label="Casual Leave">
                {daysText(item.used)} used · {daysText(item.pending ?? 0)} waiting · {daysText(item.remaining ?? 0)}{" "}
                left
              </Fact>
            )}
            {item.carryForwardDates && item.carryForwardDates.length > 0 && (
              <Fact label="Carry forward dates">{item.carryForwardDates.map((d) => dayLong(d)).join(", ")}</Fact>
            )}
          </dl>
          <button
            type="button"
            className="md-btn inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold"
            onClick={() => openIn(employeeAddress(item.employeeId))}
            data-testid={`md-leave-item-${item.key}-employee`}
          >
            <UserRound size={14} aria-hidden /> Employee record
          </button>
        </div>
      )}
    </li>
  );
}

/** The leave, people or permissions behind a figure the MD clicked, a page at a time. */
export default function DrillSheet({
  drill,
  params,
  onClose,
}: {
  drill: Drill | null;
  /** The tab's filters: the drill's own filters are laid over them. */
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
  const query = useMdQuery<LvList>(
    "leave/list",
    { ...params, ...(shown?.params ?? {}), page, pageSize: 25 },
    {
      enabled: !!drill,
    },
  );
  const data = query.data;
  const openIn = useOpenInPage();
  const what = (shown?.params.what ?? "requests") as LvWhat;

  return (
    <DetailSheet
      open={!!drill}
      onClose={onClose}
      title={shown?.title ?? "Leave"}
      subtitle={data ? `${shown?.subtitle ? `${shown.subtitle}. ` : ""}${num(data.total)} in all` : shown?.subtitle}
      loading={query.isPending}
      error={query.isError ? describeMdError(query.error) : null}
      onRetry={() => void query.refetch()}
      empty={data && data.total === 0 ? "Nothing matches this figure." : null}
      ask={shown?.ask}
      openLabel="Open in Leave & Holiday"
      onOpen={() => openIn(leaveAddress(LEAVE_TAB_FOR[what]))}
      testId="md-leave-drill"
      wide
    >
      {data && (
        <div className="space-y-3">
          <ul className="md-panel divide-y divide-md-line" data-testid="md-leave-drill-list">
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
                data-testid="md-leave-drill-prev"
              >
                Previous
              </button>
              <span>
                Page {num(data.page)} of {num(data.pages)}
              </span>
              <button
                type="button"
                className="md-btn h-9 rounded-lg px-3 font-semibold disabled:opacity-40"
                disabled={page >= data.pages}
                onClick={() => setPage((p) => p + 1)}
                data-testid="md-leave-drill-next"
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

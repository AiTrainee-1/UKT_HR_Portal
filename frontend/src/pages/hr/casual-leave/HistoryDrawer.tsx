import { History, Loader2 } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useCasualLeaveHistory, type CasualLeaveHistoryEntry } from "@/lib/api-client/custom-hooks";
import { TONE } from "@/lib/statusTones";
import { cn } from "@/lib/utils";
import { Chip } from "../leave/parts";
import { balanceDetail, balanceText } from "./logic";

/** What each kind of line is called, and its tint. */
const KIND: Record<CasualLeaveHistoryEntry["kind"], { label: string; tone: string }> = {
  opening: { label: "Opening", tone: TONE.info },
  approved: { label: "Approved", tone: TONE.success },
  pending: { label: "Waiting", tone: TONE.warning },
  rejected: { label: "Rejected", tone: TONE.neutral },
  lapsed: { label: "Lapsed", tone: TONE.neutral },
};

/**
 * One employee's Casual Leave year as a running balance (GET /api/casual-leaves/history): the fresh 12, then a line for every
 * Casual Leave that counts ("12 → 11 on 05 Nov: Casual Leave approved (Full day, 05 Nov 2026)"), oldest first, and once the
 * year is over the unused days lapsing on 31 December. Read-only.
 */
export default function HistoryDrawer({
  target,
  year,
  onClose,
}: {
  target: { employeeId: number; name: string } | null;
  year: number;
  onClose: () => void;
}) {
  const query = useCasualLeaveHistory(target?.employeeId ?? null, year, !!target);
  const data = query.data;
  const left = balanceText(data?.balance);
  const detail = balanceDetail(data?.balance);
  return (
    <Sheet open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md" data-testid="cl-history" data-view-safe>
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <History size={18} className="text-[#006496]" /> Casual Leave history
          </SheetTitle>
          <SheetDescription>
            {target?.name ?? ""} · {year}
          </SheetDescription>
        </SheetHeader>

        {query.isLoading ? (
          <p className="mt-6 flex items-center gap-2 text-sm text-gray-500" data-testid="cl-history-loading">
            <Loader2 size={14} className="animate-spin" /> Loading the year…
          </p>
        ) : query.isError || !data ? (
          <p className="mt-6 rounded-xl border border-red-100 bg-red-50 p-3 text-sm text-red-700" role="alert">
            Could not load the Casual Leave history.{" "}
            <button type="button" className="font-semibold underline" onClick={() => void query.refetch()}>
              Try again
            </button>
          </p>
        ) : (
          <div className="mt-5 space-y-4">
            <div className="rounded-xl border border-sky-100 bg-sky-50 p-3" data-testid="cl-history-balance">
              <p className="text-lg font-black text-sky-900">{left ?? `No balance is kept for ${year}`}</p>
              {detail && <p className="text-xs text-sky-800">{detail}</p>}
              {data.balance.tracked && data.balance.since && (
                <p className="mt-1 text-[11px] text-sky-700">
                  Counted from {data.balance.since}; unused days lapse on {data.balance.endsOn}.
                </p>
              )}
            </div>

            {data.entries.length === 0 ? (
              <p className="text-sm text-gray-500" data-testid="cl-history-empty">
                Nothing to show for {year}.
              </p>
            ) : (
              <ol className="space-y-2" aria-label={`Casual Leave of ${year}, oldest first`}>
                {data.entries.map((e, i) => (
                  <li
                    key={`${e.kind}-${e.requestKind ?? ""}-${e.requestId ?? i}-${i}`}
                    className="rounded-xl border border-gray-100 bg-white p-3"
                    data-testid="cl-history-entry"
                    data-kind={e.kind}
                  >
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Chip className={KIND[e.kind]?.tone ?? TONE.neutral}>{KIND[e.kind]?.label ?? e.kind}</Chip>
                      {e.source === "hr_edit" && <Chip className={TONE.info}>HR attendance edit</Chip>}
                      {e.source === "hr_assign" && <Chip className={TONE.info}>Given by HR (Carry Forward)</Chip>}
                      <span
                        className={cn(
                          "ml-auto text-sm font-black tabular-nums",
                          e.change < 0 ? "text-rose-700" : "text-gray-700",
                        )}
                      >
                        {e.balanceAfter}
                      </span>
                    </div>
                    <p className="mt-1 text-xs leading-snug text-gray-700">{e.text}</p>
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

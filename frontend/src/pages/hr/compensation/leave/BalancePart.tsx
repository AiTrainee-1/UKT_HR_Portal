import { useMemo, useState } from "react";
import { Archive, ListOrdered, PiggyBank, Wallet } from "lucide-react";
import { EmptyNote, KpiTile, SectionCard, SkeletonKpis, SkeletonRows } from "@/components/payroll/kit/parts";
import { LoadError, SearchField } from "@/components/payroll/panels/issues/panel-kit";
import { errorDetail } from "@/components/payroll/panels/issues/lists";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  useCompensationBalance,
  useCompensationBalances,
  useCompensationCredits,
  type BalanceRow,
} from "@/lib/api-client/custom-hooks";
import { VIEW_SAFE_ATTR } from "@/lib/view-only-lock";
import { dateShort, errorMessage, fmtShifts, matchesText, shiftsText, sumShifts } from "../logic";
import { CELL, ErrorNotice, PersonCell, Pager, StatusChip, TABLE_HEAD, usePaged } from "../ui";
import { entrySourceText } from "./leave-logic";
import { RedeemDialog, type RedeemTarget } from "./RedeemDialog";

/**
 * The compensation balance: every staff member with shifts to take (credited when the Department Head approves a Sunday /
 * holiday work claim, or from an earlier Alternative-Day credit), what is behind each balance, and Redeem, which turns part
 * of it into a day off on a date. Below it, the earlier Alternative-Day credits (each counts as one shift).
 */
export function BalancePart({ paused, pausedReason }: { paused: boolean; pausedReason: string }) {
  const query = useCompensationBalances();
  const [search, setSearch] = useState("");
  const [redeeming, setRedeeming] = useState<RedeemTarget | null>(null);
  const [viewing, setViewing] = useState<BalanceRow | null>(null);

  const all = useMemo(() => query.data?.results ?? [], [query.data]);
  const rows = useMemo(
    () => all.filter((r) => matchesText(search, r.employeeName, r.employeeCode, r.department)),
    [all, search],
  );
  const withBalance = all.filter((r) => r.balance > 0);
  const total = sumShifts(all.map((r) => r.balance));
  const paged = usePaged(rows, `bal|${search}|${rows.length}`);

  return (
    <div className="space-y-4" data-testid="balance-part">
      <SectionCard
        testId="balance-card"
        icon={Wallet}
        title="Compensation balance"
        description="Shifts waiting to be taken as a day off. They are added when the Department Head approves a Sunday / holiday work claim; HR redeems them on a date."
        bodyClassName="space-y-4 px-0 pb-0"
      >
        <div className="space-y-3 px-5">
          {query.isLoading ? (
            <SkeletonKpis count={2} className="md:grid-cols-2 xl:grid-cols-2" />
          ) : (
            <div className="grid grid-cols-2 gap-3" data-testid="balance-kpis">
              <KpiTile
                testId="balance-kpi-people"
                label="Employees with a balance"
                value={withBalance.length}
                icon={PiggyBank}
                tone="bg-indigo-50 text-indigo-800"
              />
              <KpiTile
                testId="balance-kpi-total"
                label="Shifts to be taken"
                value={fmtShifts(total)}
                sub="across all employees"
                icon={ListOrdered}
                tone="bg-emerald-50 text-emerald-800"
              />
            </div>
          )}
          <div {...{ [VIEW_SAFE_ATTR]: "" }}>
            <SearchField
              value={search}
              onChange={setSearch}
              placeholder="Search by name, code or department"
              label="Search the balances"
              testId="balance-search"
              className="max-w-md"
            />
          </div>
        </div>

        {query.isLoading ? (
          <div className="px-5 pb-5">
            <SkeletonRows rows={3} />
          </div>
        ) : query.isError && !query.data ? (
          <div className="px-5 pb-5">
            <LoadError
              what="the balances"
              detail={errorDetail(query.error)}
              onRetry={() => void query.refetch()}
              retrying={query.isFetching}
              testId="balance-error"
            />
          </div>
        ) : rows.length === 0 ? (
          <div className="px-5 pb-5">
            <EmptyNote
              icon={Wallet}
              title={all.length > 0 ? "Nobody matches the search" : "Nobody has a balance yet"}
              hint={
                all.length > 0
                  ? "Try a different name or code."
                  : "Shifts are added here when the Department Head approves a Sunday or company-holiday work claim."
              }
              testId="balance-empty"
            />
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm" data-testid="balance-table">
                <thead className={TABLE_HEAD}>
                  <tr>
                    <th className="px-3 py-2.5 pl-5">Employee</th>
                    <th className="px-3 py-2.5">Balance</th>
                    <th className="px-3 py-2.5 text-right">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {paged.rows.map((row) => (
                    <tr key={row.employeeId} data-testid={`balance-row-${row.employeeCode}`}>
                      <td className={`${CELL} pl-5`}>
                        <PersonCell name={row.employeeName} code={row.employeeCode} department={row.department} />
                      </td>
                      <td className={CELL}>
                        <StatusChip tone={row.balance > 0 ? "success" : "neutral"}>
                          {shiftsText(row.balance)}
                        </StatusChip>
                      </td>
                      <td className={`${CELL} pr-5 text-right`}>
                        <div className="flex flex-wrap justify-end gap-2">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            aria-label={`See what is behind the balance of ${row.employeeName}`}
                            onClick={() => setViewing(row)}
                            data-view-safe=""
                            data-testid={`balance-details-${row.employeeCode}`}
                          >
                            Details
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            disabled={paused || row.balance <= 0}
                            aria-label={`Redeem the balance of ${row.employeeName}`}
                            title={
                              paused
                                ? pausedReason
                                : row.balance <= 0
                                  ? "Nothing to redeem"
                                  : `Redeem: create a day off for ${row.employeeName} from the balance`
                            }
                            onClick={() =>
                              setRedeeming({
                                employeeId: row.employeeId,
                                employeeName: row.employeeName,
                                employeeCode: row.employeeCode,
                                balance: row.balance,
                              })
                            }
                            data-testid={`balance-redeem-${row.employeeCode}`}
                          >
                            Redeem
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager paged={paged} />
          </>
        )}
      </SectionCard>

      <LegacyCredits />

      <RedeemDialog target={redeeming} onOpenChange={(open) => !open && setRedeeming(null)} />
      <LedgerDialog row={viewing} onClose={() => setViewing(null)} />
    </div>
  );
}

/** What is behind one balance: every credit and every day off taken, newest first. */
function LedgerDialog({ row, onClose }: { row: BalanceRow | null; onClose: () => void }) {
  const detail = useCompensationBalance(row?.employeeId ?? null);
  const entries = detail.data?.entries ?? [];
  return (
    <Dialog open={row !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto" data-testid="ledger-dialog">
        <DialogHeader>
          <DialogTitle>{row ? `Balance of ${row.employeeName}` : "Balance"}</DialogTitle>
          <DialogDescription>
            {detail.data ? (
              <>
                <strong>{shiftsText(detail.data.balance)}</strong> to take. Credits add to it, days off taken subtract.
              </>
            ) : (
              "Every credit and every day off taken."
            )}
          </DialogDescription>
        </DialogHeader>
        {detail.isLoading ? (
          <SkeletonRows rows={3} />
        ) : detail.isError ? (
          <ErrorNotice testId="ledger-error">
            {errorMessage(detail.error, "The entries could not be loaded.")}{" "}
            <button type="button" className="font-semibold underline" onClick={() => void detail.refetch()}>
              Retry
            </button>
          </ErrorNotice>
        ) : entries.length === 0 ? (
          <EmptyNote icon={Wallet} title="No entries" testId="ledger-empty" />
        ) : (
          <div className="overflow-x-auto rounded-xl border border-slate-100">
            <table className="w-full min-w-[560px] text-sm" data-testid="ledger-table">
              <thead className={TABLE_HEAD}>
                <tr>
                  <th className="px-3 py-2.5">Date</th>
                  <th className="px-3 py-2.5">What</th>
                  <th className="px-3 py-2.5">Shifts</th>
                  <th className="px-3 py-2.5">By</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {entries.map((e, i) => (
                  <tr key={e.id ?? `legacy-${e.legacyCreditId ?? i}`} className={e.counted ? undefined : "opacity-60"}>
                    <td className={`${CELL} whitespace-nowrap`}>{dateShort(e.date)}</td>
                    <td className={CELL}>
                      <p className="text-gray-800">{entrySourceText(e)}</p>
                      {e.note && <p className="text-[11px] text-muted-foreground">{e.note}</p>}
                      {!e.counted && (
                        <p className="text-[11px] text-muted-foreground">Shown for the record: not taken off twice.</p>
                      )}
                    </td>
                    <td className={CELL}>
                      <StatusChip tone={e.type === "credit" ? "success" : "info"}>
                        {e.type === "credit" ? "+" : "−"}
                        {fmtShifts(e.shifts)}
                      </StatusChip>
                    </td>
                    <td className={`${CELL} text-gray-600`}>{e.createdBy ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The Alternative-Day credits from before the overhaul: still visible, each one shift in the balance while available. */
function LegacyCredits() {
  const query = useCompensationCredits();
  const rows = query.data?.results ?? [];
  const paged = usePaged(rows, `credits|${rows.length}`, 10);
  return (
    <SectionCard
      testId="credits-card"
      icon={Archive}
      title="Earlier Alternative-Day credits"
      description="From overtime announced before the new rules. Each available credit counts as one shift in the balance above."
      bodyClassName="space-y-3 px-0 pb-0"
    >
      {query.isLoading ? (
        <div className="px-5 pb-5">
          <SkeletonRows rows={2} />
        </div>
      ) : query.isError && !query.data ? (
        <div className="px-5 pb-5">
          <LoadError
            what="the earlier credits"
            detail={errorDetail(query.error)}
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
            testId="credits-error"
          />
        </div>
      ) : rows.length === 0 ? (
        <div className="px-5 pb-5">
          <EmptyNote icon={Archive} title="No earlier credits" testId="credits-empty" />
        </div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm" data-testid="credits-table">
              <thead className={TABLE_HEAD}>
                <tr>
                  <th className="px-3 py-2.5 pl-5">Employee</th>
                  <th className="px-3 py-2.5">Earned from OT on</th>
                  <th className="px-3 py-2.5">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {paged.rows.map((c) => (
                  <tr key={c.id} data-testid={`credit-row-${c.id}`}>
                    <td className={`${CELL} pl-5`}>
                      <PersonCell name={c.employeeName} code={c.employeeCode} />
                    </td>
                    <td className={`${CELL} text-gray-600`}>{dateShort(c.sourceDate)}</td>
                    <td className={CELL}>
                      <StatusChip tone={c.status === "available" ? "success" : "neutral"}>
                        {c.status === "available" ? "Available: 1 shift" : `Used on ${dateShort(c.usedDate)}`}
                      </StatusChip>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager paged={paged} size={10} />
        </>
      )}
    </SectionCard>
  );
}

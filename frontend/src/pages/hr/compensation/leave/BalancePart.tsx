import { useMemo, useState } from "react";
import { Link } from "wouter";
import { CheckCircle2, Hourglass, ListOrdered, PiggyBank, Wallet } from "lucide-react";
import { SectionCard } from "@/components/payroll/kit/parts";
import { Button } from "@/components/ui/button";
import {
  useCompensationBalance,
  useCompensationBalanceList,
  useCompensationClaims,
  type BalanceListRow,
} from "@/lib/api-client/custom-hooks";
import {
  ClearFilters,
  DataTable,
  DetailDrawer,
  DrawerSection,
  FilterBar,
  PersonCell,
  SearchFilter,
  StatRow,
  StatTile,
  StatusChip,
  type DataColumn,
} from "@/pages/hr/outpass-visitors/kit";
import { dateShort, errorMessage, fmtShifts, shiftsText, sumShifts } from "../logic";
import { ErrorNotice } from "../ui";
import { KIND_LABEL, ledgerSourceText, signedShifts } from "./claims-logic";
import { OrgFilters } from "./LeaveFilters";
import { claimLink, creditLink, idOf, pageOf, useLeaveUrl, type LeaveUrl } from "./leave-url";
import { RedeemDialog, type RedeemTarget } from "./RedeemDialog";
import { UseBalanceDialog, type UseBalanceTarget } from "./UseBalanceDialog";

const PAGE_SIZE = 25;

const LINK = "font-semibold text-indigo-700 underline-offset-2 hover:underline";

type Person = { employeeId: number; employeeName: string; employeeCode: string };

/**
 * The compensation balance of every staff member: what they EARNED (approved claims: Sunday / holiday work, OT shift
 * credits, birthday credits, and the earlier Alternative-Day credits), what they USED (days off taken), what is WAITING
 * (asked to use and not decided yet) and what is AVAILABLE. Filtered by department, branch and name or code, a page at a
 * time. A row opens the employee's drawer: every entry behind the balance, with a link to the claim that made it. Use
 * balance asks the Department Head on the employee's behalf; Redeem (HR, direct and audited) takes it at once.
 */
export function BalancePart({ paused, pausedReason }: { paused: boolean; pausedReason: string }) {
  const [lu, setLu] = useLeaveUrl();
  const query = useCompensationBalanceList({
    departmentId: idOf(lu.baldept),
    branchId: idOf(lu.balbranch),
    q: lu.balq.trim() || undefined,
    page: pageOf(lu.balpage),
    pageSize: PAGE_SIZE,
  });
  const [using, setUsing] = useState<UseBalanceTarget | null>(null);
  const [redeeming, setRedeeming] = useState<RedeemTarget | null>(null);
  const rows = useMemo(() => query.data?.items ?? [], [query.data]);
  const s = query.data?.summary;
  const tiles = {
    employees: s?.employees ?? rows.filter((r) => r.available > 0).length,
    earned: s?.earned ?? sumShifts(rows.map((r) => r.earned)),
    used: s?.used ?? sumShifts(rows.map((r) => r.used)),
    pending: s?.pending ?? sumShifts(rows.map((r) => r.pending)),
    available: s?.available ?? sumShifts(rows.map((r) => r.available)),
  };
  const filter = (patch: Partial<LeaveUrl>) => setLu({ ...patch, balpage: "" });
  const filtersOn = [lu.baldept, lu.balbranch, lu.balq].filter((v) => v !== "").length;
  const drawerId = idOf(lu.balemp) ?? null;
  const drawerRow = rows.find((r) => r.employeeId === drawerId) ?? null;

  const startUse = (who: Person, available: number) => setUsing({ ...who, available });
  const startRedeem = (who: Person, available: number) => setRedeeming({ ...who, balance: available });

  const columns = useMemo<DataColumn<BalanceListRow>[]>(
    () => [
      {
        key: "employee",
        header: "Employee",
        cell: (r) => <PersonCell name={r.employeeName} code={r.employeeCode} sub={r.department} size={28} />,
        text: (r) => `${r.employeeName} (${r.employeeCode})`,
        minWidth: 180,
        truncate: false,
      },
      { key: "earned", header: "Earned", cell: (r) => fmtShifts(r.earned), align: "right" },
      { key: "used", header: "Used", cell: (r) => fmtShifts(r.used), align: "right" },
      {
        key: "pending",
        header: "Waiting",
        cell: (r) => (r.pending > 0 ? <span className="text-indigo-700">{fmtShifts(r.pending)}</span> : "0"),
        align: "right",
      },
      {
        key: "available",
        header: "Available",
        truncate: false,
        align: "right",
        cell: (r) => (
          <StatusChip tone={r.available > 0 ? "teal" : "slate"} testId={`balance-available-${r.employeeCode}`}>
            {shiftsText(r.available)}
          </StatusChip>
        ),
      },
      {
        key: "last",
        header: "Last activity",
        cell: (r) => (r.lastActivity ? dateShort(r.lastActivity.slice(0, 10)) : "—"),
        hideOnPhone: true,
      },
      {
        key: "actions",
        header: <span className="sr-only">Actions</span>,
        align: "right",
        truncate: false,
        cell: (r) => (
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-11 sm:h-8"
              disabled={paused || r.available <= 0}
              aria-label={`Use the balance of ${r.employeeName}`}
              title={
                paused
                  ? pausedReason
                  : r.available <= 0
                    ? "Nothing available to use"
                    : `Use balance: send a request for ${r.employeeName} to the Department Head`
              }
              onClick={() =>
                setUsing({
                  employeeId: r.employeeId,
                  employeeName: r.employeeName,
                  employeeCode: r.employeeCode,
                  available: r.available,
                })
              }
              data-testid={`balance-use-${r.employeeCode}`}
            >
              Use balance
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-11 sm:h-8"
              disabled={paused || r.available <= 0}
              aria-label={`Redeem the balance of ${r.employeeName}`}
              title={
                paused
                  ? pausedReason
                  : r.available <= 0
                    ? "Nothing to redeem"
                    : `Redeem: create a day off for ${r.employeeName} from the balance now, without the Department Head`
              }
              onClick={() =>
                setRedeeming({
                  employeeId: r.employeeId,
                  employeeName: r.employeeName,
                  employeeCode: r.employeeCode,
                  balance: r.available,
                })
              }
              data-testid={`balance-redeem-${r.employeeCode}`}
            >
              Redeem
            </Button>
          </div>
        ),
      },
    ],
    [paused, pausedReason],
  );

  return (
    <div className="space-y-4" data-testid="balance-part">
      <SectionCard
        testId="balance-card"
        icon={Wallet}
        title="Compensation balance"
        description="Shifts earned from approved claims and earlier credits, the days off already taken, what is waiting for the Department Head, and what is left to use."
        bodyClassName="space-y-3"
      >
        <FilterBar label="Balance filters" testId="balance-filters" sticky={false}>
          <OrgFilters
            dept={lu.baldept}
            branch={lu.balbranch}
            onDept={(v) => filter({ baldept: v })}
            onBranch={(v) => filter({ balbranch: v })}
            testId="balance"
          />
          <SearchFilter
            value={lu.balq}
            onChange={(v) => filter({ balq: v })}
            placeholder="Name or code"
            label="Search the balances by name or code"
            testId="balance-search"
          />
          <ClearFilters
            count={filtersOn}
            onClear={() => filter({ baldept: "", balbranch: "", balq: "" })}
            testId="balance-clear"
          />
        </FilterBar>

        <StatRow columns={5} testId="balance-kpis">
          <StatTile
            label="With a balance"
            value={tiles.employees}
            hint="employees"
            icon={PiggyBank}
            tone="indigo"
            loading={query.isLoading}
            testId="balance-kpi-people"
          />
          <StatTile
            label="Earned"
            value={fmtShifts(tiles.earned)}
            hint="shifts"
            icon={ListOrdered}
            loading={query.isLoading}
            testId="balance-kpi-earned"
          />
          <StatTile
            label="Used"
            value={fmtShifts(tiles.used)}
            hint="shifts"
            icon={CheckCircle2}
            tone="slate"
            loading={query.isLoading}
            testId="balance-kpi-used"
          />
          <StatTile
            label="Waiting for HOD"
            value={fmtShifts(tiles.pending)}
            hint="shifts"
            icon={Hourglass}
            tone="amber"
            loading={query.isLoading}
            testId="balance-kpi-pending"
          />
          <StatTile
            label="Available"
            value={fmtShifts(tiles.available)}
            hint="shifts"
            icon={Wallet}
            tone="teal"
            loading={query.isLoading}
            testId="balance-kpi-total"
          />
        </StatRow>

        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.employeeId}
          onRowClick={(r) => setLu({ balemp: String(r.employeeId) })}
          rowLabel={(r) => `Open the balance of ${r.employeeName}`}
          selectedKey={drawerId}
          loading={query.isLoading}
          error={
            query.isError && !query.data
              ? `Could not load the balances. ${errorMessage(query.error, "Check the connection and try again.")}`
              : null
          }
          onRetry={() => void query.refetch()}
          empty={{
            icon: Wallet,
            title: filtersOn > 0 ? "Nobody matches the filters" : "Nobody has a balance yet",
            hint:
              filtersOn > 0
                ? "Try a different name, code, department or branch."
                : "Shifts are added here when the Department Head approves a claim (Sunday / holiday work, OT shift credit, birthday credit).",
          }}
          pagination={{
            page: pageOf(lu.balpage),
            pageSize: PAGE_SIZE,
            total: query.data?.total ?? 0,
            onPageChange: (p) => setLu({ balpage: p > 1 ? String(p) : "" }),
          }}
          caption="Compensation balances"
          testId="balance-table"
        />
      </SectionCard>

      <BalanceDrawer
        employeeId={drawerId}
        row={drawerRow}
        onClose={() => setLu({ balemp: "" })}
        paused={paused}
        pausedReason={pausedReason}
        onUse={startUse}
        onRedeem={startRedeem}
      />
      <UseBalanceDialog target={using} onOpenChange={(open) => !open && setUsing(null)} />
      <RedeemDialog target={redeeming} onOpenChange={(open) => !open && setRedeeming(null)} />
    </div>
  );
}

/** One employee's balance: the four figures, the requests still waiting, and every entry behind it (newest first). */
function BalanceDrawer({
  employeeId,
  row,
  onClose,
  paused,
  pausedReason,
  onUse,
  onRedeem,
}: {
  employeeId: number | null;
  row: BalanceListRow | null;
  onClose: () => void;
  paused: boolean;
  pausedReason: string;
  onUse: (who: Person, available: number) => void;
  onRedeem: (who: Person, available: number) => void;
}) {
  const detail = useCompensationBalance(employeeId);
  const waiting = useCompensationClaims(
    { employeeId: employeeId ?? undefined, kind: "use_balance", status: "pending", anyMonth: true, pageSize: 50 },
    { enabled: employeeId !== null },
  );
  const d = detail.data;
  const entries = d?.entries ?? [];
  const counted = entries.filter((e) => e.counted);
  const figures = {
    earned: d?.earned ?? row?.earned ?? sumShifts(counted.filter((e) => e.type === "credit").map((e) => e.shifts)),
    used: d?.used ?? row?.used ?? sumShifts(counted.filter((e) => e.type === "debit").map((e) => e.shifts)),
    pending: d?.pending ?? row?.pending ?? 0,
    available: d?.available ?? row?.available ?? d?.balance ?? 0,
  };
  const who: Person | null =
    d || row
      ? {
          employeeId: (d?.employeeId ?? row?.employeeId) as number,
          employeeName: d?.employeeName ?? row?.employeeName ?? "",
          employeeCode: d?.employeeCode ?? row?.employeeCode ?? "",
        }
      : null;
  const requests = waiting.data?.items ?? [];

  return (
    <DetailDrawer
      open={employeeId !== null}
      onOpenChange={(open) => !open && onClose()}
      title={who ? `Balance of ${who.employeeName}` : "Balance"}
      subtitle={who ? `${who.employeeCode} · ${shiftsText(figures.available)} available` : undefined}
      wide
      testId="ledger-dialog"
      footer={
        who && (
          <>
            <Button
              type="button"
              variant="outline"
              className="h-11 sm:h-9"
              disabled={paused || figures.available <= 0}
              title={
                paused ? pausedReason : `Use balance: send a request for ${who.employeeName} to the Department Head`
              }
              onClick={() => onUse(who, figures.available)}
              data-testid="ledger-use"
            >
              Use balance
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="h-11 sm:h-9"
              disabled={paused || figures.available <= 0}
              title={paused ? pausedReason : `Redeem: create a day off for ${who.employeeName} now`}
              onClick={() => onRedeem(who, figures.available)}
              data-testid="ledger-redeem"
            >
              Redeem
            </Button>
          </>
        )
      }
    >
      {detail.isLoading ? (
        <p className="text-sm text-slate-500" role="status">
          Loading the entries…
        </p>
      ) : detail.isError ? (
        <ErrorNotice testId="ledger-error">
          {errorMessage(detail.error, "The entries could not be loaded.")}{" "}
          <button type="button" className="font-semibold underline" onClick={() => void detail.refetch()}>
            Retry
          </button>
        </ErrorNotice>
      ) : (
        <>
          <StatRow columns={4} testId="ledger-figures">
            <StatTile label="Earned" value={fmtShifts(figures.earned)} testId="ledger-earned" />
            <StatTile label="Used" value={fmtShifts(figures.used)} tone="slate" testId="ledger-used" />
            <StatTile label="Waiting" value={fmtShifts(figures.pending)} tone="amber" testId="ledger-pending" />
            <StatTile label="Available" value={fmtShifts(figures.available)} tone="teal" testId="ledger-available" />
          </StatRow>

          {requests.length > 0 && (
            <DrawerSection title="Waiting for the Department Head" testId="ledger-waiting">
              <ul className="space-y-1.5 text-sm">
                {requests.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      {shiftsText(c.shifts)} on {dateShort(c.workDate)}
                      {c.hodName ? ` · HOD: ${c.hodName}` : ""}
                    </span>
                    <Link href={claimLink(c.id, c.employeeId)} className={LINK} data-testid={`ledger-waiting-${c.id}`}>
                      Open the request
                    </Link>
                  </li>
                ))}
              </ul>
            </DrawerSection>
          )}

          <DrawerSection
            title="Entries"
            testId="ledger-entries"
            actions={
              who ? (
                <Link href={creditLink(who.employeeId)} className={`${LINK} text-xs`} data-testid="ledger-credits-link">
                  Open in Credits
                </Link>
              ) : undefined
            }
          >
            {entries.length === 0 ? (
              <p className="text-sm text-slate-500" data-testid="ledger-empty">
                No entries yet.
              </p>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-slate-100">
                <table className="w-full min-w-[520px] text-sm" data-testid="ledger-table">
                  <thead className="bg-slate-50 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-3 py-2">Date</th>
                      <th className="px-3 py-2">What</th>
                      <th className="px-3 py-2 text-right">Shifts</th>
                      <th className="px-3 py-2">Claim</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {entries.map((e, i) => (
                      <tr
                        key={e.id ?? `legacy-${e.legacyCreditId ?? i}`}
                        className={e.counted ? undefined : "opacity-60"}
                      >
                        <td className="whitespace-nowrap px-3 py-2">{dateShort(e.date)}</td>
                        <td className="px-3 py-2">
                          <p className="text-slate-800">{ledgerSourceText(e)}</p>
                          {e.note && <p className="text-[11px] text-slate-500">{e.note}</p>}
                          {!e.counted && (
                            <p className="text-[11px] text-slate-500">Shown for the record: not taken off twice.</p>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <StatusChip tone={e.type === "credit" ? "teal" : "slate"}>{signedShifts(e)}</StatusChip>
                        </td>
                        <td className="px-3 py-2">
                          {e.claim && who ? (
                            <Link
                              href={claimLink(e.claim.id, who.employeeId)}
                              className={LINK}
                              data-testid={`ledger-claim-${e.claim.id}`}
                            >
                              {KIND_LABEL[e.claim.kind as keyof typeof KIND_LABEL] ?? "Claim"} #{e.claim.id}
                            </Link>
                          ) : (
                            <span className="text-slate-400">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </DrawerSection>
        </>
      )}
    </DetailDrawer>
  );
}

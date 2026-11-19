import { useMemo } from "react";
import { Link } from "wouter";
import { Archive, ArrowDownCircle, ArrowUpCircle, BookOpen, Scale } from "lucide-react";
import { EmptyNote, SectionCard, SkeletonRows } from "@/components/payroll/kit/parts";
import { LoadError } from "@/components/payroll/panels/issues/panel-kit";
import { errorDetail } from "@/components/payroll/panels/issues/lists";
import { useCompensationCredits, useCompensationLedger, type LedgerRow } from "@/lib/api-client/custom-hooks";
import {
  ClearFilters,
  DataTable,
  FilterBar,
  PersonCell,
  SearchFilter,
  SelectFilter,
  StatRow,
  StatTile,
  StatusChip as KitChip,
  type DataColumn,
} from "@/pages/hr/outpass-visitors/kit";
import { dateShort, errorMessage, fmtShifts, sumShifts } from "../logic";
import { CELL, PersonCell as SmallPerson, Pager, StatusChip, TABLE_HEAD, usePaged } from "../ui";
import { ENTRY_TYPE_OPTIONS, KIND_LABEL, LEDGER_SOURCE_OPTIONS, ledgerSourceText, signedShifts } from "./claims-logic";
import { EmployeeChip, MonthFilter, OrgFilters } from "./LeaveFilters";
import {
  balanceLink,
  claimLink,
  idOf,
  monthChoice,
  monthChoiceLabel,
  pageOf,
  useLeaveUrl,
  type LeaveUrl,
} from "./leave-url";

const PAGE_SIZE = 25;
const LINK = "font-semibold text-indigo-700 underline-offset-2 hover:underline";

/**
 * Credits: every entry of the compensation balances, credits (an approved claim of Sunday / holiday work, an OT shift
 * credit, a birthday credit) and debits (a day off taken: a use-balance request the Department Head approved, or HR's
 * direct redeem), each with a link to the claim that made it and to the employee's balance. Filtered by month (or every
 * month), credit or debit, where it came from, department, branch and name or code. The earlier Alternative-Day credits of
 * the old system are their own section below.
 */
export function CreditsPart({ today }: { today: string }) {
  const [lu, setLu] = useLeaveUrl();
  const month = monthChoice(lu.lmonth, lu.lyear, today);
  const query = useCompensationLedger({
    entryType: lu.ltype || undefined,
    source: lu.lsource || undefined,
    ...(month.all ? {} : { month: month.month, year: month.year }),
    employeeId: idOf(lu.lemp),
    departmentId: idOf(lu.ldept),
    branchId: idOf(lu.lbranch),
    q: lu.lq.trim() || undefined,
    page: pageOf(lu.lpage),
    pageSize: PAGE_SIZE,
  });
  const rows = useMemo(() => query.data?.items ?? [], [query.data]);
  const s = query.data?.summary;
  const tiles = {
    credits: s?.credits ?? rows.filter((r) => r.type === "credit").length,
    debits: s?.debits ?? rows.filter((r) => r.type === "debit").length,
    creditShifts: s?.creditShifts ?? sumShifts(rows.filter((r) => r.type === "credit").map((r) => r.shifts)),
    debitShifts: s?.debitShifts ?? sumShifts(rows.filter((r) => r.type === "debit" && r.counted).map((r) => r.shifts)),
  };
  const filter = (patch: Partial<LeaveUrl>) => setLu({ ...patch, lpage: "", lclaim: "" });
  const filtersOn = [lu.ltype, lu.lsource, lu.ldept, lu.lbranch, lu.lq, lu.lemp].filter((v) => v !== "").length;
  const marked = idOf(lu.lclaim) ?? null;
  const markedKey = marked === null ? null : (rows.find((r) => r.claim?.id === marked)?.id ?? null);
  const employeeName = idOf(lu.lemp) ? (rows.find((r) => r.employeeId === idOf(lu.lemp))?.employeeName ?? null) : null;

  const columns = useMemo<DataColumn<LedgerRow>[]>(
    () => [
      {
        key: "date",
        header: "Date",
        cell: (r) => <span className="font-semibold text-slate-900">{dateShort(r.date)}</span>,
        minWidth: 100,
      },
      {
        key: "employee",
        header: "Employee",
        cell: (r) => (
          <Link
            href={balanceLink(r.employeeId)}
            className="block min-w-0"
            title={`Open the balance of ${r.employeeName}`}
          >
            <PersonCell name={r.employeeName} code={r.employeeCode} sub={r.department} size={28} />
          </Link>
        ),
        text: (r) => `${r.employeeName} (${r.employeeCode})`,
        minWidth: 180,
        truncate: false,
      },
      {
        key: "entry",
        header: "Shifts",
        align: "right",
        truncate: false,
        cell: (r) => (
          <KitChip tone={r.type === "credit" ? "teal" : "slate"} title={r.counted ? undefined : "Not taken off twice"}>
            {signedShifts(r)}
          </KitChip>
        ),
      },
      {
        key: "what",
        header: "What",
        cell: (r) => (
          <div className="leading-tight">
            <p className="text-slate-800">{ledgerSourceText(r)}</p>
            {r.note && <p className="text-[11px] text-slate-500">{r.note}</p>}
          </div>
        ),
        text: (r) => [ledgerSourceText(r), r.note].filter(Boolean).join(" · "),
        maxWidth: 320,
      },
      {
        key: "claim",
        header: "Claim",
        truncate: false,
        cell: (r) =>
          r.claim ? (
            <Link
              href={claimLink(r.claim.id, r.employeeId)}
              className={LINK}
              data-testid={`ledger-row-claim-${r.claim.id}`}
            >
              {KIND_LABEL[r.claim.kind]} #{r.claim.id}
            </Link>
          ) : (
            <span className="text-slate-400">{r.source === "redemption" ? "HR redeem" : "—"}</span>
          ),
      },
      { key: "by", header: "By", cell: (r) => r.createdBy ?? "—", hideOnPhone: true },
    ],
    [],
  );

  return (
    <div className="space-y-4" data-testid="credits-part">
      <SectionCard
        testId="ledger-card"
        icon={BookOpen}
        title="Credits"
        description="Every shift added to or taken off a balance, with the claim behind it. The same entries make up the Balance, so the two always agree."
        bodyClassName="space-y-3"
      >
        <FilterBar label="Credit filters" testId="ledger-filters" sticky={false}>
          <MonthFilter
            value={month}
            today={today}
            allowAll
            onChange={(m, y) => filter({ lmonth: m, lyear: y })}
            label="Month of the entry"
            testId="ledger-month"
          />
          <SelectFilter
            label="Credit or debit"
            value={lu.ltype}
            onChange={(v) => filter({ ltype: v })}
            options={ENTRY_TYPE_OPTIONS}
            allLabel="Credits and debits"
            testId="ledger-type"
          />
          <SelectFilter
            label="Where it came from"
            value={lu.lsource}
            onChange={(v) => filter({ lsource: v })}
            options={LEDGER_SOURCE_OPTIONS}
            allLabel="Every source"
            testId="ledger-source"
          />
          <OrgFilters
            dept={lu.ldept}
            branch={lu.lbranch}
            onDept={(v) => filter({ ldept: v })}
            onBranch={(v) => filter({ lbranch: v })}
            testId="ledger"
          />
          <SearchFilter
            value={lu.lq}
            onChange={(v) => filter({ lq: v })}
            placeholder="Name or code"
            label="Search the credits by name or code"
            testId="ledger-search"
          />
          {lu.lemp && (
            <EmployeeChip name={employeeName} onClear={() => filter({ lemp: "" })} testId="ledger-employee" />
          )}
          <ClearFilters
            count={filtersOn}
            onClear={() => filter({ ltype: "", lsource: "", ldept: "", lbranch: "", lq: "", lemp: "" })}
            testId="ledger-clear"
          />
        </FilterBar>

        <StatRow columns={3} testId="ledger-kpis">
          <StatTile
            label="Credits"
            value={tiles.credits}
            hint={`+${fmtShifts(tiles.creditShifts)} shifts`}
            icon={ArrowUpCircle}
            tone="teal"
            loading={query.isLoading}
            onClick={() => filter({ ltype: lu.ltype === "credit" ? "" : "credit" })}
            active={lu.ltype === "credit"}
            title="Show only the credits"
            testId="ledger-kpi-credits"
          />
          <StatTile
            label="Debits"
            value={tiles.debits}
            hint={`−${fmtShifts(tiles.debitShifts)} shifts`}
            icon={ArrowDownCircle}
            tone="slate"
            loading={query.isLoading}
            onClick={() => filter({ ltype: lu.ltype === "debit" ? "" : "debit" })}
            active={lu.ltype === "debit"}
            title="Show only the debits"
            testId="ledger-kpi-debits"
          />
          <StatTile
            label="Net"
            value={fmtShifts(sumShifts([tiles.creditShifts, -tiles.debitShifts]))}
            hint={`shifts, ${monthChoiceLabel(month)}`}
            icon={Scale}
            tone="indigo"
            loading={query.isLoading}
            testId="ledger-kpi-net"
          />
        </StatRow>

        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id ?? `${r.source}-${r.employeeId}-${r.date}`}
          selectedKey={markedKey}
          loading={query.isLoading}
          error={
            query.isError && !query.data
              ? `Could not load the credits. ${errorMessage(query.error, "Check the connection and try again.")}`
              : null
          }
          onRetry={() => void query.refetch()}
          empty={{
            icon: BookOpen,
            title: filtersOn > 0 ? "No entry matches these filters" : `No entry for ${monthChoiceLabel(month)}`,
            hint: "An entry is made when the Department Head approves a claim, or when a day off is taken from a balance.",
          }}
          pagination={{
            page: pageOf(lu.lpage),
            pageSize: PAGE_SIZE,
            total: query.data?.total ?? 0,
            onPageChange: (p) => setLu({ lpage: p > 1 ? String(p) : "" }),
          }}
          caption="Credits and debits of the compensation balances"
          testId="ledger-table"
        />
      </SectionCard>

      <LegacyCredits />
    </div>
  );
}

/** The Alternative-Day credits from before the overhaul: still visible, each one shift in the balance while available. */
export function LegacyCredits() {
  const query = useCompensationCredits();
  const rows = query.data?.results ?? [];
  const paged = usePaged(rows, `credits|${rows.length}`, 10);
  return (
    <SectionCard
      testId="credits-card"
      icon={Archive}
      title={`Earlier Alternative-Day credits${query.data ? ` (${rows.length})` : ""}`}
      description="From overtime announced before the new rules. Each available credit counts as one shift in the Compensation balance."
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
                      <SmallPerson name={c.employeeName} code={c.employeeCode} />
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

import { useMemo, useState } from "react";
import { FileText } from "lucide-react";
import { useListOutpassRequests, type GateRange, type OutpassRequestItem } from "@/lib/api-client/custom-hooks";
import { inGateRange } from "@/lib/gate-range";
import {
  DataTable,
  PersonCell,
  SearchFilter,
  SelectFilter,
  StatusChip,
  WhenCell,
  fmtCount,
  type DataColumn,
} from "../kit";
import { RANGE_LABEL } from "../shared";
import {
  APPROVAL_CHIP,
  PASS_STATUS_OPTIONS,
  SCAN_STATUS_CHIP,
  formatApprover,
  matchesPassSearch,
  matchesPassStatus,
  type PassFilterStatus,
} from "./logic";

const PAGE_SIZE = 20;

const COLUMNS: DataColumn<OutpassRequestItem>[] = [
  {
    key: "employee",
    header: "Employee",
    cell: (r) => (
      <PersonCell
        name={r.employee?.name ?? `#${r.employeeId}`}
        code={r.employee?.employeeCode}
        photoUrl={r.employee?.photoUrl}
      />
    ),
    text: (r) => r.employee?.name,
    minWidth: 190,
    maxWidth: 260,
  },
  {
    key: "department",
    header: "Department",
    cell: (r) => r.employee?.department ?? "—",
    text: (r) => r.employee?.department,
    hideOnPhone: true,
    maxWidth: 160,
  },
  {
    key: "destination",
    header: "Destination",
    cell: (r) => r.destination,
    text: (r) =>
      r.reason && r.reason.trim() !== (r.destination ?? "").trim() ? `${r.destination}: ${r.reason}` : r.destination,
    maxWidth: 240,
  },
  {
    key: "requested",
    header: "Asked",
    cell: (r) => <WhenCell value={r.createdAt} />,
  },
  {
    key: "approval",
    header: "Approval",
    cell: (r) => {
      const chip = APPROVAL_CHIP[r.status] ?? APPROVAL_CHIP.pending;
      return <StatusChip tone={chip.tone}>{chip.label}</StatusChip>;
    },
    text: (r) => (r.status === "pending" ? null : formatApprover(r.approverRole, r.approvedBy)),
  },
  {
    key: "gate",
    header: "Gate",
    cell: (r) => r.exitGateName ?? "—",
    text: (r) =>
      r.entryGateName && r.entryGateName !== r.exitGateName ? `Back through ${r.entryGateName}` : r.exitGateName,
    hideOnPhone: true,
    maxWidth: 140,
  },
  {
    key: "scan",
    header: "At the gate",
    cell: (r) => {
      const chip = SCAN_STATUS_CHIP[r.scanStatus];
      return chip ? <StatusChip tone={chip.tone}>{chip.label}</StatusChip> : <span className="text-slate-400">—</span>;
    },
    truncate: false,
  },
  {
    key: "out",
    header: "Out",
    cell: (r) => (r.exitedAt ? <WhenCell value={r.exitedAt} /> : <span className="text-slate-400">—</span>),
  },
];

/**
 * Overview > Passes: every pass asked for in the range (the Today / This Week / This Month filter above), newest first,
 * with its decision and where it stands at the gate. The list comes whole from /api/outpass-requests (the Requests
 * module's list, also the sidebar's), so the search and the status filter work on it here.
 */
export function ApprovedPassesSection({
  range,
  status,
  q,
  onFilters,
}: {
  range: GateRange;
  status: PassFilterStatus;
  q: string;
  onFilters: (patch: { status?: PassFilterStatus; q?: string }) => void;
}) {
  const [page, setPage] = useState(1);
  const { data: requests, isLoading, error, refetch } = useListOutpassRequests();
  const inRange = useMemo(
    () =>
      (requests ?? [])
        .filter((r) => inGateRange(r.createdAt, range))
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
    [requests, range],
  );
  const rows = useMemo(
    () => inRange.filter((r) => matchesPassStatus(r, status) && matchesPassSearch(r, q)),
    [inRange, status, q],
  );
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const pageSafe = Math.min(page, pageCount);
  const pageRows = rows.slice((pageSafe - 1) * PAGE_SIZE, pageSafe * PAGE_SIZE);
  const rangeText = RANGE_LABEL[range].toLowerCase();
  const filtered = !!status || !!q.trim();
  const change = (patch: { status?: PassFilterStatus; q?: string }) => {
    setPage(1);
    onFilters(patch);
  };

  const waiting = inRange.filter((r) => r.status === "pending").length;
  const outNow = inRange.filter((r) => !!r.exitedAt && !r.enteredAt).length;
  const summary = requests ? (
    <span>
      <strong className="font-semibold text-slate-900">
        {fmtCount(rows.length)} {rows.length === 1 ? "pass" : "passes"}
      </strong>
      {filtered ? ` of ${fmtCount(inRange.length)}` : ""} · {rangeText}
      {!filtered && waiting > 0 && ` · ${fmtCount(waiting)} waiting`}
      {!filtered && outNow > 0 && ` · ${fmtCount(outNow)} out now`}
    </span>
  ) : null;

  return (
    <DataTable
      columns={COLUMNS}
      rows={requests ? pageRows : undefined}
      rowKey={(r) => r.id}
      loading={isLoading}
      error={error ? "The passes could not be loaded. Your role may not include the Requests module." : null}
      onRetry={() => void refetch()}
      summary={summary}
      toolbar={
        <>
          <SelectFilter
            label="Pass status"
            value={status}
            onChange={(next) => change({ status: next as PassFilterStatus })}
            options={PASS_STATUS_OPTIONS}
            allLabel="Any status"
            testId="passes-status"
          />
          <SearchFilter
            value={q}
            onChange={(next) => change({ q: next })}
            placeholder="Name, code or destination"
            label="Search the passes"
            testId="passes-search"
          />
        </>
      }
      empty={{
        icon: FileText,
        title: filtered ? "No pass matches the search" : `No gate passes asked for ${rangeText}`,
        hint: filtered ? "Clear the search or pick another status." : "Try This Week or This Month.",
      }}
      pagination={{ page: pageSafe, pageSize: PAGE_SIZE, total: rows.length, onPageChange: setPage }}
      caption="Gate passes"
      testId="outpass-passes"
    />
  );
}

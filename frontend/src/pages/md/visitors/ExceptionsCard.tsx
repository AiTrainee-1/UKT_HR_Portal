import { useState, type ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import AskAiButton from "@/components/md/kit/AskAiButton";
import DataTable, { type Column } from "@/components/md/kit/DataTable";
import SectionCard from "@/components/md/kit/SectionCard";
import { ErrorBanner } from "@/components/md/kit/states";
import { PillTabs } from "@/components/ui/pill-tabs";
import { describeMdError } from "@/lib/api-client/custom-hooks/md";
import { minutesText, num } from "@/lib/md/format";
import {
  EMPTY_TEXT,
  daysAgoText,
  exceptionRule,
  exceptionTabs,
  periodPhrase,
  stampText,
  waitText,
  type ExceptionTab,
} from "./logic";
import { Chip, PersonCell } from "./parts";
import type {
  AfterHoursVisit,
  EmployeeRef,
  ExceptionsResponse,
  LongOutpassRow,
  NotReturnedRow,
  RepeatOutpassRow,
  WaitingRow,
} from "./types";

const who = (r: EmployeeRef) => <PersonCell name={r.name} sub={`${r.code} · ${r.department}`} />;
const place = (text: string | null) => <span className="block max-w-[14rem] truncate">{text ?? "—"}</span>;

const typeMix = (r: RepeatOutpassRow) =>
  [
    r.personal > 0 && `${r.personal} personal`,
    r.official > 0 && `${r.official} official`,
    r.earlyDismissal > 0 && `${r.earlyDismissal} early dismissal`,
    r.notStated > 0 && `${r.notStated} no type`,
  ]
    .filter(Boolean)
    .join(" · ");

const repeatColumns: Column<RepeatOutpassRow>[] = [
  { key: "who", header: "Employee", cell: who, sortValue: (r) => r.name },
  { key: "passes", header: "Passes", align: "right", cell: (r) => num(r.passes), sortValue: (r) => r.passes },
  {
    key: "time",
    header: "Time out",
    align: "right",
    cell: (r) => minutesText(r.minutesOut),
    sortValue: (r) => r.minutesOut,
  },
  { key: "mix", header: "Kind of pass", cell: typeMix },
  { key: "last", header: "Last pass", cell: (r) => stampText(r.lastPassAt) },
];

const notReturnedColumns: Column<NotReturnedRow>[] = [
  { key: "who", header: "Employee", cell: who, sortValue: (r) => r.name },
  {
    key: "state",
    header: "Status",
    cell: (r) => <Chip tone={r.state === "outside_now" ? "amber" : "red"}>{r.stateLabel}</Chip>,
  },
  {
    key: "left",
    header: "Left at",
    cell: (r) => (
      <div>
        <p>{stampText(r.exitedAt)}</p>
        {r.state === "outside_now" && r.minutesOutsideSoFar != null && (
          <p className="text-[11px] text-[#006496]/60">out for {minutesText(r.minutesOutsideSoFar)} so far</p>
        )}
        {r.state === "not_returned" && <p className="text-[11px] text-[#006496]/60">{daysAgoText(r.daysAgo)}</p>}
      </div>
    ),
    sortValue: (r) => r.exitedAt,
  },
  { key: "type", header: "Kind of pass", cell: (r) => r.passTypeLabel },
  { key: "dest", header: "Destination", cell: (r) => place(r.destination) },
];

const longColumns: Column<LongOutpassRow>[] = [
  { key: "who", header: "Employee", cell: who, sortValue: (r) => r.name },
  {
    key: "minutes",
    header: "Time out",
    align: "right",
    cell: (r) => <span className="font-semibold text-red-700">{minutesText(r.minutes)}</span>,
    sortValue: (r) => r.minutes,
  },
  { key: "type", header: "Kind of pass", cell: (r) => r.passTypeLabel },
  { key: "dest", header: "Destination", cell: (r) => place(r.destination) },
  { key: "when", header: "Left → back", cell: (r) => `${stampText(r.exitedAt)} → ${stampText(r.enteredAt)}` },
];

const waitingColumns: Column<WaitingRow>[] = [
  { key: "who", header: "Employee", cell: who, sortValue: (r) => r.name },
  {
    key: "wait",
    header: "Waiting",
    cell: (r) => <span className="font-semibold text-red-700">{waitText(r.waitingMinutes)}</span>,
    sortValue: (r) => r.waitingMinutes,
  },
  { key: "asked", header: "Asked at", cell: (r) => stampText(r.requestedAt) },
  { key: "type", header: "Kind of pass", cell: (r) => r.passTypeLabel },
  {
    key: "why",
    header: "Destination and reason",
    cell: (r) => place([r.destination, r.reason].filter(Boolean).join(" — ")),
  },
];

const afterHoursColumns: Column<AfterHoursVisit>[] = [
  { key: "who", header: "Visitor", cell: (r) => <PersonCell name={r.visitorName} /> },
  { key: "at", header: "Checked in", cell: (r) => stampText(r.visitedAt), sortValue: (r) => r.visitedAt },
  {
    key: "host",
    header: "Whom they came to meet",
    cell: (r) => (
      <PersonCell name={r.hostName ?? "—"} sub={r.hostLinked ? r.hostDepartment : "Name typed, not matched"} />
    ),
  },
  { key: "purpose", header: "Purpose", cell: (r) => place(r.purpose) },
];

function TabTable({ tab, data }: { tab: ExceptionTab; data: ExceptionsResponse }) {
  const empty = EMPTY_TEXT[tab];
  switch (tab) {
    case "repeat":
      return (
        <DataTable
          columns={repeatColumns}
          rows={data.repeatOutpass.rows}
          rowKey={(r) => r.employeeId}
          empty={empty}
          testId="md-exceptions-table-repeat"
        />
      );
    case "notReturned":
      return (
        <DataTable
          columns={notReturnedColumns}
          rows={data.notReturned.rows}
          rowKey={(r) => `${r.employeeId}-${r.exitedAt}`}
          empty={empty}
          testId="md-exceptions-table-notReturned"
        />
      );
    case "long":
      return (
        <DataTable
          columns={longColumns}
          rows={data.longOutpasses.rows}
          rowKey={(r) => `${r.employeeId}-${r.exitedAt}`}
          empty={empty}
          testId="md-exceptions-table-long"
        />
      );
    case "waiting":
      return (
        <DataTable
          columns={waitingColumns}
          rows={data.approvalsWaiting.rows}
          rowKey={(r) => `${r.employeeId}-${r.requestedAt}`}
          empty={empty}
          testId="md-exceptions-table-waiting"
        />
      );
    case "afterHours":
      return (
        <DataTable
          columns={afterHoursColumns}
          rows={data.afterHoursVisits.rows}
          rowKey={(r) => r.visitId}
          empty={empty}
          testId="md-exceptions-table-afterHours"
        />
      );
  }
}

const QUESTIONS: Record<ExceptionTab, (when: string) => string> = {
  repeat: (when) => `Who took repeated outpasses ${when}, and how much time did they spend out?`,
  notReturned: (when) => `Which outpasses were never returned ${when}, and who is outside right now?`,
  long: (when) => `Which outpasses were far longer than usual ${when}?`,
  waiting: () => "Which outpass requests have waited more than 24 hours for a decision?",
  afterHours: (when) => `Who visited outside opening hours ${when}, and whom did they come to see?`,
};

/** The people and records behind the findings, one tab per kind: short tables (ten rows, then "Show more"). */
export default function ExceptionsCard({ query }: { query: UseQueryResult<ExceptionsResponse> }) {
  const [tab, setTab] = useState<ExceptionTab>("repeat");
  const d = query.isError ? undefined : query.data;
  const tabs = exceptionTabs(d);
  const note: ReactNode = d ? exceptionRule(tab, d) : null;
  return (
    <SectionCard
      title="Exceptions"
      subtitle="The people and records behind the findings above"
      loading={query.isPending}
      provenance={d?.provenance}
      provenanceIds={["exceptions"]}
      actions={<AskAiButton question={QUESTIONS[tab](periodPhrase(d?.period))} />}
      testId="md-visitors-exceptions"
    >
      {query.isError ? (
        <ErrorBanner message={describeMdError(query.error)} onRetry={() => query.refetch()} />
      ) : (
        <div className="space-y-3">
          <div className="max-w-full overflow-x-auto pb-1" data-testid="md-visitors-exception-tabs">
            <PillTabs size="sm" items={tabs} value={tab} onChange={(v) => setTab(v as ExceptionTab)} />
          </div>
          {note && <p className="text-xs text-[#006496]/60">{note}</p>}
          {d && <TabTable tab={tab} data={d} />}
        </div>
      )}
    </SectionCard>
  );
}

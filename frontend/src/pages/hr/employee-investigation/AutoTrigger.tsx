import { useState } from "react";
import {
  BadgeCheck,
  CalendarSearch,
  Clock,
  History,
  Info,
  Loader2,
  MoonStar,
  Play,
  Power,
  UserCheck,
} from "lucide-react";
import { Chip, EmptyNote, SectionCard } from "@/components/payroll/kit/parts";
import { dateShort, dateTime } from "@/components/payroll/kit/format";
import { Button } from "@/components/ui/button";
import { DataPagination } from "@/components/ui/DataPagination";
import { Switch } from "@/components/ui/switch";
import type {
  InvestigationHistoryItem,
  InvestigationRow,
  InvestigationSettings,
} from "@/lib/api-client/custom-hooks/employee-investigation";
import { cn } from "@/lib/utils";
import { useMediaQuery } from "../production-employees/hooks";
import { paginate, type Selection } from "../salary-slip-center/logic";
import { canReactivate, dayCount, employeeCount, lastRunText, ruleLines, runNowBlock, sinceText } from "./logic";
import { EmployeeStatusChip, KindChip } from "./parts";
import { RowList } from "./RowList";

const TONIGHT_PAGE = 50;
const HISTORY_PAGE = 25;
const LOCKED = "Needs edit rights on this page";

/** The switch, when it runs, its last run and the rule in plain words with its exceptions. */
export function StatusCard({
  settings,
  tonight,
  due,
  canEdit,
  pending,
  running,
  onSwitch,
  onRunNow,
}: {
  settings: InvestigationSettings;
  /** Tonight's list as this tab shows it (its kind). */
  tonight: number;
  /** How many Run now would mark inactive (the whole company); null = not known yet. */
  due: number | null;
  canEdit: boolean;
  pending: boolean;
  /** Run now is on its way. */
  running: boolean;
  /** Asks to switch to this value (the page confirms first). */
  onSwitch: (next: boolean) => void;
  /** Asks to run the Auto Trigger now (the page confirms first). */
  onRunNow: () => void;
}) {
  const { rule, exceptions, counting } = ruleLines(settings);
  const runBlock = runNowBlock(settings, canEdit, due);
  const blocked = !settings.canChange
    ? "The Auto Trigger is one company-wide switch: only a login for all units can change it."
    : !canEdit
      ? "Switching it needs edit rights on this page."
      : null;
  return (
    <SectionCard
      title={
        <span className="flex flex-wrap items-center gap-2">
          Auto Trigger
          {settings.autoEnabled ? (
            <Chip tone="success" icon={Power}>
              On
            </Chip>
          ) : (
            <Chip tone="neutral" icon={Power}>
              Off
            </Chip>
          )}
        </span>
      }
      description={`Runs every night at ${settings.runAt}.`}
      icon={MoonStar}
      testId="inv-auto-status"
      actions={
        <label className="flex items-center gap-2 text-sm font-semibold text-gray-700">
          <Switch
            checked={settings.autoEnabled}
            onCheckedChange={(next) => onSwitch(next)}
            disabled={blocked !== null || pending}
            aria-label="Auto Trigger"
            aria-describedby={blocked ? "inv-auto-blocked" : undefined}
            title={blocked ?? undefined}
            data-testid="inv-auto-switch"
          />
          {settings.autoEnabled ? "On" : "Off"}
        </label>
      }
    >
      <div className="space-y-3 text-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-gray-600">
            <p className="inline-flex items-center gap-1.5" data-testid="inv-auto-last-run">
              <Clock size={13} className="text-gray-400" /> {lastRunText(settings)}
            </p>
            <p className="inline-flex items-center gap-1.5" data-testid="inv-auto-next">
              <MoonStar size={13} className="text-gray-400" />
              {settings.autoEnabled
                ? `Tonight at ${settings.runAt}: ${tonight > 0 ? `${employeeCount(tonight)} would be marked inactive` : "nobody is due"}.`
                : "Switched off: nobody is marked inactive automatically."}
            </p>
          </div>
          <div className="flex flex-col items-start gap-0.5 sm:items-end">
            <span title={runBlock ?? undefined} className="inline-flex">
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5 border-red-200 bg-white text-red-700 hover:bg-red-50 hover:text-red-800"
                onClick={onRunNow}
                disabled={runBlock !== null || running || pending}
                aria-describedby={runBlock ? "inv-run-block" : undefined}
                data-testid="inv-run-now"
              >
                {running ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                Run now
              </Button>
            </span>
            {runBlock ? (
              <p id="inv-run-block" className="text-[11px] text-gray-500" data-testid="inv-run-block">
                {runBlock}
              </p>
            ) : (
              <p className="text-[11px] text-gray-500">
                The same rules as tonight&apos;s run, even while switched off.
              </p>
            )}
          </div>
        </div>
        {blocked && (
          <p
            id="inv-auto-blocked"
            className="flex items-start gap-1.5 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-700"
            data-testid="inv-auto-blocked"
          >
            <Info size={13} className="mt-0.5 shrink-0" /> {blocked}
          </p>
        )}
        <div className="rounded-xl border border-slate-100 bg-slate-50/60 px-3.5 py-3 text-xs leading-relaxed text-gray-700">
          <p className="font-semibold text-gray-900" data-testid="inv-auto-rule">
            {rule}
          </p>
          <p className="mt-2 font-semibold text-gray-800">It never marks inactive:</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5" data-testid="inv-auto-exceptions">
            {exceptions.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
          <p className="mt-2 font-semibold text-gray-800">How days are counted:</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {counting.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      </div>
    </SectionCard>
  );
}

/** Who the next run would mark inactive, ticked or one by one: Keep active, Mark inactive and Leave details. */
export function TonightSection({
  rows,
  settings,
  canEdit,
  busy,
  selection,
  onToggle,
  onToggleAll,
  onDetails,
  onKeep,
  onInactivate,
}: {
  /** The filtered Tonight list (every page). */
  rows: InvestigationRow[];
  settings: InvestigationSettings;
  canEdit: boolean;
  busy: boolean;
  selection: Selection;
  onToggle: (row: InvestigationRow) => void;
  onToggleAll: () => void;
  onDetails: (row: InvestigationRow) => void;
  onKeep: (row: InvestigationRow) => void;
  onInactivate: (row: InvestigationRow) => void;
}) {
  const [page, setPage] = useState(1);
  const paged = paginate(rows, page, TONIGHT_PAGE);
  return (
    <SectionCard
      title={`Tonight (${rows.length})`}
      description={
        settings.autoEnabled
          ? `Who the next run, tonight at ${settings.runAt}, would mark inactive. Keep active leaves someone alone until they attend again; Mark inactive does it now, with your reason.`
          : "The Auto Trigger is switched off: these employees would be marked inactive if it were on."
      }
      icon={Clock}
      testId="inv-tonight"
      bodyClassName="space-y-3"
    >
      {rows.length === 0 ? (
        <EmptyNote
          icon={BadgeCheck}
          title="Nobody is due"
          hint="No active employee in this list is away more than the Auto Trigger's days without an exception."
          className="bg-white py-8"
          testId="inv-tonight-empty"
        />
      ) : (
        <>
          <RowList
            rows={paged.rows}
            allRows={rows}
            selection={selection}
            onToggle={onToggle}
            onToggleAll={onToggleAll}
            settings={settings}
            showWhyNot={false}
            onDetails={onDetails}
            onKeep={onKeep}
            onInactivate={onInactivate}
            canEdit={canEdit}
            busy={busy}
            testPrefix="inv-tonight"
            caption="Employees the next Auto Trigger run would mark inactive"
          />
          <DataPagination
            page={paged.page}
            totalPages={paged.totalPages}
            totalItems={paged.total}
            pageSize={TONIGHT_PAGE}
            onPageChange={setPage}
          />
        </>
      )}
    </SectionCard>
  );
}

function HistoryActions({
  item,
  canEdit,
  busy,
  onDetails,
  onReactivate,
  compact,
}: {
  item: InvestigationHistoryItem;
  canEdit: boolean;
  busy: boolean;
  onDetails: (employeeId: number) => void;
  onReactivate: (item: InvestigationHistoryItem) => void;
  compact?: boolean;
}) {
  return (
    <div className={cn("flex flex-wrap items-center gap-1", !compact && "justify-end")}>
      <Button
        variant="outline"
        size="sm"
        className="h-8 gap-1 px-2.5"
        onClick={() => onDetails(item.employee.id)}
        aria-label={`Leave details of ${item.employee.name}`}
        data-testid={`inv-history-details-${item.id}`}
      >
        <CalendarSearch size={14} /> Leave details
      </Button>
      {canReactivate(item) && (
        <span title={canEdit ? undefined : LOCKED} className="inline-flex">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1 px-2 text-emerald-700 hover:bg-emerald-50 hover:text-emerald-800"
            onClick={() => onReactivate(item)}
            disabled={!canEdit || busy}
            aria-label={canEdit ? `Make ${item.employee.name} active again` : `Make active again: ${LOCKED}`}
            data-testid={`inv-history-reactivate-${item.id}`}
          >
            <UserCheck size={14} /> Make active again
          </Button>
        </span>
      )}
    </div>
  );
}

function HistoryEmployee({ item }: { item: InvestigationHistoryItem }) {
  const e = item.employee;
  return (
    <div className="min-w-0 leading-tight">
      <div className="flex flex-wrap items-center gap-1.5">
        <p className="truncate font-semibold text-gray-900" title={e.name}>
          {e.name}
        </p>
        <KindChip kind={e.kind} />
      </div>
      <p className="mt-0.5 font-mono text-xs text-gray-500">{e.code}</p>
      <p className="truncate text-xs text-gray-600">
        {e.department || "No department"}
        {e.unit && <> · {e.unit}</>}
      </p>
    </div>
  );
}

function HistoryStatus({ item }: { item: InvestigationHistoryItem }) {
  const since = sinceText(item);
  return (
    <div className="flex min-w-0 flex-col items-start gap-1">
      <EmployeeStatusChip status={item.employee.status} />
      {since && (
        <p className="text-[11px] leading-snug text-gray-600" data-testid={`inv-history-since-${item.id}`}>
          {since}
        </p>
      )}
    </div>
  );
}

/** Everyone the Auto Trigger marked inactive, newest first, with what happened since. */
export function HistorySection({
  items,
  canEdit,
  busy,
  onDetails,
  onReactivate,
}: {
  items: InvestigationHistoryItem[];
  canEdit: boolean;
  busy: boolean;
  onDetails: (employeeId: number) => void;
  onReactivate: (item: InvestigationHistoryItem) => void;
}) {
  const wide = useMediaQuery("(min-width: 1024px)");
  const [page, setPage] = useState(1);
  const paged = paginate(items, page, HISTORY_PAGE);
  const actions = { canEdit, busy, onDetails, onReactivate };
  return (
    <SectionCard
      title={`History (${items.length})`}
      description="Everyone the Auto Trigger marked inactive, newest first. Make active again when it should not have."
      icon={History}
      testId="inv-history"
      bodyClassName="space-y-3"
    >
      {items.length === 0 ? (
        <EmptyNote
          icon={History}
          title="The Auto Trigger has not marked anyone inactive"
          className="bg-white py-8"
          testId="inv-history-empty"
        />
      ) : wide ? (
        <div className="overflow-x-auto rounded-2xl border bg-white" data-testid="inv-history-table">
          <table className="w-full min-w-[1000px] text-sm">
            <caption className="sr-only">Employees the Auto Trigger marked inactive</caption>
            <thead className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
              <tr>
                <th scope="col" className="px-3 py-2.5">
                  Employee
                </th>
                <th scope="col" className="px-3 py-2.5">
                  Marked inactive
                </th>
                <th scope="col" className="px-3 py-2.5">
                  Days away
                </th>
                <th scope="col" className="px-3 py-2.5">
                  Last attended
                </th>
                <th scope="col" className="px-3 py-2.5">
                  Reason
                </th>
                <th scope="col" className="px-3 py-2.5">
                  Status now
                </th>
                <th scope="col" className="px-3 py-2.5 text-right">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {paged.rows.map((item) => (
                <tr key={item.id} className="align-top hover:bg-gray-50/60" data-testid={`inv-history-row-${item.id}`}>
                  <td className="max-w-[240px] px-3 py-3">
                    <HistoryEmployee item={item} />
                  </td>
                  <td className="max-w-[200px] px-3 py-3 text-xs text-gray-700">
                    <p className="whitespace-nowrap">{dateTime(item.at)}</p>
                    {item.by && (
                      <p className="text-[11px] text-gray-500" data-testid={`inv-history-by-${item.id}`}>
                        by {item.by}
                      </p>
                    )}
                  </td>
                  <td className="px-3 py-3">
                    <p className="font-bold tabular-nums text-gray-900">{dayCount(item.absentDays)}</p>
                    <p className="text-[11px] text-gray-500">{item.calendarDays} calendar days</p>
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 text-xs text-gray-700">
                    {item.lastAttended ? dateShort(item.lastAttended) : "Never"}
                  </td>
                  <td className="max-w-[260px] px-3 py-3 text-xs text-gray-700">{item.reason ?? "—"}</td>
                  <td className="max-w-[220px] px-3 py-3">
                    <HistoryStatus item={item} />
                  </td>
                  <td className="px-3 py-3">
                    <HistoryActions item={item} {...actions} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="space-y-2" data-testid="inv-history-cards" role="list" aria-label="Auto Trigger history">
          {paged.rows.map((item) => (
            <div
              key={item.id}
              role="listitem"
              className="space-y-2 rounded-2xl border bg-white p-3"
              data-testid={`inv-history-row-${item.id}`}
            >
              <div className="flex items-start justify-between gap-3">
                <HistoryEmployee item={item} />
                <div className="shrink-0 text-right">
                  <p className="font-black tabular-nums text-gray-900">{dayCount(item.absentDays)}</p>
                  <p className="text-[11px] text-gray-500">{item.calendarDays} calendar days</p>
                </div>
              </div>
              <p className="text-xs text-gray-600">
                Marked inactive {dateTime(item.at)}
                {item.by && <span data-testid={`inv-history-by-${item.id}`}> by {item.by}</span>} · last attended{" "}
                {item.lastAttended ? dateShort(item.lastAttended) : "never"}
              </p>
              {item.reason && <p className="text-xs text-gray-700">{item.reason}</p>}
              <HistoryStatus item={item} />
              <HistoryActions item={item} compact {...actions} />
            </div>
          ))}
        </div>
      )}
      {items.length > 0 && (
        <DataPagination
          page={paged.page}
          totalPages={paged.totalPages}
          totalItems={paged.total}
          pageSize={HISTORY_PAGE}
          onPageChange={setPage}
        />
      )}
    </SectionCard>
  );
}

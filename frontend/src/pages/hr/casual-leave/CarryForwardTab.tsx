import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { ArrowRight, CalendarCheck2, History, ScrollText, Search, Wallet, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { PillTabs } from "@/components/ui/pill-tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useIsMobile } from "@/hooks/use-mobile";
import { isRouteViewOnly, useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { moduleForPath } from "@/lib/permission-modules";
import { TONE } from "@/lib/statusTones";
import { pickVisible, useLevel, useViewOnlyLock, ViewOnlyTabNote, visibleItems } from "@/lib/tab-access";
import { cn } from "@/lib/utils";
import { exportSheet } from "../leave/export";
import { ALL, type Option, type PersonFilters } from "../leave/logic";
import {
  Chip,
  EmptyState,
  ErrorState,
  ExportButton,
  FilterPanel,
  ListSkeleton,
  MoreRows,
  PersonCell,
  ResultLine,
  SearchBox,
  useVisibleCount,
} from "../leave/parts";
import ClTab from "./ClTab";
import DeductDialog from "./DeductDialog";
import { useAssignCl, useClAdjustments } from "./api";
import {
  CARRY_EXPORT_HEADERS,
  LOG_EXPORT_HEADERS,
  assignedText,
  carryCounts,
  carryExportRows,
  carryRows,
  PORTION_TEXT,
  chipDate,
  daysNumber,
  filterCarry,
  filterLog,
  logExportRows,
  logPerson,
  partsOf,
  whenText,
  type CarryRow,
  type ClAdjustProblem,
  type ClAdjustment,
  type PickedDate,
} from "./carry-forward";
import { NO_CL_FILTERS, balanceLevel, clFiltersActive, type BoardRow } from "./logic";

const HEAD = "text-[11px] font-bold uppercase tracking-wider text-[#006496]/60";

const LEFT_TONE: Record<NonNullable<ReturnType<typeof balanceLevel>>, string> = {
  full: "text-emerald-700",
  some: "text-sky-800",
  low: "text-amber-700",
  none: "text-rose-700",
};

const where = (r: { department?: string | null; branch?: string | null }) =>
  [r.department, r.branch].filter(Boolean).join(" · ") || null;

/** "10 of 12" with a thin bar of what is left. */
function LeftCell({ r }: { r: CarryRow }) {
  const level = balanceLevel(r.balance);
  const share = r.balance.total ? r.balance.remaining / r.balance.total : 0;
  return (
    <span className="inline-flex min-w-24 flex-col gap-1" data-testid={`cf-left-${r.employeeId}`}>
      <span className="inline-flex items-baseline gap-1">
        <span className={cn("text-lg font-black tabular-nums", level && LEFT_TONE[level])}>
          {daysNumber(r.balance.remaining)}
        </span>{" "}
        <span className="text-xs text-gray-500">of {daysNumber(r.balance.total)}</span>
      </span>
      <span className="h-1 w-full overflow-hidden rounded-full bg-slate-100" aria-hidden>
        <span className="block h-full rounded-full bg-emerald-400" style={{ width: `${Math.round(share * 100)}%` }} />
      </span>
    </span>
  );
}

/** A staff member who cannot use Casual Leave yet still has a balance; say so beside the name. */
function NotYetChip({ r }: { r: BoardRow }) {
  if (r.reasonCode === "under_service") return <Chip className={TONE.neutral}>Under 6 months</Chip>;
  if (r.reasonCode === "no_join_date") return <Chip className={TONE.neutral}>No join date</Chip>;
  return null;
}

function RowActions({
  r,
  canEdit,
  onAssign,
  onHistory,
}: {
  r: CarryRow;
  canEdit: boolean;
  onAssign: (rows: CarryRow[]) => void;
  onHistory: (r: BoardRow) => void;
}) {
  return (
    <div className="flex items-center justify-end gap-1.5">
      <Button
        size="sm"
        variant="outline"
        className="h-8 gap-1 border-[#006496]/30 text-xs text-[#006496]"
        onClick={() => onAssign([r])}
        disabled={!canEdit || r.balance.remaining <= 0}
        title={
          !canEdit
            ? "Only this year's Casual Leave can be given"
            : r.balance.remaining <= 0
              ? "No Casual Leave left this year"
              : `Assign CL for absent or leave days of ${r.employeeName ?? r.employeeCode}`
        }
        data-testid={`cf-assign-${r.employeeId}`}
      >
        <CalendarCheck2 size={12} /> Assign CL
      </Button>
      <span data-view-safe>
        <button
          type="button"
          onClick={() => onHistory(r)}
          className="rounded-lg p-1.5 text-gray-400 hover:bg-sky-50 hover:text-[#006496] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
          title="See the Casual Leave history of the year"
          aria-label={`Casual Leave history of ${r.employeeName ?? r.employeeCode}`}
          data-testid={`cf-history-${r.employeeId}`}
        >
          <History size={15} />
        </button>
      </span>
    </div>
  );
}

function BalanceList({
  rows,
  selected,
  onToggle,
  allShown,
  onToggleAll,
  canEdit,
  onAssign,
  onHistory,
}: {
  rows: CarryRow[];
  selected: Set<number>;
  onToggle: (id: number) => void;
  allShown: boolean | "indeterminate";
  onToggleAll: () => void;
  canEdit: boolean;
  onAssign: (rows: CarryRow[]) => void;
  onHistory: (r: BoardRow) => void;
}) {
  // one layout at a time: an employee's test ids are on the page once
  const phone = useIsMobile();
  if (!phone) {
    return (
      <Table data-testid="cf-table">
        <TableHeader>
          <TableRow>
            <TableHead className="w-10">
              <Checkbox
                checked={allShown}
                onCheckedChange={onToggleAll}
                disabled={!canEdit}
                aria-label="Tick every employee in the list"
                data-testid="cf-select-all"
              />
            </TableHead>
            <TableHead className={HEAD}>Employee</TableHead>
            <TableHead className={cn(HEAD, "text-center")}>A year</TableHead>
            <TableHead className={cn(HEAD, "text-center")}>Used</TableHead>
            <TableHead className={cn(HEAD, "text-center")}>Waiting</TableHead>
            <TableHead className={HEAD}>Left now</TableHead>
            <TableHead className={cn(HEAD, "text-right")}>Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow
              key={r.employeeId}
              data-testid={`cf-row-${r.employeeId}`}
              data-state={selected.has(r.employeeId) ? "selected" : undefined}
            >
              <TableCell>
                <Checkbox
                  checked={selected.has(r.employeeId)}
                  onCheckedChange={() => onToggle(r.employeeId)}
                  disabled={!canEdit}
                  aria-label={`Tick ${r.employeeName ?? r.employeeCode}`}
                  data-testid={`cf-select-${r.employeeId}`}
                />
              </TableCell>
              <TableCell>
                <PersonCell id={r.employeeId} name={r.employeeName} code={r.employeeCode} sub={where(r)} />
                <div className="mt-1 pl-12 empty:hidden">
                  <NotYetChip r={r} />
                </div>
              </TableCell>
              <TableCell className="text-center text-sm tabular-nums text-gray-700">
                {daysNumber(r.balance.total)}
              </TableCell>
              <TableCell className="text-center text-sm tabular-nums text-gray-700">
                {r.balance.used ? daysNumber(r.balance.used) : <span className="text-gray-300">0</span>}
              </TableCell>
              <TableCell className="text-center text-sm tabular-nums text-gray-700">
                {r.balance.pending ? daysNumber(r.balance.pending) : <span className="text-gray-300">0</span>}
              </TableCell>
              <TableCell>
                <LeftCell r={r} />
              </TableCell>
              <TableCell>
                <RowActions r={r} canEdit={canEdit} onAssign={onAssign} onHistory={onHistory} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    );
  }
  return (
    <ul className="divide-y" data-testid="cf-cards">
      {rows.map((r) => (
        <li key={r.employeeId} className="space-y-2 px-4 py-3" data-testid={`cf-card-${r.employeeId}`}>
          <div className="flex items-start gap-3">
            <Checkbox
              className="mt-2.5"
              checked={selected.has(r.employeeId)}
              onCheckedChange={() => onToggle(r.employeeId)}
              disabled={!canEdit}
              aria-label={`Tick ${r.employeeName ?? r.employeeCode}`}
            />
            <div className="min-w-0 flex-1">
              <PersonCell id={r.employeeId} name={r.employeeName} code={r.employeeCode} sub={where(r)} size="sm" />
            </div>
            <LeftCell r={r} />
          </div>
          <div className="flex flex-wrap items-center gap-1.5 pl-7 text-xs text-gray-600">
            {r.balance.used > 0 && <Chip className={TONE.neutral}>{daysNumber(r.balance.used)} used</Chip>}
            {r.balance.pending > 0 && <Chip className={TONE.warning}>{daysNumber(r.balance.pending)} waiting</Chip>}
            <NotYetChip r={r} />
          </div>
          <div className="pl-7">
            <RowActions r={r} canEdit={canEdit} onAssign={onAssign} onHistory={onHistory} />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** The dates of a round, as small sky-blue chips. */
function DateChips({ a }: { a: ClAdjustment }) {
  return (
    <span className="flex flex-wrap gap-1" data-testid={`cf-log-dates-${a.id}`}>
      {partsOf(a).map((p) => (
        <span
          key={p.date}
          className="rounded-full bg-sky-50 px-2 py-0.5 text-[11px] font-semibold text-sky-800 ring-1 ring-sky-100"
          title={PORTION_TEXT[p.portion]}
        >
          {chipDate(p.date)}
          {p.portion !== "full" && (
            <span className="ml-1 rounded bg-sky-200/70 px-1 text-[10px] font-bold">
              {p.portion === "first_half" ? "1st half" : "2nd half"}
            </span>
          )}
        </span>
      ))}
    </span>
  );
}

function LogList({ items }: { items: ClAdjustment[] }) {
  const phone = useIsMobile();
  const left = (a: ClAdjustment) => (
    <span className="inline-flex items-center gap-1 text-sm font-bold tabular-nums text-gray-900">
      {daysNumber(a.balanceBefore)}
      <ArrowRight size={12} className="text-gray-400" aria-hidden />
      {daysNumber(a.balanceAfter)}
    </span>
  );
  if (!phone) {
    return (
      <Table data-testid="cf-log-table">
        <TableHeader>
          <TableRow>
            <TableHead className={HEAD}>When</TableHead>
            <TableHead className={HEAD}>Employee</TableHead>
            <TableHead className={HEAD}>Given as Casual Leave</TableHead>
            <TableHead className={HEAD}>Left</TableHead>
            <TableHead className={HEAD}>Reason</TableHead>
            <TableHead className={HEAD}>By</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((a) => (
            <TableRow key={a.id} data-testid={`cf-log-${a.id}`}>
              <TableCell className="whitespace-nowrap text-xs text-gray-600">{whenText(a.createdAt)}</TableCell>
              <TableCell>
                <PersonCell
                  id={a.employeeId}
                  name={a.employeeName}
                  code={a.employeeCode}
                  sub={where(logPerson(a))}
                  size="sm"
                />
              </TableCell>
              <TableCell className="max-w-[16rem]">
                <DateChips a={a} />
              </TableCell>
              <TableCell className="whitespace-nowrap">{left(a)}</TableCell>
              <TableCell className="max-w-[16rem] text-xs text-gray-700">{a.reason}</TableCell>
              <TableCell className="whitespace-nowrap text-xs text-gray-600">{a.createdBy ?? "-"}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    );
  }
  return (
    <ul className="divide-y" data-testid="cf-log-cards">
      {items.map((a) => (
        <li key={a.id} className="space-y-1.5 px-4 py-3" data-testid={`cf-log-${a.id}`}>
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <PersonCell id={a.employeeId} name={a.employeeName} code={a.employeeCode} size="sm" />
            </div>
            {left(a)}
          </div>
          <DateChips a={a} />
          <p className="text-xs text-gray-700">{a.reason}</p>
          <p className="text-[11px] text-gray-500">
            {whenText(a.createdAt)} · {a.createdBy ?? "HR"}
          </p>
        </li>
      ))}
    </ul>
  );
}

type View = "balances" | "log";

// Each part's own permission key; a key with no setting follows the Carry Forward tab.
const VIEW_KEY: Record<View, string> = {
  balances: "casual_leave.carry_forward.balances",
  log: "casual_leave.carry_forward.log",
};
const VIEWS = Object.keys(VIEW_KEY) as View[];

/**
 * Carry Forward (owner 2026-11-04): each staff member's Casual Leave balance for the year (a fixed 12), the place to turn
 * their absent or on-leave days into Casual Leave (one employee, or several ticked at once), and the log of every round
 * with the balance before and after. Only this year's Casual Leave can be given.
 */
export default function CarryForwardTab({
  board,
  loading,
  failed,
  onRetry,
  branches,
  departments,
  year,
  month,
  today,
  onHistory,
}: {
  board: BoardRow[];
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
  branches: Option[];
  departments: Option[];
  year: number;
  /** The page's month: the detection opens on it. */
  month: number;
  today: { year: number; month: number };
  onHistory: (r: BoardRow) => void;
}) {
  const { toast } = useToast();
  const { user } = useAuth();
  const [location] = useLocation();
  const level = useLevel();
  // Only the parts this role may see; a hidden one is never shown (its list is never loaded).
  const views = visibleItems(VIEWS, (v) => VIEW_KEY[v], level);
  const [askedView, setView] = useState<View>("balances");
  const view = pickVisible(askedView, views);
  // A part this role may only VIEW, when neither the page nor the Carry Forward tab is View-only already (those lock it).
  const viewOnly =
    views.length > 0 &&
    !isRouteViewOnly(user, location, moduleForPath(location)) &&
    level("casual_leave.carry_forward") !== "view" &&
    level(VIEW_KEY[view]) === "view";
  useViewOnlyLock(viewOnly, view);
  const [filters, setFilters] = useState<PersonFilters>(NO_CL_FILTERS);
  const [pill, setPill] = useState<string>(ALL);
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [targets, setTargets] = useState<CarryRow[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [problems, setProblems] = useState<ClAdjustProblem[]>([]);
  const [logQuery, setLogQuery] = useState("");
  const more = useVisibleCount();
  const logMore = useVisibleCount();

  const canEdit = year === today.year;
  const assign = useAssignCl();
  const log = useClAdjustments(year, view === "log" && views.includes("log"));

  const all = useMemo(() => carryRows(board), [board]);
  const counts = useMemo(() => carryCounts(all), [all]);
  const shown = useMemo(() => filterCarry(all, filters, pill), [all, filters, pill]);
  const byId = useMemo(() => new Map(all.map((r) => [r.employeeId, r])), [all]);
  const picked = useMemo(
    () => [...selected].map((id) => byId.get(id)).filter((r): r is CarryRow => !!r && r.balance.remaining > 0),
    [selected, byId],
  );
  const shownTicked = shown.filter((r) => selected.has(r.employeeId)).length;
  const allShown: boolean | "indeterminate" =
    shown.length > 0 && shownTicked === shown.length ? true : shownTicked > 0 ? "indeterminate" : false;

  const logItems = useMemo(() => log.data?.items ?? [], [log.data]);
  const logShown = useMemo(() => filterLog(logItems, logQuery), [logItems, logQuery]);
  const summary = log.data?.summary;

  const toggle = (id: number) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAll = () =>
    setSelected((s) => {
      const next = new Set(s);
      if (allShown === true) shown.forEach((r) => next.delete(r.employeeId));
      else shown.forEach((r) => next.add(r.employeeId));
      return next;
    });

  const openAssign = (rows: CarryRow[]) => {
    setProblem(null);
    setProblems([]);
    setTargets(rows);
  };

  const submit = async (input: {
    reason: string;
    items: { employeeId: number; limit: number; dates: PickedDate[] }[];
  }) => {
    setProblem(null);
    setProblems([]);
    try {
      const saved = await assign.mutateAsync(input);
      toast({ title: "Casual Leave assigned", description: assignedText(saved) });
      setTargets(null);
      setSelected(new Set());
    } catch (err: any) {
      setProblem(err?.data?.error ?? err?.message ?? "Could not save the change");
      setProblems(Array.isArray(err?.data?.problems) ? err.data.problems : []);
    }
  };

  return (
    <div className="space-y-4 pt-4" data-testid="tab-carry-forward">
      <div className="flex flex-wrap items-start justify-between gap-3 rounded-2xl border border-sky-100 bg-sky-50/70 p-3">
        <p className="max-w-3xl text-xs leading-relaxed text-sky-900">
          Unused Casual Leave carries forward through the year; the balance stays <strong>12 days a year</strong>.{" "}
          <strong>Assign CL</strong> turns the days an employee was marked Absent or On Leave into Casual Leave: enter
          the most days, the system detects those days for the month, and you pick the dates. Only the picked dates are
          used, and each round is kept in the Change log with the balance before and after.{" "}
          {canEdit
            ? "Unused days lapse on 31 December."
            : `This is ${year}: only this year's (${today.year}) Casual Leave can be given.`}
        </p>
        {views.length > 0 && (
          <PillTabs
            size="sm"
            items={visibleItems(
              [
                { value: "balances", label: "Balances", icon: <Wallet size={13} />, count: counts.all },
                { value: "log", label: "Change log", icon: <ScrollText size={13} />, count: summary?.changes },
              ],
              (v) => VIEW_KEY[v.value as View],
              level,
            )}
            value={view}
            onChange={(v) => setView(v as View)}
          />
        )}
      </div>
      <ViewOnlyTabNote show={viewOnly} testId="cf-view-only" />

      {views.length === 0 ? (
        <p
          className="rounded-2xl bg-white p-6 text-center text-sm text-muted-foreground shadow-sm"
          data-testid="cf-nothing-open"
        >
          Nothing on this page is open to your role.
        </p>
      ) : view === "balances" ? (
        <ClTab
          id="cf-balances"
          filters={filters}
          onFilters={setFilters}
          noFilters={NO_CL_FILTERS}
          branches={branches}
          departments={departments}
          showEmployeeType={false}
          searchLabel="Search staff balances"
          pills={{
            items: [
              { value: "all", label: "All staff", count: counts.all },
              { value: "left", label: "CL left", count: counts.left },
              { value: "none-left", label: "None left", count: counts["none-left"] },
            ],
            value: pill,
            onChange: setPill,
          }}
          loading={loading}
          failed={failed}
          onRetry={onRetry}
          total={all.length}
          shown={shown.length}
          visible={more.count}
          onMore={more.more}
          noun="staff balances"
          active={clFiltersActive(filters, [pill])}
          empty={{
            icon: Wallet,
            title: `No Casual Leave balance is kept for ${year}`,
            text: "Staff appear here with their yearly balance once the year's balance has started.",
          }}
          onExport={() => exportSheet(`Casual leave balances ${year}`, CARRY_EXPORT_HEADERS, carryExportRows(shown))}
        >
          {selected.size > 0 && (
            <div
              className="sticky top-0 z-20 flex flex-wrap items-center justify-between gap-2 border-b border-[#006496]/15 bg-[#006496]/5 px-4 py-2"
              data-testid="cf-selection"
            >
              <p className="text-sm font-bold text-[#006496]">
                {selected.size} employee{selected.size === 1 ? "" : "s"} ticked
              </p>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  className="h-8 gap-1 bg-[#006496] text-xs hover:bg-[#00547e]"
                  onClick={() => openAssign(picked)}
                  disabled={!canEdit || picked.length === 0}
                  data-testid="cf-assign-selected"
                >
                  <CalendarCheck2 size={13} /> Assign CL for them
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 gap-1 text-xs"
                  onClick={() => setSelected(new Set())}
                  data-view-safe
                >
                  <X size={13} /> Untick all
                </Button>
              </div>
            </div>
          )}
          <BalanceList
            rows={shown.slice(0, more.count)}
            selected={selected}
            onToggle={toggle}
            allShown={allShown}
            onToggleAll={toggleAll}
            canEdit={canEdit}
            onAssign={openAssign}
            onHistory={onHistory}
          />
        </ClTab>
      ) : (
        <div className="space-y-4" data-testid="cf-log">
          <FilterPanel>
            <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
              <SearchBox
                value={logQuery}
                onChange={setLogQuery}
                placeholder="Search by name, employee code, reason or who made the change"
                label="Search the change log"
                testId="cf-log-search"
              />
              <ExportButton
                disabled={logShown.length === 0}
                onClick={() => exportSheet(`Casual leave given ${year}`, LOG_EXPORT_HEADERS, logExportRows(logShown))}
                testId="cf-log-export"
              />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              {summary && summary.changes > 0 ? (
                <p className="text-xs text-gray-600" data-testid="cf-log-summary">
                  {year}: {summary.days} day{summary.days === 1 ? "" : "s"} given as Casual Leave to {summary.employees}{" "}
                  employee{summary.employees === 1 ? "" : "s"} in {summary.changes} round
                  {summary.changes === 1 ? "" : "s"}
                </p>
              ) : (
                <span />
              )}
              <ResultLine
                shown={logShown.length}
                total={logItems.length}
                noun="rounds"
                active={logQuery.trim() !== ""}
                onClear={() => setLogQuery("")}
                testId="cf-log-count"
              />
            </div>
          </FilterPanel>

          <Card className="overflow-hidden rounded-2xl">
            <CardContent className="p-0">
              {log.isLoading ? (
                <ListSkeleton testId="cf-log-loading" />
              ) : log.isError ? (
                <ErrorState what="changes" onRetry={() => void log.refetch()} testId="cf-log-error" />
              ) : logItems.length === 0 ? (
                <EmptyState
                  icon={ScrollText}
                  title={`Nothing given in ${year} yet`}
                  text="Every time HR turns absent or leave days into Casual Leave it is kept here, with the balance before and after."
                  testId="cf-log-empty"
                />
              ) : logShown.length === 0 ? (
                <EmptyState
                  icon={Search}
                  title="No rounds match"
                  text="Try fewer words, or clear the search."
                  tone="bg-gray-100 text-gray-500"
                  testId="cf-log-no-match"
                />
              ) : (
                <>
                  <LogList items={logShown.slice(0, logMore.count)} />
                  <MoreRows
                    shown={Math.min(logMore.count, logShown.length)}
                    total={logShown.length}
                    onMore={logMore.more}
                  />
                </>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      <DeductDialog
        targets={targets}
        year={year}
        month={month}
        today={today}
        saving={assign.isPending}
        problem={problem}
        problems={problems}
        onClose={() => setTargets(null)}
        onAssign={(input) => void submit(input)}
      />
    </div>
  );
}

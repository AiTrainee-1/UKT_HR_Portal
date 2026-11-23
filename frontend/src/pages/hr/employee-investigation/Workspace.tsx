import { useMemo, useState } from "react";
import { Link } from "wouter";
import {
  AlertTriangle,
  ArrowLeft,
  Info,
  PowerOff,
  SearchX,
  ShieldCheck,
  UserCheck,
  UserSearch,
  UserX,
  X,
} from "lucide-react";
import { RefreshButton } from "@/components/PageRefreshBar";
import { dateShort } from "@/components/payroll/kit/format";
import { Button } from "@/components/ui/button";
import { DataPagination } from "@/components/ui/DataPagination";
import { PillTabs } from "@/components/ui/pill-tabs";
import { canEdit, isRouteViewOnly, useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import {
  useInvestigationAction,
  useInvestigationAuto,
  useInvestigationList,
  useRunInvestigationNow,
  useSetInvestigationAuto,
  type InvestigationBucket,
  type InvestigationDecisionBucket,
  type InvestigationHistoryItem,
  type InvestigationKind,
  type InvestigationRow,
} from "@/lib/api-client/custom-hooks/employee-investigation";
import { moduleForPath } from "@/lib/permission-modules";
import {
  NO_SELECTION,
  PAGE_SIZE,
  deselectRows,
  hiddenSelected,
  listSelection,
  paginate,
  selectRows,
  toggleId,
  type Selection,
} from "../salary-slip-center/logic";
import { AutoSwitchDialog, DecisionDialog, RunNowDialog, type DecisionTarget } from "./ActionDialogs";
import { HistorySection, StatusCard, TonightSection } from "./AutoTrigger";
import { DetailSheet } from "./DetailSheet";
import {
  ALL,
  DECISION_PATH,
  EMPLOYEES_PATH,
  INVESTIGATION_MODULE,
  INVESTIGATION_PATH,
  NO_FILTERS,
  TABS,
  TAB_LABEL,
  decisionBody,
  doneTitle,
  employeeCount,
  errorText,
  filtersActive,
  isTab,
  keepOffered,
  matchesFilters,
  optionsOf,
  parseKind,
  parseTab,
  refusalReport,
  runNowDoneTitle,
  type Filters,
  type InvestigationTab,
  type ResultReport,
} from "./logic";
import { ACCENT, Banner, EmptyNote, ListSkeleton, LoadError, ResultPanel } from "./parts";
import { RowList } from "./RowList";
import { Toolbar } from "./Toolbar";

const NO_ROWS: InvestigationRow[] = [];
const NO_HISTORY: InvestigationHistoryItem[] = [];

type Props = {
  url: Record<string, string>;
  setUrl: (patch: Record<string, string>) => void;
};

/** A decision waiting for its reason: the employees, what to do, and the list it is decided in. */
type PendingDecision = DecisionTarget & {
  rows: { id: number; name: string; code: string; bucket?: InvestigationBucket | null }[];
  bucket: InvestigationDecisionBucket | null;
};

/**
 * The Investigation page under HrLayout: the title, the 15 Days / 30 Days / Auto Trigger tabs with their counts, the kind
 * and filters, the lists with ticks and row actions, the bulk bar, the refusals, the Auto Trigger's status card, Tonight
 * and History, the Leave details sheet and the decision / switch dialogs.
 */
export function Workspace({ url, setUrl }: Props) {
  const { user } = useAuth();
  const { toast } = useToast();
  const tab = parseTab(url.tab);
  const kind = parseKind(url.kind);
  const onAuto = tab === "auto";
  const moduleKey = moduleForPath(INVESTIGATION_PATH) ?? INVESTIGATION_MODULE;
  // Keep active, Mark inactive, Make active again and the switch need the page's Edit right (the server checks it too)
  const mayEdit = canEdit(user, moduleKey);
  const layoutViewOnly = isRouteViewOnly(user, INVESTIGATION_PATH, moduleKey);

  // The list of the open tab; on the Auto Trigger tab the 15 Days list is still read for the tabs' counts.
  const bucket: InvestigationBucket = tab === "30" ? "30" : "15";
  const list = useInvestigationList(bucket, kind);
  const auto = useInvestigationAuto(kind, { enabled: onAuto });
  const settings = auto.data?.settings ?? list.data?.settings;
  const counts = list.data?.counts;

  const [search, setSearch] = useState("");
  const listRows = list.data?.employees ?? NO_ROWS;
  const tonight = auto.data?.tonight ?? NO_ROWS;
  const history = auto.data?.history ?? NO_HISTORY;

  // The filter lists come from what the open tab lists (History items carry names, not ids: the names are the values).
  const departments = useMemo(
    () =>
      optionsOf(
        onAuto
          ? [...tonight.map((r) => r.department), ...history.map((h) => h.employee.department)]
          : listRows.map((r) => r.department),
      ),
    [onAuto, tonight, history, listRows],
  );
  const units = useMemo(
    () =>
      optionsOf(
        onAuto ? [...tonight.map((r) => r.unit), ...history.map((h) => h.employee.unit)] : listRows.map((r) => r.unit),
      ),
    [onAuto, tonight, history, listRows],
  );
  // a department or unit the open list does not offer (another kind was picked) reads as "all"
  const filters = useMemo<Filters>(
    () => ({
      search,
      department: keepOffered(url.dept || ALL, departments),
      unit: keepOffered(url.unit || ALL, units),
    }),
    [search, url.dept, url.unit, departments, units],
  );
  const filtered = filtersActive(filters);

  const rows = useMemo(() => listRows.filter((r) => matchesFilters(r, filters)), [listRows, filters]);
  const tonightRows = useMemo(() => tonight.filter((r) => matchesFilters(r, filters)), [tonight, filters]);
  const historyRows = useMemo(() => history.filter((h) => matchesFilters(h.employee, filters)), [history, filters]);

  const [page, setPage] = useState(1);
  const paged = paginate(rows, page);

  // What the ticks work on: the 15 / 30 Days list, or on the Auto Trigger tab its Tonight list.
  const pool = onAuto ? tonight : listRows;
  const shownRows = onAuto ? tonightRows : rows;
  // Decisions say where they were made: the list's bucket, or "auto" on the Auto Trigger tab.
  const decideIn: InvestigationDecisionBucket = onAuto ? "auto" : bucket;

  // The ticks belong to one tab and kind: another is another list, so nothing stays ticked.
  const listKey = `${tab}-${kind}`;
  const [tickState, setTicks] = useState<{ key: string; ids: Selection }>({ key: listKey, ids: NO_SELECTION });
  const selection = tickState.key === listKey ? tickState.ids : NO_SELECTION;
  const setSelection = (next: (s: Selection) => Selection) =>
    setTicks((t) => ({ key: listKey, ids: next(t.key === listKey ? t.ids : NO_SELECTION) }));
  // fresh from the list (a row that dropped out, e.g. marked inactive, is no longer ticked)
  const chosen = useMemo(() => pool.filter((r) => selection.has(r.id)), [pool, selection]);
  const hidden = hiddenSelected(new Set(chosen.map((r) => r.id)), shownRows);

  const [detailId, setDetailId] = useState<number | null>(null);
  const [decision, setDecision] = useState<PendingDecision | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [report, setReport] = useState<ResultReport | null>(null);
  const [switchTo, setSwitchTo] = useState<boolean | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const action = useInvestigationAction();
  const switcher = useSetInvestigationAuto();
  const runner = useRunInvestigationNow();
  const [runAsk, setRunAsk] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const busy = action.isPending || switcher.isPending || runner.isPending;

  // Run now marks inactive everyone due in the whole company (all kinds): with Staff or Production picked, the Tonight
  // list of everyone is read for its count and the confirm (only for a login that may press it).
  const mayRun = mayEdit && settings?.canChange === true;
  const everyone = useInvestigationAuto("all", { enabled: onAuto && kind !== "all" && mayRun });
  const dueRows = kind === "all" ? (auto.data?.tonight ?? null) : (everyone.data?.tonight ?? null);

  const selectTab = (next: InvestigationTab) => {
    setPage(1);
    setUrl({ tab: next });
  };
  const selectKind = (next: InvestigationKind) => {
    setPage(1);
    setUrl({ kind: next, dept: ALL, unit: ALL });
  };
  const patchFilters = (patch: Partial<Filters>) => {
    setPage(1);
    if (patch.search !== undefined) setSearch(patch.search);
    const toUrl: Record<string, string> = {};
    if (patch.department !== undefined) toUrl.dept = patch.department;
    if (patch.unit !== undefined) toUrl.unit = patch.unit;
    if (Object.keys(toUrl).length) setUrl(toUrl);
  };
  const clearFilters = () => {
    setPage(1);
    setSearch(NO_FILTERS.search);
    setUrl({ dept: ALL, unit: ALL });
  };
  const toggleAll = () =>
    setSelection((s) =>
      listSelection(s, shownRows) === "all" ? deselectRows(s, shownRows) : selectRows(s, shownRows),
    );
  const toggleOne = (row: InvestigationRow) => setSelection((s) => toggleId(s, row.id));

  const ask = (
    kindOfDecision: PendingDecision["kind"],
    target: PendingDecision["rows"],
    inBucket: InvestigationDecisionBucket | null,
  ) => {
    if (target.length === 0) return;
    setDecisionError(null);
    setDecision({ kind: kindOfDecision, rows: target, bucket: inBucket });
  };
  const confirmDecision = (reason: string) => {
    if (!decision) return;
    const d = decision;
    action.mutate(
      { path: DECISION_PATH[d.kind], body: decisionBody(d.kind, d.rows, reason, d.bucket) },
      {
        onSuccess: (result) => {
          setDecision(null);
          setDecisionError(null);
          if (result.done.length > 0) toast({ title: doneTitle(d.kind, result.done.length) });
          setReport(refusalReport(d.kind, result));
          setSelection((s) =>
            deselectRows(
              s,
              result.done.map((x) => ({ id: x.employeeId })),
            ),
          );
        },
        onError: (e) => setDecisionError(errorText(e)),
      },
    );
  };
  const confirmRunNow = () => {
    runner.mutate(undefined, {
      onSuccess: (result) => {
        setRunAsk(false);
        setRunError(null);
        setSelection(() => NO_SELECTION);
        toast({ title: runNowDoneTitle(result.summary?.inactivated ?? 0) });
      },
      onError: (e) => setRunError(errorText(e)),
    });
  };
  const confirmSwitch = () => {
    if (switchTo === null) return;
    const next = switchTo;
    switcher.mutate(next, {
      onSuccess: () => {
        setSwitchTo(null);
        setSwitchError(null);
        toast({ title: next ? "Auto Trigger switched on" : "Auto Trigger switched off" });
      },
      onError: (e) => setSwitchError(errorText(e)),
    });
  };

  const asOf = list.data?.asOf;
  const tabCount = (t: InvestigationTab): number | null => {
    if (t === "auto") return auto.data ? auto.data.tonight.length : (counts?.tonight ?? null);
    if (!counts) return null;
    return t === "15" ? counts.d15 : counts.d30;
  };
  const showing =
    !onAuto && list.data
      ? rows.length > 0
        ? `Showing ${paged.from}-${paged.to} of ${paged.total}`
        : "Showing 0 employees"
      : null;

  const bulkBar =
    chosen.length > 0 ? (
      <div
        className="sticky top-0 z-20 flex flex-wrap items-center gap-2 rounded-2xl border border-indigo-200 bg-indigo-50/95 px-3 py-2 shadow-sm backdrop-blur"
        data-testid="inv-bulk"
        role="region"
        aria-label="Ticked employees"
      >
        <p className="text-sm font-semibold text-indigo-950">
          <span data-testid="inv-selected-count">{chosen.length} selected</span>
          {hidden > 0 && (
            <span className="ml-1 text-xs font-normal text-indigo-800">({hidden} not shown by the filters)</span>
          )}
        </p>
        <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
          <span title={mayEdit ? undefined : "Needs edit rights on this page"} className="inline-flex">
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5 bg-white text-emerald-700"
              onClick={() => ask("keep", chosen, decideIn)}
              disabled={!mayEdit || busy}
              data-testid="inv-bulk-keep"
            >
              <ShieldCheck size={14} /> Keep active ({chosen.length})
            </Button>
          </span>
          <span title={mayEdit ? undefined : "Needs edit rights on this page"} className="inline-flex">
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5 bg-white text-red-700"
              onClick={() => ask("inactivate", chosen, decideIn)}
              disabled={!mayEdit || busy}
              data-testid="inv-bulk-inactivate"
            >
              <UserX size={14} /> Mark inactive ({chosen.length})
            </Button>
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="gap-1"
            onClick={() => setSelection(() => NO_SELECTION)}
            data-testid="inv-bulk-clear"
          >
            <X size={14} /> Clear selection
          </Button>
        </div>
      </div>
    ) : null;

  return (
    <div className="space-y-5" data-testid="investigation-page">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 items-start gap-2">
          <Link
            href={EMPLOYEES_PATH}
            className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-gray-600 hover:bg-gray-100 hover:text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Back to employees"
            data-testid="inv-back"
          >
            <ArrowLeft size={18} />
          </Link>
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-2xl font-black text-gray-900">
              <UserSearch size={22} className="text-indigo-600" /> Investigation
            </h2>
            <p className="mt-0.5 max-w-2xl text-sm text-muted-foreground" data-testid="inv-subtitle">
              Employees away from the company 15 or 30+ days in a row, counted in calendar days up to yesterday
              {asOf ? ` (${dateShort(asOf)})` : ""}.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <RefreshButton className="h-10 rounded-2xl" />
        </div>
      </div>

      <div className="max-w-full overflow-x-auto" data-testid="inv-tabs">
        <PillTabs
          baseColor={ACCENT}
          items={TABS.map((t) => {
            const n = tabCount(t);
            return {
              value: t,
              label: (
                <span data-testid={`inv-tab-${t}`}>
                  {TAB_LABEL[t]} <span className="font-semibold opacity-70">({n ?? "—"})</span>
                </span>
              ),
            };
          })}
          value={tab}
          onChange={(v) => isTab(v) && selectTab(v)}
        />
      </div>

      <div className="space-y-2" data-testid="inv-banners">
        {!mayEdit && !layoutViewOnly && (
          <Banner tone="slate" icon={Info} testId="inv-banner-view-only">
            You can look at the lists and the leave details. Keep active, Mark inactive, the Auto Trigger switch and Run
            now need edit rights on this page.
          </Banner>
        )}
        {settings && !settings.autoEnabled && !onAuto && (
          <Banner tone="slate" icon={PowerOff} testId="inv-banner-auto-off">
            The Auto Trigger is switched off: nobody is marked inactive automatically.
          </Banner>
        )}
        {tab === "30" && settings?.autoEnabled && counts && counts.tonight > 0 && (
          <Banner tone="amber" icon={AlertTriangle} testId="inv-banner-tonight">
            {employeeCount(counts.tonight)} would be marked inactive by the Auto Trigger tonight at {settings.runAt}.
            Keep active anyone who should stay.
          </Banner>
        )}
      </div>

      <Toolbar
        kind={kind}
        onKind={selectKind}
        filters={filters}
        onChange={patchFilters}
        departments={departments}
        units={units}
        showing={showing}
        onClear={filtered ? clearFilters : null}
      />

      {!onAuto && bulkBar}

      {report && <ResultPanel report={report} onClose={() => setReport(null)} />}

      {onAuto ? (
        auto.isLoading ? (
          <ListSkeleton />
        ) : auto.isError || !auto.data ? (
          <LoadError what="the Auto Trigger" error={errorText(auto.error)} onRetry={() => void auto.refetch()} />
        ) : (
          <div className="space-y-5">
            <StatusCard
              settings={auto.data.settings}
              tonight={auto.data.tonight.length}
              due={dueRows ? dueRows.length : null}
              canEdit={mayEdit}
              pending={switcher.isPending}
              running={runner.isPending}
              onSwitch={(next) => {
                setSwitchError(null);
                setSwitchTo(next);
              }}
              onRunNow={() => {
                setRunError(null);
                setRunAsk(true);
              }}
            />
            {bulkBar}
            <TonightSection
              key={`tonight-${kind}`}
              rows={tonightRows}
              settings={auto.data.settings}
              canEdit={mayEdit}
              busy={busy}
              selection={selection}
              onToggle={toggleOne}
              onToggleAll={toggleAll}
              onDetails={(row) => setDetailId(row.id)}
              onKeep={(row) => ask("keep", [row], "auto")}
              onInactivate={(row) => ask("inactivate", [row], "auto")}
            />
            <HistorySection
              key={`history-${kind}`}
              items={historyRows}
              canEdit={mayEdit}
              busy={busy}
              onDetails={(id) => setDetailId(id)}
              onReactivate={(item) =>
                ask("reactivate", [{ id: item.employee.id, name: item.employee.name, code: item.employee.code }], null)
              }
            />
          </div>
        )
      ) : list.isLoading ? (
        <ListSkeleton />
      ) : list.isError || !list.data ? (
        <LoadError
          what={`the ${TAB_LABEL[tab]} list`}
          error={errorText(list.error)}
          onRetry={() => void list.refetch()}
        />
      ) : rows.length === 0 ? (
        filtered ? (
          <EmptyNote
            icon={SearchX}
            title="No employee matches these filters"
            action={
              <Button variant="outline" size="sm" className="mt-1" onClick={clearFilters}>
                Clear filters
              </Button>
            }
            className="bg-white"
            testId="inv-empty"
          />
        ) : (
          <EmptyNote
            icon={UserCheck}
            title={tab === "30" ? "Nobody is away 30 days or more" : "Nobody is away 15 to 29 days"}
            hint={asOf ? `Counted up to yesterday (${dateShort(asOf)}).` : undefined}
            className="bg-white"
            testId="inv-empty"
          />
        )
      ) : (
        <>
          <RowList
            rows={paged.rows}
            allRows={rows}
            selection={selection}
            onToggle={toggleOne}
            onToggleAll={toggleAll}
            settings={settings}
            showWhyNot={tab === "30"}
            onDetails={(row) => setDetailId(row.id)}
            onKeep={(row) => ask("keep", [row], bucket)}
            onInactivate={(row) => ask("inactivate", [row], bucket)}
            canEdit={mayEdit}
            busy={busy}
            testPrefix="inv"
            caption={tab === "30" ? "Employees away 30 days or more" : "Employees away 15 to 29 days"}
          />
          <DataPagination
            page={paged.page}
            totalPages={paged.totalPages}
            totalItems={paged.total}
            pageSize={PAGE_SIZE}
            onPageChange={setPage}
          />
        </>
      )}

      <DetailSheet
        employeeId={detailId}
        settings={settings}
        canEdit={mayEdit}
        onKeep={(row) => ask("keep", [row], onAuto ? "auto" : (row.bucket ?? bucket))}
        onInactivate={(row) => ask("inactivate", [row], onAuto ? "auto" : (row.bucket ?? bucket))}
        onClose={() => setDetailId(null)}
      />
      <DecisionDialog
        target={decision}
        pending={action.isPending}
        error={decisionError}
        onConfirm={confirmDecision}
        onClose={() => {
          setDecision(null);
          setDecisionError(null);
        }}
      />
      <RunNowDialog
        open={runAsk}
        rows={dueRows}
        kind={kind}
        autoEnabled={settings?.autoEnabled ?? true}
        runAt={settings?.runAt ?? "01:00"}
        pending={runner.isPending}
        error={runError}
        onConfirm={confirmRunNow}
        onClose={() => {
          setRunAsk(false);
          setRunError(null);
        }}
      />
      <AutoSwitchDialog
        next={switchTo}
        tonight={auto.data?.tonight.length ?? counts?.tonight ?? 0}
        autoDays={settings?.autoDays ?? 30}
        runAt={settings?.runAt ?? "01:00"}
        pending={switcher.isPending}
        error={switchError}
        onConfirm={confirmSwitch}
        onClose={() => {
          setSwitchTo(null);
          setSwitchError(null);
        }}
      />
    </div>
  );
}

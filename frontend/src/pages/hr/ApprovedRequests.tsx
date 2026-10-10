import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { Bell, CheckCircle2, Hourglass, ShieldAlert, UserCheck, XCircle } from "lucide-react";
import HrLayout from "@/components/HrLayout";
import { RefreshButton } from "@/components/PageRefreshBar";
import { PipelineSummary } from "@/components/ApprovalTrail";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PillTabs } from "@/components/ui/pill-tabs";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { downloadBlob, downloadWorkbook, fileSafe, newWorkbook, styleHeaderCell, todayStamp } from "@/lib/exportUtils";
import { DetailDialog, DecisionDialog, HandleDialog } from "./requests/dialogs";
import { useDecide, useHandleRequest, useHubRequests } from "./requests/api";
import {
  EXPORT_HEADERS,
  NO_FILTERS,
  buildTabs,
  daysText,
  dayStamp,
  exportRows,
  filterItems,
  filtersActive,
  normalizeHub,
  serverParams,
  sortItems,
  tabFromAddress,
  toCsv,
  type Filters,
  type HubItem,
  type HubKind,
} from "./requests/logic";
import { FigureCard, type ActionHandlers } from "./requests/parts";
import RequestList, { EmptyState, ErrorState, ListSkeleton } from "./requests/RequestList";
import Toolbar from "./requests/Toolbar";

/** Requests shown before "Show more": a long list is paged on the page, the server has already narrowed it. */
const PAGE_SIZE = 50;

const readTab = () => {
  try {
    return new URLSearchParams(window.location.search).get("kind");
  } catch {
    return null;
  }
};

const writeTab = (tab: string) => {
  try {
    const url = new URL(window.location.href);
    if (tab === "all") url.searchParams.delete("kind");
    else url.searchParams.set("kind", tab);
    window.history.replaceState(window.history.state, "", url);
  } catch {
    /* the address just is not updated */
  }
};

/** Requests: every kind of request in the HRMS (leave, permission, casual leave, missing punch, on-duty, outpass, general
 *  requests, attendance corrections, resignations, advances) in one place, as sub-tabs, with who each is waiting for. */
export default function ApprovedRequests() {
  const { toast } = useToast();
  const { user } = useAuth();
  const [, navigate] = useLocation();

  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [rawTab, setRawTab] = useState<string | null>(readTab);
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<{ item: HubItem; mode: "approve" | "reject" } | null>(null);
  const [handling, setHandling] = useState<HubItem | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const today = dayStamp(new Date());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const params = useMemo(() => serverParams(filters, new Date()), [filters, today]);
  const query = useHubRequests(params);
  const hub = useMemo(() => normalizeHub(query.data), [query.data]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const now = useMemo(() => new Date(), [query.dataUpdatedAt]);

  const decide = useDecide();
  const handle = useHandleRequest();

  const kinds = useMemo(
    () => Object.fromEntries(hub.kinds.map((k) => [k.key, k])) as Record<string, HubKind>,
    [hub.kinds],
  );
  const tabs = useMemo(() => buildTabs(hub.kinds, hub.stats), [hub.kinds, hub.stats]);
  const tab = tabFromAddress(rawTab, hub.kinds);
  const activeKind = tab === "all" ? undefined : kinds[tab];

  const inTab = useMemo(() => (tab === "all" ? hub.items : hub.items.filter((i) => i.kind === tab)), [hub.items, tab]);
  const shown = useMemo(() => sortItems(filterItems(hub.items, filters, tab), filters.sort), [hub.items, filters, tab]);

  // a different tab or filter starts at the top again
  useEffect(() => setVisible(PAGE_SIZE), [filters, tab]);

  const selectTab = (next: string) => {
    setRawTab(next);
    setFilters((f) => (f.requestType === "all" ? f : { ...f, requestType: "all" }));
    writeTab(next);
  };

  const kindLabel = (item: Pick<HubItem, "kind">) => kinds[item.kind]?.label ?? item.kind;

  // The server's reason when it refuses (not this role's turn, workflow switched off, ...) beats a bare "Failed".
  const failed = (title: string, err: unknown) =>
    toast({ title, description: err instanceof Error ? err.message : undefined, variant: "destructive" });

  const decideNow = async (item: HubItem, status: "approved" | "rejected", comment?: string) => {
    setBusyKey(item.key);
    try {
      await decide.mutateAsync({ item, status, comment });
      toast({ title: `${kindLabel(item)} ${status}` });
      return true;
    } catch (err) {
      failed(status === "approved" ? "Failed to approve" : "Failed to reject", err);
      return false;
    } finally {
      setBusyKey(null);
    }
  };

  const handlers: ActionHandlers = {
    // an On-Duty approval also accepts the punches already captured, so it asks first
    onApprove: (item) =>
      item.kind === "on_duty" ? setDeciding({ item, mode: "approve" }) : void decideNow(item, "approved"),
    onReject: (item) => setDeciding({ item, mode: "reject" }),
    onHandle: (item) => setHandling(item),
    onOpenPage: (_item, kind) => kind.openPath && navigate(kind.openPath),
  };

  // the detail dialog closes before another dialog opens over it
  const detailHandlers: ActionHandlers = {
    ...handlers,
    onReject: (item) => {
      setSelectedKey(null);
      handlers.onReject(item);
    },
    onHandle: (item) => {
      setSelectedKey(null);
      handlers.onHandle(item);
    },
    onApprove: (item) => {
      if (item.kind === "on_duty") setSelectedKey(null);
      handlers.onApprove(item);
    },
  };

  const confirmDecision = async (comment: string) => {
    if (!deciding) return;
    const ok = await decideNow(deciding.item, deciding.mode === "approve" ? "approved" : "rejected", comment);
    if (ok) setDeciding(null);
  };

  const submitHandling = async (status: string, notes: string) => {
    if (!handling) return;
    setBusyKey(handling.key);
    try {
      await handle.mutateAsync({ id: handling.id, status, hrNotes: notes.trim() || undefined, handledBy: user?.name });
      toast({ title: "Request updated" });
      setHandling(null);
    } catch (err) {
      failed("Could not update the request", err);
    } finally {
      setBusyKey(null);
    }
  };

  const exportList = useCallback(
    async (format: "xlsx" | "csv") => {
      const labels = Object.fromEntries(hub.kinds.map((k) => [k.key, k.label]));
      const rows = exportRows(shown, labels);
      const name = `requests-${fileSafe(activeKind?.label ?? "all")}-${todayStamp()}`;
      try {
        if (format === "csv") {
          downloadBlob(new Blob([toCsv(rows)], { type: "text/csv;charset=utf-8" }), `${name}.csv`);
          return;
        }
        const wb = newWorkbook();
        const ws = wb.addWorksheet("Requests");
        ws.columns = EXPORT_HEADERS.map((h) => ({ header: h, width: h === "Details" || h === "Reason" ? 34 : 18 }));
        ws.getRow(1).eachCell((cell) => styleHeaderCell(cell, { fill: "FF006496" }));
        rows.forEach((r) => ws.addRow(r));
        ws.views = [{ state: "frozen", ySplit: 1 }];
        await downloadWorkbook(wb, `${name}.xlsx`);
      } catch (err) {
        failed("Could not export the list", err);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shown, hub.kinds, activeKind],
  );

  // the cards narrow the list to what they count
  const focusWaiting = (status: Filters["status"]) => {
    setRawTab("all");
    writeTab("all");
    setFilters({ ...NO_FILTERS, status });
  };

  const selected = selectedKey ? (hub.items.find((i) => i.key === selectedKey) ?? null) : null;
  const stats = hub.stats;
  const oldest = stats.oldestWaiting;
  const oldestDays = oldest
    ? Math.max(0, Math.floor((now.getTime() - Date.parse(oldest.submittedAt)) / 86_400_000))
    : 0;
  const filtered = filtersActive(filters);
  const hasData = !!query.data;
  const page = shown.slice(0, visible);

  return (
    <HrLayout>
      <div className="space-y-5" data-testid="requests-hub">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-2xl font-black text-gray-900">
              <Bell size={22} className="text-amber-500" />
              Requests
              {stats.waiting > 0 && <Badge className="bg-amber-500 text-xs text-white">{stats.waiting} pending</Badge>}
            </h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Every request employees and HR raise, and who it is waiting for - auto-refreshes every 30 s
            </p>
          </div>
          <RefreshButton />
        </div>

        {/* Figures */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5" data-testid="requests-figures">
          <FigureCard
            label="Waiting for HR now"
            value={stats.waitingHr}
            sub="HR can decide these today"
            icon={UserCheck}
            tone="bg-blue-50 text-blue-800"
            onClick={() => focusWaiting("waiting_hr")}
            active={filters.status === "waiting_hr"}
            testId="figure-waiting-hr"
          />
          <FigureCard
            label="Waiting for HOD"
            value={stats.waitingHod}
            sub={
              stats.waitingOther > 0
                ? `HR cannot decide yet · ${stats.waitingOther} with someone else`
                : "HR cannot decide these yet"
            }
            icon={Hourglass}
            tone="bg-amber-50 text-amber-800"
            onClick={() => focusWaiting("waiting_hod")}
            active={filters.status === "waiting_hod"}
            testId="figure-waiting-hod"
          />
          <FigureCard
            label="Approved this month"
            value={stats.approvedThisMonth}
            icon={CheckCircle2}
            tone="bg-green-50 text-green-800"
            testId="figure-approved"
          />
          <FigureCard
            label="Rejected this month"
            value={stats.rejectedThisMonth}
            icon={XCircle}
            tone="bg-red-50 text-red-800"
            testId="figure-rejected"
          />
          <FigureCard
            label="Oldest waiting"
            value={oldest ? daysText(oldestDays) : "None"}
            sub={oldest ? `${oldest.employeeName} · ${oldest.label}` : "Nothing is waiting"}
            icon={ShieldAlert}
            tone={oldestDays >= 3 ? "bg-rose-50 text-rose-800" : "bg-slate-50 text-slate-700"}
            onClick={oldest ? () => focusWaiting("waiting") : undefined}
            testId="figure-oldest"
          />
        </div>

        {/* Sub-tabs: all, then one per kind with how many are waiting */}
        <div className="space-y-2">
          <div className="overflow-x-auto pb-1" data-testid="requests-tabs">
            <PillTabs size="sm" items={tabs} value={tab} onChange={selectTab} />
          </div>
          {activeKind && (
            <p className="text-xs text-muted-foreground" data-testid="requests-tab-note">
              Approval pipeline: <strong className="text-gray-700">{activeKind.pipeline}</strong>
              {!activeKind.enabled && (
                <span className="ml-2 font-semibold text-red-600">Switched off: new requests are refused</span>
              )}
              {activeKind.mode === "link" && activeKind.openPath && (
                <>
                  {" "}
                  · decided on its own page:{" "}
                  <button
                    type="button"
                    className="font-semibold text-blue-600 hover:underline"
                    onClick={() => navigate(activeKind.openPath!)}
                  >
                    Open in {activeKind.openLabel}
                  </button>
                </>
              )}
            </p>
          )}
        </div>

        <Toolbar
          filters={filters}
          onFilters={setFilters}
          options={hub.options}
          showRequestType={tab === "request"}
          shown={shown.length}
          total={inTab.length}
          canExport={shown.length > 0}
          onExport={exportList}
        />

        {/* The list */}
        <Card className="overflow-hidden rounded-2xl">
          <CardContent className="p-0">
            {query.isError && !hasData ? (
              <ErrorState onRetry={() => void query.refetch()} />
            ) : !hasData ? (
              <ListSkeleton />
            ) : hub.kinds.length === 0 ? (
              <div className="px-6 py-14 text-center text-sm text-muted-foreground" data-testid="requests-no-access">
                Your role cannot open any kind of request.
              </div>
            ) : shown.length === 0 ? (
              <EmptyState
                filtered={filtered}
                tabLabel={activeKind?.label ?? null}
                onClear={() => setFilters({ ...NO_FILTERS, sort: filters.sort })}
              />
            ) : (
              <RequestList
                items={page}
                kinds={kinds}
                now={now}
                busyKey={busyKey}
                handlers={handlers}
                onOpen={(item) => setSelectedKey(item.key)}
              />
            )}
          </CardContent>
        </Card>

        {shown.length > visible && (
          <div className="flex justify-center">
            <Button variant="outline" onClick={() => setVisible((v) => v + PAGE_SIZE)} data-testid="requests-more">
              Show {Math.min(PAGE_SIZE, shown.length - visible)} more ({shown.length - visible} left)
            </Button>
          </div>
        )}

        {hub.kinds.some((k) => k.truncated) && (
          <p className="text-center text-xs text-amber-700" data-testid="requests-truncated">
            {hub.kinds
              .filter((k) => k.truncated)
              .map((k) => `${k.label}: the newest ${hub.limit} of ${k.matched}`)
              .join(" · ")}
            . Narrow the period to see older ones.
          </p>
        )}

        <PipelineSummary workflows={hub.kinds.map((k) => k.key)} />
      </div>

      <DetailDialog
        item={selected}
        kind={selected ? kinds[selected.kind] : undefined}
        now={now}
        busy={busyKey === selected?.key}
        handlers={detailHandlers}
        onClose={() => setSelectedKey(null)}
      />
      <DecisionDialog
        item={deciding?.item ?? null}
        mode={deciding?.mode ?? "reject"}
        busy={busyKey !== null}
        onClose={() => setDeciding(null)}
        onConfirm={(comment) => void confirmDecision(comment)}
      />
      <HandleDialog
        item={handling}
        busy={busyKey !== null}
        onClose={() => setHandling(null)}
        onSubmit={(status, notes) => void submitHandling(status, notes)}
      />
    </HrLayout>
  );
}

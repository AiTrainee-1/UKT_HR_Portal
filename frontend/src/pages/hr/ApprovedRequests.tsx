import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useSearch } from "wouter";
import { Bell, BellRing, CheckCircle2, Hourglass, Inbox, ShieldAlert, UserCheck, Users, XCircle } from "lucide-react";
import HrLayout from "@/components/HrLayout";
import { RefreshButton } from "@/components/PageRefreshBar";
import { PipelineSummary } from "@/components/ApprovalTrail";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PillTabs } from "@/components/ui/pill-tabs";
import { isRouteViewOnly, useAuth } from "@/contexts/AuthContext";
import { useIsMobile } from "@/hooks/use-mobile";
import { useToast } from "@/hooks/use-toast";
import { downloadBlob, downloadWorkbook, fileSafe, newWorkbook, styleHeaderCell, todayStamp } from "@/lib/exportUtils";
import { moduleForPath } from "@/lib/permission-modules";
import { pickVisible, useLevel, useViewOnlyLock, ViewOnlyTabNote, visibleItems } from "@/lib/tab-access";
import { DetailDialog, DecisionDialog, HandleDialog } from "./requests/dialogs";
import { useDecide, useHandleRequest, useHubRequests } from "./requests/api";
import { useHrReminders, withReminders } from "./requests/reminders";
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
import HodsTab from "./requests/hods/HodsTab";
import NotifyTab from "./requests/notify/NotifyTab";
import {
  PAGE_SECTIONS,
  focusFromSearch,
  focusKey,
  requestLinkTarget,
  searchForSection,
  sectionFromSearch,
  type FocusTarget,
  type PageSection,
} from "./requests/sections";

/** Requests shown before "Show more": a long list is paged on the page, the server has already narrowed it. A phone shows
 *  them as tall cards, so it pages by 20 (fifty cards are a 10,000 px scroll). */
const PAGE_SIZE = 50;
const PHONE_PAGE_SIZE = 20;

const readTab = () => {
  try {
    return new URLSearchParams(window.location.search).get("kind");
  } catch {
    return null;
  }
};

const SECTION_ICONS: Record<PageSection, ReactNode> = {
  requests: <Inbox size={13} aria-hidden />,
  hods: <Users size={13} aria-hidden />,
  notify: <BellRing size={13} aria-hidden />,
};

// Each section's own permission key (Account Management -> Roles & Permissions); a key with no setting follows "requests".
const SECTION_KEY: Record<PageSection, string> = {
  requests: "requests.list",
  hods: "requests.hods",
  notify: "requests.notify",
};

const SECTION_NOTES: Record<PageSection, string> = {
  requests: "Every request employees and HR raise, and who it is waiting for - auto-refreshes every minute",
  hods: "What is waiting for each Department Head's approval, kind by kind - refreshes every minute",
  notify: "Automatic reminders to every HoD with requests waiting for their approval",
};

/** The `?focus=` instruction is used once: it leaves the address so a refresh does not open the request again. */
const dropFocus = () => {
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("focus")) return;
    url.searchParams.delete("focus");
    window.history.replaceState(window.history.state, "", url);
  } catch {
    /* the address just keeps it */
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
 *  requests, attendance corrections, Holiday / Sunday work, resignations, advances) in one place, as sub-tabs, with who each
 *  is waiting for. Two more sections sit beside the heading (`?tab=`): HoD's, what is pending with each Department Head,
 *  and Notify, the automatic reminder to them (requests/hods, requests/notify). */
export default function ApprovedRequests() {
  const { toast } = useToast();
  const { user } = useAuth();
  const [location, navigate] = useLocation();
  const search = useSearch();
  const level = useLevel();
  // Only the sections this role may see; one that is hidden is never shown (or loaded), also when ?tab= asks for it.
  const sections = visibleItems(PAGE_SECTIONS, (s) => SECTION_KEY[s.value], level);
  const sectionValues = sections.map((s) => s.value);
  const section = pickVisible(sectionFromSearch(search), sectionValues);
  const canSee = (s: PageSection) => sectionValues.includes(s);
  // A section this role may only VIEW on a page it may edit: lock its change buttons (HrLayout locks a View-only page).
  const sectionViewOnly =
    sections.length > 0 &&
    !isRouteViewOnly(user, location, moduleForPath(location)) &&
    level(SECTION_KEY[section]) === "view";
  useViewOnlyLock(sectionViewOnly, section);

  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [rawTab, setRawTab] = useState<string | null>(readTab);
  // how many pages of the list are open; a page is 50 requests, 20 on a phone
  const phone = useIsMobile();
  const pageSize = phone ? PHONE_PAGE_SIZE : PAGE_SIZE;
  const [pages, setPages] = useState(1);
  const visible = pages * pageSize;
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<{ item: HubItem; mode: "approve" | "reject" } | null>(null);
  const [handling, setHandling] = useState<HubItem | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  // `?kind=leave&focus=12` (a HoD's link, a notification) opens that request's details once the list is in
  const [focus, setFocus] = useState<FocusTarget | null>(() => focusFromSearch(window.location.search));

  const today = dayStamp(new Date());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const params = useMemo(() => serverParams(filters, new Date()), [filters, today]);
  const query = useHubRequests(params, canSee("requests"));
  // the reminders employees sent HR from the app show on their rows ("Employee reminded HR on ...")
  const reminders = useHrReminders(canSee("requests"));
  const hub = useMemo(() => withReminders(normalizeHub(query.data), reminders.data), [query.data, reminders.data]);
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
  useEffect(() => setPages(1), [filters, tab]);

  // on a phone the sub-tab row scrolls: the open one is brought into view (?kind=advance opens it out of sight otherwise).
  // Only the row itself scrolls, never the page.
  const tabStrip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = tabStrip.current;
    const pill = box?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    if (!box || !pill || box.scrollWidth <= box.clientWidth) return;
    const at = pill.getBoundingClientRect().left - box.getBoundingClientRect().left;
    box.scrollLeft += at - (box.clientWidth - pill.offsetWidth) / 2;
  }, [tab, tabs.length]);

  useEffect(() => {
    if (!focus || !query.data || query.isPlaceholderData) return;
    const key = focusKey(focus);
    setFocus(null);
    dropFocus();
    if (hub.items.some((i) => i.key === key)) setSelectedKey(key);
    else
      toast({
        title: "That request is not in the list",
        description: "It may have been decided and closed already, or it is older than the list holds.",
      });
  }, [focus, query.data, query.isPlaceholderData, hub.items, toast]);

  const selectSection = (next: PageSection) => {
    const qs = searchForSection(search, next);
    navigate(qs ? `${location}?${qs}` : location);
  };

  /** A link from HoD's: a request of this page opens here (the Requests section, its kind, its details), anything else is
   *  followed. The filters are cleared so the request cannot be hidden by them. */
  const openFromHods = (openPath: string) => {
    const target = requestLinkTarget(openPath);
    if (!target) {
      navigate(openPath);
      return;
    }
    const next = new URLSearchParams(searchForSection(search, "requests"));
    next.set("kind", target.kind);
    setFilters((f) => ({ ...NO_FILTERS, sort: f.sort }));
    setRawTab(target.kind);
    setFocus(target);
    navigate(`${location}?${next.toString()}`);
  };

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
        const wb = await newWorkbook();
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
        {/* Header, with the page's three sections beside it */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* The heading, its note and the section tabs are direct children of one block (a grid placing the tabs beside the
              heading), so the MD portal's copy of this page can lay the title row out like its other tall-title pages. */}
          <div className="grid min-w-0 items-center gap-x-6 gap-y-3 sm:grid-cols-[auto_minmax(0,1fr)]">
            <h2 className="flex items-center gap-2 text-2xl font-black text-gray-900 sm:col-start-1 sm:row-start-1">
              <Bell size={22} className="text-amber-500" />
              Requests
              {stats.waiting > 0 && <Badge className="bg-amber-500 text-xs text-white">{stats.waiting} pending</Badge>}
            </h2>
            <p
              className="-mt-2.5 text-sm text-muted-foreground sm:col-start-1 sm:row-start-2"
              data-testid="requests-section-note"
            >
              {sections.length > 0 ? SECTION_NOTES[section] : ""}
            </p>
            <nav
              aria-label="Sections of the Requests page"
              className="min-w-0 max-w-full overflow-x-auto sm:col-start-2 sm:row-span-2 sm:row-start-1"
              data-testid="requests-sections"
              data-tab-row
            >
              <PillTabs
                size="sm"
                baseColor="#4f46e5"
                items={sections.map((s) => ({ ...s, icon: SECTION_ICONS[s.value] }))}
                value={section}
                onChange={(v) => selectSection(v as PageSection)}
              />
            </nav>
          </div>
          <RefreshButton />
        </div>

        {/* Notify shows its own View-only note (and keeps its form read-only) */}
        <ViewOnlyTabNote show={sectionViewOnly && section !== "notify"} />
        {sections.length === 0 && (
          <p
            className="rounded-2xl bg-white p-6 text-center text-sm text-muted-foreground shadow-sm"
            data-testid="requests-nothing-open"
          >
            Nothing on this page is open to your role.
          </p>
        )}

        {canSee("hods") && section === "hods" && (
          <div role="tabpanel" aria-label="HoD's" data-testid="requests-section-hods">
            <HodsTab onOpenRequest={openFromHods} />
          </div>
        )}
        {canSee("notify") && section === "notify" && (
          <div role="tabpanel" aria-label="Notify" data-testid="requests-section-notify">
            <NotifyTab />
          </div>
        )}

        {canSee("requests") && section === "requests" && (
          <div role="tabpanel" aria-label="Requests" className="space-y-5" data-testid="requests-section-requests">
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
                className="col-span-2 sm:col-span-1"
              />
            </div>

            {/* Sub-tabs: all, then one per kind with how many are waiting */}
            <div className="space-y-2">
              {/* one row that scrolls sideways on a phone (data-tab-row: the MD skin keeps its pills on one line too) */}
              <div ref={tabStrip} className="overflow-x-auto pb-1" data-testid="requests-tabs" data-tab-row>
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
                  <div
                    className="px-6 py-14 text-center text-sm text-muted-foreground"
                    data-testid="requests-no-access"
                  >
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
                <Button variant="outline" onClick={() => setPages((p) => p + 1)} data-testid="requests-more">
                  Show {Math.min(pageSize, shown.length - visible)} more ({shown.length - visible} left)
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

            {/* on a phone each line keeps its icon beside the text instead of wrapping the text under it */}
            <PipelineSummary
              workflows={hub.kinds.map((k) => k.key)}
              className="max-sm:[&>p]:flex-nowrap max-sm:[&>p]:items-start max-sm:[&>p>svg]:mt-0.5"
            />
          </div>
        )}
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

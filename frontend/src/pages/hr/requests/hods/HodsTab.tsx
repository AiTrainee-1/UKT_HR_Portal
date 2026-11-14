import { useMemo, useRef, useState, type MouseEvent } from "react";
import {
  FileImage,
  FileSpreadsheet,
  FileText,
  Hourglass,
  Search,
  Share2,
  ShieldAlert,
  UserCheck,
  Users,
  X,
} from "lucide-react";
import { BranchFilter } from "@/components/payroll/kit/BranchFilter";
import { ExportMenu } from "@/components/payroll/kit/ExportMenu";
import { EmptyNote, SkeletonKpis, SkeletonRows } from "@/components/payroll/kit/parts";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useListBranches, useListDepartments, useHodPending, type HodPendingItem, type HodRow } from "@/lib/api-client";
import { ApiError } from "@/lib/api-client/custom-fetch";
import { downloadBlob } from "@/lib/exportUtils";
import { VIEW_SAFE_ATTR } from "@/lib/view-only-lock";
import { useCompany } from "../../report-log/useCompany";
import { FigureCard } from "../parts";
import { ErrorState } from "../RequestList";
import {
  BOARD_TITLE,
  elementPng,
  hodExcelBlob,
  hodFileName,
  hodPdfBlob,
  shareOrDownload,
  type HodReportInput,
} from "./export";
import HodBoard from "./HodBoard";
import HodDetailDialog from "./HodDetailDialog";
import HodImageSheet from "./HodImageSheet";
import {
  NO_HOD_FILTERS,
  filterHods,
  hodFigures,
  hodFiltersActive,
  scopeText,
  serverHodParams,
  shareSummary,
  stampText,
  visibleCategories,
  waitingText,
  type HodFilters,
} from "./logic";
import ShareDialog from "./ShareDialog";

const ALL = "all";

/**
 * HoD's: every Department Head and what is waiting for their approval right now (the same "mine" list as their phone's
 * Approvals tab), as figures, a board of heads x categories, and a drill-down of each head's requests. Exports the board
 * as Excel / PDF / picture and shares it. Read-only by nature: nothing here changes data.
 */
export default function HodsTab({ onOpenRequest }: { onOpenRequest: (openPath: string) => void }) {
  const company = useCompany();
  const [filters, setFilters] = useState<HodFilters>(NO_HOD_FILTERS);
  const params = useMemo(() => serverHodParams(filters), [filters]);
  const query = useHodPending(params);
  const departments = useListDepartments();
  const branches = useListBranches();
  const [open, setOpen] = useState<{ managerId: number; category?: string } | null>(null);
  const [sharing, setSharing] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);

  const data = query.data;
  const rows = useMemo(() => data?.hods ?? [], [data]);
  const categories = useMemo(() => visibleCategories(rows, data?.categories ?? []), [rows, data]);
  const shown = useMemo(() => filterHods(rows, filters), [rows, filters]);
  const figures = useMemo(() => hodFigures(rows), [rows]);
  const asOf = useMemo(() => (data?.generatedAt ? new Date(data.generatedAt) : new Date()), [data]);
  const openRow: HodRow | null = open ? (rows.find((r) => r.managerId === open.managerId) ?? null) : null;

  const set = (patch: Partial<HodFilters>) => setFilters((f) => ({ ...f, ...patch }));
  const deptList = departments.data ?? [];
  const names = {
    branch: (branches.data ?? []).find((b) => String(b.id) === filters.branch)?.name,
    department: deptList.find((d) => String(d.id) === filters.department)?.name,
  };
  const scope = scopeText(filters, names);
  const report: HodReportInput = {
    rows: shown,
    categories,
    company: company.excel.company,
    // the login's own branch line; a branch picked in the filter is in `scope`
    branchLabel: company.excel.branchLabel,
    logoDataUrl: company.excel.logoDataUrl,
    scope,
    now: asOf,
  };
  const summary = shareSummary(shown, categories, asOf, scope);

  const picture = async () => {
    if (!sheetRef.current) throw new Error("The picture is not ready yet.");
    return elementPng(sheetRef.current);
  };

  const openRequest = (item: HodPendingItem, e: MouseEvent) => {
    // a plain click switches the page in place; a ctrl / middle click opens a new tab as any link does
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    setOpen(null);
    onOpenRequest(item.openPath);
  };

  const notThere = query.error instanceof ApiError && query.error.status === 404;
  const forbidden = query.error instanceof ApiError && query.error.status === 403;

  if (!data) {
    if (query.isError) {
      return (
        <Card className="overflow-hidden rounded-2xl" data-testid="hods-tab">
          <CardContent className="p-0">
            {notThere || forbidden ? (
              <EmptyNote
                icon={ShieldAlert}
                title={
                  notThere
                    ? "The HoD summary is not available on this server yet"
                    : "Your login cannot open the HoD summary"
                }
                hint={
                  notThere
                    ? "It arrives with the next server update. The Requests section works as before."
                    : "Ask an administrator for access to Requests."
                }
                className="m-4"
                testId="hods-unavailable"
              />
            ) : (
              <ErrorState onRetry={() => void query.refetch()} />
            )}
          </CardContent>
        </Card>
      );
    }
    return (
      <div className="space-y-4" data-testid="hods-tab" aria-busy>
        <SkeletonKpis count={4} className="lg:grid-cols-4 xl:grid-cols-4" />
        <SkeletonRows rows={5} />
      </div>
    );
  }

  return (
    <div className="space-y-5" data-testid="hods-tab">
      {/* Figures */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="hods-figures">
        <FigureCard
          label="HoDs"
          value={figures.hods}
          sub="Active Department Heads"
          icon={Users}
          tone="bg-slate-50 text-slate-700"
          testId="hods-figure-hods"
        />
        <FigureCard
          label="HoDs with pending"
          value={figures.withPending}
          sub={
            figures.hods - figures.withPending > 0
              ? `${figures.hods - figures.withPending} with nothing waiting`
              : "Every HoD has something waiting"
          }
          icon={UserCheck}
          tone="bg-blue-50 text-blue-800"
          onClick={() => set({ onlyPending: !filters.onlyPending })}
          active={filters.onlyPending}
          testId="hods-figure-with-pending"
        />
        <FigureCard
          label="Total pending"
          value={figures.pending}
          sub="Waiting for a HoD's approval"
          icon={Hourglass}
          tone="bg-amber-50 text-amber-800"
          testId="hods-figure-pending"
        />
        <FigureCard
          label="Oldest waiting"
          value={figures.oldest ? waitingText(figures.oldest.days) : "None"}
          sub={
            figures.oldest
              ? `${figures.oldest.name}${figures.oldest.label ? ` · ${figures.oldest.label}` : ""}`
              : "Nothing is waiting"
          }
          icon={ShieldAlert}
          tone={(figures.oldest?.days ?? 0) >= 3 ? "bg-rose-50 text-rose-800" : "bg-slate-50 text-slate-700"}
          onClick={figures.oldest ? () => setOpen({ managerId: figures.oldest!.managerId }) : undefined}
          testId="hods-figure-oldest"
        />
      </div>

      {/* Search, filters, exports */}
      <div className="space-y-3 rounded-2xl border bg-white p-3" data-testid="hods-toolbar">
        <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
          <div className="relative flex-1">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <Input
              value={filters.query}
              onChange={(e) => set({ query: e.target.value })}
              placeholder="Search a HoD, a department or an employee waiting on one"
              aria-label="Search HoDs"
              className="h-10 pl-9 pr-9"
              data-testid="hods-search"
            />
            {filters.query && (
              <button
                type="button"
                onClick={() => set({ query: "" })}
                aria-label="Clear search"
                className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-1 text-gray-400 hover:text-gray-700"
              >
                <X size={14} />
              </button>
            )}
          </div>
          {/* phones: Export and Share as two equal buttons side by side */}
          <div
            className="grid grid-cols-2 gap-2 max-sm:[&>span]:grid max-sm:[&_button]:w-full sm:flex sm:flex-wrap"
            {...{ [VIEW_SAFE_ATTR]: "" }}
          >
            <ExportMenu
              heading="Download the board"
              disabled={shown.length === 0}
              testId="hods-export"
              className="h-10 gap-2 border-emerald-200 text-emerald-700 hover:bg-emerald-50"
              items={[
                {
                  key: "xlsx",
                  label: "Excel",
                  hint: "The board and every pending request, on two sheets",
                  icon: FileSpreadsheet,
                  run: async () => downloadBlob(await hodExcelBlob(report), hodFileName(asOf, "xlsx")),
                },
                {
                  key: "pdf",
                  label: "PDF",
                  hint: "A4: the board, then each HoD's requests",
                  icon: FileText,
                  run: async () => downloadBlob(await hodPdfBlob(report), hodFileName(asOf, "pdf")),
                },
                {
                  key: "png",
                  label: "Image (PNG)",
                  hint: "A picture of the board, for WhatsApp",
                  icon: FileImage,
                  run: async () => downloadBlob(await picture(), hodFileName(asOf, "png")),
                },
              ]}
            />
            <Button
              variant="outline"
              className="h-10 gap-2 border-indigo-200 text-indigo-700 hover:bg-indigo-50"
              onClick={() => setSharing(true)}
              disabled={shown.length === 0}
              data-testid="hods-share"
            >
              <Share2 size={14} /> Share
            </Button>
          </div>
        </div>

        {/* phones: the two selects side by side, the switch on its own row under them */}
        <div className="grid grid-cols-2 items-center gap-2 max-sm:[&>button]:w-full max-sm:[&>label]:col-span-2 max-sm:[&>:only-child]:col-span-2 sm:flex sm:flex-wrap">
          <BranchFilter value={filters.branch} onChange={(v) => set({ branch: v })} testId="hods-branch" />
          {deptList.length > 0 && (
            <Select value={filters.department || ALL} onValueChange={(v) => set({ department: v === ALL ? "" : v })}>
              <SelectTrigger
                className="h-9 w-full sm:w-52"
                aria-label="Filter by department"
                data-testid="hods-department"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All departments</SelectItem>
                {deptList.map((d) => (
                  <SelectItem key={d.id} value={String(d.id)}>
                    {d.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <label className="flex h-9 items-center gap-2 rounded-lg border px-3 text-sm text-gray-700">
            <Switch
              checked={filters.onlyPending}
              onCheckedChange={(onlyPending) => set({ onlyPending })}
              aria-label="Only HoDs with pending"
              data-testid="hods-only-pending"
            />
            Only HoDs with pending
          </label>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-gray-500" data-testid="hods-count">
            Showing <b>{shown.length}</b> of {rows.length} HoD{rows.length === 1 ? "" : "s"} · as of {stampText(asOf)} ·
            refreshes every minute
            {query.isFetching && <span className="ml-1 text-gray-400">(updating…)</span>}
          </p>
          {hodFiltersActive(filters) && (
            <button
              type="button"
              onClick={() => setFilters(NO_HOD_FILTERS)}
              className="text-xs font-semibold text-blue-600 hover:underline"
              data-testid="hods-clear-filters"
            >
              Clear filters
            </button>
          )}
        </div>
      </div>

      {/* The board */}
      <Card className="overflow-hidden rounded-2xl">
        <CardContent className="p-0">
          {rows.length === 0 ? (
            <EmptyNote
              icon={Users}
              title="No Department Heads yet"
              hint="Department Heads are set up in User Management. Once one is, what is waiting for them shows here."
              className="m-4"
              testId="hods-empty"
            />
          ) : shown.length === 0 ? (
            <EmptyNote
              icon={Search}
              title="No HoD matches"
              hint="Try fewer words, or clear the filters."
              className="m-4"
              testId="hods-no-match"
              action={
                <Button variant="outline" size="sm" onClick={() => setFilters(NO_HOD_FILTERS)}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <HodBoard
              rows={shown}
              categories={categories}
              onOpen={(row, category) => setOpen({ managerId: row.managerId, category })}
            />
          )}
        </CardContent>
      </Card>
      <p className="text-[11px] text-muted-foreground">
        "—" means that HoD does not approve that kind of request. A request counts here only while it is waiting for
        that HoD's own decision, exactly as on their phone's Approvals tab.
      </p>

      <HodDetailDialog
        row={openRow}
        categories={categories}
        focusCategory={open?.category ?? null}
        onClose={() => setOpen(null)}
        onOpenRequest={openRequest}
      />
      <ShareDialog
        open={sharing}
        onClose={() => setSharing(false)}
        summary={summary}
        onShare={async (format) => {
          const blob = format === "png" ? await picture() : await hodPdfBlob(report);
          return shareOrDownload(blob, hodFileName(asOf, format), { title: BOARD_TITLE, text: summary });
        }}
      />

      {/* The off-screen copy the picture is taken from (display:none would give html2canvas nothing to draw). */}
      <div style={{ position: "fixed", left: -99999, top: 0, zIndex: -1 }} aria-hidden="true">
        <HodImageSheet ref={sheetRef} input={report} />
      </div>
    </div>
  );
}

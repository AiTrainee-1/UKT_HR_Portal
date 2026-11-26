import { useMemo, useState } from "react";
import { FileSpreadsheet, FileText, Loader2, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { categoryForEmploymentType, keepIfOffered, namedOrgOptions } from "@/lib/departments";
import { OrgSelectItems } from "@/lib/org-select";
import { cn } from "@/lib/utils";
import type { ExportCompany } from "../attendance/export";
import {
  ALL_MONTHS,
  BASIS_OPTIONS,
  DEFAULT_COLUMN_KEYS,
  EXPORT_COLUMNS,
  EXPORT_STATUS_OPTIONS,
  EXTRA_COLUMN_KEYS,
  TYPE_LABEL,
  buildExport,
  countOf,
  currentPeriod,
  describeScope,
  exportColumns,
  exportStatusLabel,
  exportTypeLabel,
  loadColumnChoice,
  pageView,
  periodLabel,
  reportDefaults,
  reportState,
  rowsOfTab,
  saveColumnChoice,
  tabOfReportType,
  yearOptions,
  type MonthBasis,
  type PageState,
  type ReportSettings,
  type SettlementRow,
  type StatusFilter,
} from "./logic";
import { MONTH_FULL, distinct } from "./shared";

type Props = {
  /** The page draws the dialog only while it is open, so every opening starts from the page as it is then. */
  open: boolean;
  onClose: () => void;
  /** Every advance the page has (any tab, any month). */
  all: SettlementRow[];
  /** The page as it is now: the dialog starts from it, and keeps its search text and other filters. */
  page: PageState;
  company: ExportCompany;
};

const TRIGGER = "h-9";
const COLUMN_BY_KEY = new Map(EXPORT_COLUMNS.map((c) => [c.key, c]));

/**
 * The customisable Settlement report (owner 2026-11-26): the month, status, type, department, branch and Staff /
 * Production start as the page shows them and can be changed here; the columns are tick-boxes (the owner's 12 by default,
 * extras after them), and this browser remembers the last choice. Excel or PDF, with totals for the ticked money columns.
 */
export default function ExportDialog({ open, onClose, all, page, company }: Props) {
  const { toast } = useToast();
  // starts from the page as it is now, with this browser's last column choice
  const [r, setSettings] = useState<ReportSettings>(() => reportDefaults(page, loadColumnChoice()));
  const [busy, setBusy] = useState<"xlsx" | "pdf" | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const patch = (p: Partial<ReportSettings>) => {
    setSettings((prev) => ({ ...prev, ...p }));
    setSaved(null);
  };
  const setColumns = (columns: string[]) => {
    patch({ columns });
    saveColumnChoice(columns);
  };

  const state = useMemo(() => reportState(page, r), [page, r]);
  const view = useMemo(() => pageView(all, state), [all, state]);
  const rows = view.shown;
  const years = useMemo(() => yearOptions(all, r.period), [all, r.period]);
  const tab = tabOfReportType(r.type);
  const typeRows = useMemo(() => rowsOfTab(all, tab), [all, tab]);
  const branches = useMemo(() => distinct(all.map((a) => a.employeeBranch)), [all]);
  const departmentsFor = (employeeType: string) =>
    namedOrgOptions(
      typeRows,
      (a) => a.employeeDepartment,
      (a) => a.employeeType,
      categoryForEmploymentType(employeeType),
    );
  const departments = departmentsFor(r.employeeType);
  // what the page adds that the dialog does not change: the search, employment, raised from / to, the sort
  const fromPage = describeScope({
    ...page,
    period: null,
    filters: { ...page.filters, status: "all", type: "all", department: "all", branch: "all", employeeType: "all" },
  });
  const chosen = new Set(r.columns);
  const toggle = (key: string, on: boolean) => {
    const next = EXPORT_COLUMNS.filter((c) => (c.key === key ? on : chosen.has(c.key))).map((c) => c.key);
    if (next.length === 0) return; // at least one column stays ticked
    setColumns(next);
  };
  const isDefaultColumns =
    r.columns.length === DEFAULT_COLUMN_KEYS.length && DEFAULT_COLUMN_KEYS.every((k) => chosen.has(k));
  const thisYear = currentPeriod().year;

  const run = async (kind: "xlsx" | "pdf") => {
    if (busy || rows.length === 0) return;
    setBusy(kind);
    try {
      const mod = await import("./export");
      const table = buildExport(rows, state, view.periodRows.length, r.columns);
      const input = { ...company, table, now: new Date() };
      if (kind === "xlsx") await mod.downloadSettlementExcel(input);
      else await mod.downloadSettlementPdf(input);
      setSaved(mod.exportFileName(table, kind));
    } catch (err) {
      toast({
        title: `Could not export the ${kind === "xlsx" ? "Excel file" : "PDF"}`,
        description: err instanceof Error ? err.message : "Something went wrong while building the file.",
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  };

  const columnBox = (key: string) => {
    const c = COLUMN_BY_KEY.get(key)!;
    const on = chosen.has(key);
    const last = on && r.columns.length === 1;
    return (
      <label
        key={key}
        className={cn(
          "flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-xs hover:bg-slate-50",
          last && "cursor-not-allowed opacity-70",
        )}
        title={last ? "At least one column stays ticked" : undefined}
      >
        <Checkbox
          checked={on}
          disabled={last}
          onCheckedChange={(v) => toggle(key, v === true)}
          data-testid={`report-column-${key}`}
        />
        <span className="text-slate-700">{c.header}</span>
      </label>
    );
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-2xl overflow-y-auto" data-view-safe data-testid="report-dialog">
        <DialogHeader>
          <DialogTitle>Export report</DialogTitle>
          <DialogDescription>
            The filters start from the page; change them here for the file only. Excel or PDF, with the totals of the
            ticked money columns, the Final Summary and the signatures.
          </DialogDescription>
        </DialogHeader>

        <section className="space-y-2" aria-label="What to export">
          <p className="text-xs font-bold uppercase tracking-wider text-gray-400">Filters</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <div className="space-y-1">
              <Label className="text-xs">Month</Label>
              <Select
                value={r.period ? String(r.period.month) : ALL_MONTHS}
                onValueChange={(v) =>
                  patch({
                    period: v === ALL_MONTHS ? null : { month: Number(v), year: r.period?.year ?? thisYear },
                  })
                }
              >
                <SelectTrigger className={TRIGGER} aria-label="Report month" data-testid="report-month">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_MONTHS}>All months</SelectItem>
                  {MONTH_FULL.map((m, i) => (
                    <SelectItem key={m} value={String(i + 1)}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Year</Label>
              <Select
                value={String(r.period?.year ?? thisYear)}
                onValueChange={(v) => r.period && patch({ period: { month: r.period.month, year: Number(v) } })}
                disabled={!r.period}
              >
                <SelectTrigger className={TRIGGER} aria-label="Report year" data-testid="report-year">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {years.map((y) => (
                    <SelectItem key={y} value={String(y)}>
                      {y}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="col-span-2 space-y-1 sm:col-span-1">
              <Label className="text-xs">In the month</Label>
              <Select value={r.basis} onValueChange={(v) => patch({ basis: v as MonthBasis })} disabled={!r.period}>
                <SelectTrigger className={TRIGGER} aria-label="Which activity counts" data-testid="report-basis">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BASIS_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Status</Label>
              <Select value={r.status} onValueChange={(v) => patch({ status: v as StatusFilter })}>
                <SelectTrigger className={TRIGGER} aria-label="Report status" data-testid="report-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EXPORT_STATUS_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                      {o.hint ? ` (${o.hint})` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Type</Label>
              <Select
                value={r.type}
                onValueChange={(v) => patch({ type: v as ReportSettings["type"], department: "all" })}
              >
                <SelectTrigger className={TRIGGER} aria-label="Report type" data-testid="report-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All types</SelectItem>
                  <SelectItem value="general">{TYPE_LABEL.general}</SelectItem>
                  <SelectItem value="term">{TYPE_LABEL.term}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Staff / Production</Label>
              <Select
                value={r.employeeType}
                onValueChange={(v) =>
                  patch({ employeeType: v, department: keepIfOffered(r.department, departmentsFor(v), "all") })
                }
              >
                <SelectTrigger className={TRIGGER} aria-label="Report employee type" data-testid="report-employee-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Staff and production</SelectItem>
                  <SelectItem value="staff">Staff</SelectItem>
                  <SelectItem value="production">Production</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Department</Label>
              <Select value={r.department} onValueChange={(v) => patch({ department: v })}>
                <SelectTrigger className={TRIGGER} aria-label="Report department" data-testid="report-department">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All departments</SelectItem>
                  <OrgSelectItems options={departments} />
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Branch</Label>
              <Select value={r.branch} onValueChange={(v) => patch({ branch: v })}>
                <SelectTrigger className={TRIGGER} aria-label="Report branch" data-testid="report-branch">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All branches</SelectItem>
                  {branches.map((b) => (
                    <SelectItem key={b} value={b}>
                      {b}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {fromPage && (
            <p className="text-[11px] text-gray-500" data-testid="report-from-page">
              Also from the page: {fromPage}
            </p>
          )}
        </section>

        <section className="space-y-2" aria-label="Columns">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-bold uppercase tracking-wider text-gray-400">
              Columns ({r.columns.length} of {EXPORT_COLUMNS.length})
            </p>
            <button
              type="button"
              onClick={() => setColumns([...DEFAULT_COLUMN_KEYS])}
              disabled={isDefaultColumns}
              className="inline-flex items-center gap-1 text-xs font-semibold text-blue-600 hover:underline disabled:cursor-default disabled:text-gray-400 disabled:no-underline"
              data-testid="report-columns-reset"
            >
              <RotateCcw size={12} /> Reset to default
            </button>
          </div>
          <div className="rounded-xl border bg-white p-2">
            <p className="px-1.5 pb-1 text-[11px] font-semibold text-gray-500">The owner's columns</p>
            <div className="grid grid-cols-2 sm:grid-cols-3">{DEFAULT_COLUMN_KEYS.map(columnBox)}</div>
            <p className="mt-2 border-t px-1.5 pb-1 pt-2 text-[11px] font-semibold text-gray-500">More columns</p>
            <div className="grid grid-cols-2 sm:grid-cols-3">{EXTRA_COLUMN_KEYS.map(columnBox)}</div>
          </div>
        </section>

        <p className="text-xs text-gray-600" data-testid="report-summary">
          <b>{countOf(rows.length, tab)}</b> · {exportTypeLabel(tab)} · {exportStatusLabel(r.status)} ·{" "}
          {periodLabel(r.period)} · {exportColumns(r.columns).length} columns
        </p>
        {saved && (
          <p className="text-xs font-medium text-emerald-700" data-testid="report-saved">
            Downloaded {saved}
          </p>
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={onClose} disabled={!!busy}>
            Close
          </Button>
          <Button
            variant="outline"
            className="gap-2 border-emerald-200 text-emerald-700 hover:bg-emerald-50"
            onClick={() => run("xlsx")}
            disabled={!!busy || rows.length === 0}
            data-view-safe
            data-testid="report-xlsx"
          >
            {busy === "xlsx" ? <Loader2 size={14} className="animate-spin" /> : <FileSpreadsheet size={14} />} Excel
          </Button>
          <Button
            className="gap-2"
            onClick={() => run("pdf")}
            disabled={!!busy || rows.length === 0}
            data-view-safe
            data-testid="report-pdf"
          >
            {busy === "pdf" ? <Loader2 size={14} className="animate-spin" /> : <FileText size={14} />} PDF
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

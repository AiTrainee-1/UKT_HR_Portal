import { useEffect, useId, useMemo, useState, type ComponentType } from "react";
import {
  CalendarRange,
  CheckCircle2,
  Download,
  FileSearch,
  FileSpreadsheet,
  FileText,
  IndianRupee,
  Layers,
  Mail,
  MessageCircle,
  RotateCcw,
  Search,
  TrendingUp,
  Users,
  Wallet,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { DataPagination } from "@/components/ui/DataPagination";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import SalarySlipBulkPipeline from "@/components/SalarySlipBulkPipeline";
import WhatsAppBulkPipeline from "@/components/WhatsAppBulkPipeline";
import { useAuth } from "@/contexts/AuthContext";
import { useSalarySlipBulk } from "@/contexts/SalarySlipBulkContext";
import { useWhatsAppBulk } from "@/contexts/WhatsAppBulkContext";
import { useToast } from "@/hooks/use-toast";
import {
  PAY_CYCLE_INFO,
  downloadDocumentPdf,
  previewDocumentPdf,
  useEmailSalarySlip,
  useListSalarySlips,
  usePayrollSettings,
  useWhatsAppSalarySlip,
  type PayCycle,
  type PayrollKind,
  type SalarySlipItem,
} from "@/lib/api-client/custom-hooks";
import { dateTime, inr, inr2, monthYear, plural } from "@/components/payroll/kit/format";
import { ExportMenu, type ExportItem } from "@/components/payroll/kit/ExportMenu";
import { Avatar, BusyIcon, Chip, EmptyNote, KpiTile, SkeletonRows } from "@/components/payroll/kit/parts";
import { hasTds, tdsAmount, tdsLabel } from "@/components/payroll/kit/statutory";
import { cn } from "@/lib/utils";
import { pageSlice } from "../records/records-logic";
import {
  ALL_DEPARTMENTS,
  MONTH_NAMES,
  emailedDay,
  errorText,
  filterSlips,
  parseYear,
  registerColumnsFor,
  registerFileStem,
  slipCycleLabel,
  slipDepartments,
  slipFilterCount,
  slipPeriodText,
  slipTotals,
} from "./payslips-logic";

export type PayslipsPanelProps = {
  kind: PayrollKind;
  /** The production pay cycle whose slips to show (a weekly page shows only weekly slips). */
  cycle?: PayCycle;
  accent: "indigo" | "amber";
  /** Test ids are `<prefix>-payslip-tab`, `<prefix>-slip-row-<id>` and so on. Default "pcp" for production, "sp" for staff. */
  testIdPrefix?: string;
  /** Give both to control the month from outside (the address); leave them out and the panel keeps its own, on this month. */
  month?: number;
  year?: number;
  onPeriodChange?: (month: number, year: number) => void;
};

const ACCENT = {
  indigo: { tile: "bg-indigo-50 text-indigo-800", on: "border-indigo-300 bg-indigo-50 text-indigo-800" },
  amber: { tile: "bg-amber-50 text-amber-800", on: "border-amber-300 bg-amber-50 text-amber-800" },
} as const;

type IconType = ComponentType<{ size?: number; className?: string }>;

/** One of a payslip's four buttons: an icon (a spinner while it runs) and its words where there is room for them. */
function SlipAction({
  icon,
  busy,
  label,
  ariaLabel,
  disabled,
  onClick,
  className,
  testId,
}: {
  icon: IconType;
  busy: boolean;
  label: string;
  ariaLabel: string;
  disabled: boolean;
  onClick: () => void;
  className?: string;
  testId: string;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={cn("h-8 gap-1.5 px-2.5 text-xs", className)}
      aria-label={ariaLabel}
      title={ariaLabel}
      disabled={disabled}
      onClick={onClick}
      data-testid={testId}
    >
      <BusyIcon busy={busy} icon={icon} size={14} />
      <span className="hidden xl:inline">{label}</span>
    </Button>
  );
}

/**
 * The payslips of a month (staff) or of one pay cycle (production): a month overview, a search and department filter,
 * a "not yet emailed" filter, each slip with its PDF / email / WhatsApp actions, the bulk versions of them, and the
 * Payslip register as Excel or CSV. It replaces both the Staff Payroll and the Production Payroll payslip tabs.
 */
export function PayslipsPanel({ kind, cycle, accent, testIdPrefix, month, year, onPeriodChange }: PayslipsPanelProps) {
  const p = testIdPrefix ?? (kind === "production" ? "pcp" : "sp");
  const colors = ACCENT[accent];
  const ids = useId();
  const { toast } = useToast();
  const { token } = useAuth();
  const emailMutation = useEmailSalarySlip();
  const whatsappMutation = useWhatsAppSalarySlip();
  const bulk = useSalarySlipBulk();
  const whatsappBulk = useWhatsAppBulk();
  const { data: settings } = usePayrollSettings();

  // ── the month (the page's, or this panel's own) ──
  const today = new Date();
  const [ownPeriod, setOwnPeriod] = useState({ month: today.getMonth() + 1, year: today.getFullYear() });
  const controlled = month !== undefined && year !== undefined;
  const period = month !== undefined && year !== undefined ? { month, year } : ownPeriod;
  const changePeriod = (m: number, y: number) => {
    if (!controlled) setOwnPeriod({ month: m, year: y });
    onPeriodChange?.(m, y);
  };
  // The year is typed: it is only asked of the server once it is a whole year.
  const [yearText, setYearText] = useState(String(period.year));
  useEffect(() => {
    setYearText((text) => (parseYear(text) === period.year ? text : String(period.year)));
  }, [period.year]);

  // ── the slips ──
  const params = { month: period.month, year: period.year, employmentType: kind };
  const query = useListSalarySlips(kind === "production" && cycle ? { ...params, payCycle: cycle } : params);
  const { data, isLoading, isError, error, isFetching, refetch } = query;
  const slips = useMemo(() => data ?? [], [data]);
  const cycleName = cycle ? PAY_CYCLE_INFO[cycle].label : null;
  const periodName = monthYear(period.month, period.year);

  // ── what is shown ──
  const [search, setSearch] = useState("");
  const [dept, setDept] = useState(ALL_DEPARTMENTS);
  const [notEmailed, setNotEmailed] = useState(false);
  const filter = { q: search, dept, notEmailed };
  const filtered = useMemo(
    () => filterSlips(slips, { q: search, dept, notEmailed }),
    [slips, search, dept, notEmailed],
  );
  const totals = useMemo(() => slipTotals(slips), [slips]);
  const shown = useMemo(() => slipTotals(filtered), [filtered]);
  const departments = useMemo(() => slipDepartments(slips), [slips]);
  useEffect(() => {
    // A department chosen for one month may not exist in the next: do not leave a filter nobody can see.
    if (!isLoading && dept !== ALL_DEPARTMENTS && !departments.some((d) => d.value === dept)) setDept(ALL_DEPARTMENTS);
  }, [isLoading, departments, dept]);

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const resetKey = `${period.month}/${period.year}|${search}|${dept}|${notEmailed}`;
  const [seenKey, setSeenKey] = useState(resetKey);
  if (seenKey !== resetKey) {
    setSeenKey(resetKey);
    setPage(1);
  }
  const view = useMemo(() => pageSlice(filtered, page, pageSize), [filtered, page, pageSize]);
  const filterCount = slipFilterCount(filter);
  const clearFilters = () => {
    setSearch("");
    setDept(ALL_DEPARTMENTS);
    setNotEmailed(false);
  };

  // ── one slip's actions ──
  const [emailing, setEmailing] = useState<number | null>(null);
  const [whatsapping, setWhatsapping] = useState<number | null>(null);
  const [pdfBusy, setPdfBusy] = useState<{ id: number; mode: "preview" | "download" } | null>(null);

  async function doPdf(slip: SalarySlipItem, mode: "preview" | "download") {
    setPdfBusy({ id: slip.id, mode });
    try {
      const url = `/api/salary-slips/${slip.id}/pdf`;
      if (mode === "preview") await previewDocumentPdf(url, () => token);
      else await downloadDocumentPdf(url, () => token);
    } catch {
      toast({ title: "Failed to generate PDF", variant: "destructive" });
    } finally {
      setPdfBusy(null);
    }
  }

  async function doEmail(slip: SalarySlipItem) {
    setEmailing(slip.id);
    try {
      const result = await emailMutation.mutateAsync({ id: slip.id });
      toast({ title: `Email sent to ${slip.employeeName}`, description: `Salary slip delivered to ${result.sentTo}` });
      void refetch(); // the slip now says when it was emailed
    } catch (err) {
      toast({ title: "Failed to send email", description: errorText(err), variant: "destructive" });
    } finally {
      setEmailing(null);
    }
  }

  async function doWhatsApp(slip: SalarySlipItem) {
    setWhatsapping(slip.id);
    try {
      const result = await whatsappMutation.mutateAsync(slip.id);
      toast({
        title: `WhatsApp sent to ${slip.employeeName}`,
        description: `Salary slip delivered to ${result.sentTo}`,
      });
    } catch (err) {
      toast({ title: "Failed to send via WhatsApp", description: errorText(err), variant: "destructive" });
    } finally {
      setWhatsapping(null);
    }
  }

  // ── the bulk actions: always the whole month (and cycle), whatever the filters show ──
  const bulkParams = {
    month: period.month,
    year: period.year,
    employmentType: kind,
    ...(kind === "production" && cycle ? { payCycle: cycle } : {}),
  };
  const everyone = totals.slips;
  const bulkEmail = () => {
    void Promise.resolve(bulk.triggerBulkEmail(bulkParams)).then(() => refetch());
  };

  // ── the register ──
  const registerFile = registerFileStem(kind, cycle, period.month, period.year);
  // two TDS columns join the register only when a slip listed has TDS
  const registerColumns = registerColumnsFor(filtered);
  const exportItems: ExportItem[] = [
    {
      key: "excel",
      label: "Payslip register (Excel)",
      hint: `${plural(filtered.length, "payslip")} as listed, styled sheet`,
      icon: FileSpreadsheet,
      disabled: filtered.length === 0,
      run: async () => {
        const { exportTableToExcel } = await import("@/components/payroll/kit/export-table");
        await exportTableToExcel({
          rows: filtered,
          columns: registerColumns,
          filename: registerFile,
          sheetName: "Payslips",
          company: settings?.companyName || "UKTextiles",
          subtitle: `${kind === "production" ? `Production${cycleName ? ` - ${cycleName}` : ""}` : "Staff"} - ${periodName}`,
          title: "Payslip register",
        });
      },
    },
    {
      key: "csv",
      label: "Payslip register (CSV)",
      hint: `${plural(filtered.length, "payslip")} as listed, plain text`,
      icon: FileText,
      disabled: filtered.length === 0,
      run: async () => {
        const { exportTableToCsv } = await import("@/components/payroll/kit/export-table");
        exportTableToCsv({ rows: filtered, columns: registerColumns, filename: registerFile });
      },
    },
  ];

  const who = kind === "production" ? (cycleName ? `${cycleName} cycle` : "production") : "staff";

  return (
    <div className="min-w-0 space-y-4" data-testid={`${p}-payslip-tab`} data-kind={kind}>
      <div className="grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 xl:grid-cols-4" data-testid={`${p}-slip-kpis`}>
        <KpiTile
          testId={`${p}-slip-kpi-employees`}
          label="Employees"
          icon={Users}
          tone={colors.tile}
          loading={isLoading}
          value={totals.employees}
          sub={totals.slips !== totals.employees ? plural(totals.slips, "payslip") : periodName}
        />
        <KpiTile
          testId={`${p}-slip-kpi-gross`}
          label="Total gross"
          icon={TrendingUp}
          tone="bg-blue-50 text-blue-800"
          loading={isLoading}
          value={inr(totals.gross)}
          sub="before deductions"
        />
        <KpiTile
          testId={`${p}-slip-kpi-deductions`}
          label="Deductions"
          icon={IndianRupee}
          tone="bg-red-50 text-red-800"
          loading={isLoading}
          value={inr(totals.deductions)}
          sub={totals.gross > 0 ? `${Math.round((totals.deductions / totals.gross) * 100)}% of gross` : undefined}
        />
        <KpiTile
          testId={`${p}-slip-kpi-net`}
          label="Total net salary"
          icon={Wallet}
          tone="bg-green-50 text-green-800"
          loading={isLoading}
          value={inr(totals.net)}
          sub="paid out through payslips"
        />
      </div>

      <div className="clay-card rounded-2xl border border-slate-100 p-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor={`${ids}-month`} className="text-xs font-medium text-muted-foreground">
              Month
            </label>
            <select
              id={`${ids}-month`}
              aria-label="Month"
              value={period.month}
              onChange={(e) => changePeriod(Number(e.target.value), period.year)}
              className="h-10 rounded-md border border-input bg-white px-3 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
              data-testid={`${p}-slips-month`}
            >
              {MONTH_NAMES.map((name, i) => (
                <option key={name} value={i + 1}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={`${ids}-year`} className="text-xs font-medium text-muted-foreground">
              Year
            </label>
            <Input
              id={`${ids}-year`}
              type="number"
              aria-label="Year"
              value={yearText}
              min={2000}
              max={2100}
              onChange={(e) => {
                setYearText(e.target.value);
                const next = parseYear(e.target.value);
                if (next !== null && next !== period.year) changePeriod(period.month, next);
              }}
              className="h-10 w-24"
              data-testid={`${p}-slips-year`}
            />
          </div>
          <div className="relative min-w-[12rem] flex-1">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name or employee code"
              aria-label="Search the payslips by name or code"
              className="h-10 pl-9"
              data-testid={`${p}-slips-search`}
            />
          </div>
          <Select value={dept} onValueChange={setDept} disabled={isLoading || departments.length === 0}>
            <SelectTrigger className="h-10 w-full sm:w-48" aria-label="Department" data-testid={`${p}-slips-dept`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_DEPARTMENTS}>All departments</SelectItem>
              {departments.map((d) => (
                <SelectItem key={d.value} value={d.value}>
                  {d.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <button
            type="button"
            aria-pressed={notEmailed}
            onClick={() => setNotEmailed((v) => !v)}
            disabled={isLoading}
            className={cn(
              "inline-flex h-10 items-center gap-2 rounded-md border px-3 text-sm font-semibold transition-colors disabled:opacity-50",
              notEmailed ? colors.on : "border-input bg-white text-gray-600 hover:bg-gray-50",
            )}
            data-testid={`${p}-slips-not-emailed`}
          >
            <Mail size={14} /> Not yet emailed
            {!isLoading && <span className="rounded-full bg-black/5 px-1.5 text-[11px]">{totals.notEmailed}</span>}
          </button>
          <ExportMenu
            items={exportItems}
            testId={`${p}-export`}
            heading="What to export"
            disabled={isLoading || slips.length === 0}
            className="h-10 gap-2 border-emerald-200 text-emerald-700 hover:bg-emerald-50"
          />
        </div>
        {filterCount > 0 && (
          <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-gray-100 pt-2.5 text-xs text-gray-500">
            <span data-testid={`${p}-slips-count`}>
              {filtered.length} of {slips.length} payslips match
            </span>
            <button
              type="button"
              onClick={clearFilters}
              className="font-semibold text-blue-600 hover:underline"
              data-testid={`${p}-slips-clear`}
            >
              Clear filters
            </button>
          </div>
        )}
      </div>

      <div
        className="sticky top-0 z-20 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border bg-white/95 px-3 py-2.5 shadow-sm backdrop-blur"
        data-testid={`${p}-bulk-bar`}
      >
        <div className="min-w-0">
          {isLoading ? (
            <Skeleton className="h-4 w-44" />
          ) : (
            <p className="text-sm font-semibold text-gray-900">
              {plural(everyone, "payslip")} · {cycleName ? `${cycleName} · ` : ""}
              {periodName}
            </p>
          )}
          <p className="text-[11px] text-muted-foreground">
            Bulk actions cover every {who} payslip of this period, not only the ones listed.
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9 gap-2 border-purple-200 text-purple-700 hover:bg-purple-50"
            disabled={bulk.isRunning || everyone === 0}
            onClick={bulkEmail}
            title="Send every payslip of this period by email"
            data-testid={`${p}-bulk-email`}
          >
            <BusyIcon busy={bulk.isRunning && bulk.progress?.kind === "email"} icon={Mail} size={14} />
            Bulk Send ({everyone})
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9 gap-2 border-emerald-200 text-emerald-700 hover:bg-emerald-50"
            disabled={whatsappBulk.isRunning || everyone === 0}
            onClick={() => void whatsappBulk.triggerBulkWhatsApp(bulkParams)}
            title="Send every payslip of this period on WhatsApp"
            data-testid={`${p}-bulk-whatsapp`}
          >
            <BusyIcon busy={whatsappBulk.isRunning} icon={MessageCircle} size={14} />
            Bulk WhatsApp ({everyone})
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9 gap-2"
            disabled={bulk.isRunning || everyone === 0}
            onClick={() => void bulk.triggerBulkDownload(bulkParams)}
            title="Download every payslip of this period as one PDF"
            data-testid={`${p}-bulk-download`}
          >
            <BusyIcon busy={bulk.isRunning && bulk.progress?.kind === "pdf"} icon={Layers} size={14} />
            Bulk Download All ({everyone})
          </Button>
        </div>
      </div>

      <SalarySlipBulkPipeline active={bulk.showPipeline} data={bulk.progress} onDismiss={bulk.dismiss} />
      <WhatsAppBulkPipeline
        active={whatsappBulk.showPipeline}
        data={whatsappBulk.progress}
        onDismiss={whatsappBulk.dismiss}
      />

      {isLoading ? (
        <SkeletonRows rows={6} />
      ) : isError && !data ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-red-200 bg-red-50 px-4 py-4"
          data-testid={`${p}-slips-error`}
        >
          <p className="text-sm text-red-800">
            <b>Could not load the payslips.</b> {errorText(error)}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => void refetch()}
            disabled={isFetching}
            data-testid={`${p}-slips-retry`}
          >
            <BusyIcon busy={isFetching} icon={RotateCcw} size={13} /> Retry
          </Button>
        </div>
      ) : slips.length === 0 ? (
        <EmptyNote
          testId={`${p}-slips-empty`}
          icon={FileText}
          title={`No ${kind === "production" ? (cycleName ?? "production") : "staff"} payslips for ${periodName}`}
          hint={
            kind === "production"
              ? "A payslip belongs to the month its pay period ends in. Generate payroll for the period first; its payslips appear here."
              : "Generate payroll for this month first; its payslips appear here."
          }
        />
      ) : filtered.length === 0 ? (
        <EmptyNote
          testId={`${p}-slips-empty`}
          icon={Search}
          title="No payslip matches these filters"
          hint="Try another name or department, or show every payslip again."
          action={
            <Button type="button" variant="outline" size="sm" onClick={clearFilters}>
              Clear filters
            </Button>
          }
        />
      ) : (
        <>
          <div
            className={cn(
              "clay-card overflow-hidden rounded-2xl border border-slate-100 transition-opacity",
              isFetching && "opacity-60",
            )}
            data-testid={`${p}-slips-list`}
          >
            <div className="divide-y divide-gray-100">
              {view.items.map((slip) => {
                const cycleLabel = slipCycleLabel(slip);
                const sent = emailedDay(slip.emailedAt);
                const previewing = pdfBusy?.id === slip.id && pdfBusy.mode === "preview";
                const downloading = pdfBusy?.id === slip.id && pdfBusy.mode === "download";
                return (
                  <div
                    key={slip.id}
                    className="flex flex-col gap-3 px-4 py-3.5 transition-colors hover:bg-slate-50/70 md:flex-row md:items-center"
                    data-testid={`${p}-slip-row-${slip.id}`}
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-3">
                      <Avatar name={slip.employeeName} size={40} />
                      <div className="min-w-0">
                        <p className="truncate text-sm font-bold text-gray-900">{slip.employeeName}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          <span className="font-mono">{slip.employeeCode}</span>
                          {slip.designationTitle && <> · {slip.designationTitle}</>}
                          {slip.departmentName && <> · {slip.departmentName}</>}
                        </p>
                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                          {cycleLabel && (
                            <Chip tone="caution" icon={Layers}>
                              {cycleLabel}
                            </Chip>
                          )}
                          <Chip tone="neutral" icon={CalendarRange}>
                            {slipPeriodText(slip)}
                          </Chip>
                          {hasTds(slip) && (
                            <span data-testid={`${p}-slip-tds-${slip.id}`}>
                              <Chip
                                tone="warning"
                                title="Tax deducted at source, part of the deductions on this payslip"
                              >
                                {tdsLabel(slip)} {inr(tdsAmount(slip))}
                              </Chip>
                            </span>
                          )}
                          {sent ? (
                            <Chip tone="success" icon={CheckCircle2} title={dateTime(slip.emailedAt)}>
                              Emailed {sent}
                            </Chip>
                          ) : (
                            <Chip tone="neutral">Not emailed</Chip>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center justify-between gap-3 md:justify-end">
                      <div className="text-right">
                        <p className="text-base font-black text-green-700">{inr2(slip.netSalary)}</p>
                        <p className="text-[11px] text-muted-foreground">net salary</p>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <SlipAction
                          testId={`${p}-slip-${slip.id}-view`}
                          icon={FileSearch}
                          busy={previewing}
                          label="View PDF"
                          ariaLabel={`View the payslip PDF of ${slip.employeeName}`}
                          disabled={pdfBusy !== null}
                          onClick={() => void doPdf(slip, "preview")}
                        />
                        <SlipAction
                          testId={`${p}-slip-${slip.id}-download`}
                          icon={Download}
                          busy={downloading}
                          label="Download PDF"
                          ariaLabel={`Download the payslip PDF of ${slip.employeeName}`}
                          disabled={pdfBusy !== null}
                          onClick={() => void doPdf(slip, "download")}
                          className="border-green-200 text-green-700 hover:bg-green-50"
                        />
                        <SlipAction
                          testId={`${p}-slip-${slip.id}-email`}
                          icon={Mail}
                          busy={emailing === slip.id}
                          label="Email"
                          ariaLabel={`Send the payslip of ${slip.employeeName} by email`}
                          disabled={emailing !== null}
                          onClick={() => void doEmail(slip)}
                          className="border-purple-200 text-purple-700 hover:bg-purple-50"
                        />
                        <SlipAction
                          testId={`${p}-slip-${slip.id}-whatsapp`}
                          icon={MessageCircle}
                          busy={whatsapping === slip.id}
                          label="WhatsApp"
                          ariaLabel={`Send the payslip of ${slip.employeeName} on WhatsApp`}
                          disabled={whatsapping !== null}
                          onClick={() => void doWhatsApp(slip)}
                          className="border-emerald-200 text-emerald-700 hover:bg-emerald-50"
                        />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            <div
              className="flex flex-wrap items-center justify-between gap-2 border-t border-gray-100 bg-gray-50/60 px-5 py-3 text-xs text-gray-500"
              data-testid={`${p}-slips-footer`}
            >
              <span>
                {filtered.length === slips.length
                  ? plural(filtered.length, "payslip")
                  : `${filtered.length} of ${plural(slips.length, "payslip")}`}
              </span>
              <span className="font-semibold text-gray-700">Total net {inr2(shown.net)}</span>
            </div>
          </div>
          <DataPagination
            page={view.page}
            totalPages={view.totalPages}
            totalItems={view.total}
            pageSize={pageSize}
            onPageChange={setPage}
            onPageSizeChange={view.total > 10 ? setPageSize : undefined}
            className="px-1"
          />
        </>
      )}
    </div>
  );
}

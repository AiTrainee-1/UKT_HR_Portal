import { Fragment, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import HrLayout from "@/components/HrLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { PillTabs } from "@/components/ui/pill-tabs";
import DayStatusDialog from "./punch-view/DayStatusDialog";
import { StatusChip } from "./punch-view/parts";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import {
  usePunchList, downloadPunchesExcel, useImportPunches,
  type PunchFilters, type PunchImportResult,
} from "@/lib/api-client/custom-hooks";
import {
  ArrowLeft, Download, UploadCloud, Search, Fingerprint, Info,
  CheckCircle2, AlertTriangle, X, ChevronLeft, ChevronRight, Trash2, Loader2, History, CalendarCheck, Pencil,
} from "lucide-react";

const PAGE_SIZE = 100;

/** From this many deletions on, the confirmation asks for the word DELETE to be typed (and always when the file has none of the
 *  punches its download listed). */
const TYPED_CONFIRM_FROM = 25;

/** YYYY-MM-DD from the viewer's LOCAL calendar date.
 *
 *  Deliberately not toISOString().slice(0,10): that converts to UTC first, so
 *  in IST (UTC+5:30) it returns *yesterday* between midnight and 05:30 —
 *  "Today" would quietly show the wrong day every early morning, which on an
 *  attendance screen looks like missing punches rather than a date bug. */
function localISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function todayISO(): string {
  return localISO(new Date());
}

/** Monday of the current week -the working week people actually mean by
 *  "this week", rather than JS's Sunday-based getDay() origin. */
function startOfWeekISO(): string {
  const d = new Date();
  const dow = d.getDay();                 // 0 = Sunday
  const backToMonday = dow === 0 ? 6 : dow - 1;
  d.setDate(d.getDate() - backToMonday);
  return localISO(d);
}

function startOfMonthISO(): string {
  const d = new Date();
  d.setDate(1);
  return localISO(d);
}

/** "12 Aug – 28 Aug 2026", collapsing to a single date when both ends match. */
function rangeLabel(from?: string | null, to?: string | null): string {
  if (!from || !to) return "";
  const fmt = (iso: string) =>
    new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
      day: "numeric", month: "short", year: "numeric",
    });
  return from === to ? fmt(to) : `${fmt(from)} – ${fmt(to)}`;
}

type DatePreset = "today" | "week" | "month" | "custom";

/** Ranges always end today: punches can't exist in the future, so extending
 *  to a month/week end would only ever add empty days. */
function rangeForPreset(preset: DatePreset): { dateFrom: string; dateTo: string } {
  const dateTo = todayISO();
  if (preset === "today") return { dateFrom: dateTo, dateTo };
  if (preset === "week") return { dateFrom: startOfWeekISO(), dateTo };
  if (preset === "month") return { dateFrom: startOfMonthISO(), dateTo };
  return { dateFrom: dateTo, dateTo };
}

/**
 * Punch View -every punch already stored in the database, filterable, with an
 * Excel round trip.
 *
 * Deliberately never contacts a biometric device. The old Manual Import had
 * to reach the device just to produce its file, which is impossible from a
 * cloud-hosted backend (devices live on a private factory LAN) -so it failed
 * regardless of the data already sitting in the database. This reads what
 * ADMS push has already delivered, so it works from anywhere.
 */
export default function PunchView() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);

  // Defaults to Today -the overwhelmingly common case is "did this morning's
  // punches come through", not a historical range.
  const [datePreset, setDatePreset] = useState<DatePreset>("today");
  const [filters, setFilters] = useState<PunchFilters>({
    ...rangeForPreset("today"),
    employmentType: "",
    punchType: "",
    search: "",
  });
  const [page, setPage] = useState(0);
  const [searchInput, setSearchInput] = useState("");
  const [exporting, setExporting] = useState(false);
  const [importResult, setImportResult] = useState<PunchImportResult | null>(null);
  // The checked file waiting for a yes: what it would change, and the file to send again with "delete" switched on.
  const [pending, setPending] = useState<{ file: File; check: PunchImportResult } | null>(null);
  const [confirmText, setConfirmText] = useState("");
  // the Day status dialog: opened from a day's pencil (code and date filled in) or from the toolbar (empty)
  const [dayDialog, setDayDialog] = useState<{ code: string; date: string } | null>(null);

  const query: PunchFilters = { ...filters, limit: PAGE_SIZE, offset: page * PAGE_SIZE };
  const { data, isLoading } = usePunchList(query);
  const importer = useImportPunches();

  const rows = data?.results ?? [];
  const total = data?.total ?? 0;
  const maxPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);

  // Group consecutive rows by employee. Relies on the backend already
  // ordering by name → date → time, so this only has to detect where one
  // person's block ends -it never re-sorts. Re-sorting here would be wrong:
  // it would silently reorder within a page while the pages themselves
  // stayed in server order, so page 2 could start mid-alphabet.
  const groups = useMemo(() => {
    const out: {
      employeeId: number;
      employeeCode: string;
      employeeName: string;
      department: string | null;
      punches: typeof rows;
    }[] = [];
    for (const r of rows) {
      const last = out[out.length - 1];
      if (last && last.employeeId === r.employeeId) {
        last.punches.push(r);
      } else {
        out.push({
          employeeId: r.employeeId,
          employeeCode: r.employeeCode,
          employeeName: r.employeeName,
          department: r.department,
          punches: [r],
        });
      }
    }
    return out;
  }, [rows]);

  const patch = (p: Partial<PunchFilters>) => {
    setFilters((f) => ({ ...f, ...p }));
    setPage(0); // any filter change invalidates the current page offset
  };

  /** Switching preset recomputes the range; switching *to* Custom keeps the
   *  dates already on screen so the pickers open on the range just viewed
   *  rather than snapping back to a default. */
  const applyPreset = (preset: DatePreset) => {
    setDatePreset(preset);
    if (preset !== "custom") patch(rangeForPreset(preset));
    else setPage(0);
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      await downloadPunchesExcel(filters);
      toast({
        title: "Export downloaded",
        description: `${total} punch${total === 1 ? "" : "es"} matching the current filters.`,
      });
    } catch (e: any) {
      toast({ title: "Export failed", description: e?.message, variant: "destructive" });
    } finally {
      setExporting(false);
    }
  };

  const announce = (res: PunchImportResult) => {
    const parts = [`${res.updated} updated`, `${res.created} added`];
    if (res.deleted > 0) parts.push(`${res.deleted} deleted`);
    toast({
      title: parts.join(", "),
      description: res.errorCount > 0
        ? `${res.errorCount} row${res.errorCount === 1 ? "" : "s"} rejected -see details below.`
        : "All rows applied.",
      variant: res.errorCount > 0 ? "destructive" : "default",
    });
  };

  const apply = (file: File) => {
    importer.mutate(
      { file, deleteMissing: true },
      {
        onSuccess: (res) => {
          setPending(null);
          setConfirmText("");
          setImportResult(res);
          announce(res);
        },
        onError: (e: any) => toast({ title: "Import failed", description: e?.message, variant: "destructive" }),
      },
    );
  };

  /** The file is checked first (nothing changes). With nothing to delete it is applied at once; with punches
   *  removed from the sheet, a confirmation says exactly how many and which, and only a yes deletes them. */
  const handleFile = (file: File | null) => {
    if (!file) return;
    setImportResult(null);
    importer.mutate(
      { file, preview: true },
      {
        onSuccess: (check) => {
          if (check.canDelete && check.toDelete > 0) {
            setConfirmText("");
            setPending({ file, check });
          } else {
            apply(file);
          }
        },
        onError: (e: any) => toast({ title: "Import failed", description: e?.message, variant: "destructive" }),
      },
    );
    if (fileRef.current) fileRef.current.value = "";
  };

  const needsTyping = !!pending && (pending.check.toDelete >= TYPED_CONFIRM_FROM || pending.check.deleteAll);
  const confirmReady = !needsTyping || confirmText.trim().toUpperCase() === "DELETE";

  return (
    <HrLayout>
      <div className="space-y-5 pb-8">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate("/hr/attendance")}>
            <ArrowLeft size={18} />
          </Button>
          <div>
            <h2 className="text-2xl font-black text-gray-900">Punch View</h2>
            <p className="text-muted-foreground text-sm">
              Every punch already recorded — filter, export to Excel, edit, and upload it back.
            </p>
          </div>
          <Button
            variant="outline" className="ml-auto gap-1.5 h-9 text-xs"
            onClick={() => navigate("/hr/attendance/punch-view/history")}
            data-testid="punch-history-link"
          >
            <History size={14} /> History
          </Button>
        </div>

        <div className="rounded-lg border border-blue-100 bg-blue-50/60 p-3 flex items-start gap-2.5">
          <Info size={14} className="text-blue-600 shrink-0 mt-0.5" />
          <p className="text-xs text-blue-800">
            Reads only what's already in the database, so it never depends on reaching a device.
            Uploading the edited file makes the system match it: rows keep their <b>Punch ID</b> and are{" "}
            <b>updated</b>, a row with the Punch ID blank <b>adds</b> a new punch, and a row you{" "}
            <b>delete</b> from the sheet <b>deletes</b> that punch (you are asked to confirm first). Only punches
            that were in the file you downloaded can be deleted. Re-uploading the same file changes nothing.
            Employee Name, Department and Source may be removed from the sheet; removing a column never removes
            it from the system. A day left with no punch becomes Absent (or Half Day when the punches left fit the
            Half Day rule). To set a day as <b>Present</b>, <b>Half Day</b> or <b>Absent</b> yourself, use <b>Set day
            status</b> or the pencil beside a day; every change is kept in the <b>History</b>.
          </p>
        </div>

        {/* ── Filters ── */}
        <Card className="border-0 shadow-sm">
          <CardContent className="p-4 space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
              <div className="space-y-1.5 md:col-span-2">
                <div className="flex items-baseline gap-2">
                  <Label className="text-xs">Date range</Label>
                  {/* The resolved dates stay visible for the presets too, so
                      "This Week" is never ambiguous about where it starts. */}
                  <span className="text-[11px] text-muted-foreground">
                    {rangeLabel(filters.dateFrom, filters.dateTo)}
                  </span>
                </div>
                <PillTabs
                  size="sm"
                  items={[
                    { value: "today", label: "Today" },
                    { value: "week", label: "This Week" },
                    { value: "month", label: "This Month" },
                    { value: "custom", label: "Custom" },
                  ]}
                  value={datePreset}
                  onChange={(v) => applyPreset(v as DatePreset)}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Type</Label>
                <PillTabs
                  size="sm"
                  items={[
                    { value: "", label: "All" },
                    { value: "staff", label: "Staff" },
                    { value: "production", label: "Production" },
                  ]}
                  value={filters.employmentType ?? ""}
                  onChange={(v) => patch({ employmentType: v as PunchFilters["employmentType"] })}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Punch</Label>
                <PillTabs
                  size="sm"
                  items={[
                    { value: "", label: "All" },
                    { value: "IN", label: "IN" },
                    { value: "OUT", label: "OUT" },
                  ]}
                  value={filters.punchType ?? ""}
                  onChange={(v) => patch({ punchType: v as PunchFilters["punchType"] })}
                />
              </div>
            </div>

            {/* Manual pickers only exist under Custom -showing them beside the
                presets would invite editing a date that the preset then
                silently overwrites. */}
            {datePreset === "custom" && (
              <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">From</Label>
                  <Input
                    type="date" className="h-9 text-sm"
                    max={filters.dateTo || undefined}
                    value={filters.dateFrom ?? ""}
                    onChange={(e) => patch({ dateFrom: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">To</Label>
                  <Input
                    type="date" className="h-9 text-sm"
                    min={filters.dateFrom || undefined}
                    value={filters.dateTo ?? ""}
                    onChange={(e) => patch({ dateTo: e.target.value })}
                  />
                </div>
              </div>
            )}

            <div className="flex items-center gap-2 flex-wrap">
              <form
                className="relative flex-1 min-w-[220px]"
                onSubmit={(e) => { e.preventDefault(); patch({ search: searchInput.trim() }); }}
              >
                <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
                <Input
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  onBlur={() => patch({ search: searchInput.trim() })}
                  placeholder="Search employee code or name…"
                  className="h-9 pl-8 text-sm"
                />
              </form>

              <Button
                variant="outline" className="gap-1.5 h-9 text-xs"
                onClick={handleExport}
                disabled={exporting || isLoading || total === 0}
              >
                <Download size={14} />
                {exporting ? "Exporting…" : `Export ${total > 0 ? `(${total})` : ""}`}
              </Button>

              <Button
                variant="outline" className="gap-1.5 h-9 text-xs"
                onClick={() => setDayDialog({ code: groups.length === 1 ? groups[0].employeeCode : "", date: "" })}
                data-testid="day-status-open"
              >
                <CalendarCheck size={14} /> Set day status
              </Button>

              <input
                ref={fileRef} type="file" accept=".xlsx,.xls" className="hidden"
                onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
              />
              <Button
                variant="outline" className="gap-1.5 h-9 text-xs"
                onClick={() => fileRef.current?.click()}
                disabled={importer.isPending}
              >
                <UploadCloud size={14} />
                {importer.isPending ? "Checking…" : "Upload edited file"}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* ── Import result ── */}
        {importResult && (
          <Card className="border-0 shadow-sm">
            <CardContent className="p-4 space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-sm font-bold flex items-center gap-2">
                  {importResult.errorCount > 0
                    ? <AlertTriangle size={15} className="text-amber-500" />
                    : <CheckCircle2 size={15} className="text-green-600" />}
                  Import result
                </p>
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setImportResult(null)}>
                  <X size={14} />
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                <b className="text-green-700">{importResult.updated}</b> updated ·{" "}
                <b className="text-blue-700">{importResult.created}</b> added ·{" "}
                <b className="text-red-700">{importResult.deleted}</b> deleted ·{" "}
                <b>{importResult.unchanged}</b> unchanged
                {importResult.errorCount > 0 && (
                  <> · <b className="text-red-600">{importResult.errorCount}</b> rejected</>
                )}
              </p>
              {(importResult.historyRows ?? 0) > 0 && (
                <p className="text-xs text-muted-foreground" data-testid="punch-history-rows">
                  {importResult.historyRows} change{importResult.historyRows === 1 ? "" : "s"} written to the{" "}
                  <button type="button" className="font-semibold text-indigo-700 hover:underline" onClick={() => navigate("/hr/attendance/punch-view/history")}>
                    History
                  </button>
                  .
                </p>
              )}
              {(importResult.marksCleared ?? 0) > 0 && (
                <p className="text-xs text-muted-foreground" data-testid="punch-marks-cleared">
                  {importResult.marksCleared} day{importResult.marksCleared === 1 ? "" : "s"} no longer {importResult.marksCleared === 1 ? "has" : "have"} a punch, so {importResult.marksCleared === 1 ? "it is" : "they are"} no longer marked Present.
                </p>
              )}
              {importResult.errors.length > 0 && (
                <div className="max-h-40 overflow-y-auto rounded-lg bg-red-50 border border-red-200 p-2 space-y-0.5">
                  {importResult.errors.map((err, i) => (
                    <p key={i} className="text-[11px] text-red-700">{err}</p>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        <DayStatusDialog
          open={dayDialog !== null}
          onClose={() => setDayDialog(null)}
          initialCode={dayDialog?.code ?? ""}
          initialDate={dayDialog?.date ?? ""}
        />

        {/* ── Confirm the deletions ── */}
        <AlertDialog open={!!pending} onOpenChange={(open) => { if (!open && !importer.isPending) setPending(null); }}>
          <AlertDialogContent data-testid="punch-delete-confirm">
            <AlertDialogHeader>
              <AlertDialogTitle className="flex items-center gap-2">
                <Trash2 size={18} className="text-red-600" />
                Delete {pending?.check.toDelete} punch{pending?.check.toDelete === 1 ? "" : "es"}?
              </AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="space-y-3 text-sm">
                  <p>
                    {pending?.check.toDelete === 1 ? "This punch was" : "These punches were"} in the file you
                    downloaded and {pending?.check.toDelete === 1 ? "is" : "are"} no longer in the file you
                    uploaded. Applying the file <b>permanently deletes</b> {pending?.check.toDelete === 1 ? "it" : "them"}
                    {" "}from the system.
                  </p>
                  {pending?.check.deleteAll && (
                    <p className="rounded-md bg-red-50 border border-red-200 p-2 text-red-700 text-xs">
                      Not one of the punches in the downloaded file is left in this upload. Check that you chose the
                      right file.
                    </p>
                  )}
                  <div className="max-h-44 overflow-y-auto rounded-md border bg-slate-50 divide-y text-xs">
                    {pending?.check.deleteSample.map((d) => (
                      <div key={d.id} className="px-2 py-1 flex gap-2">
                        <span className="font-mono text-gray-500">{d.employeeCode}</span>
                        <span className="font-semibold">{d.employeeName}</span>
                        <span className="ml-auto font-mono">{d.date} {d.punchTime} {d.punchType}</span>
                      </div>
                    ))}
                    {pending && pending.check.toDelete > pending.check.deleteSample.length && (
                      <div className="px-2 py-1 text-muted-foreground">
                        and {pending.check.toDelete - pending.check.deleteSample.length} more
                      </div>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    The same upload also updates {pending?.check.updated} and adds {pending?.check.created} punch
                    {pending?.check.updated === 1 && pending?.check.created === 0 ? "" : "es"}.
                    A day left with no punch stops showing as Present.
                  </p>
                  {needsTyping && (
                    <div className="space-y-1">
                      <Label className="text-xs">Type DELETE to confirm</Label>
                      <Input
                        value={confirmText}
                        onChange={(e) => setConfirmText(e.target.value)}
                        className="h-9 text-sm"
                        data-testid="punch-delete-confirm-text"
                        autoFocus
                      />
                    </div>
                  )}
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={importer.isPending}>Cancel</AlertDialogCancel>
              <Button
                variant="destructive"
                disabled={!confirmReady || importer.isPending}
                onClick={() => pending && apply(pending.file)}
                data-testid="punch-delete-confirm-apply"
              >
                {importer.isPending ? <Loader2 size={14} className="animate-spin mr-1.5" /> : <Trash2 size={14} className="mr-1.5" />}
                Delete {pending?.check.toDelete} and apply the file
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* ── Table ── */}
        <Card className="border-0 shadow-sm overflow-hidden">
          <CardContent className="p-0">
            {isLoading ? (
              <div className="p-4 space-y-2">
                {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-10 rounded" />)}
              </div>
            ) : rows.length === 0 ? (
              <div className="py-16 text-center">
                <Fingerprint size={30} className="text-gray-200 mx-auto mb-3" />
                <p className="text-sm text-gray-500">No punches match these filters.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-slate-50 text-left">
                      {["#", "Date", "Time", "Type", "Source", "Day status"].map((h) => (
                        <th key={h} className="px-3 py-2 text-[11px] font-bold uppercase tracking-wide text-gray-500 whitespace-nowrap">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {groups.map((g) => (
                      <Fragment key={g.employeeId}>
                        {/* One header row per employee, so the boundary
                            between people is obvious at a glance rather than
                            having to compare the name column row by row. */}
                        <tr className="bg-slate-100/70 border-t-2 border-slate-200">
                          <td colSpan={6} className="px-3 py-2">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-mono text-[11px] text-gray-500">{g.employeeCode}</span>
                              <span className="font-bold text-gray-900">{g.employeeName}</span>
                              {g.department && (
                                <span className="text-[11px] text-muted-foreground">· {g.department}</span>
                              )}
                              <span className="ml-auto text-[10px] font-bold px-1.5 py-0.5 rounded bg-white text-slate-600 border">
                                {g.punches.length} punch{g.punches.length === 1 ? "" : "es"}
                              </span>
                            </div>
                          </td>
                        </tr>
                        {g.punches.map((r, i) => (
                          <tr key={r.id} className="border-t hover:bg-slate-50/60">
                            <td className="px-3 py-2 text-[11px] text-gray-400 tabular-nums">{i + 1}</td>
                            <td className="px-3 py-2 text-xs whitespace-nowrap">{r.date}</td>
                            <td className="px-3 py-2 text-xs font-mono whitespace-nowrap">{r.punchTime}</td>
                            <td className="px-3 py-2">
                              <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                                r.punchType === "IN" ? "bg-green-50 text-green-700" : "bg-orange-50 text-orange-700"
                              }`}>
                                {r.punchType}
                              </span>
                            </td>
                            <td className="px-3 py-2 text-[11px] text-gray-400 whitespace-nowrap">{r.source}</td>
                            <td className="px-3 py-2 whitespace-nowrap">
                              {(i === 0 || g.punches[i - 1].date !== r.date) && (
                                <span className="inline-flex items-center gap-1.5">
                                  {r.dayStatus
                                    ? <StatusChip status={r.dayStatus.status} source={r.dayStatus.source} />
                                    : <span className="text-[10px] text-gray-300">not worked out</span>}
                                  <button
                                    type="button"
                                    className="rounded p-1 text-gray-400 hover:bg-slate-100 hover:text-indigo-700"
                                    aria-label={`Set the status of ${g.employeeName} on ${r.date}`}
                                    title="Set this day as Present, Half Day or Absent"
                                    onClick={() => setDayDialog({ code: g.employeeCode, date: r.date })}
                                    data-testid={`day-status-edit-${g.employeeCode}-${r.date}`}
                                  >
                                    <Pencil size={12} />
                                  </button>
                                </span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* ── Pagination ── */}
        {total > PAGE_SIZE && (
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total}
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline" size="sm" className="h-8 gap-1 text-xs"
                disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}
              >
                <ChevronLeft size={13} /> Previous
              </Button>
              <Button
                variant="outline" size="sm" className="h-8 gap-1 text-xs"
                disabled={page >= maxPage} onClick={() => setPage((p) => Math.min(maxPage, p + 1))}
              >
                Next <ChevronRight size={13} />
              </Button>
            </div>
          </div>
        )}
      </div>
    </HrLayout>
  );
}

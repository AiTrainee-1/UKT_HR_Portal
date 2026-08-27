import { useRef, useState } from "react";
import { useLocation } from "wouter";
import HrLayout from "@/components/HrLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { PillTabs } from "@/components/ui/pill-tabs";
import { useToast } from "@/hooks/use-toast";
import {
  usePunchList, downloadPunchesExcel, useImportPunches,
  type PunchFilters, type PunchImportResult,
} from "@/lib/api-client/custom-hooks";
import {
  ArrowLeft, Download, UploadCloud, Search, Fingerprint, Info,
  CheckCircle2, AlertTriangle, X, ChevronLeft, ChevronRight,
} from "lucide-react";

const PAGE_SIZE = 100;

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}
function daysAgoISO(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
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

  const [filters, setFilters] = useState<PunchFilters>({
    dateFrom: daysAgoISO(7),
    dateTo: todayISO(),
    employmentType: "",
    punchType: "",
    search: "",
  });
  const [page, setPage] = useState(0);
  const [searchInput, setSearchInput] = useState("");
  const [exporting, setExporting] = useState(false);
  const [importResult, setImportResult] = useState<PunchImportResult | null>(null);

  const query: PunchFilters = { ...filters, limit: PAGE_SIZE, offset: page * PAGE_SIZE };
  const { data, isLoading } = usePunchList(query);
  const importer = useImportPunches();

  const rows = data?.results ?? [];
  const total = data?.total ?? 0;
  const maxPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);

  const patch = (p: Partial<PunchFilters>) => {
    setFilters((f) => ({ ...f, ...p }));
    setPage(0); // any filter change invalidates the current page offset
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

  const handleFile = (file: File | null) => {
    if (!file) return;
    setImportResult(null);
    importer.mutate(file, {
      onSuccess: (res) => {
        setImportResult(res);
        toast({
          title: `${res.updated} updated, ${res.created} added`,
          description: res.errorCount > 0
            ? `${res.errorCount} row${res.errorCount === 1 ? "" : "s"} rejected -see details below.`
            : "All rows applied.",
          variant: res.errorCount > 0 ? "destructive" : "default",
        });
      },
      onError: (e: any) =>
        toast({ title: "Import failed", description: e?.message, variant: "destructive" }),
    });
    if (fileRef.current) fileRef.current.value = "";
  };

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
        </div>

        <div className="rounded-lg border border-blue-100 bg-blue-50/60 p-3 flex items-start gap-2.5">
          <Info size={14} className="text-blue-600 shrink-0 mt-0.5" />
          <p className="text-xs text-blue-800">
            Reads only what's already in the database, so it never depends on reaching a device.
            On re-upload, rows keep their <b>Punch ID</b> and are <b>updated</b> — re-uploading the
            same file changes nothing. Leave Punch ID blank to add a new punch.
            Deleting a row from the sheet does <b>not</b> delete the punch.
          </p>
        </div>

        {/* ── Filters ── */}
        <Card className="border-0 shadow-sm">
          <CardContent className="p-4 space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">From</Label>
                <Input
                  type="date" className="h-9 text-sm"
                  value={filters.dateFrom ?? ""}
                  onChange={(e) => patch({ dateFrom: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">To</Label>
                <Input
                  type="date" className="h-9 text-sm"
                  value={filters.dateTo ?? ""}
                  onChange={(e) => patch({ dateTo: e.target.value })}
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
                {importer.isPending ? "Importing…" : "Upload edited file"}
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
                <b>{importResult.unchanged}</b> unchanged
                {importResult.errorCount > 0 && (
                  <> · <b className="text-red-600">{importResult.errorCount}</b> rejected</>
                )}
              </p>
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
                      {["Code", "Employee", "Department", "Date", "Time", "Type", "Source"].map((h) => (
                        <th key={h} className="px-3 py-2 text-[11px] font-bold uppercase tracking-wide text-gray-500 whitespace-nowrap">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.id} className="border-t hover:bg-slate-50/60">
                        <td className="px-3 py-2 font-mono text-xs">{r.employeeCode}</td>
                        <td className="px-3 py-2 font-semibold text-gray-800 whitespace-nowrap">{r.employeeName}</td>
                        <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">{r.department ?? "—"}</td>
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
                      </tr>
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

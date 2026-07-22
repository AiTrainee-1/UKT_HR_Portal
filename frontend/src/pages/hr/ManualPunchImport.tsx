import { useRef, useState } from "react";
import { useLocation } from "wouter";
import ExcelJS from "exceljs";
import HrLayout from "@/components/HrLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PillTabs } from "@/components/ui/pill-tabs";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import { useListBiometricDevices, type SyncBiometricMode } from "@/lib/api-client/custom-hooks";
import {
  ArrowLeft, Download, UploadCloud, FileSpreadsheet, CheckCircle2,
  XCircle, AlertTriangle, ListChecks, Info, X, Fingerprint,
} from "lucide-react";

// Must match EXPORT_HEADERS in backend/api/manual_attendance_import_views.py —
// the backend rejects the file outright if these don't match exactly.
const PUNCH_HEADERS = [
  "Employee Code", "Employee Name", "Device User ID", "Matched", "Date", "Punch Time", "Punch Type",
] as const;

const RANGE_MODES: { key: SyncBiometricMode; label: string }[] = [
  { key: "day", label: "Today" },
  { key: "week", label: "Last 7 Days" },
  { key: "month", label: "Last 30 Days" },
  { key: "all", label: "All" },
];

type PunchRow = {
  kind: "punch" | "no_punch";
  employeeCode: string;
  employeeName: string;
  deviceUserId: string;
  matched: boolean;
  date: string;
  time: string;
  punchType: string;
};

type ImportResult = {
  message: string;
  created: number;
  skipped: number;
  notFound: string[];
  errors: string[];
  suspiciousDays: { employeeId: number; employeeName: string; date: string; punches: number }[];
};

function todayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function styleHeaderRow(headerRow: ExcelJS.Row) {
  PUNCH_HEADERS.forEach((h, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = h;
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1B4B6E" } };
    cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = { bottom: { style: "medium", color: { argb: "FF0A2E3E" } } };
  });
  headerRow.height = 28;
}

async function downloadPunchesAsExcel(rows: PunchRow[]) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "UKTextiles HRMS";
  const ws = wb.addWorksheet("Punches");
  ws.columns = PUNCH_HEADERS.map((h) => ({ key: h, width: Math.max(16, h.length + 4) }));
  styleHeaderRow(ws.getRow(1));

  rows.forEach((r) => {
    const isNoPunch = r.kind === "no_punch";
    const row = ws.addRow([
      r.employeeCode, r.employeeName, r.deviceUserId,
      isNoPunch ? "—" : r.matched ? "Yes" : "No",
      isNoPunch ? "" : r.date, isNoPunch ? "" : r.time, isNoPunch ? "" : r.punchType,
    ]);
    if (isNoPunch) {
      row.eachCell((cell) => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8EEF3" } };
      });
    } else if (!r.matched) {
      row.eachCell((cell) => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFDF3D6" } };
      });
    }
  });

  // Dropdown on Punch Type to cut down on typos when HR hand-edits a row.
  const typeCol = PUNCH_HEADERS.indexOf("Punch Type") + 1;
  for (let r = 2; r <= rows.length + 1; r++) {
    ws.getCell(r, typeCol).dataValidation = {
      type: "list", allowBlank: false, formulae: ['"IN,OUT"'],
    };
  }

  ws.views = [{ state: "frozen", ySplit: 1 }];

  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `Biometric_Punches_${todayStamp()}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function ManualPunchImport() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const { token } = useAuth();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: devices } = useListBiometricDevices();
  const enabledDevices = (devices ?? []).filter((d) => d.isActive);
  const [selectedDeviceIds, setSelectedDeviceIds] = useState<(number | "env")[]>([]);
  const [rangeMode, setRangeMode] = useState<SyncBiometricMode>("all");
  const [includeAllEmployees, setIncludeAllEmployees] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadedRows, setDownloadedRows] = useState<PunchRow[] | null>(null);
  const [downloadSummary, setDownloadSummary] = useState<{ totalEmployees: number | null; employeesWithoutPunches: number } | null>(null);

  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [invalidTemplate, setInvalidTemplate] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);

  const allDevicesSelected = selectedDeviceIds.length === 0;

  const toggleDevice = (id: number | "env") => {
    setSelectedDeviceIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const handleDownload = async () => {
    setDownloading(true);
    setDownloadedRows(null);
    setDownloadSummary(null);
    try {
      const params = new URLSearchParams({ mode: rangeMode });
      selectedDeviceIds.forEach((id) => params.append("deviceId", String(id)));
      if (includeAllEmployees) params.set("includeAllEmployees", "1");
      const response = await fetch(`${window.location.origin}/api/attendance/manual-import/export?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not reach the biometric device.");
      const rows = body.rows as PunchRow[];
      setDownloadedRows(rows);
      setDownloadSummary({ totalEmployees: body.totalEmployees ?? null, employeesWithoutPunches: body.employeesWithoutPunches ?? 0 });
      await downloadPunchesAsExcel(rows);
      const punchRows = rows.filter((r) => r.kind === "punch");
      const unmatched = punchRows.filter((r) => !r.matched).length;
      toast({
        title: `${punchRows.length} punch${punchRows.length === 1 ? "" : "es"} downloaded`,
        description: unmatched > 0 ? `${unmatched} didn't match an employee — shown highlighted in the file.` : undefined,
      });
      if (body.deviceErrors?.length) {
        toast({ title: "Some devices could not be reached", description: body.deviceErrors.join("; "), variant: "destructive" });
      }
    } catch (err: any) {
      toast({ title: "Download failed", description: err.message, variant: "destructive" });
    } finally {
      setDownloading(false);
    }
  };

  const pickFile = (f: File | null) => {
    setFile(f);
    setResult(null);
    setInvalidTemplate(null);
  };

  const handleDrop = (e: React.DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    setDragActive(false);
    const dropped = e.dataTransfer.files?.[0];
    if (dropped) pickFile(dropped);
  };

  const handleUpload = async () => {
    if (!file) return;
    setUploading(true);
    setResult(null);
    setInvalidTemplate(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const response = await fetch(`${window.location.origin}/api/attendance/manual-import/upload`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
      const body = await response.json();
      if (!response.ok) {
        if (body.error === "invalid_template") {
          setInvalidTemplate(body.message);
        } else {
          throw new Error(body.message || body.error || "Import failed");
        }
        return;
      }
      setResult(body as ImportResult);
      if (body.created > 0) {
        toast({ title: `${body.created} punch${body.created === 1 ? "" : "es"} imported` });
      }
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (err: any) {
      toast({ title: "Import failed", description: err.message, variant: "destructive" });
    } finally {
      setUploading(false);
    }
  };

  return (
    <HrLayout>
      <div className="space-y-5 pb-8">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate("/hr/attendance")}>
            <ArrowLeft size={18} />
          </Button>
          <div>
            <h2 className="text-2xl font-black text-gray-900">Manual Punch Import</h2>
            <p className="text-muted-foreground text-sm">
              Backup path for when Sync Biometric misses punches — download the device's raw punch list,
              verify it, then import it back in.
            </p>
          </div>
        </div>

        <div className="rounded-lg border border-blue-100 bg-blue-50/60 p-3 flex items-start gap-2.5">
          <Info size={14} className="text-blue-600 shrink-0 mt-0.5" />
          <p className="text-xs text-blue-800">
            This is an additional, optional path — it never runs automatically and doesn't change how
            Sync Biometric works. Importing the same file twice is always safe: punches already recorded
            (from either path) are silently skipped, never duplicated.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
          {/* ── Step 1: Download ── */}
          <Card className="border-0 shadow-sm">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-full bg-cyan-600 text-white flex items-center justify-center text-xs font-black shrink-0">1</div>
                <CardTitle className="text-base font-bold text-gray-900">Download Punching Data</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <p className="text-xs font-bold uppercase tracking-wide text-gray-400 mb-2">Device</p>
                <div className="space-y-1 max-h-40 overflow-y-auto rounded-lg border border-gray-100 p-2">
                  <label className="w-full flex items-center gap-2 px-2 py-1.5 text-sm hover:bg-cyan-50 rounded-md cursor-pointer transition-colors">
                    <input type="checkbox" checked={allDevicesSelected} onChange={() => setSelectedDeviceIds([])} className="accent-cyan-600" />
                    <span className={allDevicesSelected ? "text-cyan-700 font-semibold" : "text-gray-700"}>All Devices</span>
                  </label>
                  {enabledDevices.map((d) => (
                    <label key={d.id} className="w-full flex items-center gap-2 px-2 py-1.5 text-sm hover:bg-cyan-50 rounded-md cursor-pointer transition-colors">
                      <input type="checkbox" checked={selectedDeviceIds.includes(d.id)} onChange={() => toggleDevice(d.id)} className="accent-cyan-600" />
                      <Fingerprint size={13} className="text-gray-400" />
                      <span className={selectedDeviceIds.includes(d.id) ? "text-cyan-700 font-semibold" : "text-gray-700"}>{d.name}</span>
                    </label>
                  ))}
                  {enabledDevices.length === 0 && (
                    <p className="px-2 py-1.5 text-xs text-amber-600">No enabled devices — add one in Settings.</p>
                  )}
                </div>
              </div>

              <div>
                <p className="text-xs font-bold uppercase tracking-wide text-gray-400 mb-2">Range</p>
                <PillTabs
                  items={RANGE_MODES.map((m) => ({ value: m.key, label: m.label }))}
                  value={rangeMode}
                  onChange={(v) => setRangeMode(v as SyncBiometricMode)}
                />
              </div>

              <label className="w-full flex items-start gap-2 px-2 py-1.5 text-sm hover:bg-cyan-50 rounded-md cursor-pointer transition-colors">
                <input
                  type="checkbox"
                  checked={includeAllEmployees}
                  onChange={(e) => setIncludeAllEmployees(e.target.checked)}
                  className="accent-cyan-600 mt-0.5"
                />
                <span>
                  <span className="text-gray-700 font-medium">Include every employee</span>
                  <span className="block text-xs text-muted-foreground">
                    Also list employees with zero punches in this range, so the file reflects your whole Employees table — not just who punched.
                  </span>
                </span>
              </label>

              <Button onClick={handleDownload} disabled={downloading} className="w-full gap-2">
                <Download size={15} /> {downloading ? "Connecting to device…" : "Download Punching Data"}
              </Button>

              {downloadedRows && downloadSummary && (
                <div className="rounded-xl border border-cyan-200 bg-cyan-50/60 p-3 text-xs text-cyan-800 space-y-1">
                  {(() => {
                    const punchRows = downloadedRows.filter((r) => r.kind === "punch");
                    return (
                      <div>
                        Downloaded {punchRows.length} punch{punchRows.length === 1 ? "" : "es"}
                        {" — "}{punchRows.filter((r) => r.matched).length} matched an employee,{" "}
                        {punchRows.filter((r) => !r.matched).length} did not (highlighted in the file).
                      </div>
                    );
                  })()}
                  {downloadSummary.totalEmployees != null && (
                    <div>
                      {downloadSummary.totalEmployees} employee{downloadSummary.totalEmployees === 1 ? "" : "s"} checked
                      {" — "}{downloadSummary.employeesWithoutPunches} had no punches in this range (also included, greyed out).
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* ── Step 2: Upload ── */}
          <Card className="border-0 shadow-sm overflow-hidden">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-full bg-cyan-600 text-white flex items-center justify-center text-xs font-black shrink-0">2</div>
                <CardTitle className="text-base font-bold text-gray-900">Upload &amp; Import</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                After reviewing the downloaded file — and fixing any blank Employee Code cells for
                unmatched rows — upload it here to import.
              </p>

              {file ? (
                <div className="rounded-xl border border-cyan-200 bg-cyan-50/60 p-4 flex items-center gap-3">
                  <div className="w-11 h-11 rounded-lg bg-cyan-600 flex items-center justify-center shrink-0">
                    <FileSpreadsheet size={20} className="text-white" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-gray-800 truncate">{file.name}</p>
                    <p className="text-xs text-cyan-700/70">{formatFileSize(file.size)} · Ready to upload</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => { pickFile(null); if (fileInputRef.current) fileInputRef.current.value = ""; }}
                    className="w-7 h-7 rounded-full bg-white border border-cyan-200 flex items-center justify-center text-cyan-700 hover:bg-cyan-100 transition-colors shrink-0"
                    aria-label="Remove selected file"
                  >
                    <X size={14} />
                  </button>
                </div>
              ) : (
                <label
                  htmlFor="punch-import-file"
                  onDragOver={(e) => { e.preventDefault(); setDragActive(true); }}
                  onDragLeave={() => setDragActive(false)}
                  onDrop={handleDrop}
                  className={`relative border-2 border-dashed transition-all rounded-xl p-7 flex flex-col items-center gap-2 text-center cursor-pointer block ${
                    dragActive ? "border-cyan-500 bg-cyan-50" : "border-gray-200 hover:border-cyan-400 bg-gray-50/50"
                  }`}
                >
                  <input
                    id="punch-import-file"
                    ref={fileInputRef}
                    type="file"
                    accept=".xlsx,.xls"
                    onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                  />
                  <div className={`w-12 h-12 rounded-full flex items-center justify-center transition-colors ${dragActive ? "bg-cyan-600" : "bg-cyan-600/10"}`}>
                    <UploadCloud size={22} className={dragActive ? "text-white" : "text-cyan-600"} />
                  </div>
                  <span className="text-sm font-semibold text-gray-700">
                    {dragActive ? "Drop the file here" : "Drag the reviewed Excel file here, or click to browse"}
                  </span>
                  <span className="text-xs text-muted-foreground">.xlsx or .xls, from Step 1's download</span>
                </label>
              )}

              <Button onClick={handleUpload} disabled={!file || uploading} className="w-full gap-2">
                <UploadCloud size={15} /> {uploading ? "Importing…" : "Upload & Import"}
              </Button>

              {invalidTemplate && (
                <div className="rounded-lg border border-red-200 bg-red-50 p-3 flex items-start gap-2.5">
                  <XCircle size={16} className="text-red-600 shrink-0 mt-0.5" />
                  <p className="text-sm text-red-700 font-medium">{invalidTemplate}</p>
                </div>
              )}

              {result && (
                <div className="rounded-xl border border-gray-100 overflow-hidden">
                  <div
                    className={`px-4 py-3 flex items-center gap-2.5 ${
                      result.created > 0 && result.errors.length === 0
                        ? "bg-green-50"
                        : result.created === 0
                        ? "bg-red-50"
                        : "bg-amber-50"
                    }`}
                  >
                    {result.created > 0 && result.errors.length === 0 ? (
                      <CheckCircle2 size={18} className="text-green-600 shrink-0" />
                    ) : result.created === 0 ? (
                      <XCircle size={18} className="text-red-600 shrink-0" />
                    ) : (
                      <AlertTriangle size={18} className="text-amber-600 shrink-0" />
                    )}
                    <p className="text-sm font-semibold text-gray-800">{result.message}</p>
                  </div>

                  <div className="grid grid-cols-2 gap-3 p-4">
                    <div className="rounded-xl border border-green-100 bg-green-50/50 p-4 flex items-center gap-3">
                      <div className="w-9 h-9 rounded-lg bg-green-600 flex items-center justify-center shrink-0">
                        <CheckCircle2 size={18} className="text-white" />
                      </div>
                      <div>
                        <p className="text-2xl font-black text-green-700 leading-none">{result.created}</p>
                        <p className="text-[11px] font-semibold text-green-700/70 uppercase tracking-wide mt-0.5">Imported</p>
                      </div>
                    </div>
                    <div className={`rounded-xl border p-4 flex items-center gap-3 ${result.skipped > 0 ? "border-gray-100 bg-gray-50/50" : "border-gray-100 bg-gray-50/50"}`}>
                      <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 bg-gray-400">
                        <XCircle size={18} className="text-white" />
                      </div>
                      <div>
                        <p className="text-2xl font-black leading-none text-gray-600">{result.skipped}</p>
                        <p className="text-[11px] font-semibold uppercase tracking-wide mt-0.5 text-gray-500">Skipped</p>
                      </div>
                    </div>
                  </div>

                  {result.errors.length > 0 && (
                    <div className="border-t border-gray-100 p-4 space-y-2 max-h-52 overflow-y-auto">
                      <p className="text-xs font-bold text-red-700 flex items-center gap-1.5"><XCircle size={12} /> Issues ({result.errors.length})</p>
                      {result.errors.map((e, i) => {
                        const sep = e.indexOf(":");
                        const rowLabel = sep === -1 ? "" : e.slice(0, sep).trim();
                        const message = sep === -1 ? e : e.slice(sep + 1).trim();
                        return (
                          <div key={i} className="flex items-start gap-2 rounded-lg bg-red-50/60 border border-red-100 px-3 py-2">
                            {rowLabel && (
                              <span className="shrink-0 text-[10px] font-black text-red-700 bg-red-100 rounded px-1.5 py-0.5 mt-0.5">{rowLabel}</span>
                            )}
                            <span className="text-xs text-red-700 leading-relaxed">{message}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {result.suspiciousDays.length > 0 && (
                    <div className="border-t border-gray-100 p-4 space-y-2 max-h-44 overflow-y-auto">
                      <p className="text-xs font-bold text-amber-700 flex items-center gap-1.5">
                        <AlertTriangle size={12} /> Possible shared Device IDs ({result.suspiciousDays.length})
                      </p>
                      {result.suspiciousDays.map((s, i) => (
                        <div key={i} className="rounded-lg bg-amber-50/60 border border-amber-100 px-3 py-2 text-xs text-amber-700">
                          {s.employeeName} logged {s.punches} punches on {s.date} — likely two people sharing one Device User ID.
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <Card className="border-0 shadow-sm">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <ListChecks size={16} className="text-cyan-700" />
              <CardTitle className="text-base font-bold text-gray-900">How This Works</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <ol className="grid sm:grid-cols-2 gap-3 text-sm">
              {[
                "Pick a device (or All Devices) and a range, then download — this reads the device directly, the same way Sync Biometric does, but doesn't save anything yet.",
                "Punches are matched by Employee Code only — the code enrolled on the device must be the Employee Code. Amber rows didn't match any active employee; type the correct Employee Code into that cell.",
                "Check \"Include every employee\" to also see who has zero punches in the range — those rows (grey) are for visibility only and are skipped automatically if you re-upload the file as-is.",
                "Import is always safe to re-run: a punch already on file (from a live sync or an earlier import) is silently skipped, never duplicated.",
                "This never touches Sync Biometric's own schedule or settings — it's a separate, manual path you use only when you choose to.",
              ].map((step, i) => (
                <li key={i} className="flex gap-2.5">
                  <span className="w-5 h-5 rounded-full bg-cyan-50 text-cyan-700 text-[11px] font-black flex items-center justify-center shrink-0 mt-0.5">{i + 1}</span>
                  <span className="text-gray-600">{step}</span>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      </div>
    </HrLayout>
  );
}

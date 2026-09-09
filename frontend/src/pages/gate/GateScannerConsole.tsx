import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { AnimatePresence, motion } from "framer-motion";
import ExcelJS from "exceljs";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Pagination, PaginationContent, PaginationItem, PaginationLink,
  PaginationNext, PaginationPrevious,
} from "@/components/ui/pagination";
import { useToast } from "@/hooks/use-toast";
import { customFetch, ApiError } from "@/lib/api-client/custom-fetch";
import {
  ShieldCheck, LogOut, ScanLine, CheckCircle2, XCircle, Clock,
  AlertTriangle, MapPin, Building2, History, DoorOpen, UserCheck,
  Usb, FileSpreadsheet,
} from "lucide-react";

/**
 * The gate kiosk's scanning screen -a two-pane console built for an operator
 * standing at the gate, not a dashboard someone browses:
 *
 *   Left  -Today's Gate-Out Report: every successful exit this gate has
 *          recorded today, newest first, paginated the same way the rest of
 *          the app paginates a records table.
 *   Right -top: the scanner itself (animated ready/scanned/rejected state +
 *          spoken feedback); bottom: the most recent scan's full detail,
 *          which stays on screen until the operator dismisses it or scans
 *          the next code.
 *
 * Input is a connected QR scanner in HID keyboard-wedge mode (see
 * useWedgeScanner below) -no camera. Voice feedback uses the browser's
 * built-in Web Speech API. Excel export uses ExcelJS, already a dependency
 * (see AttendanceReportLog.tsx for the same pattern).
 */

type ScanResult = {
  result: "success" | "already_scanned" | "expired" | "not_approved" | "invalid_qr";
  message: string;
  employee?: { name: string; employeeCode: string; department: string | null; photoUrl: string | null };
  destination?: string;
  reason?: string;
  approvedBy?: string | null;
  approverRole?: string | null;
  approvedAt?: string | null;
  expiresAt?: string | null;
  gateName?: string | null;
  exitedAt?: string | null;
};

type GateLogEntry = {
  id: number;
  employeeName: string;
  employeeCode: string | null;
  department: string | null;
  photoUrl: string | null;
  destination: string | null;
  reason: string | null;
  approvedBy: string | null;
  approverRole: string | null;
  exitedAt: string;
};

type PaginatedLog = { items: GateLogEntry[]; total: number; page: number; pageSize: number };

// "hr" -> just "HR"; "dept_head" -> "HOD – <name>", the name fetched from
// OutpassRequest.approved_by (see gate_scanner_views.py), never hardcoded;
// "system" is an On-Duty session's auto-approval (geo_attendance_views.py::
// _create_outpass_from_on_duty), mirrored from the same label used on the
// employee-facing Outpass cards and the HR Outpass page.
function formatApprover(approverRole?: string | null, approvedBy?: string | null): string | null {
  if (approverRole === "hr") return "HR";
  if (approverRole === "dept_head") return approvedBy ? `HOD – ${approvedBy}` : "HOD";
  if (approverRole === "system") return "On-Duty approval";
  return approvedBy ?? null;
}

type FlashPhase = "idle" | "success" | "error";

// Scanner keystrokes land within a couple of ms of each other; anything
// slower than this gap is treated as a fresh (human) keypress, not a
// continuation of a scan.
const WEDGE_RESET_GAP_MS = 50;
// A real qrToken is a signed JWT, always well over this.
const MIN_SCAN_LENGTH = 12;
// How long the scanner card shows its transient "Scanned"/"Rejected" flash
// before settling back to Ready -the persistent detail panel below is
// unaffected by this timer.
const FLASH_DURATION_MS = 1800;
// A physical scanner can occasionally fire twice for one pass; ignore an
// identical read that arrives again inside this window rather than treating
// it as the guard scanning the same person again on purpose.
const DUPLICATE_GUARD_MS = 2000;
// Rows per page in the report table -matches the app's usual list density
// (e.g. OutpassVisitors.tsx's records tables use 20; a single gate's daily
// volume is small enough that 10 keeps the table comfortably filled without
// needing to scroll on most days).
const LOG_PAGE_SIZE = 10;
// Batch size when paging through everything for an export -the API caps
// pageSize at 100 (outpass_visitor_views.py::MAX_PAGE_SIZE).
const EXPORT_BATCH_SIZE = 100;

const RESULT_TONE: Record<ScanResult["result"], { cls: string; icon: typeof CheckCircle2 }> = {
  success: { cls: "bg-green-50 border-green-300 text-green-800", icon: CheckCircle2 },
  already_scanned: { cls: "bg-amber-50 border-amber-300 text-amber-800", icon: AlertTriangle },
  expired: { cls: "bg-amber-50 border-amber-300 text-amber-800", icon: Clock },
  not_approved: { cls: "bg-red-50 border-red-300 text-red-800", icon: XCircle },
  invalid_qr: { cls: "bg-gray-100 border-gray-300 text-gray-700", icon: XCircle },
};

function fmtTime(iso?: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

function fmtClock(iso: string) {
  return new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
}

const VOICE_LANG = "en-IN";
const VOICE_APPROVED = "Approved. You may proceed.";
const VOICE_NOT_APPROVED = "This outpass is not approved. Please get it approved first.";

// Voices load asynchronously in most browsers (empty on the very first call
// until the "voiceschanged" event fires) -wait for that once rather than
// racing it, so the matching voice below is actually in the list by the time
// we look for it instead of only being found starting from the second scan.
function getVoices(): Promise<SpeechSynthesisVoice[]> {
  return new Promise((resolve) => {
    const existing = window.speechSynthesis.getVoices();
    if (existing.length > 0) return resolve(existing);
    const onChange = () => {
      window.speechSynthesis.removeEventListener("voiceschanged", onChange);
      resolve(window.speechSynthesis.getVoices());
    };
    window.speechSynthesis.addEventListener("voiceschanged", onChange);
    // Some browsers never fire voiceschanged when there's genuinely nothing
    // to load -don't hang the whole scan flow waiting on it.
    setTimeout(() => resolve(window.speechSynthesis.getVoices()), 500);
  });
}

async function speak(text: string) {
  try {
    if (!("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = VOICE_LANG;
    utter.rate = 0.95;
    utter.pitch = 1;
    const voices = await getVoices();
    const match =
      voices.find((v) => v.lang === VOICE_LANG) ??
      voices.find((v) => v.lang?.toLowerCase().startsWith("en"));
    if (match) utter.voice = match;
    window.speechSynthesis.speak(utter);
  } catch {
    // Speech isn't available in every kiosk environment -the visual/voice
    // feedback is an enhancement, never the only signal.
  }
}

/** The connected scanner IS this listener -a document-level keydown capture
 *  that buffers a fast keystroke burst and flushes on Enter. Always armed:
 *  a new scan mid-review simply calls onScan again and replaces whatever the
 *  operator was looking at, per how a gate actually operates. */
function useWedgeScanner(onScan: (raw: string) => void) {
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;

  useEffect(() => {
    let buffer = "";
    let lastCharAt = 0;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        const value = buffer.trim();
        buffer = "";
        lastCharAt = 0;
        if (value.length >= MIN_SCAN_LENGTH) {
          e.preventDefault();
          onScanRef.current(value);
        }
        return;
      }

      const now = Date.now();
      if (now - lastCharAt > WEDGE_RESET_GAP_MS) buffer = "";
      lastCharAt = now;
      if (e.key.length === 1) buffer += e.key;
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

function gateAuthHeader(): HeadersInit | undefined {
  const token = localStorage.getItem("gate_device_token");
  return token ? { Authorization: `Bearer ${token}` } : undefined;
}

// ── Scanner connection status ────────────────────────────────────────────
// A keyboard-wedge scanner sends keystrokes indistinguishable from someone
// typing, so there is no page-level signal that proves one is attached
// *before* it's used. WebHID is the closest real API for this -it can see
// a paired device's presence/connect/disconnect -but Chrome deliberately
// blocks WebHID from ever listing a device that identifies as a standard
// keyboard, precisely to stop pages from being able to fingerprint/snoop
// keyboards. Many wedge scanners (including ones that work perfectly for
// scanning) present as exactly that, so "Connect Scanner" below may show no
// device to pick even while scanning works fine -this reports what the
// browser can actually see, not a guess layered on top of it.
type ScannerStatus = "checking" | "connected" | "disconnected" | "unsupported";

function useScannerConnection() {
  const [status, setStatus] = useState<ScannerStatus>("checking");
  const supported = typeof navigator !== "undefined" && "hid" in navigator;

  const refresh = useCallback(async () => {
    if (!supported) { setStatus("unsupported"); return; }
    try {
      const devices = await (navigator as any).hid.getDevices();
      setStatus(devices.length > 0 ? "connected" : "disconnected");
    } catch {
      setStatus("disconnected");
    }
  }, [supported]);

  useEffect(() => {
    refresh();
    if (!supported) return;
    const hid = (navigator as any).hid;
    hid.addEventListener("connect", refresh);
    hid.addEventListener("disconnect", refresh);
    return () => {
      hid.removeEventListener("connect", refresh);
      hid.removeEventListener("disconnect", refresh);
    };
  }, [supported, refresh]);

  const requestConnect = useCallback(async () => {
    if (!supported) return;
    try {
      const picked: unknown[] = await (navigator as any).hid.requestDevice({ filters: [] });
      if (picked.length > 0) setStatus("connected");
    } catch {
      // User cancelled the picker, or the browser blocked every candidate
      // device -leave status as-is either way.
    }
  }, [supported]);

  return { status, supported, requestConnect };
}

function ScannerStatusBadge({ scanner }: { scanner: ReturnType<typeof useScannerConnection> }) {
  if (scanner.status === "connected") {
    return (
      <span className="flex items-center gap-1.5 rounded-full border border-green-200 bg-green-50 px-3 py-1 text-xs font-semibold text-green-700">
        <Usb size={13} /> Scanner Connected
      </span>
    );
  }
  if (scanner.status === "disconnected") {
    return (
      <button
        type="button"
        onClick={scanner.requestConnect}
        className="flex items-center gap-1.5 rounded-full border border-red-200 bg-red-50 px-3 py-1 text-xs font-semibold text-red-700 hover:bg-red-100"
        title="Click to pair a scanner over WebHID (may not list a scanner that identifies as a keyboard -it will still work for scanning either way)"
      >
        <Usb size={13} /> No Scanners Connected
      </button>
    );
  }
  // "unsupported" (browser has no WebHID) or "checking" -we genuinely can't
  // tell either way, so say the neutral thing rather than a false negative.
  return (
    <span className="flex items-center gap-1.5 rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-700">
      <ScanLine size={13} /> Scanner Ready
    </span>
  );
}

// ── Scanner card ─────────────────────────────────────────────────────────

function ScannerCard({ flash }: { flash: FlashPhase }) {
  const tone =
    flash === "success" ? { bg: "bg-green-600", icon: CheckCircle2, label: "Scanned Successfully" }
    : flash === "error" ? { bg: "bg-red-600", icon: XCircle, label: "Not Approved" }
    : { bg: "bg-slate-900", icon: ScanLine, label: "Ready" };
  const Icon = tone.icon;

  return (
    <div
      className={`relative flex aspect-[4/3] w-full flex-col items-center justify-center gap-3 overflow-hidden rounded-2xl border px-8 text-center transition-colors duration-500 ${tone.bg}`}
    >
      <AnimatePresence mode="wait">
        <motion.div
          key={flash}
          initial={{ scale: 0.6, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.7, opacity: 0 }}
          transition={{ type: "spring", stiffness: 340, damping: 22 }}
        >
          <Icon size={60} className={`text-white ${flash === "idle" ? "animate-pulse" : ""}`} />
        </motion.div>
      </AnimatePresence>
      <motion.p
        key={`${flash}-label`}
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        className="text-base font-bold text-white"
      >
        {flash === "idle" ? "Ready -scan an employee's Outpass QR code" : tone.label}
      </motion.p>
      {flash === "idle" && (
        <p className="text-xs text-white/50">Point the connected scanner at the QR code on the employee's card.</p>
      )}
    </div>
  );
}

// ── Persistent scan detail ───────────────────────────────────────────────

function ScanDetailPanel({ result, onDone }: { result: ScanResult | null; onDone: () => void }) {
  if (!result) {
    return (
      <Card className="flex-1 border-dashed">
        <CardContent className="flex h-full flex-col items-center justify-center gap-2 py-10 text-center text-muted-foreground">
          <ScanLine size={22} className="opacity-40" />
          <p className="text-sm">Scan results will appear here.</p>
        </CardContent>
      </Card>
    );
  }

  const tone = RESULT_TONE[result.result];
  const ToneIcon = tone.icon;

  return (
    <Card className={`flex-1 border-2 ${tone.cls}`}>
      <CardContent className="flex h-full flex-col gap-3 py-4">
        <div className="flex items-center gap-2">
          <ToneIcon size={22} className="shrink-0" />
          <p className="font-bold">{result.message}</p>
        </div>

        {result.employee && (
          <div className="flex items-center gap-3">
            <Avatar className="size-14 border-2 border-white">
              <AvatarImage src={result.employee.photoUrl ?? undefined} />
              <AvatarFallback>{result.employee.name[0]}</AvatarFallback>
            </Avatar>
            <div>
              <p className="font-semibold">{result.employee.name}</p>
              <p className="text-xs opacity-80">
                {result.employee.employeeCode}
                {result.employee.department && ` · ${result.employee.department}`}
              </p>
            </div>
          </div>
        )}

        {(result.destination || result.reason) && (
          <div className="grid grid-cols-2 gap-3 text-xs">
            {result.destination && (
              <div>
                <p className="mb-0.5 flex items-center gap-1 font-semibold uppercase tracking-wide opacity-70"><MapPin size={11} /> Where</p>
                <p className="font-medium">{result.destination}</p>
              </div>
            )}
            {result.reason && (
              <div>
                <p className="mb-0.5 flex items-center gap-1 font-semibold uppercase tracking-wide opacity-70"><Building2 size={11} /> Reason</p>
                <p className="font-medium">{result.reason}</p>
              </div>
            )}
            {formatApprover(result.approverRole, result.approvedBy) && (
              <div>
                <p className="mb-0.5 flex items-center gap-1 font-semibold uppercase tracking-wide opacity-70"><UserCheck size={11} /> Approved By</p>
                <p className="font-medium">{formatApprover(result.approverRole, result.approvedBy)}</p>
              </div>
            )}
            {result.expiresAt && (
              <div>
                <p className="mb-0.5 font-semibold uppercase tracking-wide opacity-70">Expires</p>
                <p className="font-medium">{fmtTime(result.expiresAt)}</p>
              </div>
            )}
            {result.exitedAt && (
              <div>
                <p className="mb-0.5 font-semibold uppercase tracking-wide opacity-70">Exited</p>
                <p className="font-medium">{fmtTime(result.exitedAt)}</p>
              </div>
            )}
          </div>
        )}

        <Button variant="outline" size="sm" className="mt-auto self-start gap-1.5" onClick={onDone}>
          Done
        </Button>
      </CardContent>
    </Card>
  );
}

// ── Pagination footer -same component/behaviour as OutpassVisitors.tsx's
//    RecordsPagination, so this table paginates exactly like every other
//    records table in the app ──────────────────────────────────────────────

function RecordsPagination({
  page, total, pageSize, onPageChange,
}: {
  page: number;
  total: number;
  pageSize: number;
  onPageChange: (page: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const pageSafe = Math.min(page, totalPages);
  if (totalPages <= 1) return null;

  return (
    <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between border-t">
      <p className="text-xs text-muted-foreground">
        Showing {(pageSafe - 1) * pageSize + 1}–{Math.min(pageSafe * pageSize, total)} of {total}
      </p>
      <Pagination className="mx-0 w-auto">
        <PaginationContent>
          <PaginationItem>
            <PaginationPrevious
              href="#"
              className={pageSafe === 1 ? "pointer-events-none opacity-50" : undefined}
              onClick={(e) => { e.preventDefault(); if (pageSafe > 1) onPageChange(pageSafe - 1); }}
            />
          </PaginationItem>
          {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
            <PaginationItem key={p}>
              <PaginationLink href="#" isActive={p === pageSafe} onClick={(e) => { e.preventDefault(); onPageChange(p); }}>
                {p}
              </PaginationLink>
            </PaginationItem>
          ))}
          <PaginationItem>
            <PaginationNext
              href="#"
              className={pageSafe === totalPages ? "pointer-events-none opacity-50" : undefined}
              onClick={(e) => { e.preventDefault(); if (pageSafe < totalPages) onPageChange(pageSafe + 1); }}
            />
          </PaginationItem>
        </PaginationContent>
      </Pagination>
    </div>
  );
}

// ── Today's Gate-Out Report ──────────────────────────────────────────────

function GateOutReport({
  rows, total, page, pageSize, loading, onPageChange,
}: {
  rows: GateLogEntry[];
  total: number;
  page: number;
  pageSize: number;
  loading: boolean;
  onPageChange: (page: number) => void;
}) {
  return (
    <Card className="flex h-full flex-col">
      <CardContent className="flex h-full flex-col p-0">
        <div className="flex items-center gap-2 px-4 pt-4 pb-3">
          <History size={16} className="text-primary" />
          <p className="font-bold">Today's Gate-Out Report</p>
          <span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-xs font-semibold text-muted-foreground">
            {total}
          </span>
        </div>

        {loading && rows.length === 0 ? (
          <p className="flex-1 py-10 text-center text-sm text-muted-foreground">Loading…</p>
        ) : rows.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 py-10 text-center text-muted-foreground">
            <DoorOpen size={22} className="opacity-40" />
            <p className="text-sm">No exits recorded through this gate yet today.</p>
          </div>
        ) : (
          <div className="flex-1 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Employee</TableHead>
                  <TableHead>Department</TableHead>
                  <TableHead>Destination</TableHead>
                  <TableHead>Approved By</TableHead>
                  <TableHead className="text-right">Exit Time</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>
                      <div className="flex items-center gap-2.5">
                        <Avatar className="size-9 shrink-0">
                          <AvatarImage src={r.photoUrl ?? undefined} />
                          <AvatarFallback className="text-xs">{r.employeeName[0]}</AvatarFallback>
                        </Avatar>
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold">{r.employeeName}</p>
                          <p className="text-xs text-muted-foreground">{r.employeeCode ?? "—"}</p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{r.department ?? "—"}</TableCell>
                    <TableCell className="max-w-[180px] truncate" title={r.destination ?? undefined}>{r.destination ?? "—"}</TableCell>
                    <TableCell>
                      <span className="inline-flex items-center gap-1 text-muted-foreground">
                        <UserCheck size={12} /> {formatApprover(r.approverRole, r.approvedBy) ?? "—"}
                      </span>
                    </TableCell>
                    <TableCell className="text-right font-semibold tabular-nums text-muted-foreground">{fmtClock(r.exitedAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        <RecordsPagination page={page} total={total} pageSize={pageSize} onPageChange={onPageChange} />
      </CardContent>
    </Card>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────

export default function GateScannerConsole() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [gateName] = useState(() => localStorage.getItem("gate_device_name") ?? "Gate Scanner");
  const [flash, setFlash] = useState<FlashPhase>("idle");
  const [lastResult, setLastResult] = useState<ScanResult | null>(null);
  const [log, setLog] = useState<GateLogEntry[]>([]);
  const [logTotal, setLogTotal] = useState(0);
  const [logLoading, setLogLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [exporting, setExporting] = useState(false);
  const scanner = useScannerConnection();

  const pageRef = useRef(1);
  pageRef.current = page;
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRawRef = useRef<{ value: string; at: number }>({ value: "", at: 0 });

  useEffect(() => {
    if (!localStorage.getItem("gate_device_token")) navigate("/");
  }, [navigate]);

  const logout = () => {
    localStorage.removeItem("gate_device_token");
    localStorage.removeItem("gate_device_id");
    localStorage.removeItem("gate_device_name");
    navigate("/");
  };

  const fetchLog = useCallback(async () => {
    try {
      const res = await customFetch<PaginatedLog>(
        `/api/gate-devices/scan-log?page=${pageRef.current}&pageSize=${LOG_PAGE_SIZE}`,
        { headers: gateAuthHeader() },
      );
      setLog(res.items);
      setLogTotal(res.total);
    } catch {
      // Best-effort -the console still works for scanning if this fails.
    } finally {
      setLogLoading(false);
    }
  }, []);

  useEffect(() => {
    setLogLoading(true);
    fetchLog();
  }, [page, fetchLog]);

  useEffect(() => {
    const id = setInterval(fetchLog, 20_000);
    return () => clearInterval(id);
  }, [fetchLog]);

  const handleScan = useCallback(async (raw: string) => {
    const now = Date.now();
    if (raw === lastRawRef.current.value && now - lastRawRef.current.at < DUPLICATE_GUARD_MS) return;
    lastRawRef.current = { value: raw, at: now };

    const token = localStorage.getItem("gate_device_token");
    if (!token) {
      navigate("/");
      return;
    }

    let body: ScanResult;
    try {
      body = await customFetch<ScanResult>("/api/gate-devices/scan", {
        method: "POST",
        body: JSON.stringify({ qrToken: raw }),
        headers: gateAuthHeader(),
      });
    } catch (err) {
      body = err instanceof ApiError && err.data
        ? (err.data as ScanResult)
        : { result: "invalid_qr", message: "Could not reach the server -please try again." };
    }

    setLastResult(body);
    const ok = body.result === "success";
    setFlash(ok ? "success" : "error");
    speak(ok ? VOICE_APPROVED : VOICE_NOT_APPROVED);
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => setFlash("idle"), FLASH_DURATION_MS);
    if (ok) {
      // A fresh exit belongs on page 1 (newest-first) -jump back there so it's
      // immediately visible instead of only bumping a total the operator
      // can't see from wherever they were paged to.
      pageRef.current = 1;
      setPage(1);
      fetchLog();
    }
  }, [fetchLog, navigate]);

  useWedgeScanner(handleScan);

  useEffect(() => () => { if (flashTimerRef.current) clearTimeout(flashTimerRef.current); }, []);

  const exportExcel = useCallback(async () => {
    setExporting(true);
    try {
      const all: GateLogEntry[] = [];
      let batchPage = 1;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const res = await customFetch<PaginatedLog>(
          `/api/gate-devices/scan-log?page=${batchPage}&pageSize=${EXPORT_BATCH_SIZE}`,
          { headers: gateAuthHeader() },
        );
        all.push(...res.items);
        if (all.length >= res.total || res.items.length === 0) break;
        batchPage += 1;
      }

      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("Gate-Out Report");
      ws.columns = [
        { header: "Employee", key: "employeeName", width: 26 },
        { header: "Code", key: "employeeCode", width: 14 },
        { header: "Department", key: "department", width: 20 },
        { header: "Destination", key: "destination", width: 24 },
        { header: "Reason", key: "reason", width: 30 },
        { header: "Approved By", key: "approvedBy", width: 24 },
        { header: "Exit Time", key: "exitedAt", width: 20 },
      ];
      ws.getRow(1).font = { bold: true };
      ws.getRow(1).eachCell((c) => { c.border = { bottom: { style: "thin" } }; });

      all.forEach((r) => {
        ws.addRow({
          employeeName: r.employeeName,
          employeeCode: r.employeeCode ?? "—",
          department: r.department ?? "—",
          destination: r.destination ?? "—",
          reason: r.reason ?? "—",
          approvedBy: formatApprover(r.approverRole, r.approvedBy) ?? "—",
          exitedAt: new Date(r.exitedAt).toLocaleString("en-IN"),
        });
      });

      const buffer = await wb.xlsx.writeBuffer();
      const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${gateName.replace(/[^a-z0-9]+/gi, "_")}_gate_out_${new Date().toISOString().slice(0, 10)}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
      toast({ title: "Exported", description: `${all.length} record${all.length === 1 ? "" : "s"} exported.` });
    } catch {
      toast({ title: "Export failed", description: "Could not export the report. Please try again.", variant: "destructive" });
    } finally {
      setExporting(false);
    }
  }, [gateName, toast]);

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b px-5 py-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="text-accent" size={20} />
          <span className="font-black text-lg">{gateName}</span>
        </div>
        <div className="flex items-center gap-3">
          <ScannerStatusBadge scanner={scanner} />
          <Button variant="outline" size="sm" className="gap-1.5" onClick={exportExcel} disabled={exporting}>
            <FileSpreadsheet size={14} /> {exporting ? "Exporting…" : "Export Data"}
          </Button>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={logout}>
            <LogOut size={14} /> Logout
          </Button>
        </div>
      </header>

      <main className="grid flex-1 grid-cols-1 gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_420px]">
        <section className="order-2 min-h-[420px] lg:order-1">
          <GateOutReport
            rows={log}
            total={logTotal}
            page={page}
            pageSize={LOG_PAGE_SIZE}
            loading={logLoading}
            onPageChange={setPage}
          />
        </section>

        <section className="order-1 flex flex-col gap-4 lg:order-2">
          <ScannerCard flash={flash} />
          <ScanDetailPanel result={lastResult} onDone={() => setLastResult(null)} />
        </section>
      </main>
    </div>
  );
}

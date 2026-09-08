import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { customFetch, ApiError } from "@/lib/api-client/custom-fetch";
import {
  ShieldCheck, LogOut, ScanLine, CheckCircle2, XCircle, Clock,
  AlertTriangle, MapPin, Building2,
} from "lucide-react";

/**
 * The gate kiosk's scanning screen. Reads from a connected QR scanner (a
 * Zebra hands-free unit, or any similar device) in HID keyboard-wedge mode —
 * the scanner types the decoded value as fast keystrokes followed by Enter,
 * indistinguishable at the hardware level from someone typing very quickly.
 * A document-level keydown listener buffers characters and flushes on
 * Enter, resetting the buffer whenever the gap between keystrokes is too
 * large to be the scanner (i.e. an actual human typing). No camera is used —
 * the physical scanner is the only input device.
 */

type ScanResult = {
  result: "success" | "already_scanned" | "expired" | "not_approved" | "invalid_qr";
  message: string;
  employee?: { name: string; employeeCode: string; department: string | null; photoUrl: string | null };
  destination?: string;
  reason?: string;
  approvedAt?: string | null;
  expiresAt?: string | null;
  gateName?: string | null;
  exitedAt?: string | null;
};

// Scanner keystrokes land within a couple of ms of each other; anything
// slower than this gap is treated as a fresh (human) keypress, not a
// continuation of a scan -so stray typing elsewhere on the page can never
// accumulate into a bogus "scan".
const WEDGE_RESET_GAP_MS = 50;
// A real qrToken is a signed JWT, always well over this -guards against a
// stray Enter keypress with little/no buffered text being treated as a scan.
const MIN_SCAN_LENGTH = 12;

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

export default function GateScannerConsole() {
  const [, navigate] = useLocation();
  const [gateName] = useState(() => localStorage.getItem("gate_device_name") ?? "Gate Scanner");
  const [lastResult, setLastResult] = useState<ScanResult | null>(null);

  const scanningRef = useRef(true);
  const handleDecodedRef = useRef<(raw: string) => void>(() => {});

  useEffect(() => {
    if (!localStorage.getItem("gate_device_token")) navigate("/");
  }, [navigate]);

  const logout = () => {
    localStorage.removeItem("gate_device_token");
    localStorage.removeItem("gate_device_id");
    localStorage.removeItem("gate_device_name");
    navigate("/");
  };

  const handleDecoded = async (raw: string) => {
    if (!scanningRef.current) return;
    scanningRef.current = false;

    const token = localStorage.getItem("gate_device_token");
    if (!token) {
      setLastResult({ result: "invalid_qr", message: "Not logged in -please sign in again." });
      return;
    }
    try {
      const body = await customFetch<ScanResult>("/api/gate-devices/scan", {
        method: "POST",
        body: JSON.stringify({ qrToken: raw }),
        headers: { Authorization: `Bearer ${token}` },
      });
      setLastResult(body);
    } catch (err) {
      if (err instanceof ApiError && err.data) {
        setLastResult(err.data as ScanResult);
      } else {
        setLastResult({ result: "invalid_qr", message: "Could not reach the server -please try again." });
      }
    }
  };
  handleDecodedRef.current = handleDecoded;

  const resumeScanning = () => {
    setLastResult(null);
    scanningRef.current = true;
  };

  // Auto-resume a few seconds after any result so the kiosk keeps working
  // unattended, but give the guard time to actually read it first.
  useEffect(() => {
    if (!lastResult) return;
    const t = setTimeout(resumeScanning, 4500);
    return () => clearTimeout(t);
  }, [lastResult]);

  // ── Keyboard-wedge capture -the connected QR scanner IS this input ──────
  useEffect(() => {
    let buffer = "";
    let lastCharAt = 0;

    const onKeyDown = (e: KeyboardEvent) => {
      if (!scanningRef.current) return;

      // Enter always flushes whatever is currently buffered, regardless of
      // timing -a real scanner's own trailing Enter arrives inside the same
      // tight burst as the rest of the code, so this never fires "too late"
      // in practice; it just must not be gated behind the same gap check
      // that guards against buffering stray human keystrokes below.
      if (e.key === "Enter") {
        const value = buffer.trim();
        buffer = "";
        lastCharAt = 0;
        if (value.length >= MIN_SCAN_LENGTH) {
          e.preventDefault();
          handleDecodedRef.current(value);
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

  const tone = lastResult ? RESULT_TONE[lastResult.result] : null;
  const ToneIcon = tone?.icon;
  const ready = !lastResult;

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="flex items-center justify-between border-b px-5 py-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="text-accent" size={20} />
          <span className="font-black text-lg">{gateName}</span>
        </div>
        <div className="flex items-center gap-3">
          <span className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold ${
            ready ? "bg-green-50 text-green-700 border-green-200" : "bg-amber-50 text-amber-700 border-amber-200"
          }`}>
            <ScanLine size={13} />
            {ready ? "Scanner Ready" : "Processing…"}
          </span>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={logout}>
            <LogOut size={14} /> Logout
          </Button>
        </div>
      </header>

      <main className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-md">
          <div className="relative aspect-square w-full overflow-hidden rounded-2xl border bg-slate-900 flex flex-col items-center justify-center gap-4 px-8 text-center">
            <ScanLine size={64} className={`text-white/80 ${ready ? "animate-pulse" : ""}`} />
            <p className="text-sm font-semibold text-white">
              {ready ? "Ready -scan an employee's Outpass QR code" : "Reading scan…"}
            </p>
            <p className="text-xs text-white/50">Point the connected scanner at the QR code on the employee's card.</p>
          </div>

          {lastResult && tone && ToneIcon && (
            <Card className={`mt-4 border-2 ${tone.cls}`}>
              <CardContent className="flex flex-col gap-3 py-4">
                <div className="flex items-center gap-2">
                  <ToneIcon size={22} />
                  <p className="font-bold">{lastResult.message}</p>
                </div>
                {lastResult.employee && (
                  <div className="flex items-center gap-3">
                    <Avatar className="size-12 border-2 border-white">
                      <AvatarImage src={lastResult.employee.photoUrl ?? undefined} />
                      <AvatarFallback>{lastResult.employee.name[0]}</AvatarFallback>
                    </Avatar>
                    <div>
                      <p className="font-semibold">{lastResult.employee.name}</p>
                      <p className="text-xs opacity-80">
                        {lastResult.employee.employeeCode}
                        {lastResult.employee.department && ` · ${lastResult.employee.department}`}
                      </p>
                    </div>
                  </div>
                )}
                {lastResult.destination && (
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="flex items-center gap-1"><MapPin size={12} /> {lastResult.destination}</div>
                    {lastResult.reason && <div className="flex items-center gap-1"><Building2 size={12} /> {lastResult.reason}</div>}
                    {lastResult.expiresAt && <div>Expires: {fmtTime(lastResult.expiresAt)}</div>}
                    {lastResult.exitedAt && <div>Exited: {fmtTime(lastResult.exitedAt)}</div>}
                  </div>
                )}
                <Button variant="outline" size="sm" onClick={resumeScanning}>Scan Next</Button>
              </CardContent>
            </Card>
          )}
        </div>
      </main>
    </div>
  );
}

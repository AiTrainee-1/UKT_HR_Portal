// How the gate monitor shows and says each scan answer. Every lookup has a fallback: an answer this console does not know
// (a new server result, an error body without `result`) is shown as "Check with HR" instead of crashing the page (the old
// console read RESULT_TONE[result].cls and fell over on an expired session's error body).

import type { GateScanResult } from "@/lib/api-client/custom-hooks/gate-monitor";

/** teal = let through, amber = a tea break, rose = stopped, slate = nothing decided (not recognised, no connection). */
export type ScanTone = "teal" | "amber" | "rose" | "slate";

export type ScanView = {
  tone: ScanTone;
  /** The banner's big line: "Allowed - exit recorded". */
  title: string;
  /** Exit / Return / Tea break out / Tea break in / Tea break, or null when the code named nothing. */
  kindLabel: string | null;
  /** What the voice says. */
  voice: string;
  allowed: boolean;
};

/** The console's own answer when the scan never reached the server. */
export const OFFLINE_RESULT: GateScanResult = {
  result: "offline",
  message: "Could not reach the server. Check the connection, then scan again.",
};

const DENIED: Record<string, { title: string; voice: string; tone?: ScanTone }> = {
  already_scanned: { title: "Denied - pass already used", voice: "This pass was already used." },
  expired: { title: "Denied - pass expired", voice: "This pass has expired." },
  not_approved: { title: "Denied - not approved", voice: "This pass is not approved. Please get it approved first." },
  not_exited: { title: "Denied - has not gone out yet", voice: "This employee has not gone out yet." },
  not_allowed_here: { title: "Denied - not taken at this gate", voice: "This gate does not take this pass." },
  invalid_qr: { title: "Code not recognised", voice: "Code not recognised. Please scan again.", tone: "slate" },
  offline: { title: "No connection", voice: "No connection. Please try again.", tone: "slate" },
};

/** A tea-break code at a gate set not to take tea breaks (the server answers not_allowed_here with kind tea_break). */
const TEA_NOT_HERE: { title: string; voice: string; tone?: ScanTone } = {
  title: "Denied - no tea breaks at this gate",
  voice: "This gate does not take tea-break scans.",
};

const UNKNOWN = { title: "Check with HR", voice: "Please check with HR.", tone: "slate" as ScanTone };

export function kindLabel(r: Pick<GateScanResult, "scanType" | "action" | "kind">): string | null {
  if (r.action === "out") return "Tea break out";
  if (r.action === "in") return "Tea break in";
  if (r.kind === "tea_break") return "Tea break";
  if (r.scanType === "entry") return "Return";
  if (r.scanType === "exit") return "Exit";
  return null;
}

export function describeScan(r: GateScanResult | null | undefined): ScanView {
  const result = typeof r?.result === "string" ? r.result : "";
  const kind = r ? kindLabel(r) : null;
  if (result === "success") {
    if (r?.action === "out") {
      return { tone: "amber", title: "Tea break started", kindLabel: kind, voice: "Tea break started.", allowed: true };
    }
    if (r?.action === "in") {
      const minutes = typeof r.takenMinutes === "number" ? ` - ${r.takenMinutes} min` : "";
      return {
        tone: "amber",
        title: `Tea break ended${minutes}`,
        kindLabel: kind,
        voice: "Tea break ended.",
        allowed: true,
      };
    }
    if (r?.scanType === "entry") {
      return {
        tone: "teal",
        title: "Welcome back - return recorded",
        kindLabel: kind,
        voice: "Welcome back.",
        allowed: true,
      };
    }
    return {
      tone: "teal",
      title: "Allowed - exit recorded",
      kindLabel: kind,
      voice: "Approved. You may go.",
      allowed: true,
    };
  }
  const denied = result === "not_allowed_here" && r?.kind === "tea_break" ? TEA_NOT_HERE : (DENIED[result] ?? UNKNOWN);
  return { tone: denied.tone ?? "rose", title: denied.title, kindLabel: kind, voice: denied.voice, allowed: false };
}

/** Who approved a pass, as the gate says it: "HR", "HOD - <name>", "On-Duty approval", else the name. */
export function formatApprover(approverRole?: string | null, approvedBy?: string | null): string | null {
  if (approverRole === "hr") return "HR";
  if (approverRole === "dept_head") return approvedBy ? `HOD - ${approvedBy}` : "HOD";
  if (approverRole === "system") return "On-Duty approval";
  return approvedBy || null;
}

/** The short words of a gate record's type in the latest-scans list. */
export const RECORD_TYPE_SHORT: Record<string, string> = {
  exit: "Exit",
  return: "Return",
  tea_out: "Tea out",
  tea_in: "Tea in",
};

/**
 * A record's type chip: RECORD_TYPE_SHORT, except a refused tea-break code (the server lists it as a denied "tea_out"
 * row, since out or in cannot be told for a refusal) reads "Tea break".
 */
export function recordTypeShort(r: { type: string; result?: string | null }): string {
  if (r.type === "tea_out" && r.result === "denied") return "Tea break";
  return RECORD_TYPE_SHORT[r.type] ?? r.type;
}

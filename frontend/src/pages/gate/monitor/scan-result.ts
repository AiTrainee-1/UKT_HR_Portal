// How the gate monitor shows and says each scan answer. Every lookup has a fallback: an answer this console does not know
// (a new server result, an error body without `result`) is shown as "Check with HR" instead of crashing the page (the old
// console read RESULT_TONE[result].cls and fell over on an expired session's error body).
//
// The tone is what the whole page turns for a moment after a scan (the edge light, the scanner card, the result card), so it
// must read from across the gate without reading a word. The words and the icon say the same thing (colour is never the
// only signal).

import type { GateScanResult } from "@/lib/api-client/custom-hooks/gate-monitor";
import { fmtTime } from "@/pages/hr/outpass-visitors/kit/fmt";

/**
 * green   = let through: a gate pass exit or return recorded, a tea break started;
 * orange  = stop and look: the pass was already used or has expired, the employee has not gone out yet, the same tea-break
 *           QR again inside the cooldown;
 * red     = refused: a code that is not recognised, not approved, or not taken at this gate;
 * return  = back from a tea break (its own colour, never the green of a break that starts);
 * neutral = nothing decided: no connection, or an answer this console does not know.
 */
export type ScanTone = "green" | "orange" | "red" | "return" | "neutral";

/** The animated icon of an answer: a check that draws, a warning that pulses, a clock (wait), a cross that shakes, the
 *  returning arrow, no connection, or a question (check with HR). */
export type ScanGlyph = "check" | "warn" | "wait" | "cross" | "return" | "offline" | "unknown";

export type ScanNote = {
  text: string;
  /** Written as a warning (a tea break over the allowed time). */
  warn: boolean;
};

export type ScanView = {
  tone: ScanTone;
  glyph: ScanGlyph;
  /** The big line: "Allowed - exit recorded". */
  title: string;
  /** Exit / Return / Tea break out / Tea break in / Tea break, or null when the code named nothing. */
  kindLabel: string | null;
  /** A second line that matters at a glance: the cooldown's "Already scanned at 10:05 - ...", a long break's warning. */
  note: ScanNote | null;
  /** What the voice says. */
  voice: string;
  allowed: boolean;
};

/** The console's own answer when the scan never reached the server. */
export const OFFLINE_RESULT: GateScanResult = {
  result: "offline",
  message: "Could not reach the server. Check the connection, then scan again.",
};

type Refusal = { title: string; voice: string; tone: ScanTone; glyph: ScanGlyph };

const REFUSED: Record<string, Refusal> = {
  already_scanned: {
    title: "Denied - pass already used",
    voice: "This pass was already used.",
    tone: "orange",
    glyph: "warn",
  },
  expired: { title: "Denied - pass expired", voice: "This pass has expired.", tone: "orange", glyph: "warn" },
  not_exited: {
    title: "Denied - has not gone out yet",
    voice: "This employee has not gone out yet.",
    tone: "orange",
    glyph: "warn",
  },
  not_approved: {
    title: "Denied - not approved",
    voice: "This pass is not approved. Please get it approved first.",
    tone: "red",
    glyph: "cross",
  },
  not_allowed_here: {
    title: "Denied - not taken at this gate",
    voice: "This gate does not take this pass.",
    tone: "red",
    glyph: "cross",
  },
  invalid_qr: {
    title: "Code not recognised",
    voice: "Code not recognised. Please scan again.",
    tone: "red",
    glyph: "cross",
  },
  offline: { title: "No connection", voice: "No connection. Please try again.", tone: "neutral", glyph: "offline" },
};

/** A tea-break code at a gate set not to take tea breaks (the server answers not_allowed_here with kind tea_break). */
const TEA_NOT_HERE: Refusal = {
  title: "Denied - no tea breaks at this gate",
  voice: "This gate does not take tea-break scans.",
  tone: "red",
  glyph: "cross",
};

const UNKNOWN: Refusal = { title: "Check with HR", voice: "Please check with HR.", tone: "neutral", glyph: "unknown" };

export function kindLabel(r: Pick<GateScanResult, "scanType" | "action" | "kind">): string | null {
  if (r.action === "out") return "Tea break out";
  if (r.action === "in") return "Tea break in";
  if (r.kind === "tea_break") return "Tea break";
  if (r.scanType === "entry") return "Return";
  if (r.scanType === "exit") return "Exit";
  return null;
}

/** Minutes a finished tea break went over the allowed time, or null (on time, or the allowed time is not known). */
export function teaOverMinutes(r: Pick<GateScanResult, "takenMinutes" | "allowedMinutes">): number | null {
  const taken = r.takenMinutes;
  const allowed = r.allowedMinutes;
  if (
    typeof taken !== "number" ||
    typeof allowed !== "number" ||
    !Number.isFinite(taken) ||
    !Number.isFinite(allowed)
  ) {
    return null;
  }
  return taken > allowed ? Math.round(taken - allowed) : null;
}

/**
 * The cooldown answer's line: "Already scanned at 10:05 - tea break started. Scan again after 10:10." (India time, as the
 * server writes it). The server's own message when the times are missing.
 */
export function cooldownLine(
  r: Pick<GateScanResult, "lastAction" | "lastScanAt" | "retryAt" | "message">,
): string | null {
  const last = r.lastScanAt ? fmtTime(r.lastScanAt) : null;
  const retry = r.retryAt ? fmtTime(r.retryAt) : null;
  if (!last || !retry || last === "—" || retry === "—") return r.message?.trim() || null;
  const what = r.lastAction === "in" ? "back from tea break" : "tea break started";
  return `Already scanned at ${last} - ${what}. Scan again after ${retry}.`;
}

/**
 * When the employee may scan again, as a time on this kiosk's clock: `answeredAt` + waitSeconds (so a kiosk clock that is a
 * few minutes off does not matter), else the server's retryAt. Null when the answer names neither.
 */
export function cooldownDeadline(
  r: Pick<GateScanResult, "waitSeconds" | "retryAt">,
  answeredAt: Date | null,
): number | null {
  if (typeof r.waitSeconds === "number" && Number.isFinite(r.waitSeconds) && answeredAt) {
    return answeredAt.getTime() + Math.max(0, r.waitSeconds) * 1000;
  }
  const at = r.retryAt ? Date.parse(r.retryAt) : Number.NaN;
  return Number.isNaN(at) ? null : at;
}

/** "3:32" for 212 seconds; "0:00" at the end (never negative). */
export function fmtCountdown(seconds: number): string {
  const whole = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

export function describeScan(r: GateScanResult | null | undefined): ScanView {
  const result = typeof r?.result === "string" ? r.result : "";
  const kind = r ? kindLabel(r) : null;
  const base = { kindLabel: kind, note: null as ScanNote | null };
  if (result === "success") {
    if (r?.action === "out") {
      return {
        ...base,
        tone: "green",
        glyph: "check",
        title: "Tea break started",
        voice: "Tea break started.",
        allowed: true,
      };
    }
    if (r?.action === "in") {
      const minutes = typeof r.takenMinutes === "number" ? ` - ${r.takenMinutes} min` : "";
      const over = teaOverMinutes(r);
      return {
        ...base,
        tone: "return",
        glyph: "return",
        title: `Back from tea break${minutes}`,
        note: over !== null ? { text: `Over the allowed ${r.allowedMinutes} min by ${over} min`, warn: true } : null,
        voice: over !== null ? "Tea break ended. Over the allowed time." : "Tea break ended. Welcome back.",
        allowed: true,
      };
    }
    if (r?.scanType === "entry") {
      return {
        ...base,
        tone: "green",
        glyph: "check",
        title: "Welcome back - return recorded",
        voice: "Welcome back.",
        allowed: true,
      };
    }
    return {
      ...base,
      tone: "green",
      glyph: "check",
      title: "Allowed - exit recorded",
      voice: "Approved. You may go.",
      allowed: true,
    };
  }
  if (result === "cooldown") {
    const line = r ? cooldownLine(r) : null;
    return {
      ...base,
      kindLabel: kind ?? "Tea break",
      tone: "orange",
      glyph: "wait",
      title: "Already scanned - please wait",
      note: line ? { text: line, warn: false } : null,
      voice: "Already scanned. Please wait.",
      allowed: false,
    };
  }
  const refusal =
    result === "not_allowed_here" && r?.kind === "tea_break" ? TEA_NOT_HERE : (REFUSED[result] ?? UNKNOWN);
  return {
    ...base,
    tone: refusal.tone,
    glyph: refusal.glyph,
    title: refusal.title,
    voice: refusal.voice,
    allowed: false,
  };
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

// One definition of "what colour is a status" for the whole portal. Pages used
// to each hard-code their own Tailwind pairs, and they had drifted -two
// different greens for "success", "On Leave" purple on some screens and blue
// on others. Tailwind only sees complete class strings, so every tone is
// written out literally here.

export type Tone = "success" | "warning" | "caution" | "danger" | "info" | "accent" | "neutral";

export const TONE: Record<Tone, string> = {
  success: "bg-green-100 text-green-800 border-green-200",
  warning: "bg-amber-100 text-amber-800 border-amber-200",
  caution: "bg-orange-100 text-orange-800 border-orange-200",
  danger: "bg-red-100 text-red-800 border-red-200",
  info: "bg-blue-100 text-blue-800 border-blue-200",
  accent: "bg-purple-100 text-purple-800 border-purple-200",
  neutral: "bg-slate-100 text-slate-600 border-slate-200",
};

/** Attendance day verdicts (AttendanceDayRecord.status). */
export const ATTENDANCE_STATUS_TONE: Record<string, Tone> = {
  present: "success",
  half_shift: "warning",
  absent: "danger",
  on_leave: "info",
  holiday: "neutral",
};

/** Approval workflow (leave, permission, casual leave, outpass, missing punch...). */
export const REQUEST_STATUS_TONE: Record<string, Tone> = {
  pending: "warning",
  approved: "success",
  rejected: "danger",
};

/** Tone classes for a status string in the given vocabulary; unknown -> neutral. */
export function toneClass(map: Record<string, Tone>, status: string | null | undefined): string {
  return TONE[(status && map[status]) || "neutral"];
}

export const attendanceStatusClass = (status: string | null | undefined) => toneClass(ATTENDANCE_STATUS_TONE, status);
export const requestStatusClass = (status: string | null | undefined) => toneClass(REQUEST_STATUS_TONE, status);

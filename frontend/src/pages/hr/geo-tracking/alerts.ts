// Geo Attendance -> Live Map -> "Tracking alerts": the words of the log of the automatic On-Duty tracking alerts (backend
// geo_tracking/alerts.py), as pure functions. One row = one episode of a problem (location off, a restricted permission or
// background use, no location received, a missing Geo-Punch, a reminder): when it was seen, what the employee and (when it was
// not fixed in time) their Department Head were sent on each channel, and how it ended.
import type { TrackingAlert, TrackingAlertChannel, TrackingAlertKind } from "@/lib/api-client/custom-hooks";
import type { Tone } from "@/lib/statusTones";
import { fmtTime } from "./logic";

export const ALERT_KIND_TONE: Record<TrackingAlertKind, Tone> = {
  location_off: "danger",
  permission_restricted: "warning",
  background_restricted: "warning",
  tracking_failure: "danger",
  missing_punch: "caution",
  punch_reminder: "info",
};

export const alertKindTone = (kind: string): Tone => ALERT_KIND_TONE[kind as TrackingAlertKind] ?? "neutral";

const PUSH_STATUS: Record<string, string> = {
  delivered: "delivered",
  sent: "pushed",
  waiting: "waiting to push",
  sending: "pushing",
  no_device: "no phone registered",
  failed: "push failed",
  off: "not pushed (muted or switched off)",
};

const WHATSAPP_STATUS: Record<string, string> = {
  queued: "queued",
  sending: "sending",
  sent: "sent",
  delivered: "delivered",
  read: "read",
  failed: "failed",
  skipped: "skipped",
  expired: "expired (too late to send)",
};

export type ChannelLine = { text: string; tone: Tone; title?: string };

/** What one channel did with one stage, in a few words, with its tone (and the reason as a tooltip). */
export function channelLine(channel: TrackingAlertChannel, kind: "push" | "whatsapp"): ChannelLine {
  const made = channel.outcome === (kind === "push" ? "made" : "queued");
  if (made && channel.status) {
    const words = (kind === "push" ? PUSH_STATUS : WHATSAPP_STATUS)[channel.status] ?? channel.status;
    const bad = ["failed", "no_device", "skipped", "expired", "off"].includes(channel.status);
    const good = ["delivered", "sent", "read"].includes(channel.status);
    return { text: words, tone: bad ? "warning" : good ? "success" : "info", title: channel.error ?? undefined };
  }
  if (!channel.outcome) return { text: "-", tone: "neutral" };
  const bad = channel.outcome === "error" || channel.outcome === "not_sent";
  return {
    text: channel.label || channel.outcome,
    tone: bad ? "warning" : "neutral",
    title: channel.error ?? undefined,
  };
}

export type AlertState = { label: string; tone: Tone };

/** Where the episode stands: seen (the employee is not told yet), open, or how and when it ended. */
export function alertState(
  alert: Pick<TrackingAlert, "open" | "waiting" | "resolvedAt" | "resolution" | "resolutionLabel">,
): AlertState {
  if (alert.open && alert.waiting) return { label: "Seen, alert pending", tone: "neutral" };
  if (alert.open) return { label: "Open", tone: "warning" };
  const when = alert.resolvedAt ? ` ${fmtTime(alert.resolvedAt)}` : "";
  const label = alert.resolutionLabel ?? "Ended";
  return { label: `${label}${when}`, tone: alert.resolution === "fixed" ? "success" : "neutral" };
}

/** The Department Head line of an episode: told (whom, when), due (when, if still not fixed), nobody to tell, or nothing. */
export function headLine(alert: TrackingAlert): string | null {
  const stage = alert.stages.find((s) => s.stage === "hod");
  if (stage) {
    if (stage.push.outcome === "no_head") return "No Department Head to tell";
    const who = stage.recipientName ? ` (${stage.recipientName})` : "";
    return `Department Head told at ${fmtTime(stage.sentAt)}${who}`;
  }
  if (alert.hodDueAt) return `Department Head is told at ${fmtTime(alert.hodDueAt)} if it is still not fixed`;
  return null;
}

/** "3 open now: 2 location off, 1 missing Geo-Punch" from the counts by kind. */
export function openSummary(open: number, byKind: Record<string, number>, labels: Record<string, string>): string {
  if (open <= 0) return "Nothing open now";
  const parts = Object.entries(byKind)
    .filter(([, n]) => n > 0)
    .map(([kind, n]) => `${n} ${(labels[kind] ?? kind).toLowerCase()}`);
  return `${open} open now${parts.length ? `: ${parts.join(", ")}` : ""}`;
}

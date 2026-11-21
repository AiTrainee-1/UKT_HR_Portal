import { ArrowRight, MapPinOff } from "lucide-react";
import { Link } from "wouter";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import type { MobileMessageControl } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { audienceLabel, formatNumber, plural } from "./logic";
import { pnPath } from "./routes";
import { Notice, Panel } from "./ui";

/** The Controls tab's group of the On-Duty tracking alerts (backend mobile_messages.TRACKING_ALERT_TYPES). */
export const TRACKING_GROUP = "tracking";

/** The tracking alert switches, in the server's order. */
export const trackingControls = (controls: readonly MobileMessageControl[] | undefined): MobileMessageControl[] =>
  (controls ?? []).filter((c) => c.group === TRACKING_GROUP && c.kind === "message");

/**
 * Overview -> "On-Duty tracking alerts": the six automatic alerts sent while an employee is On-Duty (location turned off, the
 * background location permission restricted, the app restricted in the background, a missing Geo-Punch, a Geo-Punch reminder,
 * a tracking failure), each with its own phone switch: the same switches as the Controls tab's group, so a change here shows
 * there at once. The employee gets the alert first; when it is not fixed in time their Department Head gets one too.
 */
export default function TrackingAlertsCard({
  rows,
  pushEnabled,
  busy,
  locked,
  canManage,
  onToggle,
}: {
  rows: readonly MobileMessageControl[];
  pushEnabled: boolean;
  busy: boolean;
  locked: string | null;
  canManage: boolean;
  onToggle: (row: MobileMessageControl, on: boolean) => void;
}) {
  if (rows.length === 0) return null;
  const on = rows.filter((r) => r.enabled).length;
  return (
    <Panel
      title="On-Duty tracking alerts"
      icon={MapPinOff}
      testId="pn-tracking-alerts"
      description="Sent automatically while an employee is On-Duty: the employee is alerted first, and their Department Head when it is not fixed in time. Each alert has its own switch for phones."
      actions={
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <span className="text-muted-foreground" data-testid="pn-tracking-count">
            <b className="text-foreground">{on}</b> of {plural(rows.length, "alert", "alerts")} on
          </span>
          {canManage && (
            <Link
              href={pnPath("controls", "category=on_duty")}
              className="inline-flex items-center gap-1 font-semibold text-sky-700 underline-offset-2 hover:underline dark:text-sky-400"
            >
              In Controls <ArrowRight size={11} />
            </Link>
          )}
        </div>
      }
    >
      {!pushEnabled && (
        <Notice tone="neutral" testId="pn-tracking-master-off">
          The master switch is <b>OFF</b>, so none of these is pushed until it is turned back on.
        </Notice>
      )}
      <ul className="grid gap-x-6 sm:grid-cols-2">
        {rows.map((row) => (
          <li
            key={row.key}
            className={cn("flex items-start justify-between gap-3 border-b py-3", !pushEnabled && "opacity-70")}
            data-testid={`pn-tracking-${row.key}`}
          >
            <div className="min-w-0">
              <p className="text-sm font-semibold leading-snug">{row.label}</p>
              <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground" title={row.description}>
                {row.description}
              </p>
              <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                <StatusBadge tone="neutral">{audienceLabel(row.audience)}</StatusBadge>
                {row.stats && <span>Last 30 days: {formatNumber(row.stats.total)}</span>}
              </p>
            </div>
            <Switch
              checked={row.enabled}
              disabled={busy || locked !== null}
              title={locked ?? undefined}
              onCheckedChange={(v) => onToggle(row, v)}
              aria-label={`Phone notification: ${row.label}`}
              data-testid={`pn-tracking-toggle-${row.key}`}
              className="mt-0.5 shrink-0"
            />
          </li>
        ))}
      </ul>
    </Panel>
  );
}

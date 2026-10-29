// On-Duty Map: the list beside the map. One row per employee: the colour of their route (the same colour as their line, stops and
// pins), who they are, what they are doing, a one-line summary of the journey, and the punches of the day. Click a row to focus
// that employee (the map zooms to them and the others fade; click again to let go); the eye hides or shows one on the map.
// The row is a div with a button role, not a <button>: it holds the eye button, and free text (a destination) inside a real
// button would be read by the View-only lock as an action word.
import type { KeyboardEvent } from "react";
import { Eye, EyeOff, Route as RouteIcon } from "lucide-react";
import { Chip } from "@/components/payroll/kit/parts";
import { initials } from "@/components/payroll/kit/format";
import type { OnDutyMapEmployee } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import type { DutyEntry } from "./dutyMap";
import { SessionChip, StateChip, PUNCH_STATUS_LABEL, PUNCH_TONE } from "./kit";
import { fmtDistance, fmtDuration, fmtTime, timeAgo } from "./logic";

type Punch = OnDutyMapEmployee["punches"][number];

function PunchChip({ p }: { p: Punch }) {
  const status = (p.status in PUNCH_STATUS_LABEL ? p.status : "pending") as keyof typeof PUNCH_STATUS_LABEL;
  return (
    <Chip tone={PUNCH_TONE[status]} className="!px-1.5 !py-0 !text-[10px]">
      #{p.punchNumber} {p.punchType} {p.punchTime.slice(0, 5)} · {PUNCH_STATUS_LABEL[status]}
    </Chip>
  );
}

export default function OnDutyLegend({
  entries,
  colors,
  hidden,
  focusId,
  onFocus,
  onToggle,
  onHover,
}: {
  entries: DutyEntry[];
  colors: ReadonlyMap<number, string>;
  hidden: ReadonlySet<number>;
  focusId: number | null;
  onFocus: (employeeId: number) => void;
  onToggle: (employeeId: number) => void;
  onHover: (employeeId: number | null) => void;
}) {
  const key = (id: number) => (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onFocus(id);
    }
  };
  return (
    <ul className="space-y-2" data-testid="duty-legend">
      {entries.map((e) => {
        const color = colors.get(e.employeeId) ?? "#475569";
        const isHidden = hidden.has(e.employeeId);
        const focused = focusId === e.employeeId;
        return (
          <li key={e.employeeId}>
            <div
              role="button"
              tabIndex={0}
              aria-pressed={focused}
              data-testid="duty-row"
              data-employee-id={e.employeeId}
              data-color={color}
              data-hidden={isHidden ? "true" : "false"}
              onClick={() => onFocus(e.employeeId)}
              onKeyDown={key(e.employeeId)}
              onMouseEnter={() => onHover(e.employeeId)}
              onMouseLeave={() => onHover(null)}
              onFocus={() => onHover(e.employeeId)}
              onBlur={() => onHover(null)}
              className={cn(
                "cursor-pointer rounded-xl border bg-white p-3 outline-none transition-colors hover:border-slate-300 focus-visible:ring-2 focus-visible:ring-sky-300",
                isHidden && "opacity-55",
              )}
              style={{
                borderLeftWidth: 4,
                borderLeftColor: color,
                // longhand only: mixing borderColor with borderLeftColor makes React warn on every re-render
                ...(focused
                  ? {
                      borderTopColor: color,
                      borderRightColor: color,
                      borderBottomColor: color,
                      backgroundColor: `${color}12`,
                    }
                  : null),
              }}
            >
              <div className="flex items-start gap-3">
                <span
                  aria-hidden
                  data-testid="duty-swatch"
                  className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white"
                  style={{ background: color }}
                >
                  {initials(e.employeeName)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <p className="min-w-0 truncate text-sm font-bold leading-tight text-gray-900">
                      {e.employeeName}
                      <span className="ml-1.5 font-mono text-[11px] font-medium text-gray-400">{e.employeeCode}</span>
                    </p>
                    <button
                      type="button"
                      data-testid="duty-toggle"
                      aria-pressed={!isHidden}
                      aria-label={
                        isHidden ? `Show ${e.employeeName} on the map` : `Hide ${e.employeeName} from the map`
                      }
                      title={isHidden ? "Show on the map" : "Hide from the map"}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        onToggle(e.employeeId);
                      }}
                      onKeyDown={(ev) => ev.stopPropagation()}
                      className="-m-1 shrink-0 rounded-md p-1 text-gray-500 hover:bg-slate-100 hover:text-gray-900"
                    >
                      {isHidden ? <EyeOff size={15} /> : <Eye size={15} />}
                    </button>
                  </div>
                  <p className="mt-0.5 truncate text-xs text-gray-600">
                    {e.department ?? "No department"}
                    {e.destination ? (
                      <>
                        {" "}
                        · <span className="italic">{e.destination}</span>
                      </>
                    ) : null}
                  </p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    {e.live && e.state ? (
                      <StateChip state={e.state} testId="duty-state" />
                    ) : e.hasJourney ? (
                      <Chip tone="neutral">Journey ended</Chip>
                    ) : (
                      <Chip tone="neutral" icon={RouteIcon}>
                        No route recorded
                      </Chip>
                    )}
                    {e.approvalStatus && (
                      <SessionChip status={e.approvalStatus as Parameters<typeof SessionChip>[0]["status"]} />
                    )}
                    {e.mocked && <Chip tone="danger">Simulated</Chip>}
                  </div>
                  {e.hasJourney && (
                    <p
                      className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] font-medium text-gray-700"
                      data-testid="duty-summary"
                    >
                      <span>{fmtDistance(e.totals.distanceM)}</span>
                      <span>
                        {e.totals.stops} stop{e.totals.stops === 1 ? "" : "s"}
                      </span>
                      <span>{fmtDuration(e.totals.durationS)}</span>
                      {e.live && e.lastSeenAt ? (
                        <span className="font-normal text-gray-500">last seen {timeAgo(e.lastSeenAt)}</span>
                      ) : !e.live && e.endAt ? (
                        <span className="font-normal text-gray-500">ended {fmtTime(e.endAt)}</span>
                      ) : null}
                    </p>
                  )}
                  {!e.hasJourney && e.lastSeenAt && (
                    <p className="mt-1.5 text-[11px] text-gray-500">last seen {timeAgo(e.lastSeenAt)}</p>
                  )}
                  {e.punches.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {e.punches.map((p) => (
                        <PunchChip key={p.punchNumber} p={p} />
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

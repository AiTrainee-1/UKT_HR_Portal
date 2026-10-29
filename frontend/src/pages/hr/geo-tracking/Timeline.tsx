// Journey History: the detailed log of one journey. Travel, stationary periods, gaps (no location) and events in one list by time,
// with the category filters. (The journey told as a story is <ActivityTimeline>.)
// Picking a row highlights it on the map (which moves to it), and picking something on the map highlights its row here.
// A stationary period shows its length and a chip: "waiting" under 15 minutes, "long stop" from 15 minutes on.
import { useMemo, useState } from "react";
import { ScrollText } from "lucide-react";
import { SectionCard } from "@/components/payroll/kit/parts";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { causeLabel, fmtDistance, fmtDuration, timeRange, type TimelineRow, type TimelineType } from "./logic";
import { PlaceLinks } from "./PlaceLinks";
import { Chip, EmptyNote, TypeChip } from "./ui";

type Show = "all" | TimelineType;

const SHOWS: { value: Show; label: string }[] = [
  { value: "all", label: "Everything" },
  { value: "stop", label: "Stationary" },
  { value: "gap", label: "Gaps" },
  { value: "event", label: "Events" },
  { value: "travel", label: "Travel" },
];

function Place({ row }: { row: TimelineRow }) {
  return (
    <>
      <p className="font-semibold text-gray-900">
        {row.stopNumber !== null && <span className="mr-1.5 text-gray-500">#{row.stopNumber}</span>}
        {row.title}
      </p>
      {row.detail && <p className="text-xs text-gray-500">{row.detail}</p>}
      {row.pos && (
        <p className="mt-0.5 flex items-center gap-1 text-[11px] text-[#006496]">
          <PlaceLinks lat={row.pos[0]} lng={row.pos[1]} compact /> <span>Google Maps</span>
        </p>
      )}
    </>
  );
}

export default function Timeline({
  rows,
  selectedKey,
  onSelect,
  active,
}: {
  rows: TimelineRow[];
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
  active: boolean;
}) {
  const [show, setShow] = useState<Show>("all");
  const counts = useMemo(() => {
    const c: Record<Show, number> = { all: rows.length, stop: 0, gap: 0, event: 0, travel: 0 };
    for (const r of rows) c[r.type] += 1;
    return c;
  }, [rows]);
  const shown = show === "all" ? rows : rows.filter((r) => r.type === show);

  return (
    <SectionCard
      testId="timeline"
      title="Detailed log"
      description="Every stretch of travel, every stop, gap and event, as recorded."
      icon={ScrollText}
      actions={
        <div role="group" aria-label="What the timeline shows" className="flex flex-wrap gap-1">
          {SHOWS.map((s) => (
            <button
              key={s.value}
              type="button"
              aria-pressed={show === s.value}
              data-testid={`timeline-show-${s.value}`}
              onClick={() => setShow(s.value)}
              className={cn(
                "rounded-full border px-3 py-1 text-xs font-semibold transition-colors",
                show === s.value
                  ? "border-slate-900 bg-slate-900 text-white"
                  : "border-gray-200 bg-white text-gray-700 hover:bg-gray-50",
              )}
            >
              {s.label} ({counts[s.value]})
            </button>
          ))}
        </div>
      }
    >
      <div className="space-y-3">
        {rows.length === 0 ? (
          <EmptyNote testId="timeline-empty">
            {active
              ? "Nothing has been recorded yet. Stops, travel and events appear here as the phone reports."
              : "Nothing was recorded for this journey."}
          </EmptyNote>
        ) : shown.length === 0 ? (
          <p className="py-6 text-center text-sm text-gray-500" data-testid="timeline-none">
            Nothing of this kind in the journey.
          </p>
        ) : (
          <Table className="text-sm">
            <TableHeader>
              <TableRow>
                <TableHead>Time (IST)</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Place / route</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Distance</TableHead>
                <TableHead>Cause</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((row) => {
                const selected = row.key === selectedKey;
                return (
                  <TableRow
                    key={row.key}
                    data-testid="timeline-row"
                    data-key={row.key}
                    data-type={row.type}
                    data-selected={selected ? "true" : "false"}
                    aria-current={selected ? "true" : undefined}
                    tabIndex={0}
                    className={cn(
                      "cursor-pointer",
                      selected && "bg-sky-50 outline outline-2 -outline-offset-2 outline-sky-400",
                    )}
                    onClick={() => onSelect(selected ? null : row.key)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onSelect(selected ? null : row.key);
                      }
                    }}
                  >
                    <TableCell className="whitespace-nowrap">
                      {timeRange(row.startedAt, row.endedAt, row.open)}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-1">
                        <TypeChip type={row.type} />
                        {row.type === "stop" && (
                          <Chip
                            testId="stop-kind"
                            className={row.longStop ? "bg-purple-50 text-purple-700" : "bg-amber-50 text-amber-800"}
                          >
                            {row.longStop ? "long stop" : "waiting"}
                          </Chip>
                        )}
                        {row.estimated && <Chip className="bg-sky-50 text-sky-700">estimated</Chip>}
                        {row.mock && <Chip className="bg-red-50 text-red-700">simulated</Chip>}
                      </div>
                    </TableCell>
                    <TableCell className="min-w-[14rem]">
                      <Place row={row} />
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {row.open && row.durationS === null
                        ? "ongoing"
                        : row.durationS === null
                          ? "-"
                          : fmtDuration(row.durationS)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {row.distanceM !== null ? fmtDistance(row.distanceM) : "-"}
                    </TableCell>
                    <TableCell className="min-w-[10rem]">{row.cause ? causeLabel(row.cause) : "-"}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>
    </SectionCard>
  );
}

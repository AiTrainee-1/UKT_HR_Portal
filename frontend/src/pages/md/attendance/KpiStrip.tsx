import type { ComponentType } from "react";
import { Clock, Fingerprint, Hourglass, Timer, UserCheck, UserX } from "lucide-react";
import AskAiButton from "@/components/md/kit/AskAiButton";
import StatCard, { type StatTone } from "@/components/md/kit/StatCard";
import { minutesText, num } from "@/lib/md/format";
import { ask, metricDelta, metricText, wasText, type AskContext } from "./logic";
import type { AttendanceSummary, MetricKey } from "./types";

type Tile = {
  key: MetricKey;
  label: string;
  icon: ComponentType<{ size?: number; className?: string }>;
  tone: StatTone;
  provenanceIds: string[];
  question: (c: AskContext) => string;
  sub: (s: AttendanceSummary) => string | undefined;
};

const join = (...parts: (string | null | undefined)[]) => parts.filter(Boolean).join(" · ") || undefined;

const TILES: Tile[] = [
  {
    key: "attendancePct",
    label: "Attendance",
    icon: UserCheck,
    tone: "blue",
    provenanceIds: ["attendance-pct", "coverage"],
    question: ask.attendance,
    sub: (s) => wasText("attendancePct", s.metrics.attendancePct) ?? "of scheduled days worked",
  },
  {
    key: "absenteeismPct",
    label: "Absenteeism",
    icon: UserX,
    tone: "red",
    provenanceIds: ["absenteeism-pct"],
    question: ask.absenteeism,
    sub: (s) =>
      join(
        s.counts.absent != null ? `${num(s.counts.absent)} unplanned absence days` : null,
        wasText("absenteeismPct", s.metrics.absenteeismPct),
      ),
  },
  {
    key: "latePct",
    label: "Late arrivals",
    icon: Clock,
    tone: "amber",
    provenanceIds: ["late-pct", "avg-late-minutes"],
    question: ask.late,
    sub: (s) => {
      const avg = s.metrics.avgLateMinutes?.value;
      return join(
        avg != null ? `${minutesText(avg)} late on average` : "of days worked",
        wasText("latePct", s.metrics.latePct),
      );
    },
  },
  {
    key: "overtimeHours",
    label: "Overtime",
    icon: Timer,
    tone: "indigo",
    provenanceIds: ["overtime-hours"],
    question: ask.overtime,
    sub: (s) =>
      s.metrics.overtimeHours?.value == null
        ? "Not tracked: see the notes"
        : join(
            s.counts.overtimeDays != null ? `${num(s.counts.overtimeDays)} staff days` : null,
            wasText("overtimeHours", s.metrics.overtimeHours),
          ),
  },
  {
    key: "halfDays",
    label: "Half days",
    icon: Hourglass,
    tone: "purple",
    provenanceIds: ["half-days"],
    question: ask.halfDays,
    sub: (s) => join("one half worked only", wasText("halfDays", s.metrics.halfDays)),
  },
  {
    key: "missingPunches",
    label: "Missing punches",
    icon: Fingerprint,
    tone: "slate",
    provenanceIds: ["missing-punches"],
    question: ask.missingPunches,
    sub: () => "requests waiting for a decision",
  },
];

/** The six headline figures of the period, each with the change against the previous period and a sparkline. */
export default function KpiStrip({
  summary,
  loading,
  context,
}: {
  summary?: AttendanceSummary;
  loading: boolean;
  context: AskContext;
}) {
  return (
    // A card needs about 200 px for its change chip beside the sparkline, so: one column on a phone, two once there is
    // room, three beside the sidebar, and six only on a wide screen.
    <div
      className="grid grid-cols-1 gap-3 @md:grid-cols-2 @3xl:grid-cols-3 @6xl:grid-cols-6"
      data-testid="md-attendance-kpis"
    >
      {TILES.map((tile) => {
        const metric = summary?.metrics[tile.key];
        return (
          <StatCard
            key={tile.key}
            testId={`md-attendance-kpi-${tile.key}`}
            label={tile.label}
            value={metricText(tile.key, metric)}
            sub={summary ? tile.sub(summary) : undefined}
            icon={tile.icon}
            tone={tile.tone}
            delta={metricDelta(tile.key, metric)}
            spark={metric?.spark ?? undefined}
            loading={loading}
            provenance={summary?.provenance}
            provenanceIds={tile.provenanceIds}
          >
            <AskAiButton question={tile.question(context)} label="" className="ml-1 px-1.5 align-middle" />
          </StatCard>
        );
      })}
    </div>
  );
}

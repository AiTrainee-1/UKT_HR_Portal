import type { ComponentType } from "react";
import {
  CalendarClock,
  Clock,
  Hourglass,
  LogOut,
  Timer,
  UserCheck,
  UserX,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import AskAiButton from "@/components/md/kit/AskAiButton";
import SectionCard from "@/components/md/kit/SectionCard";
import StatCard from "@/components/md/kit/StatCard";
import { num } from "@/lib/md/format";
import { cn } from "@/lib/utils";
import BriefingList from "../shared/BriefingList";
import { drillClick } from "../shared/drill";
import {
  BOARD,
  boardSentence,
  tileDelta,
  tileQuestion,
  tileValue,
  TILES,
  type AttendanceKind,
  type TileKey,
} from "./logic";
import type { BoardState, InsightsSummary, LiveTodayV2, Metric, PeopleMetric } from "./types";

const ICONS: Record<TileKey, ComponentType<{ size?: number; className?: string }>> = {
  attendancePct: UserCheck,
  absenteeismPct: UserX,
  latePct: Clock,
  quarterDays: CalendarClock,
  penaltyEarlyOuts: LogOut,
  halfDays: Hourglass,
  shiftsEarned: Wallet,
  overtimeHours: Timer,
  avgLateMinutes: Clock,
  missingPunches: Clock,
  leaveDays: Clock,
  scheduledDays: Clock,
  coveragePct: Clock,
  shiftsDeducted: LogOut,
};

/** The server's few plain sentences about the figures, with Ask AI. */
export function BriefingCard({
  summary,
  loading,
  question,
  title,
}: {
  summary?: InsightsSummary;
  loading: boolean;
  question: string;
  title: string;
}) {
  const lines = summary?.briefing ?? [];
  return (
    <SectionCard
      testId="md-att-briefing"
      title={title}
      subtitle="Written from the figures below"
      loading={loading}
      provenance={summary?.provenance}
      actions={<AskAiButton question={question} label="Explain with AI" />}
    >
      {lines.length > 0 ? (
        <BriefingList sentences={lines} testIdPrefix="md-att-sentence" />
      ) : (
        <p className="md-analytics-note">No completed day with attendance records yet.</p>
      )}
    </SectionCard>
  );
}

/** The headline figures; a click on one lists the people behind it. */
export function KpiTiles({
  summary,
  loading,
  kind,
  where,
  onDrill,
}: {
  summary?: InsightsSummary;
  loading: boolean;
  kind: AttendanceKind;
  where: string;
  onDrill: (metric: PeopleMetric, label: string) => void;
}) {
  return (
    <div
      className="grid grid-cols-2 gap-3 @3xl:grid-cols-4 [&>*:last-child:nth-child(odd)]:col-span-2 @3xl:[&>*:last-child:nth-child(odd)]:col-span-1"
      data-testid="md-att-kpis"
    >
      {TILES.map((tile) => {
        const metric = (summary?.metrics as Record<string, Metric | undefined> | undefined)?.[tile.key];
        const value = tileValue(tile.key, metric);
        const drill = tile.drill;
        return (
          <StatCard
            key={tile.key}
            testId={`md-att-kpi-${tile.key}`}
            label={tile.label}
            value={value}
            sub={summary ? tile.sub(summary) : undefined}
            icon={ICONS[tile.key]}
            tone={tile.tone}
            delta={tileDelta(tile.key, metric)}
            spark={metric?.spark ?? undefined}
            loading={loading}
            provenance={summary?.provenance}
            provenanceIds={tile.provenanceIds}
            onClick={drill && metric?.value != null ? drillClick(() => onDrill(drill, tile.label)) : undefined}
          >
            <AskAiButton
              question={tileQuestion(tile, kind, where, value)}
              label=""
              className="ml-1 px-1.5 align-middle"
            />
          </StatCard>
        );
      })}
    </div>
  );
}

/** Today so far: HR's six status cards, each opening the people on it. */
export function TodayBoard({
  live,
  question,
  onOpen,
}: {
  live: LiveTodayV2;
  question: string;
  onOpen: (state: BoardState) => void;
}) {
  const board = live.board;
  if (!board) return null;
  return (
    <SectionCard
      testId="md-att-today"
      title="Today so far"
      subtitle={`${boardSentence(board, live.expected)} · provisional until the day ends`}
      actions={<AskAiButton question={question} />}
    >
      {!live.isWorkingDay ? (
        <p className="md-analytics-note">Nobody is scheduled to work today.</p>
      ) : (
        <div className="grid grid-cols-2 gap-2 @2xl:grid-cols-3 @5xl:grid-cols-6">
          {BOARD.map((b) => {
            const Icon: LucideIcon = b.key === "absent" ? UserX : b.key === "present" ? UserCheck : Clock;
            return (
              <button
                key={b.key}
                type="button"
                onClick={() => onOpen(b.key)}
                disabled={board[b.key] === 0}
                className={cn(
                  "md-analytics-stat flex flex-col items-start text-left transition-opacity disabled:cursor-default disabled:opacity-60",
                  b.tone,
                )}
                data-testid={`md-att-today-${b.key}`}
              >
                <span className="flex items-center gap-1.5">
                  <Icon size={14} aria-hidden />
                  <span className="md-analytics-stat-value">{num(board[b.key])}</span>
                </span>
                <span className="md-analytics-stat-label">{b.label}</span>
                <span className="text-[11px] text-md-ink-soft">{b.hint}</span>
              </button>
            );
          })}
        </div>
      )}
    </SectionCard>
  );
}

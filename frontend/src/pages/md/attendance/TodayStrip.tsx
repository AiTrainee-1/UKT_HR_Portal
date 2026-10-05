import AskAiButton from "@/components/md/kit/AskAiButton";
import SectionCard from "@/components/md/kit/SectionCard";
import { clockText, num, pct } from "@/lib/md/format";
import type { Provenance } from "@/lib/md/types";
import { ask, liveSentence, mostMissing, type AskContext } from "./logic";
import type { LiveToday } from "./types";

const Figure = ({ label, value, tone }: { label: string; value: string; tone: string }) => (
  <div className={`rounded-xl px-3 py-2 ${tone}`}>
    <p className="text-xl font-black leading-tight">{value}</p>
    <p className="text-[11px] font-medium opacity-70">{label}</p>
  </div>
);

/**
 * Today, so far: who has punched in. It is a count from the punch log, not a rate: the day is still running, so
 * "not in yet" is not "absent", and the attendance figures further down leave today out for the same reason.
 */
export default function TodayStrip({
  live,
  provenance,
  context,
}: {
  live: LiveToday;
  provenance?: Provenance[];
  context: AskContext;
}) {
  const missing = mostMissing(live.byUnit);
  return (
    <SectionCard
      testId="md-attendance-today"
      title="Today so far"
      subtitle={`Provisional${live.asOf ? ` · as of ${clockText(live.asOf)}` : ""} · from the punch log`}
      provenance={provenance}
      provenanceIds={["live-today"]}
      actions={<AskAiButton question={ask.today(context)} />}
    >
      {!live.isWorkingDay ? (
        <p className="text-sm text-muted-foreground" data-testid="md-attendance-today-off">
          {liveSentence(live)}
        </p>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2 @xl:grid-cols-4">
            <Figure label="in so far" value={num(live.present)} tone="bg-green-50 text-green-800" />
            <Figure label="on approved leave" value={num(live.leave)} tone="bg-purple-50 text-purple-800" />
            <Figure label="not in yet" value={num(live.absent)} tone="bg-amber-50 text-amber-800" />
            <Figure label="of scheduled so far" value={pct(live.attendancePct, 0)} tone="bg-blue-50 text-blue-800" />
          </div>
          <p className="text-xs text-[#006496]/70" data-testid="md-attendance-today-sentence">
            {liveSentence(live)}
            {missing ? `. Most not in yet: ${missing.name} (${num(missing.absent)}).` : ""}
          </p>
        </div>
      )}
    </SectionCard>
  );
}

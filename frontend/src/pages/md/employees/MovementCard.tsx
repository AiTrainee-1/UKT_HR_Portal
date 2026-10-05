import { ArrowLeftRight } from "lucide-react";
import AskAiButton from "@/components/md/kit/AskAiButton";
import { CHART } from "@/components/md/kit/chartTheme";
import SectionCard from "@/components/md/kit/SectionCard";
import { EmptyBlock } from "@/components/md/kit/states";
import TrendChart from "@/components/md/kit/TrendChart";
import { num } from "@/lib/md/format";
import { grainText, headcountDomain, movementRows } from "./logic";
import { Unavailable } from "./parts";
import type { EmployeesMovement } from "./types";

/** Joiners and leavers as bars, and the (reconstructed) headcount as a line: is the workforce growing or shrinking? */
export default function MovementCard({
  movement,
  question,
  failed,
}: {
  movement: EmployeesMovement | undefined;
  question: string;
  failed?: boolean;
}) {
  const rows = movement ? movementRows(movement) : [];
  const t = movement?.totals;
  return (
    <SectionCard
      title="Joiners, leavers and headcount"
      subtitle={
        movement && movement.period
          ? `${movement.period.label}, by ${grainText(movement.grain)}${
              t ? ` · ${num(t.joiners)} joined, ${num(t.leavers)} left` : ""
            }`
          : undefined
      }
      provenance={movement?.provenance}
      loading={!movement && !failed}
      actions={<AskAiButton question={question} />}
      testId="md-employees-movement"
    >
      {!movement ? (
        <Unavailable />
      ) : rows.length === 0 ? (
        <EmptyBlock icon={ArrowLeftRight} title="Nothing to chart yet">
          {movement?.notes.find((n) => n.includes("not started")) ??
            "There are no days in this period to show joiners and leavers for."}
        </EmptyBlock>
      ) : (
        <div className="space-y-1">
          <TrendChart
            data={rows}
            xKey="label"
            series={[
              { key: "joiners", label: "Joiners", kind: "bar", color: CHART.good },
              { key: "leavers", label: "Leavers", kind: "bar", color: CHART.bad },
            ]}
            yFormat={(v) => num(v)}
            height={210}
          />
          <p className="px-1 pt-1 text-[11px] font-bold uppercase tracking-wider text-[#006496]/60">Headcount</p>
          <TrendChart
            data={rows}
            xKey="label"
            series={[{ key: "headcount", label: "Headcount", kind: "area", color: CHART.brand }]}
            yDomain={headcountDomain(rows)}
            yFormat={(v) => num(v)}
            legend={false}
            height={130}
          />
          <p className="px-1 text-[11px] text-[#006496]/55" data-testid="md-employees-movement-caveat">
            Headcount before today is rebuilt from join and exit dates: the system keeps no headcount history.
          </p>
        </div>
      )}
    </SectionCard>
  );
}

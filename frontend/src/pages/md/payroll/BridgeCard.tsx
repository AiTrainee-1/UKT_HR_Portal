import { ArrowDownRight, ArrowUpRight, CheckCircle2, GitCompareArrows, Minus } from "lucide-react";
import AskAiButton from "@/components/md/kit/AskAiButton";
import { CHART } from "@/components/md/kit/chartTheme";
import SectionCard from "@/components/md/kit/SectionCard";
import { EmptyBlock, NoteBanner } from "@/components/md/kit/states";
import { inr, pct } from "@/lib/md/format";
import { cn } from "@/lib/utils";
import { bridgeQuestion, buildWaterfall, reconciles, signedInr, stepIsDrawn } from "./logic";
import { CardError, cardNotes, failed } from "./parts";
import type { PayrollQueries } from "./queries";
import type { PayrollBridge } from "./types";
import WaterfallChart from "./WaterfallChart";

/** One sentence that says what happened and what drove it. */
function headline(b: PayrollBridge): string {
  const change = b.change;
  if (!b.start || !b.end || !change) return "";
  const move =
    change.abs === 0
      ? `Gross pay did not change from ${b.previousLabel} to ${b.monthLabel}.`
      : `Gross pay ${change.abs > 0 ? "rose" : "fell"} by ${inr(Math.abs(change.abs), 2)}${
          change.pct != null ? ` (${pct(Math.abs(change.pct))})` : ""
        } from ${b.previousLabel} to ${b.monthLabel}.`;
  const driver = b.mainDriver;
  return driver ? `${move} The biggest step is ${driver.label.toLowerCase()} (${signedInr(driver.amount)}).` : move;
}

/**
 * "What changed since last month, and why?": last month's gross pay walked to this month's as a waterfall, with every
 * step's exact amount and the people behind it listed beside it. The steps add up to the change to the paisa.
 */
export default function BridgeCard({
  query,
  label,
  previousLabel,
}: {
  query: PayrollQueries["bridge"];
  label: string;
  previousLabel: string;
}) {
  const bridge = query.data;
  const ready = bridge?.available && bridge.start && bridge.end;
  const bars = ready ? buildWaterfall(bridge.start!, bridge.steps, bridge.end!) : [];
  const exact = ready && Math.abs((bridge.sumOfSteps ?? 0) - (bridge.end!.amount - bridge.start!.amount)) < 0.005;
  return (
    <SectionCard
      testId="md-payroll-bridge"
      title="Why did payroll change?"
      subtitle={`From ${previousLabel} to ${label}, step by step`}
      loading={query.isPending}
      provenance={bridge?.provenance}
      provenanceIds={["bridge", "bridge-split", "gross-pay", "provisional"]}
      actions={<AskAiButton question={bridgeQuestion(label, previousLabel, bridge?.change)} />}
    >
      {failed(query) ? (
        <CardError query={query} />
      ) : !bridge || !ready ? (
        <EmptyBlock icon={GitCompareArrows} title="Nothing to compare" testId="md-payroll-bridge-unavailable">
          {bridge?.reason ?? "The bridge needs payroll for this month and the one before it."}
        </EmptyBlock>
      ) : (
        <div className="space-y-4">
          <div className="md-panel-sand flex items-start gap-3 px-4 py-3">
            <span className="md-money-tile md-money-tile-sm md-money-t-warning">
              <GitCompareArrows size={16} aria-hidden />
            </span>
            <p
              className="min-w-0 pt-1 text-[14px] font-semibold leading-snug text-md-ink"
              data-testid="md-payroll-bridge-headline"
            >
              {headline(bridge)}
            </p>
          </div>
          <div className="grid grid-cols-1 items-start gap-5 @4xl:grid-cols-12">
            <div className="min-w-0 @4xl:col-span-7">
              <WaterfallChart bars={bars} />
              <ul
                className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11.5px] font-semibold text-md-ink-soft"
                aria-label="How to read the chart"
              >
                <li className="inline-flex items-center gap-1.5">
                  <i className="md-money-swatch" style={{ background: CHART.brand }} /> Monthly total
                </li>
                <li className="inline-flex items-center gap-1.5">
                  <i className="md-money-swatch" style={{ background: CHART.bad }} /> Raises payroll cost
                </li>
                <li className="inline-flex items-center gap-1.5">
                  <i className="md-money-swatch" style={{ background: CHART.good }} /> Lowers payroll cost
                </li>
              </ul>
            </div>
            <div className="@4xl:col-span-5">
              <ul className="md-panel md-money-steps" data-testid="md-payroll-bridge-steps">
                {bridge.steps.map((s) => {
                  const Arrow = s.amount > 0 ? ArrowUpRight : s.amount < 0 ? ArrowDownRight : Minus;
                  return (
                    <li
                      key={s.id}
                      data-testid={`md-payroll-bridge-step-${s.id}`}
                      className={cn("md-money-step", !stepIsDrawn(s) && "opacity-60")}
                    >
                      <span
                        className={cn(
                          "md-money-badge",
                          s.amount > 0
                            ? "md-money-t-danger"
                            : s.amount < 0
                              ? "md-money-t-success"
                              : "md-money-t-neutral",
                        )}
                        aria-hidden
                      >
                        <Arrow size={14} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="text-[13px] font-bold text-md-ink">
                            {s.label}
                            {s.people > 0 && (
                              <span className="ml-1.5 text-[11.5px] font-medium text-md-ink-soft">
                                {s.people} {s.people === 1 ? "person" : "people"}
                              </span>
                            )}
                          </span>
                          <span
                            data-testid={`md-payroll-bridge-amount-${s.id}`}
                            className={cn(
                              "shrink-0 text-[13px] font-black tabular-nums",
                              s.amount > 0 ? "text-md-danger" : s.amount < 0 ? "text-md-success" : "text-md-ink-soft",
                            )}
                          >
                            {signedInr(s.amount)}
                          </span>
                        </div>
                        <p className="mt-0.5 text-[11.5px] leading-snug text-md-ink-soft">{s.detail}</p>
                      </div>
                    </li>
                  );
                })}
                <li className="md-money-step md-money-step-total justify-between">
                  <span className="text-[13px] font-black text-md-ink">Total change</span>
                  <span
                    className="text-[14px] font-black tabular-nums text-md-ink"
                    data-testid="md-payroll-bridge-total"
                  >
                    {signedInr(bridge.sumOfSteps)}
                  </span>
                </li>
              </ul>
              {exact && reconciles(bars) && (
                <p
                  className="mt-2.5 flex items-center gap-1.5 text-[11.5px] font-semibold text-md-success"
                  data-testid="md-payroll-bridge-reconciles"
                >
                  <CheckCircle2 size={14} aria-hidden /> The steps add up to the change exactly.
                </p>
              )}
            </div>
          </div>
          {cardNotes(bridge.notes).map((n) => (
            <NoteBanner key={n}>{n}</NoteBanner>
          ))}
        </div>
      )}
    </SectionCard>
  );
}

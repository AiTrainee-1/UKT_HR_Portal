import { Factory, Users, UserRound } from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import AskAiButton from "@/components/md/kit/AskAiButton";
import { axisStyle, gridProps, tooltipStyle } from "@/components/md/kit/chartTheme";
import { num, pct } from "@/lib/md/format";
import { cn } from "@/lib/utils";
import type { HomeEmployees } from "./home-types";
import GenderBreakdown from "./GenderBreakdown";
import { CountUp, Reveal } from "./motion";
import { CardState, HOME_COLORS, LegendDot, OverviewHeader } from "./parts";

/** One headline count: an icon tile, the figure counting up, and its share of the company. */
function Figure({
  label,
  value,
  share,
  tile,
  icon: Icon,
  testId,
}: {
  label: string;
  value: number;
  share?: number | null;
  tile: "wine" | "ink" | "sand";
  icon: typeof Users;
  testId: string;
}) {
  return (
    <div
      className="md-panel md-home-figure flex h-full items-center gap-2.5 rounded-2xl p-3 @lg:gap-3.5 @lg:p-4"
      data-testid={testId}
    >
      <span className={cn("md-dashboard-icon", `md-dashboard-icon-${tile}`)}>
        <Icon size={18} aria-hidden />
      </span>
      <div className="min-w-0">
        <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-md-ink-soft @lg:tracking-[0.12em]">
          {label}
        </p>
        <p className="md-dashboard-figure text-2xl font-black leading-tight text-md-ink @lg:text-3xl">
          <CountUp value={value} testId={`${testId}-value`} />
        </p>
        {share != null && (
          <p className="text-[11px] font-medium leading-tight text-md-ink-soft @lg:text-xs">
            {pct(share)} of all employees
          </p>
        )}
      </div>
    </div>
  );
}

/** A unit's share of the company as a bar (its staff and its production in their colours) and the percentage. */
function UnitShare({ staff, production, company }: { staff: number; production: number; company: number }) {
  const of = (n: number) => (company > 0 ? (100 * n) / company : 0);
  const share = of(staff + production);
  return (
    <div className="flex items-center gap-2" aria-label={`${pct(share)} of all employees`}>
      <div className="flex h-2 min-w-[72px] flex-1 overflow-hidden rounded-full bg-md-ink/[0.08]" aria-hidden>
        <div className="h-full" style={{ width: `${of(staff)}%`, backgroundColor: HOME_COLORS.staff }} />
        <div className="h-full" style={{ width: `${of(production)}%`, backgroundColor: HOME_COLORS.production }} />
      </div>
      <span className="w-12 shrink-0 text-right text-xs font-semibold tabular-nums text-md-ink-soft">{pct(share)}</span>
    </div>
  );
}

/**
 * Employee Overview: how many active employees the company has, staff against production (a ring), and every unit's
 * staff and production side by side (stacked bars, with the exact numbers in a table under them).
 */
export default function EmployeeOverview({
  data,
  loading,
  error,
  onRetry,
}: {
  data: HomeEmployees | undefined;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
}) {
  const units = data?.units ?? [];
  const split = data
    ? [
        { name: "Staff", value: data.staff, color: HOME_COLORS.staff },
        { name: "Production", value: data.production, color: HOME_COLORS.production },
      ].filter((s) => s.value > 0)
    : [];
  const chartHeight = Math.max(160, units.length * 46 + 30);

  return (
    <Reveal
      index={0}
      className="md-card md-dashboard-card @container"
      testId="md-home-employees"
      labelledBy="md-home-employees-title"
    >
      <OverviewHeader
        id="md-home-employees-title"
        title="Employee Overview"
        subtitle="Active employees: staff and production, and how they are spread across the units"
      >
        <AskAiButton question="How is our workforce split between staff and production in each unit?" />
      </OverviewHeader>

      {loading || error || !data ? (
        <CardState loading={loading || (!error && !data)} error={error} onRetry={onRetry} />
      ) : (
        <div className="grid grid-cols-1 items-start gap-6 @4xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
          <div className="space-y-3">
            <Figure label="Total employees" value={data.total} tile="sand" icon={Users} testId="md-home-total" />
            <div className="grid grid-cols-2 gap-3">
              <Figure
                label="Staff"
                value={data.staff}
                share={data.staffPct}
                tile="ink"
                icon={UserRound}
                testId="md-home-staff"
              />
              <Figure
                label="Production"
                value={data.production}
                share={data.productionPct}
                tile="wine"
                icon={Factory}
                testId="md-home-production"
              />
            </div>
            {split.length > 0 && (
              <div className="md-panel flex items-center gap-4 rounded-2xl p-3 @lg:p-4">
                <div
                  className="relative h-[112px] w-[112px] shrink-0 @lg:h-[132px] @lg:w-[132px]"
                  data-testid="md-home-split-ring"
                >
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={split}
                        dataKey="value"
                        nameKey="name"
                        innerRadius="66%"
                        outerRadius="96%"
                        paddingAngle={2.5}
                        cornerRadius={5}
                        stroke="none"
                      >
                        {split.map((s) => (
                          <Cell key={s.name} fill={s.color} />
                        ))}
                      </Pie>
                      <Tooltip contentStyle={tooltipStyle} formatter={(v, name) => [num(Number(v)), name]} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                    <span className="md-dashboard-figure text-xl font-black text-md-ink">{num(data.total)}</span>
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-md-ink-soft">people</span>
                  </div>
                </div>
                <ul className="min-w-0 flex-1 space-y-2 text-sm">
                  {split.map((s) => (
                    <li key={s.name} className="flex items-center justify-between gap-2">
                      <LegendDot color={s.color}>{s.name}</LegendDot>
                      <span className="font-bold tabular-nums text-md-ink">
                        {num(s.value)}{" "}
                        <span className="text-xs font-medium text-md-ink-soft">
                          ({pct((100 * s.value) / Math.max(1, data.total))})
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {data.gender && <GenderBreakdown gender={data.gender} />}
          </div>

          <div className="min-w-0">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-extrabold text-md-ink">By unit</h3>
              <div className="flex gap-3">
                <LegendDot color={HOME_COLORS.staff}>Staff</LegendDot>
                <LegendDot color={HOME_COLORS.production}>Production</LegendDot>
              </div>
            </div>
            {units.length === 0 ? (
              <p className="py-8 text-center text-sm text-md-ink-soft">No active employees yet.</p>
            ) : (
              <>
                <div style={{ height: chartHeight }} data-testid="md-home-units-chart">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={units}
                      layout="vertical"
                      margin={{ top: 4, right: 16, bottom: 4, left: 4 }}
                      barSize={22}
                    >
                      <CartesianGrid {...gridProps} horizontal={false} vertical />
                      <XAxis type="number" allowDecimals={false} tick={axisStyle} axisLine={false} tickLine={false} />
                      <YAxis
                        type="category"
                        dataKey="name"
                        width={96}
                        tick={axisStyle}
                        axisLine={false}
                        tickLine={false}
                      />
                      <Tooltip
                        contentStyle={tooltipStyle}
                        cursor={{ fill: "rgba(127, 1, 31, 0.05)" }}
                        formatter={(v, name) => [num(Number(v)), name === "staff" ? "Staff" : "Production"]}
                      />
                      <Bar dataKey="staff" stackId="people" fill={HOME_COLORS.staff} radius={[6, 0, 0, 6]} />
                      <Bar dataKey="production" stackId="people" fill={HOME_COLORS.production} radius={[0, 6, 6, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full text-sm" data-testid="md-home-units-table">
                    <thead>
                      <tr className="text-left text-[11px] font-bold uppercase tracking-wide text-md-ink-soft">
                        <th className="py-1.5 pr-3 font-bold">Unit</th>
                        <th className="py-1.5 pr-3 text-right font-bold">Staff</th>
                        <th className="py-1.5 pr-3 text-right font-bold">Production</th>
                        <th className="py-1.5 pr-3 text-right font-bold">Total</th>
                        <th className="hidden py-1.5 pl-2 text-left font-bold @lg:table-cell">Share of company</th>
                      </tr>
                    </thead>
                    <tbody>
                      {units.map((u) => (
                        <tr key={u.id ?? u.name} className="md-dashboard-row border-t border-md-ink/[0.06]">
                          <td className="py-2 pr-3 font-semibold text-md-ink">{u.name}</td>
                          <td className="py-2 pr-3 text-right tabular-nums text-md-ink">{num(u.staff)}</td>
                          <td className="py-2 pr-3 text-right tabular-nums text-md-ink">{num(u.production)}</td>
                          <td className="py-2 pr-3 text-right font-extrabold tabular-nums text-md-ink">
                            {num(u.total)}
                          </td>
                          <td className="hidden py-2 pl-2 @lg:table-cell">
                            <UnitShare staff={u.staff} production={u.production} company={data.total} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t-2 border-md-ink/15" data-testid="md-home-units-total">
                        <td className="py-2.5 pr-3 font-extrabold text-md-ink">All units</td>
                        <td className="py-2.5 pr-3 text-right font-extrabold tabular-nums text-md-ink">
                          {num(data.staff)}
                        </td>
                        <td className="py-2.5 pr-3 text-right font-extrabold tabular-nums text-md-ink">
                          {num(data.production)}
                        </td>
                        <td className="py-2.5 pr-3 text-right font-black tabular-nums text-md-wine">
                          {num(data.total)}
                        </td>
                        <td className="hidden py-2.5 pl-2 @lg:table-cell">
                          <UnitShare staff={data.staff} production={data.production} company={data.total} />
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </Reveal>
  );
}

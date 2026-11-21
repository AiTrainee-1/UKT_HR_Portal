import { useState } from "react";
import { Bar, BarChart, CartesianGrid, Line, LineChart, Tooltip, XAxis, YAxis } from "recharts";
import { BarChart3, Building2, LineChart as LineIcon } from "lucide-react";
import { EmptyNote, SectionCard } from "@/components/payroll/kit/parts";
import { ChartContainer } from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  LEVEL_META,
  MAX_TREND_SERIES,
  assignColors,
  defaultTrendKeys,
  departmentRows,
  distributionRows,
  shortLabel,
  weeklyRows,
} from "./logic";
import type { CategoryMeta, DepartmentRow, WeeklyPoint } from "./types";

// The charts of the page, in the attendance page's recharts style: thin marks, a dashed horizontal grid, small ticks,
// a tooltip of our own (the stock one hides a 0), a legend in words and the same numbers as a table for a screen reader.

const tick = { fontSize: 10 };
const clip = (s: string, n = 18) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A category / department name beside a horizontal bar: one line, cut short with an ellipsis (recharts would wrap it
 *  into a stack of fragments), the full name on hover. */
function NameTick({
  x,
  y,
  payload,
  short,
}: {
  x?: number;
  y?: number;
  payload?: { value?: string };
  short?: (v: string) => string;
}) {
  const full = String(payload?.value ?? "");
  return (
    <text x={x} y={y} dy={3} textAnchor="end" fontSize={10} className="fill-slate-500">
      <title>{full}</title>
      {clip(short ? short(full) : full, 20)}
    </text>
  );
}

type TooltipItem = { name?: string; value?: number; color?: string; payload?: Record<string, unknown> };

function ChartTooltip({
  active,
  payload,
  title,
}: {
  active?: boolean;
  payload?: TooltipItem[];
  title: (row: Record<string, unknown>) => string;
}) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload ?? {};
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs shadow-md">
      <p className="font-semibold text-slate-800">{title(row)}</p>
      {payload.map((p) => (
        <p key={p.name} className="mt-0.5 flex items-center gap-1.5 text-slate-600">
          <i className="inline-block h-2 w-2 rounded-sm" style={{ background: p.color }} />
          {p.name}: <b className="tabular-nums text-slate-900">{p.value ?? 0}</b>
        </p>
      ))}
    </div>
  );
}

/** Records per week for up to four categories the reader picks (the three busiest to begin with). */
export function WeeklyTrend({
  weekly,
  categories,
  loading,
}: {
  weekly: WeeklyPoint[];
  categories: CategoryMeta[];
  loading: boolean;
}) {
  const [picked, setPicked] = useState<string[] | null>(null);
  const [colors, setColors] = useState<Record<string, string>>({});
  const keys = (picked ?? defaultTrendKeys(categories)).filter((k) => categories.some((c) => c.key === k));
  const palette = assignColors(keys, colors);
  const rows = weeklyRows(weekly, keys);
  const labelOf = (k: string) => categories.find((c) => c.key === k)?.label ?? k;
  const offered = categories.filter((c) => c.total > 0 || keys.includes(c.key));

  const toggle = (key: string) => {
    const next = keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key].slice(-MAX_TREND_SERIES);
    setColors(assignColors(next, palette));
    setPicked(next);
  };

  return (
    <SectionCard
      title="Week by week"
      description={`Records per week (Monday to Sunday). Pick up to ${MAX_TREND_SERIES} categories to compare.`}
      icon={LineIcon}
      testId="chart-weekly"
      className="min-w-0"
    >
      {loading ? (
        <Skeleton className="h-56 w-full rounded-xl" />
      ) : weekly.length === 0 || offered.length === 0 ? (
        <EmptyNote icon={LineIcon} title="No records in this period" className="py-8" />
      ) : (
        <>
          <div className="mb-3 flex flex-wrap gap-1.5" role="group" aria-label="Categories in the chart">
            {offered.map((c) => {
              const on = keys.includes(c.key);
              return (
                <button
                  key={c.key}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggle(c.key)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300",
                    on
                      ? "border-slate-300 bg-white text-slate-800 shadow-sm"
                      : "border-slate-200 bg-slate-50 text-slate-500 hover:text-slate-800",
                  )}
                  data-testid={`trend-toggle-${c.key}`}
                >
                  <i
                    className="inline-block h-2.5 w-2.5 rounded-full"
                    style={{ background: on ? palette[c.key] : "#cbd5e1" }}
                    aria-hidden="true"
                  />
                  {shortLabel(c.label)}
                </button>
              );
            })}
          </div>
          {keys.length === 0 ? (
            <p className="rounded-xl border border-dashed border-slate-200 py-10 text-center text-sm text-slate-500">
              Pick a category above to draw its weeks.
            </p>
          ) : (
            <ChartContainer
              config={Object.fromEntries(keys.map((k) => [k, { label: labelOf(k), color: palette[k] }]))}
              className="aspect-auto h-56 w-full"
              role="img"
              aria-label={`Records per week for ${keys.map(labelOf).join(", ")}`}
            >
              <LineChart data={rows} margin={{ top: 8, right: 8, left: -4, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="label" tick={tick} interval="preserveStartEnd" minTickGap={14} />
                <YAxis allowDecimals={false} tick={tick} width={36} />
                <Tooltip
                  content={<ChartTooltip title={(r) => `Week of ${String(r.range ?? r.label)}`} />}
                  cursor={{ stroke: "#cbd5e1" }}
                />
                {keys.map((k) => (
                  <Line
                    key={k}
                    type="monotone"
                    dataKey={k}
                    name={shortLabel(labelOf(k))}
                    stroke={palette[k]}
                    strokeWidth={2}
                    dot={{ r: 3, strokeWidth: 2, fill: "#fff" }}
                    activeDot={{ r: 5 }}
                    isAnimationActive={false}
                  />
                ))}
              </LineChart>
            </ChartContainer>
          )}
          <div className="sr-only">
            <table>
              <caption>Records per week</caption>
              <thead>
                <tr>
                  <th>Week</th>
                  {keys.map((k) => (
                    <th key={k}>{labelOf(k)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={String(r.range)}>
                    <td>{r.range}</td>
                    {keys.map((k) => (
                      <td key={k}>{r[k]}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </SectionCard>
  );
}

/** Over the limit per category, high and attention apart; a bar opens the category. */
export function CategoryDistribution({
  categories,
  loading,
  onOpen,
}: {
  categories: CategoryMeta[];
  loading: boolean;
  onOpen: (key: string) => void;
}) {
  const rows = distributionRows(categories);
  const any = rows.some((r) => r.flagged > 0);
  return (
    <SectionCard
      title="Over the limit, by category"
      description="Employees at or over each limit; red = twice the limit."
      icon={BarChart3}
      testId="chart-distribution"
      className="min-w-0"
    >
      {loading ? (
        <Skeleton className="h-56 w-full rounded-xl" />
      ) : !any ? (
        <EmptyNote icon={BarChart3} title="Nobody is over a limit" className="py-8" />
      ) : (
        <>
          <ChartContainer
            config={{
              high: { label: "High", color: LEVEL_META.high.color },
              attention: { label: "Attention", color: LEVEL_META.attention.color },
            }}
            className="aspect-auto w-full"
            style={{ height: rows.length * 30 + 30 }}
            role="img"
            aria-label="Employees over the limit per category"
          >
            <BarChart
              data={rows}
              layout="vertical"
              margin={{ top: 0, right: 12, left: 0, bottom: 0 }}
              barCategoryGap="22%"
              maxBarSize={18}
            >
              <CartesianGrid strokeDasharray="3 3" horizontal={false} />
              <XAxis type="number" allowDecimals={false} tick={tick} />
              <YAxis type="category" dataKey="label" width={124} interval={0} tick={<NameTick short={shortLabel} />} />
              <Tooltip content={<ChartTooltip title={(r) => String(r.label)} />} cursor={{ fillOpacity: 0.06 }} />
              <Bar
                dataKey="high"
                name="High"
                stackId="a"
                fill={LEVEL_META.high.color}
                isAnimationActive={false}
                onClick={(d: { key?: string }) => d.key && onOpen(d.key)}
                className="cursor-pointer"
              />
              <Bar
                dataKey="attention"
                name="Attention"
                stackId="a"
                fill={LEVEL_META.attention.color}
                radius={[0, 4, 4, 0]}
                isAnimationActive={false}
                onClick={(d: { key?: string }) => d.key && onOpen(d.key)}
                className="cursor-pointer"
              />
            </BarChart>
          </ChartContainer>
          <Legend
            items={[
              { color: LEVEL_META.high.color, label: "High: twice the limit or more" },
              { color: LEVEL_META.attention.color, label: "Attention: at or over the limit" },
            ]}
          />
          <div className="sr-only">
            <table>
              <caption>Employees over the limit per category</caption>
              <thead>
                <tr>
                  <th>Category</th>
                  <th>High</th>
                  <th>Attention</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key}>
                    <td>{r.label}</td>
                    <td>{r.high}</td>
                    <td>{r.attention}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </SectionCard>
  );
}

const FLAGGED = "#4f46e5";
const OTHERS = "#e2e8f0";

/** Flagged employees per department against its headcount; a bar filters the page to the department. */
export function DepartmentChart({
  departments,
  loading,
  onPick,
}: {
  departments: DepartmentRow[];
  loading: boolean;
  onPick: (id: number) => void;
}) {
  const rows = departmentRows(departments, 12);
  return (
    <SectionCard
      title="Departments"
      description="Employees over a limit (indigo) out of everyone in scope. Click a bar to filter to the department."
      icon={Building2}
      testId="chart-departments"
      className="min-w-0"
    >
      {loading ? (
        <Skeleton className="h-56 w-full rounded-xl" />
      ) : rows.length === 0 ? (
        <EmptyNote icon={Building2} title="No department in scope" className="py-8" />
      ) : (
        <>
          <ChartContainer
            config={{ flagged: { label: "Over a limit", color: FLAGGED }, others: { label: "Others", color: OTHERS } }}
            className="aspect-auto w-full"
            style={{ height: rows.length * 30 + 30 }}
            role="img"
            aria-label="Employees over a limit per department"
          >
            <BarChart
              data={rows}
              layout="vertical"
              margin={{ top: 0, right: 12, left: 0, bottom: 0 }}
              barCategoryGap="22%"
              maxBarSize={18}
            >
              <CartesianGrid strokeDasharray="3 3" horizontal={false} />
              <XAxis type="number" allowDecimals={false} tick={tick} />
              <YAxis type="category" dataKey="name" width={124} interval={0} tick={<NameTick />} />
              <Tooltip
                content={<ChartTooltip title={(r) => `${String(r.name)}: ${String(r.employees)} in scope`} />}
                cursor={{ fillOpacity: 0.06 }}
              />
              <Bar
                dataKey="flagged"
                name="Over a limit"
                stackId="d"
                fill={FLAGGED}
                isAnimationActive={false}
                onClick={(d: { id?: number }) => d.id && onPick(d.id)}
                className="cursor-pointer"
              />
              <Bar
                dataKey="others"
                name="Others"
                stackId="d"
                fill={OTHERS}
                radius={[0, 4, 4, 0]}
                isAnimationActive={false}
                onClick={(d: { id?: number }) => d.id && onPick(d.id)}
                className="cursor-pointer"
              />
            </BarChart>
          </ChartContainer>
          <Legend
            items={[
              { color: FLAGGED, label: "Over a limit" },
              { color: OTHERS, label: "Everyone else in scope" },
            ]}
          />
          <div className="sr-only">
            <table>
              <caption>Employees over a limit per department</caption>
              <thead>
                <tr>
                  <th>Department</th>
                  <th>Over a limit</th>
                  <th>In scope</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>{r.name}</td>
                    <td>{r.flagged}</td>
                    <td>{r.employees}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </SectionCard>
  );
}

function Legend({ items }: { items: { color: string; label: string }[] }) {
  return (
    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-500">
      {items.map((i) => (
        <span key={i.label} className="flex items-center gap-1.5">
          <i className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: i.color }} aria-hidden="true" />
          {i.label}
        </span>
      ))}
    </div>
  );
}

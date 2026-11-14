import { memo, useMemo } from "react";
import { Bar, BarChart, CartesianGrid, Cell, Tooltip, XAxis, YAxis } from "recharts";
import { CalendarRange, FileSpreadsheet, FileText } from "lucide-react";
import { fetchMonthlyAttendanceSummary, useListHolidays, type TrendPoint } from "@/lib/api-client/custom-hooks";
import { ExportMenu } from "@/components/payroll/kit/ExportMenu";
import { ChartContainer } from "@/components/ui/chart";
import { Input } from "@/components/ui/input";
import { useCompany } from "../report-log/useCompany";
import { BOARD_META, shortDate } from "./logic";
import { prefersReducedMotion } from "./useCountUp";
import { usePhone } from "./usePhone";

export const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_FULL = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const PRESENT = BOARD_META.present.hex;
const NOT_IN = BOARD_META.absent.hex;
/** Sundays and holidays: nobody is expected in, so their bar is grey and they stay out of the figures below the chart. */
const OFF_DAY = "#94a3b8";

type MonthPoint = TrendPoint & { offDay: string | null };

/** "Sunday" or the holiday's name for a day nobody is expected in, else null. A Sunday holiday is named by the holiday. */
export function offDayLabel(date: string, holidayNames: Map<string, string>): string | null {
  const named = holidayNames.get(date);
  if (named) return named;
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d).getDay() === 0 ? "Sunday" : null;
}

/** Average, best and lowest present count over the month's working days (Sundays and holidays left out). */
export function monthFigures(points: MonthPoint[]) {
  const days = points.filter((d) => !d.offDay && d.present + d.absent > 0);
  if (days.length === 0) return null;
  const avg = Math.round(days.reduce((a, d) => a + d.present, 0) / days.length);
  const best = days.reduce((a, d) => (d.present > a.present ? d : a), days[0]);
  const low = days.reduce((a, d) => (d.present < a.present ? d : a), days[0]);
  return { avg, best, low, workingDays: days.length };
}

function TrendTooltip({ active, payload }: { active?: boolean; payload?: { payload: MonthPoint }[] }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  const total = p.present + p.absent;
  if (p.offDay) {
    return (
      <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs shadow-md">
        <p className="font-semibold text-slate-800">{shortDate(p.date)}</p>
        <p className="mt-0.5 text-slate-600">{p.offDay}, day off</p>
        <p className="text-slate-600">
          <span className="font-semibold tabular-nums text-slate-900">{p.present}</span> came in
        </p>
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs shadow-md">
      <p className="font-semibold text-slate-800">{shortDate(p.date)}</p>
      <p className="mt-0.5 text-slate-600">
        <span className="font-semibold tabular-nums text-slate-900">{p.present}</span> present
        {total > 0 ? ` (${Math.round((p.present * 100) / total)}%)` : ""}
      </p>
      <p className="text-slate-600">
        <span className="font-semibold tabular-nums text-slate-900">{p.absent}</span> not in
      </p>
    </div>
  );
}

/** The month: present against not-in for every day so far, a few figures, and the monthly report per employee. */
export const MonthPanel = memo(function MonthPanel({
  trend,
  month,
  year,
  onMonth,
  onYear,
  view,
}: {
  trend: TrendPoint[];
  month: number;
  year: number;
  onMonth: (m: number) => void;
  onYear: (y: number) => void;
  view: "staff" | "production";
}) {
  const company = useCompany();
  const { data: holidays } = useListHolidays({ year });
  const points = useMemo<MonthPoint[]>(() => {
    const names = new Map((holidays ?? []).map((h) => [h.date, h.name] as const));
    return trend.map((d) => ({ ...d, offDay: offDayLabel(d.date, names) }));
  }, [trend, holidays]);
  const figures = useMemo(() => monthFigures(points), [points]);
  // phones: 11 px ticks and at most six day labels (every n-th day), so they stay apart on a narrow chart
  const phone = usePhone();
  const tick = { fontSize: phone ? 11 : 10 };
  const dayInterval = phone ? Math.max(0, Math.ceil(points.length / 6) - 1) : "preserveStartEnd";

  const monthExport = async (kind: "xlsx" | "pdf") => {
    const summary = await fetchMonthlyAttendanceSummary(year, month, view);
    const mod = await import("./export");
    const input = {
      ...company.excel,
      year,
      month,
      view,
      asOf: summary.asOf,
      rows: summary.rows,
      now: new Date(),
    };
    if (kind === "xlsx") await mod.downloadMonthExcel(input);
    else await mod.downloadMonthPdf(input);
  };

  return (
    <section
      className="clay-card min-w-0 rounded-2xl border border-slate-100 bg-white p-3.5 sm:p-5"
      aria-labelledby="month-title"
      data-testid="attendance-month"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          <span className="mt-0.5 rounded-lg bg-slate-50 p-1.5 text-slate-600 ring-1 ring-slate-100">
            <CalendarRange size={14} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h3 id="month-title" className="text-sm font-bold text-slate-900">
              {MONTH_FULL[month - 1]} {year}
            </h3>
            <p className="text-xs text-slate-500">Present and not in, day by day. Sundays and holidays are grey</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <select
            value={month}
            onChange={(e) => onMonth(Number(e.target.value))}
            aria-label="Month"
            className="h-9 rounded-lg border border-slate-200 bg-white px-1.5 text-xs sm:h-8"
          >
            {MONTH_NAMES.map((m, i) => (
              <option key={m} value={i + 1}>
                {m}
              </option>
            ))}
          </select>
          <Input
            type="number"
            value={year}
            onChange={(e) => onYear(Number(e.target.value))}
            aria-label="Year"
            className="h-9 w-20 text-xs sm:h-8"
            min={2020}
            max={2035}
          />
          <ExportMenu
            testId="month-export-menu"
            label="Monthly report"
            heading={`Every ${view === "staff" ? "staff member" : "production employee"}, ${MONTH_NAMES[month - 1]} ${year}`}
            items={[
              {
                key: "month-xlsx",
                label: "Excel",
                hint: "Present, absent, half day, leave, CL, on duty and late per person",
                icon: FileSpreadsheet,
                run: () => monthExport("xlsx"),
              },
              {
                key: "month-pdf",
                label: "PDF",
                hint: "A4 landscape with the totals",
                icon: FileText,
                run: () => monthExport("pdf"),
              },
            ]}
          />
        </div>
      </div>

      <div className="mt-3">
        {trend.length > 0 ? (
          <ChartContainer config={{ present: { color: PRESENT }, absent: { color: NOT_IN } }} className="h-52 w-full">
            <BarChart data={points} margin={{ top: 4, right: 4, left: -20, bottom: 0 }} barCategoryGap="22%">
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="day" tick={tick} interval={dayInterval} minTickGap={10} />
              <YAxis allowDecimals={false} tick={tick} />
              <Tooltip content={<TrendTooltip />} cursor={{ fillOpacity: 0.06 }} />
              <Bar
                dataKey="present"
                stackId="a"
                fill={PRESENT}
                name="Present"
                maxBarSize={28}
                isAnimationActive={!prefersReducedMotion()}
              >
                {points.map((p) => (
                  <Cell key={p.date} fill={p.offDay ? OFF_DAY : PRESENT} />
                ))}
              </Bar>
              <Bar
                dataKey="absent"
                stackId="a"
                fill={NOT_IN}
                fillOpacity={0.35}
                name="Not in"
                radius={[3, 3, 0, 0]}
                maxBarSize={28}
                isAnimationActive={!prefersReducedMotion()}
              >
                {points.map((p) => (
                  <Cell key={p.date} fill={p.offDay ? OFF_DAY : NOT_IN} fillOpacity={p.offDay ? 0.18 : 0.35} />
                ))}
              </Bar>
            </BarChart>
          </ChartContainer>
        ) : (
          <div className="flex h-52 items-center justify-center rounded-xl border border-dashed border-slate-200 text-sm text-slate-500">
            No days yet in {MONTH_NAMES[month - 1]} {year}
          </div>
        )}
      </div>

      {figures && (
        <dl
          className="mt-3 grid grid-cols-3 gap-2 border-t border-slate-100 pt-3 text-center"
          data-testid="month-figures"
        >
          <div>
            <dd className="text-sm font-bold tabular-nums text-slate-900">{figures.avg}</dd>
            <dt className="text-[11px] text-slate-500">
              Present on an average working day ({figures.workingDays} so far)
            </dt>
          </div>
          <div>
            <dd className="text-sm font-bold tabular-nums text-slate-900">{figures.best.present}</dd>
            <dt className="text-[11px] text-slate-500">Best day, {shortDate(figures.best.date)}</dt>
          </div>
          <div>
            <dd className="text-sm font-bold tabular-nums text-slate-900">{figures.low.present}</dd>
            <dt className="text-[11px] text-slate-500">Lowest day, {shortDate(figures.low.date)}</dt>
          </div>
        </dl>
      )}
    </section>
  );
});

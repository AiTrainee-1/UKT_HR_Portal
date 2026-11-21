import { ArrowDownRight, ArrowUpRight, ClipboardList, IndianRupee, UserCheck, Users } from "lucide-react";
import { Link } from "wouter";
import { prefetchProps } from "@/components/md/shell/prefetch";
import { inrCompact, num, pct, signed } from "@/lib/md/format";
import { cn } from "@/lib/utils";
import { currentAndPrevious } from "./home-logic";
import type { DashboardHome } from "./home-types";
import { CountUp } from "./motion";

type Tone = "wine" | "ink" | "sand";

/** One headline figure: what it is, the figure, a line of context, and the page it opens (with the month applied). */
function Kpi({
  label,
  value,
  format,
  sub,
  href,
  icon: Icon,
  tone,
  change,
  testId,
}: {
  label: string;
  value: number;
  format?: (n: number) => string;
  sub: string;
  href: string;
  icon: typeof Users;
  tone: Tone;
  change?: number | null;
  testId: string;
}) {
  return (
    <div className={cn("md-card md-dashboard-kpi", tone !== "wine" && `md-dashboard-kpi-${tone}`)} data-testid={testId}>
      <Link href={href} {...prefetchProps(href)} className="md-dashboard-kpi-link" data-testid={`${testId}-link`}>
        <div className="flex items-start justify-between gap-2">
          <span className={cn("md-dashboard-icon md-dashboard-icon-sm", `md-dashboard-icon-${tone}`)}>
            <Icon size={15} aria-hidden />
          </span>
          <ArrowUpRight size={15} className="md-dashboard-kpi-arrow" aria-hidden />
        </div>
        <p className="mt-3 text-[11px] font-bold uppercase tracking-[0.08em] text-md-ink-soft">{label}</p>
        <p className="md-dashboard-figure mt-1 flex flex-wrap items-baseline gap-x-2 text-2xl font-black leading-none text-md-ink @lg:text-3xl">
          <CountUp value={value} format={format} testId={`${testId}-value`} />
          {change != null && (
            <span className="inline-flex items-center gap-0.5 text-xs font-bold text-md-ink-soft">
              {change < 0 ? <ArrowDownRight size={12} aria-hidden /> : <ArrowUpRight size={12} aria-hidden />}
              {signed(change)}%
            </span>
          )}
        </p>
        <p className="mt-1.5 line-clamp-2 text-[11px] font-medium leading-snug text-md-ink-soft @lg:text-xs">{sub}</p>
      </Link>
    </div>
  );
}

/** The four figures under the welcome card, each a door to its page: the people, attendance (today, or the chosen
 *  month's share), the month's pay against the month before, and the requests waiting. Placeholders of the same size
 *  while the answer is on its way, so nothing below moves when it lands. */
export default function KpiBand({ data, month }: { data: DashboardHome | undefined; month: string | null }) {
  if (!data) {
    return (
      <div className="grid grid-cols-2 gap-3 @4xl:grid-cols-4" aria-busy="true" data-testid="md-home-kpis">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="md-dashboard-skeleton h-[132px] rounded-[1.25rem] motion-safe:animate-pulse @lg:h-[142px]"
          />
        ))}
      </div>
    );
  }
  const att = data.attendance;
  const chosen = att.month && !att.month.current ? att.month : null;
  const pair = currentAndPrevious(data.payroll.months);
  const pay = pair.current;
  const waiting = data.waiting;
  const payHref = month ? `/md/payroll?month=${month}` : "/md/payroll";
  return (
    <div className="grid grid-cols-2 gap-3 @4xl:grid-cols-4" data-testid="md-home-kpis">
      <Kpi
        label="Employees"
        value={data.employees.total}
        sub={`${num(data.employees.staff)} staff · ${num(data.employees.production)} production, active now`}
        href="/md/employees"
        icon={Users}
        tone="sand"
        testId="md-home-kpi-employees"
      />
      {chosen ? (
        <Kpi
          label={`Present · ${chosen.label.split(" ")[0]}`}
          value={chosen.presentPct ?? 0}
          format={(n) => `${n.toFixed(1)}%`}
          sub={`${num(chosen.present)} of ${num(chosen.expected)} person-days; ${num(chosen.cl)} CL`}
          href="/md/attendance/staff"
          icon={UserCheck}
          tone="ink"
          testId="md-home-kpi-attendance"
        />
      ) : (
        <Kpi
          label="Present today"
          value={att.present}
          sub={`${pct(att.presentPct)} of ${num(att.expected)} due · ${num(att.absent)} absent, ${num(att.cl)} CL`}
          href="/md/attendance/staff"
          icon={UserCheck}
          tone="ink"
          testId="md-home-kpi-attendance"
        />
      )}
      <Kpi
        label={`Gross pay · ${pay?.label.split(" ")[0] ?? "this month"}`}
        value={pay?.figures?.grossPay ?? 0}
        format={(n) => inrCompact(Math.round(n))}
        change={pair.grossChange}
        sub={
          pay?.figures
            ? `${num(pay.figures.headcount)} people paid · ${pay.stateLabel}`
            : "No payroll generated for this month yet"
        }
        href={payHref}
        icon={IndianRupee}
        tone="wine"
        testId="md-home-kpi-payroll"
      />
      <Kpi
        label="Requests waiting"
        value={waiting?.total ?? 0}
        sub={
          waiting
            ? `${num(waiting.leave)} leave · ${num(waiting.permission)} permission · ${num(waiting.outpass)} gate pass`
            : "Leave, permission and gate pass"
        }
        href="/md/requests"
        icon={ClipboardList}
        tone="sand"
        testId="md-home-kpi-waiting"
      />
    </div>
  );
}

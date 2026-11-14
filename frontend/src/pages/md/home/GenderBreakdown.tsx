import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { CHART, tooltipStyle } from "@/components/md/kit/chartTheme";
import { num, pct } from "@/lib/md/format";
import type { GenderCounts, HomeGender } from "./home-types";
import { LegendDot } from "./parts";

/** One colour per answer, kept apart from staff (indigo) and production (wine) so the two splits are never confused. */
export const GENDER_SEGMENTS: { key: keyof Omit<GenderCounts, "total">; label: string; color: string }[] = [
  { key: "male", label: "Men", color: CHART.info },
  { key: "female", label: "Women", color: CHART.sky },
  { key: "other", label: "Other", color: CHART.gold },
  { key: "notRecorded", label: "Not recorded", color: CHART.slate },
];

const GROUPS: { key: keyof HomeGender; label: string }[] = [
  { key: "staff", label: "Staff" },
  { key: "production", label: "Production" },
  { key: "all", label: "Everyone" },
];

const share = (n: number, total: number) => (total > 0 ? (100 * n) / total : 0);

/** One group as a donut: its people in the middle, each answer a slice (hover for the figure), the counts under it. */
function GenderDonut({ label, counts }: { label: string; counts: GenderCounts }) {
  const slices = GENDER_SEGMENTS.filter((s) => counts[s.key] > 0).map((s) => ({
    name: s.label,
    value: counts[s.key],
    color: s.color,
  }));
  return (
    <li className="flex min-w-0 flex-col items-center gap-2" data-testid={`md-home-gender-${label.toLowerCase()}`}>
      <p className="text-sm font-extrabold text-md-ink">{label}</p>
      <div
        className="relative h-[84px] w-[84px] @[24rem]:h-[112px] @[24rem]:w-[112px]"
        role="img"
        aria-label={`${label}: ${slices.map((s) => `${num(s.value)} ${s.name.toLowerCase()}`).join(", ") || "nobody"}`}
      >
        {slices.length > 0 ? (
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={slices}
                dataKey="value"
                nameKey="name"
                innerRadius="64%"
                outerRadius="96%"
                paddingAngle={slices.length > 1 ? 3 : 0}
                cornerRadius={4}
                stroke="none"
                startAngle={90}
                endAngle={-270}
              >
                {slices.map((s) => (
                  <Cell key={s.name} fill={s.color} />
                ))}
              </Pie>
              <Tooltip
                contentStyle={tooltipStyle}
                formatter={(v, name) => [`${num(Number(v))} (${pct(share(Number(v), counts.total))})`, name]}
              />
            </PieChart>
          </ResponsiveContainer>
        ) : (
          <div className="h-full w-full rounded-full border-[10px] border-md-ink/[0.08]" />
        )}
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="md-dashboard-figure text-lg font-black leading-none text-md-ink">{num(counts.total)}</span>
          <span className="mt-0.5 hidden text-[11px] font-semibold uppercase tracking-wide text-md-ink-soft @[24rem]:block">
            people
          </span>
        </div>
      </div>
      <ul className="w-full space-y-0.5 text-[11px] @[24rem]:text-[11.5px]">
        {slices.length === 0 ? (
          <li className="text-center text-md-ink-soft">Nobody yet</li>
        ) : (
          slices.map((s) => (
            <li key={s.name} className="flex items-center justify-between gap-1.5 tabular-nums">
              <span className="inline-flex min-w-0 items-center gap-1.5 text-md-ink-soft">
                <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: s.color }} />
                <span className="truncate">{s.name}</span>
              </span>
              <span className="shrink-0 text-md-ink-soft">
                <b className="font-extrabold text-md-ink">{num(s.value)}</b>{" "}
                <span className="hidden @[24rem]:inline">{pct(share(s.value, counts.total))}</span>
              </span>
            </li>
          ))
        )}
      </ul>
    </li>
  );
}

/**
 * "Gender": men and women among the active staff, the production workers and everyone, as three donuts side by side
 * (owner 2026-11-13: the space under the staff / production ring, and as pie / donut charts). "Not recorded" appears
 * only when somebody has no gender set.
 */
export default function GenderBreakdown({ gender }: { gender: HomeGender }) {
  const used = GENDER_SEGMENTS.filter((s) => gender.all[s.key] > 0);
  return (
    <div className="md-panel @container rounded-2xl p-3 @[24rem]:p-4" data-testid="md-home-gender">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-extrabold text-md-ink">Gender</h3>
        <div className="flex flex-wrap gap-3">
          {used.map((s) => (
            <LegendDot key={s.key} color={s.color}>
              {s.label}
            </LegendDot>
          ))}
        </div>
      </div>
      <ul className="grid grid-cols-3 gap-2 @[22rem]:gap-3">
        {GROUPS.map((g) => (
          <GenderDonut key={g.key} label={g.label} counts={gender[g.key]} />
        ))}
      </ul>
    </div>
  );
}

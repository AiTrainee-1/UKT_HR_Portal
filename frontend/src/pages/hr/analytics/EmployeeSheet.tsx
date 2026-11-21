import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowLeft, FileSpreadsheet, FileText, History, Repeat, Target } from "lucide-react";
import { Chip, EmptyNote, SkeletonRows } from "@/components/payroll/kit/parts";
import { ExportMenu } from "@/components/payroll/kit/ExportMenu";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import type { ExportCompany } from "../attendance/export";
import { errorText, useAnalyticsEmployee } from "./api";
import {
  dateShort,
  groupByMonth,
  num1,
  orderedCategoryKeys,
  patternExtras,
  patternNote,
  plural,
  shortLabel,
  thresholdText,
} from "./logic";
import { LevelChip, LimitBar, PersonAvatar, RecordItem, WeekdayBars, categoryIcon } from "./parts";
import type { EmployeeCategory, EmployeeDetail } from "./types";

type View = "timeline" | "patterns";

const TIMELINE_AT_ONCE = 60;

/** Each category with records: count against the limit; the ones without records named on one line. */
function AgainstLimits({ detail, onOpenCategory }: { detail: EmployeeDetail; onOpenCategory?: (key: string) => void }) {
  const keys = orderedCategoryKeys(detail.categories);
  const hit = keys.filter((k) => detail.categories[k].count > 0);
  const quiet = keys.filter((k) => detail.categories[k].count === 0);
  return (
    <section aria-label="Against each limit" className="space-y-2" data-testid="employee-limits">
      <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">
        <Target size={12} /> Against each limit
      </p>
      <ul className="space-y-1.5">
        {hit.map((k) => {
          const c = detail.categories[k];
          const Icon = categoryIcon(k);
          return (
            <li
              key={k}
              className="rounded-xl border border-slate-100 bg-white px-3 py-2.5"
              data-testid={`employee-limit-${k}`}
            >
              <div className="flex items-center gap-2">
                <Icon size={14} className="shrink-0 text-slate-500" />
                {onOpenCategory ? (
                  <button
                    type="button"
                    onClick={() => onOpenCategory(k)}
                    className="min-w-0 flex-1 truncate text-left text-[13px] font-semibold text-slate-800 hover:text-indigo-700"
                  >
                    {c.category.label}
                  </button>
                ) : (
                  <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-slate-800">
                    {c.category.label}
                  </span>
                )}
                {c.category.informational ? (
                  <Chip tone="accent">For reference</Chip>
                ) : c.count >= c.category.threshold * 2 ? (
                  <Chip tone="danger">Twice the limit</Chip>
                ) : c.flagged ? (
                  <Chip tone="warning">Over the limit</Chip>
                ) : (
                  <Chip tone="info">Under the limit</Chip>
                )}
              </div>
              <div className="mt-2 flex items-center gap-2">
                <LimitBar count={c.count} category={c.category} className="flex-1" />
                <span className="shrink-0 text-xs tabular-nums text-slate-600">
                  <b className="text-slate-900">{c.count}</b>
                  {c.category.informational ? "" : ` / ${num1(c.category.threshold)}`} {c.category.unit}
                </span>
              </div>
              <p className="mt-1 text-[11px] text-slate-400">{thresholdText(c.category)}</p>
            </li>
          );
        })}
      </ul>
      {quiet.length > 0 && (
        <p className="text-[11px] leading-relaxed text-slate-500">
          No records in: {quiet.map((k) => shortLabel(detail.categories[k].category.label)).join(", ")}.
        </p>
      )}
    </section>
  );
}

function PatternCard({ c }: { c: EmployeeCategory }) {
  const Icon = categoryIcon(c.category.key);
  const note = patternNote(c.pattern);
  const extras = patternExtras(c.pattern);
  return (
    <li className="rounded-xl border border-slate-100 bg-white p-3" data-testid={`pattern-${c.category.key}`}>
      <div className="flex items-center gap-2">
        <Icon size={14} className="text-slate-500" />
        <p className="min-w-0 flex-1 truncate text-[13px] font-semibold text-slate-800">{c.category.label}</p>
        <span className="text-xs font-bold tabular-nums text-slate-700">
          {plural(c.count, c.category.unit.replace(/s$/, ""), c.category.unit)}
        </span>
      </div>
      <div className="mt-2 grid gap-3 sm:grid-cols-[1fr_auto]">
        <WeekdayBars pattern={c.pattern} />
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:w-48 sm:grid-cols-1">
          <div className="flex justify-between gap-2">
            <dt className="text-slate-500">Longest run</dt>
            <dd className="font-semibold tabular-nums text-slate-800">{plural(c.pattern.longestStreak, "day")}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-slate-500">Last date</dt>
            <dd className="font-semibold tabular-nums text-slate-800">{dateShort(c.pattern.lastDate)}</dd>
          </div>
          {extras.map((x) => (
            <div key={x.label} className="flex justify-between gap-2">
              <dt className="text-slate-500">{x.label}</dt>
              <dd className="font-semibold tabular-nums text-slate-800">{x.value}</dd>
            </div>
          ))}
        </dl>
      </div>
      {note && (
        <p className="mt-2 flex items-center gap-1.5 text-xs font-semibold text-indigo-700">
          <Repeat size={12} /> {note}
        </p>
      )}
    </li>
  );
}

function Timeline({ detail }: { detail: EmployeeDetail }) {
  const [only, setOnly] = useState<string | null>(null);
  const [limit, setLimit] = useState(TIMELINE_AT_ONCE);
  const keys = orderedCategoryKeys(detail.categories).filter((k) => detail.categories[k].count > 0);
  const records = useMemo(() => detail.timeline.filter((r) => !only || r.category === only), [detail.timeline, only]);
  const groups = groupByMonth(records.slice(0, limit));
  return (
    <div className="space-y-3" data-testid="employee-timeline">
      {keys.length > 1 && (
        <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1" role="group" aria-label="Show records of">
          {[null, ...keys].map((k) => {
            const on = only === k;
            return (
              <button
                key={k ?? "all"}
                type="button"
                aria-pressed={on}
                onClick={() => {
                  setOnly(k);
                  setLimit(TIMELINE_AT_ONCE);
                }}
                className={cn(
                  "shrink-0 whitespace-nowrap rounded-full border px-2.5 py-1 text-[11px] font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300",
                  on ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white text-slate-600",
                )}
                data-testid={`timeline-filter-${k ?? "all"}`}
              >
                {k
                  ? `${shortLabel(detail.categories[k].category.label)} ${detail.categories[k].count}`
                  : `All ${detail.timeline.length}`}
              </button>
            );
          })}
        </div>
      )}
      {records.length === 0 ? (
        <EmptyNote icon={History} title="No records in this period" className="py-8" />
      ) : (
        groups.map((g) => (
          <section key={g.month} aria-label={g.month}>
            <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">
              {g.month} <span className="font-semibold normal-case tracking-normal">({g.items.length})</span>
            </p>
            <ol className="space-y-1.5">
              {g.items.map((r, i) => (
                <RecordItem
                  key={`${r.category}-${r.date}-${i}`}
                  record={r}
                  category={{ key: r.category, label: detail.categories[r.category]?.category.label ?? r.category }}
                />
              ))}
            </ol>
          </section>
        ))
      )}
      {records.length > limit && (
        <Button variant="outline" className="w-full" onClick={() => setLimit((n) => n + TIMELINE_AT_ONCE)}>
          Show {Math.min(TIMELINE_AT_ONCE, records.length - limit)} more of {records.length - limit}
        </Button>
      )}
    </div>
  );
}

/** One employee in full: level and score, each count against its limit, every record on a timeline, the patterns, and
 *  their own Excel / PDF. */
export function EmployeeSheet({
  employeeId,
  params,
  company,
  backTo,
  onBack,
  onClose,
  onOpenCategory,
}: {
  employeeId: number | null;
  params: Record<string, string>;
  company: ExportCompany;
  /** The category this was opened from: a Back button returns to it. */
  backTo?: string | null;
  onBack?: () => void;
  onClose: () => void;
  onOpenCategory?: (key: string) => void;
}) {
  const { data, isLoading, isError, error, refetch } = useAnalyticsEmployee(employeeId, params);
  const [view, setView] = useState<View>("timeline");
  useEffect(() => setView("timeline"), [employeeId]);
  const patterns = data
    ? orderedCategoryKeys(data.categories)
        .map((k) => data.categories[k])
        .filter((c) => c.count > 0)
    : [];
  const e = data?.employee;

  return (
    <Sheet open={employeeId !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        className="w-full overflow-y-auto bg-slate-50 p-0 sm:max-w-2xl [&>[data-slot=sheet-close]]:z-20"
        data-testid="employee-sheet"
      >
        {isError ? (
          <div className="space-y-3 p-6 pt-10">
            <SheetTitle className="text-base">Employee</SheetTitle>
            <SheetDescription className="sr-only">The employee could not be loaded</SheetDescription>
            <EmptyNote
              icon={AlertTriangle}
              title="This employee could not be loaded"
              hint={errorText(error)}
              action={
                <Button variant="outline" size="sm" onClick={() => refetch()}>
                  Retry
                </Button>
              }
            />
          </div>
        ) : isLoading || !data || !e ? (
          <div className="space-y-4 p-6 pt-10">
            <SheetTitle className="sr-only">Loading the employee</SheetTitle>
            <SheetDescription className="sr-only">Loading every record of the employee</SheetDescription>
            <SkeletonRows rows={6} />
          </div>
        ) : (
          <>
            <div className="sticky top-0 z-10 border-b border-slate-100 bg-white/95 px-5 pb-4 pt-5 backdrop-blur">
              {backTo && onBack && (
                <button
                  type="button"
                  onClick={onBack}
                  className="mb-2 inline-flex items-center gap-1 rounded text-xs font-semibold text-indigo-700 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300"
                  data-testid="employee-back"
                >
                  <ArrowLeft size={12} /> Back to {backTo}
                </button>
              )}
              <SheetHeader className="space-y-0 pr-8 text-left">
                <div className="flex items-center gap-3">
                  <PersonAvatar name={e.name} photoUrl={e.photoUrl} size={48} />
                  <div className="min-w-0 flex-1">
                    <SheetTitle className="truncate text-base">{e.name}</SheetTitle>
                    <SheetDescription className="truncate text-xs">
                      <span className="font-mono">{e.code}</span>
                      {[e.designation, e.department, e.branch].filter(Boolean).map((t) => ` · ${t}`)}
                    </SheetDescription>
                  </div>
                </div>
              </SheetHeader>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <LevelChip level={data.level} />
                <Chip tone="neutral">Score {num1(data.score)}</Chip>
                <Chip tone={data.flags.length ? "warning" : "neutral"}>
                  Over the limit in {plural(data.flags.length, "category", "categories")}
                </Chip>
                <span className="text-[11px] text-slate-500">{data.period.label}</span>
                <div className="ml-auto">
                  <ExportMenu
                    testId="employee-export"
                    heading={`${e.name} · ${data.period.label}`}
                    items={[
                      {
                        key: "xlsx",
                        label: "Excel (.xlsx)",
                        hint: "Counts against each limit with the patterns, and every record",
                        icon: FileSpreadsheet,
                        run: async () =>
                          (await import("./export")).downloadEmployeeExcel({
                            ...company,
                            detail: data,
                            now: new Date(),
                          }),
                      },
                      {
                        key: "pdf",
                        label: "PDF",
                        hint: "A4 landscape, for printing",
                        icon: FileText,
                        run: async () =>
                          (await import("./export")).downloadEmployeePdf({ ...company, detail: data, now: new Date() }),
                      },
                    ]}
                  />
                </div>
              </div>
            </div>

            <div className="space-y-5 p-4 sm:p-5">
              <AgainstLimits detail={data} onOpenCategory={onOpenCategory} />

              <div>
                <div
                  className="mb-3 inline-flex rounded-xl border border-slate-200 bg-white p-1"
                  role="tablist"
                  aria-label="Records or patterns"
                >
                  {(
                    [
                      ["timeline", `Timeline (${data.timeline.length})`],
                      ["patterns", `Patterns (${patterns.length})`],
                    ] as const
                  ).map(([v, label]) => (
                    <button
                      key={v}
                      type="button"
                      role="tab"
                      aria-selected={view === v}
                      onClick={() => setView(v)}
                      className={cn(
                        "rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300",
                        view === v ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100",
                      )}
                      data-testid={`employee-view-${v}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {view === "timeline" ? (
                  <Timeline detail={data} />
                ) : patterns.length === 0 ? (
                  <EmptyNote icon={Repeat} title="No pattern: no records in this period" className="py-8" />
                ) : (
                  <ul className="space-y-2" data-testid="employee-patterns">
                    {patterns.map((c) => (
                      <PatternCard key={c.category.key} c={c} />
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

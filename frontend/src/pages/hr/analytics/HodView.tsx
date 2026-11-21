import { useMemo, useState } from "react";
import { Hourglass, UserCog } from "lucide-react";
import { Chip, EmptyNote, SectionCard, SkeletonRows } from "@/components/payroll/kit/parts";
import { cn } from "@/lib/utils";
import { DEFAULT_HOD_SORT, hodNeedsLook, hoursText, pct, sortHods, type HodSort, type HodSortKey } from "./logic";
import { PersonAvatar, SortHeader } from "./parts";
import type { HodRow } from "./types";

const FIRST: Record<HodSortKey, HodSort["dir"]> = {
  name: "asc",
  decided: "desc",
  rejectionRate: "desc",
  avgResponseHours: "desc",
  waitingNow: "desc",
  waitingLong: "desc",
  oldestWaitingHours: "desc",
};

function RateBar({ rate }: { rate: number }) {
  const value = Math.round(Math.min(1, Math.max(0, rate)) * 100);
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-slate-100" aria-hidden="true">
        <div
          className={cn(
            "h-full rounded-full",
            rate >= 0.4 ? "bg-red-500" : rate >= 0.2 ? "bg-amber-500" : "bg-emerald-500",
          )}
          style={{ width: `${value}%` }}
        />
      </div>
      <span className="text-xs font-semibold tabular-nums text-slate-700">{pct(rate)}</span>
    </div>
  );
}

function Waiting({ h }: { h: HodRow }) {
  if (h.waitingNow === 0) return <span className="text-xs text-slate-400">Nothing waiting</span>;
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="text-sm font-bold tabular-nums text-slate-800">{h.waitingNow}</span>
      {h.waitingLong > 0 ? (
        <Chip tone="warning" icon={Hourglass}>
          {h.waitingLong} over 2 days
        </Chip>
      ) : (
        <Chip tone="neutral">all recent</Chip>
      )}
    </div>
  );
}

/** Staff only: how each Department Head handles requests (decided, rejected, how fast) and what waits with them now. */
export function HodView({ hods, loading }: { hods: HodRow[]; loading: boolean }) {
  const [sort, setSort] = useState<HodSort>(DEFAULT_HOD_SORT);
  const rows = useMemo(() => sortHods(hods, sort), [hods, sort]);
  const onSort = (key: HodSortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: FIRST[key] }));
  const look = hods.filter(hodNeedsLook).length;

  return (
    <SectionCard
      id="hod-view"
      title="HOD view"
      description="Requests each Department Head decided in the period, how fast, and what is waiting with them now."
      icon={UserCog}
      testId="hod-view"
      actions={look > 0 ? <Chip tone="warning">{look} worth a look</Chip> : undefined}
    >
      {loading ? (
        <SkeletonRows rows={3} />
      ) : hods.length === 0 ? (
        <EmptyNote icon={UserCog} title="No Department Head has requests in this period" />
      ) : (
        <>
          <div className="hidden overflow-x-auto rounded-xl border border-slate-100 md:block">
            <table className="w-full min-w-[720px] text-sm" data-testid="hod-table">
              <caption className="sr-only">Department Heads and their requests</caption>
              <thead className="bg-slate-50/80">
                <tr>
                  <SortHeader label="Department Head" column="name" sort={sort} onSort={onSort} />
                  <SortHeader label="Decided" column="decided" sort={sort} onSort={onSort} align="right" />
                  <SortHeader label="Rejected" column="rejectionRate" sort={sort} onSort={onSort} />
                  <SortHeader
                    label="Avg response"
                    column="avgResponseHours"
                    sort={sort}
                    onSort={onSort}
                    align="right"
                  />
                  <SortHeader label="Waiting now" column="waitingNow" sort={sort} onSort={onSort} />
                  <SortHeader label="Oldest" column="oldestWaitingHours" sort={sort} onSort={onSort} align="right" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((h) => (
                  <tr
                    key={h.employeeId}
                    className={cn("bg-white", hodNeedsLook(h) && "bg-amber-50/40")}
                    data-testid={`hod-row-${h.employeeId}`}
                  >
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2.5">
                        <PersonAvatar name={h.name} size={32} />
                        <div className="min-w-0">
                          <p className="truncate font-semibold text-slate-900">{h.name}</p>
                          <p className="truncate text-[11px] text-slate-500">
                            <span className="font-mono">{h.code}</span>
                            {h.department ? ` · ${h.department}` : ""}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-right font-semibold tabular-nums">{h.decided}</td>
                    <td className="px-3 py-2.5">
                      {h.decided > 0 ? (
                        <div className="space-y-0.5">
                          <RateBar rate={h.rejectionRate} />
                          <p className="text-[11px] text-slate-400">
                            {h.rejected} of {h.decided}
                          </p>
                        </div>
                      ) : (
                        <span className="text-xs text-slate-400">None decided</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-700">
                      {hoursText(h.avgResponseHours)}
                    </td>
                    <td className="px-3 py-2.5">
                      <Waiting h={h} />
                    </td>
                    <td className="px-3 py-2.5 text-right text-xs tabular-nums text-slate-600">
                      {h.oldestWaitingHours ? hoursText(h.oldestWaitingHours) : "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="space-y-2 md:hidden" data-testid="hod-cards">
            {rows.map((h) => (
              <li
                key={h.employeeId}
                className={cn("rounded-xl border border-slate-100 bg-white p-3", hodNeedsLook(h) && "border-amber-200")}
              >
                <div className="flex items-center gap-2.5">
                  <PersonAvatar name={h.name} size={34} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold text-slate-900">{h.name}</p>
                    <p className="truncate text-[11px] text-slate-500">{h.department ?? h.code}</p>
                  </div>
                  <Waiting h={h} />
                </div>
                <dl className="mt-2 grid grid-cols-3 gap-2 border-t border-slate-50 pt-2 text-center">
                  <div>
                    <dd className="text-sm font-bold tabular-nums text-slate-800">{h.decided}</dd>
                    <dt className="text-[10px] text-slate-500">Decided</dt>
                  </div>
                  <div>
                    <dd className="text-sm font-bold tabular-nums text-slate-800">
                      {h.decided ? pct(h.rejectionRate) : "-"}
                    </dd>
                    <dt className="text-[10px] text-slate-500">Rejected</dt>
                  </div>
                  <div>
                    <dd className="text-sm font-bold tabular-nums text-slate-800">{hoursText(h.avgResponseHours)}</dd>
                    <dt className="text-[10px] text-slate-500">Avg response</dt>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
        </>
      )}
    </SectionCard>
  );
}

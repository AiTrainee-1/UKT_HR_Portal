import type { UseQueryResult } from "@tanstack/react-query";
import AskAiButton from "@/components/md/kit/AskAiButton";
import BarList from "@/components/md/kit/BarList";
import SectionCard from "@/components/md/kit/SectionCard";
import { CHART } from "@/components/md/kit/chartTheme";
import { EmptyBlock } from "@/components/md/kit/states";
import { num, pct } from "@/lib/md/format";
import { DetailList, DetailRow } from "../shared/DetailSheet";
import { employeeAddress, useOpenInPage } from "../shared/jump";
import { QueryError, refreshingClass } from "./cards";
import type { Drill, LvPermissions } from "./types";

/** Permissions (Morning Late-In, Evening Early-Out, Middle One-Hour) against the monthly cap: an approved permission beyond
 *  the cap shifts nothing. A type opens its permissions; a person opens their record. */
export default function PermissionsCard({
  query,
  ask,
  onDrill,
}: {
  query: UseQueryResult<LvPermissions>;
  ask: string;
  onDrill: (d: Drill) => void;
}) {
  const data = query.data;
  const openIn = useOpenInPage();
  const t = data?.totals;
  return (
    <SectionCard
      title="Permissions"
      subtitle={
        data
          ? `Dated in the period; the cap is ${num(data.cap)} approved a month and anything beyond it shifts nothing`
          : undefined
      }
      loading={query.isPending}
      provenance={data?.provenance}
      actions={<AskAiButton question={ask} />}
      bodyClassName={refreshingClass(query)}
      testId="md-leave-permissions"
    >
      {query.isError ? (
        <QueryError query={query} />
      ) : data && t && t.requested > 0 ? (
        <div className="space-y-4">
          <p className="text-[13px] text-md-ink" data-testid="md-leave-permissions-line">
            <b>{num(t.requested)}</b> asked: {num(t.approved)} approved, {num(t.rejected)} rejected, {num(t.pending)}{" "}
            waiting; <b>{num(t.excess)}</b> approved beyond the cap
            {t.excessPct != null ? ` (${pct(t.excessPct)} of the approved)` : ""}.
          </p>
          <BarList
            testId="md-leave-permission-types"
            items={data.byType.map((r) => ({
              key: r.key,
              label: r.label,
              value: r.requested,
              color: CHART.info,
              sub: `${num(r.approved)} approved · ${num(r.excess)} over the cap · ${num(r.people)} ${r.people === 1 ? "person" : "people"}`,
            }))}
            format={(v) => num(v)}
            onSelect={(item) =>
              onDrill({
                title: `Permissions: ${String(item.label)}`,
                params: { what: "permissions", leaveType: String(item.label) },
              })
            }
          />
          {data.overCap.length > 0 && (
            <div>
              <h4 className="md-analytics-subhead">Went beyond the cap</h4>
              <DetailList testId="md-leave-overcap">
                {data.overCap.map((p) => (
                  <DetailRow
                    key={p.employeeId}
                    primary={p.employeeName}
                    secondary={`${p.employeeCode} · ${p.department}`}
                    value={`${num(p.excess)} over`}
                    tone="md-analytics-tone-watch"
                    onClick={() => openIn(employeeAddress(p.employeeId))}
                    testId={`md-leave-overcap-${p.employeeCode}`}
                  />
                ))}
              </DetailList>
            </div>
          )}
        </div>
      ) : data ? (
        <EmptyBlock title="No permissions in this period" testId="md-leave-permissions-empty">
          Nobody asked for a permission dated in this period.
        </EmptyBlock>
      ) : null}
    </SectionCard>
  );
}

import { useState } from "react";
import { Users } from "lucide-react";
import { describeMdError, useMdQuery, type MdQueryParams } from "@/lib/api-client/custom-hooks/md";
import { num } from "@/lib/md/format";
import DetailSheet, { DetailList, DetailRow } from "../shared/DetailSheet";
import { useOpenInPage } from "../shared/jump";
import { PeopleSheet } from "../employees/kit";
import type { PeopleAsk } from "../employees/types";
import { againstCompany, metricText, verdictTone } from "./logic";
import type { MetricDef, MetricId, UnitProfile } from "./types";

const PROFILE_METRICS: MetricId[] = [
  "headcount",
  "attendancePct",
  "absenteeismPct",
  "latePct",
  "overtimeHours",
  "attritionPct",
  "joiners",
  "leavers",
  "payrollCost",
  "costPerHead",
];

const TONE = { good: "md-analytics-tone-good", bad: "md-analytics-tone-bad", neutral: "" } as const;

/**
 * One unit in depth (GET /api/md/units/profile?branch=<id>): every figure against the company, then its departments
 * against the unit. A department (or "People of this unit") opens the people; "Open in Branches" goes to the HR page.
 */
export default function UnitSheet({
  unitId,
  params,
  metrics,
  onClose,
}: {
  unitId: number | null;
  params: MdQueryParams;
  metrics: MetricDef[];
  onClose: () => void;
}) {
  const openPage = useOpenInPage();
  const [people, setPeople] = useState<PeopleAsk | null>(null);
  const query = useMdQuery<UnitProfile>(
    "units/profile",
    unitId != null ? { ...params, branch: String(unitId) } : undefined,
    { enabled: unitId != null },
  );
  const data = query.data;
  const defs = Object.fromEntries(metrics.map((m) => [m.id, m])) as Record<MetricId, MetricDef>;
  const row = data?.row;
  const name = data?.unit?.name ?? "Unit";

  return (
    <>
      <DetailSheet
        open={unitId != null && people == null}
        onClose={onClose}
        title={name}
        subtitle={
          row
            ? `${num(row.headcount)} active · ${num(row.staff)} staff · ${num(row.production)} production${row.factory ? ` · ${num(row.factory)} factory` : ""}`
            : undefined
        }
        loading={query.isPending || (query.isPlaceholderData && query.isFetching)}
        error={query.isError ? describeMdError(query.error) : null}
        onRetry={() => void query.refetch()}
        empty={data && !row ? (data.notes[data.notes.length - 1] ?? "Nobody works in this unit.") : null}
        ask={`Tell me about ${name}: how does it compare with the company, and which department drags it down?`}
        openLabel="Open in Branches"
        onOpen={() => openPage("/md/branches")}
        testId="md-units-sheet"
        wide
      >
        {row && (
          <div className="space-y-4">
            <button
              type="button"
              className="md-btn inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold"
              onClick={() =>
                setPeople({
                  group: "active",
                  title: `People of ${name}`,
                  subtitle: "Here today",
                  extra: { branch: String(unitId) },
                  open: { path: "/md/employees", label: "Open in Employees" },
                })
              }
              data-testid="md-units-sheet-people"
            >
              <Users size={14} aria-hidden /> People of this unit
            </button>
            <div>
              <h4 className="md-analytics-subhead">Against the company</h4>
              <DetailList testId="md-units-sheet-figures">
                {PROFILE_METRICS.map((id) => {
                  const entry = row.metrics[id];
                  const tone = verdictTone(entry);
                  return (
                    <DetailRow
                      key={id}
                      testId={`md-units-sheet-figure-${id}`}
                      primary={defs[id]?.label ?? id}
                      secondary={againstCompany(defs[id], entry) ?? defs[id]?.hint}
                      value={metricText(defs[id]?.format, entry?.value)}
                      tone={tone ? TONE[tone] : undefined}
                    />
                  );
                })}
              </DetailList>
            </div>
            {data?.departments && data.departments.rows.length > 0 && (
              <div>
                <h4 className="md-analytics-subhead">Departments, against the unit</h4>
                <DetailList testId="md-units-sheet-departments">
                  {data.departments.rows.map((d) => (
                    <DetailRow
                      key={String(d.id)}
                      testId={`md-units-sheet-department-${d.id ?? "none"}`}
                      primary={d.name}
                      secondary={`${num(d.headcount)} active · attendance ${metricText("pct", d.metrics.attendancePct?.value)}`}
                      value={againstCompany(defs.attendancePct, d.metrics.attendancePct) ?? undefined}
                      tone={(() => {
                        const t = verdictTone(d.metrics.attendancePct);
                        return t ? TONE[t] : undefined;
                      })()}
                      onClick={
                        d.id == null
                          ? undefined
                          : () =>
                              setPeople({
                                group: "active",
                                title: `${d.name}, ${name}`,
                                subtitle: "Here today",
                                extra: { branch: String(unitId), department: String(d.id) },
                                open: { path: "/md/employees", label: "Open in Employees" },
                              })
                      }
                    />
                  ))}
                </DetailList>
              </div>
            )}
          </div>
        )}
      </DetailSheet>
      <PeopleSheet ask={people} params={params} onClose={() => setPeople(null)} testId="md-units-people" />
    </>
  );
}

import { useState } from "react";
import { Users } from "lucide-react";
import MdLayout from "@/components/md/MdLayout";
import { FilterBar, PeriodBar, ScopeBar } from "@/components/md/kit/FilterBar";
import MdPageHeader from "@/components/md/kit/MdPageHeader";
import { ErrorBanner, NoteBanner } from "@/components/md/kit/states";
import { describeMdError, useMdOrg, useMdQuery } from "@/lib/api-client/custom-hooks/md";
import { usePublishAssistantContext } from "@/lib/md/assistant-store";
import {
  EVERYONE,
  PRESET_LABEL,
  describeScope,
  periodParams,
  scopeParams,
  type PeriodChoice,
  type ScopeChoice,
} from "@/lib/md/period";
import AttentionCard from "./employees/AttentionCard";
import AttritionSection from "./employees/AttritionSection";
import CompositionSection from "./employees/CompositionSection";
import DirectoryCard from "./employees/DirectoryCard";
import KpiStrip from "./employees/KpiStrip";
import { EMPLOYEE_PRESETS, assistantContext, askQuestions, uniqueNotes } from "./employees/logic";
import MilestonesCard from "./employees/MilestonesCard";
import MovementCard from "./employees/MovementCard";
import ProfileSheet from "./employees/ProfileSheet";
import type {
  EmployeesAttrition,
  EmployeesComposition,
  EmployeesInsights,
  EmployeesMilestones,
  EmployeesMovement,
  EmployeesSummary,
} from "./employees/types";

const DEPARTMENT_ROWS = { first: 10, all: 25 };
const COMPOSITION_ROWS = { first: 8, all: 25 };

const periodText = (choice: PeriodChoice) =>
  choice.preset === "custom" ? `${choice.from} to ${choice.to}` : PRESET_LABEL[choice.preset];

/** Employees: who works here, how the workforce is moving, where people leave from, and a directory to look anyone up. */
export default function MdEmployees() {
  const [period, setPeriod] = useState<PeriodChoice>({ preset: "last_12_months" });
  const [scope, setScope] = useState<ScopeChoice>(EVERYONE);
  const [selected, setSelected] = useState<number | null>(null);
  const [departmentLimit, setDepartmentLimit] = useState(DEPARTMENT_ROWS.first);
  const [compositionLimit, setCompositionLimit] = useState(COMPOSITION_ROWS.first);
  const org = useMdOrg();

  const forScope = scopeParams(scope);
  const forBoth = { ...periodParams(period), ...forScope };
  const summary = useMdQuery<EmployeesSummary>("employees/summary", forBoth);
  const movement = useMdQuery<EmployeesMovement>("employees/movement", forBoth);
  const attrition = useMdQuery<EmployeesAttrition>("employees/attrition", { ...forBoth, limit: departmentLimit });
  const insights = useMdQuery<EmployeesInsights>("employees/insights", forBoth);
  // the server's default (the 8 biggest) is asked for by leaving the limit out
  const composition = useMdQuery<EmployeesComposition>(
    "employees/composition",
    compositionLimit > COMPOSITION_ROWS.first ? { ...forScope, limit: compositionLimit } : forScope,
  );
  const milestones = useMdQuery<EmployeesMilestones>("employees/milestones", forScope);

  const branchName = org.data?.branches.find((b) => String(b.id) === scope.branch)?.name;
  const scopeText = summary.data?.scope?.description ?? describeScope(scope, branchName, scope.department || undefined);
  const periodLabel = summary.data?.period?.label ?? periodText(period);
  const asks = askQuestions(periodLabel, scopeText);
  usePublishAssistantContext(assistantContext(summary.data, periodLabel, scopeText));

  const loads = [
    ["Summary", summary],
    ["Movement", movement],
    ["Attrition", attrition],
    ["Needs your attention", insights],
    ["Composition", composition],
    ["Moments to mark", milestones],
  ] as const;
  const failed = loads.filter(([, q]) => q.isError);
  const notes = uniqueNotes(summary.data?.notes, composition.data?.notes, attrition.data?.notes);

  return (
    <MdLayout>
      <div className="mx-auto max-w-[1500px] space-y-5" data-testid="md-employees-page">
        <MdPageHeader
          icon={Users}
          title="Employees"
          subtitle="Who works here, how the workforce is changing, and where people are leaving."
          updatedAt={summary.data?.generatedAt}
        />
        <FilterBar>
          {/* seven pills do not fit a phone: they scroll inside the bar instead of widening the page */}
          <div className="min-w-0 max-w-full overflow-x-auto">
            <PeriodBar value={period} onChange={setPeriod} presets={EMPLOYEE_PRESETS} />
          </div>
          <ScopeBar value={scope} onChange={setScope} org={org.data} />
        </FilterBar>

        {failed.length > 0 && (
          <ErrorBanner
            message={failed.map(([name, q]) => `${name}: ${describeMdError(q.error)}`).join(" · ")}
            onRetry={() => failed.forEach(([, q]) => q.refetch())}
          />
        )}
        {notes.length > 0 && (
          <NoteBanner>
            {notes.map((n) => (
              <p key={n}>{n}</p>
            ))}
          </NoteBanner>
        )}

        <KpiStrip summary={summary.data} movement={movement.data} failed={summary.isError} />
        <AttentionCard insights={insights.data} question={asks.attention} failed={insights.isError} />
        <CompositionSection
          composition={composition.data}
          failed={composition.isError}
          asks={asks}
          showingAll={compositionLimit > COMPOSITION_ROWS.first}
          onShowAll={() => setCompositionLimit(COMPOSITION_ROWS.all)}
        />
        <MovementCard movement={movement.data} question={asks.movement} failed={movement.isError} />
        <AttritionSection
          attrition={attrition.data}
          failed={attrition.isError}
          asks={asks}
          onSelect={setSelected}
          showingAll={departmentLimit > DEPARTMENT_ROWS.first}
          onShowAll={() => setDepartmentLimit(DEPARTMENT_ROWS.all)}
        />
        <MilestonesCard
          milestones={milestones.data}
          failed={milestones.isError}
          question={asks.milestones}
          onSelect={setSelected}
        />
        <DirectoryCard
          scopeParams={forScope}
          scopeKey={JSON.stringify(forScope)}
          question={asks.directory}
          onSelect={setSelected}
        />
      </div>
      <ProfileSheet employeeId={selected} onClose={() => setSelected(null)} />
    </MdLayout>
  );
}

import { useEffect, useRef } from "react";
import MdLayout from "@/components/md/MdLayout";
import { FilterBar, ScopeBar } from "@/components/md/kit/FilterBar";
import MdPageHeader from "@/components/md/kit/MdPageHeader";
import { NoteBanner } from "@/components/md/kit/states";
import { useMdOrg } from "@/lib/api-client/custom-hooks/md";
import { usePublishAssistantContext, type AssistantPageContext } from "@/lib/md/assistant-store";
import { inr, inrCompact, num, pct } from "@/lib/md/format";
import { describeScope } from "@/lib/md/period";
import DepartmentsView from "./payroll-dashboard/DepartmentsView";
import EmployeeProfile from "./payroll-dashboard/EmployeeProfile";
import EmployeesView from "./payroll-dashboard/EmployeesView";
import {
  daysText,
  departmentBars,
  figuresSummary,
  kpiChange,
  scopeOf,
  typeLabel,
  withChange,
  type DashState,
  type DashView,
} from "./payroll-dashboard/logic";
import MonthlyView from "./payroll-dashboard/MonthlyView";
import { MonthSelect, SearchBox, ViewTabs } from "./payroll-dashboard/parts";
import {
  FROM_LIST_STATE,
  cameFromList,
  stampOf,
  useDashState,
  usePayrollDashboard,
  type DashQueries,
} from "./payroll-dashboard/queries";

const VIEW_NAME: Record<DashView, string> = { monthly: "Monthly", departments: "Departments", employees: "Employees" };

/** Where the list was scrolled when an employee was opened: Back returns there. */
let listScroll = 0;
const scroller = () => document.querySelector("main");

/** What the MD is looking at, for the assistant: the filters in words and the headline figures of the open view. */
function assistantContext(state: DashState, q: DashQueries, branchName: string | undefined): AssistantPageContext {
  const monthly = q.monthly.data;
  const monthLabel =
    (state.view === "departments" ? q.departments.data?.label : undefined) ??
    (state.view === "employees" ? q.people.data?.label : undefined) ??
    monthly?.label ??
    null;
  const person = state.employee && q.person.data?.employee.id === state.employee ? q.person.data : undefined;
  const filters: AssistantPageContext["filters"] = {
    View: person ? "One employee's salary history" : VIEW_NAME[state.view],
    Month: monthLabel ?? (state.month || "Latest month"),
    Scope: describeScope(scopeOf(state), branchName, state.department || undefined),
    Search: state.view === "employees" && state.q ? state.q : undefined,
    Employee: person ? `${person.employee.name} (${person.employee.code})` : undefined,
  };

  let summary: AssistantPageContext["summary"];
  if (person) {
    const t = person.totals;
    summary = {
      Employee: `${person.employee.name}, ${person.employee.code}`,
      Department: [person.employee.department, person.employee.unit].filter(Boolean).join(", ") || null,
      Type: typeLabel(person.employee.type),
      "Monthly salary today":
        person.employee.monthlySalary != null ? inr(person.employee.monthlySalary) : "paid per shift",
      "Months of history": person.months.length,
      "Total earned": inrCompact(t.earnedSalary),
      "Total deductions": inrCompact(t.deductions.total),
      "Total net paid": inrCompact(t.netPaid),
      "Attendance deductions": inrCompact(t.attendanceDeduction),
      "Casual leave": `${daysText(t.clDays)} days, ${inrCompact(t.clAmount)}`,
    };
  } else if (state.view === "departments" && q.departments.data) {
    const d = q.departments.data;
    const top = departmentBars(d.rows)[0];
    summary = {
      Departments: d.rows.length,
      "Company cost": inrCompact(d.totals.companyCost),
      "Largest department": top ? `${top.name}: ${inrCompact(top.companyCost)} (${pct(top.sharePct)})` : null,
      "Average earned per employee": inrCompact(d.totals.averageEarned),
      Attendance: pct(d.totals.attendancePct),
    };
  } else if (state.view === "employees" && q.people.data) {
    const p = q.people.data;
    summary = { ...figuresSummary(p.totals), Employees: num(p.total) };
  } else if (monthly?.current) {
    summary = {
      ...figuresSummary(monthly.current),
      "Payroll status": monthly.current.status.label,
      "Company cost against the month before": withChange(
        monthly.current.companyCost,
        kpiChange(monthly, "companyCost") ?? undefined,
      ),
    };
  }
  return { page: "payroll", title: "Payroll", filters, summary };
}

/**
 * Payroll (/md/payroll): what the company spends on salaries each month, what is deducted and what the employees actually
 * earn, by month, by department and by employee. Three tabs over one filter bar (month, unit, department, staff /
 * production; the Employees tab adds a search), and an employee's complete salary history opened inside the page. All of
 * it lives in the address (?view=&month=&branch=&department=&type=&q=&employee=), so Back and shared links work.
 */
export default function MdPayroll() {
  const [state, update] = useDashState();
  const org = useMdOrg();
  const q = usePayrollDashboard(state);
  const monthly = q.monthly.data;

  // a profile opens at its top; Back to the list returns to where the list was
  const previousEmployee = useRef(state.employee);
  useEffect(() => {
    const was = previousEmployee.current;
    previousEmployee.current = state.employee;
    const main = scroller();
    if (!main || was === state.employee) return;
    if (state.employee) main.scrollTo({ top: 0 });
    else if (was) requestAnimationFrame(() => (main.scrollTop = listScroll));
  }, [state.employee]);

  const openEmployee = (id: number) => {
    listScroll = scroller()?.scrollTop ?? 0;
    update({ employee: id }, { push: true, historyState: FROM_LIST_STATE });
  };
  const backToList = () => {
    if (cameFromList()) window.history.back();
    else update({ employee: null });
  };
  const openDepartment = (department: string) =>
    update({ view: "employees", department, q: "", employee: null }, { push: true });

  const branchName = org.data?.branches.find((b) => String(b.id) === state.branch)?.name;
  usePublishAssistantContext(assistantContext(state, q, branchName));

  return (
    <MdLayout>
      <div
        className="mx-auto max-w-[1500px] space-y-4 @lg:space-y-5"
        data-testid="md-payroll"
        data-view={state.employee ? "employee" : state.view}
      >
        <MdPageHeader
          title="Payroll"
          subtitle="What the company spends on salaries, what is deducted and what employees earn, by month, department and employee."
          updatedAt={stampOf(q.person.data, q.people.data, q.departments.data, monthly)}
        />
        <ViewTabs value={state.view} onChange={(view) => update({ view, employee: null }, { push: true })} />

        {!state.employee && (
          <FilterBar>
            <MonthSelect
              value={state.month}
              onChange={(month) => update({ month })}
              available={monthly?.available}
              latest={state.month ? null : monthly?.month}
            />
            <ScopeBar
              value={scopeOf(state)}
              onChange={(s) => update({ branch: s.branch, department: s.department, type: s.type })}
              org={org.data}
            />
            {state.view === "employees" && <SearchBox value={state.q} onChange={(text) => update({ q: text })} />}
          </FilterBar>
        )}

        {q.monthly.isError && !monthly && state.view !== "monthly" && !state.employee && (
          <NoteBanner>The list of payroll months could not be loaded, so the latest month is shown.</NoteBanner>
        )}

        {state.employee ? (
          <EmployeeProfile
            id={state.employee}
            query={q.person}
            month={state.month || monthly?.month || ""}
            onBack={backToList}
          />
        ) : state.view === "departments" ? (
          <DepartmentsView query={q.departments} chosen={state.department} onOpen={openDepartment} />
        ) : state.view === "employees" ? (
          <EmployeesView query={q.people} state={state} update={update} onOpen={openEmployee} />
        ) : (
          <MonthlyView
            query={q.monthly}
            onSelectMonth={(month) => update({ month })}
            onLatest={() => update({ month: "" })}
          />
        )}
      </div>
    </MdLayout>
  );
}

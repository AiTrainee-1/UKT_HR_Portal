import { useEffect, useRef } from "react";
import { FilterBar, ScopeBar } from "@/components/md/kit/FilterBar";
import { MonthPicker, thisMonthKey } from "@/components/md/kit/MonthPicker";
import { NoteBanner } from "@/components/md/kit/states";
import { useMdOrg } from "@/lib/api-client/custom-hooks/md";
import { usePublishAssistantContext, type AssistantPageContext } from "@/lib/md/assistant-store";
import { inr, inrCompact, num, pct } from "@/lib/md/format";
import { describeScope } from "@/lib/md/period";
import DepartmentsView from "./DepartmentsView";
import EmployeeProfile from "./EmployeeProfile";
import EmployeesView from "./EmployeesView";
import {
  daysText,
  departmentBars,
  figuresSummary,
  kpiChange,
  orgFor,
  scopeOf,
  typeLabel,
  withChange,
  type DashState,
  type DashView,
} from "./logic";
import MonthlyView from "./MonthlyView";
import { SearchBox, ViewTabs } from "./parts";
import { FROM_LIST_STATE, cameFromList, useDashState, usePayrollDashboard, type DashQueries } from "./queries";

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
    Payroll: "Staff (monthly)",
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
    const w = monthly.current.workflow;
    summary = {
      ...figuresSummary(monthly.current),
      "Payroll status": monthly.current.status.label,
      "Company cost against the month before": withChange(
        monthly.current.companyCost,
        kpiChange(monthly, "companyCost") ?? undefined,
      ),
      "Salaries on hold": w.onHold ? `${num(w.onHold)} (${inrCompact(w.onHoldNet)})` : null,
      "New joiners waiting": w.newJoinersWaiting ? num(w.newJoinersWaiting) : null,
      "Staff not included": monthly.notIncluded?.count ? num(monthly.notIncluded.count) : null,
      "Company cost this year so far": monthly.yearly?.current ? inrCompact(monthly.yearly.current.companyCost) : null,
    };
  }
  return { page: "payroll", title: "Staff payroll", filters, summary };
}

/**
 * Staff payroll (/md/payroll, the Staff side): what the company spends on staff salaries each month, what is deducted and
 * what the staff actually earn, by month, by department and by employee. Three tabs over one filter bar (month and year,
 * unit, department; the Employees tab adds a search), and an employee's complete salary history opened inside the page.
 * All of it lives in the address (?view=&month=&branch=&department=&q=&employee=), so Back and shared links work.
 */
export default function StaffPayroll() {
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

  const available = monthly?.available ?? [];
  const shownMonth = state.month || monthly?.month || thisMonthKey();
  const newest = available[0];
  const top = newest && newest > thisMonthKey() ? newest : thisMonthKey();

  return (
    <div
      className="space-y-4 @lg:space-y-5"
      data-testid="md-pay-staff"
      data-view={state.employee ? "employee" : state.view}
    >
      <ViewTabs value={state.view} onChange={(view) => update({ view, employee: null }, { push: true })} />

      {!state.employee && (
        <FilterBar>
          <MonthPicker
            value={shownMonth}
            onChange={(month) => update({ month })}
            min={available.at(-1)}
            max={top}
            label="Payroll month"
          />
          <ScopeBar
            value={scopeOf(state)}
            onChange={(s) => update({ branch: s.branch, department: s.department })}
            org={orgFor(org.data, monthly?.departments)}
            showType={false}
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
  );
}

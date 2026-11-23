import HrLayout from "@/components/HrLayout";
import { useUrlParams } from "@/components/payroll/kit/url-state";
import { URL_DEFAULTS } from "./employee-investigation/logic";
import { Workspace } from "./employee-investigation/Workspace";

/**
 * Employees -> Investigation (/hr/employees/investigation, owner 2026-11-23): the active employees (staff and production)
 * away from the company 15-29 days in a row (15 Days) or 30+ (30 Days), counted in calendar days since the last attended
 * day up to yesterday, with a unit's no-data days (its punches did not arrive) left out. HR checks their leave (Leave
 * details), keeps them active with a reason (the Auto Trigger then leaves them alone until they attend again) or marks
 * them inactive. The Auto Trigger tab shows the nightly 01:00 run: its switch, last run, who it would mark inactive tonight
 * and everyone it marked inactive (Make active again). The tab, kind and filters live in the address. Permission key
 * employees.investigation (follows "Activate / deactivate an employee"). Backend: /api/employee-investigation/*.
 */
export default function EmployeeInvestigation() {
  const [url, setUrl] = useUrlParams(URL_DEFAULTS);
  return (
    <HrLayout>
      <Workspace url={url} setUrl={setUrl} />
    </HrLayout>
  );
}

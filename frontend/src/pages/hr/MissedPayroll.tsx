import HrLayout from "@/components/HrLayout";
import { useUrlParams } from "@/components/payroll/kit/url-state";
import { URL_DEFAULTS } from "./missed-payroll/logic";
import { Workspace } from "./missed-payroll/Workspace";

/**
 * Missed Payroll (/hr/missed-payroll, owner 2026-11-23): the employees the Staff / Production Payroll missed for a month
 * (salary not fixed, on hold, new joiners, not generated; inactive employees in their own view; payroll rows not marked
 * Cleared only to check). Their pay is worked out here (Generate), checked (Clear), added to the month's payroll (Done,
 * remark MISSED PAYROLL) and paid from this page (its bank file, then Paid), with its own payroll report and salary
 * statement and the attendance editor inside the page. Separate from the Staff and Production Payroll pages. The month,
 * tab, view and filters live in the address. Backend: /api/missed-payroll/*.
 */
export default function MissedPayroll() {
  const [url, setUrl] = useUrlParams(URL_DEFAULTS);
  return (
    <HrLayout>
      <Workspace url={url} setUrl={setUrl} />
    </HrLayout>
  );
}

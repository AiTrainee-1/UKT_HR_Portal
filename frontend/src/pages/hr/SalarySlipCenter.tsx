import HrLayout from "@/components/HrLayout";
import { useUrlParams } from "@/components/payroll/kit/url-state";
import { URL_DEFAULTS } from "./salary-slip-center/logic";
import { SlipWorkspace } from "./salary-slip-center/SlipWorkspace";

/**
 * Salary Slip (/hr/salary-slip, owner 2026-11-20): salary slips for ANY employee (active, inactive, on hold, new joiner)
 * from the employee's current details, attendance and salary only, independent of Staff / Production Payroll; with the
 * salary statement, the bank file and the page's own per-month Hold / Release. The month, tab and filters live in the
 * address, so a reload or a shared link opens the same list. Backend: /api/salary-slip-center/*.
 */
export default function SalarySlipCenter() {
  const [url, setUrl] = useUrlParams(URL_DEFAULTS);
  return (
    <HrLayout>
      <SlipWorkspace url={url} setUrl={setUrl} />
    </HrLayout>
  );
}

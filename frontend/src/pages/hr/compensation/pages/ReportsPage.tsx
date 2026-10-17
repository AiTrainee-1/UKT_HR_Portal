import { FileSpreadsheet } from "lucide-react";
import { useUrlParams } from "@/components/payroll/kit/url-state";
import { useAuth } from "@/contexts/AuthContext";
import { CompensationPageShell, useCompensationFeaturesOff } from "../CompensationPageShell";
import ReportsTab from "../history/ReportsTab";
import { COMPENSATION_URL_DEFAULTS } from "../logic";

/** Compensation > Reports: the cross-type summary and the Excel / CSV export of every section. */
export default function ReportsPage() {
  const { user } = useAuth();
  const [url, setUrl] = useUrlParams(COMPENSATION_URL_DEFAULTS);
  const featuresOff = useCompensationFeaturesOff();
  return (
    <CompensationPageShell
      icon={<FileSpreadsheet size={20} className="text-teal-600" />}
      title="Reports"
      description="Who benefited from each type of compensation at a glance, and one Excel or CSV file of everything for the period you choose."
    >
      <ReportsTab featuresOff={featuresOff} isBranchScoped={!!user?.branchId} url={url} setUrl={setUrl} />
    </CompensationPageShell>
  );
}

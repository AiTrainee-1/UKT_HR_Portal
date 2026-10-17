import { History } from "lucide-react";
import { ToFirstSubtab, useSubtab } from "@/components/ui/subtab-nav";
import { useUrlParams } from "@/components/payroll/kit/url-state";
import { useAuth } from "@/contexts/AuthContext";
import {
  CompensationPageShell,
  ToDefaultNested,
  useCompensationFeaturesOff,
  useNestedSubtab,
} from "../CompensationPageShell";
import HistoryTab from "../history/HistoryTab";
import { COMPENSATION_URL_DEFAULTS } from "../logic";
import { HISTORY_SUB_VALUES, pagePath } from "../routes";

const BASE = pagePath("history");

function CompensationHistory({ sub, nested }: { sub: string; nested: string | undefined }) {
  const { user } = useAuth();
  const [url, setUrl] = useUrlParams(COMPENSATION_URL_DEFAULTS);
  const featuresOff = useCompensationFeaturesOff();
  return (
    <CompensationPageShell
      icon={<History size={20} className="text-teal-600" />}
      title="History"
      description="Who benefited from each kind of compensation, for Today, a Week or a Month: one tab per kind, with its summary and its records."
    >
      <HistoryTab
        sub={sub}
        nested={nested}
        featuresOff={featuresOff}
        isBranchScoped={!!user?.branchId}
        url={url}
        setUrl={setUrl}
      />
    </CompensationPageShell>
  );
}

/**
 * Compensation > History, with a subtab per kind of record (/ot-allowance, /ot-relaxation, /ot-pay, ...) and, where a kind
 * has two sections, a nested subtab each (/company-windows/late-in, /holiday-work/redeemed).
 */
export default function HistoryPage() {
  const sub = useSubtab(BASE, HISTORY_SUB_VALUES);
  const nested = useNestedSubtab("history", sub);
  if (!sub) return <ToFirstSubtab base={BASE} first={HISTORY_SUB_VALUES[0]} />;
  if (nested === null) return <ToDefaultNested pageKey="history" sub={sub} />;
  return <CompensationHistory sub={sub} nested={nested} />;
}

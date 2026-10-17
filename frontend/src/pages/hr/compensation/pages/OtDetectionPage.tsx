import { Clock } from "lucide-react";
import { COMPENSATION_URL_DEFAULTS } from "../logic";
import { ToFirstSubtab, useSubtab } from "@/components/ui/subtab-nav";
import { useUrlParams } from "@/components/payroll/kit/url-state";
import {
  CompensationPageShell,
  ToDefaultNested,
  useCompensationFeaturesOff,
  useNestedSubtab,
} from "../CompensationPageShell";
import OtTab from "../ot/OtTab";
import { OT_SUBS, pagePath } from "../routes";

const BASE = pagePath("ot");

function OtDetection({ sub, nested }: { sub: (typeof OT_SUBS)[number]; nested: string | undefined }) {
  const [url, setUrl] = useUrlParams(COMPENSATION_URL_DEFAULTS);
  const featuresOff = useCompensationFeaturesOff();
  return (
    <CompensationPageShell
      icon={<Clock size={20} className="text-teal-600" />}
      title="OT Detection"
      description="The month's extra work past the shift end: the automatic late-in allowance, the shift compensation HR assigns, and earlier records."
    >
      <OtTab sub={sub} nested={nested} featuresOff={featuresOff} url={url} setUrl={setUrl} />
    </CompensationPageShell>
  );
}

/**
 * Compensation > OT Detection, with a subtab each for Type 1, Type 2 and Earlier records (/type-1, /type-2, /earlier), and
 * nested subtabs under Type 1 (/allowance, /how) and Type 2 (/waiting, /assigned, /how).
 */
export default function OtDetectionPage() {
  const sub = useSubtab(BASE, OT_SUBS);
  const nested = useNestedSubtab("ot", sub);
  if (!sub) return <ToFirstSubtab base={BASE} first={OT_SUBS[0]} />;
  if (nested === null) return <ToDefaultNested pageKey="ot" sub={sub} />;
  return <OtDetection sub={sub} nested={nested} />;
}

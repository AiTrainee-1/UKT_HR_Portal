import type { ReactNode } from "react";
import { BarChart3 } from "lucide-react";
import MdPageHeader from "@/components/md/kit/MdPageHeader";

/** The page's title row, the same in every state (loading, library, an open report). The actions wrap on a phone. */
export function ReportsHeader({ actions }: { actions?: ReactNode }) {
  return (
    <MdPageHeader
      icon={BarChart3}
      title="Reports"
      subtitle="Executive summaries and every report in the library: choose the filters, then view, print or export."
      actions={actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : undefined}
    />
  );
}

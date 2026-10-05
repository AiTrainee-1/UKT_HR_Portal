import type { ReactNode } from "react";
import { CircleLoader } from "@/components/ui/CircleLoader";
import type { Provenance } from "@/lib/md/types";
import { cn } from "@/lib/utils";
import ProvenanceButton from "./ProvenanceButton";

/**
 * A titled card for one chart, list or table: the portal's clay card with a title, an optional subtitle and actions on
 * the right (and the "how is this calculated" button when the section has provenance).
 */
export default function SectionCard({
  title,
  subtitle,
  actions,
  provenance,
  provenanceIds,
  loading,
  className,
  bodyClassName,
  testId,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  provenance?: Provenance[];
  provenanceIds?: string[];
  /** True only for the first load: while a changed filter loads, the previous result stays on screen. */
  loading?: boolean;
  className?: string;
  bodyClassName?: string;
  testId?: string;
  children?: ReactNode;
}) {
  return (
    <section className={cn("relative rounded-2xl p-5 clay-card", className)} data-testid={testId}>
      <header className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-bold text-[#1a3a4a]">{title}</h3>
          {subtitle && <p className="mt-0.5 text-xs text-[#006496]/60">{subtitle}</p>}
        </div>
        <div className="flex items-center gap-1.5">
          {actions}
          {provenance && provenance.length > 0 && <ProvenanceButton provenance={provenance} ids={provenanceIds} />}
        </div>
      </header>
      <div className={bodyClassName}>
        {loading ? (
          <div className="flex min-h-[140px] items-center justify-center">
            <CircleLoader texts={["UK Textiles", "MD Portal", "Loading"]} />
          </div>
        ) : (
          children
        )}
      </div>
    </section>
  );
}

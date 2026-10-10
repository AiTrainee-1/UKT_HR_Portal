import type { ReactNode } from "react";
import type { Provenance } from "@/lib/md/types";
import { cn } from "@/lib/utils";
import ProvenanceButton from "./ProvenanceButton";
import { SkeletonBlock } from "./states";

/**
 * A titled card for one chart, list or table: a glass card (md-card) with a title, an optional subtitle and actions on the
 * right (and the "how is this calculated" button when the section has provenance).
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
    <section className={cn("md-card relative p-5 @2xl:p-6", className)} data-testid={testId}>
      <header className="mb-4 flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0">
          <h3 className="text-[15px] font-extrabold leading-snug tracking-tight text-md-ink">{title}</h3>
          {subtitle && <p className="mt-0.5 text-xs leading-snug text-md-ink-soft">{subtitle}</p>}
        </div>
        <div className="flex items-center gap-2">
          {actions}
          {provenance && provenance.length > 0 && <ProvenanceButton provenance={provenance} ids={provenanceIds} />}
        </div>
      </header>
      <div className={bodyClassName}>{loading ? <SkeletonBlock /> : children}</div>
    </section>
  );
}

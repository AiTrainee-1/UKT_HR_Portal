import type { ReactNode } from "react";
import { Link, useSearch } from "wouter";
import { PauseCircle } from "lucide-react";
import HrLayout from "@/components/HrLayout";
import { ToFirstSubtab, useSubtab } from "@/components/ui/subtab-nav";
import { usePayrollSettings } from "@/lib/api-client/custom-hooks";
import { defaultNested, nestedOf, pagePath, type CompensationPageKey } from "./routes";

// What the five Compensation pages share: the heading with its one-line description, the "features are switched off"
// notice, and the subtab row (a path, not a query key, so each subtab has an address of its own).

/**
 * True while the OT / Compensation master switch (Settings -> Payroll) is OFF. The pages themselves are mandatory and never
 * hidden: with the switch off everything stays readable and only the changes that would have no effect are paused. "Not
 * loaded yet" counts as on, so the notice does not flash before Settings has come back.
 */
export function useCompensationFeaturesOff(): boolean {
  const { data } = usePayrollSettings();
  return data?.compensationFeatureEnabled === false;
}

export function FeaturesOffNotice() {
  return (
    <div
      className="flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 p-3.5 text-xs text-amber-900"
      role="status"
      data-testid="compensation-features-off"
    >
      <PauseCircle size={16} className="mt-0.5 shrink-0 text-amber-600" />
      <p className="leading-relaxed">
        <strong>The OT and Compensation features are switched off.</strong> This page and every record on it stay
        available, but OT is not being detected, assigned OT no longer adds pay to payslips, announced late-in /
        early-out, birthday leave and the next-day allowance do not act, and assigning OT, announcing, raising Sunday /
        holiday claims and redeeming the balance are paused until they are switched back on in{" "}
        <Link href="/hr/settings?tab=payroll#compensation-features" className="font-semibold underline">
          Settings → Payroll → OT / Compensation
        </Link>
        . Nothing is deleted while they are off.
      </p>
    </div>
  );
}

/** A page of Compensation: HrLayout, the heading, one line about the page, the switched-off notice where it matters. */
export function CompensationPageShell({
  icon,
  title,
  description,
  showOffNotice = true,
  children,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  /** Show the master-switch notice when the features are off (every page but CTC Breakdown). */
  showOffNotice?: boolean;
  children: ReactNode;
}) {
  const featuresOff = useCompensationFeaturesOff();
  return (
    <HrLayout>
      <div className="space-y-5">
        <div>
          <h2 className="flex items-center gap-2 text-2xl font-black">
            {icon} {title}
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
        </div>
        {showOffNotice && featuresOff && <FeaturesOffNotice />}
        {children}
      </div>
    </HrLayout>
  );
}

// ── Subtabs ───────────────────────────────────────────────────────────────────

/**
 * The nested subtab an address names (`/hr/compensation/compensation-leave/holiday-work/claims` -> `claims`). Undefined when the
 * subtab has no nested level at all; null when it has one and the address names none or an unknown one (the caller then
 * renders <ToDefaultNested>).
 */
export function useNestedSubtab(key: CompensationPageKey, sub: string | null): string | null | undefined {
  const values = sub ? nestedOf(key, sub).map((n) => n.value) : [];
  const named = useSubtab(`${pagePath(key)}/${sub ?? ""}`, values);
  if (!sub || values.length === 0) return undefined;
  return named;
}

/** Sends a subtab with a missing or unknown nested subtab to its default one (the first), keeping the query string. */
export function ToDefaultNested({ pageKey, sub }: { pageKey: CompensationPageKey; sub: string }) {
  const search = useSearch();
  return <ToFirstSubtab base={`${pagePath(pageKey)}/${sub}`} first={defaultNested(pageKey, sub, search) ?? ""} />;
}

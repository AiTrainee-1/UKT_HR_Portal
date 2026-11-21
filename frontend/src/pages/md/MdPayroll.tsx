import { Factory, UserRound } from "lucide-react";
import { useLocation, useSearch } from "wouter";
import MdLayout from "@/components/md/MdLayout";
import MdPageHeader from "@/components/md/kit/MdPageHeader";
import { cn } from "@/lib/utils";
import { kindOf, type PayKind } from "./payroll-dashboard/logic";
import ProductionPayroll from "./payroll-dashboard/production/ProductionPayroll";
import StaffPayroll from "./payroll-dashboard/StaffPayroll";

const KINDS: { id: PayKind; label: string; hint: string; icon: typeof Factory }[] = [
  { id: "staff", label: "Staff", hint: "Monthly salary", icon: UserRound },
  { id: "production", label: "Production", hint: "Weekly, BiWeekly, Monthly cycles", icon: Factory },
];

const SUBTITLE: Record<PayKind, string> = {
  staff: "Staff salaries month by month: what the company spends, what is deducted and what the staff earn.",
  production: "Production wages per pay cycle and period: shifts, pay, deductions and where each period stands.",
};

/** Staff | Production: the two payrolls, kept apart as the HRMS keeps them. Switching keeps the unit. */
function KindSwitch({ value, onChange }: { value: PayKind; onChange: (kind: PayKind) => void }) {
  return (
    <div
      role="tablist"
      aria-label="Staff or production payroll"
      className="md-seg md-shell-seg grid w-full grid-cols-2 @lg:inline-grid @lg:w-auto"
      data-testid="md-pay-kind"
    >
      {KINDS.map(({ id, label, hint, icon: Icon }) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={value === id}
          data-testid={`md-pay-kind-${id}`}
          onClick={() => onChange(id)}
          className={cn(
            "md-seg-item min-h-11 justify-center gap-2 whitespace-nowrap px-3 @lg:px-5",
            value === id && "md-money-seg-on",
          )}
        >
          <Icon size={16} strokeWidth={2.2} aria-hidden="true" className="shrink-0" />
          <span className="flex flex-col items-start leading-tight">
            <span className="text-[13px] font-extrabold">{label}</span>
            <span className="hidden text-[11px] font-medium opacity-80 @lg:block">{hint}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

/**
 * Payroll (/md/payroll): Staff and Production separated, like the HRMS (owner 2026-11-21). Staff is monthly (Monthly,
 * Departments, Employees); Production is per pay cycle and period (Overview, Departments, Workers). Analytics only: the MD
 * reads payroll, never changes it. Which side is open lives in the address (?kind=production; Staff is the default).
 */
export default function MdPayroll() {
  const search = useSearch();
  const [path, navigate] = useLocation();
  const kind = kindOf(search);

  const switchKind = (next: PayKind) => {
    if (next === kind) return;
    // the unit stays (both sides have it); departments differ between staff and production, so the rest starts afresh
    const branch = new URLSearchParams(search).get("branch");
    const p = new URLSearchParams();
    if (next === "production") p.set("kind", "production");
    if (branch) p.set("branch", branch);
    const qs = p.toString();
    navigate(`${path}${qs ? `?${qs}` : ""}`);
  };

  return (
    <MdLayout>
      <div className="mx-auto max-w-[1500px] space-y-4 @lg:space-y-5" data-testid="md-payroll" data-kind={kind}>
        <MdPageHeader title="Payroll" subtitle={SUBTITLE[kind]} />
        <KindSwitch value={kind} onChange={switchKind} />
        {kind === "production" ? <ProductionPayroll /> : <StaffPayroll />}
      </div>
    </MdLayout>
  );
}

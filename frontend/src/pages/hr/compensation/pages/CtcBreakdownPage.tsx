import { Landmark } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { CompensationPageShell } from "../CompensationPageShell";
import CtcBreakdownTab from "../CtcBreakdownTab";

/** Compensation > CTC Breakdown: every staff employee's salary in the 50% + 50% split with the employer's cost. */
export default function CtcBreakdownPage() {
  const { user } = useAuth();
  return (
    <CompensationPageShell
      icon={<Landmark size={20} className="text-teal-600" />}
      title="CTC Breakdown"
      description="Each staff employee's salary in its 50% + 50% split, the employer's PF and ESI, and the annual cost to the company."
      showOffNotice={false}
    >
      <CtcBreakdownTab isBranchScoped={!!user?.branchId} />
    </CompensationPageShell>
  );
}

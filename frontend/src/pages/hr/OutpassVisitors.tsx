import { Redirect, useLocation, useSearch } from "wouter";
import { Coffee, DoorOpen, UserRound } from "lucide-react";
import HrLayout from "@/components/HrLayout";
import { RefreshButton } from "@/components/PageRefreshBar";
import { useAuth } from "@/contexts/AuthContext";
import { OutpassTab } from "./outpass-visitors/outpass/OutpassTab";
import { cleanGatePath, readGatePath, resolveGatePath, type GatePageKey } from "./outpass-visitors/routes";
import { TeaBreakTab } from "./outpass-visitors/tea-break/TeaBreakTab";
import { VisitorsTab } from "./outpass-visitors/visitors/VisitorsTab";

const HEADING: Record<GatePageKey, { icon: typeof DoorOpen; title: string; description: string }> = {
  outpass: {
    icon: DoorOpen,
    title: "Outpass",
    description:
      "Gate exit logs and Outpass requests, collected via a permanent per-branch QR code -no attendance or payroll impact.",
  },
  visitors: {
    icon: UserRound,
    title: "Visitors",
    description: "Front-desk visitor logs, collected via a permanent per-branch QR code.",
  },
  "tea-break": {
    icon: Coffee,
    title: "Tea Break",
    description: "Employee tea-break Out/In timings, scanned at the gate -no approval, purely for tracking.",
  },
};

/**
 * Outpass, Visitors and Tea Break: three independent pages sharing one route file (the sidebar has a separate entry for each,
 * deliberately no in-page switcher, so none of the three shows any trace of the others). The page is the first path segment
 * and its tabs are the ones after it (/outpass/overview/passes, /tea-break/rule): a path that stops early, or names an
 * unknown tab, is replaced by the first one (routes.ts). Visitors is one list, so it has no tabs.
 */
export default function OutpassVisitors() {
  const { user } = useAuth();
  const isBranchScoped = !!user?.branchId;
  const [location] = useLocation();
  const search = useSearch();

  const here = cleanGatePath(location);
  const target = resolveGatePath(here);
  if (target !== here) return <Redirect to={`${target}${search ? `?${search}` : ""}`} replace />;

  const { page, sub, nested } = readGatePath(here);
  const { icon: Icon, title, description } = HEADING[page];

  return (
    <HrLayout>
      <div className="space-y-5">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-2xl font-black flex items-center gap-2">
              <Icon size={20} className="text-teal-600" /> {title}
            </h2>
            <p className="text-muted-foreground text-sm mt-0.5">{description}</p>
          </div>
          <RefreshButton />
        </div>

        {page === "outpass" ? (
          <OutpassTab isBranchScoped={isBranchScoped} sub={sub!} nested={nested} />
        ) : page === "visitors" ? (
          <VisitorsTab isBranchScoped={isBranchScoped} />
        ) : (
          <TeaBreakTab sub={sub!} />
        )}
      </div>
    </HrLayout>
  );
}

import { useEffect, useState } from "react";
import HrLayout from "@/components/HrLayout";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { PillTabs } from "@/components/ui/pill-tabs";
import { Eye, GitBranch, Users } from "lucide-react";
import { useAuth, permissionLevel, isRouteViewOnly } from "@/contexts/AuthContext";
import { lockMutatingControls } from "@/lib/view-only-lock";
import HodAssignmentTab from "./user-management/HodAssignmentTab";
import ApprovalWorkflowControl from "./user-management/ApprovalWorkflowControl";
import { USER_MANAGEMENT_TAB_MODULE } from "./user-management/constants";

// User Management: HOD Assignment (who the Department Heads are and what each may decide) and Approval Workflow Control
// (how every kind of request is approved: who is responsible for each step, in what order, on or off).
export default function UserManagement() {
  const { user } = useAuth();
  const tabLevel = (t: string) => permissionLevel(user, USER_MANAGEMENT_TAB_MODULE[t] ?? "user_management");
  const firstVisibleTab = () => Object.keys(USER_MANAGEMENT_TAB_MODULE).find((t) => tabLevel(t) !== "hidden");
  // Start on a tab this role can see, so a role without HOD Assignment never mounts it (and never calls its API).
  // '?tab=approvals' (the "Change" link beside each screen's approval pipeline) opens Approval Workflow Control.
  const [tab, setTab] = useState(() => {
    const asked = new URLSearchParams(window.location.search).get("tab") ?? "";
    return asked in USER_MANAGEMENT_TAB_MODULE && tabLevel(asked) !== "hidden" ? asked : (firstVisibleTab() ?? "hod");
  });

  // HrLayout already shows the banner and locks the page when NEITHER tab is editable (ROUTE_OR_MODULES); the per-tab
  // banner and lock below are for a role that can edit one tab but only view the other.
  const pageViewOnly = isRouteViewOnly(user, "/hr/user-management", "user_management");
  const isTabViewOnly = !pageViewOnly && tabLevel(tab) === "view";

  // A role's permissions can change under an open page: move off a tab that has just become hidden.
  useEffect(() => {
    if (tabLevel(tab) === "hidden") {
      const firstVisible = firstVisibleTab();
      if (firstVisible) setTab(firstVisible);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, tab]);

  // Only the active tab is mounted, so locking the body while it is view-only touches just that tab's controls.
  useEffect(() => {
    if (!isTabViewOnly) return;
    const relock = () => lockMutatingControls(document.body);
    relock();
    const observer = new MutationObserver(relock);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [isTabViewOnly, tab]);

  return (
    <HrLayout>
      <div className="space-y-5">
        <div>
          <h2 className="text-2xl font-black text-gray-900">User Management</h2>
          <p className="text-muted-foreground text-sm mt-0.5">
            Department approvers and the approval pipelines the whole HRMS follows
          </p>
        </div>

        <Tabs value={tab} onValueChange={setTab}>
          <PillTabs
            items={[
              { value: "hod", label: "HOD Assignment", icon: <Users size={13} /> },
              { value: "approvals", label: "Approval Workflow Control", icon: <GitBranch size={13} /> },
            ].filter((t) => tabLevel(t.value) !== "hidden")}
            value={tab}
            onChange={setTab}
            size="sm"
          />

          {isTabViewOnly && (
            <div
              className="flex items-center gap-2 mt-3 px-3.5 py-2.5 rounded-xl text-sm font-semibold"
              style={{
                background: "rgba(245,158,11,0.08)",
                color: "#b45309",
                boxShadow: "inset 3px 3px 8px rgba(245,158,11,0.06), inset -3px -3px 8px rgba(255,255,255,0.9)",
              }}
            >
              <Eye size={15} strokeWidth={2} />
              View only -browse and inspect freely, changes can't be saved.
            </div>
          )}

          <TabsContent value="hod" className="mt-4 focus-visible:outline-none">
            <HodAssignmentTab />
          </TabsContent>
          <TabsContent value="approvals" className="mt-4 focus-visible:outline-none">
            <ApprovalWorkflowControl />
          </TabsContent>
        </Tabs>
      </div>
    </HrLayout>
  );
}

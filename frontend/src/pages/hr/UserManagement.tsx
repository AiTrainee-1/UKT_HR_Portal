import { useState } from "react";
import HrLayout from "@/components/HrLayout";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { PillTabs } from "@/components/ui/pill-tabs";
import { GitBranch, Users } from "lucide-react";
import { useAuth, isRouteViewOnly } from "@/contexts/AuthContext";
import { pickVisible, useLevel, useViewOnlyLock, ViewOnlyTabNote, visibleItems } from "@/lib/tab-access";
import HodAssignmentTab from "./user-management/HodAssignmentTab";
import ApprovalWorkflowControl from "./user-management/ApprovalWorkflowControl";
import { USER_MANAGEMENT_TAB_MODULE } from "./user-management/constants";

const TABS = [
  { value: "hod", label: "HOD Assignment", icon: <Users size={13} /> },
  { value: "approvals", label: "Approval Workflow Control", icon: <GitBranch size={13} /> },
];

// User Management: HOD Assignment (who the Department Heads are and what each may decide) and Approval Workflow Control
// (how every kind of request is approved: who is responsible for each step, in what order, on or off).
export default function UserManagement() {
  const { user } = useAuth();
  const level = useLevel();
  const tabLevel = (t: string) => level(USER_MANAGEMENT_TAB_MODULE[t] ?? "user_management");
  const visibleTabs = visibleItems(TABS, (t) => USER_MANAGEMENT_TAB_MODULE[t.value], level);
  // '?tab=approvals' (the "Change" link beside each screen's approval pipeline) opens Approval Workflow Control.
  const [asked, setTab] = useState(() => new URLSearchParams(window.location.search).get("tab") ?? "hod");
  // The tab shown is always one this role can see (also when it came from the URL, or a permission changed under an
  // open page), so a role without HOD Assignment never mounts it (and never calls its API).
  const tab = pickVisible(
    asked,
    visibleTabs.map((t) => t.value),
  );

  // HrLayout already shows the banner and locks the page when NEITHER tab is editable (ROUTE_OR_MODULES); the per-tab
  // banner and lock below are for a role that can edit one tab but only view the other.
  const pageViewOnly = isRouteViewOnly(user, "/hr/user-management", "user_management");
  const isTabViewOnly = visibleTabs.length > 0 && !pageViewOnly && tabLevel(tab) === "view";
  // Only the active tab is mounted, so locking the body while it is view-only touches just that tab's controls.
  useViewOnlyLock(isTabViewOnly, tab);

  return (
    <HrLayout>
      <div className="space-y-5">
        <div>
          <h2 className="text-2xl font-black text-gray-900">User Management</h2>
          <p className="text-muted-foreground text-sm mt-0.5">
            Department approvers and the approval pipelines the whole HRMS follows
          </p>
        </div>

        {visibleTabs.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="user-management-nothing-open">
            Nothing on this page is open to your role.
          </p>
        ) : (
          <Tabs value={tab} onValueChange={setTab}>
            <PillTabs items={visibleTabs} value={tab} onChange={setTab} size="sm" />

            {isTabViewOnly && (
              <div className="mt-3">
                <ViewOnlyTabNote show />
              </div>
            )}

            {tab === "hod" && (
              <TabsContent value="hod" className="mt-4 focus-visible:outline-none">
                <HodAssignmentTab />
              </TabsContent>
            )}
            {tab === "approvals" && (
              <TabsContent value="approvals" className="mt-4 focus-visible:outline-none">
                <ApprovalWorkflowControl />
              </TabsContent>
            )}
          </Tabs>
        )}
      </div>
    </HrLayout>
  );
}

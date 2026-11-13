// User Management tab -> its own permission key (see permission_registry.py / permission_tree.py). HOD Assignment is
// "user_management.hod" (with no setting of its own it follows the page's "user_management", as it always did);
// Approval Workflow Control changes who approves every kind of request, so it has a permission of its own that a role
// can be given without the rest of User Management.
export const USER_MANAGEMENT_TAB_MODULE: Record<string, string> = {
  hod: "user_management.hod",
  approvals: "user_management.approval_workflow",
};

// HOD Assignment's two finder pills (components/ManagerAssignmentLookup.tsx) -> their own keys (follow the tab when unset).
export const HOD_FINDER_PILL_MODULE: Record<"users" | "unassigned", string> = {
  users: "user_management.hod.find_user",
  unassigned: "user_management.hod.unassigned",
};

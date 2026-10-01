// User Management tab -> its own permission key (see permission_registry.py). HOD Assignment is the page's own
// permission ("user_management", as it always was); Approval Workflow Control changes who approves every kind of
// request, so it has a permission of its own that a role can be given without the rest of User Management.
export const USER_MANAGEMENT_TAB_MODULE: Record<string, string> = {
  hod: "user_management",
  approvals: "user_management.approval_workflow",
};

import { permissionLevel } from "@/contexts/AuthContext";

// The requests the Managing Director only VIEWS: leave, permission and outpass requests (the Leave & Holiday and Requests
// pages, and the Outpass page's Requests tab). The server holds the modules behind them at "view" for the MD
// (backend/api/permission_registry.py MD_VIEW_ONLY) and refuses the decision calls; the pages' own Approve / Reject buttons
// are drawn only when lib/approval-workflow.ts says the viewer may decide, so the MD portal tells it which workflows are
// view-only for this user (setViewOnlyWorkflows). The workflow keys are the server's approval workflow keys.
export const REQUEST_WORKFLOW_MODULES: Record<string, string> = {
  leave: "leave",
  permission: "requests",
  outpass: "requests",
};

type User = Parameters<typeof permissionLevel>[0];

/** The approval workflows whose requests this user may look at but not decide: those whose module is not "edit" for them. */
export function viewOnlyWorkflowsFor(user: User): string[] {
  return Object.entries(REQUEST_WORKFLOW_MODULES)
    .filter(([, module]) => permissionLevel(user, module) !== "edit")
    .map(([workflow]) => workflow);
}

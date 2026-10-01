// approval: hooks/types for Approval Workflow Control (User Management -> Approval Workflow Control) and for the pipelines
// as any screen needs them to explain a request's path. The rules live in backend/api/approval_workflow.py.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "../custom-fetch";
import type { ApprovalRole, ApprovalStep } from "../../approval-workflow";

export type ApprovalWorkflowItem = {
  key: string;
  label: string;
  group: string;
  /** What the request is for. */
  purpose: string;
  requestedBy: "Employee" | "HR";
  enabled: boolean;
  steps: ApprovalStep[];
  defaultSteps: ApprovalStep[];
  /** True when HR has changed it (a different pipeline, or switched off). */
  customised: boolean;
  /** 'Employee → HOD → HR' */
  path: string;
  /** False: the pipeline is fixed (the screens for the other role do not exist). */
  editable: boolean;
  canDisable: boolean;
  allowedRoles: ApprovalRole[];
  fixedNote: string | null;
  note: string | null;
  onOffEffect: string;
  /** The per-person switch on a Department Head's profile that also has to be on. */
  hodSwitch: string | null;
  /** What HR may want to change (HR left out, a mandatory step that can strand a request, switched off). */
  warnings: string[];
  /** Worth knowing, not a problem (the per-person switch on a Department Head's profile). */
  hints: string[];
  /** Requests waiting now, and how many each role could decide today. */
  waiting: { total: number; hod: number; hr: number } | null;
  updatedBy: string | null;
  updatedAt: string | null;
};

export type ApprovalWorkflowsResponse = {
  roles: { key: ApprovalRole; label: string; long: string }[];
  maxSteps: number;
  workflows: ApprovalWorkflowItem[];
};

export type ApprovalSummaryItem = {
  label: string;
  enabled: boolean;
  requestedBy: "Employee" | "HR";
  steps: ApprovalStep[];
  path: string;
};

export const getApprovalWorkflowsQueryKey = () => ["approval-workflows"] as const;
export const getApprovalSummaryQueryKey = () => ["approval-summary"] as const;

export const useApprovalWorkflows = () =>
  useQuery({
    queryKey: getApprovalWorkflowsQueryKey(),
    queryFn: () => customFetch<ApprovalWorkflowsResponse>("/api/approval-workflows"),
  });

/** The pipelines in force, for any signed-in screen (read-only; cheap, so it is remembered for a minute). */
export const useApprovalSummary = () =>
  useQuery({
    queryKey: getApprovalSummaryQueryKey(),
    queryFn: () => customFetch<Record<string, ApprovalSummaryItem>>("/api/approval-summary"),
    staleTime: 60_000,
  });

/** A pipeline change re-labels the requests still waiting, so every request list on screen is refreshed with it. */
const useRefreshAfterChange = () => {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries();
};

export const useUpdateApprovalWorkflow = () => {
  const refresh = useRefreshAfterChange();
  return useMutation({
    mutationFn: ({
      key,
      data,
    }: {
      key: string;
      data: { enabled?: boolean; steps?: { roles: ApprovalRole[]; mandatory: boolean }[] };
    }) =>
      customFetch<ApprovalWorkflowItem>(`/api/approval-workflows/${key}`, {
        method: "PUT",
        body: JSON.stringify(data),
      }),
    onSuccess: refresh,
  });
};

export const useResetApprovalWorkflow = () => {
  const refresh = useRefreshAfterChange();
  return useMutation({
    mutationFn: (key: string) =>
      customFetch<ApprovalWorkflowItem>(`/api/approval-workflows/${key}`, { method: "DELETE" }),
    onSuccess: refresh,
  });
};

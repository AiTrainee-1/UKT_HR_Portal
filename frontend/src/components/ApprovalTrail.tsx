import { Link } from "wouter";
import { Check, Clock, GitBranch, Minus, X } from "lucide-react";
import { StatusBadge } from "@/components/ui/status-badge";
import { useAuth, canView } from "@/contexts/AuthContext";
import { useApprovalSummary } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import {
  stepLabel,
  trailLine,
  waitingText,
  type ApprovalProgress,
  type ApprovalProgressStep,
  type ApprovalStepState,
} from "@/lib/approval-workflow";
import type { Tone } from "@/lib/statusTones";

// How an HR screen shows where a request stands in ITS approval pipeline (the one configured in User Management ->
// Approval Workflow Control), instead of assuming "Department Head, then HR".

/** 'Waiting for HR' chip for a request that waits on someone; nothing when it is decided. */
export function WaitingChip({ approval, className }: { approval?: ApprovalProgress | null; className?: string }) {
  const text = waitingText(approval);
  if (!text || !approval) return null;
  const roles = approval.waitingFor;
  const tone: Tone = roles.length > 1 ? "accent" : roles[0] === "hr" ? "info" : "warning";
  return (
    <StatusBadge tone={tone} className={className}>
      {text}
    </StatusBadge>
  );
}

/** One muted line on a list row: 'HOD approved by Suresh · Waiting for HR' (nothing when there is nothing to add). */
export function ApprovalTrailLine({ approval, className }: { approval?: ApprovalProgress | null; className?: string }) {
  const line = trailLine(approval);
  if (!line) return null;
  return (
    <p className={cn("text-[11px] text-gray-400", className)} data-testid="approval-trail-line">
      {line}
    </p>
  );
}

type NodeState = "done" | "active" | "rejected" | "waiting" | "skipped";

const NODE_STATE: Record<ApprovalStepState, NodeState> = {
  approved: "done",
  pending: "active",
  rejected: "rejected",
  waiting: "waiting",
  skipped: "skipped",
};

const NODE_COLOR: Record<NodeState, { bg: string; text: string; border: string }> = {
  done: { bg: "#059669", text: "white", border: "#059669" },
  active: { bg: "#d97706", text: "white", border: "#d97706" },
  rejected: { bg: "#dc2626", text: "white", border: "#dc2626" },
  waiting: { bg: "#f0f4f8", text: "#94a3b8", border: "#cbd5e1" },
  skipped: { bg: "#f8fafc", text: "#94a3b8", border: "#cbd5e1" },
};

const firstName = (name?: string | null) => (name ? name.split(" ")[0] : undefined);

function subLabel(step: ApprovalProgressStep): string | undefined {
  const by = firstName(step.by);
  switch (step.state) {
    case "approved":
      return by ? `By ${by}` : undefined;
    case "rejected":
      return by ? `By ${by}` : "Rejected";
    case "pending":
      return "Pending";
    case "skipped":
      return "Skipped";
    default:
      return "Not reached";
  }
}

function Node({
  label,
  state,
  sublabel,
  last,
}: {
  label: string;
  state: NodeState;
  sublabel?: string;
  last?: boolean;
}) {
  const c = NODE_COLOR[state];
  const icon =
    state === "done" ? (
      <Check className="w-3 h-3" />
    ) : state === "active" ? (
      <Clock className="w-3 h-3" />
    ) : state === "rejected" ? (
      <X className="w-3 h-3" />
    ) : state === "skipped" ? (
      <Minus className="w-3 h-3" />
    ) : (
      <span className="w-2 h-2 rounded-full bg-slate-300 inline-block" />
    );
  return (
    <div className="flex items-center gap-1.5">
      <div className="flex flex-col items-center gap-0.5">
        <div
          className="flex items-center justify-center w-6 h-6 rounded-full text-[10px] font-bold"
          style={{
            background: c.bg,
            color: c.text,
            border: `2px ${state === "skipped" ? "dashed" : "solid"} ${c.border}`,
          }}
        >
          {icon}
        </div>
        <span className="text-[9px] font-semibold text-center leading-tight" style={{ color: c.border, maxWidth: 64 }}>
          {label}
        </span>
        {sublabel && (
          <span className="text-[8px] text-center text-slate-400 leading-tight" style={{ maxWidth: 64 }}>
            {sublabel}
          </span>
        )}
      </div>
      {!last && (
        <div
          className="w-8 h-0.5 mb-4 shrink-0"
          style={{ background: state === "done" || state === "rejected" ? c.border : "#e2e8f0" }}
        />
      )}
    </div>
  );
}

/** The request's whole path as a stepper: who raised it, then every step of its pipeline with how it went. */
export function ApprovalTrail({
  approval,
  submittedBy = "Submitted",
}: {
  approval: ApprovalProgress;
  submittedBy?: string;
}) {
  return (
    <div className="flex items-start" data-testid="approval-trail">
      <Node label={submittedBy} state="done" last={approval.steps.length === 0} />
      {approval.steps.map((step, i) => (
        <Node
          key={step.index}
          label={stepLabel(step)}
          state={NODE_STATE[step.state]}
          sublabel={subLabel(step)}
          last={i === approval.steps.length - 1}
        />
      ))}
    </div>
  );
}

/** 'Approval pipeline: Employee → HOD → HR' for a workflow, read live from the summary, with a link to change it. */
export function PipelineNote({ workflow, className }: { workflow: string; className?: string }) {
  const { user } = useAuth();
  const { data } = useApprovalSummary();
  const item = data?.[workflow];
  if (!item) return null;
  const canChange = canView(user, "user_management.approval_workflow");
  return (
    <p
      className={cn("flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground", className)}
      data-testid={`pipeline-note-${workflow}`}
    >
      <GitBranch size={12} className="shrink-0" />
      <span>
        Approval pipeline: <strong className="text-gray-700">{item.path}</strong>
      </span>
      {!item.enabled && <StatusBadge tone="danger">OFF: new requests are refused</StatusBadge>}
      {canChange && (
        <Link href="/hr/user-management?tab=approvals" className="font-semibold text-primary hover:underline">
          Change
        </Link>
      )}
    </p>
  );
}

/** The pipelines of several workflows that share one screen, one line per distinct pipeline:
 *  'Leave, Permission: Employee → HOD or HR'. */
export function PipelineSummary({ workflows, className }: { workflows: string[]; className?: string }) {
  const { user } = useAuth();
  const { data } = useApprovalSummary();
  if (!data) return null;
  const groups = new Map<string, { labels: string[]; off: string[] }>();
  for (const key of workflows) {
    const item = data[key];
    if (!item) continue;
    const group = groups.get(item.path) ?? { labels: [], off: [] };
    group.labels.push(item.label);
    if (!item.enabled) group.off.push(item.label);
    groups.set(item.path, group);
  }
  if (groups.size === 0) return null;
  const canChange = canView(user, "user_management.approval_workflow");
  return (
    <div className={cn("space-y-0.5 text-xs text-muted-foreground", className)} data-testid="pipeline-summary">
      {[...groups.entries()].map(([path, group]) => (
        <p key={path} className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <GitBranch size={12} className="shrink-0" />
          <span>
            <strong className="text-gray-700">{group.labels.join(", ")}</strong>: {path}
          </span>
          {group.off.length > 0 && (
            <StatusBadge tone="danger">{group.off.join(", ")} OFF: new requests are refused</StatusBadge>
          )}
        </p>
      ))}
      {canChange && (
        <Link href="/hr/user-management?tab=approvals" className="ml-[18px] font-semibold text-primary hover:underline">
          Change approval pipelines
        </Link>
      )}
    </div>
  );
}

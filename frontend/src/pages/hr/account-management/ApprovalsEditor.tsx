import { CheckCheck, History, Lock, RotateCcw, ShieldCheck, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  APPROVAL_KINDS,
  ASSISTANT_LOCKED,
  approvalCount,
  isLocked,
  legacyApprovals,
  setAllApprovals,
  type Approvals,
  type ApprovalKind,
  type Permissions,
} from "@/lib/hr-access";
import { MODULE_LABELS, resolvePermission } from "@/lib/permission-modules";
import { cn } from "@/lib/utils";
import { Chip } from "./parts";

const moduleLabel = (key: string) => MODULE_LABELS.find((m) => m.key === key)?.label ?? key;

/** One request type: what approving it means, and its switch (or the lock that keeps it off). */
function ApprovalRow({
  kind,
  checked,
  onChange,
  locked,
  hiddenModule,
  extra,
}: {
  kind: ApprovalKind;
  checked: boolean;
  onChange?: (on: boolean) => void;
  /** HR Assistants can never approve this: the reason is shown and the switch stays off. */
  locked?: boolean;
  /** The module that owns these requests is hidden, so the switch has no effect. */
  hiddenModule?: boolean;
  /** Follows role / custom indicators (accounts). */
  extra?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-2 border-t border-gray-100 px-3 py-2.5 first:border-t-0 sm:flex-row sm:items-center sm:justify-between",
        locked && "bg-gray-50/70",
      )}
      data-testid={`approval-${kind.key}`}
      data-locked={locked ? "true" : undefined}
    >
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-1.5 text-sm font-semibold text-gray-900">
          {kind.label}
          {locked && (
            <Chip className="border-gray-300 bg-white text-gray-600">
              <Lock size={10} /> Locked for HR Assistants
            </Chip>
          )}
        </p>
        <p className="text-xs text-gray-500">
          {locked ? ASSISTANT_LOCKED[kind.key] : kind.description}
          {!locked && hiddenModule && (
            <span className="ml-1 text-amber-700">
              No effect while {moduleLabel(kind.module)} is hidden: approving needs at least View on it.
            </span>
          )}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {extra}
        <Switch
          checked={checked && !locked}
          onCheckedChange={(on) => onChange?.(on)}
          disabled={locked || !onChange}
          aria-label={`Allow approving ${kind.label} requests`}
          data-testid={`approval-switch-${kind.key}`}
        />
      </div>
    </div>
  );
}

/**
 * A role's Approvals: one switch per request type, apart from the Hidden / View / Edit levels. A role made for HR
 * Assistants shows missing punches and attendance edits locked off. A role for any account may stay on the old rule
 * (approve = edit on the module), which is what every role made before had: then the switches are offered, not forced.
 */
export function RoleApprovalsEditor({
  approvals,
  permissions,
  category,
  onChange,
}: {
  approvals: Approvals | null;
  permissions: Permissions;
  category: string;
  onChange: (next: Approvals | null) => void;
}) {
  if (approvals === null) {
    const now = legacyApprovals(permissions, category);
    return (
      <div className="space-y-3 rounded-xl border bg-white p-4" data-testid="approvals-legacy">
        <div className="flex items-start gap-3">
          <span className="rounded-lg bg-slate-100 p-2 text-slate-600">
            <History size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold text-gray-900">Approvals follow Edit (the original rule)</p>
            <p className="mt-0.5 text-xs leading-relaxed text-gray-600">
              Anyone with this role can approve or reject the requests of every module it can <b>edit</b>. Right now
              that is {approvalCount(now)} of {APPROVAL_KINDS.length} request types. Set the approvals separately to let
              this role edit a module without approving its requests (or the other way round).
            </p>
          </div>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => onChange(now)}
          data-testid="approvals-make-explicit"
        >
          <ShieldCheck size={14} /> Set approvals separately
        </Button>
      </div>
    );
  }
  const on = approvalCount(approvals);
  return (
    <div className="space-y-2" data-testid="approvals-editor">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-gray-50 p-3">
        <p className="text-sm font-semibold text-gray-900">
          Approvals{" "}
          <span className="font-normal text-gray-500" data-testid="approvals-count">
            {on} of {APPROVAL_KINDS.length} request types
          </span>
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 gap-1 bg-white px-2.5 text-xs"
            onClick={() => onChange(setAllApprovals(true, category))}
            data-testid="approvals-all-on"
          >
            <CheckCheck size={13} /> Allow all
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 gap-1 bg-white px-2.5 text-xs"
            onClick={() => onChange(setAllApprovals(false, category))}
            data-testid="approvals-all-off"
          >
            <XCircle size={13} /> Allow none
          </Button>
          {!category && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2.5 text-xs"
              onClick={() => onChange(null)}
              title="Approve = edit on the module again, as before"
              data-testid="approvals-make-legacy"
            >
              <RotateCcw size={13} /> Follow Edit again
            </Button>
          )}
        </div>
      </div>
      <div className="overflow-hidden rounded-xl border bg-white">
        {APPROVAL_KINDS.map((kind) => (
          <ApprovalRow
            key={kind.key}
            kind={kind}
            checked={!!approvals[kind.key]}
            locked={isLocked(category, kind.key)}
            hiddenModule={resolvePermission(permissions, kind.module) === "hidden"}
            onChange={(value) => onChange({ ...approvals, [kind.key]: value })}
          />
        ))}
      </div>
      <p className="text-[11px] leading-relaxed text-gray-400">
        Approving is separate from editing: a role can edit a module without approving its requests, or approve them
        with View only. Nobody approves requests of a module they can't open.
      </p>
    </div>
  );
}

/**
 * An HR Manager's / HR Assistant's own approvals: each request type follows the role unless switched for this person
 * ("Custom", with a reset back to the role). Locked items stay off for HR Assistants.
 */
export function AccountApprovalsEditor({
  roleApprovals,
  permissions,
  overrides,
  category,
  onChange,
}: {
  /** The role's switches, or null when the role follows Edit. */
  roleApprovals: Approvals;
  /** The account's levels after its own module changes. */
  permissions: Permissions;
  overrides: Approvals;
  category: string;
  onChange: (next: Approvals) => void;
}) {
  return (
    <div className="space-y-2" data-testid="account-approvals">
      <div className="overflow-hidden rounded-xl border bg-white">
        {APPROVAL_KINDS.map((kind) => {
          const custom = kind.key in overrides;
          const fromRole = !!roleApprovals[kind.key];
          const value = custom ? !!overrides[kind.key] : fromRole;
          const locked = isLocked(category, kind.key);
          return (
            <ApprovalRow
              key={kind.key}
              kind={kind}
              checked={value}
              locked={locked}
              hiddenModule={resolvePermission(permissions, kind.module) === "hidden"}
              onChange={(on) => {
                const next = { ...overrides };
                if (on === fromRole) delete next[kind.key];
                else next[kind.key] = on;
                onChange(next);
              }}
              extra={
                locked ? null : custom ? (
                  <span className="flex items-center gap-1">
                    <Chip className="border-blue-200 bg-blue-50 text-blue-700">Custom</Chip>
                    <button
                      type="button"
                      onClick={() => {
                        const next = { ...overrides };
                        delete next[kind.key];
                        onChange(next);
                      }}
                      title={`Follow the role again (${fromRole ? "allowed" : "not allowed"})`}
                      aria-label={`${kind.label}: follow the role again`}
                      className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
                      data-testid={`approval-reset-${kind.key}`}
                    >
                      <RotateCcw size={13} />
                    </button>
                  </span>
                ) : (
                  <span className="text-[11px] text-gray-400">Follows role</span>
                )
              }
            />
          );
        })}
      </div>
    </div>
  );
}

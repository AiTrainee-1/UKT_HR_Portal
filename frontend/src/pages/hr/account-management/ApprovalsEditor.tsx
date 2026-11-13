import { CheckCheck, History, Info, Lock, RotateCcw, ShieldCheck, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  APPROVAL_GROUPS,
  APPROVAL_INFO,
  APPROVAL_KINDS,
  ASSISTANT_LOCKED,
  effectiveApprovals,
  isLocked,
  legacyApprovals,
  normalizeOverrideApprovals,
  roleSwitch,
  setAllApprovals,
  type Approvals,
  type ApprovalKind,
  type Permissions,
} from "@/lib/hr-access";
import { MODULE_LABELS, resolvePermission } from "@/lib/permission-modules";
import { cn } from "@/lib/utils";
import { Chip } from "./parts";

const moduleLabel = (key: string) => MODULE_LABELS.find((m) => m.key === key)?.label ?? key;

/** What a role's switches give for every kind (a kind split out of an older one follows it; a "needs Edit" kind never set
 *  follows Edit), before the module and account rules. */
export function roleValues(approvals: Approvals, permissions: Permissions): Approvals {
  return Object.fromEntries(
    APPROVAL_KINDS.map((k) => [k.key, roleSwitch(approvals, k, resolvePermission(permissions, k.module))]),
  );
}

/** How many kinds a role's switches allow. */
export const roleApprovalCount = (approvals: Approvals | null, permissions: Permissions, category = ""): number =>
  Object.values(effectiveApprovals({ rolePermissions: permissions, roleApprovals: approvals, category })).filter(
    Boolean,
  ).length;

/** One switch changed: an older switch it was split out of is first spread over all its kinds, so the others keep it. */
export function setApproval(approvals: Approvals, kind: ApprovalKind, value: boolean): Approvals {
  const next = { ...approvals };
  if (kind.replaces && kind.replaces in next) {
    const old = !!next[kind.replaces];
    for (const k of APPROVAL_KINDS) if (k.replaces === kind.replaces && !(k.key in next)) next[k.key] = old;
    delete next[kind.replaces];
  }
  next[kind.key] = value;
  return next;
}

/** One kind of decision: what approving it means, and its switch (or the lock that keeps it off). */
function ApprovalRow({
  kind,
  checked,
  onChange,
  locked,
  level,
  source,
  extra,
}: {
  kind: ApprovalKind;
  checked: boolean;
  onChange?: (on: boolean) => void;
  /** HR Assistants can never approve this: the reason is shown and the switch stays off. */
  locked?: boolean;
  /** The level on the module that owns these requests. */
  level: string;
  /** Where an unset switch takes its value from ("Other requests" ...), shown beside it. */
  source?: string;
  /** Follows role / custom indicators (accounts). */
  extra?: React.ReactNode;
}) {
  const hiddenModule = level === "hidden";
  const noEdit = !!kind.needsEdit && level !== "edit";
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
          {kind.needsEdit && !locked && (
            <Chip className="border-slate-200 bg-slate-50 text-slate-600">Also needs Edit</Chip>
          )}
          {source && <span className="text-[10px] font-normal text-gray-400">({source})</span>}
        </p>
        <p className="text-xs text-gray-500">
          {locked ? ASSISTANT_LOCKED[kind.key] : kind.description}
          {!locked && kind.note && <span className="ml-1 text-gray-600">{kind.note}</span>}
          {!locked && hiddenModule && (
            <span className="ml-1 text-amber-700">
              No effect while {moduleLabel(kind.module)} is hidden: approving needs at least View on it.
            </span>
          )}
          {!locked && !hiddenModule && noEdit && (
            <span className="ml-1 text-amber-700">No effect without Edit on {moduleLabel(kind.module)}.</span>
          )}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {extra}
        <Switch
          checked={checked && !locked}
          onCheckedChange={(on) => onChange?.(on)}
          disabled={locked || !onChange}
          aria-label={`Allow approving ${kind.label}`}
          data-testid={`approval-switch-${kind.key}`}
        />
      </div>
    </div>
  );
}

/** A decision HR does not make, listed so nothing is missing (no switch). */
function InfoRow({ info }: { info: { key: string; label: string; text: string } }) {
  return (
    <div
      className="flex items-start gap-2 border-t border-gray-100 bg-gray-50/70 px-3 py-2.5 first:border-t-0"
      data-testid={`approval-info-${info.key}`}
    >
      <Info size={14} className="mt-0.5 shrink-0 text-gray-400" />
      <div className="min-w-0">
        <p className="text-sm font-semibold text-gray-700">{info.label}</p>
        <p className="text-xs text-gray-500">{info.text}</p>
      </div>
    </div>
  );
}

/** The kinds of one heading, in order, and the decisions listed there without a switch. */
const kindsIn = (group: string) => APPROVAL_KINDS.filter((k) => k.group === group);
const infoIn = (group: string) => APPROVAL_INFO.filter((i) => i.group === group);

function GroupHeading({
  label,
  on,
  total,
  onAll,
  id,
}: {
  label: string;
  on: number;
  total: number;
  onAll?: (value: boolean) => void;
  id: string;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 bg-slate-50 px-3 py-2">
      <p className="text-xs font-bold uppercase tracking-wider text-[#006496]">
        {label}{" "}
        <span
          className="font-semibold normal-case tracking-normal text-gray-500"
          data-testid={`approval-group-count-${id}`}
        >
          {on} of {total} on
        </span>
      </p>
      {onAll && total > 0 && (
        <span className="flex gap-1">
          <button
            type="button"
            onClick={() => onAll(true)}
            className="rounded border bg-white px-2 py-0.5 text-[10px] font-semibold text-gray-600 hover:bg-gray-100"
            data-testid={`approval-group-on-${id}`}
          >
            All on
          </button>
          <button
            type="button"
            onClick={() => onAll(false)}
            className="rounded border bg-white px-2 py-0.5 text-[10px] font-semibold text-gray-600 hover:bg-gray-100"
            data-testid={`approval-group-off-${id}`}
          >
            All off
          </button>
        </span>
      )}
    </div>
  );
}

/**
 * A role's Approvals: one switch per kind of decision, listed under the page it is made on, apart from the Hidden / View /
 * Edit levels. A role made for HR Assistants shows missing punches and attendance edits locked off. A role for any account
 * may stay on the old rule (approve = edit on the module), which is what every role made before had: then the switches are
 * offered, not forced.
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
    const now = roleApprovalCount(null, permissions, category);
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
              that is {now} of {APPROVAL_KINDS.length} kinds of decision. Set the approvals separately to let this role
              edit a module without approving its requests (or the other way round), one kind at a time.
            </p>
          </div>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => onChange(legacyApprovals(permissions, category))}
          data-testid="approvals-make-explicit"
        >
          <ShieldCheck size={14} /> Set approvals separately
        </Button>
      </div>
    );
  }
  const values = roleValues(approvals, permissions);
  const on = APPROVAL_KINDS.filter((k) => values[k.key] && !isLocked(category, k.key)).length;
  const setMany = (kinds: ApprovalKind[], value: boolean) =>
    onChange(kinds.reduce((a, k) => setApproval(a, k, value && !isLocked(category, k.key)), approvals));
  return (
    <div className="space-y-2" data-testid="approvals-editor">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-gray-50 p-3">
        <p className="text-sm font-semibold text-gray-900">
          Approvals{" "}
          <span className="font-normal text-gray-500" data-testid="approvals-count">
            {on} of {APPROVAL_KINDS.length} kinds of decision
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
      {APPROVAL_GROUPS.map((g) => {
        const kinds = kindsIn(g.id);
        return (
          <div key={g.id} className="overflow-hidden rounded-xl border bg-white" data-testid={`approval-group-${g.id}`}>
            <GroupHeading
              id={g.id}
              label={g.label}
              on={kinds.filter((k) => values[k.key] && !isLocked(category, k.key)).length}
              total={kinds.length}
              onAll={(value) => setMany(kinds, value)}
            />
            {kinds.map((kind) => {
              const unset = !(kind.key in approvals);
              const source =
                unset && kind.replaces && kind.replaces in approvals
                  ? `follows the old “${kind.replaces === "request" ? "Other requests" : "Advance"}” switch`
                  : unset && kind.needsEdit
                    ? "follows Edit until set"
                    : undefined;
              return (
                <ApprovalRow
                  key={kind.key}
                  kind={kind}
                  checked={!!values[kind.key]}
                  locked={isLocked(category, kind.key)}
                  level={resolvePermission(permissions, kind.module)}
                  source={source}
                  onChange={(value) => onChange(setApproval(approvals, kind, value))}
                />
              );
            })}
            {infoIn(g.id).map((info) => (
              <InfoRow key={info.key} info={info} />
            ))}
          </div>
        );
      })}
      <p className="text-[11px] leading-relaxed text-gray-400">
        Approving is separate from editing: a role can edit a module without approving its requests, or approve them
        with View only. Nobody approves requests of a module they can't open. “Also needs Edit” decisions are an extra
        right on top of Edit, never instead of it.
      </p>
    </div>
  );
}

/**
 * An HR Manager's / HR Assistant's own approvals: each kind follows the role unless switched for this person ("Custom",
 * with a reset back to the role). Locked items stay off for HR Assistants.
 */
export function AccountApprovalsEditor({
  roleApprovals,
  permissions,
  overrides,
  category,
  onChange,
}: {
  /** The role's switches (or, for a role that follows Edit, what Edit gives). */
  roleApprovals: Approvals;
  /** The account's levels after its own module changes. */
  permissions: Permissions;
  overrides: Approvals;
  category: string;
  onChange: (next: Approvals) => void;
}) {
  const own = normalizeOverrideApprovals(overrides);
  const fromRole = roleValues(roleApprovals, permissions);
  return (
    <div className="space-y-2" data-testid="account-approvals">
      {APPROVAL_GROUPS.map((g) => {
        const kinds = kindsIn(g.id);
        const value = (k: ApprovalKind) => (k.key in own ? !!own[k.key] : !!fromRole[k.key]);
        return (
          <div key={g.id} className="overflow-hidden rounded-xl border bg-white" data-testid={`approval-group-${g.id}`}>
            <GroupHeading
              id={g.id}
              label={g.label}
              on={kinds.filter((k) => value(k) && !isLocked(category, k.key)).length}
              total={kinds.length}
            />
            {kinds.map((kind) => {
              const custom = kind.key in own;
              const locked = isLocked(category, kind.key);
              return (
                <ApprovalRow
                  key={kind.key}
                  kind={kind}
                  checked={value(kind)}
                  locked={locked}
                  level={resolvePermission(permissions, kind.module)}
                  onChange={(on) => {
                    const next = { ...own };
                    if (on === !!fromRole[kind.key]) delete next[kind.key];
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
                            const next = { ...own };
                            delete next[kind.key];
                            onChange(next);
                          }}
                          title={`Follow the role again (${fromRole[kind.key] ? "allowed" : "not allowed"})`}
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
            {infoIn(g.id).map((info) => (
              <InfoRow key={info.key} info={info} />
            ))}
          </div>
        );
      })}
    </div>
  );
}

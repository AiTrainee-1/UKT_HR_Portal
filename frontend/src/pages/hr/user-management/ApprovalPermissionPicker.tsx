import { GitBranch, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useApprovalSummary } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import {
  PERMISSIONS,
  enabledCount,
  pipelineNote,
  type PermKey,
  type PermissionDef,
  type PermissionValues,
  type PipelineTone,
} from "./approval-permissions";

const NOTE_TEXT: Record<PipelineTone, string> = {
  ok: "text-muted-foreground",
  warn: "text-amber-700",
  off: "text-red-600",
};

function PermissionCard({
  perm,
  on,
  pending,
  disabled,
  note,
  onToggle,
}: {
  perm: PermissionDef;
  on: boolean;
  pending: boolean;
  disabled: boolean;
  note: ReturnType<typeof pipelineNote>;
  onToggle: () => void;
}) {
  const Icon = perm.icon;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      // "Enable"/"Disable" in the tooltip is also what makes a View-only role's lock (lib/view-only-lock.ts) catch it.
      title={on ? `Disable: ${perm.title}` : `Enable: ${perm.title}`}
      disabled={disabled || pending}
      onClick={onToggle}
      data-testid={`perm-${perm.key}`}
      className={cn(
        "group flex w-full items-start gap-3 rounded-xl border p-3 text-left transition-all",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:cursor-not-allowed",
        on
          ? "border-blue-200 bg-blue-50/70 shadow-[0_1px_0_rgba(37,99,235,0.06)] hover:border-blue-300"
          : "border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50/60",
        disabled && !pending && "opacity-70",
      )}
    >
      <span
        className={cn(
          "mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors",
          on ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-400",
        )}
      >
        <Icon size={17} strokeWidth={2} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-start justify-between gap-2">
          <span className={cn("text-sm font-semibold leading-5", on ? "text-gray-900" : "text-gray-600")}>
            {perm.title}
          </span>
          {pending ? (
            <Loader2 size={16} className="mt-0.5 shrink-0 animate-spin text-blue-600" aria-hidden />
          ) : (
            <span
              aria-hidden
              className={cn(
                "relative mt-0.5 inline-flex h-5 w-9 shrink-0 rounded-full transition-colors",
                on ? "bg-blue-600" : "bg-gray-300",
              )}
            >
              <span
                className={cn(
                  "absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform",
                  on ? "translate-x-[18px]" : "translate-x-0.5",
                )}
              />
            </span>
          )}
        </span>
        <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">{perm.description}</span>
        {note && (
          <span
            className={cn("mt-1.5 flex items-start gap-1 text-[11px] leading-4", NOTE_TEXT[note.tone])}
            data-testid={`perm-note-${perm.key}`}
          >
            <GitBranch size={11} className="mt-0.5 shrink-0" aria-hidden />
            <span>{note.text}</span>
          </span>
        )}
      </span>
    </button>
  );
}

/**
 * The approval permissions of a Department Head: one card per kind of request, switched on or off. Used when creating
 * a department user (the values are held by the dialog) and on the manager's page (each switch saves as it is
 * pressed, `pendingKey` marks the one being saved). It reads the approval pipelines, so each card says what path a
 * request takes, or that an HOD has no step in it.
 */
export function ApprovalPermissionPicker({
  values,
  onToggle,
  onSetAll,
  pendingKey = null,
  disabled = false,
  columns = "grid-cols-1 sm:grid-cols-2",
}: {
  values: PermissionValues;
  onToggle: (key: PermKey) => void;
  /** Switch every permission on or off (omit to hide the shortcuts). */
  onSetAll?: (on: boolean) => void;
  pendingKey?: PermKey | "all" | null;
  disabled?: boolean;
  /** Tailwind grid-cols classes: the dialog is two wide, the manager's page uses more. */
  columns?: string;
}) {
  const { data: summary } = useApprovalSummary();
  const on = enabledCount(values);
  const busy = pendingKey !== null;

  return (
    <div className="space-y-3" data-testid="permission-picker">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground" data-testid="permission-count">
          <b className="text-gray-900">{on}</b> of {PERMISSIONS.length} switched on
        </p>
        {onSetAll && (
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              disabled={disabled || busy || on === PERMISSIONS.length}
              onClick={() => onSetAll(true)}
            >
              Enable all
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-muted-foreground"
              disabled={disabled || busy || on === 0}
              onClick={() => onSetAll(false)}
            >
              Disable all
            </Button>
          </div>
        )}
      </div>
      <div className={cn("grid gap-2", columns)}>
        {PERMISSIONS.map((perm) => (
          <PermissionCard
            key={perm.key}
            perm={perm}
            on={values[perm.key]}
            pending={pendingKey === perm.key || pendingKey === "all"}
            disabled={disabled}
            note={pipelineNote(summary, perm)}
            onToggle={() => onToggle(perm.key)}
          />
        ))}
      </div>
    </div>
  );
}

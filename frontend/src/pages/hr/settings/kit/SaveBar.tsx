import { Loader2, RotateCcw, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The Save button of a settings group, with the state HR needs: nothing changed (quiet), unsaved changes (the bar says
 * so and offers Discard), saving. A tab keeps its own form state; this only draws the bar. Give the button the label
 * the tab has always had ("Save Company Settings"): other pages and the tests find it by name.
 */
export function SaveBar({
  dirty,
  saving,
  onSave,
  onDiscard,
  saveLabel,
  savingLabel = "Saving…",
  disabled,
  hint,
  className,
}: {
  dirty: boolean;
  saving?: boolean;
  onSave: () => void;
  /** Put the form back to what is saved. Omit when the tab has no way to do it. */
  onDiscard?: () => void;
  saveLabel: string;
  savingLabel?: string;
  /** Stops saving (view-only role, or a value that is not valid yet). */
  disabled?: boolean;
  /** Shown beside the button instead of the default text ("Fix the highlighted fields first"). */
  hint?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-3 rounded-lg px-3 py-2 transition-colors",
        dirty ? "settings-glass !border-amber-200 !bg-amber-50" : "bg-transparent",
        className,
      )}
      data-testid="save-bar"
      data-dirty={dirty ? "true" : "false"}
    >
      <Button size="sm" onClick={onSave} disabled={disabled || saving} className="gap-1.5">
        {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
        {saving ? savingLabel : saveLabel}
      </Button>
      {dirty && onDiscard && (
        <Button size="sm" variant="ghost" onClick={onDiscard} disabled={saving} className="gap-1.5 text-gray-600">
          <RotateCcw size={13} /> Discard changes
        </Button>
      )}
      <span className={cn("text-xs font-medium", dirty ? "text-amber-800" : "text-gray-400")}>
        {hint ?? (dirty ? "You have changes that are not saved yet." : "Everything shown is saved.")}
      </span>
    </div>
  );
}

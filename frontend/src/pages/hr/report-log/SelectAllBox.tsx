import { Checkbox } from "@/components/ui/checkbox";
import type { SelectState } from "./selection";

// A box in the same style as the other tables of the portal (Production Employees, Device Control): ticked, empty, or a
// dimmed tick when only some of the rows in view are ticked.
const INDETERMINATE_CLASS =
  "data-[state=indeterminate]:bg-primary/60 data-[state=indeterminate]:text-primary-foreground";

/** The box in a table header that ticks (or unticks) every row in view. */
export default function SelectAllBox({
  state,
  count,
  onToggle,
  testId = "select-all",
  label,
}: {
  state: SelectState;
  /** How many rows are in view (what the box would tick). */
  count: number;
  onToggle: () => void;
  testId?: string;
  /** Names the box for a screen reader when it is not the whole list's ("all 19 in HO"). */
  label?: string;
}) {
  return (
    <Checkbox
      checked={state === "all" ? true : state === "some" ? "indeterminate" : false}
      onCheckedChange={onToggle}
      disabled={count === 0}
      aria-label={
        label
          ? `${state === "all" ? "Deselect" : "Select"} ${label}`
          : state === "all"
            ? `Deselect all ${count} employees shown`
            : `Select all ${count} employees shown`
      }
      className={INDETERMINATE_CLASS}
      data-testid={testId}
    />
  );
}

import { Briefcase, Factory } from "lucide-react";
import { ORG_CATEGORIES, ORG_CATEGORY_LABEL, type OrgCategory } from "@/lib/departments";
import { cn } from "@/lib/utils";

/** Staff / Production inside the department and designation dialogs (the page's switch presets it). */
export function KindPicker({
  value,
  onChange,
  disabled,
  testId,
}: {
  value: OrgCategory;
  onChange: (c: OrgCategory) => void;
  disabled?: boolean;
  testId: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Staff or production"
      className="grid grid-cols-2 gap-1 rounded-xl border bg-gray-50 p-1"
      data-testid={testId}
      data-value={value}
    >
      {ORG_CATEGORIES.map((c) => {
        const on = value === c;
        const Icon = c === "production" ? Factory : Briefcase;
        return (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={disabled && !on}
            onClick={() => onChange(c)}
            data-testid={`${testId}-${c}`}
            className={cn(
              "flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors",
              on
                ? c === "production"
                  ? "bg-amber-500 text-white shadow-sm"
                  : "bg-blue-600 text-white shadow-sm"
                : "text-gray-600 hover:bg-white disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent",
            )}
          >
            <Icon size={14} />
            {ORG_CATEGORY_LABEL[c]}
          </button>
        );
      })}
    </div>
  );
}

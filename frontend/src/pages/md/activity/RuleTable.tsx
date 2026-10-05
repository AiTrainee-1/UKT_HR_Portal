import { CATEGORY_ORDER } from "./logic";
import { CATEGORY_ICON, SeverityChip } from "./parts";
import type { RuleRow } from "./types";

/** "What counts as sensitive": the rule table that decides it, in plain words, grouped by category. */
export default function RuleTable({ rules }: { rules: RuleRow[] }) {
  return (
    <div className="grid grid-cols-1 gap-4 @xl:grid-cols-2" data-testid="md-activity-rules">
      {CATEGORY_ORDER.map((category) => {
        const own = rules.filter((r) => r.category === category);
        if (own.length === 0) return null;
        const Icon = CATEGORY_ICON[category];
        return (
          <div key={category}>
            <h5 className="mb-1.5 flex items-center gap-1.5 text-[12px] font-bold text-[#1a3a4a]">
              <Icon size={14} className="text-[#006496]" />
              {own[0].categoryLabel}
            </h5>
            <ul className="space-y-1">
              {own.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-2 text-xs text-[#1a3a4a]">
                  <span>{r.title}</span>
                  <SeverityChip severity={r.severity} />
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

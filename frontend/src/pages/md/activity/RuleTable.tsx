import { CATEGORY_ORDER } from "./logic";
import { CATEGORY_ICON, SeverityChip } from "./parts";
import type { RuleRow } from "./types";

/** "What counts as sensitive": the rule table that decides it, in plain words, grouped by category. One quiet panel per
 *  category, each rule with the severity it carries. */
export default function RuleTable({ rules }: { rules: RuleRow[] }) {
  return (
    <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2" data-testid="md-activity-rules">
      {CATEGORY_ORDER.map((category) => {
        const own = rules.filter((r) => r.category === category);
        if (own.length === 0) return null;
        const Icon = CATEGORY_ICON[category];
        return (
          <div key={category} className="md-panel p-4">
            <h5 className="mb-1.5 flex items-center gap-2.5 text-[13px] font-bold text-md-ink">
              <span className="md-icon-tile h-8 w-8 shrink-0">
                <Icon size={15} />
              </span>
              {own[0].categoryLabel}
            </h5>
            <ul>
              {own.map((r) => (
                <li
                  key={r.id}
                  className="flex items-center justify-between gap-3 border-t border-md-line py-2 text-xs leading-snug text-md-ink first:border-t-0"
                >
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

import { History } from "lucide-react";

/** One entry of a rule's dated history, already in words: "From 19 Nov 2026" and "On, cut-off 06:00". */
export type RuleHistoryLine = { when: string; what: string };

/** How many entries are listed (the newest); older ones are counted. */
export const RULE_HISTORY_SHOWN = 4;

/**
 * The read-only dated history of a switch (the server keeps it, review 2026-11-19): every change applies from the day it
 * is saved, and a day keeps the value in force on it, so an earlier day is never judged again by a later change. Shown as
 * a short list under the switch, newest first. Nothing is shown while the server reports no history (never changed, or
 * an older server).
 */
export function RuleHistory({
  lines,
  testId,
  label = "Changes so far",
}: {
  /** Oldest first, as the server sends them. */
  lines: RuleHistoryLine[];
  testId?: string;
  label?: string;
}) {
  if (lines.length === 0) return null;
  const newest = [...lines].reverse();
  const shown = newest.slice(0, RULE_HISTORY_SHOWN);
  const older = newest.length - shown.length;
  return (
    <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2" data-testid={testId}>
      <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        <History size={12} aria-hidden="true" />
        {label}
      </p>
      <ul className="mt-1 space-y-0.5 text-xs text-slate-600">
        {shown.map((line, i) => (
          <li key={`${line.when}-${i}`} data-testid={testId ? `${testId}-line` : undefined}>
            <span className="font-semibold text-slate-700">{line.when}:</span> {line.what}
          </li>
        ))}
      </ul>
      {older > 0 && (
        <p className="mt-0.5 text-[11px] text-slate-500">
          and {older === 1 ? "1 earlier change" : `${older} earlier changes`}
        </p>
      )}
      <p className="mt-1 text-[11px] text-slate-500">
        A change applies from the day it is saved; earlier days keep the rule they were worked out with.
      </p>
    </div>
  );
}

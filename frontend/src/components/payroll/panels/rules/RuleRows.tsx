import type { ComponentType } from "react";
import { Link } from "wouter";
import {
  AlarmClock,
  ArrowUpRight,
  CalendarClock,
  CalendarRange,
  Fingerprint,
  IndianRupee,
  Landmark,
  ScrollText,
  Timer,
} from "lucide-react";
import { plural } from "@/components/payroll/kit/format";
import { Chip } from "@/components/payroll/kit/parts";
import type { RuleGroup, RuleItem } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { ACCENT, type PanelAccent } from "../issues/panel-kit";
import { RULE_SOURCE_LABEL, ruleEditLink, ruleGroupKind, type RuleGroupKind } from "./rules-logic";

const GROUP_ICON: Record<RuleGroupKind, ComponentType<{ size?: number; className?: string }>> = {
  late: AlarmClock,
  overtime: Timer,
  deductions: Landmark,
  attendance: Fingerprint,
  shift: CalendarClock,
  cycle: CalendarRange,
  pay: IndianRupee,
  other: ScrollText,
};

/**
 * One rule: its name and what it means, its value in words and where it is changed. Used for the rules configured on the
 * Settings page and for each employee's own rules. A rule that has changed since a payroll was generated says so.
 */
export function RuleRow({ rule, employeeId, accent }: { rule: RuleItem; employeeId?: number; accent: PanelAccent }) {
  const link = ruleEditLink(rule, employeeId);
  return (
    <li
      className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 py-2.5"
      data-testid={`rule-${rule.key}`}
      data-source={rule.source}
    >
      <div className="min-w-0 flex-1 basis-44">
        <p className="text-sm font-semibold text-gray-900">{rule.label}</p>
        {rule.detail && (
          <p className="mt-0.5 break-words text-xs leading-snug text-muted-foreground" data-testid="rule-detail">
            {rule.detail}
          </p>
        )}
        {rule.applied && (
          <p className="mt-0.5 break-words text-xs text-gray-600" data-testid="rule-applied">
            Generated with <span className="font-semibold">{rule.applied}</span>
          </p>
        )}
      </div>
      <div className="flex min-w-0 max-w-full flex-col items-end gap-1 text-right">
        <p className="break-words text-sm font-bold tabular-nums text-gray-900" data-testid="rule-value">
          {rule.value}
        </p>
        <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
          {rule.changed && <Chip tone="warning">Changed since</Chip>}
          {rule.source !== "settings" && (
            <span className="text-[11px] text-muted-foreground">{RULE_SOURCE_LABEL[rule.source]}</span>
          )}
          {link && (
            <Link
              href={link.href}
              className={cn(
                "inline-flex items-center gap-0.5 text-xs font-semibold hover:underline",
                ACCENT[accent].link,
              )}
              data-testid="rule-link"
            >
              {link.label} <ArrowUpRight size={11} />
            </Link>
          )}
        </div>
      </div>
    </li>
  );
}

/** A heading with an icon and the rules of the group under it, one per row. */
export function RuleGroupCard({
  group,
  employeeId,
  accent,
  testId,
}: {
  group: RuleGroup;
  employeeId?: number;
  accent: PanelAccent;
  testId?: string;
}) {
  const Icon = GROUP_ICON[ruleGroupKind(group.group)];
  return (
    <section className="rounded-2xl border border-slate-100 bg-white p-4" data-testid={testId}>
      <h4 className="flex flex-wrap items-center gap-2 text-sm font-bold text-gray-900">
        <span className="rounded-xl bg-slate-50 p-1.5 text-slate-600 ring-1 ring-slate-100">
          <Icon size={14} />
        </span>
        <span>{group.group}</span>{" "}
        <span className="text-xs font-semibold text-muted-foreground">· {plural(group.items.length, "rule")}</span>
      </h4>
      <ul className="mt-1 divide-y divide-slate-100">
        {group.items.map((rule, i) => (
          <RuleRow key={`${rule.key}-${i}`} rule={rule} employeeId={employeeId} accent={accent} />
        ))}
      </ul>
    </section>
  );
}

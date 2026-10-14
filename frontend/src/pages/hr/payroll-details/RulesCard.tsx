import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import {
  AlertTriangle,
  ArrowUpRight,
  BookOpenCheck,
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Chip, EmptyNote, SectionCard } from "@/components/payroll/kit/parts";
import type { RuleGroup, RuleItem, RuleSource } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import type { Accent } from "./accent";
import { ToggleChip } from "./parts";
import {
  RULE_SOURCES,
  SOURCE_META,
  changedRules,
  countRules,
  filterRuleGroups,
  isRuleChanged,
  sectionDomId,
  slug,
  sourceCounts,
} from "./logic";

/** Asks the card to find one rule (from "See the rule" on a money line); the nonce lets the same rule be asked twice. */
export type RuleFocus = { key: string; nonce: number } | null;

/**
 * The rules that govern this payroll, in groups: where each comes from (Settings, the employee's profile, the shift,
 * the pay cycle), what it says, and whether it was changed after the payroll was generated, with the way to the
 * Settings page that holds it. Search, filter by source, show only the changed ones, collapse a group.
 */
export function RulesCard({ groups, accent, focus }: { groups: RuleGroup[]; accent: Accent; focus: RuleFocus }) {
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<RuleSource | "all">("all");
  const [changedOnly, setChangedOnly] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [flash, setFlash] = useState<string | null>(null);

  const total = countRules(groups);
  const changed = useMemo(() => changedRules(groups), [groups]);
  const counts = useMemo(() => sourceCounts(groups), [groups]);
  const shown = useMemo(
    () => filterRuleGroups(groups, { query, source, changedOnly }),
    [groups, query, source, changedOnly],
  );
  const filtering = query.trim() !== "" || source !== "all" || changedOnly;

  // "See the rule" on a money line: show everything, then bring that rule into view and flash it.
  useEffect(() => {
    if (!focus) return;
    setQuery("");
    setSource("all");
    setChangedOnly(false);
    setCollapsed(new Set());
    setFlash(focus.key);
  }, [focus]);

  useEffect(() => {
    if (!flash) return;
    const row = [...document.querySelectorAll<HTMLElement>("[data-rule-key]")].find(
      (el) => el.dataset.ruleKey === flash,
    );
    row?.scrollIntoView?.({ block: "center", behavior: "smooth" });
    const timer = window.setTimeout(() => setFlash(null), 2500);
    return () => window.clearTimeout(timer);
  }, [flash]);

  const toggleGroup = (name: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const allCollapsed = shown.length > 0 && shown.every((g) => collapsed.has(g.group));

  return (
    <SectionCard
      id={sectionDomId("rules")}
      testId="pd-section-rules"
      className="scroll-mt-16"
      icon={BookOpenCheck}
      title="Rules behind this payroll"
      description="What was assigned to this employee and what is configured in Settings, as this payroll was generated with it. Each rule says where it comes from and where to change it."
      actions={
        total > 0 && (
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 print:hidden"
            onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(shown.map((g) => g.group)))}
            data-testid="pd-rules-collapse-all"
          >
            {allCollapsed ? <ChevronsUpDown size={13} /> : <ChevronsDownUp size={13} />}
            {allCollapsed ? "Expand all" : "Collapse all"}
          </Button>
        )
      }
    >
      {total === 0 ? (
        <EmptyNote
          icon={BookOpenCheck}
          title="No rules were stored with this payroll"
          hint="Payroll records the rules a payroll is priced with when it computes it; this one has none to show."
          testId="pd-rules-empty"
        />
      ) : (
        <>
          {changed.length > 0 && (
            <div
              className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3"
              data-testid="pd-rules-changed-banner"
            >
              <p className="flex items-start gap-2 text-sm text-amber-900">
                <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                <span>
                  <strong>
                    {changed.length} {changed.length === 1 ? "rule has" : "rules have"} changed
                  </strong>{" "}
                  in Settings since this payroll was generated. Regenerating it would price it with today&apos;s rules;
                  this page shows what it was generated with.
                </span>
              </p>
              <ToggleChip
                pressed={changedOnly}
                onClick={() => setChangedOnly((v) => !v)}
                tone="warning"
                className="print:hidden"
                testId="pd-rules-changed-only"
              >
                Show only changed
              </ToggleChip>
            </div>
          )}

          <div className="mb-4 flex flex-wrap items-center gap-2 print:hidden">
            <div className="relative min-w-[12rem] flex-1 sm:max-w-xs">
              <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search the rules…"
                aria-label="Search the rules"
                className="h-9 rounded-xl pl-8 text-sm"
                data-testid="pd-rules-search"
              />
            </div>
            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Where a rule comes from">
              <ToggleChip pressed={source === "all"} onClick={() => setSource("all")} testId="pd-rules-source-all">
                All <span className="tabular-nums opacity-70">{counts.all}</span>
              </ToggleChip>
              {RULE_SOURCES.filter((s) => counts[s] > 0).map((s) => (
                <ToggleChip
                  key={s}
                  pressed={source === s}
                  onClick={() => setSource(source === s ? "all" : s)}
                  tone={SOURCE_META[s].tone}
                  title={SOURCE_META[s].hint}
                  testId={`pd-rules-source-${s}`}
                >
                  {SOURCE_META[s].label} <span className="tabular-nums opacity-70">{counts[s]}</span>
                </ToggleChip>
              ))}
            </div>
          </div>

          {shown.length === 0 ? (
            <EmptyNote
              icon={Search}
              title="No rule matches"
              hint="Try a different word, or clear the filters."
              testId="pd-rules-nomatch"
              action={
                filtering ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-1 h-8"
                    onClick={() => {
                      setQuery("");
                      setSource("all");
                      setChangedOnly(false);
                    }}
                  >
                    Clear the filters
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <div className="space-y-3">
              {shown.map((group) => {
                const open = !collapsed.has(group.group);
                const changedHere = group.items.filter(isRuleChanged).length;
                return (
                  <section
                    key={group.group}
                    className="overflow-hidden rounded-xl border border-slate-100"
                    data-testid={`pd-rule-group-${slug(group.group)}`}
                  >
                    <h4>
                      <button
                        type="button"
                        onClick={() => toggleGroup(group.group)}
                        aria-expanded={open}
                        className="flex w-full items-center justify-between gap-3 bg-slate-50 px-4 py-2.5 text-left"
                      >
                        <span className="flex items-center gap-2 text-sm font-bold text-slate-800">
                          {group.group}
                          <span className="text-xs font-semibold text-muted-foreground">{group.items.length}</span>
                          {changedHere > 0 && <Chip tone="warning">{changedHere} changed</Chip>}
                        </span>
                        <ChevronDown
                          size={15}
                          className={cn(
                            "shrink-0 text-slate-400 transition-transform print:hidden",
                            !open && "-rotate-90",
                          )}
                        />
                      </button>
                    </h4>
                    <ul className={cn("divide-y divide-slate-100", !open && "hidden print:block")}>
                      {group.items.map((item) => (
                        <RuleRow key={item.key} item={item} accent={accent} flashing={flash === item.key} />
                      ))}
                    </ul>
                  </section>
                );
              })}
            </div>
          )}
        </>
      )}
    </SectionCard>
  );
}

function RuleRow({ item, accent, flashing }: { item: RuleItem; accent: Accent; flashing: boolean }) {
  const changed = isRuleChanged(item);
  const source = SOURCE_META[item.source] ?? { label: item.source, tone: "neutral" as const, hint: "" };
  return (
    <li
      className={cn(
        "grid gap-x-4 gap-y-1.5 px-4 py-3 sm:grid-cols-[13rem_minmax(0,1fr)_auto]",
        changed && "bg-amber-50/60",
        flashing && cn("ring-2 ring-inset", accent.ring),
      )}
      data-testid={`pd-rule-${item.key}`}
      data-rule-key={item.key}
      data-changed={changed ? "true" : "false"}
    >
      <div className="min-w-0">
        <p className="text-sm font-semibold text-slate-800">{item.label}</p>
        <Chip tone={source.tone} title={source.hint} className="mt-1">
          {source.label}
        </Chip>
      </div>
      <div className="min-w-0">
        {changed ? (
          <p className="text-sm text-slate-800" data-testid={`pd-rule-diff-${item.key}`}>
            <span className="text-xs text-muted-foreground">Generated with:</span>{" "}
            <strong>{item.applied ?? "—"}</strong>
            <span className="px-1.5 text-slate-300">·</span>
            <span className="text-xs text-muted-foreground">Settings now:</span> <strong>{item.value}</strong>
          </p>
        ) : (
          <p className="text-sm text-slate-800">{item.value}</p>
        )}
        {item.detail && <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{item.detail}</p>}
        {changed && (
          <span className="mt-1.5 inline-flex" data-testid={`pd-rule-changed-${item.key}`}>
            <Chip tone="warning" icon={AlertTriangle} className="whitespace-normal text-left">
              Changed since this payroll was generated - regenerate to apply
            </Chip>
          </span>
        )}
      </div>
      <div className="sm:text-right">
        {item.settingsPath && (
          <Link
            href={item.settingsPath}
            className={cn(
              "inline-flex items-center gap-1 whitespace-nowrap text-xs font-semibold underline-offset-2 hover:underline print:hidden",
              accent.text,
            )}
            data-testid={`pd-rule-link-${item.key}`}
          >
            Open in Settings <ArrowUpRight size={12} />
          </Link>
        )}
      </div>
    </li>
  );
}

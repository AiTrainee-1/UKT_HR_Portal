import { Info, Moon, Plus, Sun, Trash2, Users } from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { SettingBlock, SettingsSection } from "../kit/SettingBlock";
import { PRODUCTION_SHIFT_SECTIONS, productionShiftText } from "../ProductionShiftsTab.meta";
import { APPLIES_ON, KIND_LABEL, newGroup, unverifiedRows, type GroupRow } from "./form";
import { LadderTable } from "./LadderTable";
import { clock12 } from "./time";
import { Problem, type SectionProps } from "./ui";

const block = (id: string) => ({ id, ...productionShiftText(id) });

const KIND_ICON: Record<GroupRow["kind"], ComponentType<{ size?: number; className?: string }>> = {
  day: Sun,
  night: Moon,
  sunday: Sun,
  custom: Users,
};

const APPLIES_WORDS: Record<GroupRow["appliesOn"], string> = {
  mon_sat: "Monday to Saturday",
  sunday: "Sunday",
  all: "any day",
};

/** A labelled box of a group, with a line that says what it is. */
function GroupField({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0 space-y-1", className)}>
      <p className="text-xs font-semibold text-gray-700">{label}</p>
      {children}
      {hint && <p className="text-[11px] leading-snug text-gray-500">{hint}</p>}
    </div>
  );
}

/**
 * The shift groups: one card for each (Day, Night, Sunday, and any HR adds), with the boxes that decide which days it is
 * used for and its ladder. A group HR adds starts switched off, because a group that is on must not share a first-punch
 * window with another that can be used on the same day.
 */
export function GroupsSection({ draft, patch, readOnly, validation }: SectionProps) {
  const setGroups = (groups: GroupRow[]) => patch({ groups });
  const patchGroup = (key: string, change: Partial<GroupRow>) =>
    setGroups(draft.groups.map((g) => (g.key === key ? { ...g, ...change } : g)));
  const unverified = unverifiedRows(draft);

  return (
    <SettingsSection
      id="production-shifts-groups"
      icon={Sun}
      title={PRODUCTION_SHIFT_SECTIONS.groups}
      purpose="The default timings of the factory: the Day shift from 8:30 AM, the Night shift from 9:00 PM and the Sunday shift. Each ladder says what leaving at each time earns. Change a time or a figure, switch a row off, add a row, or add a group of your own."
      usedBy={[
        { label: "Production Attendance", to: "/hr/attendance/production" },
        { label: "Production Payroll", to: "/hr/production-payroll" },
      ]}
      testId="production-shifts-groups"
    >
      <SettingBlock
        {...block("shift-groups")}
        className="lg:grid-cols-1"
        affects={[
          {
            where: "Production Attendance",
            what: "each day's group is the one whose first-punch window holds the first punch; its ladder gives the shifts earned",
            to: "/hr/attendance/production",
          },
          {
            where: "Production Payroll",
            what: "pay is the shifts earned times the salary per shift, the next time a period is generated",
            to: "/hr/production-payroll",
          },
        ]}
      >
        <div
          className="rounded-lg bg-slate-50 px-3 py-2.5 text-[12px] leading-snug text-slate-600 ring-1 ring-slate-200"
          data-testid="ladder-how-box"
        >
          <p className="mb-1 font-semibold text-slate-700">How a ladder works</p>
          <ul className="list-disc space-y-0.5 pl-4" data-testid="ladder-how">
            <li>Leaving exactly at a row's time earns that row's shifts.</li>
            <li>
              Between two rows the shifts grow by the paid minute: halfway through the paid time between 1.00 and 1.50
              is 1.25. Breaks are not counted.
            </li>
            <li>
              A first punch later than the start plus the grace loses shifts at the first row's rate; early costs
              nothing.
            </li>
            <li>
              A worker who punches in and out several times is paid for each pair, never for the gaps outside a break.
            </li>
          </ul>
        </div>
        {unverified.length > 0 && (
          <div
            className="flex items-start gap-2 rounded-xl border border-sky-200 bg-sky-50 px-3 py-2.5 text-[12px] leading-snug text-sky-900"
            data-testid="unverified-banner"
          >
            <Info size={14} className="mt-0.5 shrink-0" />
            <div className="space-y-1">
              <p className="font-semibold">
                {unverified.length === 1 ? "Check this row with HR" : `Check these ${unverified.length} rows with HR`}
              </p>
              <p>
                They follow the owner's handwritten table exactly as it reads, but the handwriting could be read two
                ways. Ask the owner, and change the time if it should be different. The note goes away from a row once
                its time or its shifts are changed.
              </p>
              <ul className="list-disc space-y-0.5 pl-4">
                {unverified.map(({ group, row, hint }) => (
                  <li key={row.key}>
                    {group}: leaving at {clock12(row.outTime)}
                    {row.outNextDay ? " the next morning" : ""} earns {Number(row.shiftValue).toFixed(2)} shifts ({hint}
                    )
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {validation.noGroup && <Problem testId="groups-none-on-error">{validation.noGroup}</Problem>}
        {draft.groups.length === 0 ? (
          <p
            className="rounded-lg border border-dashed p-4 text-center text-xs text-gray-500"
            data-testid="groups-empty"
          >
            No shift groups: with none in use every production day keeps the old calculation. Add a group to start.
          </p>
        ) : (
          <div className="space-y-4">
            {draft.groups.map((g, gi) => {
              const e = validation.groups[gi]?.errors ?? {};
              const name = g.label.trim() || `Group ${gi + 1}`;
              const KindIcon = KIND_ICON[g.kind];
              return (
                <section
                  key={g.key}
                  data-testid="group-card"
                  data-kind={g.kind}
                  data-enabled={g.enabled ? "true" : "false"}
                  aria-label={name}
                  className={cn("space-y-4 rounded-xl border border-slate-200 p-3 sm:p-4", !g.enabled && "bg-slate-50")}
                >
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                    <span className="settings-tile h-8 w-8 shrink-0 rounded-lg">
                      <KindIcon size={15} />
                    </span>
                    <div className="min-w-[10rem] flex-1">
                      <Input
                        type="text"
                        aria-label={`${name}: name`}
                        value={g.label}
                        disabled={readOnly}
                        aria-invalid={e.label ? true : undefined}
                        className={cn("h-9 font-semibold", e.label && "border-red-400")}
                        onChange={(ev) => patchGroup(g.key, { label: ev.target.value })}
                      />
                    </div>
                    <span
                      className="settings-chip px-2 py-0.5 text-[11px] font-semibold text-slate-600"
                      data-testid="group-kind"
                    >
                      {KIND_LABEL[g.kind]}
                    </span>
                    <label className="flex items-center gap-2 text-xs font-semibold text-gray-700">
                      <Switch
                        checked={g.enabled}
                        disabled={readOnly}
                        aria-label={`${name}: in use`}
                        onCheckedChange={(v) => patchGroup(g.key, { enabled: v })}
                      />
                      {g.enabled ? "In use" : "Off"}
                    </label>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      aria-label={`Remove group ${name}`}
                      title="Remove this group and its rows"
                      className="h-8 w-8 text-rose-600 hover:text-rose-800"
                      disabled={readOnly}
                      onClick={() => setGroups(draft.groups.filter((x) => x.key !== g.key))}
                    >
                      <Trash2 size={14} />
                    </Button>
                  </div>
                  {e.label && <Problem>{e.label}</Problem>}

                  <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 xl:grid-cols-4">
                    <GroupField label="Used on" hint="The days of the week this group can be the answer for.">
                      <select
                        aria-label={`${name}: used on`}
                        className="h-9 w-full rounded-md border bg-white px-2 text-sm disabled:opacity-50"
                        value={g.appliesOn}
                        disabled={readOnly}
                        onChange={(ev) => patchGroup(g.key, { appliesOn: ev.target.value as GroupRow["appliesOn"] })}
                      >
                        {APPLIES_ON.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    </GroupField>
                    <GroupField
                      label="Start time"
                      hint="When workers of this group should arrive. The grace comes after it."
                    >
                      <Input
                        type="time"
                        aria-label={`${name}: start time`}
                        value={g.startTime}
                        disabled={readOnly}
                        aria-invalid={e.start ? true : undefined}
                        className={cn("h-9", e.start && "border-red-400")}
                        onChange={(ev) => patchGroup(g.key, { startTime: ev.target.value })}
                      />
                    </GroupField>
                    <GroupField
                      label="First punch from"
                      hint="A day belongs to this group when its first punch is between these two times."
                    >
                      <Input
                        type="time"
                        aria-label={`${name}: first punch from`}
                        value={g.firstPunchFrom}
                        disabled={readOnly}
                        aria-invalid={e.window ? true : undefined}
                        className={cn("h-9", e.window && "border-red-400")}
                        onChange={(ev) => patchGroup(g.key, { firstPunchFrom: ev.target.value })}
                      />
                    </GroupField>
                    <GroupField label="First punch to">
                      <Input
                        type="time"
                        aria-label={`${name}: first punch to`}
                        value={g.firstPunchTo}
                        disabled={readOnly}
                        aria-invalid={e.window ? true : undefined}
                        className={cn("h-9", e.window && "border-red-400")}
                        onChange={(ev) => patchGroup(g.key, { firstPunchTo: ev.target.value })}
                      />
                    </GroupField>
                    <GroupField
                      label="Standard departure"
                      hint="Only used to flag leaving early. It does not change the shifts earned. Empty = none."
                      className="sm:col-span-2"
                    >
                      <div className="flex flex-wrap items-center gap-3">
                        <Input
                          type="time"
                          aria-label={`${name}: standard departure`}
                          value={g.mainOutTime}
                          disabled={readOnly}
                          aria-invalid={e.mainOut ? true : undefined}
                          className={cn("h-9 w-32", e.mainOut && "border-red-400")}
                          onChange={(ev) => patchGroup(g.key, { mainOutTime: ev.target.value })}
                        />
                        <label className="flex items-center gap-1.5 text-xs text-gray-600">
                          <input
                            type="checkbox"
                            className="h-3.5 w-3.5"
                            checked={g.mainOutNextDay}
                            disabled={readOnly || g.mainOutTime === ""}
                            aria-label={`${name}: standard departure is the next day`}
                            onChange={(ev) => patchGroup(g.key, { mainOutNextDay: ev.target.checked })}
                          />
                          Next day
                        </label>
                      </div>
                    </GroupField>
                  </div>
                  {(e.start || e.window || e.mainOut || e.overlap) && (
                    <div className="space-y-1">
                      {e.start && <Problem testId="group-start-error">{e.start}</Problem>}
                      {e.window && <Problem testId="group-window-error">{e.window}</Problem>}
                      {e.mainOut && <Problem>{e.mainOut}</Problem>}
                      {e.overlap && <Problem testId="group-overlap-error">{e.overlap}</Problem>}
                    </div>
                  )}
                  {!e.window && !e.overlap && (
                    <p className="text-xs leading-snug text-gray-600" data-testid="group-window-note">
                      A day whose first punch is between {clock12(g.firstPunchFrom)} and {clock12(g.firstPunchTo)} on{" "}
                      {APPLIES_WORDS[g.appliesOn]} uses this group{g.enabled ? "" : " (once it is switched on)"}.
                    </p>
                  )}

                  <LadderTable
                    group={g}
                    name={name}
                    patchGroup={patchGroup}
                    readOnly={readOnly}
                    errors={e}
                    rowErrors={validation.groups[gi]?.rules ?? []}
                  />
                </section>
              );
            })}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="gap-1.5"
            disabled={readOnly}
            onClick={() => setGroups([...draft.groups, newGroup()])}
            data-testid="group-add"
          >
            <Plus size={13} /> Add a group
          </Button>
          <span className="text-xs text-gray-500">
            A new group starts switched off: set its window and ladder, then switch it on.
          </span>
        </div>
      </SettingBlock>
    </SettingsSection>
  );
}

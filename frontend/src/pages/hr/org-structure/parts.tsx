import type { ReactNode } from "react";
import { Building2, MapPin, SearchX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { TONE } from "@/lib/statusTones";
import { cn } from "@/lib/utils";
import { Chip } from "../account-management/parts";
import { initials, levelInfo, splitPercent, typeLabel } from "./logic";

export { StatCard } from "../account-management/parts";

/** Staff is blue, production amber: the same two colours in the split bar, the chips and the counts. */
export const STAFF_DOT = "bg-blue-500";
export const PRODUCTION_DOT = "bg-amber-500";

export function TypeChip({ type }: { type: string }) {
  return (
    <Chip
      className={
        type === "production"
          ? "border-amber-200 bg-amber-50 text-amber-800"
          : "border-blue-200 bg-blue-50 text-blue-700"
      }
    >
      {typeLabel(type)}
    </Chip>
  );
}

/** The level of a designation; nothing at all when it has none. */
export function LevelChip({ level }: { level: string | null | undefined }) {
  const info = levelInfo(level);
  if (!info.key) return null;
  return (
    <span data-testid="level-chip" className="inline-flex">
      <Chip className={TONE[info.tone]}>{info.label}</Chip>
    </span>
  );
}

export function BranchChip({ name }: { name?: string | null }) {
  return name ? (
    <Chip className="border-teal-200 bg-teal-50 text-teal-700">
      <MapPin size={11} /> {name}
    </Chip>
  ) : (
    <Chip className="border-gray-200 bg-gray-50 text-gray-500">No branch</Chip>
  );
}

/** A department or designation's active staff and production as one bar, with a legend that reads on its own. */
export function SplitBar({
  staff,
  production,
  legend = true,
  className,
}: {
  staff: number;
  production: number;
  legend?: boolean;
  className?: string;
}) {
  const pct = splitPercent(staff, production);
  const empty = staff + production === 0;
  return (
    <div
      className={cn("min-w-[8rem]", className)}
      data-testid="split-bar"
      data-staff={staff}
      data-production={production}
    >
      <div
        className="flex h-2 overflow-hidden rounded-full bg-gray-100"
        role="img"
        aria-label={`${staff} staff, ${production} production`}
      >
        {!empty && (
          <>
            <span className={STAFF_DOT} style={{ width: `${pct.staff}%` }} />
            <span className={PRODUCTION_DOT} style={{ width: `${pct.production}%` }} />
          </>
        )}
      </div>
      {legend && (
        <p className="mt-1 flex items-center gap-3 text-[11px] text-gray-500">
          <span className="inline-flex items-center gap-1">
            <span className={cn("h-1.5 w-1.5 rounded-full", STAFF_DOT)} /> {staff} staff
          </span>
          <span className="inline-flex items-center gap-1">
            <span className={cn("h-1.5 w-1.5 rounded-full", PRODUCTION_DOT)} /> {production} production
          </span>
        </p>
      )}
    </div>
  );
}

/** "12 employees" with the inactive ones, if any, in grey beside it. */
export function Headcount({ active, inactive, className }: { active: number; inactive: number; className?: string }) {
  return (
    <span className={cn("whitespace-nowrap", className)}>
      <b className="text-gray-900">{active}</b>
      {inactive > 0 && <span className="ml-1 text-[11px] text-gray-400">+{inactive} inactive</span>}
    </span>
  );
}

const AVATAR_TONES = [
  "bg-blue-100 text-blue-700",
  "bg-emerald-100 text-emerald-700",
  "bg-violet-100 text-violet-700",
  "bg-amber-100 text-amber-700",
  "bg-rose-100 text-rose-700",
  "bg-cyan-100 text-cyan-700",
];

/** Initials on a colour that is always the same for the same person. */
export function PersonAvatar({ name, seed, muted }: { name: string; seed: number; muted?: boolean }) {
  return (
    <div
      aria-hidden
      className={cn(
        "flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold",
        muted ? "bg-gray-100 text-gray-400" : AVATAR_TONES[seed % AVATAR_TONES.length],
      )}
    >
      {initials(name)}
    </div>
  );
}

/** The one empty state: "nothing yet" and "nothing matches" differ in words and in what the button does. */
export function EmptyState({
  filtered,
  icon: Icon = Building2,
  title,
  hint,
  action,
  onClear,
  testId,
}: {
  /** The list is empty because of the filters, not because nothing exists. */
  filtered: boolean;
  icon?: typeof Building2;
  title: string;
  hint: string;
  action?: ReactNode;
  onClear: () => void;
  testId: string;
}) {
  return (
    <Card className="rounded-2xl">
      <CardContent className="flex flex-col items-center gap-3 px-6 py-14 text-center" data-testid={testId}>
        <div className={cn("rounded-2xl p-4", filtered ? "bg-gray-100 text-gray-500" : "bg-blue-50 text-blue-600")}>
          {filtered ? <SearchX size={26} /> : <Icon size={26} />}
        </div>
        <div>
          <p className="font-bold text-gray-900">{filtered ? "Nothing matches" : title}</p>
          <p className="mt-0.5 max-w-sm text-sm text-muted-foreground">
            {filtered ? "Try fewer words, or clear the filters." : hint}
          </p>
        </div>
        {filtered ? (
          <Button variant="outline" onClick={onClear}>
            Clear filters
          </Button>
        ) : (
          action
        )}
      </CardContent>
    </Card>
  );
}

/** A failed load: say so, and let the person try again. */
export function LoadError({ what, onRetry }: { what: string; onRetry: () => void }) {
  return (
    <Card className="rounded-2xl border-red-200 bg-red-50">
      <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4" data-testid="load-error">
        <p className="text-sm text-red-800">
          <b>Could not load {what}.</b> Check the connection and try again.
        </p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      </CardContent>
    </Card>
  );
}

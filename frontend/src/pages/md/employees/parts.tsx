// Small pieces the Employees cards share: an avatar, a label pill, a person's name cell and a labelled value.

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { initials } from "./logic";

const AVATAR_TONES = [
  "bg-blue-100 text-blue-700",
  "bg-emerald-100 text-emerald-700",
  "bg-violet-100 text-violet-700",
  "bg-amber-100 text-amber-700",
  "bg-rose-100 text-rose-700",
  "bg-cyan-100 text-cyan-700",
  "bg-indigo-100 text-indigo-700",
  "bg-teal-100 text-teal-700",
];

/** The same person always gets the same colour. */
const toneOf = (key: string) =>
  AVATAR_TONES[[...key].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 997, 7) % AVATAR_TONES.length];

export function PersonAvatar({ name, size = "md" }: { name: string; size?: "sm" | "md" | "lg" }) {
  return (
    <div
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full font-bold",
        size === "lg" ? "h-14 w-14 text-lg" : size === "sm" ? "h-7 w-7 text-[10px]" : "h-9 w-9 text-xs",
        toneOf(name),
      )}
    >
      {initials(name)}
    </div>
  );
}

/** A small label pill. */
export function Chip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function StatusChip({ status }: { status: "active" | "inactive" }) {
  return status === "active" ? (
    <Chip className="border-emerald-200 bg-emerald-50 text-emerald-700">Active</Chip>
  ) : (
    <Chip className="border-gray-200 bg-gray-100 text-gray-600">Left</Chip>
  );
}

/** What a card says when its data could not be loaded (the reason is in the banner at the top of the page). */
export function Unavailable() {
  return (
    <p className="py-6 text-center text-sm text-muted-foreground" data-testid="md-employees-unavailable">
      This could not be loaded, so nothing is shown here. The reason is at the top of the page.
    </p>
  );
}

/** A name over its employee code, with an avatar: how a person appears in every list on this page. */
export function PersonCell({ name, code, sub }: { name: string; code?: string; sub?: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <PersonAvatar name={name} size="sm" />
      <div className="min-w-0">
        <p className="truncate text-[13px] font-semibold text-[#1a3a4a]">{name}</p>
        <p className="truncate text-[11px] text-[#006496]/55">{[code, sub].filter(Boolean).join(" · ")}</p>
      </div>
    </div>
  );
}

/** "LABEL" over a value: for the facts at the top of a profile. */
export function Fact({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <div className="min-w-0" data-testid={testId}>
      <p className="text-[10px] font-bold uppercase tracking-wider text-[#006496]/50">{label}</p>
      <p className="mt-0.5 truncate text-[13px] font-semibold text-[#1a3a4a]">{children}</p>
    </div>
  );
}

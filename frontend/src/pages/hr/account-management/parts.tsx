import type { ComponentType, ReactNode } from "react";
import { Briefcase, ClipboardList, Crown, ShieldCheck, UserCog } from "lucide-react";
import { CATEGORY_LABEL, type DisplayCategory } from "@/lib/hr-access";
import { cn } from "@/lib/utils";
import { initials } from "./logic";

type IconType = ComponentType<{ size?: number; className?: string }>;

/** One figure above the lists. Tinted like the stat cards on the other HR pages. */
export function StatCard({
  label,
  value,
  sub,
  icon: Icon,
  tone,
  testId,
}: {
  label: string;
  value: number | string;
  sub?: string;
  icon: IconType;
  tone: string;
  testId?: string;
}) {
  return (
    <div className={cn("flex items-start gap-3 rounded-2xl p-4", tone)} data-testid={testId}>
      <div className="mt-0.5 rounded-xl bg-white/60 p-2">
        <Icon size={16} />
      </div>
      <div className="min-w-0">
        <p className="text-xs font-medium opacity-70">{label}</p>
        <p className="text-2xl font-black leading-tight" data-testid={testId ? `${testId}-value` : undefined}>
          {value}
        </p>
        {sub && <p className="mt-0.5 text-xs leading-snug opacity-60">{sub}</p>}
      </div>
    </div>
  );
}

/** A small label pill. Not a Badge: those lift on hover, and these are not clickable. */
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

/** The Managing Director's chip: gold, the identity colour of the MD portal. */
export function MdChip({ label = "MD" }: { label?: string }) {
  return (
    <span data-testid="md-chip" className="inline-flex">
      <Chip className="border-[#e0a83a]/60 bg-[#fff1cc] text-[#7a5410]">
        <Crown size={11} /> {label}
      </Chip>
    </span>
  );
}

const CATEGORY_TONE: Record<DisplayCategory, string> = {
  super_admin: "border-indigo-200 bg-indigo-50 text-indigo-700",
  md: "border-[#e0a83a]/50 bg-[#fffaf0] text-[#7a5410]",
  admin: "border-slate-200 bg-slate-50 text-slate-700",
  hr_manager: "border-teal-200 bg-teal-50 text-teal-800",
  hr_assistant: "border-violet-200 bg-violet-50 text-violet-800",
};

const CATEGORY_ICON: Record<DisplayCategory, IconType> = {
  super_admin: ShieldCheck,
  md: Crown,
  admin: UserCog,
  hr_manager: Briefcase,
  hr_assistant: ClipboardList,
};

/** The account's category (Super Admin / Managing Director / Admin / HR Manager / HR Assistant). */
export function CategoryChip({ category, className }: { category: DisplayCategory; className?: string }) {
  const Icon = CATEGORY_ICON[category];
  return (
    <span data-testid={`category-chip-${category}`} className="inline-flex">
      <Chip className={cn(CATEGORY_TONE[category], className)}>
        <Icon size={11} /> {CATEGORY_LABEL[category]}
      </Chip>
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
  "bg-indigo-100 text-indigo-700",
  "bg-teal-100 text-teal-700",
];

/** The same account always gets the same colour. */
const toneOf = (username: string) =>
  AVATAR_TONES[[...username].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 997, 7) % AVATAR_TONES.length];

export function AccountAvatar({
  username,
  fullName,
  disabled,
  md,
  size = "md",
}: {
  username: string;
  fullName?: string | null;
  disabled?: boolean;
  /** The Managing Director's avatar is gold. */
  md?: boolean;
  size?: "md" | "lg";
}) {
  return (
    <div
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full font-bold",
        size === "lg" ? "h-11 w-11 text-sm" : "h-9 w-9 text-xs",
        disabled
          ? "bg-gray-100 text-gray-400"
          : md
            ? "bg-[#fff1cc] text-[#7a5410] ring-2 ring-[#e0a83a]/50"
            : toneOf(username),
      )}
    >
      {initials({ username, fullName })}
    </div>
  );
}

export function StatusDot({ active }: { active: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-xs font-semibold",
        active ? "text-emerald-700" : "text-gray-500",
      )}
    >
      <span className={cn("h-2 w-2 rounded-full", active ? "bg-emerald-500" : "bg-gray-300")} />
      {active ? "Active" : "Disabled"}
    </span>
  );
}

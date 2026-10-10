import type { ComponentType } from "react";
import {
  ArrowUpRight,
  BarChart3,
  ClipboardList,
  Coins,
  FileText,
  Lock,
  Settings,
  Shield,
  Sparkles,
  UserCog,
  UserPlus,
  Wallet,
} from "lucide-react";
import { Link } from "wouter";
import SectionCard from "@/components/md/kit/SectionCard";
import { toast } from "@/hooks/use-toast";
import { openAssistant } from "@/lib/md/assistant-store";
import { cn } from "@/lib/utils";

type Icon = ComponentType<{ size?: number; className?: string }>;

/** The things the MD does most from here, each on a page the MD can open. */
export const QUICK_ACTIONS: { id: string; label: string; hint: string; to: string; icon: Icon }[] = [
  { id: "add-employee", label: "Add employee", hint: "A new joiner", to: "/md/employees/new", icon: UserPlus },
  {
    id: "requests",
    label: "View requests",
    hint: "Leave, permission, outpass",
    to: "/md/requests",
    icon: ClipboardList,
  },
  { id: "reports", label: "Reports", hint: "Executive and full library", to: "/md/reports", icon: BarChart3 },
  { id: "payroll", label: "Payroll analysis", hint: "Cost and what changed", to: "/md/payroll", icon: Coins },
];

/** What only the Admin can open or run. They are shown (so the MD knows they exist) and say so when pressed. */
export const ADMIN_TOOLS: { id: string; label: string; hint: string; icon: Icon }[] = [
  { id: "run-payroll", label: "Run payroll", hint: "Generate and finalise salaries", icon: Wallet },
  { id: "salary-slips", label: "Salary slips", hint: "Slips and bulk sending", icon: FileText },
  { id: "user-management", label: "User Management", hint: "Department heads and approvals", icon: Shield },
  { id: "account-management", label: "Account Management", hint: "Accounts, roles, access", icon: UserCog },
  { id: "settings", label: "Settings", hint: "Company, attendance, devices", icon: Settings },
];

/** Quick actions take the three tile colours in turn. */
const TILE_COLOURS = ["wine", "ink", "sand", "wine"] as const;

/** The notice a locked tile shows: the same one a link inside a copied page shows (lib/md/embed.ts). */
export function notifyAdminOnly(name: string) {
  toast({ title: "Available only to the Admin", description: `${name} can only be opened by the Admin.` });
}

/** "Quick actions" (pages the MD can open) and "Admin only" (shown, locked, with a notice when pressed). */
export default function Tools() {
  return (
    <SectionCard
      title="Quick actions"
      subtitle="The things you open most"
      className="md-dashboard-card"
      testId="md-home-tools"
    >
      <div className="grid grid-cols-2 gap-3" data-testid="md-home-quick">
        {QUICK_ACTIONS.map((a, i) => (
          <Link key={a.id} href={a.to} data-testid={`md-quick-${a.id}`} className="md-dashboard-tile group">
            <span className="mb-2 flex items-center justify-between">
              <span
                className={cn("md-dashboard-icon md-dashboard-icon-sm", `md-dashboard-icon-${TILE_COLOURS[i % 4]}`)}
              >
                <a.icon size={15} aria-hidden />
              </span>
              <ArrowUpRight
                size={14}
                aria-hidden
                className="text-md-ink-500 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-md-wine"
              />
            </span>
            <span className="text-[13px] font-bold leading-tight text-md-ink">{a.label}</span>
            <span className="text-[11.5px] leading-snug text-md-ink-soft">{a.hint}</span>
          </Link>
        ))}
        <button
          type="button"
          onClick={() => openAssistant("What should I focus on today?")}
          data-testid="md-quick-ask"
          className="md-btn md-btn-ink md-btn-lg col-span-2 w-full justify-center"
        >
          <Sparkles size={15} aria-hidden /> Ask the AI what to focus on today
        </button>
      </div>

      <div className="mt-5 border-t border-md-line pt-4" data-testid="md-home-admin-tools">
        <p className="mb-3 flex items-center gap-1.5 text-[11px] font-extrabold uppercase tracking-[0.16em] text-md-ink-soft">
          <Lock size={11} aria-hidden /> Admin only
        </p>
        <div className="grid grid-cols-1 gap-2">
          {ADMIN_TOOLS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => notifyAdminOnly(t.label)}
              data-testid={`md-admin-${t.id}`}
              aria-label={`${t.label} (available only to the Admin)`}
              className="md-dashboard-locked"
            >
              <t.icon size={15} aria-hidden className="shrink-0 text-md-ink-soft" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] font-bold text-md-ink">{t.label}</span>
                <span className="block truncate text-[11px] text-md-ink-soft">{t.hint}</span>
              </span>
              <span className="md-dashboard-lockdot">
                <Lock size={12} aria-hidden />
              </span>
            </button>
          ))}
        </div>
      </div>
    </SectionCard>
  );
}

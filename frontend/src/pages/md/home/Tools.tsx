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

/** The notice a locked tile shows: the same one a link inside a copied page shows (lib/md/embed.ts). */
export function notifyAdminOnly(name: string) {
  toast({ title: "Available only to the Admin", description: `${name} can only be opened by the Admin.` });
}

/** "Quick actions" (pages the MD can open) and "Admin only" (shown, locked, with a notice when pressed). */
export default function Tools() {
  return (
    <SectionCard title="Quick actions" subtitle="The things you open most" testId="md-home-tools">
      <div className="grid grid-cols-2 gap-2.5" data-testid="md-home-quick">
        {QUICK_ACTIONS.map((a) => (
          <Link
            key={a.id}
            href={a.to}
            data-testid={`md-quick-${a.id}`}
            className="group flex flex-col gap-1 rounded-2xl bg-white/80 p-3 ring-1 ring-[#006496]/10 transition hover:-translate-y-0.5 hover:ring-[#006496]/30"
          >
            <span className="flex items-center justify-between">
              <span className="rounded-lg bg-[#006496]/[0.08] p-1.5 text-[#006496]">
                <a.icon size={15} />
              </span>
              <ArrowUpRight size={13} className="text-[#006496]/40 transition-transform group-hover:translate-x-0.5" />
            </span>
            <span className="text-[13px] font-bold text-[#1a3a4a]">{a.label}</span>
            <span className="text-[11px] text-muted-foreground">{a.hint}</span>
          </Link>
        ))}
        <button
          type="button"
          onClick={() => openAssistant("What should I focus on today?")}
          data-testid="md-quick-ask"
          className="col-span-2 flex items-center gap-2 rounded-2xl p-3 text-left text-[13px] font-bold text-[#5b3d00] transition hover:brightness-105"
          style={{ background: "linear-gradient(135deg, #f6d27a 0%, #e0a83a 100%)" }}
        >
          <Sparkles size={15} /> Ask the AI what to focus on today
        </button>
      </div>

      <div className="mt-4" data-testid="md-home-admin-tools">
        <p className="mb-2 flex items-center gap-1.5 text-[10px] font-extrabold uppercase tracking-[0.2em] text-[#006496]/50">
          <Lock size={11} /> Admin only
        </p>
        <div className="grid grid-cols-1 gap-1.5">
          {ADMIN_TOOLS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => notifyAdminOnly(t.label)}
              data-testid={`md-admin-${t.id}`}
              aria-label={`${t.label} (available only to the Admin)`}
              className="flex items-center gap-2.5 rounded-xl border border-dashed border-[#006496]/20 bg-white/50 px-3 py-2 text-left opacity-80 transition hover:opacity-100"
            >
              <t.icon size={14} className="shrink-0 text-[#006496]/60" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] font-semibold text-[#1a3a4a]">{t.label}</span>
                <span className="block truncate text-[10.5px] text-muted-foreground">{t.hint}</span>
              </span>
              <Lock size={12} className="shrink-0 text-[#006496]/40" />
            </button>
          ))}
        </div>
      </div>
    </SectionCard>
  );
}

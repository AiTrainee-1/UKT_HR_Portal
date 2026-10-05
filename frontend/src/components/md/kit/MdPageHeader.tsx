import type { ComponentType, ReactNode } from "react";
import { clockText } from "@/lib/md/format";

/**
 * The title row every MD page starts with: an icon tile, the title and what the page answers, and (on the right)
 * actions. `updatedAt` is the server's "numbers made at" stamp ("2026-10-05T10:42:10").
 */
export default function MdPageHeader({
  icon: Icon,
  title,
  subtitle,
  actions,
  updatedAt,
}: {
  icon: ComponentType<{ size?: number }>;
  title: string;
  subtitle: ReactNode;
  actions?: ReactNode;
  updatedAt?: string | null;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3" data-testid="md-page-header">
      <div className="flex min-w-0 items-center gap-3">
        <div className="rounded-2xl bg-gradient-to-br from-[#006496] to-[#0096c7] p-2.5 text-white shadow-sm">
          <Icon size={22} />
        </div>
        <div className="min-w-0">
          <h2 className="text-2xl font-black text-gray-900" data-testid="md-page-title">
            {title}
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">{subtitle}</p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        {updatedAt && (
          <span className="hidden text-[11px] text-[#006496]/55 sm:inline" data-testid="md-updated">
            Numbers as of {clockText(updatedAt)}
          </span>
        )}
        {actions}
      </div>
    </div>
  );
}

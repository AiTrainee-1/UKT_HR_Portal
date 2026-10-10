import type { ComponentType, ReactNode } from "react";
import { clockText } from "@/lib/md/format";
import { LiveChip, UpdatedRefresh } from "./MdHeaderParts";

/**
 * The title row every MD page starts with, the same on all of them (see MdHeaderParts): the title with its Live chip and,
 * under it, what the page answers or the date; the page's own buttons (`actions`) and, at the far right, when the data
 * arrived and a Refresh button. A page that switches between views puts the switch in `tabs`, beside the title.
 * `updatedAt` is the server's "numbers made at" stamp ("2026-10-05T10:42:10"); it replaces the client's "Updated" time.
 *
 * `icon` is accepted for the older call sites and is no longer drawn: the title row carries no icon tile.
 */
export default function MdPageHeader({
  title,
  subtitle,
  actions,
  tabs,
  updatedAt,
  live = true,
}: {
  icon?: ComponentType<{ size?: number }>;
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  tabs?: ReactNode;
  updatedAt?: string | null;
  live?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3" data-testid="md-page-header">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2.5">
          <h2 className="text-[22px] font-black leading-7 tracking-tight text-md-ink" data-testid="md-page-title">
            {title}
          </h2>
          {live && <LiveChip />}
        </div>
        {subtitle && (
          <p className="mt-0.5 max-w-[34rem] text-xs font-medium leading-snug text-md-ink-soft">{subtitle}</p>
        )}
      </div>
      {tabs}
      <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>
      <UpdatedRefresh stamp={updatedAt ? `Numbers as of ${clockText(updatedAt)}` : undefined} />
    </div>
  );
}

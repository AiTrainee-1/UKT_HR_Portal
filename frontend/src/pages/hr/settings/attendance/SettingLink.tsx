import type { ReactNode } from "react";
import { Link } from "wouter";
import { ArrowUpRight } from "lucide-react";
import { focusSetting, settingsAddress } from "../kit/jump";

/**
 * A link to one setting on another Settings tab (`/hr/settings?tab=attendance#morning-late-in`). The page only reads
 * the setting part of an address when it first opens, so the click also scrolls to the setting once its tab has drawn.
 */
export function SettingLink({
  tab,
  setting,
  children,
  testId,
}: {
  tab: string;
  setting?: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <Link
      href={settingsAddress(tab, setting)}
      onClick={() => {
        if (setting) focusSetting(setting);
      }}
      className="inline-flex items-center gap-0.5 font-semibold text-blue-700 hover:underline"
      data-testid={testId}
    >
      {children}
      <ArrowUpRight size={11} />
    </Link>
  );
}

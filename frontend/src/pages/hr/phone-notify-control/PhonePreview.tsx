import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { UktLogoMark } from "@/components/ui/UktLogoMark";
import { cn } from "@/lib/utils";
import { phoneCanExpand } from "./logic";

/**
 * A phone notification as it shows on a lock screen: the app's mark and name, "now", the title in bold and the message
 * under it, collapsed to about two lines with a chevron to open it all (the way Android draws one). Fixed phone colours, a
 * light card on a light wallpaper and a dark card on a dark one, so it reads like a phone in either theme of the portal.
 * `dim` greys a part that is only a stand-in (nothing typed in it yet). The chevron only opens the card, so View only never locks it.
 */
export function PhoneNotificationCard({
  title,
  body,
  dim,
  testId,
  className,
}: {
  title: string;
  body: string;
  dim?: { title?: boolean; body?: boolean };
  testId?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const canExpand = phoneCanExpand(title, body);
  const expanded = open && canExpand;
  return (
    <div
      data-testid={testId}
      data-expanded={expanded ? "true" : "false"}
      className={cn(
        "rounded-[1.75rem] bg-gradient-to-br from-sky-200 via-indigo-200 to-violet-300 p-3 sm:p-4",
        "dark:from-slate-800 dark:via-indigo-950 dark:to-slate-950",
        className,
      )}
    >
      <p aria-hidden className="mb-2 text-center text-3xl font-light tabular-nums text-slate-800 dark:text-slate-100">
        9:41
      </p>
      <div
        role="group"
        aria-label="How the notification shows on a phone"
        className="rounded-2xl bg-white p-3 text-slate-900 shadow-lg dark:bg-slate-800 dark:text-slate-100"
      >
        <div className="flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400">
          <UktLogoMark className="h-3.5 shrink-0" />
          <span className="font-medium">UKTextiles</span>
          <span aria-hidden>·</span>
          <span>now</span>
          {canExpand && (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={expanded}
              aria-label={expanded ? "Show less of the notification" : "Show the whole notification"}
              title={expanded ? "Show less" : "Show the whole notification"}
              className="ml-auto flex h-5 w-5 items-center justify-center rounded-full bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600"
              data-view-safe
              data-testid={testId ? `${testId}-expand` : undefined}
            >
              {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            </button>
          )}
        </div>
        <p
          className={cn(
            "mt-1 break-words text-sm font-semibold leading-snug",
            !expanded && "truncate",
            dim?.title && "text-slate-400 dark:text-slate-500",
          )}
          data-testid={testId ? `${testId}-title` : undefined}
        >
          {title}
        </p>
        <p
          className={cn(
            "mt-0.5 whitespace-pre-line break-words text-[13px] leading-snug text-slate-700 dark:text-slate-300",
            !expanded && "line-clamp-2",
            dim?.body && "text-slate-400 dark:text-slate-500",
          )}
          data-testid={testId ? `${testId}-body` : undefined}
        >
          {body}
        </p>
      </div>
    </div>
  );
}

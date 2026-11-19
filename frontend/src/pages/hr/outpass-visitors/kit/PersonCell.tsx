import { useState } from "react";
import { initials } from "@/components/payroll/kit/format";
import { cn } from "@/lib/utils";

/**
 * A person in a table cell or a drawer: the photo (a signed link from the API, never an embedded picture) or the initials
 * when there is none or it does not load, the name, and under it the employee code and one more fact (the department).
 * Everything stays on its line and is cut with an ellipsis; the full text is in the tooltip.
 */
export function PersonCell({
  name,
  code,
  sub,
  photoUrl,
  size = 32,
  testId,
  className,
}: {
  name: string | null | undefined;
  /** The employee code (or a phone for a visitor), shown in a monospace face. */
  code?: string | null;
  /** One more fact after the code: "Cutting", "ABC Traders". */
  sub?: string | null;
  photoUrl?: string | null;
  size?: number;
  testId?: string;
  className?: string;
}) {
  const [broken, setBroken] = useState<string | null>(null);
  const showPhoto = !!photoUrl && broken !== photoUrl;
  const label = name?.trim() || "Unknown";
  const second = [code, sub].filter(Boolean).join(" · ");
  return (
    <div className={cn("flex min-w-0 items-center gap-2.5", className)} data-testid={testId}>
      {showPhoto ? (
        <img
          src={photoUrl!}
          alt=""
          loading="lazy"
          onError={() => setBroken(photoUrl!)}
          className="shrink-0 rounded-full border border-slate-200 bg-slate-100 object-cover"
          style={{ width: size, height: size }}
        />
      ) : (
        <span
          className="inline-flex shrink-0 items-center justify-center rounded-full bg-slate-100 text-[11px] font-semibold text-slate-600"
          style={{ width: size, height: size }}
          aria-hidden="true"
        >
          {initials(label)}
        </span>
      )}
      <div className="min-w-0 leading-tight">
        <p className="truncate font-medium text-slate-900" title={label}>
          {label}
        </p>
        {second && (
          <p className="truncate text-[11px] text-slate-500" title={second}>
            {code && <span className="font-mono">{code}</span>}
            {code && sub ? " · " : ""}
            {sub}
          </p>
        )}
      </div>
    </div>
  );
}

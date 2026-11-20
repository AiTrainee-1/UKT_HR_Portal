import { Switch } from "@/components/ui/switch";
import type { SlipOptions } from "@/lib/api-client/custom-hooks/salary-slip-center";
import { cn } from "@/lib/utils";
import { OPTION_INFO } from "./logic";

/** The three deductions a slip may take (all on by default); Generate and the live preview both follow them. */
export function OptionSwitches({
  options,
  onChange,
  disabled,
  idPrefix,
  className,
}: {
  options: SlipOptions;
  onChange: (options: SlipOptions) => void;
  disabled?: boolean;
  /** Keeps the switch ids unique when the page and the preview both show them. */
  idPrefix: string;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap gap-x-5 gap-y-2", className)}>
      {OPTION_INFO.map((o) => {
        const id = `${idPrefix}-${o.key}`;
        return (
          <div key={o.key} className="flex items-center gap-2" title={o.hint}>
            <Switch
              id={id}
              checked={options[o.key]}
              onCheckedChange={(checked) => onChange({ ...options, [o.key]: checked })}
              disabled={disabled}
              data-testid={id}
            />
            <label htmlFor={id} className="cursor-pointer select-none text-sm text-gray-700">
              {o.label}
            </label>
          </div>
        );
      })}
    </div>
  );
}

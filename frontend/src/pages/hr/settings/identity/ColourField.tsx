import { Input } from "@/components/ui/input";
import { isHexColour, toPickerHex } from "./colours";

/**
 * A colour setting: the browser's picker and the hex code beside it, kept in step. The code is checked as it is typed
 * (#RGB or #RRGGBB), because the PDF builders and the ID card quietly ignore anything else and use a default colour.
 * Put the SettingBlock title's `labelFor` on `id`.
 */
export function ColourField({
  id,
  value,
  onChange,
  noun,
  disabled,
  fallback = "#000000",
}: {
  id: string;
  value: string;
  onChange: (next: string) => void;
  /** Names the picker for assistive technology ("Theme colour"). */
  noun: string;
  disabled?: boolean;
  /** What the picker shows while the typed code is not a colour yet. */
  fallback?: string;
}) {
  const valid = isHexColour(value);
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <input
          type="color"
          aria-label={`Pick ${noun}`}
          value={toPickerHex(value, fallback)}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className="h-9 w-12 shrink-0 cursor-pointer rounded border disabled:cursor-not-allowed disabled:opacity-60"
        />
        <Input
          id={id}
          value={value}
          disabled={disabled}
          spellCheck={false}
          maxLength={7}
          aria-invalid={valid ? undefined : true}
          aria-describedby={valid ? undefined : `${id}-error`}
          onChange={(e) => onChange(e.target.value)}
          className="font-mono"
        />
      </div>
      {!valid && (
        <p id={`${id}-error`} role="alert" className="text-xs font-medium text-red-600">
          Type a colour code such as #0E4B3A (a # and 6 letters or digits).
        </p>
      )}
    </div>
  );
}

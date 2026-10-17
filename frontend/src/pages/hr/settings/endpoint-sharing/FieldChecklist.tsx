import type { SharedCatalogField, SharedDataset } from "@/lib/api-client/custom-hooks";
import { Button } from "@/components/ui/button";
import { SENSITIVITY_ORDER, SENSITIVITY_TEXT } from "./form";
import { Notice } from "./ui";

/** What can never be shared, in case the server's list did not arrive. */
export const DEFAULT_EXCLUDED = [
  "Passwords and password hashes, login tokens, one-time codes and device secrets.",
  "Aadhaar, PAN, bank account numbers, and UAN, PF and ESI numbers.",
  "Photos and any biometric or punching-device user id.",
  "Anything about HR logins and roles.",
  "Any column that is not in the list below: a field that is not offered cannot be asked for.",
];

/**
 * The fields of a dataset as a checklist, grouped by how sensitive they are. Only ticked fields are ever sent; the box under
 * the list says what can never be ticked at all.
 */
export function FieldChecklist({
  dataset,
  ticked,
  onChange,
  readOnly,
  excluded,
  newSensitive,
}: {
  dataset: SharedDataset;
  ticked: string[];
  onChange: (next: string[]) => void;
  readOnly: boolean;
  excluded: string[];
  newSensitive: SharedCatalogField[];
}) {
  const on = new Set(ticked);
  const set = (keys: string[], value: boolean) => {
    const next = new Set(ticked);
    for (const k of keys) {
      if (value) next.add(k);
      else next.delete(k);
    }
    onChange(dataset.fields.filter((f) => next.has(f.key)).map((f) => f.key));
  };

  return (
    <div className="space-y-4" data-testid="field-checklist">
      <p className="text-xs font-semibold text-slate-600" data-testid="field-count" aria-live="polite">
        {ticked.length} of {dataset.fields.length} fields ticked
        {ticked.length === 0 && " - nothing is shared yet"}
      </p>

      {SENSITIVITY_ORDER.map((level) => {
        const fields = dataset.fields.filter((f) => f.sensitivity === level);
        if (fields.length === 0) return null;
        const keys = fields.map((f) => f.key);
        const allOn = keys.every((k) => on.has(k));
        return (
          <fieldset
            key={level}
            className="space-y-2 rounded-lg border border-slate-200 p-3"
            data-testid={`field-group-${level}`}
          >
            <legend className="px-1 text-[13px] font-semibold text-slate-800">{SENSITIVITY_TEXT[level].title}</legend>
            <p className="text-xs leading-snug text-slate-500">{SENSITIVITY_TEXT[level].help}</p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={readOnly || allOn}
                onClick={() => set(keys, true)}
                aria-label={`Tick all ${level} fields`}
              >
                Tick all
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={readOnly || !keys.some((k) => on.has(k))}
                onClick={() => set(keys, false)}
                aria-label={`Clear all ${level} fields`}
              >
                Clear
              </Button>
            </div>
            <ul className="grid gap-1.5 sm:grid-cols-2">
              {fields.map((f) => (
                <li key={f.key}>
                  <label
                    className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 hover:bg-slate-50"
                    htmlFor={`es-field-${f.key}`}
                  >
                    <input
                      id={`es-field-${f.key}`}
                      type="checkbox"
                      className="mt-0.5 h-4 w-4 shrink-0 accent-indigo-600"
                      checked={on.has(f.key)}
                      disabled={readOnly}
                      data-testid={`field-${f.key}`}
                      onChange={(e) => set([f.key], e.target.checked)}
                    />
                    <span className="min-w-0">
                      <span className="block text-[13px] font-medium text-slate-900">
                        {f.label} <span className="font-mono text-[11px] font-normal text-slate-500">{f.key}</span>
                      </span>
                      <span className="block text-xs leading-snug text-slate-500">
                        {f.description} <span className="text-slate-400">({f.type})</span>
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
        );
      })}

      {newSensitive.length > 0 && (
        <Notice tone="warn" title="You are about to share personal or financial data" testId="new-sensitive-notice">
          Newly ticked: {newSensitive.map((f) => f.label).join(", ")}. You will be asked to confirm when you save.
        </Notice>
      )}

      <div className="rounded-lg border border-slate-200 bg-slate-50 p-3" data-testid="hard-excluded">
        <p className="text-[13px] font-semibold text-slate-800">Never shared, from any dataset</p>
        <p className="mt-0.5 text-xs leading-snug text-slate-500">
          These can not be ticked, now or later. They are held back by the system itself, not by this screen.
        </p>
        <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs leading-snug text-slate-700">
          {(excluded.length > 0 ? excluded : DEFAULT_EXCLUDED).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

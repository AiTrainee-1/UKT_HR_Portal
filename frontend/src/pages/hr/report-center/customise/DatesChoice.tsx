import type { CustomDataset } from "@/lib/api-client/custom-hooks/report-customise";
import { defaultValues, type FilterValues } from "@/lib/report-center";
import { TOKEN_LABEL, describeDates, relativeToken, type DatesMode } from "./builder-logic";

/**
 * Which period a saved report covers when it is opened: its data source's default (this month, worked out on the day),
 * a period counted from the day it is opened (the quick range picked above: "Last month", "Last 7 days" ...), or exactly
 * the dates on screen. The filters themselves can still be changed each time the report is opened.
 */
export function DatesChoice({
  dataset,
  values,
  value,
  onChange,
  today,
}: {
  dataset: CustomDataset;
  values: FilterValues;
  value: DatesMode;
  onChange: (next: DatesMode) => void;
  today: Date;
}) {
  const token = relativeToken(dataset, values, today);
  const onScreen = describeDates(dataset, values);
  const byDefault = describeDates(dataset, defaultValues(dataset.filters));
  const options: { id: DatesMode; label: string; hint?: string; disabled?: boolean }[] = [
    {
      id: "default",
      label: "Its default period, worked out on the day it is opened",
      hint: byDefault ? `Today that is ${byDefault}. Suits a monthly report.` : undefined,
    },
    {
      id: "relative",
      label: token
        ? `${TOKEN_LABEL[token]}, counted from the day it is opened`
        : "A period counted from the day it is opened",
      hint: token ? undefined : "Pick a quick range above, such as Last month, to use this.",
      disabled: !token && value !== "relative",
    },
    {
      id: "fixed",
      label: onScreen ? `Exactly ${onScreen}` : "Exactly the dates above",
      hint: "The same dates every time it is opened.",
    },
  ];

  return (
    <fieldset className="rounded-lg border bg-slate-50/60 px-3 pb-2.5 pt-1" data-testid="dates-choice">
      <legend className="px-1 text-xs font-semibold text-gray-600">When the saved report is opened, it covers</legend>
      <div className="space-y-1.5">
        {options.map((o) => (
          <label
            key={o.id}
            className={`flex items-start gap-2 text-sm ${o.disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}
          >
            <input
              type="radio"
              name="custom-report-dates"
              value={o.id}
              checked={value === o.id}
              disabled={o.disabled}
              onChange={() => onChange(o.id)}
              className="mt-1 accent-sky-700"
              data-testid={`dates-${o.id}`}
            />
            <span className="min-w-0">
              <span className="text-gray-800">{o.label}</span>
              {o.hint && <span className="block text-[11px] leading-snug text-muted-foreground">{o.hint}</span>}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

import type { SharedCatalogFilter, SharedDataset } from "@/lib/api-client/custom-hooks";
import { Input } from "@/components/ui/input";
import { SELECT_CLASS, Pill, Problem } from "./ui";

/** The value a filter starts with when it is first locked. */
export function startingValue(filter: SharedCatalogFilter): string {
  // locking a yes / no filter to "no" would change nothing, so a new lock starts at "yes" (true)
  if (filter.type === "boolean") return "true";
  if (filter.default !== null) return filter.default;
  return filter.values[0] ?? "";
}

/** A yes / no filter is sent as the words true / false (the contract of the API) but shown as Yes / No. */
const BOOLEAN_CHOICES: { value: string; label: string }[] = [
  { value: "true", label: "Yes" },
  { value: "false", label: "No" },
];

/** The box a filter's value is typed in: a list when the filter takes a few words, a date box for a date. */
export function FilterValueBox({
  filter,
  value,
  onChange,
  disabled,
  id,
}: {
  filter: SharedCatalogFilter;
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  id: string;
}) {
  if (filter.type === "boolean") {
    return (
      <select
        id={id}
        className={SELECT_CLASS}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {!BOOLEAN_CHOICES.some((c) => c.value === value) && (
          <option value={value}>{value === "" ? "Choose" : value}</option>
        )}
        {BOOLEAN_CHOICES.map((c) => (
          <option key={c.value} value={c.value}>
            {c.label}
          </option>
        ))}
      </select>
    );
  }
  const options = filter.type === "enum" && filter.values.length > 0 ? filter.values : null;
  if (options) {
    return (
      <select
        id={id}
        className={SELECT_CLASS}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {!options.includes(value) && <option value={value}>{value === "" ? "Choose" : value}</option>}
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  }
  return (
    <Input
      id={id}
      type={filter.type === "date" ? "date" : filter.type === "month" ? "month" : "text"}
      inputMode={filter.type === "integer" || filter.type === "year" ? "numeric" : undefined}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/**
 * Locked filters: a filter that is locked has a fixed value the caller can never change, so the endpoint only ever shows
 * that slice of the data (for example only active employees). A filter that is not locked can be sent by the caller.
 */
export function LockedFilters({
  dataset,
  locked,
  onChange,
  readOnly,
  errors,
}: {
  dataset: SharedDataset;
  locked: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  readOnly: boolean;
  errors: Record<string, string>;
}) {
  if (dataset.filters.length === 0) {
    return <p className="text-sm text-slate-500">This dataset has no filters, so there is nothing to lock.</p>;
  }
  return (
    <ul className="space-y-3" data-testid="locked-filters">
      {dataset.filters.map((filter) => {
        const isLocked = filter.key in locked;
        const error = errors[`filter:${filter.key}`];
        return (
          <li
            key={filter.key}
            className="space-y-2 rounded-lg border border-slate-200 p-3"
            data-testid={`filter-${filter.key}`}
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <label className="flex cursor-pointer items-start gap-2" htmlFor={`es-lock-${filter.key}`}>
                <input
                  id={`es-lock-${filter.key}`}
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 accent-indigo-600"
                  checked={isLocked}
                  disabled={readOnly}
                  onChange={(e) => {
                    const next = { ...locked };
                    if (e.target.checked) next[filter.key] = startingValue(filter);
                    else delete next[filter.key];
                    onChange(next);
                  }}
                />
                <span className="min-w-0">
                  <span className="block text-[13px] font-semibold text-slate-900">
                    Lock {filter.label}{" "}
                    <span className="font-mono text-[11px] font-normal text-slate-500">{filter.key}</span>
                  </span>
                  <span className="block text-xs leading-snug text-slate-500">{filter.description}</span>
                </span>
              </label>
              {filter.required && !isLocked && <Pill tone="warn">The caller must send it</Pill>}
              {isLocked && <Pill tone="good">Locked: the caller cannot change it</Pill>}
            </div>
            {isLocked && (
              <div className="max-w-sm space-y-1">
                <label htmlFor={`es-lockvalue-${filter.key}`} className="text-xs font-semibold text-gray-700">
                  Always use this value for {filter.label}
                </label>
                <FilterValueBox
                  id={`es-lockvalue-${filter.key}`}
                  filter={filter}
                  value={locked[filter.key]}
                  disabled={readOnly}
                  onChange={(v) => onChange({ ...locked, [filter.key]: v })}
                />
                {error && <Problem testId={`filter-error-${filter.key}`}>{error}</Problem>}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

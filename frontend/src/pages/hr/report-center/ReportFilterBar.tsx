import type { ReactNode } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type {
  DateRangeValue,
  FilterValue,
  FilterValues,
  NamedOption,
  ReportCatalog,
  ReportFilter,
} from "@/lib/report-center";
import { DateRangeFilter } from "./filters/DateRangeFilter";
import { EmployeeMultiPicker } from "./filters/EmployeeMultiPicker";
import { MultiSelectFilter, SelectionChips } from "./filters/MultiSelectFilter";
import { PeriodPicker } from "./filters/PeriodPicker";

/** Radix Select forbids an empty item value, so "no filter" travels as this sentinel. */
const ANY = "__any__";

const asList = (v: FilterValue): string[] => (Array.isArray(v) ? v.map(String) : v ? String(v).split(",") : []);
const toOptions = (list: NamedOption[]) => list.map((o) => ({ value: String(o.id), label: o.name }));

function Field({ filter, className, children }: { filter: ReportFilter; className?: string; children: ReactNode }) {
  return (
    <div className={className}>
      <label className="mb-1 block text-xs font-semibold text-gray-600">
        {filter.label}
        {filter.required && <span className="ml-0.5 text-red-500">*</span>}
      </label>
      {children}
      {filter.help && <p className="mt-1 text-[11px] text-muted-foreground">{filter.help}</p>}
    </div>
  );
}

function SingleSelect({
  filter,
  value,
  onChange,
  includeAny,
}: {
  filter: ReportFilter;
  value: string;
  onChange: (v: string) => void;
  includeAny: boolean;
}) {
  return (
    <Select value={value || ANY} onValueChange={(v) => onChange(v === ANY ? "" : v)}>
      <SelectTrigger className="h-9" aria-label={filter.label}>
        <SelectValue placeholder={filter.placeholder ?? "All"} />
      </SelectTrigger>
      <SelectContent>
        {includeAny && <SelectItem value={ANY}>{filter.placeholder ?? "All"}</SelectItem>}
        {(filter.options ?? []).map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Renders one input per backend filter, from the report's declared filters - no per-report UI code. */
export function ReportFilterBar({
  filters,
  values,
  onChange,
  options,
}: {
  filters: ReportFilter[];
  values: FilterValues;
  onChange: (key: string, value: FilterValue) => void;
  options: ReportCatalog["options"];
}) {
  const departmentIds = asList(values.department);

  return (
    <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
      {filters.map((f) => {
        const v = values[f.key];
        switch (f.kind) {
          case "period":
            return (
              <Field key={f.key} filter={f} className="lg:col-span-2">
                <PeriodPicker value={String(v ?? "")} onChange={(x) => onChange(f.key, x)} />
              </Field>
            );
          case "year":
            return (
              <Field key={f.key} filter={f}>
                <Input
                  type="number"
                  aria-label={f.label}
                  value={String(v ?? "")}
                  min={2000}
                  max={2100}
                  onChange={(e) => onChange(f.key, e.target.value)}
                  className="h-9"
                />
              </Field>
            );
          case "dateRange":
            return (
              <Field key={f.key} filter={f} className="sm:col-span-2 lg:col-span-2">
                <DateRangeFilter
                  value={(v as DateRangeValue) ?? { dateFrom: "", dateTo: "" }}
                  maxDays={f.maxDays}
                  onChange={(x) => onChange(f.key, x)}
                />
              </Field>
            );
          case "department":
          case "designation":
          case "branch": {
            const list =
              f.kind === "department"
                ? options.departments
                : f.kind === "designation"
                  ? options.designations
                  : options.branches;
            const opts = toOptions(list);
            const sel = asList(v);
            return (
              <Field key={f.key} filter={f}>
                <MultiSelectFilter
                  label={f.label}
                  options={opts}
                  value={sel}
                  placeholder={f.placeholder ?? "All"}
                  onChange={(x) => onChange(f.key, x)}
                />
                {sel.length > 1 && (
                  <SelectionChips
                    items={sel.map((id) => ({ value: id, label: opts.find((o) => o.value === id)?.label ?? id }))}
                    onRemove={(id) =>
                      onChange(
                        f.key,
                        sel.filter((x) => x !== id),
                      )
                    }
                  />
                )}
              </Field>
            );
          }
          case "employee":
            return (
              <Field key={f.key} filter={f} className="sm:col-span-2 lg:col-span-2">
                <EmployeeMultiPicker
                  label={f.label}
                  value={asList(v)}
                  departmentIds={departmentIds}
                  onChange={(x) => onChange(f.key, x)}
                />
              </Field>
            );
          case "employmentType":
            return (
              <Field key={f.key} filter={f}>
                <SingleSelect filter={f} value={String(v ?? "")} onChange={(x) => onChange(f.key, x)} includeAny />
              </Field>
            );
          case "employeeStatus":
            return (
              <Field key={f.key} filter={f}>
                <SingleSelect
                  filter={f}
                  value={String(v ?? "active")}
                  onChange={(x) => onChange(f.key, x || "active")}
                  includeAny={false}
                />
              </Field>
            );
          case "select": {
            if (f.multi) {
              return (
                <Field key={f.key} filter={f}>
                  <MultiSelectFilter
                    label={f.label}
                    options={f.options ?? []}
                    value={asList(v)}
                    placeholder={f.placeholder ?? "All"}
                    onChange={(x) => onChange(f.key, x)}
                  />
                </Field>
              );
            }
            return (
              <Field key={f.key} filter={f}>
                <SingleSelect
                  filter={f}
                  value={String(v ?? "")}
                  onChange={(x) => onChange(f.key, x)}
                  includeAny={!f.required}
                />
              </Field>
            );
          }
          case "boolean":
            return (
              <div key={f.key} className="flex flex-col justify-end pb-1">
                <label className="flex cursor-pointer items-center gap-2 text-sm text-gray-700">
                  <Checkbox
                    checked={v === true}
                    onCheckedChange={(x) => onChange(f.key, x === true)}
                    aria-label={f.label}
                  />
                  {f.label}
                </label>
                {f.help && <p className="mt-1 pl-6 text-[11px] leading-snug text-muted-foreground">{f.help}</p>}
              </div>
            );
          case "number":
            return (
              <Field key={f.key} filter={f}>
                <Input
                  type="number"
                  aria-label={f.label}
                  value={String(v ?? "")}
                  min={f.min}
                  max={f.max}
                  onChange={(e) => onChange(f.key, e.target.value)}
                  className="h-9"
                />
              </Field>
            );
          case "text":
            return (
              <Field key={f.key} filter={f}>
                <Input
                  aria-label={f.label}
                  value={String(v ?? "")}
                  placeholder={f.placeholder}
                  maxLength={100}
                  onChange={(e) => onChange(f.key, e.target.value)}
                  className="h-9"
                />
              </Field>
            );
          default:
            return null;
        }
      })}
    </div>
  );
}

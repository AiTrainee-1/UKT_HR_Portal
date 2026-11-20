import type { ReactNode } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  offersAny,
  type DateRangeValue,
  type FilterValue,
  type FilterValues,
  type NamedOption,
  type ReportCatalog,
  type ReportFilter,
} from "@/lib/report-center";
import { DateRangeFilter } from "./filters/DateRangeFilter";
import { EmployeeMultiPicker } from "./filters/EmployeeMultiPicker";
import { MultiSelectFilter, SelectionChips, optionLabel } from "./filters/MultiSelectFilter";
import { orgFilterOptions, prunePicked, reportOrgKind } from "./filters/org-options";
import { PeriodPicker } from "./filters/PeriodPicker";

/** Radix Select forbids an empty item value, so "no filter" travels as this sentinel. */
const ANY = "__any__";

const asList = (v: FilterValue): string[] => (Array.isArray(v) ? v.map(String) : v ? String(v).split(",") : []);
const toOptions = (list: NamedOption[]) => list.map((o) => ({ value: String(o.id), label: o.name }));

function Field({
  filter,
  className,
  invalid,
  children,
}: {
  filter: ReportFilter;
  className?: string;
  invalid?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={`${className ?? ""} ${invalid ? "rounded-lg bg-amber-50 p-1.5 ring-2 ring-amber-400" : ""}`}
      data-filter={filter.key}
      data-invalid={invalid ? "true" : undefined}
    >
      <label className="mb-1 block text-xs font-semibold text-gray-600">
        {filter.label}
        {filter.required && <span className="ml-0.5 text-red-500">*</span>}
      </label>
      {children}
      {invalid && <p className="mt-1 text-[11px] font-semibold text-amber-800">Change this filter</p>}
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
  invalidKey = null,
}: {
  filters: ReportFilter[];
  values: FilterValues;
  onChange: (key: string, value: FilterValue) => void;
  options: ReportCatalog["options"];
  /** The filter a refused run points at: highlighted until it is changed. */
  invalidKey?: string | null;
}) {
  const departmentIds = asList(values.department);
  // Staff and production have departments and designations of their own (lib/departments.ts): with the report's
  // Employee type on one kind only that kind is offered; on "All types" (or a report without it) both are, under two
  // headings.
  const kind = reportOrgKind(values.employmentType);
  const orgOptions = (k: "department" | "designation", forKind = kind) =>
    orgFilterOptions(k, k === "department" ? options.departments : options.designations, forKind);
  // A department / designation of the kind the type filter just left would filter the report to nobody: dropped.
  const changeType = (key: string, next: string) => {
    onChange(key, next);
    const nextKind = reportOrgKind(next);
    for (const f of filters) {
      if (f.kind !== "department" && f.kind !== "designation") continue;
      const picked = asList(values[f.key]);
      const kept = prunePicked(picked, orgOptions(f.kind, nextKind));
      if (kept.length !== picked.length) onChange(f.key, kept);
    }
  };

  return (
    <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
      {filters.map((f) => {
        const v = values[f.key];
        switch (f.kind) {
          case "period":
            return (
              <Field key={f.key} filter={f} invalid={invalidKey === f.key} className="lg:col-span-2">
                <PeriodPicker value={String(v ?? "")} onChange={(x) => onChange(f.key, x)} />
              </Field>
            );
          case "year":
            return (
              <Field key={f.key} filter={f} invalid={invalidKey === f.key}>
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
              <Field key={f.key} filter={f} invalid={invalidKey === f.key} className="sm:col-span-2 lg:col-span-2">
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
            const opts = f.kind === "branch" ? toOptions(list) : orgOptions(f.kind);
            const sel = asList(v);
            return (
              <Field key={f.key} filter={f} invalid={invalidKey === f.key}>
                <MultiSelectFilter
                  label={f.label}
                  options={opts}
                  value={sel}
                  placeholder={f.placeholder ?? "All"}
                  onChange={(x) => onChange(f.key, x)}
                />
                {sel.length > 1 && (
                  <SelectionChips
                    items={sel.map((id) => ({
                      value: id,
                      label: ((o) => (o ? optionLabel(o) : id))(opts.find((o) => o.value === id)),
                    }))}
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
              <Field key={f.key} filter={f} invalid={invalidKey === f.key} className="sm:col-span-2 lg:col-span-2">
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
              <Field key={f.key} filter={f} invalid={invalidKey === f.key}>
                <SingleSelect filter={f} value={String(v ?? "")} onChange={(x) => changeType(f.key, x)} includeAny />
              </Field>
            );
          case "employeeStatus":
            return (
              <Field key={f.key} filter={f} invalid={invalidKey === f.key}>
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
                <Field key={f.key} filter={f} invalid={invalidKey === f.key}>
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
              <Field key={f.key} filter={f} invalid={invalidKey === f.key}>
                <SingleSelect
                  filter={f}
                  value={String(v ?? "")}
                  onChange={(x) => onChange(f.key, x)}
                  includeAny={offersAny(f)}
                />
              </Field>
            );
          }
          case "boolean": {
            const invalid = invalidKey === f.key;
            return (
              <div
                key={f.key}
                className={`flex flex-col justify-end pb-1 ${invalid ? "rounded-lg bg-amber-50 p-1.5 ring-2 ring-amber-400" : ""}`}
                data-filter={f.key}
                data-invalid={invalid ? "true" : undefined}
              >
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
          }
          case "number":
            return (
              <Field key={f.key} filter={f} invalid={invalidKey === f.key}>
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
              <Field key={f.key} filter={f} invalid={invalidKey === f.key}>
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

import { useState } from "react";
import { Loader2, Table2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  usePreviewSharedEndpoint,
  type SharedDataset,
  type SharedEndpoint,
  type SharedKeyCategory,
} from "@/lib/api-client/custom-hooks";
import { saveErrorText } from "../payroll/form";
import { FilterValueBox } from "./LockedFilters";
import { Notice, ScrollTable, TD, TH } from "./ui";

function cell(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * A live look at the first rows, exactly as the public call would send them: only the SAVED fields, the SAVED locked filters.
 * It asks the management preview (no key, no log row), so it can be used before any key exists.
 */
export function PreviewPanel({
  saved,
  dataset,
  dirty,
}: {
  saved: SharedEndpoint | null;
  dataset: SharedDataset | undefined;
  dirty: boolean;
}) {
  const preview = usePreviewSharedEndpoint(saved?.id ?? 0);
  const [filters, setFilters] = useState<Record<string, string>>({});
  // "" = the endpoint as it is saved; a category = what a key of that category would be given
  const [asCategory, setAsCategory] = useState<SharedKeyCategory | "">("");

  if (!saved) {
    return (
      <Notice testId="preview-needs-save">
        Save the endpoint first. Then this box shows its first rows, so you can see exactly what the other application
        will receive.
      </Notice>
    );
  }

  const open = (dataset?.filters ?? []).filter((f) => !(f.key in saved.lockedFilters));
  const canRun = saved.fields.length > 0 && !preview.isPending;

  const run = () => {
    const chosen: Record<string, string> = {};
    for (const f of open) {
      const text = (filters[f.key] ?? "").trim();
      if (text !== "") chosen[f.key] = text;
    }
    preview.mutate({
      limit: 5,
      ...(Object.keys(chosen).length > 0 ? { filters: chosen } : {}),
      ...(asCategory !== "" ? { category: asCategory } : {}),
    });
  };

  const error = preview.isError ? (saveErrorText(preview.error) ?? "The preview could not be loaded.") : null;
  const result = preview.data;

  return (
    <div className="space-y-3" data-testid="preview-panel">
      {dirty && (
        <Notice tone="warn" testId="preview-saved-note">
          The preview shows the saved endpoint. Save your changes to see them here.
        </Notice>
      )}
      <div className="space-y-1">
        <label htmlFor="es-preview-category" className="text-xs font-semibold text-gray-700">
          Preview as
        </label>
        <select
          id="es-preview-category"
          value={asCategory}
          onChange={(e) => setAsCategory(e.target.value as SharedKeyCategory | "")}
          className="h-9 w-full rounded-md border border-input bg-white px-3 text-sm sm:max-w-xs"
          data-testid="preview-category"
        >
          <option value="">The endpoint as saved (no key limit)</option>
          <option value="staff">A Staff key (staff employees only)</option>
          <option value="production">A Production key (production employees only)</option>
        </select>
        <p className="text-xs text-slate-500">
          A key only ever reads the category it was made for. Pick one to see exactly what that key would receive.
        </p>
      </div>
      {open.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          {open.map((f) => (
            <div key={f.key} className="space-y-1">
              <label htmlFor={`es-preview-${f.key}`} className="text-xs font-semibold text-gray-700">
                {f.label}
                {f.required ? " (a recent period is used when empty)" : " (optional)"}
              </label>
              <FilterValueBox
                id={`es-preview-${f.key}`}
                filter={f}
                value={filters[f.key] ?? ""}
                onChange={(v) => setFilters((old) => ({ ...old, [f.key]: v }))}
              />
            </div>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" onClick={run} disabled={!canRun} className="gap-1.5" data-testid="preview-run">
          {preview.isPending ? <Loader2 size={13} className="animate-spin" /> : <Table2 size={13} />}
          Show the first 5 rows
        </Button>
        {saved.fields.length === 0 && <span className="text-xs text-slate-500">Save at least one field first.</span>}
      </div>
      {error && (
        <p role="alert" className="text-xs font-medium text-red-600" data-testid="preview-error">
          {error}
        </p>
      )}
      {result && !error && result.rows.length === 0 && (
        <p className="text-sm text-slate-500" data-testid="preview-empty">
          No rows came back. Nothing matches the locked filters{open.length > 0 ? " and the filters above" : ""}.
        </p>
      )}
      {result && !error && result.rows.length > 0 && (
        <div className="space-y-1.5" data-testid="preview-result">
          <ScrollTable label="Preview of the first rows">
            <thead>
              <tr>
                {result.fields.map((f) => (
                  <th key={f} className={TH}>
                    {f}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, i) => (
                <tr key={i} data-testid="preview-row">
                  {result.fields.map((f) => (
                    <td key={f} className={TD}>
                      {cell(row[f])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </ScrollTable>
          <p className="text-xs text-slate-500">
            {result.total !== null ? `${result.total} rows in all. ` : ""}Only the saved fields are in each row.
            {Object.keys(result.filters).length > 0 &&
              ` Filters used: ${Object.entries(result.filters)
                .map(([k, v]) => `${k} = ${v}`)
                .join(", ")}.`}
          </p>
        </div>
      )}
    </div>
  );
}

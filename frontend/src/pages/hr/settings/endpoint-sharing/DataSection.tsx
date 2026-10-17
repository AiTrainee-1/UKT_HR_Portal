import { SettingBlock } from "../kit/SettingBlock";
import { newSensitiveFields } from "./form";
import { FieldChecklist } from "./FieldChecklist";
import { LockedFilters } from "./LockedFilters";
import { PreviewPanel } from "./PreviewPanel";
import { Notice, Problem, SELECT_CLASS } from "./ui";
import type { SectionProps } from "./sectionProps";

/** Shown on the employees dataset: its optional filter is the only way to honour the existing "visible to external" flag. */
export const EXTERNAL_NOTE =
  'Every employee that matches your filters is shared, including those not marked as visible to external applications; lock the filter "Visible to external apps = yes" to share only those.';

export const EXTERNAL_NOTE_LOCKED =
  "Only employees marked as visible to external applications are shared (the filter is locked to yes).";

/** Data: which dataset the endpoint shares, which of its fields, which slice of it, and a live look at the result. */
export function DataSection({
  draft,
  patch,
  readOnly,
  errors,
  creating,
  saved,
  catalog,
  dataset,
  dirty,
}: SectionProps) {
  const newSensitive = newSensitiveFields(draft, saved?.fields ?? [], dataset);
  // the employees dataset has an opt-in flag (visibleToExternal) that is NOT applied unless the filter is locked
  const hasExternalFilter = dataset?.key === "employees" && dataset.filters.some((f) => f.key === "visibleToExternal");
  const externalLocked = draft.lockedFilters.visibleToExternal === "true";
  return (
    <div className="space-y-1" data-testid="endpoint-data">
      <SettingBlock
        id="data-dataset"
        labelFor="es-dataset"
        title="Dataset"
        purpose="Which part of the HR data this endpoint shares: employees, departments, attendance and so on. One endpoint shares one dataset. To share another, create another endpoint."
        note={
          creating
            ? "Choose carefully: the dataset cannot be changed after the endpoint is created."
            : "The dataset of a saved endpoint cannot be changed. Create a new endpoint to share different data."
        }
      >
        <select
          id="es-dataset"
          className={SELECT_CLASS}
          value={draft.dataset}
          disabled={readOnly || !creating}
          aria-invalid={errors.dataset ? true : undefined}
          onChange={(e) => {
            // a new dataset starts with no fields and no locks; its own page-size ceiling is respected
            const next = catalog.datasets.find((d) => d.key === e.target.value);
            const max = Math.min(Number(draft.pageSizeMax) || 200, next?.maxPageSize ?? 200);
            patch({
              dataset: e.target.value,
              fields: [],
              lockedFilters: {},
              pageSizeMax: String(max),
              pageSizeDefault: String(Math.min(Number(draft.pageSizeDefault) || 50, max)),
            });
          }}
        >
          {draft.dataset === "" && <option value="">Choose a dataset</option>}
          {catalog.datasets.map((d) => (
            <option key={d.key} value={d.key}>
              {d.label}
            </option>
          ))}
        </select>
        {errors.dataset && <Problem testId="error-dataset">{errors.dataset}</Problem>}
        {dataset && (
          <p className="text-xs leading-snug text-slate-600" data-testid="dataset-description">
            {dataset.description}
          </p>
        )}
      </SettingBlock>

      {dataset ? (
        <>
          <SettingBlock
            id="data-fields"
            title="Fields to share"
            purpose="Tick exactly the fields the other application needs. Only ticked fields are ever sent: anything not ticked can not be read through this endpoint, even if it exists in the system."
            note="Personal and financial fields ask for a confirmation when you save, and every such change is recorded in the audit log."
          >
            <FieldChecklist
              dataset={dataset}
              ticked={draft.fields}
              onChange={(fields) => patch({ fields })}
              readOnly={readOnly}
              excluded={catalog.hardExcluded}
              newSensitive={newSensitive}
            />
            {errors.fields && <Problem testId="error-fields">{errors.fields}</Problem>}
          </SettingBlock>

          <SettingBlock
            id="data-filters"
            title="Locked filters"
            purpose="Narrow what the endpoint can ever show. A locked filter has a fixed value that the caller cannot change, for example status = active so that former employees are never listed. Filters that stay unlocked can be used by the caller."
          >
            {hasExternalFilter && (
              <p
                className={`mb-3 rounded-lg border px-3 py-2 text-xs leading-snug ${
                  externalLocked
                    ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                    : "border-amber-200 bg-amber-50 text-amber-900"
                }`}
                data-testid="employees-external-note"
              >
                {externalLocked ? EXTERNAL_NOTE_LOCKED : EXTERNAL_NOTE}
              </p>
            )}
            <LockedFilters
              dataset={dataset}
              locked={draft.lockedFilters}
              onChange={(lockedFilters) => patch({ lockedFilters })}
              readOnly={readOnly}
              errors={errors}
            />
          </SettingBlock>
        </>
      ) : (
        <Notice testId="choose-dataset-first">Choose a dataset above to see its fields and filters.</Notice>
      )}

      <SettingBlock
        id="data-preview"
        title="Live preview"
        purpose="The first rows, exactly as the other application would receive them. It reads the saved endpoint, needs no key and is not written to the activity log."
      >
        <PreviewPanel saved={saved} dataset={dataset} dirty={dirty} />
      </SettingBlock>
    </div>
  );
}

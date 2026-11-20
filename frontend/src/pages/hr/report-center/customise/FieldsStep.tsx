import { useMemo, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, GripVertical, Search, X } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import type { CustomDataset, CustomSort } from "@/lib/api-client/custom-hooks/report-customise";
import { fieldIndex, moveField, removeField, searchSections, setSection, toggleField } from "./builder-logic";

function IconButton({
  label,
  disabled,
  onClick,
  children,
  testId,
  danger,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
  testId?: string;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      data-testid={testId}
      className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-gray-500 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 disabled:pointer-events-none disabled:opacity-30 ${
        danger ? "hover:bg-red-50 hover:text-red-700" : "hover:bg-gray-100 hover:text-gray-900"
      }`}
    >
      {children}
    </button>
  );
}

const SELECT =
  "h-9 rounded-md border border-input bg-white px-2 text-sm text-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 disabled:opacity-50";

/**
 * Step 2: the columns. The chosen fields in report order (drag a row, or use its up / down buttons, which work from the
 * keyboard too; remove with x), the sort, then every field of the data source by section, with a search and tick boxes.
 */
export function FieldsStep({
  dataset,
  fields,
  sort,
  onFields,
  onSort,
}: {
  dataset: CustomDataset;
  fields: string[];
  sort: CustomSort[];
  onFields: (next: string[]) => void;
  onSort: (next: CustomSort[]) => void;
}) {
  const [needle, setNeedle] = useState("");
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const [announce, setAnnounce] = useState("");
  const index = useMemo(() => fieldIndex(dataset), [dataset]);
  const sectionLabel = useMemo(() => new Map(dataset.sections.map((s) => [s.id, s.label])), [dataset]);
  const shown = useMemo(() => searchSections(dataset.sections, needle), [dataset, needle]);
  const chosen = useMemo(() => new Set(fields), [fields]);
  const labelOf = (key: string) => index.get(key)?.label ?? key;

  const move = (from: number, to: number) => {
    const next = moveField(fields, from, to);
    if (next === fields) return;
    onFields(next);
    setAnnounce(`${labelOf(fields[from])} moved to position ${next.indexOf(fields[from]) + 1} of ${fields.length}.`);
  };
  const remove = (key: string) => {
    onFields(removeField(fields, key));
    if (sort.some((s) => s.key === key)) onSort(sort.filter((s) => s.key !== key));
    setAnnounce(`${labelOf(key)} removed.`);
  };
  const toggle = (key: string) => {
    if (chosen.has(key)) remove(key);
    else onFields(toggleField(fields, key));
  };
  const endDrag = () => {
    setDragFrom(null);
    setDragOver(null);
  };

  const sortKey = sort[0]?.key ?? "";
  const sortDir = sort[0]?.dir ?? "asc";

  return (
    <div className="space-y-4">
      {/* chosen, in order */}
      <div>
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <p className="text-xs font-semibold text-gray-600">
            Columns in the report <span className="tabular-nums text-gray-500">({fields.length})</span>
          </p>
          {fields.length > 0 && (
            <button
              type="button"
              onClick={() => {
                onFields([]);
                onSort([]);
              }}
              className="text-[11px] font-semibold text-gray-500 hover:text-red-700 hover:underline"
            >
              Remove all
            </button>
          )}
        </div>
        {fields.length === 0 ? (
          <p
            className="rounded-lg border border-dashed px-3 py-4 text-center text-sm text-muted-foreground"
            data-testid="chosen-empty"
          >
            Tick fields below to add them as columns.
          </p>
        ) : (
          <ol aria-label="Chosen fields, in report order" className="divide-y rounded-lg border bg-white">
            {fields.map((key, i) => {
              const field = index.get(key);
              const label = field?.label ?? key;
              return (
                <li
                  key={key}
                  draggable
                  data-testid={`chosen-${key}`}
                  onDragStart={(e) => {
                    setDragFrom(i);
                    try {
                      e.dataTransfer?.setData("text/plain", key);
                      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
                    } catch {
                      // some browsers refuse setData during a synthetic drag: the order still moves
                    }
                  }}
                  onDragOver={(e) => {
                    if (dragFrom === null) return;
                    e.preventDefault();
                    if (dragOver !== i) setDragOver(i);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragFrom !== null) move(dragFrom, i);
                    endDrag();
                  }}
                  onDragEnd={endDrag}
                  className={`flex items-center gap-1.5 px-2 py-1.5 ${dragFrom === i ? "opacity-40" : ""} ${
                    dragOver === i && dragFrom !== null && dragFrom !== i
                      ? "bg-sky-50 ring-1 ring-inset ring-sky-300"
                      : ""
                  }`}
                >
                  <GripVertical size={15} className="shrink-0 cursor-grab text-gray-400" aria-hidden />
                  <span className="w-5 shrink-0 text-right text-[11px] tabular-nums text-gray-500">{i + 1}</span>
                  <span className="min-w-0 flex-1 pl-1">
                    <span className="block truncate text-sm font-semibold text-gray-800">{label}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {field ? (sectionLabel.get(field.section) ?? field.section) : "Not available"}
                    </span>
                  </span>
                  <IconButton label={`Move ${label} up`} disabled={i === 0} onClick={() => move(i, i - 1)}>
                    <ArrowUp size={14} />
                  </IconButton>
                  <IconButton
                    label={`Move ${label} down`}
                    disabled={i === fields.length - 1}
                    onClick={() => move(i, i + 1)}
                  >
                    <ArrowDown size={14} />
                  </IconButton>
                  <IconButton label={`Remove ${label}`} onClick={() => remove(key)} danger>
                    <X size={14} />
                  </IconButton>
                </li>
              );
            })}
          </ol>
        )}
        <p aria-live="polite" className="sr-only">
          {announce}
        </p>
      </div>

      {/* sort */}
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-0 flex-1">
          <span className="mb-1 block text-xs font-semibold text-gray-600">Sort rows by</span>
          <select
            className={`${SELECT} w-full`}
            value={sortKey}
            aria-label="Sort rows by"
            data-testid="sort-key"
            onChange={(e) => onSort(e.target.value ? [{ key: e.target.value, dir: sortDir }] : [])}
          >
            <option value="">The data source's own order</option>
            {fields.map((key) => (
              <option key={key} value={key}>
                {labelOf(key)}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="sr-only">Sort direction</span>
          <select
            className={SELECT}
            value={sortDir}
            aria-label="Sort direction"
            data-testid="sort-dir"
            disabled={!sortKey}
            onChange={(e) => onSort([{ key: sortKey, dir: e.target.value === "desc" ? "desc" : "asc" }])}
          >
            <option value="asc">Ascending</option>
            <option value="desc">Descending</option>
          </select>
        </label>
      </div>

      {/* every field */}
      <div>
        <p className="mb-1.5 text-xs font-semibold text-gray-600">Available fields</p>
        <div className="relative mb-2">
          <Search
            size={14}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={needle}
            onChange={(e) => setNeedle(e.target.value)}
            placeholder="Search fields - try “net”, “late”, “join”…"
            aria-label="Search fields"
            data-testid="field-search"
            className="h-9 pl-8 pr-8 text-sm"
          />
          {needle && (
            <button
              type="button"
              aria-label="Clear field search"
              onClick={() => setNeedle("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-gray-100"
            >
              <X size={13} />
            </button>
          )}
        </div>
        <div className="max-h-[28rem] overflow-y-auto rounded-lg border bg-white">
          {shown.length === 0 && (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">No field matches “{needle.trim()}”.</p>
          )}
          {shown.map((section) => {
            const full = dataset.sections.find((s) => s.id === section.id) ?? section;
            const picked = full.fields.filter((f) => chosen.has(f.key)).length;
            const allOn = picked === full.fields.length;
            const headingId = `fields-section-${section.id}`;
            return (
              <section
                key={section.id}
                aria-labelledby={headingId}
                className="border-b px-3 py-2.5 last:border-b-0"
                data-testid={`section-${section.id}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <h4 id={headingId} className="text-[11px] font-bold uppercase tracking-wider text-gray-500">
                    {section.label}{" "}
                    <span className="font-semibold normal-case tracking-normal text-gray-500">
                      · {picked} of {full.fields.length}
                    </span>
                  </h4>
                  {!needle.trim() && (
                    <button
                      type="button"
                      onClick={() => {
                        const next = setSection(fields, full, !allOn);
                        onFields(next);
                        if (allOn) onSort(sort.filter((s) => next.includes(s.key)));
                      }}
                      className="text-[11px] font-semibold text-sky-700 hover:underline"
                      data-testid={`section-toggle-${section.id}`}
                    >
                      {allOn ? "Remove all" : "Add all"}
                    </button>
                  )}
                </div>
                <div className="mt-1.5 grid gap-x-3 gap-y-0.5 sm:grid-cols-2">
                  {section.fields.map((f) => (
                    <label
                      key={f.key}
                      className="flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-slate-50"
                      title={f.description}
                    >
                      <Checkbox
                        checked={chosen.has(f.key)}
                        onCheckedChange={() => toggle(f.key)}
                        aria-label={f.label}
                        data-testid={`field-${f.key}`}
                        className="mt-0.5"
                      />
                      <span className="leading-tight text-gray-700">{f.label}</span>
                    </label>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}

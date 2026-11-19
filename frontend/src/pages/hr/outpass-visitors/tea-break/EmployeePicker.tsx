import { useId, useRef, useState } from "react";
import { Loader2, UserRound, X } from "lucide-react";
import { useDebounced } from "@/hooks/use-debounced";
import { useSearchEmployees } from "@/lib/api-client/custom-hooks";
import { VIEW_SAFE_ATTR } from "@/lib/view-only-lock";
import { cn } from "@/lib/utils";
import { CONTROL_H } from "../kit";

const MAX_MATCHES = 8;
const BOX =
  "rounded-lg border border-slate-200 bg-white text-sm text-slate-900 outline-none transition-colors " +
  "hover:border-slate-300 focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring/50";

/**
 * The employee filter: once one is picked, a chip with their name and an X; before that (for a role that may read the
 * Employees module, `canSearch`) a box that looks people up by name or code (GET /api/employees?search=, two letters or
 * more) and lists up to eight. Arrow keys move through the list, Enter picks, Esc closes. Without `canSearch` only the
 * chip is shown (an employee picked from the By employee table).
 */
export function EmployeePicker({
  value,
  label,
  canSearch,
  onChange,
  testId = "tea-employee",
}: {
  /** The picked employee's id ("" = everyone). */
  value: string;
  /** Their name as the page knows it (null when only the id is known, e.g. from an old link). */
  label: string | null;
  canSearch: boolean;
  onChange: (id: string, label: string | null) => void;
  testId?: string;
}) {
  const id = useId();
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const search = useDebounced(text.trim(), 250);
  const { data, isFetching } = useSearchEmployees(search, canSearch && open && !value);
  const matches = (search.length >= 2 ? (data ?? []) : []).slice(0, MAX_MATCHES);

  if (value) {
    return (
      <span
        className={cn(
          CONTROL_H,
          "inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-lg border border-primary/40 bg-primary/5 pl-2.5 text-sm text-slate-900",
        )}
        data-testid={`${testId}-chip`}
      >
        <UserRound size={14} className="shrink-0 text-primary" aria-hidden="true" />
        <span className="min-w-0 truncate" title={label ?? undefined}>
          {label ?? "One employee"}
        </span>
        <button
          type="button"
          aria-label="Show every employee"
          onClick={() => onChange("", null)}
          className="flex size-11 shrink-0 items-center justify-center text-slate-500 hover:text-slate-800 sm:size-9"
          data-testid={`${testId}-clear`}
          {...{ [VIEW_SAFE_ATTR]: "" }}
        >
          <X size={14} />
        </button>
      </span>
    );
  }
  if (!canSearch) return null;

  const pick = (index: number) => {
    const m = matches[index];
    if (!m) return;
    const name = `${m.firstName ?? ""} ${m.lastName ?? ""}`.trim() || m.employeeCode;
    onChange(String(m.id), `${name} · ${m.employeeCode}`);
    setText("");
    setOpen(false);
  };

  const listId = `${id}-list`;
  const showList = open && search.length >= 2;
  return (
    <div className="relative w-full min-w-0 sm:w-56">
      <label htmlFor={id} className="sr-only">
        Employee
      </label>
      <UserRound
        size={15}
        className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400"
        aria-hidden="true"
      />
      <input
        ref={inputRef}
        id={id}
        type="text"
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList && matches[active] ? `${id}-opt-${matches[active].id}` : undefined}
        autoComplete="off"
        placeholder="Employee"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            setActive((i) => Math.min(i + 1, Math.max(0, matches.length - 1)));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((i) => Math.max(0, i - 1));
          } else if (e.key === "Enter") {
            if (showList && matches.length) {
              e.preventDefault();
              pick(active);
            }
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
        className={cn(BOX, CONTROL_H, "w-full pl-8 pr-8")}
        data-testid={testId}
      />
      {isFetching && showList && (
        <Loader2
          size={14}
          className="absolute right-2.5 top-1/2 -translate-y-1/2 animate-spin text-slate-400"
          aria-hidden="true"
        />
      )}
      {showList && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Matching employees"
          className="absolute left-0 right-0 top-full z-30 mt-1 max-h-72 overflow-y-auto rounded-lg border border-slate-200 bg-white py-1"
          data-testid={`${testId}-list`}
          {...{ [VIEW_SAFE_ATTR]: "" }}
        >
          {matches.length === 0 ? (
            <li className="px-3 py-2 text-sm text-slate-500">
              {isFetching ? "Looking…" : `Nobody matches "${search}".`}
            </li>
          ) : (
            matches.map((m, i) => (
              <li
                key={m.id}
                id={`${id}-opt-${m.id}`}
                role="option"
                aria-selected={i === active}
                // keeps the focus in the box, so its blur does not close the list before the click lands
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(i)}
                onMouseEnter={() => setActive(i)}
                className={cn(
                  "flex min-h-11 cursor-pointer items-center justify-between gap-3 px-3 py-1.5 text-sm sm:min-h-9",
                  i === active ? "bg-sky-50" : "hover:bg-slate-50",
                )}
                data-testid={`${testId}-option`}
              >
                <span className="min-w-0 truncate text-slate-900">
                  {`${m.firstName ?? ""} ${m.lastName ?? ""}`.trim() || m.employeeCode}
                </span>
                <span className="shrink-0 font-mono text-[11px] text-slate-500">{m.employeeCode}</span>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Search, UserRound, X } from "lucide-react";
import { useSearchEmployees } from "@/lib/api-client/custom-hooks";
import { VIEW_SAFE_ATTR } from "@/lib/view-only-lock";
import { cn } from "@/lib/utils";
import { CONTROL_H } from "../kit";

const MAX_MATCHES = 8;
const BOX =
  "rounded-lg border border-slate-200 bg-white text-sm text-slate-900 outline-none transition-colors " +
  "hover:border-slate-300 focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring/50";

/**
 * The Employee filter: type two letters of a name or a code, pick the person from the list (mouse, or the arrow keys and
 * Enter). The chosen person shows as a chip with an X that clears the filter. It asks the app's own employee search
 * (useSearchEmployees: active employees, the Employees module's permission), so the page shows it only to a role that
 * may search employees. It only filters, so a View-only role keeps it (marked view-safe).
 */
export function EmployeeFilter({
  value,
  name,
  onChange,
  testId = "inout-employee",
}: {
  /** The chosen employee's id ("" = everyone). */
  value: string;
  /** The chosen employee's name, when known (else "Employee #<id>"). */
  name?: string | null;
  onChange: (id: string, name?: string) => void;
  testId?: string;
}) {
  const id = useId();
  const listId = `${id}-list`;
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);

  // ask once typing pauses, not once per letter
  useEffect(() => {
    const timer = setTimeout(() => setQuery(text.trim()), 300);
    return () => clearTimeout(timer);
  }, [text]);

  const searching = !value && query.length >= 2;
  const { data, isFetching } = useSearchEmployees(query, searching);
  const matches = (searching ? (data ?? []) : []).slice(0, MAX_MATCHES);
  const showList = open && text.trim().length >= 2;

  // close on a click anywhere else
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  const pick = (i: number) => {
    const m = matches[i];
    if (!m) return;
    onChange(String(m.id), `${m.firstName ?? ""} ${m.lastName ?? ""}`.trim() || m.employeeCode);
    setText("");
    setQuery("");
    setOpen(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(a + 1, Math.max(0, matches.length - 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter") {
      if (showList && matches.length > 0) {
        e.preventDefault();
        pick(active);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  if (value) {
    const label = name?.trim() || `Employee #${value}`;
    return (
      <div
        className={cn(BOX, CONTROL_H, "flex w-full min-w-0 items-center gap-1.5 pl-2.5 sm:w-auto sm:max-w-[16rem]")}
        data-testid={testId}
        {...{ [VIEW_SAFE_ATTR]: "" }}
      >
        <UserRound size={14} className="shrink-0 text-slate-400" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate" title={label}>
          {label}
        </span>
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label={`Clear the employee filter (${label})`}
          className="flex size-11 shrink-0 items-center justify-center text-slate-400 hover:text-slate-700 sm:size-9"
          data-testid={`${testId}-clear`}
        >
          <X size={14} />
        </button>
      </div>
    );
  }

  return (
    <div ref={box} className="relative w-full min-w-0 sm:w-56" data-testid={testId} {...{ [VIEW_SAFE_ATTR]: "" }}>
      <label htmlFor={id} className="sr-only">
        Employee
      </label>
      <Search
        size={15}
        className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400"
        aria-hidden="true"
      />
      <input
        id={id}
        type="search"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={showList}
        aria-controls={listId}
        aria-activedescendant={showList && matches[active] ? `${id}-opt-${matches[active].id}` : undefined}
        value={text}
        placeholder="Employee name or code"
        autoComplete="off"
        onChange={(e) => {
          setText(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        className={cn(BOX, CONTROL_H, "w-full pl-8 pr-2.5 [&::-webkit-search-cancel-button]:hidden")}
        data-testid={`${testId}-input`}
      />
      {showList && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Matching employees"
          className="absolute left-0 right-0 top-full z-30 mt-1 max-h-72 overflow-y-auto rounded-lg border border-slate-200 bg-white py-1"
          data-testid={`${testId}-list`}
        >
          {matches.length === 0 ? (
            <li className="px-3 py-2 text-sm text-slate-500" role="presentation">
              {isFetching || query !== text.trim() ? "Searching…" : "No active employee matches."}
            </li>
          ) : (
            matches.map((m, i) => (
              <li
                key={m.id}
                id={`${id}-opt-${m.id}`}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(i)}
                onMouseEnter={() => setActive(i)}
                className={cn(
                  "flex min-h-11 cursor-pointer flex-col justify-center px-3 py-1.5 sm:min-h-9",
                  i === active ? "bg-sky-50" : "hover:bg-slate-50",
                )}
                data-testid={`${testId}-option`}
              >
                <span className="truncate text-sm font-medium text-slate-900">
                  {`${m.firstName ?? ""} ${m.lastName ?? ""}`.trim() || m.employeeCode}
                </span>
                <span className="truncate text-[11px] text-slate-500">
                  <span className="font-mono">{m.employeeCode}</span>
                  {m.departmentName ? ` · ${m.departmentName}` : ""}
                </span>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

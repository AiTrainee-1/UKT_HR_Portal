import { useDeferredValue, useMemo, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Search, ChevronDown, Check } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface EmployeeSearchSelectProps {
  employees: any[] | undefined;
  value: string;                      // holds String(emp.id) internally
  onChange: (value: string) => void;
  placeholder?: string;
  allowAll?: boolean;
  allPlaceholder?: string;
  dataTestId?: string;
}

/** How many matches the list draws at once; typing narrows it. */
const MAX_VISIBLE = 50;

export default function EmployeeSearchSelect({
  employees,
  value,
  onChange,
  placeholder = "Search by employee code or name…",
  allowAll = false,
  allPlaceholder = "All Employees",
  dataTestId = "employee-search-select",
}: EmployeeSearchSelectProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  // The list follows the typed text a beat behind, so the input itself never waits for a roster-wide filter + re-render.
  const deferredSearch = useDeferredValue(search);

  const selectedEmployee = useMemo(() => employees?.find((e) => String(e.id) === value), [employees, value]);

  // Lower-cased once per roster, not once per employee per keystroke. Code, first name, last name and the full name are
  // joined by a character nobody can type, so a match never spans two of them; the phone is compared as it is, as before.
  const searchIndex = useMemo(
    () =>
      (employees ?? []).map((e) => ({
        emp: e,
        text: [
          e.employeeCode?.toLowerCase() ?? "",
          e.firstName?.toLowerCase() ?? "",
          e.lastName?.toLowerCase() ?? "",
          `${e.firstName} ${e.lastName}`.toLowerCase(),
        ].join("\u0000"),
        phone: e.phone as string | null | undefined,
      })),
    [employees],
  );

  const filtered = useMemo(() => {
    if (!deferredSearch) return employees ?? [];
    const q = deferredSearch.toLowerCase();
    return searchIndex.filter((x) => x.text.includes(q) || x.phone?.includes(q)).map((x) => x.emp);
  }, [employees, searchIndex, deferredSearch]);

  // Rendering every match (the whole roster before anything is typed) is what froze the dialogs: show the first
  // MAX_VISIBLE, plus the selected employee when they match but fall outside that window, so they stay selectable.
  const visible = useMemo(() => {
    const head = filtered.slice(0, MAX_VISIBLE);
    if (filtered.length > MAX_VISIBLE && value) {
      const picked = filtered.find((e) => String(e.id) === value);
      if (picked && !head.includes(picked)) return [picked, ...head];
    }
    return head;
  }, [filtered, value]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between font-normal text-left h-9"
          data-testid={dataTestId}
        >
          <span className="truncate flex items-center gap-2">
            {value === "all" && allowAll ? (
              <span className="text-muted-foreground">{allPlaceholder}</span>
            ) : selectedEmployee ? (
              <>
                <span className="font-mono font-semibold text-gray-900 text-xs bg-gray-100 px-1.5 py-0.5 rounded">
                  {selectedEmployee.employeeCode}
                </span>
                <span className="text-sm text-gray-700">
                  {selectedEmployee.firstName} {selectedEmployee.lastName}
                </span>
              </>
            ) : (
              <span className="text-muted-foreground text-sm">{placeholder}</span>
            )}
          </span>
          <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>

      <PopoverContent className="w-[320px] p-0" align="start">
        {/* Search input */}
        <div className="flex items-center border-b px-3 py-2 gap-2">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <Input
            autoFocus
            placeholder="Employee code or name…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 border-0 focus-visible:ring-0 p-0 text-sm"
          />
        </div>

        <div className="max-h-[240px] overflow-y-auto p-1 space-y-0.5">
          {/* All option */}
          {allowAll && (
            <button
              type="button"
              className={cn(
                "relative flex w-full cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground text-left",
                value === "all" && "bg-accent/50 font-semibold"
              )}
              onClick={() => { onChange("all"); setOpen(false); setSearch(""); }}
            >
              <Check className={cn("mr-2 h-4 w-4", value === "all" ? "opacity-100" : "opacity-0")} />
              {allPlaceholder}
            </button>
          )}

          {visible.length > 0 ? (
            visible.map((emp) => {
              const isSelected = String(emp.id) === value;
              return (
                <button
                  key={emp.id}
                  type="button"
                  className={cn(
                    "relative flex w-full cursor-pointer select-none items-center rounded-sm px-2 py-2 text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground text-left gap-3",
                    isSelected && "bg-accent/50"
                  )}
                  onClick={() => { onChange(String(emp.id)); setOpen(false); setSearch(""); }}
                >
                  <Check className={cn("h-4 w-4 shrink-0", isSelected ? "opacity-100 text-primary" : "opacity-0")} />
                  {/* Employee code badge -primary identifier */}
                  <span className="font-mono font-bold text-xs bg-gray-100 text-gray-800 px-1.5 py-0.5 rounded shrink-0">
                    {emp.employeeCode}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className={cn("truncate text-sm", isSelected ? "font-semibold" : "font-medium")}>
                      {emp.firstName} {emp.lastName}
                    </p>
                    {(emp.departmentName || emp.designationTitle) && (
                      <p className="truncate text-xs text-muted-foreground">
                        {[emp.departmentName, emp.designationTitle].filter(Boolean).join(" · ")}
                      </p>
                    )}
                  </div>
                  {emp.employmentType && (
                    <Badge variant="outline" className="text-[10px] shrink-0 capitalize font-normal">
                      {emp.employmentType}
                    </Badge>
                  )}
                </button>
              );
            })
          ) : (
            <div className="py-8 text-center text-sm text-muted-foreground">
              No employees found
            </div>
          )}
          {filtered.length > MAX_VISIBLE && (
            <p
              className="px-2 py-1.5 text-center text-xs text-muted-foreground"
              data-testid={`${dataTestId}-truncated`}
            >
              Showing {visible.length} of {filtered.length} — type to narrow
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

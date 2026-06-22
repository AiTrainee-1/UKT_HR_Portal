import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Search, ChevronDown, Check } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface EmployeeSearchSelectProps {
  employees: any[] | undefined;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  allowAll?: boolean;
  allPlaceholder?: string;
  dataTestId?: string;
}

export default function EmployeeSearchSelect({
  employees,
  value,
  onChange,
  placeholder = "Select employee...",
  allowAll = false,
  allPlaceholder = "All Employees",
  dataTestId = "employee-search-select",
}: EmployeeSearchSelectProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const selectedEmployee = employees?.find((e) => String(e.id) === value);

  const filtered = employees?.filter((e) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      e.firstName?.toLowerCase().includes(q) ||
      e.lastName?.toLowerCase().includes(q) ||
      e.email?.toLowerCase().includes(q) ||
      e.phone?.includes(q) ||
      e.employeeCode?.toLowerCase().includes(q)
    );
  }) ?? [];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between font-normal text-left"
          data-testid={dataTestId}
        >
          <span className="truncate">
            {value === "all" && allowAll
              ? allPlaceholder
              : selectedEmployee
              ? `${selectedEmployee.firstName} ${selectedEmployee.lastName} (${selectedEmployee.employeeCode})`
              : placeholder}
          </span>
          <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[300px] p-0" align="start">
        <div className="flex items-center border-b px-3 py-2 gap-2">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <Input
            placeholder="Search name, phone, code..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 border-0 focus-visible:ring-0 p-0"
          />
        </div>
        <div className="max-h-[220px] overflow-y-auto p-1 space-y-0.5">
          {allowAll && (
            <button
              type="button"
              className={cn(
                "relative flex w-full cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground text-left",
                value === "all" && "bg-accent/50 font-semibold"
              )}
              onClick={() => {
                onChange("all");
                setOpen(false);
                setSearch("");
              }}
            >
              <Check className={cn("mr-2 h-4 w-4", value === "all" ? "opacity-100" : "opacity-0")} />
              {allPlaceholder}
            </button>
          )}

          {filtered.length > 0 ? (
            filtered.map((emp) => {
              const isSelected = String(emp.id) === value;
              return (
                <button
                  key={emp.id}
                  type="button"
                  className={cn(
                    "relative flex w-full cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground text-left justify-between",
                    isSelected && "bg-accent/50 font-semibold"
                  )}
                  onClick={() => {
                    onChange(String(emp.id));
                    setOpen(false);
                    setSearch("");
                  }}
                >
                  <div className="flex items-center min-w-0">
                    <Check className={cn("mr-2 h-4 w-4 shrink-0", isSelected ? "opacity-100" : "opacity-0")} />
                    <div className="truncate min-w-0">
                      <p className="truncate font-medium text-sm">
                        {emp.firstName} {emp.lastName}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">{emp.phone}</p>
                    </div>
                  </div>
                  <Badge variant="outline" className="font-mono text-[10px] scale-90 ml-1 shrink-0">
                    {emp.employeeCode}
                  </Badge>
                </button>
              );
            })
          ) : (
            <div className="py-6 text-center text-sm text-muted-foreground">No employees found</div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Search, Users } from "lucide-react";
import type { Employee } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { CATEGORIES } from "./config";
import { dmy, searchEmployees } from "./logic";
import type { Category } from "./types";

const PAGE_SIZE = 10;

const money = (n?: number | null) => (n == null ? "—" : `₹${Number(n).toLocaleString("en-IN")}`);

type Props = {
  employees: Employee[];
  category: Category;
  loading: boolean;
  emptyText: string;
};

/** A look at the employees a download would contain: a search, ten at a time. */
export default function EmployeesTable({ employees, category, loading, emptyText }: Props) {
  const cfg = CATEGORIES[category];
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const shown = useMemo(() => searchEmployees(employees, query), [employees, query]);
  const pages = Math.max(1, Math.ceil(shown.length / PAGE_SIZE));
  const current = Math.min(page, pages);
  const rows = shown.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
  const pay = (e: Employee) => (category === "staff" ? money(e.salaryAmount) : `${money(e.salaryPerShift)} / shift`);

  return (
    <div className="rounded-xl border bg-white" data-testid="employees-table">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b p-3">
        <p className="text-sm font-bold text-gray-900">
          {shown.length} {shown.length === 1 ? "employee" : "employees"}
          {query && <span className="font-normal text-gray-500"> match “{query}”</span>}
        </p>
        <div className="relative w-full sm:w-64">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
          <Input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(1);
            }}
            placeholder="Search code, name, department"
            aria-label="Search employees"
            className="h-8 pl-8 text-xs"
          />
        </div>
      </div>

      {loading ? (
        <p className="p-6 text-center text-sm text-gray-500">Loading…</p>
      ) : shown.length === 0 ? (
        <div className="p-8 text-center">
          <Users size={28} className="mx-auto mb-2 text-gray-300" />
          <p className="text-sm text-gray-500">{query ? "No employee matches this search." : emptyText}</p>
        </div>
      ) : (
        <>
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full text-sm">
              <thead className="border-b bg-gray-50 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-4 py-2.5">Code</th>
                  <th className="px-4 py-2.5">Name</th>
                  <th className="px-4 py-2.5">Department</th>
                  <th className="px-4 py-2.5">Designation</th>
                  <th className="px-4 py-2.5">Branch</th>
                  <th className="px-4 py-2.5">Pay</th>
                  <th className="px-4 py-2.5">Joined</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.id} className="border-b last:border-0">
                    <td className="px-4 py-2.5 font-mono text-xs font-semibold text-gray-800">{e.employeeCode}</td>
                    <td className="px-4 py-2.5 font-medium text-gray-900">
                      {e.firstName} {e.lastName}
                    </td>
                    <td className="px-4 py-2.5 text-gray-600">{e.departmentName ?? "—"}</td>
                    <td className="px-4 py-2.5 text-gray-600">{e.designationTitle ?? "—"}</td>
                    <td className="px-4 py-2.5 text-gray-600">{e.branchName ?? "—"}</td>
                    <td className="px-4 py-2.5 text-gray-700">{pay(e)}</td>
                    <td className="px-4 py-2.5 text-gray-600">{dmy(e.joinDate) || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="divide-y md:hidden">
            {rows.map((e) => (
              <div key={e.id} className="flex items-start justify-between gap-3 p-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-gray-900">
                    {e.firstName} {e.lastName}
                  </p>
                  <p className="truncate text-xs text-gray-500">
                    <span className="font-mono">{e.employeeCode}</span> · {e.departmentName ?? "No department"}
                  </p>
                </div>
                <span className={cn("shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-bold", cfg.accent.chip)}>
                  {pay(e)}
                </span>
              </div>
            ))}
          </div>
          {shown.length > PAGE_SIZE && (
            <div className="flex items-center justify-between border-t px-4 py-2.5 text-xs text-gray-500">
              <span>
                {(current - 1) * PAGE_SIZE + 1}-{Math.min(current * PAGE_SIZE, shown.length)} of {shown.length}
              </span>
              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="icon"
                  className="h-7 w-7"
                  disabled={current === 1}
                  onClick={() => setPage(current - 1)}
                  aria-label="Previous page"
                >
                  <ChevronLeft size={14} />
                </Button>
                <span className="px-1">
                  {current} / {pages}
                </span>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-7 w-7"
                  disabled={current === pages}
                  onClick={() => setPage(current + 1)}
                  aria-label="Next page"
                >
                  <ChevronRight size={14} />
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

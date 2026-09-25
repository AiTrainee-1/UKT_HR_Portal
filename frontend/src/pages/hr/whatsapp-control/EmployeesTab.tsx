import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import DataPagination from "@/components/ui/DataPagination";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Search } from "lucide-react";
import { useWhatsAppEmployees, type WhatsAppEmployeeRow } from "@/lib/api-client/custom-hooks";
import { MessageList } from "./MessagesTab";
import { fmtDateTime, useDebounced } from "./shared";

export default function EmployeesTab() {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [selected, setSelected] = useState<WhatsAppEmployeeRow | null>(null);
  const debounced = useDebounced(search);
  const { data, isLoading } = useWhatsAppEmployees({ search: debounced, page, pageSize });
  const rows = data?.items ?? [];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-xs text-gray-500">
          Everyone who has been sent a WhatsApp message. Open a row for that employee's full history.
        </p>
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Search name or employee code"
            className="h-8 w-64 pl-8 text-xs"
            aria-label="Search employees"
          />
        </div>
      </div>

      <div className="rounded-xl border bg-white overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 text-gray-500">
            <tr className="text-left">
              <th className="px-3 py-2 font-semibold">Employee</th>
              <th className="px-3 py-2 font-semibold">Department</th>
              <th className="px-3 py-2 font-semibold">WhatsApp number</th>
              <th className="px-3 py-2 font-semibold text-right">Messages</th>
              <th className="px-3 py-2 font-semibold text-right">Failed</th>
              <th className="px-3 py-2 font-semibold">Last message</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              Array.from({ length: 6 }).map((_, i) => (
                <tr key={i} className="border-t">
                  <td colSpan={6} className="px-3 py-2">
                    <Skeleton className="h-5 w-full" />
                  </td>
                </tr>
              ))
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-10 text-center text-gray-400">
                  {debounced ? "No employee matches that search." : "No employee has been messaged yet."}
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr
                  key={r.employeeId}
                  className="border-t hover:bg-slate-50 cursor-pointer"
                  onClick={() => setSelected(r)}
                  data-testid="whatsapp-employee-row"
                >
                  <td className="px-3 py-2">
                    <p className="font-semibold text-gray-800">{r.employeeName}</p>
                    <p className="text-[10px] text-gray-400">{r.employeeCode}</p>
                  </td>
                  <td className="px-3 py-2 text-gray-600">{r.department ?? "—"}</td>
                  <td className="px-3 py-2 text-gray-600">
                    {r.phone ? `+${r.phone}` : <span className="text-red-600">Not on file</span>}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.total}</td>
                  <td
                    className={`px-3 py-2 text-right tabular-nums ${r.failed ? "text-red-600 font-semibold" : "text-gray-400"}`}
                  >
                    {r.failed}
                  </td>
                  <td className="px-3 py-2 text-gray-500 whitespace-nowrap">{fmtDateTime(r.lastMessageAt)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <DataPagination
        page={page}
        totalPages={Math.max(1, Math.ceil((data?.total ?? 0) / pageSize))}
        onPageChange={setPage}
        pageSize={pageSize}
        onPageSizeChange={(s) => {
          setPageSize(s);
          setPage(1);
        }}
        totalItems={data?.total}
      />

      {selected && (
        <Dialog open onOpenChange={(open) => !open && setSelected(null)}>
          <DialogContent className="max-w-3xl">
            <DialogHeader>
              <DialogTitle>
                {selected.employeeName} <span className="text-gray-400 font-normal">({selected.employeeCode})</span>
              </DialogTitle>
            </DialogHeader>
            <p className="text-xs text-gray-500 -mt-1">
              {selected.phone ? `+${selected.phone}` : "No number on file"} · {selected.total} message
              {selected.total === 1 ? "" : "s"}, {selected.failed} failed
            </p>
            <MessageList employeeId={selected.employeeId} compact />
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

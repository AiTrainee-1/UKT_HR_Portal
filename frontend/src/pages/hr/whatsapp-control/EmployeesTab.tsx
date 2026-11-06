import { useState } from "react";
import { Input } from "@/components/ui/input";
import { PillTabs } from "@/components/ui/pill-tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import DataPagination from "@/components/ui/DataPagination";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { Search } from "lucide-react";
import {
  useSetWhatsAppOptOut,
  useWhatsAppEmployees,
  whatsAppErrorMessage,
  type WhatsAppEmployeeRow,
} from "@/lib/api-client/custom-hooks";
import { MessageList } from "./MessagesTab";
import { fmtDateTime, useDebounced } from "./shared";

type Show = "all" | "optout";

export default function EmployeesTab() {
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [show, setShow] = useState<Show>("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [selected, setSelected] = useState<WhatsAppEmployeeRow | null>(null);
  const debounced = useDebounced(search);
  const onlyOptOut = show === "optout";
  const { data, isLoading } = useWhatsAppEmployees({
    search: debounced,
    optOut: onlyOptOut ? "true" : undefined,
    all: "1", // everyone, also those never messaged: No WhatsApp can be set before the first message
    page,
    pageSize,
  });
  // How many have No WhatsApp on (one row is enough to read the total).
  const optOutCount = useWhatsAppEmployees({ optOut: "true", page: 1, pageSize: 1 }).data;
  const countKnown = optOutCount !== undefined && optOutCount.items.every((r) => r.optOut);
  const setOptOut = useSetWhatsAppOptOut();

  // Rows are filtered here too, so the list stays right while a switch has just moved (and the server catches up).
  const rows = (data?.items ?? []).filter((r) => !onlyOptOut || r.optOut);

  const changeOptOut = (r: WhatsAppEmployeeRow, optOut: boolean) =>
    setOptOut.mutate(
      { employeeId: r.employeeId, optOut },
      {
        onSuccess: () =>
          toast({
            title: optOut ? `${r.employeeName}: No WhatsApp` : `${r.employeeName}: WhatsApp messages back on`,
            description: optOut
              ? "Their WhatsApp messages are skipped from now on, except login codes they ask for."
              : undefined,
          }),
        onError: (e) =>
          toast({
            title: `Couldn't change No WhatsApp for ${r.employeeName}`,
            description: whatsAppErrorMessage(e, "Try again."),
            variant: "destructive",
          }),
      },
    );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-xs text-gray-500 max-w-2xl">
          Everyone who has been sent a WhatsApp message. Open a row for that employee's full history. Turn on{" "}
          <b>No WhatsApp</b> for an employee who has asked not to get WhatsApp messages: what would have gone to them
          shows as Skipped on the Messages tab. Login codes they ask for themselves still go.
        </p>
        <div className="flex items-center gap-3 flex-wrap">
          <div data-testid="wa-optout-filter">
            <PillTabs
              size="sm"
              items={[
                { value: "all", label: "All" },
                {
                  value: "optout",
                  label: "No WhatsApp",
                  count: countKnown ? optOutCount.total : undefined,
                },
              ]}
              value={show}
              onChange={(v) => {
                setShow(v as Show);
                setPage(1);
              }}
            />
          </div>
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
              <th className="px-3 py-2 font-semibold">No WhatsApp</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              Array.from({ length: 6 }).map((_, i) => (
                <tr key={i} className="border-t">
                  <td colSpan={7} className="px-3 py-2">
                    <Skeleton className="h-5 w-full" />
                  </td>
                </tr>
              ))
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-10 text-center text-gray-400">
                  {onlyOptOut
                    ? debounced
                      ? "No employee with No WhatsApp matches that search."
                      : "No employee has No WhatsApp on."
                    : debounced
                      ? "No employee matches that search."
                      : "No employee has been messaged yet."}
                </td>
              </tr>
            ) : (
              rows.map((r) => {
                const busy = setOptOut.isPending && setOptOut.variables?.employeeId === r.employeeId;
                return (
                  <tr
                    key={r.employeeId}
                    className={`border-t hover:bg-slate-50 cursor-pointer ${r.optOut ? "bg-orange-50/40" : ""}`}
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
                    {/* The switch must not open the history dialog. */}
                    <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={Boolean(r.optOut)}
                          disabled={busy}
                          onCheckedChange={(next) => changeOptOut(r, next)}
                          aria-label={`No WhatsApp for ${r.employeeName}`}
                          data-testid={`wa-optout-${r.employeeId}`}
                        />
                        {r.optOut && <StatusBadge tone="caution">No WhatsApp</StatusBadge>}
                      </div>
                    </td>
                  </tr>
                );
              })
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
              <DialogTitle className="flex items-center gap-2 flex-wrap">
                {selected.employeeName} <span className="text-gray-400 font-normal">({selected.employeeCode})</span>
                {selected.optOut && <StatusBadge tone="caution">No WhatsApp</StatusBadge>}
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

import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, History, Link2, Link2Off, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useLinkHistory, type DeviceControlDevice, type EmploymentType } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { EmploymentFilter } from "./SubTabs";

function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

/**
 * Link / Unlink -> Modified (owner 2026-11-17): every link and unlink made for an employee (who, which device, which way,
 * by whom, when), newest first, with filters; and who has a device unlinked right now. Changes made before this list
 * existed come from the audit log.
 */
export default function LinkHistory({ devices }: { devices: DeviceControlDevice[] }) {
  const [query, setQuery] = useState("");
  const search = useDebounced(query.trim());
  const [action, setAction] = useState<"" | "link" | "unlink">("");
  const [kind, setKind] = useState<EmploymentType | "">("");
  const [device, setDevice] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [search, action, kind, device]);
  const q = useLinkHistory({ search, action, employmentType: kind, device, page });
  const data = q.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div className="space-y-4" data-testid="link-history">
      <Card className="rounded-2xl">
        <CardContent className="flex flex-wrap items-center gap-2 p-3">
          <div className="relative min-w-[14rem] flex-1">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by Employee Code or name"
              className="pl-8"
              data-testid="link-history-search"
            />
          </div>
          <div className="inline-flex gap-0.5 rounded-xl bg-slate-100 p-1" role="group" aria-label="Link or unlink">
            {(
              [
                ["", "All changes"],
                ["unlink", "Unlinked"],
                ["link", "Linked again"],
              ] as const
            ).map(([v, label]) => (
              <button
                key={v || "all"}
                type="button"
                aria-pressed={action === v}
                onClick={() => setAction(v)}
                className={cn(
                  "h-8 rounded-lg px-2.5 text-xs font-semibold",
                  action === v
                    ? "bg-white text-slate-900 shadow-sm ring-1 ring-slate-200"
                    : "text-slate-500 hover:text-slate-900",
                )}
                data-view-safe
                data-testid={`link-history-action-${v || "all"}`}
              >
                {label}
              </button>
            ))}
          </div>
          <EmploymentFilter value={kind} onChange={setKind} testId="link-history-kind" />
          <select
            value={device ?? ""}
            onChange={(e) => setDevice(e.target.value ? Number(e.target.value) : null)}
            className="h-9 rounded-lg border bg-white px-2 text-xs"
            aria-label="Device"
            data-testid="link-history-device"
          >
            <option value="">Every device</option>
            {devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </CardContent>
      </Card>

      {data && data.current.length > 0 && (
        <Card className="rounded-2xl">
          <CardContent className="space-y-2 p-4" data-testid="link-history-current">
            <p className="flex items-center gap-1.5 text-sm font-bold text-slate-800">
              <Link2Off size={14} className="text-rose-600" /> Unlinked right now ({data.current.length})
            </p>
            <div className="flex flex-wrap gap-2">
              {data.current.map((c) => (
                <span
                  key={c.employee.id}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-rose-100 bg-rose-50 px-2.5 py-1 text-xs text-rose-900"
                >
                  <span className="font-mono">{c.employee.code}</span>
                  <span className="font-semibold">{c.employee.name}</span>
                  <span className="text-rose-700">· {c.unlinkedDevices.join(", ")}</span>
                </span>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <Card className="overflow-hidden rounded-2xl">
        <CardContent className="p-0">
          <p className="flex items-center gap-1.5 border-b px-4 py-3 text-sm font-bold text-slate-800">
            <History size={14} /> Changes {data ? `(${data.total.toLocaleString("en-IN")})` : ""}
          </p>
          {q.isLoading && !data ? (
            <div className="p-4">
              <Skeleton className="h-32 rounded-xl" />
            </div>
          ) : !data || data.rows.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-slate-500" data-testid="link-history-empty">
              No link or unlink has been made
              {search || action || kind || device ? " that matches these filters" : " yet"}.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table data-testid="link-history-table">
                <TableHeader>
                  <TableRow>
                    {["When", "Employee", "Kind", "Device", "Change", "By"].map((h) => (
                      <TableHead key={h} className="whitespace-nowrap text-xs">
                        {h}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.rows.map((r) => (
                    <TableRow key={r.id} data-testid={`link-history-row-${r.id}`}>
                      <TableCell className="whitespace-nowrap text-xs text-slate-500">{when(r.at)}</TableCell>
                      <TableCell>
                        <span className="block whitespace-nowrap text-sm font-semibold text-slate-900">
                          {r.employee.name}
                        </span>
                        <span className="block font-mono text-[11px] text-slate-500">
                          {r.employee.code}
                          {r.employee.department ? ` · ${r.employee.department}` : ""}
                        </span>
                      </TableCell>
                      <TableCell className="text-xs capitalize text-slate-600">{r.employee.employmentType}</TableCell>
                      <TableCell className="whitespace-nowrap text-sm text-slate-700">{r.deviceName || "—"}</TableCell>
                      <TableCell>
                        <span
                          className={cn(
                            "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold",
                            r.action === "unlink" ? "bg-rose-50 text-rose-700" : "bg-emerald-50 text-emerald-700",
                          )}
                        >
                          {r.action === "unlink" ? <Link2Off size={11} /> : <Link2 size={11} />}
                          {r.action === "unlink" ? "Unlinked" : "Linked again"}
                        </span>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-slate-500">{r.changedBy || "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          {data && pages > 1 && (
            <div className="flex items-center justify-end gap-2 border-t px-4 py-2 text-xs text-slate-500">
              Page {page} of {pages}
              <Button
                size="sm"
                variant="outline"
                className="h-8 w-8 p-0"
                disabled={page <= 1}
                onClick={() => setPage(page - 1)}
                aria-label="Previous page"
              >
                <ChevronLeft size={14} />
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-8 w-8 p-0"
                disabled={page >= pages}
                onClick={() => setPage(page + 1)}
                aria-label="Next page"
              >
                <ChevronRight size={14} />
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

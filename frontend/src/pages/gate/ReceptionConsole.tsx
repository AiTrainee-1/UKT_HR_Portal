import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Pagination, PaginationContent, PaginationItem, PaginationLink,
  PaginationNext, PaginationPrevious,
} from "@/components/ui/pagination";
import { PillTabs } from "@/components/ui/pill-tabs";
import { KpiRunningBorder } from "@/components/ui/KpiLoader";
import {
  useReceptionSummary, useReceptionVisits,
  type GateRange, type ReceptionVisit,
} from "@/lib/api-client/custom-hooks";
import {
  UserRound, LogOut, Calendar, CalendarDays, CalendarRange,
  Mail, MessageCircle, Eye, EyeOff, Inbox,
} from "lucide-react";

/**
 * The Reception dashboard -a read-only desk view onto VisitorVisit, with
 * its own ReceptionDevice login (reception_views.py) instead of an HR one.
 * Deliberately NOT a scanner: the visitor's own phone scanning the existing
 * permanent per-branch Visitor QR (see VisitorGate.tsx) remains the only way
 * a visit gets recorded -this page only surfaces that data live, plus who
 * each visitor came to see (resolved by phone match against Employee) and
 * whether that person was notified.
 */

const RANGE_LABEL: Record<GateRange, string> = { today: "Today", week: "This Week", month: "This Month" };
const PAGE_SIZE = 15;

function fmtDateTime(iso: string) {
  const d = new Date(iso);
  return isNaN(d.getTime())
    ? iso
    : d.toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

function StatCard({
  icon: Icon, label, value, colorCls, accent, isLoading,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
  value: number;
  colorCls: string;
  accent: string;
  isLoading?: boolean;
}) {
  return (
    <Card className="relative border">
      {isLoading && <KpiRunningBorder accent={accent} radius={12} />}
      <CardContent className="p-5">
        <div className="flex items-center justify-between mb-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-gray-500">{label}</p>
          <div className={`p-1.5 rounded-lg ${colorCls}`}>
            <Icon size={14} className="text-white" />
          </div>
        </div>
        <p className="flex h-9 items-center text-3xl font-black text-gray-900 leading-none">
          {isLoading ? "" : value}
        </p>
      </CardContent>
    </Card>
  );
}

function VisitRow({ visit }: { visit: ReceptionVisit }) {
  const [revealed, setRevealed] = useState(false);
  const emp = visit.meetingEmployee;

  return (
    <TableRow>
      <TableCell>
        <p className="font-medium">{visit.name}</p>
        <p className="text-xs text-muted-foreground">{visit.phone}</p>
      </TableCell>
      <TableCell className="tracking-wider">
        {visit.aadhaarLast4 ? (
          <button
            type="button"
            onClick={() => setRevealed((r) => !r)}
            className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground"
          >
            <span className="font-mono text-xs">{revealed && visit.aadhaar ? visit.aadhaar : `••••${visit.aadhaarLast4}`}</span>
            {revealed ? <EyeOff size={12} /> : <Eye size={12} />}
          </button>
        ) : "—"}
      </TableCell>
      <TableCell>
        {emp ? (
          <div className="flex items-center gap-2">
            <Avatar className="size-7">
              <AvatarImage src={emp.photoUrl ?? undefined} />
              <AvatarFallback className="text-[10px]">{emp.name[0]}</AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <p className="truncate font-medium">{emp.name}</p>
              <p className="text-xs text-muted-foreground">{emp.department ?? emp.employeeCode}</p>
            </div>
          </div>
        ) : (
          <span className="text-muted-foreground">{visit.whomToMeet}</span>
        )}
      </TableCell>
      <TableCell className="max-w-[180px] truncate" title={visit.purpose}>{visit.purpose}</TableCell>
      <TableCell>
        {emp ? (
          <div className="flex items-center gap-1.5">
            <span
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                visit.notifiedEmailAt ? "border-green-200 bg-green-50 text-green-700" : "border-gray-200 bg-gray-50 text-gray-400"
              }`}
              title={visit.notifiedEmailAt ? `Emailed ${fmtDateTime(visit.notifiedEmailAt)}` : "Not emailed"}
            >
              <Mail size={11} /> {visit.notifiedEmailAt ? "Sent" : "—"}
            </span>
            <span
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                visit.notifiedWhatsappAt ? "border-green-200 bg-green-50 text-green-700" : "border-gray-200 bg-gray-50 text-gray-400"
              }`}
              title={visit.notifiedWhatsappAt ? `WhatsApp sent ${fmtDateTime(visit.notifiedWhatsappAt)}` : "Not sent"}
            >
              <MessageCircle size={11} /> {visit.notifiedWhatsappAt ? "Sent" : "—"}
            </span>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className="text-right text-muted-foreground">{fmtDateTime(visit.visitedAt)}</TableCell>
    </TableRow>
  );
}

export default function ReceptionConsole() {
  const [, navigate] = useLocation();
  const [deskName] = useState(() => localStorage.getItem("reception_device_name") ?? "Reception");
  const [range, setRange] = useState<GateRange>("today");
  const [page, setPage] = useState(1);

  useEffect(() => {
    if (!localStorage.getItem("reception_device_token")) navigate("/");
  }, [navigate]);

  const { data: summary, isLoading: summaryLoading } = useReceptionSummary();
  const { data: page_, isLoading } = useReceptionVisits(range, page, PAGE_SIZE);
  const rows = page_?.items ?? [];

  const logout = () => {
    localStorage.removeItem("reception_device_token");
    localStorage.removeItem("reception_device_id");
    localStorage.removeItem("reception_device_name");
    navigate("/");
  };

  const changeRange = (v: string) => { setRange(v as GateRange); setPage(1); };

  const totalPages = Math.max(1, Math.ceil((page_?.total ?? 0) / PAGE_SIZE));
  const pageSafe = Math.min(page, totalPages);

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b px-5 py-3">
        <div className="flex items-center gap-2">
          <UserRound className="text-accent" size={20} />
          <span className="font-black text-lg">{deskName}</span>
        </div>
        <Button variant="outline" size="sm" className="gap-1.5" onClick={logout}>
          <LogOut size={14} /> Logout
        </Button>
      </header>

      <main className="flex-1 space-y-4 p-4">
        <div className="grid grid-cols-3 gap-4">
          <StatCard icon={Calendar} label="Today" value={summary?.today ?? 0} colorCls="bg-sky-500" accent="#0ea5e9" isLoading={summaryLoading} />
          <StatCard icon={CalendarDays} label="This Week" value={summary?.thisWeek ?? 0} colorCls="bg-violet-500" accent="#8b5cf6" isLoading={summaryLoading} />
          <StatCard icon={CalendarRange} label="This Month" value={summary?.thisMonth ?? 0} colorCls="bg-amber-500" accent="#f59e0b" isLoading={summaryLoading} />
        </div>

        <div className="flex items-center justify-between">
          <PillTabs
            size="sm"
            items={(["today", "week", "month"] as GateRange[]).map((r) => ({ value: r, label: RANGE_LABEL[r] }))}
            value={range}
            onChange={changeRange}
            baseColor="#0f172a"
            pillBg="#f1f5f9"
          />
        </div>

        <Card>
          <CardContent className="p-0">
            <div className="flex items-center gap-2 px-4 pt-4 pb-3">
              <UserRound size={16} className="text-primary" />
              <p className="font-bold">Visitors -{RANGE_LABEL[range]}</p>
              <span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-xs font-semibold text-muted-foreground">
                {page_?.total ?? 0}
              </span>
            </div>

            {isLoading && !page_ ? (
              <p className="py-10 text-center text-sm text-muted-foreground">Loading…</p>
            ) : !rows.length ? (
              <div className="flex flex-col items-center gap-2 py-10 text-center text-muted-foreground">
                <Inbox size={22} className="opacity-40" />
                <p className="text-sm">No visitors recorded for {RANGE_LABEL[range].toLowerCase()}.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Visitor</TableHead>
                      <TableHead>Aadhaar</TableHead>
                      <TableHead>Meeting</TableHead>
                      <TableHead>Purpose</TableHead>
                      <TableHead>Notified</TableHead>
                      <TableHead className="text-right">Visited</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((v) => <VisitRow key={v.id} visit={v} />)}
                  </TableBody>
                </Table>
              </div>
            )}

            {totalPages > 1 && (
              <div className="flex items-center justify-between border-t px-4 py-3">
                <p className="text-xs text-muted-foreground">
                  Showing {(pageSafe - 1) * PAGE_SIZE + 1}–{Math.min(pageSafe * PAGE_SIZE, page_?.total ?? 0)} of {page_?.total ?? 0}
                </p>
                <Pagination className="mx-0 w-auto">
                  <PaginationContent>
                    <PaginationItem>
                      <PaginationPrevious
                        href="#"
                        className={pageSafe === 1 ? "pointer-events-none opacity-50" : undefined}
                        onClick={(e) => { e.preventDefault(); if (pageSafe > 1) setPage(pageSafe - 1); }}
                      />
                    </PaginationItem>
                    {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
                      <PaginationItem key={p}>
                        <PaginationLink href="#" isActive={p === pageSafe} onClick={(e) => { e.preventDefault(); setPage(p); }}>
                          {p}
                        </PaginationLink>
                      </PaginationItem>
                    ))}
                    <PaginationItem>
                      <PaginationNext
                        href="#"
                        className={pageSafe === totalPages ? "pointer-events-none opacity-50" : undefined}
                        onClick={(e) => { e.preventDefault(); if (pageSafe < totalPages) setPage(pageSafe + 1); }}
                      />
                    </PaginationItem>
                  </PaginationContent>
                </Pagination>
              </div>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}

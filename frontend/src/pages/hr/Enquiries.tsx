// HR -> Enquiries (2026-11-24): every question an employee raised from the mobile app ("Enquiries"), worked through as a
// to-do list. Tick one to mark it Done, or set it Pending / On Hold; write a reply the employee reads. Every change is
// pushed to the employee's phone (backend/api/enquiry_views.py). Who may see / handle the Requests page may do the same
// here (module "requests").
import { useMemo, useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Circle,
  CircleCheckBig,
  Clock,
  History,
  Inbox,
  MessageCircleQuestion,
  PauseCircle,
  Reply,
  Search,
  Send,
} from "lucide-react";
import HrLayout from "@/components/HrLayout";
import { RefreshButton } from "@/components/PageRefreshBar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PillTabs } from "@/components/ui/pill-tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { isRouteViewOnly, useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import {
  useEnquiries,
  useUpdateEnquiry,
  type EnquiryItem,
  type EnquiryStatus,
} from "@/lib/api-client/custom-hooks";

type View = EnquiryStatus | "all";

const STATUS_META: Record<EnquiryStatus, { label: string; tone: string; icon: typeof Clock }> = {
  pending: { label: "Pending", tone: "bg-amber-50 text-amber-800 border-amber-200", icon: Clock },
  on_hold: { label: "On Hold", tone: "bg-sky-50 text-sky-800 border-sky-200", icon: PauseCircle },
  done: { label: "Done", tone: "bg-green-50 text-green-800 border-green-200", icon: CheckCircle2 },
};

const CATEGORY_TONE: Record<string, string> = {
  salary: "bg-emerald-50 text-emerald-700",
  attendance: "bg-indigo-50 text-indigo-700",
  leave: "bg-pink-50 text-pink-700",
  documents: "bg-slate-100 text-slate-700",
  general: "bg-blue-50 text-blue-700",
  other: "bg-gray-100 text-gray-700",
};

function when(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
}

function ago(iso: string | null): string {
  if (!iso) return "";
  const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("");
}

function EnquiryRow({ item, readOnly }: { item: EnquiryItem; readOnly: boolean }) {
  const { toast } = useToast();
  const update = useUpdateEnquiry();
  const [replyOpen, setReplyOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [reply, setReply] = useState("");
  const done = item.status === "done";
  const emp = item.employee;

  const save = async (status?: EnquiryStatus, text?: string) => {
    try {
      await update.mutateAsync({ id: item.id, status, reply: text });
      toast({
        title: status ? `Marked ${STATUS_META[status].label}` : "Reply sent",
        description: `${emp?.name ?? "The employee"} gets a notification on their phone.`,
      });
      if (text) {
        setReply("");
        setReplyOpen(false);
      }
    } catch (err: any) {
      toast({ title: "Could not save", description: err?.message ?? "Please try again.", variant: "destructive" });
    }
  };

  return (
    <li
      className={`rounded-2xl border bg-white p-4 transition-colors ${done ? "border-green-100 bg-green-50/30" : "hover:border-slate-300"}`}
      data-testid="enquiry-row"
      data-status={item.status}
    >
      <div className="flex items-start gap-3">
        {/* the to-do tick: Done / back to Pending */}
        <button
          type="button"
          disabled={readOnly || update.isPending}
          onClick={() => void save(done ? "pending" : "done")}
          className="mt-0.5 shrink-0 rounded-full text-gray-300 transition-colors hover:text-green-600 disabled:cursor-not-allowed"
          aria-label={done ? "Mark as not done" : "Mark as done"}
          title={done ? "Mark as not done" : "Mark as done"}
          data-testid="enquiry-tick"
        >
          {done ? <CircleCheckBig size={22} className="text-green-600" /> : <Circle size={22} />}
        </button>

        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <p className={`text-sm font-bold text-gray-900 ${done ? "text-gray-500 line-through" : ""}`}>{item.subject}</p>
              <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
                <span className={`rounded-full px-2 py-0.5 font-semibold ${CATEGORY_TONE[item.category] ?? CATEGORY_TONE.other}`}>
                  {item.categoryLabel}
                </span>
                <span className="text-gray-500" title={when(item.createdAt)}>
                  Raised {when(item.createdAt)} · {ago(item.createdAt)}
                </span>
              </div>
            </div>
            {/* status switch */}
            <div className="flex overflow-hidden rounded-lg border" role="group" aria-label="Status">
              {(Object.keys(STATUS_META) as EnquiryStatus[]).map((s) => {
                const meta = STATUS_META[s];
                const active = item.status === s;
                const Icon = meta.icon;
                return (
                  <button
                    key={s}
                    type="button"
                    disabled={readOnly || active || update.isPending}
                    onClick={() => void save(s)}
                    className={`flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                      active ? meta.tone : "bg-white text-gray-500 hover:bg-slate-50"
                    } disabled:cursor-default`}
                    aria-pressed={active}
                    data-testid={`enquiry-status-${s}`}
                  >
                    <Icon size={12} /> {meta.label}
                  </button>
                );
              })}
            </div>
          </div>

          {emp && (
            <div className="flex items-center gap-2">
              {emp.photoUrl ? (
                <img src={emp.photoUrl} alt="" className="h-7 w-7 rounded-full object-cover" />
              ) : (
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-indigo-50 text-[10px] font-bold text-indigo-700">
                  {initials(emp.name)}
                </span>
              )}
              <p className="text-xs text-gray-600">
                <b className="font-semibold text-gray-900">{emp.name}</b> · {emp.employeeCode}
                {emp.designation || emp.department ? ` · ${[emp.designation, emp.department].filter(Boolean).join(", ")}` : ""}
                {emp.branch ? ` · ${emp.branch}` : ""}
              </p>
            </div>
          )}

          {!!item.message && (
            <p className="whitespace-pre-wrap rounded-xl bg-slate-50 px-3 py-2 text-sm text-gray-700">{item.message}</p>
          )}

          {!!item.hrReply && (
            <div className="rounded-xl border border-indigo-100 bg-indigo-50/50 px-3 py-2">
              <p className="text-[11px] font-semibold text-indigo-700">
                Reply{item.handledBy ? ` by ${item.handledBy}` : ""}
                {item.handledAt ? ` · ${when(item.handledAt)}` : ""}
              </p>
              <p className="mt-0.5 whitespace-pre-wrap text-sm text-gray-800">{item.hrReply}</p>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {!readOnly && (
              <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs" onClick={() => setReplyOpen((v) => !v)}>
                <Reply size={13} /> {item.hrReply ? "Reply again" : "Reply"}
              </Button>
            )}
            {item.history.length > 0 && (
              <Button variant="ghost" size="sm" className="h-8 gap-1.5 text-xs" onClick={() => setHistoryOpen((v) => !v)}>
                <History size={13} /> History ({item.history.length}) {historyOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              </Button>
            )}
          </div>

          {replyOpen && !readOnly && (
            <div className="space-y-2" data-testid="enquiry-reply">
              <Textarea
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                maxLength={2000}
                rows={3}
                placeholder="Write the answer the employee will read in the app..."
              />
              <div className="flex flex-wrap gap-2">
                <Button size="sm" className="h-8 gap-1.5 text-xs" disabled={!reply.trim() || update.isPending} onClick={() => void save(undefined, reply)}>
                  <Send size={13} /> Send reply
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 gap-1.5 border-green-300 text-xs text-green-700"
                  disabled={!reply.trim() || update.isPending}
                  onClick={() => void save("done", reply)}
                >
                  <CheckCircle2 size={13} /> Reply & mark Done
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 gap-1.5 text-xs"
                  disabled={!reply.trim() || update.isPending}
                  onClick={() => void save("on_hold", reply)}
                >
                  <PauseCircle size={13} /> Reply & put On Hold
                </Button>
              </div>
            </div>
          )}

          {historyOpen && (
            <ol className="space-y-1 border-l-2 border-slate-200 pl-3 text-xs text-gray-600">
              {item.history.map((h, i) => (
                <li key={i}>
                  <b className="font-semibold text-gray-800">{STATUS_META[h.status]?.label ?? h.status}</b> by {h.by} · {when(h.at)}
                  {h.reply ? <span className="block text-gray-500">&ldquo;{h.reply}&rdquo;</span> : null}
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </li>
  );
}

export default function Enquiries() {
  const { user } = useAuth();
  const readOnly = isRouteViewOnly(user, "/hr/enquiries", "requests");
  const [view, setView] = useState<View>("pending");
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("");
  const query = useEnquiries({ status: view, q, category });
  const counts = query.data?.counts;
  const items = query.data?.items ?? [];

  const tabs = useMemo(
    () => [
      { value: "pending", label: "Pending", count: counts?.pending },
      { value: "on_hold", label: "On Hold", count: counts?.onHold },
      { value: "done", label: "Done", count: counts?.done },
      { value: "all", label: "All", count: counts?.all },
    ],
    [counts],
  );

  return (
    <HrLayout>
      <div className="space-y-5" data-testid="enquiries-page">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-2xl font-black text-gray-900">
              <MessageCircleQuestion size={22} className="text-indigo-500" />
              Enquiries
              {!!counts?.pending && <Badge className="bg-amber-500 text-xs text-white">{counts.pending} pending</Badge>}
            </h2>
            <p className="text-sm text-muted-foreground">
              Questions employees raised from the mobile app. Work through them like a to-do list: reply, put On Hold, or tick
              them Done. The employee gets a notification on their phone for every change.
            </p>
          </div>
          <RefreshButton />
        </div>

        {readOnly && (
          <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800">
            View only: your role can see the enquiries but not change them.
          </p>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <PillTabs size="sm" baseColor="#4f46e5" items={tabs} value={view} onChange={(v) => setView(v as View)} />
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="h-9 rounded-md border bg-white px-2 text-sm"
              aria-label="Filter by topic"
            >
              <option value="">All topics</option>
              <option value="general">General question</option>
              <option value="salary">Salary & deductions</option>
              <option value="attendance">Attendance & shift</option>
              <option value="leave">Leave & holidays</option>
              <option value="documents">Documents & letters</option>
              <option value="other">Something else</option>
            </select>
            <div className="relative">
              <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search name, code or text"
                className="h-9 w-64 pl-8 text-sm"
                aria-label="Search enquiries"
              />
            </div>
          </div>
        </div>

        {query.isLoading ? (
          <div className="space-y-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-28 rounded-2xl" />
            ))}
          </div>
        ) : query.isError && !query.data ? (
          <p className="rounded-2xl bg-white p-6 text-center text-sm text-red-600">
            Could not load the enquiries. Use Refresh to try again.
          </p>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-2xl bg-white p-10 text-center text-sm text-muted-foreground" data-testid="enquiries-empty">
            <Inbox size={28} className="text-gray-300" />
            {view === "pending" ? "Nothing waiting. Every enquiry has been handled." : "No enquiries here."}
          </div>
        ) : (
          <ul className="space-y-3">
            {items.map((item) => (
              <EnquiryRow key={item.id} item={item} readOnly={readOnly} />
            ))}
          </ul>
        )}
      </div>
    </HrLayout>
  );
}

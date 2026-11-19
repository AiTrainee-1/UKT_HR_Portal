import { Eye, EyeOff, LogOut, Mail, MessageCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { VisitorVisit } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import type { DataColumn } from "@/pages/hr/outpass-visitors/kit/DataTable";
import { StatusChip, toneOf } from "@/pages/hr/outpass-visitors/kit/StatusChip";
import { WhenCell } from "@/pages/hr/outpass-visitors/kit/WhenCell";
import { fmtDateTime, NONE } from "@/pages/hr/outpass-visitors/kit/fmt";
import { canCheckOut, checkedInByLabel, hostName, maskAadhaar } from "@/pages/hr/outpass-visitors/visitors/logic";

/**
 * The desk's visit table columns (today's list and the records view): the visitor, the Aadhaar (masked, a tap shows it),
 * whom they came to meet, the purpose, in and out (a Check out button while they are inside), the status, whether the
 * host was told, and (records) how they were checked in. One line a row; the details truncate with a tooltip.
 */
export function visitColumns({
  now,
  shownAadhaar,
  onToggleAadhaar,
  onCheckOut,
  withCheckedInBy = false,
}: {
  now: Date;
  shownAadhaar: number | null;
  onToggleAadhaar: (id: number) => void;
  onCheckOut: (visit: VisitorVisit) => void;
  withCheckedInBy?: boolean;
}): DataColumn<VisitorVisit>[] {
  const columns: DataColumn<VisitorVisit>[] = [
    {
      key: "visitor",
      header: "Visitor",
      cell: (v) => (
        <span className="block min-w-0">
          <span className="block truncate font-medium text-slate-900">{v.name}</span>
          <span className="block truncate text-[11px] text-slate-500">
            {[v.phone, v.company].filter(Boolean).join(" · ")}
          </span>
        </span>
      ),
      text: (v) => [v.name, v.phone, v.company].filter(Boolean).join(" · "),
      minWidth: 150,
      maxWidth: 220,
    },
    {
      key: "aadhaar",
      header: "Aadhaar",
      truncate: false,
      hideOnPhone: true,
      cell: (v) =>
        v.aadhaarLast4 ? (
          <button
            type="button"
            onClick={() => onToggleAadhaar(v.id)}
            className="inline-flex h-8 items-center gap-1.5 rounded-md px-1 font-mono text-xs text-slate-600 hover:text-slate-900"
            aria-label={shownAadhaar === v.id ? `Hide the Aadhaar of ${v.name}` : `Show the Aadhaar of ${v.name}`}
          >
            {shownAadhaar === v.id && v.aadhaar ? v.aadhaar : maskAadhaar(v.aadhaarLast4)}
            {shownAadhaar === v.id ? <EyeOff size={12} /> : <Eye size={12} />}
          </button>
        ) : (
          <span className="text-slate-400">{NONE}</span>
        ),
    },
    {
      key: "host",
      header: "Meeting",
      cell: (v) => (
        <span className="block min-w-0">
          <span className="block truncate font-medium text-slate-900">{hostName(v)}</span>
          {v.meetingEmployee?.department && (
            <span className="block truncate text-[11px] text-slate-500">{v.meetingEmployee.department}</span>
          )}
        </span>
      ),
      text: (v) => hostName(v),
      maxWidth: 200,
    },
    {
      key: "purpose",
      header: "Purpose",
      cell: (v) => v.purpose,
      text: (v) => v.purpose,
      maxWidth: 180,
      hideOnPhone: true,
    },
    { key: "in", header: "In", truncate: false, cell: (v) => <WhenCell value={v.visitedAt} now={now} /> },
    {
      key: "out",
      header: "Out",
      truncate: false,
      cell: (v) =>
        v.checkedOutAt ? (
          <WhenCell value={v.checkedOutAt} now={now} />
        ) : canCheckOut(v) ? (
          <Button
            type="button"
            size="sm"
            className="h-11 gap-1 px-3 sm:h-9"
            onClick={() => onCheckOut(v)}
            aria-label={`Check out ${v.name}`}
            data-testid={`reception-check-out-${v.id}`}
          >
            <LogOut size={14} aria-hidden="true" /> Check out
          </Button>
        ) : (
          <span className="text-slate-400">{NONE}</span>
        ),
    },
    {
      key: "status",
      header: "Status",
      truncate: false,
      cell: (v) => <StatusChip tone={toneOf(v.status)}>{v.statusLabel}</StatusChip>,
    },
    {
      key: "told",
      header: "Host told",
      truncate: false,
      hideOnPhone: true,
      cell: (v) =>
        v.meetingEmployee ? (
          <span className="flex items-center gap-1">
            <Told icon={Mail} label="Email" at={v.notifiedEmailAt} />
            <Told icon={MessageCircle} label="WhatsApp" at={v.notifiedWhatsappAt} />
          </span>
        ) : (
          <span className="text-slate-400">{NONE}</span>
        ),
    },
  ];
  if (withCheckedInBy) {
    columns.push({
      key: "source",
      header: "Checked in by",
      cell: (v) => checkedInByLabel(v),
      text: (v) => checkedInByLabel(v),
      maxWidth: 200,
      hideOnPhone: true,
    });
  }
  return columns;
}

function Told({ icon: Icon, label, at }: { icon: typeof Mail; label: string; at: string | null }) {
  return (
    <span
      className={cn(
        "inline-flex size-7 items-center justify-center rounded-full border",
        at ? "border-teal-200 bg-teal-50 text-teal-700" : "border-slate-200 bg-slate-50 text-slate-400",
      )}
      title={at ? `${label} sent ${fmtDateTime(at)}` : `${label} not sent`}
    >
      <Icon size={13} aria-hidden="true" />
      <span className="sr-only">{at ? `${label} sent` : `${label} not sent`}</span>
    </span>
  );
}

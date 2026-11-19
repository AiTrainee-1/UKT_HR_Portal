import { useEffect, useState } from "react";
import { Eye, EyeOff, LogOut, Mail, MessageCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useVisitorVisit, type VisitorVisit } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { DetailDrawer, DrawerFields, DrawerSection, StatusChip, fmtDateTime, fmtMinutes, toneOf } from "../kit";
import {
  canCheckOut as visitCanCheckOut,
  checkedInByLabel,
  checkedOutByLabel,
  groupAadhaar,
  hostName,
  isLongStay,
  maskAadhaar,
} from "./logic";

/**
 * One visit in the panel from the right: the visitor (phone in full, Aadhaar masked with Show / Hide), the visit (whom, why,
 * when in and out, who checked them in and out, time inside, notes), whether the host was told, and the visitor's history
 * (a past visit opens in the same panel). The Check out button is there while the visitor is inside, for an edit role.
 */
export function VisitDrawer({
  visitId,
  onClose,
  onOpenVisit,
  onCheckOut,
  canEdit,
}: {
  visitId: number | null;
  onClose: () => void;
  onOpenVisit: (id: number) => void;
  onCheckOut: (visit: VisitorVisit) => void;
  canEdit: boolean;
}) {
  const { data, isLoading, isError, refetch } = useVisitorVisit(visitId);
  const [aadhaarShown, setAadhaarShown] = useState(false);
  useEffect(() => setAadhaarShown(false), [visitId]);

  const visit = data && data.id === visitId ? data : undefined;
  const history = visit?.history ?? [];
  const canCheckOut = canEdit && !!visit && visitCanCheckOut(visit);

  return (
    <DetailDrawer
      open={visitId !== null}
      onOpenChange={(open) => !open && onClose()}
      title={visit?.name ?? "Visit"}
      subtitle={visit ? [visit.company, `Visit ${visit.visitCount}`].filter(Boolean).join(" · ") : undefined}
      testId="visit-drawer"
      footer={
        <>
          <Button type="button" variant="outline" className="h-11 sm:h-9" onClick={onClose}>
            Close
          </Button>
          {canCheckOut && visit && (
            <Button
              type="button"
              className="h-11 gap-1.5 sm:h-9"
              onClick={() => onCheckOut(visit)}
              data-testid="visit-drawer-check-out"
            >
              <LogOut size={15} aria-hidden="true" /> Check out
            </Button>
          )}
        </>
      }
    >
      {isError && !visit ? (
        <div role="alert" className="space-y-2 text-sm text-slate-600">
          <p>Could not load this visit.</p>
          <Button type="button" variant="outline" size="sm" onClick={() => refetch()}>
            Try again
          </Button>
        </div>
      ) : isLoading || !visit ? (
        <div className="space-y-3" aria-busy="true">
          <span className="sr-only" role="status">
            Loading…
          </span>
          <Skeleton className="h-6 w-32" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2" data-testid="visit-drawer-status">
            <StatusChip tone={toneOf(visit.status)}>{visit.statusLabel}</StatusChip>
            {isLongStay(visit) && <StatusChip tone="rose">Inside over 2 h</StatusChip>}
            {visit.minutesInside !== null && (
              <span className="text-sm text-slate-600">
                {visit.status === "inside" ? "Inside for " : "Stayed "}
                {fmtMinutes(visit.minutesInside)}
              </span>
            )}
          </div>

          <DrawerSection title="Visitor">
            <DrawerFields
              items={[
                { label: "Phone", value: <span className="tabular-nums">{visit.phone}</span> },
                {
                  label: "Aadhaar",
                  value: visit.aadhaarLast4 ? (
                    <span className="inline-flex items-center gap-1.5">
                      <span className="font-mono tabular-nums" data-testid="visit-drawer-aadhaar">
                        {aadhaarShown && visit.aadhaar ? groupAadhaar(visit.aadhaar) : maskAadhaar(visit.aadhaarLast4)}
                      </span>
                      <button
                        type="button"
                        onClick={() => setAadhaarShown((v) => !v)}
                        className="inline-flex size-8 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-800"
                        aria-label={aadhaarShown ? "Hide the Aadhaar number" : "Show the Aadhaar number"}
                        data-testid="visit-drawer-aadhaar-toggle"
                      >
                        {aadhaarShown ? <EyeOff size={15} /> : <Eye size={15} />}
                      </button>
                    </span>
                  ) : null,
                },
                { label: "Company", value: visit.company },
                { label: "People", value: String(visit.peopleCount) },
                { label: "Vehicle", value: visit.vehicleNumber },
                { label: "ID proof", value: visit.idProofType },
                { label: "Badge", value: visit.badgeNumber },
                { label: "Visits so far", value: String(visit.visitCount) },
              ]}
            />
          </DrawerSection>

          <DrawerSection title="Visit">
            <DrawerFields
              items={[
                {
                  label: "Meeting",
                  value: visit.meetingEmployee
                    ? `${visit.meetingEmployee.name}${visit.meetingEmployee.department ? ` (${visit.meetingEmployee.department})` : ""}`
                    : visit.whomToMeet,
                  wide: true,
                },
                { label: "Purpose", value: visit.purpose, wide: true },
                { label: "Reason", value: visit.whyCame, wide: true },
                { label: "Checked in", value: fmtDateTime(visit.visitedAt, { year: true }) },
                { label: "Checked in by", value: checkedInByLabel(visit) },
                {
                  label: "Checked out",
                  value: visit.checkedOutAt
                    ? fmtDateTime(visit.checkedOutAt, { year: true })
                    : visit.status === "inside"
                      ? "Not yet"
                      : "Left without check-out",
                },
                { label: "Checked out by", value: checkedOutByLabel(visit) },
                { label: "Branch", value: visit.branchName },
                { label: "Notes", value: visit.notes, wide: true },
              ]}
            />
          </DrawerSection>

          {visit.meetingEmployee && (
            <DrawerSection title="Host told">
              <div className="flex flex-wrap gap-2 text-sm">
                <NotifiedChip icon={Mail} label="Email" at={visit.notifiedEmailAt} />
                <NotifiedChip icon={MessageCircle} label="WhatsApp" at={visit.notifiedWhatsappAt} />
              </div>
            </DrawerSection>
          )}

          <DrawerSection
            title={`Visit history (${history.length})`}
            actions={history.length >= 20 ? <span className="text-xs text-slate-500">The latest 20</span> : undefined}
            testId="visit-drawer-history"
          >
            <ul className="space-y-1.5">
              {history.map((h) => {
                const current = h.id === visit.id;
                return (
                  <li key={h.id}>
                    <button
                      type="button"
                      onClick={() => !current && onOpenVisit(h.id)}
                      aria-current={current ? "true" : undefined}
                      className={cn(
                        "flex w-full min-h-11 items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left text-sm",
                        current ? "border-primary/40 bg-primary/5" : "border-slate-200 hover:bg-slate-50",
                      )}
                    >
                      <span className="min-w-0">
                        <span className="block font-medium text-slate-900">
                          {fmtDateTime(h.visitedAt, { year: true })}
                          {current && <span className="ml-1.5 text-xs font-normal text-slate-500">(this visit)</span>}
                        </span>
                        <span className="block truncate text-xs text-slate-500">
                          Meeting {hostName(h)} · {h.purpose}
                        </span>
                      </span>
                      <span className="flex shrink-0 flex-col items-end gap-0.5">
                        <span className="text-xs tabular-nums text-slate-600">
                          {h.minutesInside !== null ? fmtMinutes(h.minutesInside) : ""}
                        </span>
                        <StatusChip tone={toneOf(h.status)}>{h.statusLabel}</StatusChip>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </DrawerSection>
        </>
      )}
    </DetailDrawer>
  );
}

function NotifiedChip({ icon: Icon, label, at }: { icon: typeof Mail; label: string; at: string | null }) {
  return (
    <StatusChip tone={at ? "teal" : "slate"} title={at ? `${label} sent ${fmtDateTime(at)}` : `${label} not sent`}>
      <Icon size={12} aria-hidden="true" /> {label} {at ? "sent" : "not sent"}
    </StatusChip>
  );
}

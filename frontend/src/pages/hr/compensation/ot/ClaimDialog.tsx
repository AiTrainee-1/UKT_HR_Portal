import { useMemo, useState } from "react";
import { Loader2, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useRaiseOtClaims, type OtClaimKind, type OvertimeRow, type ShiftsValue } from "@/lib/api-client/custom-hooks";
import { formatDuration } from "@/pages/hr/settings/compensation/time";
import { dateShort, shiftsText } from "../logic";
import { ErrorNotice, Field, Notice, PersonCell, ShiftsPicker, useSingleFlight } from "../ui";
import {
  OT_CLAIM_REASON_MAX,
  checkOtClaim,
  claimEffectText,
  claimFailure,
  claimRequests,
  initialClaimRows,
  type ClaimRow,
} from "./ot-logic";

// "Claim for employee": HR raises the claim of an OT record on the employee's behalf (the employee can do the same in the
// apps). It goes to the employee's Department Head; nothing is given until they approve. Type 1 asks for the record's
// allowance on the next working day; Type 2 asks for shifts (starting at the quarters-rule credit) for the balance. A
// request carries one OT date, so records of several dates are sent one date at a time: a date the server refuses stays in
// the dialog with the reason, the others are claimed.

const KIND_TEXT: Record<OtClaimKind, { title: string; what: string }> = {
  ot_allowance: {
    title: "Claim the late-in allowance",
    what: "Once the Department Head approves, the allowance is applied to the next working day after the OT date: a first punch inside it is not marked Late.",
  },
  ot_shift: {
    title: "Claim the OT credit",
    what: "Once the Department Head approves, the shifts are added to the employee's compensation balance, to use on another day. A claimed record cannot also be paid.",
  },
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: OtClaimKind;
  /** The records to claim (only claimable ones). */
  rows: OvertimeRow[];
  /** Called with the keys of the records that were claimed. */
  onClaimed: (keys: string[]) => void;
};

export function ClaimDialog({ open, onOpenChange, kind, rows, onClaimed }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-3xl overflow-y-auto" data-testid="claim-dialog">
        {open && <ClaimForm kind={kind} rows={rows} onOpenChange={onOpenChange} onClaimed={onClaimed} />}
      </DialogContent>
    </Dialog>
  );
}

function ClaimForm({ kind, rows: chosen, onOpenChange, onClaimed }: Omit<Props, "open">) {
  const { toast } = useToast();
  const raise = useRaiseOtClaims();
  const [rows, setRows] = useState<ClaimRow[]>(() => initialClaimRows(chosen));
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const check = useMemo(() => checkOtClaim(kind, rows, reason), [kind, rows, reason]);
  const once = useSingleFlight();

  const change = (key: string, shifts: ShiftsValue) =>
    setRows((list) => list.map((r) => (r.key === key ? { ...r, shifts, problem: null } : r)));

  const submit = () =>
    once(async () => {
      setTouched(true);
      if (!check.ok || raise.isPending) return;
      setError(null);
      const claimed: string[] = [];
      const refused = new Map<string, string>();
      let firstMessage: string | null = null;
      for (const body of claimRequests(kind, rows, reason)) {
        const keys = rows.filter((r) => r.date === body.date).map((r) => r.key);
        try {
          await raise.mutateAsync(body);
          claimed.push(...keys);
        } catch (err) {
          const failure = claimFailure(err);
          firstMessage ??= failure.message;
          for (const row of rows.filter((r) => r.date === body.date)) {
            const named = failure.problems.find((p) => p.employeeId === row.employeeId);
            // all-or-nothing: a request the server refused made no claim, so every row of it stays
            refused.set(row.key, named ? named.error : failure.message);
          }
        }
      }
      if (claimed.length > 0) onClaimed(claimed);
      if (refused.size === 0) {
        toast({
          title: `Sent ${claimed.length} ${claimed.length === 1 ? "claim" : "claims"} to the Department Head`,
          description: "Nothing is given until the Department Head approves. The list shows each claim's status.",
        });
        onOpenChange(false);
        return;
      }
      if (claimed.length > 0) {
        toast({
          title: `Sent ${claimed.length}; ${refused.size} could not be claimed`,
          description: "The records that could not be claimed stay open here with the reason.",
          variant: "destructive",
        });
      }
      setRows((list) =>
        list.filter((r) => refused.has(r.key)).map((r) => ({ ...r, problem: refused.get(r.key) ?? null })),
      );
      setError(firstMessage);
    });

  const text = KIND_TEXT[kind];
  const total = rows.length;
  return (
    <>
      <DialogHeader>
        <DialogTitle>{text.title}</DialogTitle>
        <DialogDescription>
          HR claims it for the employee; it goes to the employee&apos;s Department Head to approve. {text.what} {total}{" "}
          {total === 1 ? "record" : "records"}.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-4">
        <div className="overflow-x-auto rounded-xl border border-slate-200">
          <table className="w-full min-w-[640px] text-sm" data-testid="claim-table">
            <thead className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-3 py-2.5">Employee</th>
                <th className="px-3 py-2.5">OT date</th>
                <th className="px-3 py-2.5">Extra time</th>
                <th className="px-3 py-2.5">{kind === "ot_allowance" ? "Allowance" : "Shifts"}</th>
                <th className="px-3 py-2.5">Once approved</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row) => {
                const id = `${row.employeeCode}-${row.date}`;
                const problem = row.problem ?? check.problems[row.key] ?? null;
                return (
                  <tr key={row.key} className="align-top" data-testid={`claim-row-${id}`}>
                    <td className="px-3 py-3">
                      <PersonCell name={row.employeeName} code={row.employeeCode} />
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 text-gray-700">{dateShort(row.date)}</td>
                    <td className="whitespace-nowrap px-3 py-3 text-amber-700">{formatDuration(row.otMinutes)}</td>
                    <td className="px-3 py-3">
                      {kind === "ot_allowance" ? (
                        <span className="font-semibold">{row.allowanceMinutes} min</span>
                      ) : (
                        <>
                          <ShiftsPicker
                            value={row.shifts}
                            suggested={row.credit}
                            label={`Shifts for ${row.employeeName} on ${dateShort(row.date)}`}
                            onChange={(shifts) => change(row.key, shifts)}
                            testId={`claim-shifts-${id}`}
                          />
                          <p className="mt-1 text-[11px] text-muted-foreground">
                            {row.credit ? `Credit by the quarters rule: ${shiftsText(row.credit)}` : "Below a quarter"}
                          </p>
                        </>
                      )}
                    </td>
                    <td className="px-3 py-3 text-xs leading-snug text-gray-600">
                      {claimEffectText(kind, row)}
                      {problem && (
                        <p role="alert" className="mt-1 font-medium text-red-600" data-testid={`claim-problem-${id}`}>
                          {problem}
                        </p>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <Field
          label="Reason"
          htmlFor="ot-claim-reason"
          problem={touched ? check.reasonProblem : null}
          hint={`${reason.trim().length} / ${OT_CLAIM_REASON_MAX}. What was the extra work? The Department Head reads it before deciding.`}
        >
          <Textarea
            id="ot-claim-reason"
            rows={3}
            value={reason}
            maxLength={OT_CLAIM_REASON_MAX + 50}
            onChange={(e) => setReason(e.target.value)}
            onBlur={() => setTouched(true)}
            data-testid="claim-reason"
          />
        </Field>

        <Notice accent="slate" testId="claim-summary">
          <p>
            Each employee&apos;s Department Head decides their claims (the approver is set in User Management, Approval
            Workflow Control). The employee sees the claim in the app and on the web.
          </p>
        </Notice>
        {error && <ErrorNotice testId="claim-error">{error}</ErrorNotice>}
      </div>

      <DialogFooter className="gap-2">
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button
          type="button"
          onClick={() => void submit()}
          disabled={raise.isPending || total === 0}
          title={check.ok ? undefined : (check.first ?? undefined)}
          data-testid="claim-submit"
        >
          {raise.isPending ? <Loader2 size={14} className="mr-2 animate-spin" /> : <Send size={14} className="mr-2" />}
          Send {total === 1 ? "claim" : `${total} claims`} to the HOD
        </Button>
      </DialogFooter>
    </>
  );
}

// compensation-ot-claims: HR claims an OT record for an employee (OT Detection -> Type 1 / Type 2). The claim joins the one
// compensation claim workflow (the same table as Sunday / holiday work): it goes to the employee's Department Head, and only
// an approved claim gives anything. Type 1 (`ot_allowance`): the allowance is applied to the next working day after the OT
// date. Type 2 (`ot_shift`): the shifts are credited to the employee's compensation balance, to use on another day.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "../custom-fetch";
import { invalidateCompensation, type ShiftsValue } from "./compensation";

/** The two claim kinds an OT record can be claimed as. */
export type OtClaimKind = "ot_allowance" | "ot_shift";

/** One employee's record in a claim request: the OT record, and for Type 2 the shifts claimed. */
export type OtClaimItem = { employeeId: number; overtimeRecordId: number; shifts?: ShiftsValue };

/** POST /api/compensation/claims (HR on behalf). One date per request: every item is an OT record of that date. */
export type RaiseOtClaimsBody = { kind: OtClaimKind; date: string; reason: string; items: OtClaimItem[] };

/** A claim the server made (only the keys the OT page reads; the server sends the whole claim). */
export type RaisedOtClaim = {
  id: number;
  kind: string;
  status: string;
  employeeId?: number;
  overtimeRecordId?: number | null;
};

export type RaiseOtClaimsResult = { created: number; claims: RaisedOtClaim[]; warnings: string[] };

/**
 * HR claims OT records for employees. The request is all-or-nothing (like raising holiday work): a refusal is a 400 / 403 /
 * 409 with `{ error, code }` and, for a request of several employees, `problems: [{ employeeId, error }]`. Every
 * Compensation list is marked stale on success, so the OT list shows the claims at once.
 */
export const useRaiseOtClaims = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: RaiseOtClaimsBody) =>
      customFetch<RaiseOtClaimsResult>("/api/compensation/claims", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => invalidateCompensation(queryClient),
  });
};

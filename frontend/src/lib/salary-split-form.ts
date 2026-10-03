// The salary split as a piece of the Add / Edit Employee forms (zod + react-hook-form glue for lib/salary-split.ts).
import { z } from "zod";
import { checkSplit, type SplitValues } from "./salary-split";

export const splitSchema = z.object({
  basic: z.string(),
  da: z.string(),
  retainingAllowance: z.string(),
  otherAllowance: z.string(),
  petrolAllowance: z.string(),
  hra: z.string(),
  specialAllowance: z.string(),
  ca: z.string(),
});

/** Add to a form's superRefine: a staff employee's salary must come with a valid 50% + 50% split. Only speaks when a
 *  salary amount has been entered (the amount's own "required" message covers the rest). */
export function addSplitIssue(ctx: z.RefinementCtx, salaryAmount: string | undefined, split: SplitValues) {
  if (!salaryAmount || !(Number(salaryAmount) > 0)) return;
  const check = checkSplit(salaryAmount, split);
  if (!check.ok)
    ctx.addIssue({ code: "custom", path: ["split"], message: check.message ?? "The salary split is not valid" });
}

/** The message react-hook-form holds for the split after a refused Save (its shape differs by resolver version). */
export function splitErrorMessage(errors: unknown): string | undefined {
  const e = (errors as { split?: { message?: unknown; root?: { message?: unknown } } } | undefined)?.split;
  const message = e?.message ?? e?.root?.message;
  return typeof message === "string" ? message : undefined;
}

import { useListBranches } from "@/lib/api-client/custom-hooks";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/** The value of "every branch" in the select (an empty address value means the same). */
export const ALL_BRANCHES = "all";

/** The branch id a page passes to the statement ("" / "all" / junk = every branch). */
export function branchIdOf(value: string | null | undefined): number | undefined {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : undefined;
}

/**
 * "All branches" or one branch: the printed Salary Statement is per branch ("U.K TEXTILES - H.O"), so the statement's
 * toolbar can narrow it to one. Shows nothing for a login that sees a single branch (a branch-scoped HR user, or a company
 * with one branch): there is nothing to choose. Reads the branches the login may see, so it never offers another branch's.
 */
export function BranchFilter({
  value,
  onChange,
  testId = "branch-filter",
}: {
  value: string;
  onChange: (value: string) => void;
  testId?: string;
}) {
  const branches = useListBranches();
  const list = branches.data ?? [];
  if (list.length < 2) return null;
  const current = branchIdOf(value);
  const selected = current && list.some((b) => b.id === current) ? String(current) : ALL_BRANCHES;
  return (
    <Select value={selected} onValueChange={(v) => onChange(v === ALL_BRANCHES ? "" : v)}>
      <SelectTrigger className="h-9 w-[11.5rem] text-sm" aria-label="Branch" data-testid={testId}>
        <SelectValue placeholder="All branches" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL_BRANCHES}>All branches</SelectItem>
        {list.map((b) => (
          <SelectItem key={b.id} value={String(b.id)}>
            {b.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

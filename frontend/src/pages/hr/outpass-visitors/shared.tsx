import { useEffect, useState } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useListBranches, getListBranchesQueryKey } from "@/lib/api-client/custom-hooks";

export const PAGE_SIZE = 20;

// ── Branch picker (unscoped/super-admin only) ────────────────────────────

export function useSelectedBranch(isBranchScoped: boolean) {
  const { data: branches } = useListBranches({ enabled: !isBranchScoped, queryKey: getListBranchesQueryKey() });
  const [branchId, setBranchId] = useState<string>("");
  useEffect(() => {
    if (!isBranchScoped && !branchId && branches && branches.length > 0) {
      setBranchId(String(branches[0].id));
    }
  }, [isBranchScoped, branches, branchId]);
  return { branches, branchId, setBranchId };
}

export function BranchPicker({
  branches,
  branchId,
  setBranchId,
}: {
  branches: { id: number; name: string }[] | undefined;
  branchId: string;
  setBranchId: (v: string) => void;
}) {
  return (
    <Select value={branchId} onValueChange={setBranchId}>
      <SelectTrigger className="w-full sm:w-52">
        <SelectValue placeholder="Select branch" />
      </SelectTrigger>
      <SelectContent>
        {branches?.map((b) => (
          <SelectItem key={b.id} value={String(b.id)}>
            {b.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

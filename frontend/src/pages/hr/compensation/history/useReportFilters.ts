import { useMemo } from "react";
import { useListDepartments } from "@/lib/api-client";
import { getListBranchesQueryKey, useListBranches, type ReportType } from "@/lib/api-client/custom-hooks";
import { todayIst, type CompensationUrl } from "../logic";
import { isPeriod } from "../period";
import { isReportType } from "./history-logic";

/**
 * The filters History and Reports share, read from the query string: Today / Week / Month, a date inside it, a department
 * and (for a login that is not tied to one branch) a branch. `withType` adds the type filter, which only Reports has: on
 * History the type is the subtab. Also the departments and branches the pickers offer, and their names (the Excel file
 * says which filters it was made with).
 */
export function useReportFilters(url: CompensationUrl, isBranchScoped: boolean, withType = false) {
  const today = useMemo(() => todayIst(), []);
  const period = isPeriod(url.period) ? url.period : "today";
  const date = url.date || today;
  const type: ReportType | undefined = withType && isReportType(url.type) ? url.type : undefined;
  const departmentId = Number(url.dept) > 0 ? Number(url.dept) : undefined;
  const branchId = !isBranchScoped && Number(url.branch) > 0 ? Number(url.branch) : undefined;

  const { data: departments } = useListDepartments();
  const { data: branches } = useListBranches({ enabled: !isBranchScoped, queryKey: getListBranchesQueryKey() });

  const departmentName = departments?.find((d) => d.id === departmentId)?.name ?? null;
  const branchName = branches?.find((b) => b.id === branchId)?.name ?? null;

  return {
    today,
    period,
    date,
    type,
    departmentId,
    branchId,
    departments,
    branches,
    departmentName,
    branchName,
    /** How many of the optional filters (type, department, branch) are on. */
    filtersOn: (type ? 1 : 0) + (departmentId ? 1 : 0) + (branchId ? 1 : 0),
  };
}

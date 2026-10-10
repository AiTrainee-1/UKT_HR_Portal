import { useState } from "react";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useAssignEmployee, useSearchEmployees, type Employee } from "@/lib/api-client";
import { errorMessage, useRefreshOrg } from "./api";
import { PersonAvatar, TypeChip } from "./parts";

type Target = { kind: "department" | "designation"; id: number; name: string };

/** Search an active employee by name, code or phone and give them this department / designation. */
export default function AssignDialog({ target, onClose }: { target: Target; onClose: () => void }) {
  const { toast } = useToast();
  const refresh = useRefreshOrg();
  const [query, setQuery] = useState("");
  const { data: results, isFetching } = useSearchEmployees(query);
  const assignMutation = useAssignEmployee();
  const isDept = target.kind === "department";

  const assign = async (emp: Employee) => {
    try {
      await assignMutation.mutateAsync(
        isDept ? { id: emp.id, departmentId: target.id } : { id: emp.id, designationId: target.id },
      );
      await refresh();
      toast({ title: `${emp.firstName} ${emp.lastName} assigned to ${target.name}` });
    } catch (err) {
      toast({ title: "Failed to assign employee", description: errorMessage(err), variant: "destructive" });
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md" data-testid="assign-dialog">
        <DialogHeader>
          <DialogTitle>Assign employee to {target.name}</DialogTitle>
          <DialogDescription>
            Search an active employee. Their {isDept ? "department" : "designation"} changes straight away.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-1">
          <div className="space-y-1.5">
            <Label htmlFor="assign-search">Employee name, code or phone</Label>
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <Input
                id="assign-search"
                autoFocus
                className="pl-9"
                placeholder="e.g. EMP001 or 9876543210"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                data-testid="assign-search"
              />
            </div>
            {query.trim().length < 2 && <p className="text-xs text-muted-foreground">Type at least 2 characters.</p>}
          </div>

          <div className="max-h-64 space-y-2 overflow-y-auto">
            {isFetching && <p className="py-4 text-center text-xs text-muted-foreground">Searching…</p>}
            {!isFetching && query.trim().length >= 2 && (results ?? []).length === 0 && (
              <p className="py-4 text-center text-xs text-muted-foreground">No active employee matches.</p>
            )}
            {(results ?? []).map((emp) => {
              const already = isDept ? emp.departmentId === target.id : emp.designationId === target.id;
              const current = isDept ? emp.departmentName : emp.designationTitle;
              return (
                <div
                  key={emp.id}
                  className="flex items-center gap-3 rounded-xl border p-2.5 hover:bg-gray-50"
                  data-testid={`assign-result-${emp.employeeCode}`}
                >
                  <PersonAvatar name={`${emp.firstName} ${emp.lastName}`} seed={emp.id} />
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-1.5 text-sm font-semibold">
                      <span className="truncate">
                        {emp.firstName} {emp.lastName}
                      </span>
                      <TypeChip type={emp.employmentType ?? "staff"} />
                    </p>
                    <p className="text-xs text-gray-400">
                      {emp.employeeCode} · {emp.phone ?? "no phone"}
                    </p>
                    {current && !already && <p className="mt-0.5 text-xs text-amber-600">Now: {current}</p>}
                  </div>
                  <Button
                    size="sm"
                    className="h-8 shrink-0 text-xs"
                    onClick={() => assign(emp)}
                    disabled={assignMutation.isPending || already}
                  >
                    {already ? "Already here" : "Assign"}
                  </Button>
                </div>
              );
            })}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

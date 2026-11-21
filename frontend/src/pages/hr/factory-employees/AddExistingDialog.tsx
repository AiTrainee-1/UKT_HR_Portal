import { useState } from "react";
import { Info, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useDebounced } from "@/hooks/use-debounced";
import { useToast } from "@/hooks/use-toast";
import { useAddFactoryEmployees, useFactoryCandidates, type FactoryLabel } from "@/lib/api-client/custom-hooks";
import { Chip } from "../account-management/parts";
import { LABEL_IS_DEPARTMENT, candidateSub, employees, errorText, movedLines, sortLabels } from "./logic";
import { Field, GREY_CHIP, Lines, SELECT_CLASS } from "./parts";

/** Mark people who are already employees as factory employees (with a label, if one is chosen). */
export function AddExistingDialog({
  labels,
  defaultLabelId,
  onClose,
}: {
  labels: FactoryLabel[];
  defaultLabelId: string;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const add = useAddFactoryEmployees();
  const [query, setQuery] = useState("");
  const search = useDebounced(query);
  const candidates = useFactoryCandidates(search);
  const [picked, setPicked] = useState<Map<number, string>>(new Map());
  const [labelId, setLabelId] = useState(defaultLabelId);
  const rows = candidates.data?.employees ?? [];
  const searching = candidates.isFetching || query !== search;

  const toggle = (id: number, name: string) =>
    setPicked((m) => {
      const next = new Map(m);
      if (next.has(id)) next.delete(id);
      else next.set(id, name);
      return next;
    });

  const run = async () => {
    if (picked.size === 0) return;
    try {
      const result = await add.mutateAsync({
        employeeIds: [...picked.keys()],
        labelId: labelId ? Number(labelId) : null,
      });
      const label = labels.find((l) => String(l.id) === labelId);
      const lines = [
        ...(label ? [`With the label ${label.name}, which is also their department and designation.`] : []),
        ...movedLines(result.moved),
      ];
      toast({
        title: `${employees(result.updated)} added to Factory Employees`,
        description: lines.length ? <Lines lines={lines} /> : undefined,
      });
      onClose();
    } catch (e) {
      toast({ title: "Nobody was added", description: errorText(e), variant: "destructive" });
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="flex max-h-[92vh] w-[calc(100%-1.5rem)] max-w-xl flex-col gap-0 overflow-hidden p-0"
        data-testid="fe-add-dialog"
      >
        <DialogHeader className="border-b px-5 py-4 pr-14">
          <DialogTitle className="text-lg font-black">Add existing employees</DialogTitle>
          <DialogDescription className="text-xs">
            Search the employees who are not in Factory Employees yet.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
          <p className="flex items-start gap-2 rounded-xl bg-sky-50 px-3 py-2 text-xs text-sky-900">
            <Info size={14} className="mt-0.5 shrink-0" />
            Nothing else changes for them: they stay in All Employees with the same attendance, shift and payroll.
          </p>
          <div className="relative">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name, employee code or phone"
              aria-label="Search employees"
              className="h-10 pl-9"
              autoFocus
              data-testid="fe-add-search"
            />
          </div>
          <div className="divide-y rounded-xl border" data-testid="fe-add-list">
            {candidates.isLoading ? (
              <div className="space-y-2 p-3">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-4 w-1/2" />
              </div>
            ) : rows.length === 0 ? (
              <p className="px-3 py-8 text-center text-sm text-muted-foreground" data-testid="fe-add-none">
                {searching
                  ? "Searching…"
                  : search.trim()
                    ? "Nobody matches, or they are already in Factory Employees."
                    : "Everyone is already in Factory Employees."}
              </p>
            ) : (
              rows.map((c) => (
                <label
                  key={c.id}
                  className="flex cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-gray-50"
                  data-testid={`fe-add-${c.code}`}
                >
                  <Checkbox
                    checked={picked.has(c.id)}
                    onCheckedChange={() => toggle(c.id, c.name)}
                    aria-label={`Choose ${c.name}`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 text-sm font-medium text-gray-900">
                      <span className="truncate">{c.name}</span>
                      {c.status !== "active" && <Chip className={GREY_CHIP}>Inactive</Chip>}
                    </span>
                    <span className="block truncate text-xs text-gray-500">
                      <span className="font-mono">{c.code}</span> · {candidateSub(c)}
                    </span>
                  </span>
                </label>
              ))
            )}
          </div>
          {rows.length >= 50 && (
            <p className="text-xs text-muted-foreground">Showing the first 50: type more to narrow the list.</p>
          )}
          <Field label="Give them the label" htmlFor="fe-add-label" hint={LABEL_IS_DEPARTMENT}>
            <select
              id="fe-add-label"
              className={SELECT_CLASS}
              value={labelId}
              onChange={(e) => setLabelId(e.target.value)}
              data-testid="fe-add-label"
            >
              <option value="">No label</option>
              {sortLabels(labels).map((l) => (
                <option key={l.id} value={String(l.id)}>
                  {l.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="flex flex-col gap-2 border-t bg-white px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground" data-testid="fe-add-count">
            {picked.size === 0 ? "Tick the people to add" : `${employees(picked.size)} chosen`}
          </p>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              onClick={() => void run()}
              disabled={picked.size === 0 || add.isPending}
              data-testid="fe-add-confirm"
            >
              {add.isPending ? "Adding…" : picked.size > 0 ? `Add ${employees(picked.size)}` : "Add"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

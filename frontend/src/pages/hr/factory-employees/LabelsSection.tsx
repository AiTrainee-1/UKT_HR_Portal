import { useState } from "react";
import { ArrowDown, ArrowUp, Check, Pencil, Plus, Tag, Trash2, Users } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import {
  useCreateFactoryLabel,
  useDeleteFactoryLabel,
  useUpdateFactoryLabels,
  type FactoryLabel,
} from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import {
  labelDepartment,
  LABEL_IS_DEPARTMENT,
  LABEL_DESCRIPTION_MAX,
  LABEL_NAME_MAX,
  LABEL_PALETTE,
  employees,
  errorText,
  labelBody,
  labelInUse,
  labelProblem,
  moveLabel,
  nextColor,
  safeColor,
  sortLabels,
  type LabelForm,
} from "./logic";
import { Field, LabelChip, ViewOnlyNote } from "./parts";

type Props = {
  labels: FactoryLabel[];
  loading: boolean;
  canManage: boolean;
  onShowEmployees: (labelId: number) => void;
};

/** Create, rename, recolour, describe, reorder and delete the labels (Driver, Housekeeping, Chef...). */
export function LabelsSection({ labels, loading, canManage, onShowEmployees }: Props) {
  const { toast } = useToast();
  const update = useUpdateFactoryLabels();
  const remove = useDeleteFactoryLabel();
  const [editing, setEditing] = useState<FactoryLabel | "new" | null>(null);
  const [deleting, setDeleting] = useState<FactoryLabel | null>(null);
  // the server refused the delete: this many employees still carry the label
  const [inUse, setInUse] = useState<number | null>(null);
  const ordered = sortLabels(labels);

  const move = async (label: FactoryLabel, step: -1 | 1) => {
    const changes = moveLabel(labels, label.id, step);
    if (!changes.length) return;
    try {
      await update.mutateAsync(changes.map((c) => ({ id: c.id, data: { sortOrder: c.sortOrder } })));
    } catch (e) {
      toast({ title: "Could not change the order", description: errorText(e), variant: "destructive" });
    }
  };

  const closeDelete = () => {
    setDeleting(null);
    setInUse(null);
  };

  const runDelete = async (unassign: boolean) => {
    if (!deleting) return;
    const label = deleting;
    try {
      await remove.mutateAsync({ id: label.id, unassign });
      closeDelete();
      toast({
        title: `Label ${label.name} deleted`,
        description: unassign && inUse ? `It was removed from ${employees(inUse)} first.` : undefined,
      });
    } catch (e) {
      const n = labelInUse(e);
      if (n !== null && !unassign) {
        setInUse(n);
        return;
      }
      closeDelete();
      toast({ title: `Could not delete ${label.name}`, description: errorText(e), variant: "destructive" });
    }
  };

  return (
    <div className="space-y-4" data-testid="fe-labels">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted-foreground">
          A label says what a factory employee does (Driver, Housekeeping, Chef, Security...); the list is organised by
          label, in the order set here.{" "}
          <b className="font-semibold text-gray-800" data-testid="fe-labels-department-note">
            {LABEL_IS_DEPARTMENT}
          </b>{" "}
          Renaming a label renames its department and designation; taking a label off someone keeps the department they
          have.
        </p>
        {canManage && (
          <Button onClick={() => setEditing("new")} className="gap-1.5" data-testid="fe-label-new">
            <Plus size={15} /> New label
          </Button>
        )}
      </div>
      {!canManage && (
        <ViewOnlyNote>You can see the labels; changing them needs edit rights on Factory Employees.</ViewOnlyNote>
      )}

      {loading ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-28 rounded-2xl" />
          ))}
        </div>
      ) : ordered.length === 0 ? (
        <Card className="rounded-2xl">
          <CardContent
            className="flex flex-col items-center gap-3 px-6 py-12 text-center"
            data-testid="fe-labels-empty"
          >
            <div className="rounded-2xl bg-teal-50 p-4 text-teal-700">
              <Tag size={24} />
            </div>
            <div>
              <p className="font-bold text-gray-900">No labels yet</p>
              <p className="mt-0.5 text-sm text-muted-foreground">
                Create the first one, for example Driver or Housekeeping, then give it to employees from the list.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {ordered.map((label, i) => (
            <div
              key={label.id}
              className="flex flex-col rounded-2xl border bg-white p-4"
              style={{ borderTop: `4px solid ${safeColor(label.color)}` }}
              data-testid={`fe-label-card-${label.id}`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <LabelChip name={label.name} color={label.color} />
                  <p className="mt-2 text-sm text-gray-600">
                    {label.description || <span className="text-gray-400">No description</span>}
                  </p>
                </div>
                {canManage && (
                  <div className="flex shrink-0 flex-col">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0"
                      disabled={i === 0 || update.isPending}
                      onClick={() => void move(label, -1)}
                      aria-label={`Move ${label.name} up`}
                      data-testid={`fe-label-up-${label.id}`}
                    >
                      <ArrowUp size={14} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0"
                      disabled={i === ordered.length - 1 || update.isPending}
                      onClick={() => void move(label, 1)}
                      aria-label={`Move ${label.name} down`}
                      data-testid={`fe-label-down-${label.id}`}
                    >
                      <ArrowDown size={14} />
                    </Button>
                  </div>
                )}
              </div>
              <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-3">
                <button
                  type="button"
                  onClick={() => onShowEmployees(label.id)}
                  className="inline-flex items-center gap-1 text-xs font-semibold text-teal-700 hover:underline"
                  data-testid={`fe-label-show-${label.id}`}
                >
                  <Users size={12} /> {employees(label.employees ?? 0)}
                </button>
                {canManage && (
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 gap-1 px-2 text-xs"
                      onClick={() => setEditing(label)}
                      aria-label={`Edit the label ${label.name}`}
                      data-testid={`fe-label-edit-${label.id}`}
                    >
                      <Pencil size={13} /> Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 gap-1 px-2 text-xs text-red-700"
                      onClick={() => setDeleting(label)}
                      aria-label={`Delete the label ${label.name}`}
                      data-testid={`fe-label-delete-${label.id}`}
                    >
                      <Trash2 size={13} /> Delete
                    </Button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <LabelDialog
          key={editing === "new" ? "new" : editing.id}
          label={editing === "new" ? null : editing}
          labels={labels}
          onClose={() => setEditing(null)}
        />
      )}

      <AlertDialog open={deleting !== null} onOpenChange={(o) => !o && closeDelete()}>
        <AlertDialogContent data-testid="fe-label-delete-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {inUse
                ? `Remove ${deleting?.name} from ${employees(inUse)} and delete it?`
                : `Delete the label ${deleting?.name}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {inUse
                ? `${employees(inUse)} still ${inUse === 1 ? "has" : "have"} this label. They stay in Factory Employees, with no label, and keep the department and designation they have.`
                : "The label is deleted for good. Nothing else about anyone changes."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void runDelete(inUse !== null);
              }}
              disabled={remove.isPending}
              className="bg-red-600 text-white hover:bg-red-700"
              data-testid="fe-label-delete-confirm"
            >
              {inUse ? "Remove and delete" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** Create or change one label: its name, colour and description. */
function LabelDialog({
  label,
  labels,
  onClose,
}: {
  label: FactoryLabel | null;
  labels: FactoryLabel[];
  onClose: () => void;
}) {
  const { toast } = useToast();
  const create = useCreateFactoryLabel();
  const update = useUpdateFactoryLabels();
  const [form, setForm] = useState<LabelForm>(() => ({
    name: label?.name ?? "",
    color: label?.color ?? nextColor(labels),
    description: label?.description ?? "",
  }));
  const [tried, setTried] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const problem = labelProblem(form, labels, label?.id ?? null);
  const busy = create.isPending || update.isPending;

  const set = (patch: Partial<LabelForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    setServerError(null);
  };

  const save = async () => {
    setTried(true);
    if (problem) return;
    const body = labelBody(form, label);
    if (!body) return onClose();
    try {
      if (label) await update.mutateAsync([{ id: label.id, data: body }]);
      else await create.mutateAsync(body);
    } catch (e) {
      const message = errorText(e);
      setServerError(message);
      toast({
        title: label ? "Could not save the label" : "Could not create the label",
        description: message,
        variant: "destructive",
      });
      return;
    }
    toast({ title: label ? `Label ${form.name.trim()} saved` : `Label ${form.name.trim()} created` });
    onClose();
  };

  const shown = serverError ?? (tried ? problem : null);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-[calc(100%-1.5rem)] max-w-md" data-testid="fe-label-dialog">
        <DialogHeader>
          <DialogTitle>{label ? `Edit ${label.name}` : "New label"}</DialogTitle>
          <DialogDescription>
            {label
              ? `A new name or colour shows everywhere the label is used; a new name also renames its department and designation (${labelDepartment(label.name)}).`
              : `Labels group the factory employees on this page. Each name can be used once. ${LABEL_IS_DEPARTMENT}`}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Field label="Name" htmlFor="fe-label-name" required>
            <Input
              id="fe-label-name"
              value={form.name}
              onChange={(e) => set({ name: e.target.value })}
              onKeyDown={(e) => e.key === "Enter" && void save()}
              maxLength={LABEL_NAME_MAX}
              placeholder="e.g. Driver"
              autoFocus
              data-testid="fe-label-name"
            />
          </Field>
          <Field label="Colour">
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Colour">
              {LABEL_PALETTE.map((c) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={form.color.toLowerCase() === c}
                  aria-label={`Colour ${c}`}
                  onClick={() => set({ color: c })}
                  className={cn(
                    "flex h-8 w-8 items-center justify-center rounded-full ring-offset-2 transition-shadow",
                    form.color.toLowerCase() === c && "ring-2 ring-gray-900",
                  )}
                  style={{ background: c }}
                  data-testid={`fe-label-color-${c.slice(1)}`}
                >
                  {form.color.toLowerCase() === c && <Check size={14} className="text-white" />}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Description" htmlFor="fe-label-description" hint="Optional: what people with this label do.">
            <Textarea
              id="fe-label-description"
              value={form.description}
              onChange={(e) => set({ description: e.target.value })}
              maxLength={LABEL_DESCRIPTION_MAX}
              rows={2}
              placeholder="e.g. Company vehicles and staff transport"
              data-testid="fe-label-description"
            />
          </Field>
          <div className="flex items-center gap-2 rounded-xl bg-gray-50 px-3 py-2 text-xs text-gray-500">
            Preview: <LabelChip name={form.name.trim() || "Label"} color={form.color} />
          </div>
          {shown && (
            <p className="text-sm text-red-600" role="alert" data-testid="fe-label-error">
              {shown}
            </p>
          )}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={busy} data-testid="fe-label-save">
            {busy ? "Saving…" : label ? "Save label" : "Create label"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

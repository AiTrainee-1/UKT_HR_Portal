import { useState } from "react";
import { Navigation } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import GeofencePicker from "@/components/geo/GeofencePicker";
import type { Branch } from "@/lib/api-client/custom-hooks";
import {
  DEFAULT_RADIUS,
  EMPTY_FORM,
  MAX_RADIUS,
  MIN_RADIUS,
  formOf,
  validateForm,
  type BranchForm,
  type FormErrors,
} from "./logic";

type Props = {
  /** The branch being edited; null for a new one. */
  branch: Branch | null;
  /** Every branch, so a repeated name or code is caught before it reaches the server. */
  branches: Branch[];
  saving: boolean;
  onSave: (form: BranchForm) => void;
  onClose: () => void;
};

function FieldError({ id, message }: { id: string; message?: string }) {
  return message ? (
    <p id={id} className="text-xs text-red-600" role="alert">
      {message}
    </p>
  ) : null;
}

/** Add / edit a branch: the details, the Head Office switch and the attendance location (geofence). */
export default function BranchDialog({ branch, branches, saving, onSave, onClose }: Props) {
  const [form, setForm] = useState<BranchForm>(() => (branch ? formOf(branch) : EMPTY_FORM));
  const [errors, setErrors] = useState<FormErrors>({});
  const set = (patch: Partial<BranchForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    // a message goes away as soon as its field is touched
    setErrors((e) => {
      const next = { ...e };
      for (const key of Object.keys(patch)) {
        delete next[key as keyof FormErrors];
        if (key === "geofenceLat") delete next.radius;
      }
      return next;
    });
  };

  const submit = () => {
    const found = validateForm(
      form,
      branches.filter((b) => b.id !== branch?.id),
    );
    setErrors(found);
    if (Object.keys(found).length === 0) onSave(form);
  };

  const hasGeo = form.geofenceLat != null && form.geofenceLng != null;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto" data-testid="branch-dialog">
        <DialogHeader>
          <DialogTitle>{branch ? "Edit Branch" : "Add Branch"}</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-4 py-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2 space-y-1.5">
              <Label htmlFor="br-name">
                Branch Name <span className="text-red-500">*</span>
              </Label>
              <Input
                id="br-name"
                placeholder="e.g. Surat Branch"
                value={form.name}
                onChange={(e) => set({ name: e.target.value })}
                aria-invalid={!!errors.name}
                aria-describedby={errors.name ? "br-name-err" : undefined}
                autoFocus
              />
              <FieldError id="br-name-err" message={errors.name} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="br-code">Code</Label>
              <Input
                id="br-code"
                placeholder="e.g. U2"
                value={form.code}
                onChange={(e) => set({ code: e.target.value })}
                aria-invalid={!!errors.code}
                aria-describedby={errors.code ? "br-code-err" : undefined}
              />
              <FieldError id="br-code-err" message={errors.code} />
            </div>
          </div>
          <p className="-mt-2 text-xs text-muted-foreground">
            The code starts every employee's unit code in this branch (U2-1, U2-2, ...). Without one, new employees get
            no unit code.
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="br-location">Location / City</Label>
            <Input
              id="br-location"
              placeholder="e.g. Surat"
              value={form.location}
              onChange={(e) => set({ location: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="br-address">Address</Label>
            <Input
              id="br-address"
              placeholder="Full address"
              value={form.address}
              onChange={(e) => set({ address: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="br-phone">Phone</Label>
            <Input
              id="br-phone"
              placeholder="+91 ..."
              value={form.phone}
              onChange={(e) => set({ phone: e.target.value })}
              aria-invalid={!!errors.phone}
              aria-describedby={errors.phone ? "br-phone-err" : undefined}
            />
            <FieldError id="br-phone-err" message={errors.phone} />
          </div>
          <label htmlFor="br-ho" className="flex cursor-pointer items-start gap-2.5 rounded-lg border p-3">
            <input
              id="br-ho"
              type="checkbox"
              className="mt-0.5 h-4 w-4 accent-teal-600"
              checked={form.isHeadOffice}
              onChange={(e) => set({ isHeadOffice: e.target.checked })}
            />
            <span>
              <span className="block text-sm font-medium text-gray-900">Head Office</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                The default branch existing employees and departments belong to. Only one branch can be Head Office -
                marking this one unmarks any other.
              </span>
            </span>
          </label>

          <div className="space-y-2 rounded-lg border p-3">
            <div className="flex items-center justify-between">
              <Label className="flex items-center gap-1.5">
                <Navigation size={13} className="text-teal-700" /> Attendance Location (Geofence)
              </Label>
              {hasGeo && (
                <button
                  type="button"
                  className="text-[11px] text-red-500 hover:underline"
                  onClick={() => set({ geofenceLat: null, geofenceLng: null })}
                >
                  Clear
                </button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Click the map to set this branch's location. Employees inside the radius below can mark attendance from
              the mobile or web app; outside it, they'll need photo + Department-Head approval.
            </p>
            <GeofencePicker
              key={branch?.id ?? "new"}
              lat={form.geofenceLat}
              lng={form.geofenceLng}
              radiusM={Number(form.radius) >= MIN_RADIUS ? Number(form.radius) : DEFAULT_RADIUS}
              onPick={(lat, lng) => set({ geofenceLat: lat, geofenceLng: lng })}
            />
            {hasGeo && (
              <div className="grid grid-cols-2 items-end gap-3">
                <div className="font-mono text-xs text-muted-foreground">
                  {form.geofenceLat!.toFixed(6)}, {form.geofenceLng!.toFixed(6)}
                </div>
                <div className="space-y-1">
                  <Label htmlFor="br-radius" className="text-xs">
                    Radius (meters)
                  </Label>
                  <Input
                    id="br-radius"
                    type="number"
                    min={MIN_RADIUS}
                    max={MAX_RADIUS}
                    value={form.radius}
                    onChange={(e) => set({ radius: e.target.value })}
                    aria-invalid={!!errors.radius}
                    aria-describedby={errors.radius ? "br-radius-err" : undefined}
                    className="h-8"
                  />
                  <FieldError id="br-radius-err" message={errors.radius} />
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving} data-testid="branch-save">
              {saving ? "Saving..." : branch ? "Save Changes" : "Add Branch"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

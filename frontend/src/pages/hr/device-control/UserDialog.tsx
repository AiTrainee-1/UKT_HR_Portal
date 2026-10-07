import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Loader2, Search, UserPlus, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { permissionLevel, useAuth } from "@/contexts/AuthContext";
import {
  useDevicePeople,
  usePushDeviceUsers,
  useSaveEmployeePhoto,
  useUpdateDeviceUsers,
  type DeviceControlDevice,
  type PersonRow,
} from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import CameraCapture from "./CameraCapture";
import { ConnectionChip, PersonAvatar, forgetPhoto } from "./parts";
import type { ChangeOutcome } from "./ResultDialog";
import {
  EMPTY_FORM,
  NAME_BYTES,
  ROLE_OPTIONS,
  byteLength,
  changedFields,
  describeDiffers,
  deviceNameFor,
  formFromPerson,
  isAdminRole,
  newUserInput,
  pinWidthFor,
  validateForm,
  type UserForm,
} from "./logic";

type Props = {
  mode: "create" | "edit";
  open: boolean;
  onClose: () => void;
  devices: DeviceControlDevice[];
  /** edit: the person being changed. create: someone to start from (an HRMS employee to put on a device). */
  person?: PersonRow | null;
  /** The device whose chip was clicked: its details fill the form and it is the only one ticked to start with. */
  deviceId?: number | null;
  onOutcome: (outcome: ChangeOutcome) => void;
};

const useDebounced = <T,>(value: T, ms = 250): T => {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
};

/** Add a user to devices, or change one: everything the terminal asks for, a photo, and which devices to do it on. */
export default function UserDialog({ mode, open, onClose, devices, person, deviceId, onOutcome }: Props) {
  const { toast } = useToast();
  const { user } = useAuth();
  // the photo lives on the employee's profile, so saving one is an employee edit
  const canEditEmployees = permissionLevel(user, "employees") === "edit";
  const push = usePushDeviceUsers();
  const update = useUpdateDeviceUsers();
  const savePhoto = useSaveEmployeePhoto();

  const editing = mode === "edit";
  const nameRef = useRef<HTMLInputElement>(null);
  const [source, setSource] = useState<"hrms" | "manual">(editing || person?.employee || !person ? "hrms" : "manual");
  const [picked, setPicked] = useState<PersonRow | null>(person && person.employee ? person : null);
  const [query, setQuery] = useState("");
  const search = useDebounced(query.trim());
  const initial = useMemo<UserForm>(
    () => (person ? formFromPerson(person, deviceId ?? undefined) : EMPTY_FORM),
    [person, deviceId],
  );
  const [form, setForm] = useState<UserForm>(initial);
  const [photo, setPhoto] = useState<string | null>(null);
  const [clearPassword, setClearPassword] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [submitting, setSubmitting] = useState(false);

  const subject = editing ? person : picked;
  const employee = subject?.employee ?? null;
  const results = useDevicePeople(
    { search, pageSize: 8 },
    !editing && source === "hrms" && !picked && search.length >= 2,
  );
  const candidates = (results.data?.items ?? []).filter((p) => p.employee && !p.restricted);

  const hasOn = (deviceId: number) => !!subject?.presence.some((p) => p.deviceId === deviceId);
  const reachable = (d: DeviceControlDevice) => d.isActive && d.connection.state === "connected";
  const eligible = (d: DeviceControlDevice) => reachable(d) && (editing ? hasOn(d.id) : !hasOn(d.id));
  const listed = editing ? devices.filter((d) => hasOn(d.id)) : devices.filter((d) => d.isActive);

  // The devices ticked: to start with, the one that was clicked (or every one that can take the change); once the person
  // has ticked or unticked anything their choice stays, and only devices that can no longer take the change drop out.
  const touched = useRef(false);
  const seededFor = useRef<string | null>(null);
  const readyKey = devices
    .filter(eligible)
    .map((d) => d.id)
    .join();
  useEffect(() => {
    const key = subject?.userId ?? "";
    if (seededFor.current !== key) {
      seededFor.current = key;
      touched.current = false;
    }
    const ready = devices.filter(eligible).map((d) => d.id);
    setSelected((prev) =>
      touched.current
        ? new Set([...prev].filter((id) => ready.includes(id)))
        : new Set(deviceId != null && ready.includes(deviceId) ? [deviceId] : ready),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subject?.userId, readyKey, deviceId]);

  const choose = (p: PersonRow) => {
    setPicked(p);
    setQuery("");
    setPhoto(null);
    setForm(
      p.presence.length > 0
        ? formFromPerson(p)
        : { ...EMPTY_FORM, userId: p.userId, name: deviceNameFor(p.employee?.name ?? p.name) },
    );
  };

  // the ID has to fit on every device it is going to, so the limit comes from the ticked ones
  const errors = validateForm(form, {
    mode,
    pinWidth: pinWidthFor(devices.filter((d) => (selected.size ? selected.has(d.id) : d.isActive))),
  });
  const diff = editing ? changedFields(initial, form) : null;
  const effectiveDiff = editing && clearPassword ? { ...(diff ?? { userId: form.userId }), password: "" } : diff;
  const nothingToDo = editing && !effectiveDiff && !photo;
  const noDevices = selected.size === 0 && !(editing && !effectiveDiff && photo);
  const blocked = Object.keys(errors).length > 0 || nothingToDo || noDevices || (!editing && !form.userId.trim());

  const submit = async () => {
    setSubmitting(true);
    const extra: string[] = [];
    try {
      let result;
      const deviceIds = [...selected];
      if (!editing) {
        result = await push.mutateAsync({ deviceIds, users: [newUserInput(form, picked?.employee?.id ?? null)] });
      } else if (effectiveDiff && deviceIds.length > 0) {
        result = await update.mutateAsync({ deviceIds, users: [effectiveDiff] });
      }
      if (photo && employee && canEditEmployees) {
        try {
          await savePhoto.mutateAsync({ employeeId: employee.id, photo });
          forgetPhoto(employee.photoUrl);
          extra.push(`Photo saved to ${employee.name}'s HRMS profile.`);
        } catch (e) {
          extra.push(`The photo could not be saved: ${e instanceof Error ? e.message : "unknown error"}`);
        }
      }
      onClose();
      if (result) onOutcome({ kind: "push", result, extra });
      else toast({ title: extra[0] ?? "Nothing was changed" });
    } catch (e) {
      toast({
        title: editing ? "Could not change the user" : "Could not add the user",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  };

  const set = (patch: Partial<UserForm>) => setForm((f) => ({ ...f, ...patch }));
  const roleHint = ROLE_OPTIONS.find((r) => r.value === form.privilege)?.hint;
  const differs = editing && person ? describeDiffers(person.differs) : "";

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !submitting && onClose()}>
      <DialogContent
        className="max-h-[92vh] max-w-2xl overflow-y-auto"
        data-testid="user-dialog"
        onOpenAutoFocus={(e) => {
          // editing: the name is what people change, the ID is read-only, so start there
          if (editing) {
            e.preventDefault();
            nameRef.current?.focus();
            nameRef.current?.select();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {editing ? <UserRound size={18} /> : <UserPlus size={18} />}
            {editing ? `Change ${person?.name || person?.userId}` : "Add a user to the devices"}
          </DialogTitle>
          <DialogDescription>
            {editing
              ? "Change what the devices hold for this person. Only the fields you change are sent."
              : "Everything the device asks for. It is written to each device you choose and read back to be sure."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          {/* ── who ── */}
          {!editing && (
            <section className="space-y-2">
              <div className="flex gap-1.5 rounded-xl bg-slate-100 p-1 text-xs font-semibold">
                {(
                  [
                    ["hrms", "An employee in the HRMS"],
                    ["manual", "Someone not in the HRMS"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => {
                      setSource(value);
                      setPicked(null);
                      setForm(EMPTY_FORM);
                      setPhoto(null);
                    }}
                    aria-pressed={source === value}
                    data-testid={`user-source-${value}`}
                    className={cn(
                      "flex-1 rounded-lg px-3 py-1.5 transition-colors",
                      source === value ? "bg-white text-[#006496] shadow-sm" : "text-slate-500 hover:text-slate-700",
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {source === "hrms" && !picked && (
                <div className="space-y-2">
                  <div className="relative">
                    <Search
                      size={14}
                      className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
                    />
                    <Input
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Search by name or Employee Code"
                      className="pl-9"
                      aria-label="Search employees"
                      data-testid="user-search"
                      autoFocus
                    />
                  </div>
                  {search.length >= 2 && (
                    <div className="max-h-52 divide-y overflow-y-auto rounded-xl border" data-testid="user-candidates">
                      {results.isFetching && candidates.length === 0 ? (
                        <p className="flex items-center gap-2 p-3 text-xs text-slate-500">
                          <Loader2 size={13} className="animate-spin" /> Searching…
                        </p>
                      ) : candidates.length === 0 ? (
                        <p className="p-3 text-xs text-slate-500">No employee matches “{search}”.</p>
                      ) : (
                        candidates.map((p) => (
                          <button
                            key={p.userId}
                            type="button"
                            onClick={() => choose(p)}
                            data-testid={`user-pick-${p.userId}`}
                            className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-slate-50"
                          >
                            <PersonAvatar name={p.employee!.name} photoUrl={p.employee!.photoUrl} size={30} />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-semibold text-slate-800">
                                {p.employee!.name}
                              </span>
                              <span className="block truncate text-xs text-slate-500">
                                {p.userId}
                                {p.employee!.department ? ` · ${p.employee!.department}` : ""}
                                {p.employee!.status !== "active" ? " · Inactive" : ""}
                              </span>
                            </span>
                            <span className="text-[11px] text-slate-400">
                              {p.deviceCount === 0
                                ? "on no device"
                                : `on ${p.deviceCount} device${p.deviceCount > 1 ? "s" : ""}`}
                            </span>
                          </button>
                        ))
                      )}
                    </div>
                  )}
                  {search.length < 2 && <p className="text-xs text-slate-400">Type at least two letters or digits.</p>}
                </div>
              )}

              {source === "hrms" && picked?.employee && (
                <div className="flex items-center gap-3 rounded-xl border bg-slate-50/70 p-3" data-testid="user-picked">
                  <PersonAvatar name={picked.employee.name} photoUrl={picked.employee.photoUrl} size={40} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-bold text-slate-800">{picked.employee.name}</p>
                    <p className="truncate text-xs text-slate-500">
                      {picked.employee.code}
                      {picked.employee.department ? ` · ${picked.employee.department}` : ""}
                      {picked.employee.designation ? ` · ${picked.employee.designation}` : ""}
                    </p>
                  </div>
                  {!person && (
                    <Button type="button" size="sm" variant="ghost" onClick={() => setPicked(null)}>
                      Choose someone else
                    </Button>
                  )}
                </div>
              )}
              {picked?.employee?.status && picked.employee.status !== "active" && (
                <p className="flex items-start gap-1.5 rounded-lg bg-amber-50 p-2 text-xs text-amber-900">
                  <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                  This employee is Inactive in the HRMS. Their punches will not be recorded until they are made Active
                  again.
                </p>
              )}
            </section>
          )}

          {editing && person?.employee && (
            <div className="flex items-center gap-3 rounded-xl border bg-slate-50/70 p-3">
              <PersonAvatar name={person.employee.name} photoUrl={person.employee.photoUrl} size={40} />
              <div className="min-w-0">
                <p className="truncate text-sm font-bold text-slate-800">{person.employee.name}</p>
                <p className="truncate text-xs text-slate-500">
                  {person.employee.code}
                  {person.employee.department ? ` · ${person.employee.department}` : ""}
                </p>
              </div>
            </div>
          )}
          {differs && (
            <p className="rounded-lg bg-amber-50 p-2 text-xs leading-snug text-amber-900" data-testid="user-differs">
              The devices hold {differs} for this person. The form shows{" "}
              {deviceId ? "the device you chose" : "the first device"}; whatever you change is applied to every device
              you tick, and fields you leave alone stay as they are on each one.
            </p>
          )}

          {/* ── details ── */}
          {(editing || source === "manual" || picked) && (
            <section className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="user-id">User ID</Label>
                <Input
                  id="user-id"
                  value={form.userId}
                  onChange={(e) => set({ userId: e.target.value })}
                  readOnly={editing || (source === "hrms" && !!picked)}
                  placeholder="The Employee Code"
                  data-testid="user-id"
                  className={cn((editing || (source === "hrms" && picked)) && "bg-slate-50")}
                />
                {errors.userId ? (
                  <p className="text-xs text-red-600">{errors.userId}</p>
                ) : (
                  <p className="text-[11px] text-slate-400">
                    The ID on the device is the Employee Code{editing ? ", so it cannot be changed here" : ""}.
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <div className="flex items-baseline justify-between">
                  <Label htmlFor="user-name">Name on the device</Label>
                  <span
                    className={cn(
                      "text-[11px] tabular-nums",
                      byteLength(form.name) > NAME_BYTES ? "text-red-600" : "text-slate-400",
                    )}
                    data-testid="user-name-count"
                  >
                    {byteLength(form.name)}/{NAME_BYTES}
                  </span>
                </div>
                <Input
                  ref={nameRef}
                  id="user-name"
                  value={form.name}
                  onChange={(e) => set({ name: e.target.value })}
                  placeholder="As it should show on the device"
                  data-testid="user-name"
                />
                {errors.name && <p className="text-xs text-red-600">{errors.name}</p>}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="user-role">Role</Label>
                <Select value={String(form.privilege)} onValueChange={(v) => set({ privilege: Number(v) })}>
                  <SelectTrigger id="user-role" data-testid="user-role">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ROLE_OPTIONS.map((r) => (
                      <SelectItem key={r.value} value={String(r.value)}>
                        {r.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p
                  className={cn(
                    "text-[11px]",
                    isAdminRole(form.privilege) ? "font-medium text-violet-700" : "text-slate-400",
                  )}
                >
                  {roleHint}
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="user-card">Card number</Label>
                <Input
                  id="user-card"
                  inputMode="numeric"
                  value={form.card}
                  onChange={(e) => set({ card: e.target.value.replace(/\s+/g, "") })}
                  placeholder={editing ? "Unchanged (empty removes it)" : "Optional"}
                  data-testid="user-card"
                />
                {errors.card && <p className="text-xs text-red-600">{errors.card}</p>}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="user-password">Device password</Label>
                <Input
                  id="user-password"
                  type="password"
                  autoComplete="new-password"
                  inputMode="numeric"
                  value={form.password}
                  onChange={(e) => {
                    set({ password: e.target.value });
                    if (e.target.value) setClearPassword(false);
                  }}
                  placeholder={editing ? "Unchanged" : "Optional, up to 8 digits"}
                  data-testid="user-password"
                />
                {errors.password && <p className="text-xs text-red-600">{errors.password}</p>}
                {editing && person?.presence.some((p) => p.hasPassword) && (
                  <label className="flex items-center gap-2 text-xs text-slate-600">
                    <Checkbox
                      checked={clearPassword}
                      onCheckedChange={(c) => setClearPassword(c === true)}
                      data-testid="user-clear-password"
                    />
                    Remove the password
                  </label>
                )}
              </div>
              <div className="space-y-1.5">
                <button
                  type="button"
                  className="text-xs font-semibold text-[#006496] hover:underline"
                  onClick={() => setShowAdvanced((v) => !v)}
                  aria-expanded={showAdvanced}
                >
                  {showAdvanced ? "Hide" : "Show"} advanced
                </button>
                {showAdvanced && (
                  <div className="space-y-1.5">
                    <Label htmlFor="user-group">Group</Label>
                    <Input
                      id="user-group"
                      value={form.group}
                      onChange={(e) => set({ group: e.target.value })}
                      placeholder="Optional"
                      data-testid="user-group"
                    />
                    {errors.group && <p className="text-xs text-red-600">{errors.group}</p>}
                  </div>
                )}
              </div>
            </section>
          )}

          {/* ── photo ── */}
          {(editing || source === "manual" || picked) && (
            <section className="space-y-2 border-t pt-4">
              <div>
                <h4 className="text-sm font-bold text-slate-800">Photo</h4>
                <p className="text-xs leading-snug text-slate-500">
                  {!employee
                    ? "A photo is kept on an employee's HRMS profile, so it needs an employee. This person is not in the HRMS."
                    : !canEditEmployees
                      ? "A photo is saved on the employee's HRMS profile, and your role cannot edit employees."
                      : `Saved to ${employee.name}'s HRMS profile (ID card and profile). The terminals take their face enrolment on the device itself, and do not accept a photo over the network.`}
                </p>
              </div>
              <CameraCapture value={photo} onChange={setPhoto} disabled={!employee || !canEditEmployees} />
            </section>
          )}

          {/* ── devices ── */}
          {(editing || source === "manual" || picked) && (
            <section className="space-y-2 border-t pt-4">
              <h4 className="text-sm font-bold text-slate-800">{editing ? "Change it on" : "Add it to"}</h4>
              <div className="divide-y rounded-xl border" data-testid="user-devices">
                {listed.length === 0 && <p className="p-3 text-xs text-slate-500">No device is switched on.</p>}
                {listed.map((d) => {
                  const ok = eligible(d);
                  const why = !reachable(d)
                    ? "cannot be reached right now"
                    : editing
                      ? ""
                      : hasOn(d.id)
                        ? "already has this user"
                        : "";
                  return (
                    <label
                      key={d.id}
                      className={cn(
                        "flex items-center gap-3 px-3 py-2 text-sm",
                        ok ? "cursor-pointer hover:bg-slate-50" : "opacity-60",
                      )}
                    >
                      <Checkbox
                        checked={selected.has(d.id)}
                        disabled={!ok}
                        onCheckedChange={(c) => {
                          touched.current = true;
                          setSelected((prev) => {
                            const next = new Set(prev);
                            if (c === true) next.add(d.id);
                            else next.delete(d.id);
                            return next;
                          });
                        }}
                        data-testid={`user-device-${d.id}`}
                        aria-label={`${d.name}`}
                      />
                      <span className="min-w-0 flex-1 font-semibold text-slate-800">{d.name}</span>
                      {why && <span className="text-xs text-slate-500">{why}</span>}
                      <ConnectionChip device={d} />
                    </label>
                  );
                })}
              </div>
            </section>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="button" onClick={submit} disabled={blocked || submitting} data-testid="user-submit">
            {submitting && <Loader2 size={14} className="mr-1.5 animate-spin" />}
            {editing ? "Save changes" : `Add to ${selected.size} device${selected.size === 1 ? "" : "s"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

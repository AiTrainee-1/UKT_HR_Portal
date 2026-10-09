import { useRef, useState, type FormEvent } from "react";
import { Cable, CheckCircle2, Copy, Loader2, Plus, Power, RefreshCw, Settings2, Trash2 } from "lucide-react";
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
import { CircleLoader } from "@/components/ui/CircleLoader";
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
import { useToast } from "@/hooks/use-toast";
import { getApiOrigin } from "@/lib/api-client/custom-fetch";
import {
  useConnectors,
  useCreateConnector,
  useDeleteConnector,
  useNewPairingCode,
  useUpdateConnector,
  type ConnectorChanges,
  type ConnectorWithCode,
  type SiteConnector,
} from "@/lib/api-client/custom-hooks";
import { TonePill } from "../device-status/parts";
import { relativeTime } from "../device-status/logic";
import {
  CONNECTOR_STATE_LABEL,
  CONNECTOR_STATE_TONE,
  describeConnectorSync,
  formatUptime,
  validateConnectorSettings,
} from "./logic";

/** The HRMS server's address as the connector has to be told it: the API's own origin (not this page's, when they differ). */
const serverAddress = () => getApiOrigin() || window.location.origin;

// ── the pairing code, shown once ──────────────────────────────────────────────────────────────────────────────────────

function PairingCodeDialog({ made, onClose }: { made: ConnectorWithCode; onClose: () => void }) {
  const { toast } = useToast();
  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: `${what} copied` });
    } catch {
      toast({ title: "Could not copy: select the text and copy it yourself", variant: "destructive" });
    }
  };
  const expires = new Date(made.pairingExpiresAt).toLocaleString();
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="max-h-[92vh] max-w-lg overflow-y-auto"
        data-testid="connector-code-dialog"
        // the code is shown only once: a stray click outside, or Esc, must not throw it away
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Cable size={18} /> Pair “{made.connector.name}”
          </DialogTitle>
          <DialogDescription>
            Enter this code in the connector on the computer at the factory. It is shown only now, works once and
            expires on {expires}.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border bg-slate-50 px-4 py-3">
            <span
              className="whitespace-nowrap font-mono text-2xl font-black tracking-[0.15em] text-slate-900 sm:text-3xl sm:tracking-[0.2em]"
              data-testid="connector-code"
            >
              {made.pairingCode}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => copy(made.pairingCode, "Code")}
            >
              <Copy size={13} /> Copy code
            </Button>
          </div>
          {made.connector.paired && (
            <p
              className="rounded-xl bg-amber-50 p-3 text-xs leading-snug text-amber-900"
              data-testid="connector-repair-note"
            >
              This connector is already installed. It keeps working as it is until this code is used; from then on the
              program it replaces stops working, so use it only for the computer that should take over.
            </p>
          )}
          <ol className="list-decimal space-y-1.5 pl-5 text-sm text-slate-700">
            <li>
              Install the <b>UKT Biometric Site Connector</b> on a computer at the factory that is on the same network
              as the devices (the installer and its steps are in the folder it came in).
            </li>
            <li>
              Open <span className="font-mono">http://127.0.0.1:8765</span> on that computer and enter this server
              address and the code:
              <div className="mt-1 flex items-center gap-2 rounded-lg border bg-white px-2.5 py-1.5">
                <span className="min-w-0 flex-1 truncate font-mono text-xs" data-testid="connector-address">
                  {serverAddress()}
                </span>
                <button
                  type="button"
                  className="text-xs font-semibold text-[#006496] hover:underline"
                  onClick={() => copy(serverAddress(), "Address")}
                >
                  Copy
                </button>
              </div>
            </li>
            <li>
              In <b>Settings → Devices</b>, choose this connector under “Connect via” for each device at that factory,
              using the device&apos;s address on the factory network (192.168.x.x).
            </li>
          </ol>
        </div>
        <DialogFooter>
          <Button type="button" onClick={onClose} data-testid="connector-code-close">
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── add a connector ───────────────────────────────────────────────────────────────────────────────────────────────────

function AddDialog({ onClose, onMade }: { onClose: () => void; onMade: (made: ConnectorWithCode) => void }) {
  const { toast } = useToast();
  const create = useCreateConnector();
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (create.isPending || name.trim() === "") return;
    try {
      const made = await create.mutateAsync({ name: name.trim(), notes: notes.trim() });
      create.reset(); // the code is not kept anywhere once it has been handed to the dialog that shows it
      onMade(made);
    } catch (err) {
      toast({
        title: "Could not add the connector",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && !create.isPending && onClose()}>
      <DialogContent className="max-w-md" data-testid="connector-add-dialog">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Add a site connector</DialogTitle>
            <DialogDescription>
              One connector per factory network. Name it after the site: you will choose it for that site&apos;s
              devices.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="connector-name">Name</Label>
              <Input
                id="connector-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Unit 2 – Tirupur"
                maxLength={80}
                data-testid="connector-name-input"
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="connector-notes">Notes (optional)</Label>
              <Input
                id="connector-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Which computer it is installed on"
                maxLength={500}
              />
            </div>
          </div>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button type="button" variant="ghost" onClick={onClose} disabled={create.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending || name.trim() === ""} data-testid="connector-create">
              {create.isPending && <Loader2 size={14} className="mr-1.5 animate-spin" />}
              Create and show the code
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── its settings ──────────────────────────────────────────────────────────────────────────────────────────────────────

function SettingsDialog({ connector, onClose }: { connector: SiteConnector; onClose: () => void }) {
  const { toast } = useToast();
  const update = useUpdateConnector();
  const [name, setName] = useState(connector.name);
  const [notes, setNotes] = useState(connector.notes);
  const [minutes, setMinutes] = useState(String(connector.punchSyncMinutes));
  const [days, setDays] = useState(String(connector.punchSyncDays));
  const problem = validateConnectorSettings({ name, minutes, days });
  const submit = async () => {
    // only what was changed is sent, so the audit trail says what was changed
    const changes: ConnectorChanges = {};
    if (name.trim() !== connector.name) changes.name = name.trim();
    if (notes.trim() !== connector.notes) changes.notes = notes.trim();
    if (Number(minutes) !== connector.punchSyncMinutes) changes.punchSyncMinutes = Number(minutes);
    if (Number(days) !== connector.punchSyncDays) changes.punchSyncDays = Number(days);
    if (Object.keys(changes).length === 0) {
      onClose();
      return;
    }
    try {
      await update.mutateAsync({ id: connector.id, changes });
      toast({ title: "Saved" });
      onClose();
    } catch (e) {
      toast({
        title: "Could not save",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && !update.isPending && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-md overflow-y-auto" data-testid="connector-settings-dialog">
        <DialogHeader>
          <DialogTitle>Settings of “{connector.name}”</DialogTitle>
          <DialogDescription>
            Devices push their punches to the server on their own. The connector also reads each device now and then, as
            a safety net behind that push, and for a device that cannot push.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="cs-name">Name</Label>
            <Input
              id="cs-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              data-testid="connector-settings-name"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cs-notes">Notes</Label>
            <Input id="cs-notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="cs-min">Read punches every (minutes)</Label>
              <Input
                id="cs-min"
                inputMode="numeric"
                value={minutes}
                onChange={(e) => setMinutes(e.target.value)}
                data-testid="connector-settings-minutes"
              />
              <p className="text-[11px] text-slate-500">0 = never</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cs-days">Look back (days)</Label>
              <Input id="cs-days" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} />
              <p className="text-[11px] text-slate-500">1 to 31</p>
            </div>
          </div>
          {problem && (
            <p className="text-xs text-red-600" role="alert">
              {problem}
            </p>
          )}
        </div>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={update.isPending}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={submit}
            disabled={!!problem || update.isPending}
            data-testid="connector-settings-save"
          >
            {update.isPending && <Loader2 size={14} className="mr-1.5 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── one connector ─────────────────────────────────────────────────────────────────────────────────────────────────────

function ConnectorCard({
  c,
  busy,
  onCode,
  onSettings,
  onToggle,
  onRemove,
}: {
  c: SiteConnector;
  busy: boolean;
  onCode: (c: SiteConnector) => void;
  onSettings: (c: SiteConnector) => void;
  onToggle: (c: SiteConnector) => void;
  onRemove: (c: SiteConnector) => void;
}) {
  const facts = [
    c.lastSeenAt ? `Last heard from ${relativeTime(c.lastSeenAt)}` : "Has not connected yet",
    c.hostname ? `Computer ${c.hostname}${c.os ? ` (${c.os})` : ""}` : null,
    c.version ? `Version ${c.version}` : null,
    c.state === "online" && c.uptimeSeconds != null ? `Running ${formatUptime(c.uptimeSeconds)}` : null,
    c.lastRemoteIp ? `From ${c.lastRemoteIp}` : null,
  ].filter(Boolean);
  return (
    <Card className="rounded-2xl" data-testid={`connector-card-${c.id}`} data-state={c.state}>
      <CardContent className="space-y-4 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-base font-black text-slate-900" data-testid={`connector-name-${c.id}`}>
                {c.name}
              </h3>
              <span data-testid={`connector-state-${c.id}`}>
                <TonePill tone={CONNECTOR_STATE_TONE[c.state]}>{CONNECTOR_STATE_LABEL[c.state]}</TonePill>
              </span>
            </div>
            {c.notes && <p className="mt-0.5 text-xs text-slate-500">{c.notes}</p>}
            <p className="mt-1 text-xs text-slate-500">{facts.join(" · ")}</p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              onClick={() => onCode(c)}
              disabled={busy}
              data-testid={`connector-new-code-${c.id}`}
            >
              <RefreshCw size={13} /> {c.paired ? "New pairing code" : "Create pairing code"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              onClick={() => onToggle(c)}
              disabled={busy}
              data-testid={`connector-toggle-${c.id}`}
            >
              <Power size={13} /> {c.isActive ? "Disable connector" : "Enable connector"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              onClick={() => onSettings(c)}
              data-testid={`connector-settings-${c.id}`}
            >
              <Settings2 size={13} /> Settings
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="gap-1.5 text-red-600 hover:text-red-700"
              onClick={() => onRemove(c)}
              data-testid={`connector-remove-${c.id}`}
            >
              <Trash2 size={13} /> Remove
            </Button>
          </div>
        </div>

        {c.state === "unpaired" && (
          <p className="rounded-xl bg-amber-50 p-3 text-xs text-amber-900">
            {c.pairingPending
              ? "Waiting for the connector at the factory to be paired with its code."
              : "The pairing code has expired. Make a new one with “Create pairing code”."}
          </p>
        )}
        {c.state === "offline" && (
          <p className="rounded-xl bg-red-50 p-3 text-xs text-red-900">
            Not heard from for a while. Check that its computer is on and has internet. Devices behind it show as
            disconnected until it is back; punches the devices push to the server still arrive.
          </p>
        )}

        <div>
          <h4 className="mb-1.5 text-xs font-bold uppercase tracking-wide text-slate-500">
            Devices reached through it ({c.devices.length})
          </h4>
          {c.devices.length === 0 ? (
            <p
              className="rounded-xl bg-slate-50 p-3 text-xs text-slate-600"
              data-testid={`connector-no-devices-${c.id}`}
            >
              None yet. In Settings → Devices, choose this connector under “Connect via” for each device at this site.
            </p>
          ) : (
            <div className="divide-y rounded-xl border" data-testid={`connector-devices-${c.id}`}>
              {c.devices.map((d) => (
                <div key={d.id} className="flex flex-wrap items-start justify-between gap-2 px-3 py-2 text-sm">
                  <div className="min-w-0">
                    <p className="font-semibold text-slate-800">{d.name}</p>
                    <p className="text-xs text-slate-500">
                      {d.host}:{d.port}
                    </p>
                  </div>
                  <div className="max-w-md text-right text-xs">
                    <TonePill tone={!d.isActive || d.code === "pending" ? "muted" : d.connected ? "good" : "bad"}>
                      {!d.isActive
                        ? "Switched off"
                        : d.connected
                          ? "Connected"
                          : d.code === "pending"
                            ? "Not checked yet"
                            : "Not answering"}
                    </TonePill>
                    {d.isActive && !d.connected && d.reason && <p className="mt-1 text-slate-500">{d.reason}</p>}
                    <p className="mt-1 text-slate-500" data-testid={`connector-sync-${d.id}`}>
                      {describeConnectorSync(d.sync)}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
          <span>
            Reads punches {c.punchSyncMinutes > 0 ? `every ${c.punchSyncMinutes} min` : "never"} (last {c.punchSyncDays}{" "}
            {c.punchSyncDays === 1 ? "day" : "days"})
          </span>
          {c.outbox != null && c.outbox > 0 && (
            <span className="text-amber-700">{c.outbox} punches waiting to be sent</span>
          )}
          {c.openJobs > 0 && <span>{c.openJobs} job(s) in progress</span>}
        </p>
      </CardContent>
    </Card>
  );
}

// ── the tab ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Site connectors: the small programs at the factories that reach devices the server cannot, and how each is doing. */
export default function ConnectorsTab() {
  const { toast } = useToast();
  const connectors = useConnectors();
  const pairing = useNewPairingCode();
  const update = useUpdateConnector();
  const remove = useDeleteConnector();
  const [adding, setAdding] = useState(false);
  const [code, setCode] = useState<ConnectorWithCode | null>(null);
  const [settings, setSettings] = useState<SiteConnector | null>(null);
  const [disabling, setDisabling] = useState<SiteConnector | null>(null);
  const [removing, setRemoving] = useState<SiteConnector | null>(null);
  // the name shown while a dialog fades out, after its connector has been let go of
  const lastNamed = useRef<{ disabling: string; removing: string }>({ disabling: "", removing: "" });
  if (disabling) lastNamed.current.disabling = disabling.name;
  if (removing) lastNamed.current.removing = removing.name;

  const showCode = async (c: SiteConnector) => {
    try {
      setCode(await pairing.mutateAsync(c.id));
      pairing.reset();
    } catch (e) {
      toast({
        title: "Could not make a code",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    }
  };

  const setActive = async (c: SiteConnector, isActive: boolean) => {
    try {
      await update.mutateAsync({ id: c.id, changes: { isActive } });
    } catch (e) {
      toast({
        title: "Could not change it",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    }
  };

  const list = connectors.data?.connectors ?? [];
  const busy = pairing.isPending || update.isPending;
  return (
    <div className="space-y-4" data-testid="connectors-tab">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-slate-600">
          A <b>site connector</b> is a small program on a computer at a factory. It reaches that factory&apos;s
          biometric devices and reports to the HRMS, so devices on a network this server cannot reach can still be read,
          fetched from and managed here. It only calls out to the HRMS: nothing has to be opened in the factory&apos;s
          firewall.
        </p>
        <Button className="gap-1.5" onClick={() => setAdding(true)} data-testid="connector-add">
          <Plus size={14} /> Add a connector
        </Button>
      </div>

      {connectors.isLoading ? (
        <CircleLoader texts={["UK Textiles", "Site connectors", "Loading"]} />
      ) : connectors.isError && !connectors.data ? (
        <Card className="rounded-2xl ring-1 ring-red-200">
          <CardContent
            className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm text-red-700"
            data-testid="connectors-error"
          >
            <span>The connectors could not be loaded: {(connectors.error as Error)?.message}.</span>
            <Button size="sm" variant="outline" onClick={() => connectors.refetch()}>
              Try again
            </Button>
          </CardContent>
        </Card>
      ) : list.length === 0 ? (
        <Card className="rounded-2xl">
          <CardContent
            className="flex flex-col items-center gap-3 px-6 py-14 text-center"
            data-testid="connectors-empty"
          >
            <div className="rounded-2xl bg-blue-50 p-4 text-blue-600">
              <Cable size={26} />
            </div>
            <p className="font-bold text-gray-900">No site connector yet</p>
            <p className="max-w-md text-sm text-muted-foreground">
              Add one for each factory whose devices this server cannot reach, install it on a computer there, and pair
              it with the code you are shown.
            </p>
            <div className="flex items-center gap-1.5 text-xs text-slate-500">
              <CheckCircle2 size={13} className="text-emerald-600" /> Devices that push to the server keep doing so
              either way.
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {list.map((c) => (
            <ConnectorCard
              key={c.id}
              c={c}
              busy={busy}
              onCode={showCode}
              onSettings={setSettings}
              onToggle={(target) => (target.isActive ? setDisabling(target) : setActive(target, true))}
              onRemove={setRemoving}
            />
          ))}
        </div>
      )}

      {adding && (
        <AddDialog
          onClose={() => setAdding(false)}
          onMade={(made) => {
            setAdding(false);
            setCode(made);
          }}
        />
      )}
      {code && <PairingCodeDialog made={code} onClose={() => setCode(null)} />}
      {settings && <SettingsDialog connector={settings} onClose={() => setSettings(null)} />}

      <AlertDialog open={disabling != null} onOpenChange={(o) => !o && setDisabling(null)}>
        <AlertDialogContent data-testid="connector-disable-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Disable “{disabling?.name ?? lastNamed.current.disabling}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The connector is locked out at its next call and anything it is working on is ended. Its devices show as
              disconnected until it is enabled again; punches the devices push to the server still arrive.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const target = disabling;
                setDisabling(null);
                if (target) void setActive(target, false);
              }}
              data-testid="connector-disable-confirm"
            >
              Disable
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={removing != null} onOpenChange={(o) => !o && setRemoving(null)}>
        <AlertDialogContent data-testid="connector-remove-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Remove “{removing?.name ?? lastNamed.current.removing}”?</AlertDialogTitle>
            <AlertDialogDescription>
              {removing && removing.devices.length > 0
                ? `Its ${removing.devices.length} device(s) go back to being connected directly from the server, which usually cannot reach a factory network: they will show as disconnected until they are given another connector. `
                : ""}
              The program on the factory computer stops working and can be uninstalled. Nothing already in the HRMS is
              deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 text-white hover:bg-red-700"
              onClick={async () => {
                const target = removing;
                setRemoving(null);
                if (!target) return;
                try {
                  await remove.mutateAsync(target.id);
                  toast({ title: `Removed ${target.name}` });
                } catch (e) {
                  toast({
                    title: "Could not remove it",
                    description: e instanceof Error ? e.message : undefined,
                    variant: "destructive",
                  });
                }
              }}
              data-testid="connector-remove-confirm"
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

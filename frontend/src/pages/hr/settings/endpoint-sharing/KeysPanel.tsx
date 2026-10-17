import { useState } from "react";
import { KeyRound, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  useCreateSharedKey,
  useRevokeSharedKey,
  useSharedKeys,
  type SharedKey,
  type SharedKeyCreated,
} from "@/lib/api-client/custom-hooks";
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
import { todayIst } from "../compensation/form";
import { saveErrorText } from "../payroll/form";
import { stamp } from "./form";
import { CodeBox, Notice, Pill, Problem } from "./ui";

const STATUS: Record<SharedKey["status"], { label: string; tone: "good" | "bad" | "muted" }> = {
  active: { label: "Active", tone: "good" },
  revoked: { label: "Revoked", tone: "bad" },
  expired: { label: "Expired", tone: "muted" },
};

/** The expiry as the server reads it: a plain date means the end of that day in the factory's time. */
export function expiryOf(date: string): string | null {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

/**
 * API keys of one saved endpoint. A key is made and revoked at once (it does not wait for Save). The whole key is shown ONCE,
 * right after it is made, in a box with a copy button; after that only its first characters are ever shown. The secret is held
 * in this component's memory only and is dropped when the box is closed or the person leaves.
 */
export function KeysPanel({
  endpointId,
  readOnly,
  maxLive,
}: {
  endpointId: number | null;
  readOnly: boolean;
  maxLive: number;
}) {
  const { toast } = useToast();
  const keys = useSharedKeys(endpointId);
  const create = useCreateSharedKey(endpointId ?? 0);
  const revoke = useRevokeSharedKey(endpointId ?? 0);
  const [label, setLabel] = useState("");
  const [expires, setExpires] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [shown, setShown] = useState<SharedKeyCreated | null>(null);
  const [revoking, setRevoking] = useState<SharedKey | null>(null);

  if (endpointId === null) {
    return (
      <Notice testId="keys-needs-save">
        Save the endpoint first. Keys belong to a saved endpoint, so this box opens once it exists.
      </Notice>
    );
  }

  const live = (keys.data ?? []).filter((k) => k.status === "active").length;
  const today = todayIst();

  const make = async () => {
    const name = label.trim();
    if (name === "") return setProblem("Give the key a label, so you know who it was made for.");
    if (name.length > 100) return setProblem("The label is too long: 100 characters at most.");
    if (expires !== "" && (expiryOf(expires) === null || expires <= today)) {
      return setProblem("The expiry must be a day after today, or empty for a key that never expires.");
    }
    setProblem(null);
    try {
      const made = await create.mutateAsync({ label: name, expiresAt: expires ? expiryOf(expires) : null });
      setShown(made);
      setLabel("");
      setExpires("");
      toast({ title: "Key created", description: "Copy it now: it is never shown again." });
    } catch (err) {
      const message = saveErrorText(err) ?? "The key could not be created. Check the connection and try again.";
      setProblem(message);
      toast({ title: "Failed to create the key", description: message, variant: "destructive" });
    }
  };

  const doRevoke = async () => {
    const target = revoking;
    setRevoking(null);
    if (!target) return;
    try {
      await revoke.mutateAsync(target.id);
      toast({ title: "Key revoked", description: `${target.label} no longer works.` });
    } catch (err) {
      toast({
        title: "Failed to revoke the key",
        description: saveErrorText(err) ?? "Check the connection and try again.",
        variant: "destructive",
      });
    }
  };

  return (
    <div className="space-y-3" data-testid="keys-panel">
      <Notice testId="keys-immediate">
        Keys take effect at once: a new key works as soon as it is made and a revoked key stops at once. They do not
        wait for Save.
      </Notice>

      {shown && (
        <div
          className="space-y-2 rounded-lg border-2 border-amber-300 bg-amber-50 p-3"
          role="alert"
          data-testid="key-reveal"
        >
          <p className="flex items-center gap-1.5 text-[13px] font-bold text-amber-900">
            <KeyRound size={14} /> New key for {shown.label}: copy it now, it is never shown again
          </p>
          <p className="text-xs leading-snug text-amber-900">
            This is the only time the whole key is shown. The system keeps only a fingerprint of it, so nobody can read
            it back later, not even you. If it is lost, revoke it and make a new one. Keep it somewhere safe, such as
            your server's secret settings. Never put it in a web page.
          </p>
          <CodeBox code={shown.key} label="API key" testId="key-secret" copyLabel="Copy key" />
          <Button type="button" size="sm" onClick={() => setShown(null)} data-testid="key-hide">
            I have copied it, hide it
          </Button>
        </div>
      )}

      {!readOnly && (
        <div className="grid gap-3 rounded-lg border border-slate-200 p-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto] sm:items-end">
          <div className="space-y-1">
            <label htmlFor="es-key-label" className="text-xs font-semibold text-gray-700">
              Label for the new key
            </label>
            <Input
              id="es-key-label"
              value={label}
              maxLength={100}
              placeholder="For example: Intranet server"
              onChange={(e) => {
                setLabel(e.target.value);
                setProblem(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void make();
                }
              }}
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="es-key-expires" className="text-xs font-semibold text-gray-700">
              Expires on (optional)
            </label>
            <Input
              id="es-key-expires"
              type="date"
              min={today}
              value={expires}
              onChange={(e) => {
                setExpires(e.target.value);
                setProblem(null);
              }}
            />
          </div>
          <Button
            type="button"
            onClick={() => void make()}
            disabled={create.isPending || live >= maxLive}
            className="gap-1.5"
            data-testid="key-create"
          >
            {create.isPending ? <Loader2 size={13} className="animate-spin" /> : <KeyRound size={13} />}
            Create key
          </Button>
          <div className="sm:col-span-3">
            {problem && <Problem testId="key-error">{problem}</Problem>}
            <p className="text-xs text-slate-500">
              {live} of {maxLive} live keys. {live >= maxLive ? "Revoke one before making another." : ""} Leave the
              expiry empty for a key that works until you revoke it.
            </p>
          </div>
        </div>
      )}

      {keys.isLoading ? (
        <Skeleton className="h-24 w-full rounded-lg" data-testid="keys-loading" />
      ) : keys.isError ? (
        <div
          className="flex flex-wrap items-center gap-3 rounded-lg bg-red-50 p-3 text-sm text-red-800"
          data-testid="keys-error"
        >
          The keys could not be loaded.
          <Button size="sm" variant="outline" onClick={() => void keys.refetch()}>
            Try again
          </Button>
        </div>
      ) : (keys.data ?? []).length === 0 ? (
        <p className="text-sm text-slate-500" data-testid="keys-empty">
          No key yet, so nothing can be read from this endpoint. Make a key above.
        </p>
      ) : (
        <ul className="space-y-2" aria-label="API keys" data-testid="keys-table">
          {(keys.data ?? []).map((k) => (
            <li
              key={k.id}
              className="rounded-lg border border-slate-200 p-3"
              data-testid="key-row"
              data-status={k.status}
            >
              {/* the name, the status and the Revoke button come first: they are what a person looks for, and they are
                  reachable at any width because the row wraps instead of scrolling */}
              <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
                <div className="min-w-0 flex-1 basis-40">
                  <p className="break-words text-[13px] font-semibold text-slate-900" data-testid="key-label">
                    {k.label}
                  </p>
                  <p className="break-all font-mono text-xs text-slate-500">uks_{k.prefix}...</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Pill tone={STATUS[k.status].tone}>{STATUS[k.status].label}</Pill>
                  {k.status === "active" && !readOnly && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="text-red-700"
                      aria-label={`Revoke ${k.label}`}
                      data-testid="key-revoke"
                      onClick={() => setRevoking(k)}
                    >
                      Revoke
                    </Button>
                  )}
                </div>
              </div>
              <dl className="mt-2 grid gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
                {[
                  ["Created", stamp(k.createdAt, "-")],
                  ["Last used", k.lastUsedAt ? stamp(k.lastUsedAt) : "Never used"],
                  ["Expires", k.expiresAt ? stamp(k.expiresAt) : "Never"],
                ].map(([term, value]) => (
                  <div key={term} className="min-w-0">
                    <dt className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{term}</dt>
                    <dd className="break-words text-slate-800">{value}</dd>
                  </div>
                ))}
              </dl>
            </li>
          ))}
        </ul>
      )}

      <AlertDialog open={revoking !== null} onOpenChange={(open) => !open && setRevoking(null)}>
        <AlertDialogContent data-testid="confirm-revoke">
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke the key "{revoking?.label}"?</AlertDialogTitle>
            <AlertDialogDescription>
              The key stops working at once: every application that uses it is refused with "invalid key". This can not
              be undone. To give access again you make a new key.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep the key</AlertDialogCancel>
            <AlertDialogAction data-testid="confirm-revoke-yes" onClick={() => void doRevoke()}>
              Revoke the key
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

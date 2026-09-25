import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
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
import { useToast } from "@/hooks/use-toast";
import {
  useDeleteMobileAppVersion,
  useMobileAppVersions,
  usePublishMobileAppVersion,
  useUpdateMobileAppVersion,
  type MobileAppVersionEntry,
} from "@/lib/api-client/custom-hooks";
import {
  compareVersions,
  isDriveShareLink,
  isValidVersion,
  isWebLink,
  suggestNextVersion,
} from "@/lib/mobile-app-version";
import { CheckCircle2, Copy, Download, ExternalLink, Info, Rocket, Smartphone, Trash2 } from "lucide-react";

const NOTES_MAX = 4000;

const STEPS = [
  "Export the new APK.",
  "Upload it to Google Drive and share it as “Anyone with the link”.",
  "Paste the link and the version number here, then publish.",
  "Employees are asked to update the next time they open the app.",
];

function fmtDate(iso: string) {
  return new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

function errorMessage(e: unknown): string {
  const err = e as { data?: { error?: string }; message?: string };
  return err?.data?.error ?? err?.message ?? "Something went wrong";
}

/** What the employee sees in the app, so HR can check the wording before publishing. */
function EmployeePrompt({ version, notes, mandatory }: { version: string; notes: string; mandatory: boolean }) {
  return (
    <div className="rounded-2xl bg-slate-900 p-4" data-testid="version-preview">
      <div className="mx-auto max-w-[280px] rounded-2xl bg-white p-5 text-center shadow-xl">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-blue-50 text-blue-600">
          <Download size={22} />
        </div>
        <p className="text-base font-black text-gray-900">New Version Available</p>
        <p className="mt-1 text-xs text-gray-500">A new version of the mobile application is available.</p>
        <p className="mt-3 inline-block rounded-full bg-blue-50 px-3 py-1 text-xs font-bold text-blue-700">
          Version: {version.trim().replace(/^[vV]/, "") || "3.0.0"}
        </p>
        {notes.trim() && (
          <p className="mt-3 line-clamp-4 whitespace-pre-wrap text-left text-[11px] leading-relaxed text-gray-600">
            {notes.trim()}
          </p>
        )}
        <div className="mt-4 rounded-xl bg-blue-600 py-2.5 text-xs font-bold text-white">Download and Install</div>
        {!mandatory && <p className="mt-2 text-[11px] font-semibold text-gray-400">Later</p>}
      </div>
    </div>
  );
}

function VersionRow({ row }: { row: MobileAppVersionEntry }) {
  const { toast } = useToast();
  const update = useUpdateMobileAppVersion();
  const remove = useDeleteMobileAppVersion();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const toggleActive = (isActive: boolean) =>
    update.mutate(
      { id: row.id, isActive },
      {
        onSuccess: () =>
          toast({
            title: isActive ? `Version ${row.version} is live again` : `Version ${row.version} withdrawn`,
            description: isActive ? undefined : "Employees are no longer asked to install it.",
          }),
        onError: (e) => toast({ title: "Couldn't update", description: errorMessage(e), variant: "destructive" }),
      },
    );

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(row.downloadUrl);
      toast({ title: "Link copied" });
    } catch {
      toast({ title: "Couldn't copy", description: "Select the link and copy it by hand.", variant: "destructive" });
    }
  };

  return (
    <Card className="border-0 shadow-sm" data-testid="app-version-row" data-version={row.version}>
      <CardContent className="flex flex-wrap items-start gap-4 p-4">
        <div className="min-w-[240px] flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-lg font-black tabular-nums text-gray-900">v{row.version}</p>
            {row.isLatest && (
              <Badge variant="outline" className="border-green-200 bg-green-50 text-[10px] text-green-700">
                <CheckCircle2 size={10} className="mr-1" /> Latest — offered to employees
              </Badge>
            )}
            {!row.isActive && (
              <Badge variant="outline" className="border-gray-200 bg-gray-50 text-[10px] text-gray-500">
                Withdrawn
              </Badge>
            )}
            <Badge
              variant="outline"
              className={
                row.isMandatory
                  ? "border-amber-200 bg-amber-50 text-[10px] text-amber-700"
                  : "border-slate-200 bg-slate-50 text-[10px] text-slate-600"
              }
            >
              {row.isMandatory ? "Required update" : "Optional update"}
            </Badge>
          </div>
          <p className="text-[11px] text-gray-400">
            Published {fmtDate(row.createdAt)}
            {row.createdBy ? ` by ${row.createdBy}` : ""}
          </p>
          {row.releaseNotes && (
            <p className="line-clamp-3 whitespace-pre-wrap text-xs text-gray-600">{row.releaseNotes}</p>
          )}
          <div className="flex items-center gap-1.5">
            <a
              href={row.downloadUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="max-w-[360px] truncate text-[11px] text-blue-600 hover:underline"
              title={row.downloadUrl}
            >
              {row.downloadUrl}
            </a>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-6 w-6 shrink-0"
              onClick={copyLink}
              aria-label="Copy download link"
            >
              <Copy size={12} />
            </Button>
            <Button asChild variant="ghost" size="icon" className="h-6 w-6 shrink-0">
              <a href={row.downloadUrl} target="_blank" rel="noreferrer noopener" aria-label="Test the download link">
                <ExternalLink size={12} />
              </a>
            </Button>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs font-semibold text-gray-600">
            Offered
            <Switch
              checked={row.isActive}
              disabled={update.isPending}
              onCheckedChange={toggleActive}
              aria-label={`Offer version ${row.version} to employees`}
            />
          </label>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-red-500 hover:bg-red-50 hover:text-red-600"
            onClick={() => setConfirmDelete(true)}
            aria-label={`Delete version ${row.version}`}
          >
            <Trash2 size={14} />
          </Button>
        </div>
      </CardContent>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete version {row.version}?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the record from the list.
              {row.isLatest
                ? " Employees will be offered the next newest version instead, or nothing if there isn't one."
                : ""}{" "}
              The APK file itself stays wherever you uploaded it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              onClick={() =>
                remove.mutate(row.id, {
                  onSuccess: () => toast({ title: `Version ${row.version} deleted` }),
                  onError: (e) =>
                    toast({ title: "Couldn't delete", description: errorMessage(e), variant: "destructive" }),
                })
              }
            >
              Delete version
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

export default function NewVersionTab() {
  const { toast } = useToast();
  const { data: versions = [], isLoading, isError, refetch } = useMobileAppVersions();
  const publish = usePublishMobileAppVersion();

  const [version, setVersion] = useState("");
  const [link, setLink] = useState("");
  const [notes, setNotes] = useState("");
  const [mandatory, setMandatory] = useState(true);

  const latest = versions.find((v) => v.isLatest);
  const suggestion = latest ? suggestNextVersion(latest.version) : null;

  const versionEntered = version.trim() !== "";
  const versionOk = isValidVersion(version);
  const alreadyPublished = versionOk && versions.some((v) => compareVersions(v.version, version) === 0);
  const notNewer = versionOk && !alreadyPublished && !!latest && compareVersions(version, latest.version) < 0;
  const linkEntered = link.trim() !== "";
  const linkOk = isWebLink(link);
  const canPublish = versionOk && !alreadyPublished && linkOk && notes.length <= NOTES_MAX && !publish.isPending;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canPublish) return;
    publish.mutate(
      { version: version.trim(), downloadUrl: link.trim(), releaseNotes: notes.trim(), isMandatory: mandatory },
      {
        onSuccess: (row) => {
          toast({
            title: `Version ${row.version} published`,
            description: "Employees will be asked to update the next time they open the app.",
          });
          setVersion("");
          setLink("");
          setNotes("");
          setMandatory(true);
        },
        onError: (err) => toast({ title: "Couldn't publish", description: errorMessage(err), variant: "destructive" }),
      },
    );
  };

  return (
    <div className="space-y-6" data-testid="new-version-tab">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <Card className="border-0 shadow-sm">
          <CardContent className="p-5">
            <div className="mb-4 flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-50 text-blue-600">
                <Rocket size={16} />
              </div>
              <div>
                <p className="text-sm font-bold text-gray-900">Publish a new version</p>
                <p className="text-[11px] text-gray-500">Employees are asked to install it from inside the app.</p>
              </div>
            </div>

            <form onSubmit={submit} className="space-y-4" noValidate>
              <div className="space-y-1.5">
                <Label htmlFor="app-version">Mobile app version</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="app-version"
                    data-testid="input-app-version"
                    value={version}
                    onChange={(e) => setVersion(e.target.value)}
                    placeholder="e.g. 3.0.1"
                    inputMode="decimal"
                    autoComplete="off"
                    className="max-w-[200px]"
                    aria-invalid={versionEntered && (!versionOk || alreadyPublished)}
                  />
                  {suggestion && !versionEntered && (
                    <button
                      type="button"
                      className="rounded-full border px-2.5 py-1 text-[11px] font-semibold text-gray-600 hover:bg-gray-50"
                      onClick={() => setVersion(suggestion)}
                    >
                      Use {suggestion}
                    </button>
                  )}
                </div>
                {versionEntered && !versionOk && (
                  <p className="text-[11px] text-red-600">Use numbers separated by dots, like 3.0.1.</p>
                )}
                {alreadyPublished && (
                  <p className="text-[11px] text-red-600">Version {version.trim()} is already published.</p>
                )}
                {notNewer && (
                  <p className="text-[11px] text-amber-700">
                    This is lower than the latest published version (v{latest?.version}), so employees on the latest
                    won't be asked to install it.
                  </p>
                )}
                {!versionEntered && latest && (
                  <p className="text-[11px] text-gray-400">Latest published: v{latest.version}</p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="app-link">APK download link</Label>
                <Input
                  id="app-link"
                  data-testid="input-app-link"
                  value={link}
                  onChange={(e) => setLink(e.target.value)}
                  placeholder="https://drive.google.com/file/d/…/view?usp=sharing"
                  inputMode="url"
                  autoComplete="off"
                  aria-invalid={linkEntered && !linkOk}
                />
                {linkEntered && !linkOk ? (
                  <p className="text-[11px] text-red-600">Enter the full link, starting with https://</p>
                ) : isDriveShareLink(link) ? (
                  <p className="flex items-center gap-1 text-[11px] text-green-700">
                    <CheckCircle2 size={11} /> Google Drive link — it will be turned into a direct download.
                  </p>
                ) : (
                  <p className="text-[11px] text-gray-400">
                    A Google Drive share link, or any link that downloads the APK.
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <div className="flex items-baseline justify-between">
                  <Label htmlFor="app-notes">Release information</Label>
                  <span
                    className={`text-[11px] tabular-nums ${notes.length > NOTES_MAX ? "text-red-600" : "text-gray-400"}`}
                  >
                    {notes.length}/{NOTES_MAX}
                  </span>
                </div>
                <Textarea
                  id="app-notes"
                  data-testid="input-app-notes"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder={"What's new in this version?\n• Chat input fixed\n• Faster start-up"}
                  rows={4}
                />
              </div>

              <div className="flex items-start justify-between gap-4 rounded-xl bg-slate-50 p-3">
                <div>
                  <Label htmlFor="app-mandatory" className="text-sm">
                    Required update
                  </Label>
                  <p className="mt-0.5 text-[11px] text-gray-500">
                    On: employees can't close the prompt until they update. Off: they can choose “Later”.
                  </p>
                </div>
                <Switch id="app-mandatory" checked={mandatory} onCheckedChange={setMandatory} />
              </div>

              <div className="flex justify-end">
                <Button type="submit" data-testid="button-publish-version" disabled={!canPublish} className="gap-1.5">
                  <Rocket size={14} /> {publish.isPending ? "Publishing…" : "Publish version"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card className="border-0 shadow-sm">
            <CardContent className="p-5">
              <p className="mb-3 flex items-center gap-1.5 text-sm font-bold text-gray-900">
                <Smartphone size={15} /> What employees will see
              </p>
              <EmployeePrompt version={version} notes={notes} mandatory={mandatory} />
            </CardContent>
          </Card>

          <div className="flex items-start gap-2 rounded-lg border bg-slate-50 p-3 text-[11px] leading-relaxed text-slate-600">
            <Info size={13} className="mt-0.5 shrink-0" />
            <ol className="list-decimal space-y-0.5 pl-4">
              {STEPS.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <p className="text-sm font-bold text-gray-900">
          Published versions
          {versions.length > 0 && <span className="ml-2 text-xs font-medium text-gray-400">{versions.length}</span>}
        </p>
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-24 w-full rounded-xl" />
            <Skeleton className="h-24 w-full rounded-xl" />
          </div>
        ) : isError ? (
          <Card className="border-0 shadow-sm">
            <CardContent className="py-10 text-center">
              <p className="text-sm text-gray-500">Couldn't load the published versions.</p>
              <Button variant="outline" size="sm" className="mt-3" onClick={() => refetch()}>
                Try again
              </Button>
            </CardContent>
          </Card>
        ) : versions.length === 0 ? (
          <Card className="border-0 shadow-sm">
            <CardContent className="py-12 text-center">
              <Rocket size={30} className="mx-auto mb-3 text-gray-200" />
              <p className="text-sm text-gray-500">No versions published yet.</p>
              <p className="mt-0.5 text-xs text-gray-400">
                Publish one above and employees will be asked to install it.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-2">
            {versions.map((row) => (
              <VersionRow key={row.id} row={row} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

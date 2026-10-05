import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Crown,
  KeyRound,
  Loader2,
  PlugZap,
  Save,
  ShieldCheck,
  Sparkles,
  UserPlus,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import {
  getListHrUsersQueryKey,
  useMdAssistantSettings,
  useTestMdAssistant,
  useUpdateHrUser,
  useUpdateMdAssistantSettings,
  type HrUserItem,
  type MdAssistantSettings,
  type MdAssistantTestResult,
  type ThinkingLevel,
} from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { relativeTime } from "./logic";
import { AccountAvatar, MdChip } from "./parts";

const DEFAULT_MODELS = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.8-flash"];
const THINKING: { value: ThinkingLevel; label: string; hint: string }[] = [
  { value: "minimal", label: "Minimal", hint: "fastest, lightest" },
  { value: "low", label: "Low", hint: "recommended" },
  { value: "medium", label: "Medium", hint: "more careful, slower" },
  { value: "high", label: "High", hint: "deepest, slowest" },
];

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3 border-t border-gray-100 pt-4 first:border-t-0 first:pt-0">
      <div>
        <h4 className="text-sm font-bold text-gray-900">{title}</h4>
        {hint && <p className="mt-0.5 text-xs text-gray-500">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

// ─── who is the MD ──────────────────────────────────────────────────────────────────────────────────────────────

function MdIdentityCard({
  users,
  onCreate,
  onEdit,
}: {
  users: HrUserItem[];
  onCreate: () => void;
  onEdit: (user: HrUserItem) => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const updateUser = useUpdateHrUser();
  const md = useMemo(() => users.find((u) => u.isMd) ?? null, [users]);
  const candidates = useMemo(() => users.filter((u) => u.isActive && !u.isSuperAdmin && !u.isMd), [users]);
  const [choice, setChoice] = useState("");
  const [confirmingChange, setConfirmingChange] = useState(false);
  const chosen = candidates.find((u) => String(u.id) === choice) ?? null;

  const apply = async (user: HrUserItem, data: { isMd: boolean; replaceMd?: boolean }, done: string) => {
    try {
      await updateUser.mutateAsync({ id: user.id, data: { ...data, ...(data.isMd ? { branchId: null } : {}) } });
      await queryClient.invalidateQueries({ queryKey: getListHrUsersQueryKey() });
      setChoice("");
      setConfirmingChange(false);
      toast({ title: done });
    } catch (e: unknown) {
      toast({
        title: "Could not change the MD",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    }
  };

  return (
    <Card className="overflow-hidden rounded-2xl border-[#e0a83a]/40" data-testid="md-identity-card">
      <div className="h-1.5 w-full" style={{ background: "linear-gradient(90deg, #f6d27a, #e0a83a)" }} />
      <CardContent className="space-y-4 p-5">
        <div className="flex items-start gap-3">
          <span className="rounded-xl bg-[#fff1cc] p-2.5 text-[#7a5410]">
            <Crown size={20} />
          </span>
          <div>
            <h3 className="text-base font-black text-gray-900">Managing Director</h3>
            <p className="mt-0.5 text-xs text-gray-600">
              One account gets the executive portal (dashboards, analytics, reports) and the AI assistant. No other
              account is affected.
            </p>
          </div>
        </div>

        {md ? (
          <div
            className="flex items-center gap-3 rounded-xl border border-[#e0a83a]/40 bg-[#fffaf0] p-3.5"
            data-testid="md-current"
          >
            <AccountAvatar username={md.username} fullName={md.fullName} md size="lg" />
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-1.5 font-bold text-gray-900">
                {md.fullName || md.username} <MdChip label="Managing Director" />
              </p>
              <p className="truncate text-xs text-gray-600">
                {md.username}
                {md.mdAssignedAt ? ` · assigned ${relativeTime(md.mdAssignedAt)}` : ""} · last sign-in{" "}
                {relativeTime(md.lastLogin)}
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={() => onEdit(md)} data-testid="md-edit">
              Edit account
            </Button>
          </div>
        ) : (
          <div
            className="rounded-xl border border-dashed border-[#e0a83a]/60 bg-[#fffaf0] p-4 text-center"
            data-testid="md-none"
          >
            <p className="font-bold text-gray-900">No Managing Director is assigned</p>
            <p className="mx-auto mt-1 max-w-sm text-xs text-gray-600">
              Create the MD's login, or pick an existing account. The MD signs in at the usual HR login page and lands
              on the MD portal.
            </p>
          </div>
        )}

        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={onCreate} className="gap-1.5" data-testid="md-create">
              <UserPlus size={15} /> Create MD account
            </Button>
          </div>
          {candidates.length > 0 && (
            <div className="rounded-xl border bg-white p-3">
              <Label className="text-xs font-semibold text-gray-700">
                {md ? "Or move the MD identity to another account" : "Or make an existing account the MD"}
              </Label>
              <div className="mt-1.5 flex flex-col gap-2 sm:flex-row">
                <Select
                  value={choice}
                  onValueChange={(v) => {
                    setChoice(v);
                    setConfirmingChange(false);
                  }}
                >
                  <SelectTrigger className="sm:flex-1" aria-label="Account to make the MD" data-testid="md-pick">
                    <SelectValue placeholder="Choose an account" />
                  </SelectTrigger>
                  <SelectContent>
                    {candidates.map((u) => (
                      <SelectItem key={u.id} value={String(u.id)}>
                        {u.fullName ? `${u.fullName} (${u.username})` : u.username}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {md && chosen && !confirmingChange ? (
                  <Button variant="outline" onClick={() => setConfirmingChange(true)} data-testid="md-change">
                    Change MD…
                  </Button>
                ) : (
                  <Button
                    disabled={!chosen || updateUser.isPending}
                    onClick={() =>
                      chosen &&
                      apply(
                        chosen,
                        { isMd: true, ...(md ? { replaceMd: true } : {}) },
                        `${chosen.username} is now the Managing Director`,
                      )
                    }
                    data-testid="md-assign"
                  >
                    {updateUser.isPending ? "Saving…" : md ? "Yes, move it" : "Make MD"}
                  </Button>
                )}
              </div>
              {md && chosen && confirmingChange && (
                <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-900" data-testid="md-change-warning">
                  <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                  {md.fullName || md.username} will lose the MD portal and the AI assistant, and{" "}
                  {chosen.fullName || chosen.username} gets them.
                </p>
              )}
              {chosen?.branchId != null && (
                <p className="mt-2 text-xs text-gray-500">
                  This account is limited to one branch; making it the MD makes it company-wide.
                </p>
              )}
            </div>
          )}
          {md && (
            <button
              type="button"
              onClick={() => apply(md, { isMd: false }, "MD access removed")}
              className="text-xs font-semibold text-red-700 hover:underline"
              data-testid="md-remove"
            >
              Remove MD access from {md.username}
            </button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── the assistant's settings ───────────────────────────────────────────────────────────────────────────────────

type Form = {
  enabled: boolean;
  privacyMode: boolean;
  model: string;
  fallbackModels: string;
  thinkingLevel: ThinkingLevel;
  maxToolRounds: string;
  requestsPerMinute: string;
};

const toForm = (s: MdAssistantSettings): Form => ({
  enabled: s.enabled,
  privacyMode: s.privacyMode,
  model: s.model,
  fallbackModels: s.fallbackModels.join(", "),
  thinkingLevel: s.thinkingLevel,
  maxToolRounds: String(s.maxToolRounds),
  requestsPerMinute: String(s.requestsPerMinute),
});

function AssistantSettingsCard() {
  const { toast } = useToast();
  const { data: settings, isLoading, isError } = useMdAssistantSettings();
  const save = useUpdateMdAssistantSettings();
  const test = useTestMdAssistant();
  const [form, setForm] = useState<Form | null>(null);
  const [result, setResult] = useState<MdAssistantTestResult | null>(null);

  useEffect(() => {
    if (settings && form === null) setForm(toForm(settings));
  }, [settings, form]);

  if (isLoading || !settings || !form) {
    return (
      <Card className="rounded-2xl">
        <CardContent className="p-8 text-center text-sm text-gray-500">
          {isError ? "The assistant settings could not be loaded." : "Loading…"}
        </CardContent>
      </Card>
    );
  }

  const set = (patch: Partial<Form>) => setForm({ ...form, ...patch });
  const dirty = JSON.stringify(form) !== JSON.stringify(toForm(settings));
  const models = Array.from(new Set([...(result?.availableModels ?? []), ...DEFAULT_MODELS]));

  const submit = async () => {
    try {
      await save.mutateAsync({
        enabled: form.enabled,
        privacyMode: form.privacyMode,
        model: form.model.trim(),
        fallbackModels: form.fallbackModels
          .split(",")
          .map((m) => m.trim())
          .filter(Boolean),
        thinkingLevel: form.thinkingLevel,
        maxToolRounds: Number(form.maxToolRounds),
        requestsPerMinute: Number(form.requestsPerMinute),
      });
      setForm(null); // reloads from the saved settings
      toast({ title: "Assistant settings saved" });
    } catch (e: unknown) {
      toast({
        title: "Could not save",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    }
  };

  const runTest = async () => {
    setResult(null);
    try {
      setResult(await test.mutateAsync());
    } catch (e: unknown) {
      setResult({ ok: false, error: e instanceof Error ? e.message : "The test could not run." });
    }
  };

  return (
    <Card className="rounded-2xl" data-testid="md-assistant-card">
      <CardContent className="space-y-5 p-5">
        <div className="flex items-start gap-3">
          <span className="rounded-xl bg-blue-50 p-2.5 text-blue-700">
            <Sparkles size={20} />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-black text-gray-900">AI assistant (Google Gemini)</h3>
            <p className="mt-0.5 text-xs text-gray-600">
              Text and voice. It can only <b>read</b> company data and explains how it got every answer. It can never
              change anything.
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm font-semibold">
            <Switch
              checked={form.enabled}
              onCheckedChange={(enabled) => set({ enabled })}
              data-testid="assistant-enabled"
              aria-label="Assistant enabled"
            />
            {form.enabled ? "On" : "Off"}
          </label>
        </div>

        <Section
          title="Connection"
          hint="The key is never stored in the database or shown here: it is read from the server's environment."
        >
          <div
            className={cn(
              "flex items-start gap-2.5 rounded-xl border p-3 text-sm",
              settings.keyConfigured
                ? "border-green-200 bg-green-50 text-green-900"
                : "border-amber-200 bg-amber-50 text-amber-900",
            )}
            data-testid="assistant-key-status"
          >
            {settings.keyConfigured ? (
              <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
            ) : (
              <KeyRound size={16} className="mt-0.5 shrink-0" />
            )}
            <div className="text-xs leading-relaxed">
              {settings.keyConfigured ? (
                <p>
                  <b>A Gemini API key is set on the server.</b> Use “Test connection” to check that it works.
                </p>
              ) : (
                <>
                  <p>
                    <b>No Gemini API key yet.</b> Create one in Google AI Studio, add this line to{" "}
                    <code className="rounded bg-white/70 px-1">backend/.env</code>, then restart the backend:
                  </p>
                  <p className="mt-1 rounded bg-white/70 px-1.5 py-1 font-mono">GEMINI_API_KEY=your-key-here</p>
                </>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="outline"
              onClick={runTest}
              disabled={test.isPending || !settings.keyConfigured}
              className="gap-1.5"
              data-testid="assistant-test"
            >
              {test.isPending ? <Loader2 size={14} className="animate-spin" /> : <PlugZap size={14} />} Test connection
            </Button>
            <p className="text-xs text-gray-500" data-testid="assistant-usage">
              Today: <b>{settings.usage.requests}</b> Gemini request{settings.usage.requests === 1 ? "" : "s"}
              {settings.usage.limitHit ? ` · daily limit reached, resets about ${settings.usage.resetsAt}` : ""}
            </p>
          </div>
          {result && (
            <p
              className={cn(
                "rounded-lg border p-2.5 text-xs",
                result.ok ? "border-green-200 bg-green-50 text-green-900" : "border-red-200 bg-red-50 text-red-900",
              )}
              role="status"
              data-testid="assistant-test-result"
            >
              {result.ok
                ? `Connected: ${result.model} answered in ${result.ms} ms.${result.availableModels?.length ? ` ${result.availableModels.length} models are available to this key.` : ""}`
                : result.error}
            </p>
          )}
        </Section>

        <Section
          title="Model"
          hint="Google retires and renames models, so this is a setting. The fallbacks are tried in order if the first is busy or its daily allowance is used up."
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="assistant-model">Main model</Label>
              <Input
                id="assistant-model"
                list="assistant-model-list"
                value={form.model}
                onChange={(e) => set({ model: e.target.value })}
                data-testid="assistant-model"
              />
              <datalist id="assistant-model-list">
                {models.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="assistant-fallbacks">Fallback models</Label>
              <Input
                id="assistant-fallbacks"
                value={form.fallbackModels}
                onChange={(e) => set({ fallbackModels: e.target.value })}
                placeholder="comma separated"
                data-testid="assistant-fallbacks"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Thinking depth</Label>
              <Select value={form.thinkingLevel} onValueChange={(v) => set({ thinkingLevel: v as ThinkingLevel })}>
                <SelectTrigger data-testid="assistant-thinking">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {THINKING.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      {t.label} · {t.hint}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="assistant-rounds">Lookup rounds</Label>
                <Input
                  id="assistant-rounds"
                  type="number"
                  min={1}
                  max={8}
                  value={form.maxToolRounds}
                  onChange={(e) => set({ maxToolRounds: e.target.value })}
                  data-testid="assistant-rounds"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="assistant-rpm">Requests / min</Label>
                <Input
                  id="assistant-rpm"
                  type="number"
                  min={1}
                  max={60}
                  value={form.requestsPerMinute}
                  onChange={(e) => set({ requestsPerMinute: e.target.value })}
                  data-testid="assistant-rpm"
                />
              </div>
            </div>
          </div>
        </Section>

        <Section title="Privacy">
          <div className="rounded-xl border bg-gray-50/70 p-3">
            <div className="flex items-start gap-3">
              <ShieldCheck size={18} className="mt-0.5 shrink-0 text-green-600" />
              <div className="min-w-0 flex-1">
                <Label htmlFor="assistant-privacy" className="font-bold">
                  Hide employee names from Gemini
                </Label>
                <p className="mt-0.5 text-xs text-gray-600">
                  Names become codes before anything leaves the server, and come back in the answer the MD reads. Phone
                  numbers, e-mail and bank details are never sent, whatever this says.
                </p>
              </div>
              <Switch
                id="assistant-privacy"
                checked={form.privacyMode}
                onCheckedChange={(privacyMode) => set({ privacyMode })}
                data-testid="assistant-privacy"
              />
            </div>
          </div>
          <p className="flex items-start gap-1.5 rounded-lg bg-amber-50 p-2.5 text-xs text-amber-900">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            <span>
              On Google's <b>free tier</b>, what is sent may be used to improve Google's products and read by reviewers.
              For real payroll and HR data, enable billing on the Google project (Paid Services terms) before relying on
              the assistant.
            </span>
          </p>
        </Section>

        <div className="flex items-center justify-between gap-3 border-t border-gray-100 pt-4">
          <p className="text-xs text-gray-500">
            {settings.updatedAt
              ? `Last saved ${relativeTime(settings.updatedAt)}${settings.updatedBy ? ` by ${settings.updatedBy}` : ""}.`
              : "Not changed yet."}
          </p>
          <Button onClick={submit} disabled={!dirty || save.isPending} className="gap-1.5" data-testid="assistant-save">
            <Save size={15} /> {save.isPending ? "Saving…" : "Save settings"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/** Account Management > MD profile: who the Managing Director is, and how the MD's AI assistant behaves. */
export default function MdProfileTab({
  users,
  onCreateMd,
  onEditUser,
}: {
  users: HrUserItem[];
  onCreateMd: () => void;
  onEditUser: (user: HrUserItem) => void;
}) {
  return (
    <div
      className="grid items-start gap-5 pt-3 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]"
      data-testid="md-profile-tab"
    >
      <MdIdentityCard users={users} onCreate={onCreateMd} onEdit={onEditUser} />
      <AssistantSettingsCard />
    </div>
  );
}

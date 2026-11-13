import { useState } from "react";
import { useLocation } from "wouter";
import HrLayout from "@/components/HrLayout";
import { RefreshButton } from "@/components/PageRefreshBar";
import NewVersionTab from "./mobile-app/NewVersionTab";
import MobileMessagesTab from "./mobile-app/MobileMessagesTab";
import { useToast } from "@/hooks/use-toast";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { PillTabs } from "@/components/ui/pill-tabs";
import { CircleLoader } from "@/components/ui/CircleLoader";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { isRouteViewOnly, useAuth } from "@/contexts/AuthContext";
import { moduleForPath } from "@/lib/permission-modules";
import { Gate, pickVisible, useLevel, useViewOnlyLock, ViewOnlyTabNote, visibleItems } from "@/lib/tab-access";
import {
  Smartphone,
  Search,
  KeyRound,
  ShieldCheck,
  ShieldAlert,
  UserX,
  Users,
  Eye,
  EyeOff,
  Info,
  Trash2,
  Wand2,
  FileSpreadsheet,
  Rocket,
  BellRing,
} from "lucide-react";
import {
  useMobileAppLogins,
  useResetMobileAppPassword,
  downloadMobileAppLoginsExcel,
  type MobileAppLoginEntry,
  type MobileAppLoginFilters,
} from "@/lib/api-client/custom-hooks";

function fmtTime(iso: string | null) {
  if (!iso) return null;
  return new Date(iso).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function StatCard({
  label,
  value,
  sub,
  icon: Icon,
  color,
}: {
  label: string;
  value: number | string;
  sub?: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  color: string;
}) {
  return (
    <div className={`rounded-2xl p-4 flex items-start gap-3 ${color}`}>
      <div className="mt-0.5 opacity-80">
        <Icon size={18} />
      </div>
      <div>
        <p className="text-xs font-medium opacity-70">{label}</p>
        <p className="text-2xl font-black">{value}</p>
        {sub && <p className="text-xs opacity-60 mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}

// Avoids look-alike characters (0/O, 1/l/I) since HR reads these out loud
// or writes them down for the employee.
const PW_ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
function generatePassword(len = 10) {
  const bytes = new Uint32Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => PW_ALPHABET[b % PW_ALPHABET.length]).join("");
}

function ResetPasswordDialog({ employee, onClose }: { employee: MobileAppLoginEntry | null; onClose: () => void }) {
  const { toast } = useToast();
  const reset = useResetMobileAppPassword();
  const [password, setPassword] = useState("");
  const [reveal, setReveal] = useState(false);

  if (!employee) return null;

  const tooShort = password.length > 0 && password.length < 8;

  const close = () => {
    setPassword("");
    setReveal(false);
    onClose();
  };

  const handleSet = () => {
    reset.mutate(
      { employeeId: employee.id, password },
      {
        onSuccess: (r) => {
          toast({
            title: "Password updated",
            description: `${r.message} Share it with them directly — it can't be looked up later.`,
          });
          close();
        },
        onError: (e: any) =>
          toast({
            title: "Failed to update password",
            description: e?.data?.error ?? e?.message,
            variant: "destructive",
          }),
      },
    );
  };

  const handleClear = () => {
    reset.mutate(
      { employeeId: employee.id, clear: true },
      {
        onSuccess: (r) => {
          toast({ title: "Password cleared", description: r.message });
          close();
        },
        onError: (e: any) =>
          toast({
            title: "Failed to clear password",
            description: e?.data?.error ?? e?.message,
            variant: "destructive",
          }),
      },
    );
  };

  return (
    <Dialog open onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound size={16} /> {employee.hasPassword ? "Reset" : "Set"} mobile app password
          </DialogTitle>
        </DialogHeader>

        <div className="text-sm">
          <p className="font-bold text-gray-900">{employee.name}</p>
          <p className="text-xs text-gray-500">
            {employee.employeeCode}
            {employee.department ? ` · ${employee.department}` : ""}
          </p>
        </div>

        <div className="flex gap-2 items-start rounded-lg bg-amber-50 text-amber-900 p-2.5 text-[11px] leading-relaxed">
          <Info size={13} className="mt-0.5 shrink-0" />
          <span>
            Existing passwords are stored as one-way hashes and can never be displayed or recovered — not here, not
            anywhere. To help someone who has forgotten theirs, set a new password below and pass it on.
          </span>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-semibold text-gray-700">New password</label>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Input
                type={reveal ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 8 characters"
                className="pr-9"
                autoComplete="new-password"
              />
              <button
                type="button"
                onClick={() => setReveal((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                aria-label={reveal ? "Hide password" : "Show password"}
              >
                {reveal ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1.5 text-xs shrink-0"
              onClick={() => {
                setPassword(generatePassword());
                setReveal(true);
              }}
            >
              <Wand2 size={13} /> Generate
            </Button>
          </div>
          {tooShort && <p className="text-[11px] text-red-600">Must be at least 8 characters.</p>}
        </div>

        <div className="flex items-center justify-between gap-2 pt-1">
          {employee.hasPassword ? (
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 text-xs text-red-600 hover:text-red-700 hover:bg-red-50"
              disabled={reset.isPending}
              onClick={handleClear}
            >
              <Trash2 size={13} /> Clear password
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="outline" size="sm" className="text-xs" onClick={close}>
              Cancel
            </Button>
            <Button size="sm" className="text-xs" disabled={password.length < 8 || reset.isPending} onClick={handleSet}>
              {reset.isPending ? "Saving…" : employee.hasPassword ? "Reset password" : "Set password"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const ACCESS_TABS = [
  { value: "all", label: "All" },
  { value: "no_access", label: "Never set up" },
  { value: "has_access", label: "Has access" },
  { value: "signed_in", label: "Signed in" },
] as const;

type PageView = "logins" | "messages" | "version";

const PAGE_TABS: { value: PageView; label: string; icon: React.ReactNode }[] = [
  { value: "logins", label: "Login Status", icon: <Smartphone size={12} /> },
  { value: "messages", label: "Mobile Messages", icon: <BellRing size={12} /> },
  { value: "version", label: "New Version", icon: <Rocket size={12} /> },
];

// Each tab has its own permission key (Account Management -> Mobile App Login); with no setting of its own it follows the page.
const PAGE_TAB_MODULE: Record<PageView, string> = {
  logins: "mobile_app_login.logins",
  messages: "mobile_app_login.messages",
  version: "mobile_app_login.version",
};

/** The Login Status list's filters: kept by the page, so the header's Export uses the same ones as the list. */
type LoginFilters = {
  access: MobileAppLoginFilters["access"];
  status: MobileAppLoginFilters["status"];
  search: string;
};

/**
 * The header's "Export to Excel" (Login Status only). It reads the same list as the tab (one request: React Query shares
 * it), so the count on the button is the list's.
 */
function LoginsExportButton({ filters }: { filters: LoginFilters }) {
  const { toast } = useToast();
  const [exporting, setExporting] = useState(false);
  const { data, isLoading } = useMobileAppLogins(filters);
  const rows = data?.results ?? [];

  const handleExport = async () => {
    setExporting(true);
    try {
      await downloadMobileAppLoginsExcel(filters);
      toast({
        title: "Export downloaded",
        description: `${rows.length} staff exported to Excel.`,
      });
    } catch (e: any) {
      toast({ title: "Export failed", description: e?.message, variant: "destructive" });
    } finally {
      setExporting(false);
    }
  };

  return (
    <Button
      variant="outline"
      size="sm"
      className="gap-1.5 text-xs"
      onClick={handleExport}
      disabled={exporting || isLoading || rows.length === 0}
    >
      <FileSpreadsheet size={13} />
      {exporting ? "Exporting…" : `Export to Excel${rows.length ? ` (${rows.length})` : ""}`}
    </Button>
  );
}

/**
 * Login Status: who can get into the employee app. Mounted only while its tab is open (and visible to the role), so a role
 * without it never asks /api/mobile-app-logins.
 */
function LoginStatusTab({
  filters,
  setAccess,
  setStatus,
  searchInput,
  setSearchInput,
  setSearch,
}: {
  filters: LoginFilters;
  setAccess: (v: MobileAppLoginFilters["access"]) => void;
  setStatus: (v: MobileAppLoginFilters["status"]) => void;
  searchInput: string;
  setSearchInput: (v: string) => void;
  setSearch: (v: string) => void;
}) {
  const level = useLevel();
  // Set / Reset / Clear password is its own feature key: hidden = no button, View = the button is there but locked
  // (its words are not ones the page-wide View-only lock knows, so it is locked here).
  const passwordLevel = level("mobile_app_login.logins.password");
  const [resetTarget, setResetTarget] = useState<MobileAppLoginEntry | null>(null);
  const { access, status } = filters;

  const { data, isLoading } = useMobileAppLogins(filters);

  const rows = data?.results ?? [];
  const s = data?.summary;

  return (
    <>
      {/* ── Stats ──────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          label="Staff"
          value={s?.total ?? "—"}
          sub="in the current filter"
          icon={Users}
          color="bg-slate-100 text-slate-800"
        />
        <StatCard
          label="Has App Access"
          value={s?.hasAccess ?? "—"}
          sub="password set up"
          icon={ShieldCheck}
          color="bg-green-50 text-green-800"
        />
        <StatCard
          label="Never Set Up"
          value={s?.noAccess ?? "—"}
          sub={s ? `${s.activeNoAccess} of them active` : undefined}
          icon={UserX}
          color="bg-amber-50 text-amber-800"
        />
        <StatCard
          label="Signed In"
          value={s?.signedIn ?? "—"}
          sub="login recorded"
          icon={Smartphone}
          color="bg-blue-50 text-blue-800"
        />
      </div>

      <div className="flex gap-2 items-start rounded-lg bg-slate-50 border text-slate-600 p-2.5 text-[11px] leading-relaxed">
        <Info size={13} className="mt-0.5 shrink-0" />
        <span>
          This page covers <b>staff only</b> — production employees aren't listed or counted here, so these totals
          won't match the Employees page.
          <b className="ml-1">Has App Access</b> means the employee has created a password, so they can log in.
          <b className="ml-1">Signed In</b> counts logins recorded since login tracking was added — someone with
          access but no recorded login simply hasn't signed in since then. Passwords themselves are stored as
          one-way hashes and can't be displayed; use
          <b> Reset</b> to give someone a new one.
        </span>
      </div>

      {/* ── Filters ────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 flex-wrap">
        <PillTabs
          items={ACCESS_TABS.map((t) => ({ value: t.value, label: t.label }))}
          value={access ?? "all"}
          onChange={(v) => setAccess(v as MobileAppLoginFilters["access"])}
          size="sm"
        />
        <PillTabs
          items={[
            { value: "all", label: "All" },
            { value: "active", label: "Active" },
            { value: "inactive", label: "Inactive" },
          ]}
          value={status ?? "all"}
          onChange={(v) => setStatus(v as MobileAppLoginFilters["status"])}
          size="sm"
        />
        <form
          className="relative ml-auto"
          onSubmit={(e) => {
            e.preventDefault();
            setSearch(searchInput.trim());
          }}
        >
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onBlur={() => setSearch(searchInput.trim())}
            placeholder="Search code, name, phone…"
            className="h-9 pl-8 text-sm w-56"
          />
        </form>
      </div>

      {/* ── List ───────────────────────────────────────────────────────── */}
      {isLoading ? (
        <div className="space-y-2">
          <CircleLoader texts={["UK Textiles", "Mobile App Login", "Loading"]} />
        </div>
      ) : rows.length === 0 ? (
        <Card className="border-0 shadow-sm">
          <CardContent className="py-14 text-center">
            <Smartphone size={32} className="text-gray-200 mx-auto mb-3" />
            <p className="text-sm text-gray-500">No employees match this filter.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-2">
          {rows.map((e) => {
            const lastLogin = fmtTime(e.lastMobileLoginAt);
            return (
              <Card key={e.id} className="border-0 shadow-sm">
                <CardContent className="p-3.5 flex items-center gap-4 flex-wrap">
                  <div className="flex-1 min-w-[220px]">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-bold text-gray-900">{e.name}</p>
                      <span className="text-[11px] font-mono text-gray-400">({e.employeeCode})</span>
                      <Badge
                        variant="outline"
                        className={
                          e.status === "active"
                            ? "text-[10px] border-green-200 bg-green-50 text-green-700"
                            : "text-[10px] border-gray-200 bg-gray-50 text-gray-500"
                        }
                      >
                        {e.status === "active" ? "Active" : "Inactive"}
                      </Badge>
                      {e.hasPassword ? (
                        <span className="flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded bg-green-50 text-green-700">
                          <ShieldCheck size={10} /> Has access
                        </span>
                      ) : (
                        <span className="flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-50 text-amber-700">
                          <ShieldAlert size={10} /> Never set up
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-gray-500 mt-1">
                      {[e.department, e.designation].filter(Boolean).join(" · ") || "—"}
                      {e.phone ? ` · ${e.phone}` : ""}
                    </p>
                    <p className="text-[11px] text-gray-400 mt-1">
                      {lastLogin
                        ? `Last signed in ${lastLogin}`
                        : e.hasPassword
                          ? "No sign-in recorded yet"
                          : "Has not set a password — cannot log in"}
                      {e.deviceCount > 0 && ` · ${e.deviceCount} device${e.deviceCount === 1 ? "" : "s"}`}
                    </p>
                  </div>
                  {passwordLevel !== "hidden" && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1.5 h-8 text-xs shrink-0"
                      onClick={() => setResetTarget(e)}
                      disabled={passwordLevel !== "edit"}
                      title={passwordLevel !== "edit" ? "View only: passwords can't be changed" : undefined}
                    >
                      <KeyRound size={12} /> {e.hasPassword ? "Reset password" : "Set password"}
                    </Button>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {passwordLevel === "edit" && (
        <ResetPasswordDialog employee={resetTarget} onClose={() => setResetTarget(null)} />
      )}
    </>
  );
}

export default function MobileAppLogin() {
  const { user } = useAuth();
  const [location] = useLocation();
  const level = useLevel();
  const [access, setAccess] = useState<MobileAppLoginFilters["access"]>("all");
  const [status, setStatus] = useState<MobileAppLoginFilters["status"]>("all");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [askedView, setView] = useState<PageView>("logins");

  // Only the tabs this role may see are offered, and the one shown is always one of them (only it is mounted, so a hidden
  // tab asks the server for nothing). A tab the role may only VIEW on a page it may edit gets the note and the lock.
  const visibleTabs = visibleItems(PAGE_TABS, (t) => PAGE_TAB_MODULE[t.value], level);
  const view = pickVisible(
    askedView,
    visibleTabs.map((t) => t.value),
  );
  const pageViewOnly = isRouteViewOnly(user, location, moduleForPath(location));
  const tabViewOnly = visibleTabs.length > 0 && !pageViewOnly && level(PAGE_TAB_MODULE[view]) === "view";
  useViewOnlyLock(tabViewOnly, view);

  const filters: LoginFilters = { access, status, search };

  return (
    <HrLayout>
      <div className="space-y-6">
        {/* ── Header ─────────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-2xl font-black text-gray-900">Mobile App Login</h2>
            <p className="text-muted-foreground text-sm mt-0.5">
              {view === "version"
                ? "Publish a new version of the employee app and employees are asked to install it"
                : "Staff who can get into the employee app, who hasn't set it up yet, and password resets"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {visibleTabs.length > 0 && view === "logins" && (
              <Gate k="mobile_app_login.logins.export">
                <LoginsExportButton filters={filters} />
              </Gate>
            )}
            <RefreshButton />
          </div>
        </div>

        {visibleTabs.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="mobile-app-login-nothing-open">
            Nothing on this page is open to your role.
          </p>
        ) : (
          <>
            <PillTabs items={visibleTabs} value={view} onChange={(v) => setView(v as PageView)} size="sm" />

            <ViewOnlyTabNote show={tabViewOnly} />

            {view === "version" ? (
              <NewVersionTab />
            ) : view === "messages" ? (
              <MobileMessagesTab />
            ) : (
              <LoginStatusTab
                filters={filters}
                setAccess={setAccess}
                setStatus={setStatus}
                searchInput={searchInput}
                setSearchInput={setSearchInput}
                setSearch={setSearch}
              />
            )}
          </>
        )}
      </div>
    </HrLayout>
  );
}

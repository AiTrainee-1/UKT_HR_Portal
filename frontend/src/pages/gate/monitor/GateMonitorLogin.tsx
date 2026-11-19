// The gate monitor sign-in (/gatemonitor): ONE address for every gate. The username and password HR gave a gate decide
// which gate this screen becomes. A browser that is already signed in goes straight to the console; one whose sign-in
// ended (?ended=signed_out | switched_off | expired) is told why. `?gate=<login token>` (an old /gate-scanner/<token>
// link) only names the gate as a hint. Calls go through ./client, which never sends the HR token.

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Redirect, useLocation, useSearch } from "wouter";
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Coffee,
  Eye,
  EyeOff,
  Info,
  Loader2,
  Lock,
  ScanLine,
  ShieldCheck,
  User,
} from "lucide-react";
import { UktLogoMark } from "@/components/ui/UktLogoMark";
import type { GateLoginInfo } from "@/lib/api-client/custom-hooks/gate-monitor";
import {
  clearGateSession,
  CONSOLE_PATH,
  endedMessage,
  gateLogin,
  gateLoginInfo,
  NO_CONNECTION_MESSAGE,
  readGateSession,
  saveGateSession,
} from "./client";

const DUTIES = [
  {
    icon: ScanLine,
    title: "Scan approved gate passes",
    text: "Check a pass as the employee goes out, and record the return.",
  },
  { icon: Coffee, title: "Record tea breaks", text: "Start and end a break with the employee's tea-break QR." },
  {
    icon: ShieldCheck,
    title: "See only this gate's records",
    text: "Today's counts, the latest scans and files of this gate alone.",
  },
] as const;

const INPUT =
  "h-12 w-full min-w-0 rounded-lg border border-slate-200 bg-white pl-10 text-base text-slate-900 outline-none " +
  "focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring/50";

export default function GateMonitorLogin() {
  const params = new URLSearchParams(useSearch());
  const ended = params.get("ended");
  // already signed in on this device: straight to the console (not after a sign-in that just ended)
  if (!ended && readGateSession()) return <Redirect to={CONSOLE_PATH} replace />;
  return <SignIn ended={ended} loginToken={params.get("gate") ?? ""} />;
}

function SignIn({ ended, loginToken }: { ended: string | null; loginToken: string }) {
  const [, navigate] = useLocation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<GateLoginInfo | null>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const notice = endedMessage(ended);

  // a sign-in that ended leaves nothing behind (the client already cleared it; this covers a typed address too)
  useEffect(() => {
    if (ended) clearGateSession();
  }, [ended]);

  useEffect(() => {
    let live = true;
    if (loginToken) void gateLoginInfo(loginToken).then((info) => live && setHint(info));
    return () => {
      live = false;
    };
  }, [loginToken]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (pending || !username.trim() || !password) return;
    setPending(true);
    setError(null);
    try {
      const res = await gateLogin(username, password);
      saveGateSession(res);
      navigate(CONSOLE_PATH, { replace: true });
    } catch (err) {
      setPending(false);
      setPassword("");
      setError(err instanceof Error && err.message ? err.message : NO_CONNECTION_MESSAGE);
      passwordRef.current?.focus();
    }
  };

  const subtitle = hint
    ? `Signing in to ${hint.gateName}${hint.branchName ? `, ${hint.branchName}` : ""}. Use the username and password HR gave this gate.`
    : "Use the username and password HR gave this gate.";

  return (
    <div
      className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-6 sm:py-12"
      data-testid="gate-monitor-signin"
    >
      <div className="grid w-full max-w-4xl overflow-hidden rounded-2xl border border-slate-200 bg-white md:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        <aside className="flex flex-col gap-5 bg-primary p-6 text-primary-foreground sm:p-8 md:p-10">
          <div className="flex items-center gap-3">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-white">
              <UktLogoMark className="h-7" />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-bold tracking-wide">UK Textiles HRMS</p>
              <p className="text-xs opacity-80">Gate desk</p>
            </div>
          </div>
          <div>
            <p className="text-3xl font-bold">Gate Monitor</p>
            <p className="mt-2 text-sm opacity-90">
              One sign-in for every gate: the username and password decide which gate this screen works for.
            </p>
          </div>
          <ul className="hidden flex-col gap-3 sm:flex" aria-label="What this screen does">
            {DUTIES.map((d) => (
              <li key={d.title} className="flex gap-3 rounded-xl border border-white/10 bg-white/10 p-3">
                <d.icon size={20} className="mt-0.5 shrink-0" aria-hidden="true" />
                <div className="min-w-0">
                  <p className="text-sm font-semibold">{d.title}</p>
                  <p className="text-xs opacity-85">{d.text}</p>
                </div>
              </li>
            ))}
          </ul>
        </aside>

        <main className="p-6 sm:p-8 md:p-10">
          <h1 className="text-2xl font-bold text-slate-900 sm:text-3xl">Sign in to your gate</h1>
          <p className="mt-1.5 text-sm text-slate-600" data-testid="gate-signin-subtitle">
            {subtitle}
          </p>
          {hint && !hint.isActive && (
            <p className="mt-2 text-sm text-amber-800">
              This gate is switched off at the moment. Ask HR to switch it on.
            </p>
          )}

          {notice && (
            <div
              role="status"
              className="mt-5 flex gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900"
              data-testid="gate-signin-ended"
            >
              <Info size={17} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span>{notice}</span>
            </div>
          )}

          <form onSubmit={submit} className="mt-6 flex flex-col gap-4" data-testid="gate-monitor-login" noValidate>
            {error && (
              <div
                role="alert"
                className="flex gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2.5 text-sm text-rose-700"
                data-testid="gate-signin-error"
              >
                <AlertCircle size={17} className="mt-0.5 shrink-0" aria-hidden="true" />
                <span>{error}</span>
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              <label htmlFor="gate-monitor-username" className="text-sm font-semibold text-slate-700">
                Username
              </label>
              <div className="relative">
                <User
                  size={17}
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
                  aria-hidden="true"
                />
                <input
                  id="gate-monitor-username"
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  autoFocus
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className={`${INPUT} pr-3`}
                  data-testid="gate-username"
                />
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="gate-monitor-password" className="text-sm font-semibold text-slate-700">
                Password
              </label>
              <div className="relative">
                <Lock
                  size={17}
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
                  aria-hidden="true"
                />
                <input
                  id="gate-monitor-password"
                  ref={passwordRef}
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={`${INPUT} pr-24`}
                  data-testid="gate-password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  aria-pressed={showPassword}
                  className="absolute right-0.5 top-1/2 inline-flex h-11 -translate-y-1/2 items-center gap-1.5 rounded-md px-3 text-sm font-semibold text-primary hover:bg-primary/10"
                  data-testid="gate-password-toggle"
                >
                  {showPassword ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
                  {showPassword ? "Hide" : "Show"}
                </button>
              </div>
            </div>
            <button
              type="submit"
              disabled={pending || !username.trim() || !password}
              className="mt-1 inline-flex h-12 items-center justify-center gap-2 rounded-lg bg-primary text-base font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-60"
              data-testid="gate-signin-submit"
            >
              {pending ? (
                <>
                  <Loader2 size={18} className="animate-spin" aria-hidden="true" /> Signing in…
                </>
              ) : (
                <>
                  Sign in <ArrowRight size={18} aria-hidden="true" />
                </>
              )}
            </button>
          </form>

          <div className="mt-6 flex flex-col gap-3 border-t border-slate-200 pt-5 text-sm text-slate-600">
            <p className="flex items-center gap-2">
              <CheckCircle2 size={16} className="shrink-0 text-teal-600" aria-hidden="true" />
              Stays signed in on this device until you sign out.
            </p>
            <p className="flex items-start gap-2">
              <Info size={16} className="mt-0.5 shrink-0 text-slate-400" aria-hidden="true" />
              Forgot the password? HR can look it up or set a new one on the Manage Gates page.
            </p>
          </div>
        </main>
      </div>
    </div>
  );
}

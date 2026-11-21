// The gate monitor sign-in (/gatemonitor): ONE address for every gate. The username and password HR gave a gate decide
// which gate this screen becomes. A browser that is already signed in goes straight to the console; one whose sign-in
// ended (?ended=signed_out | switched_off | expired) is told why. `?gate=<login token>` (an old /gate-scanner/<token>
// link) only names the gate as a hint. Calls go through ./client, which never sends the HR token.
//
// The same kiosk look as the console (gate-kiosk.css): a deep slate page, the gate's scanner and what its colours mean on
// the left, a calm white sign-in card on the right.

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Redirect, useLocation, useSearch } from "wouter";
import { AlertCircle, ArrowRight, CheckCircle2, Eye, EyeOff, Info, Loader2, Lock, User } from "lucide-react";
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
import "./gate-kiosk.css";

/** What the console's colours mean: taught here, before the first scan. */
const LEGEND = [
  { tone: "green", label: "Allowed", text: "Exit or return recorded, tea break started" },
  { tone: "return", label: "Back from tea break", text: "The break is over; its minutes are shown" },
  { tone: "orange", label: "Stop and check", text: "Used, expired, not out yet, or scanned again too soon" },
  { tone: "red", label: "Denied", text: "Not recognised, not approved, or not taken at this gate" },
] as const;

const INPUT =
  "h-12 w-full min-w-0 rounded-xl border border-slate-200 bg-white pl-10 text-base text-slate-900 outline-none " +
  "transition-colors focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring/50";

export default function GateMonitorLogin() {
  const params = new URLSearchParams(useSearch());
  const ended = params.get("ended");
  // already signed in on this device: straight to the console (not after a sign-in that just ended)
  if (!ended && readGateSession()) return <Redirect to={CONSOLE_PATH} replace />;
  return <SignIn ended={ended} loginToken={params.get("gate") ?? ""} />;
}

/** A small, quiet copy of the console's scanner: the QR frame and its scan line. */
function ScannerPreview() {
  return (
    <div className="gk-scanner flex items-center gap-5 p-5" aria-hidden="true">
      <div className="gk-frame shrink-0" style={{ width: "5.5rem", height: "5.5rem" }}>
        {(["tl", "tr", "bl", "br"] as const).map((at) => (
          <span key={at} className="gk-corner" data-at={at} style={{ width: "1.4rem", height: "1.4rem" }} />
        ))}
        <span className="gk-scanline" />
      </div>
      <div className="min-w-0">
        <p className="text-base font-bold text-white">Ready to scan</p>
        <p className="mt-1 text-sm text-slate-400">
          Gate passes going out and coming back, and tea breaks. The whole screen shows the answer in colour.
        </p>
      </div>
    </div>
  );
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
      className="gk-root flex min-h-screen items-center justify-center bg-slate-950 px-4 py-6 sm:py-12"
      data-testid="gate-monitor-signin"
    >
      <div className="gk-bg" aria-hidden="true" />
      <div className="gk-enter grid w-full max-w-5xl overflow-hidden rounded-[1.75rem] border border-white/10 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <aside className="gk-panel flex flex-col gap-6 rounded-none border-0 p-6 shadow-none sm:p-8 md:p-10">
          <div className="flex items-center gap-3">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-white">
              <UktLogoMark className="h-7" />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-bold tracking-wide text-white">UK Textiles HRMS</p>
              <p className="text-xs font-medium uppercase tracking-[0.16em] text-slate-400">Gate desk</p>
            </div>
          </div>
          <div>
            <p className="text-3xl font-bold tracking-tight text-white sm:text-4xl">Gate Monitor</p>
            <p className="mt-2 max-w-md text-sm leading-relaxed text-slate-300">
              One sign-in for every gate: the username and password decide which gate this screen works for.
            </p>
          </div>
          <div className="hidden sm:block">
            <ScannerPreview />
          </div>
          <div className="hidden sm:block">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">
              What the colours mean
            </p>
            <ul className="mt-3 flex flex-col gap-2.5" aria-label="What the colours mean">
              {LEGEND.map((l) => (
                <li key={l.tone} className="flex items-start gap-3" data-gk-tone={l.tone}>
                  <span className="gk-legend-dot mt-1.5 shrink-0" aria-hidden="true" />
                  <p className="min-w-0 text-sm text-slate-300">
                    <span className="gk-tone-ink font-semibold">{l.label}</span>
                    <span className="text-slate-400"> - {l.text}</span>
                  </p>
                </li>
              ))}
            </ul>
          </div>
        </aside>

        <main className="gk-light bg-white p-6 text-slate-900 sm:p-8 md:p-10">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">Sign in to your gate</h1>
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
              className="mt-5 flex gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900"
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
                className="flex gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2.5 text-sm text-rose-700"
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
                  className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400"
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
                  className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400"
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
                  className="absolute right-0.5 top-1/2 inline-flex h-11 -translate-y-1/2 items-center gap-1.5 rounded-lg px-3 text-sm font-semibold text-primary hover:bg-primary/10"
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
              className="mt-1 inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-primary text-base font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
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
              <CheckCircle2 size={16} className="shrink-0 text-emerald-600" aria-hidden="true" />
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

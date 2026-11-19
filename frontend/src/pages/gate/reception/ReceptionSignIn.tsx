import { useEffect, useRef, useState, type FormEvent } from "react";
import { Redirect, useLocation, useRoute, useSearch } from "wouter";
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Eye,
  EyeOff,
  Info,
  Loader2,
  Lock,
  LogOut,
  User,
  UserPlus,
  UsersRound,
} from "lucide-react";
import { UktLogoMark } from "@/components/ui/UktLogoMark";
import {
  clearDeskSession,
  DESK_CONSOLE,
  DeskError,
  endedMessage,
  hasDeskSession,
  NO_CONNECTION_MESSAGE,
  saveDeskSession,
  useDeskLogin,
  useDeskLoginInfo,
} from "./desk-api";

/**
 * The reception desk's sign-in, at /reception-login: ONE address for every desk (the username and password HR gave a desk
 * decide which desk this screen becomes), and at the old per-desk links /reception-login/<token>, where the desk's name
 * is shown as a hint. It is not an HR page: it sends no HR token (desk-api.ts), and signing in writes only the desk's own
 * three keys before the console. A browser already signed in goes straight to the console; one whose sign-in ended
 * (?ended=signed_out | switched_off | expired) is told why.
 */

const DUTIES = [
  {
    icon: UserPlus,
    title: "Register walk-in visitors",
    text: "Check a visitor in and tell the person they came to meet.",
  },
  { icon: LogOut, title: "Check visitors out", text: "Record when each visitor leaves the premises." },
  {
    icon: UsersRound,
    title: "See this branch's visitors",
    text: "Who is inside now, today's visits and files of any dates.",
  },
] as const;

const INPUT =
  "h-12 w-full min-w-0 rounded-lg border border-slate-200 bg-white pl-10 text-base text-slate-900 outline-none " +
  "focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring/50";

/** What the sign-in says for a refusal: the server's own words, else plain words for the status. */
function signInError(err: unknown): string {
  if (err instanceof DeskError) {
    if (err.status === 0) return NO_CONNECTION_MESSAGE;
    if (err.data && typeof err.data.error === "string" && err.data.error) return err.data.error;
    if (err.status === 401) return "Wrong username or password.";
    if (err.status === 403) return "This desk is switched off. Ask HR to switch it on.";
    if (err.status === 429) return "Too many wrong tries. Wait 15 minutes or ask HR to reset the password.";
  }
  return "Could not sign in. Please try again.";
}

export default function ReceptionSignIn() {
  const [, params] = useRoute("/reception-login/:loginToken");
  const search = new URLSearchParams(useSearch());
  const ended = search.get("ended");
  // already signed in on this device: straight to the console (not after a sign-in that just ended)
  if (!ended && hasDeskSession()) return <Redirect to={DESK_CONSOLE} replace />;
  return <SignIn ended={ended} loginToken={params?.loginToken ?? ""} />;
}

function SignIn({ ended, loginToken }: { ended: string | null; loginToken: string }) {
  const [, navigate] = useLocation();
  const info = useDeskLoginInfo(loginToken);
  const login = useDeskLogin();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const notice = endedMessage(ended);

  // a sign-in that ended leaves nothing behind (the client already cleared it; this covers a typed address too)
  useEffect(() => {
    if (ended) clearDeskSession();
  }, [ended]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (login.isPending || !username.trim() || !password) return;
    setError(null);
    try {
      const session = await login.mutateAsync({ username: username.trim(), password });
      saveDeskSession(session);
      navigate(DESK_CONSOLE, { replace: true });
    } catch (err) {
      setPassword("");
      setError(signInError(err));
      passwordRef.current?.focus();
    }
  };

  const hint = loginToken && info.data ? info.data : null;

  return (
    <div
      className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-6 sm:py-12"
      data-testid="reception-signin-page"
    >
      <div className="grid w-full max-w-4xl overflow-hidden rounded-2xl border border-slate-200 bg-white md:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        <aside className="flex flex-col gap-5 bg-primary p-6 text-primary-foreground sm:p-8 md:p-10">
          <div className="flex items-center gap-3">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-white">
              <UktLogoMark className="h-7" />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-bold tracking-wide">UK Textiles HRMS</p>
              <p className="text-xs opacity-80">Visitors</p>
            </div>
          </div>
          <div>
            <p className="text-3xl font-bold">Reception desk</p>
            <p className="mt-2 text-sm opacity-90">
              One sign-in for every desk: the username and password decide which desk this screen works for.
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

        <main className="min-w-0 p-6 sm:p-8 md:p-10">
          <h1 className="text-2xl font-bold text-slate-900 sm:text-3xl">Reception</h1>
          <p className="mt-1.5 text-sm text-slate-600">Sign in with the username and password HR gave this desk.</p>

          {hint && (
            <p
              className="mt-4 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700"
              data-testid="reception-desk-hint"
            >
              Signing in to <span className="font-semibold">{hint.deskName}</span> · {hint.branchName}
              {!hint.isActive && (
                <span className="block text-amber-800">This desk is switched off. Ask HR to switch it on.</span>
              )}
            </p>
          )}
          {loginToken && info.isError && (
            <p className="mt-4 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
              This sign-in link is not recognised. Sign in with the desk's username and password.
            </p>
          )}
          {notice && (
            <div
              role="status"
              className="mt-5 flex gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900"
              data-testid="reception-signin-ended"
            >
              <Info size={17} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span>{notice}</span>
            </div>
          )}

          <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-4" data-testid="reception-sign-in" noValidate>
            {error && (
              <div
                role="alert"
                className="flex gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2.5 text-sm text-rose-700"
                data-testid="reception-signin-error"
              >
                <AlertCircle size={17} className="mt-0.5 shrink-0" aria-hidden="true" />
                <span>{error}</span>
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              <label htmlFor="reception-sign-in-username" className="text-sm font-semibold text-slate-700">
                Username
              </label>
              <div className="relative">
                <User
                  size={17}
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
                  aria-hidden="true"
                />
                <input
                  id="reception-sign-in-username"
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  autoFocus
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className={`${INPUT} pr-3`}
                />
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="reception-sign-in-password" className="text-sm font-semibold text-slate-700">
                Password
              </label>
              <div className="relative">
                <Lock
                  size={17}
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
                  aria-hidden="true"
                />
                <input
                  id="reception-sign-in-password"
                  ref={passwordRef}
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={`${INPUT} pr-24`}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  aria-pressed={showPassword}
                  className="absolute right-0.5 top-1/2 inline-flex h-11 -translate-y-1/2 items-center gap-1.5 rounded-md px-3 text-sm font-semibold text-primary hover:bg-primary/10"
                  data-testid="reception-password-toggle"
                >
                  {showPassword ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
                  {showPassword ? "Hide" : "Show"}
                </button>
              </div>
            </div>
            <button
              type="submit"
              disabled={login.isPending || !username.trim() || !password}
              className="mt-1 inline-flex h-12 items-center justify-center gap-2 rounded-lg bg-primary text-base font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-60"
              data-testid="reception-signin-submit"
            >
              {login.isPending ? (
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
              Forgot the password? HR can look it up or set a new one on Visitors, Manage Reception.
            </p>
          </div>
        </main>
      </div>
    </div>
  );
}

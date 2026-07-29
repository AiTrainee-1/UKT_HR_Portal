import { useState } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import { useHrLogin } from "@/lib/api-client";
import { Eye, EyeOff, Lock, User, Users2, CalendarCheck2, Wallet2, ShieldCheck } from "lucide-react";

const FEATURES = [
  { icon: Users2, label: "Employee lifecycle, in one place", desc: "Onboarding, records, documents and roles." },
  { icon: CalendarCheck2, label: "Attendance that just works", desc: "Biometric, geo-punch and shift-aware." },
  { icon: Wallet2, label: "Payroll without the spreadsheets", desc: "Salary, settlements and slips, automated." },
];

function UktMark({ className = "h-10 w-auto", style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <svg viewBox="0 0 1536 1024" className={className} style={style} aria-label="UKTextiles Logo">
      <defs>
        <mask id="ukt-mark-ring-gap">
          <rect x="0" y="0" width="1536" height="1024" fill="white" />
          <ellipse cx="793" cy="512" rx="595" ry="382" fill="black" />
        </mask>
      </defs>
      <ellipse cx="793" cy="512" rx="608" ry="391" fill="currentColor" mask="url(#ukt-mark-ring-gap)" />
      <ellipse cx="793" cy="512" rx="585" ry="375" fill="currentColor" />
      <path
        fill="#ffffff"
        d="M 447,215 L 448,642 L 452,674 L 461,710 L 476,744 L 493,768 L 510,784 L 524,793 L 556,805 L 582,809 L 616,809 L 642,804 L 668,793 L 691,774 L 708,750 L 727,707 L 836,804 L 923,805 L 771,669 L 824,494 L 905,267 L 974,266 L 975,805 L 1027,805 L 1027,267 L 1124,266 L 1124,216 L 875,216 L 777,487 L 733,629 L 732,216 L 681,216 L 681,638 L 677,673 L 667,710 L 658,727 L 641,745 L 618,755 L 586,756 L 559,749 L 539,736 L 519,711 L 507,682 L 499,633 L 499,215 Z"
      />
    </svg>
  );
}

export default function HrLogin() {
  const [, navigate] = useLocation();
  const { login } = useAuth();
  const mutation = useHrLogin();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    mutation.mutate(
      { data: { username, password } },
      {
        onSuccess: (res) => {
          login(res.token, res.role as "hr", res.employeeId ?? null, res.name);
          navigate("/hr/dashboard");
        },
        onError: () => {
          setError("Invalid username or password. Please try again.");
        },
      }
    );
  };

  return (
    <div
      className="min-h-screen flex"
      style={{ fontFamily: "'Hanken Grotesk', 'Inter', sans-serif" }}
    >
      {/* ── Brand panel ── */}
      <div
        className="hidden lg:flex lg:w-[46%] xl:w-[42%] relative overflow-hidden flex-col justify-between px-14 py-12"
        style={{ background: "linear-gradient(160deg, #002e46 0%, #006496 55%, #0096c7 100%)" }}
      >
        {/* Mesh / grid texture */}
        <div
          className="absolute inset-0 opacity-[0.07] pointer-events-none"
          style={{
            backgroundImage:
              "linear-gradient(#fff 1px, transparent 1px), linear-gradient(90deg, #fff 1px, transparent 1px)",
            backgroundSize: "42px 42px",
          }}
        />
        <div
          className="blob-animate absolute -top-24 -right-20 w-[420px] h-[420px] rounded-full opacity-20 pointer-events-none"
          style={{ background: "radial-gradient(circle, #5dbbff 0%, transparent 65%)" }}
        />
        <div
          className="blob-animate absolute bottom-[-15%] left-[-10%] w-[380px] h-[380px] rounded-full opacity-15 pointer-events-none"
          style={{ background: "radial-gradient(circle, #ffffff 0%, transparent 65%)", animationDelay: "3s" }}
        />

        {/* Logo */}
        <div className="relative flex items-center gap-3 clay-fade-in">
          <UktMark className="h-9 w-auto text-white/95" />
          <span className="text-lg font-black tracking-tight text-white">
            UK<span style={{ color: "#8fd8ff" }}>Textiles</span>
          </span>
        </div>

        {/* Headline + features */}
        <div className="relative clay-fade-in" style={{ animationDelay: "0.05s" }}>
          <p className="text-[11px] font-bold tracking-[0.35em] uppercase mb-4" style={{ color: "rgba(255,255,255,0.55)" }}>
            HR Management System
          </p>
          <h1 className="text-4xl xl:text-[2.75rem] font-black leading-[1.1] tracking-tight text-white mb-10 max-w-md">
            Run your workforce with precision, not paperwork.
          </h1>

          <div className="flex flex-col gap-5">
            {FEATURES.map(({ icon: Icon, label, desc }) => (
              <div key={label} className="flex items-start gap-4">
                <div
                  className="shrink-0 w-11 h-11 rounded-xl flex items-center justify-center"
                  style={{ background: "rgba(255,255,255,0.12)", boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.18)" }}
                >
                  <Icon size={19} className="text-white" strokeWidth={1.8} />
                </div>
                <div>
                  <p className="text-sm font-bold text-white leading-snug">{label}</p>
                  <p className="text-[13px] mt-0.5 font-medium" style={{ color: "rgba(255,255,255,0.6)" }}>
                    {desc}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div className="relative flex items-center gap-2 clay-fade-in" style={{ animationDelay: "0.1s", color: "rgba(255,255,255,0.5)" }}>
          <ShieldCheck size={14} strokeWidth={2} />
          <p className="text-[11px] font-semibold tracking-wide">On-Premise · Role-Based Access · Confidential</p>
        </div>
      </div>

      {/* ── Form panel ── */}
      <div
        className="flex-1 flex items-center justify-center px-6 py-12 relative overflow-hidden"
        style={{ background: "linear-gradient(135deg, #f6fafe 0%, #eef4fa 50%, #f0f6fc 100%)" }}
      >
        <div className="absolute inset-0 overflow-hidden pointer-events-none lg:hidden">
          <div
            className="blob-animate absolute top-[-15%] right-[-10%] w-[420px] h-[420px] rounded-full opacity-20"
            style={{ background: "radial-gradient(circle at 40% 40%, #4FB8F0 0%, transparent 65%)" }}
          />
        </div>

        <div className="relative w-full max-w-sm clay-fade-in">
          {/* Mobile-only logo */}
          <div className="flex lg:hidden items-center justify-center gap-2.5 mb-9">
            <UktMark className="h-9 w-auto" style={{ color: "#4FB8F0" }} />
            <span className="text-xl font-black tracking-tight" style={{ color: "#006496" }}>
              UK<span style={{ color: "#4FB8F0" }}>Textiles</span>
            </span>
          </div>

          <div className="mb-8">
            <h2 className="text-[28px] font-black tracking-tight" style={{ color: "#1a3a4a" }}>
              Welcome back
            </h2>
            <p className="text-sm mt-1.5 font-medium" style={{ color: "rgba(0,80,120,0.55)" }}>
              Sign in with your HR credentials to continue.
            </p>
          </div>

          <form onSubmit={handleLogin} className="space-y-5">
            {/* Username */}
            <div className="space-y-2">
              <label className="text-[13px] font-semibold block" style={{ color: "rgba(0,60,100,0.7)" }}>
                Username
              </label>
              <div className="relative">
                <User
                  size={15}
                  className="absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
                  style={{ color: "rgba(0,100,150,0.4)" }}
                  strokeWidth={1.8}
                />
                <input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="Enter your username"
                  required
                  autoFocus
                  data-testid="input-username"
                  className="w-full h-12 pl-9 pr-4 rounded-xl text-sm font-medium outline-none transition-all clay-input"
                  style={{ color: "#1a3a4a" }}
                />
              </div>
            </div>

            {/* Password */}
            <div className="space-y-2">
              <label className="text-[13px] font-semibold block" style={{ color: "rgba(0,60,100,0.7)" }}>
                Password
              </label>
              <div className="relative">
                <Lock
                  size={15}
                  className="absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
                  style={{ color: "rgba(0,100,150,0.4)" }}
                  strokeWidth={1.8}
                />
                <input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter your password"
                  required
                  data-testid="input-password"
                  className="w-full h-12 pl-9 pr-11 rounded-xl text-sm font-medium outline-none transition-all clay-input"
                  style={{ color: "#1a3a4a" }}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((s) => !s)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 transition-colors"
                  style={{ color: "rgba(0,100,150,0.4)" }}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? <EyeOff size={15} strokeWidth={1.8} /> : <Eye size={15} strokeWidth={1.8} />}
                </button>
              </div>
            </div>

            {/* Error */}
            {error && (
              <div
                className="text-sm p-3 rounded-xl font-medium"
                style={{
                  background: "rgba(239,68,68,0.07)",
                  color: "#dc2626",
                  boxShadow: "inset 3px 3px 8px rgba(220,38,38,0.08), inset -3px -3px 8px rgba(255,255,255,0.9)",
                }}
              >
                {error}
              </div>
            )}

            {/* Submit */}
            <button
              type="submit"
              data-testid="button-submit"
              disabled={mutation.isPending}
              className="w-full h-12 rounded-xl text-sm font-bold text-white transition-all disabled:opacity-60 clay-btn"
              style={{ background: "linear-gradient(135deg, #006496 0%, #0096c7 100%)" }}
            >
              {mutation.isPending ? (
                <span className="flex items-center justify-center gap-2">
                  <svg className="animate-spin h-4 w-4 text-white" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8z" />
                  </svg>
                  Signing in…
                </span>
              ) : (
                "Sign In"
              )}
            </button>
          </form>

          <p className="text-center text-[11px] mt-8 font-medium" style={{ color: "rgba(0,100,150,0.35)" }}>
            Secured · UKTextiles Enterprise HR System
          </p>
        </div>
      </div>
    </div>
  );
}

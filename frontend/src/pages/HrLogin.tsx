import { useState } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import { useHrLogin } from "@/lib/api-client";
import { Eye, EyeOff, ArrowLeft, Lock, User } from "lucide-react";

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
      className="min-h-screen relative overflow-hidden flex items-center justify-center p-4"
      style={{
        background: "linear-gradient(135deg, #f0f5fa 0%, #e8f2f8 40%, #eef4fc 100%)",
        fontFamily: "'Hanken Grotesk', 'Inter', sans-serif",
      }}
    >
      {/* ── Ambient blobs ── */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div
          className="blob-animate absolute top-[-15%] right-[-10%] w-[520px] h-[520px] rounded-full opacity-30"
          style={{ background: "radial-gradient(circle at 40% 40%, #4FB8F0 0%, transparent 65%)" }}
        />
        <div
          className="blob-animate absolute bottom-[-15%] left-[-10%] w-[480px] h-[480px] rounded-full opacity-20"
          style={{
            background: "radial-gradient(circle at 60% 60%, #006496 0%, transparent 65%)",
            animationDelay: "3s",
          }}
        />
        <div
          className="blob-animate absolute top-[40%] left-[30%] w-[300px] h-[300px] rounded-full opacity-15"
          style={{
            background: "radial-gradient(circle, #5dbbff 0%, transparent 65%)",
            animationDelay: "6s",
          }}
        />
      </div>

      <div className="relative w-full max-w-md">
        {/* Back button */}
        <button
          onClick={() => navigate("/")}
          className="flex items-center gap-1.5 text-sm mb-6 transition-all hover:translate-x-[-2px]"
          style={{ color: "rgba(0,100,150,0.55)" }}
        >
          <ArrowLeft size={15} strokeWidth={2} />
          <span className="font-medium">Back to Portal Selection</span>
        </button>

        {/* ── Login Card ── */}
        <div
          className="rounded-3xl p-8 clay-fade-in"
          style={{
            background: "#ffffff",
            boxShadow:
              "16px 16px 32px rgba(0,100,150,0.12), -8px -8px 24px rgba(255,255,255,0.9), inset 4px 4px 10px rgba(255,255,255,0.7), inset -4px -4px 12px rgba(0,100,150,0.04)",
          }}
        >
          {/* Logo + Title */}
          <div className="text-center mb-8">
            <div className="flex justify-center mb-4">
              <div
                className="relative p-3 rounded-2xl"
                style={{
                  background: "#f6fafe",
                  boxShadow:
                    "6px 6px 14px rgba(0,100,150,0.1), -4px -4px 10px rgba(255,255,255,0.9), inset 2px 2px 6px rgba(255,255,255,0.7)",
                }}
              >
                <svg viewBox="0 0 1536 1024" className="h-16 w-auto" aria-label="UKTextiles Logo">
                  <defs>
                    <mask id="ukt-login-ring-gap">
                      <rect x="0" y="0" width="1536" height="1024" fill="white" />
                      <ellipse cx="793" cy="512" rx="595" ry="382" fill="black" />
                    </mask>
                  </defs>
                  <ellipse cx="793" cy="512" rx="608" ry="391" fill="#4FB8F0" mask="url(#ukt-login-ring-gap)" />
                  <ellipse cx="793" cy="512" rx="585" ry="375" fill="#4FB8F0" />
                  <path
                    fill="#FFFFFF"
                    d="M 447,215 L 448,642 L 452,674 L 461,710 L 476,744 L 493,768 L 510,784 L 524,793 L 556,805 L 582,809 L 616,809 L 642,804 L 668,793 L 691,774 L 708,750 L 727,707 L 836,804 L 923,805 L 771,669 L 824,494 L 905,267 L 974,266 L 975,805 L 1027,805 L 1027,267 L 1124,266 L 1124,216 L 875,216 L 777,487 L 733,629 L 732,216 L 681,216 L 681,638 L 677,673 L 667,710 L 658,727 L 641,745 L 618,755 L 586,756 L 559,749 L 539,736 L 519,711 L 507,682 L 499,633 L 499,215 Z"
                  />
                </svg>
              </div>
            </div>
            <h2
              className="text-2xl font-black tracking-tight"
              style={{ color: "#006496" }}
            >
              HR Portal
            </h2>
            <p className="text-sm mt-1 font-medium" style={{ color: "rgba(0,100,150,0.5)" }}>
              UKTextiles HR Management System
            </p>
          </div>

          {/* Form */}
          <form onSubmit={handleLogin} className="space-y-5">
            {/* Username */}
            <div className="space-y-2">
              <label
                className="text-[13px] font-semibold block"
                style={{ color: "rgba(0,60,100,0.7)" }}
              >
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
                  placeholder="Enter HR username"
                  required
                  data-testid="input-username"
                  className="w-full h-11 pl-9 pr-4 rounded-xl text-sm font-medium outline-none transition-all clay-input"
                  style={{ color: "#1a3a4a" }}
                />
              </div>
            </div>

            {/* Password */}
            <div className="space-y-2">
              <label
                className="text-[13px] font-semibold block"
                style={{ color: "rgba(0,60,100,0.7)" }}
              >
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
                  placeholder="Enter password"
                  required
                  data-testid="input-password"
                  className="w-full h-11 pl-9 pr-11 rounded-xl text-sm font-medium outline-none transition-all clay-input"
                  style={{ color: "#1a3a4a" }}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((s) => !s)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 transition-colors"
                  style={{ color: "rgba(0,100,150,0.4)" }}
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
              className="w-full h-11 rounded-xl text-sm font-bold text-white transition-all disabled:opacity-60 clay-btn"
              style={{
                background: "linear-gradient(135deg, #006496 0%, #0096c7 100%)",
              }}
            >
              {mutation.isPending ? (
                <span className="flex items-center justify-center gap-2">
                  <svg className="animate-spin h-4 w-4 text-white" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8z"/>
                  </svg>
                  Signing in…
                </span>
              ) : (
                "Sign In to HR Portal"
              )}
            </button>
          </form>

          {/* Footer note */}
          <p className="text-center text-[11px] mt-6 font-medium" style={{ color: "rgba(0,100,150,0.35)" }}>
            Secured · UKTextiles Enterprise HR System
          </p>
        </div>
      </div>
    </div>
  );
}

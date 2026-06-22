import { useLocation } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import { useEffect } from "react";
import { Shield, User, ArrowLeft } from "lucide-react";

export default function LoginSelect() {
  const [, navigate] = useLocation();
  const { isAuthenticated, user } = useAuth();

  useEffect(() => {
    if (isAuthenticated && user) {
      navigate(user.role === "hr" ? "/hr/dashboard" : "/employee/dashboard");
    }
  }, [isAuthenticated, user, navigate]);

  return (
    <div className="min-h-screen bg-sidebar flex flex-col items-center justify-center px-6">
      <div className="absolute inset-0 opacity-5" style={{
        backgroundImage: `repeating-linear-gradient(45deg, transparent, transparent 10px, rgba(255,255,255,0.1) 10px, rgba(255,255,255,0.1) 11px)`,
      }} />

      <div className="relative w-full max-w-md">
        <button onClick={() => navigate("/")} className="flex items-center gap-2 text-white/40 hover:text-white/70 text-sm mb-8 transition-colors">
          <ArrowLeft size={16} /> Back
        </button>

        <div className="mb-10 text-center">
          <h1 className="text-3xl font-black text-white">Welcome Back</h1>
          <p className="text-white/50 mt-2 text-sm">Select your login type to continue</p>
        </div>

        <div className="space-y-4">
          <button
            data-testid="button-hr-login"
            onClick={() => navigate("/hr-login")}
            className="w-full p-6 rounded-2xl border border-white/10 bg-white/5 hover:bg-white/10 hover:border-accent/50 text-left transition-all group"
          >
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-xl bg-accent/20 flex items-center justify-center group-hover:bg-accent/30 transition-colors">
                <Shield size={22} className="text-accent" />
              </div>
              <div>
                <p className="text-white font-bold text-base">HR Login</p>
                <p className="text-white/40 text-sm mt-0.5">Access the HR management dashboard</p>
              </div>
            </div>
          </button>

          <button
            data-testid="button-employee-login"
            onClick={() => navigate("/employee-login")}
            className="w-full p-6 rounded-2xl border border-white/10 bg-white/5 hover:bg-white/10 hover:border-accent/50 text-left transition-all group"
          >
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-xl bg-white/10 flex items-center justify-center group-hover:bg-white/20 transition-colors">
                <User size={22} className="text-white/70" />
              </div>
              <div>
                <p className="text-white font-bold text-base">Employee Login</p>
                <p className="text-white/40 text-sm mt-0.5">View your profile, salary, and leave</p>
              </div>
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}

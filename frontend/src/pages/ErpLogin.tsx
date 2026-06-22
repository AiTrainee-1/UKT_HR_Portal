import { useState } from "react";
import { useLocation } from "wouter";
import { motion } from "framer-motion";
import { BarChart3, Eye, EyeOff, ArrowLeft, Layers } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function ErpLogin() {
  const [, navigate] = useLocation();
  const [userId, setUserId] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    await new Promise(r => setTimeout(r, 800));
    setLoading(false);
    setError("ERP Portal is under development. Please check back soon.");
  };

  return (
    <div className="min-h-screen relative overflow-hidden flex items-center justify-center" style={{
      background: "linear-gradient(135deg, #0f1923 0%, #1a2a3a 40%, #0d2137 70%, #0a1628 100%)",
    }}>
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-[-20%] right-[-10%] w-[500px] h-[500px] rounded-full opacity-10"
          style={{ background: "radial-gradient(circle, #06b6d4 0%, transparent 70%)" }} />
        <div className="absolute bottom-[-10%] left-[-10%] w-[400px] h-[400px] rounded-full opacity-10"
          style={{ background: "radial-gradient(circle, #14b8a6 0%, transparent 70%)" }} />
        <div className="absolute inset-0 opacity-[0.03]" style={{
          backgroundImage: "linear-gradient(rgba(255,255,255,0.5) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.5) 1px, transparent 1px)",
          backgroundSize: "60px 60px",
        }} />
      </div>

      <div className="relative w-full max-w-md px-6">
        <button onClick={() => navigate("/")}
          className="flex items-center gap-2 text-white/40 hover:text-white/70 text-sm mb-8 transition-colors">
          <ArrowLeft size={16} />
          Back to Portal Selection
        </button>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="rounded-2xl p-8"
          style={{
            background: "rgba(255,255,255,0.04)",
            backdropFilter: "blur(20px)",
            border: "1px solid rgba(255,255,255,0.1)",
            boxShadow: "0 8px 32px rgba(0,0,0,0.3)",
          }}
        >
          <div className="text-center mb-8">
            <div className="flex items-center justify-center gap-3 mb-4">
              <div className="w-12 h-12 rounded-xl flex items-center justify-center"
                style={{ background: "linear-gradient(135deg, #06b6d4, #14b8a6)" }}>
                <BarChart3 size={22} className="text-white" />
              </div>
            </div>
            <h2 className="text-2xl font-black text-white">ERP Portal</h2>
            <p className="text-white/40 text-sm mt-1">UKTextiles Enterprise Resource Planning</p>
          </div>

          <form onSubmit={handleLogin} className="space-y-5">
            <div className="space-y-1.5">
              <Label className="text-white/70 text-sm font-medium">ERP User ID</Label>
              <Input
                value={userId}
                onChange={e => setUserId(e.target.value)}
                placeholder="Enter your ERP User ID"
                required
                className="h-11 text-sm"
                style={{
                  background: "rgba(255,255,255,0.06)",
                  border: "1px solid rgba(255,255,255,0.1)",
                  color: "white",
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-white/70 text-sm font-medium">Password</Label>
              <div className="relative">
                <Input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="Enter your password"
                  required
                  className="h-11 text-sm pr-10"
                  style={{
                    background: "rgba(255,255,255,0.06)",
                    border: "1px solid rgba(255,255,255,0.1)",
                    color: "white",
                  }}
                />
                <button type="button" onClick={() => setShowPassword(s => !s)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-white/40 hover:text-white/70">
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>

            {error && (
              <div className="text-sm p-3 rounded-lg text-amber-300"
                style={{ background: "rgba(251,191,36,0.1)", border: "1px solid rgba(251,191,36,0.2)" }}>
                {error}
              </div>
            )}

            <Button
              type="submit"
              disabled={loading}
              className="w-full h-11 font-bold text-sm"
              style={{ background: "linear-gradient(135deg, #06b6d4, #14b8a6)", border: "none" }}
            >
              {loading ? "Signing in..." : "Sign In to ERP"}
            </Button>
          </form>

          <div className="mt-6 p-3 rounded-lg text-center"
            style={{ background: "rgba(251,191,36,0.08)", border: "1px solid rgba(251,191,36,0.15)" }}>
            <p className="text-xs text-amber-300/80 font-medium">Phase 2 — Under Development</p>
            <p className="text-xs text-white/30 mt-0.5">ERP Portal will be available in the next release</p>
          </div>
        </motion.div>
      </div>
    </div>
  );
}

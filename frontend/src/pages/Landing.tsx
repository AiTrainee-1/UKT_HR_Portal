import { useLocation } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import { useEffect } from "react";
import { motion } from "framer-motion";
import { Users, BarChart3, ArrowRight, Building2, Layers } from "lucide-react";

export default function Landing() {
  const [, navigate] = useLocation();
  const { isAuthenticated, user } = useAuth();

  useEffect(() => {
    if (isAuthenticated && user) {
      navigate(user.role === "hr" ? "/hr/dashboard" : "/employee/dashboard");
    }
  }, [isAuthenticated, user, navigate]);

  return (
    <div className="min-h-screen relative overflow-hidden" style={{
      background: "linear-gradient(135deg, #0f1923 0%, #1a2a3a 40%, #0d2137 70%, #0a1628 100%)",
    }}>
      {/* Animated background elements */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-[-20%] left-[-10%] w-[600px] h-[600px] rounded-full opacity-10"
          style={{ background: "radial-gradient(circle, #3b82f6 0%, transparent 70%)" }} />
        <div className="absolute bottom-[-20%] right-[-10%] w-[500px] h-[500px] rounded-full opacity-10"
          style={{ background: "radial-gradient(circle, #06b6d4 0%, transparent 70%)" }} />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] rounded-full opacity-5"
          style={{ background: "radial-gradient(circle, #818cf8 0%, transparent 60%)" }} />
        {/* Textile grid pattern */}
        <div className="absolute inset-0 opacity-[0.03]" style={{
          backgroundImage: `
            linear-gradient(rgba(255,255,255,0.5) 1px, transparent 1px),
            linear-gradient(90deg, rgba(255,255,255,0.5) 1px, transparent 1px)
          `,
          backgroundSize: "60px 60px",
        }} />
      </div>

      <div className="relative min-h-screen flex flex-col items-center justify-center px-6 py-12">
        {/* Brand Header */}
        <motion.div
          initial={{ opacity: 0, y: -30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, ease: "easeOut" }}
          className="text-center mb-16"
        >
          {/* Logo area - unchanged */}
          <div className="flex items-center justify-center gap-4 mb-6">
            <div className="flex items-center gap-2">
              <div className="w-12 h-12 rounded-xl flex items-center justify-center"
                style={{ background: "linear-gradient(135deg, #3b82f6, #06b6d4)" }}>
                <Layers size={24} className="text-white" />
              </div>
            </div>
            <div className="text-left">
              <p className="text-xs font-bold tracking-[0.4em] uppercase text-cyan-400">Est. 2020</p>
              <h1 className="text-5xl lg:text-6xl font-black text-white leading-none tracking-tight">
                UK<span className="text-cyan-400">Textiles</span>
              </h1>
            </div>
          </div>
          <p className="text-white/50 text-base max-w-lg mx-auto leading-relaxed">
            Enterprise Management Platform — HR &amp; ERP for precision manufacturing operations
          </p>

          {/* Stats */}
          <div className="flex items-center justify-center gap-10 mt-8">
            {[
              { value: "500+", label: "Employees" },
              { value: "12", label: "Departments" },
              { value: "100%", label: "Data Control" },
            ].map(({ value, label }) => (
              <div key={label} className="text-center">
                <p className="text-2xl font-black text-cyan-400">{value}</p>
                <p className="text-white/40 text-xs uppercase tracking-widest mt-0.5">{label}</p>
              </div>
            ))}
          </div>
        </motion.div>

        {/* Portal Cards */}
        <div className="grid md:grid-cols-2 gap-6 w-full max-w-3xl">
          {/* HR Portal Card */}
          <motion.div
            initial={{ opacity: 0, x: -40 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.6, delay: 0.2, ease: "easeOut" }}
            whileHover={{ scale: 1.02, y: -4 }}
            onClick={() => navigate("/hr-login")}
            className="group cursor-pointer rounded-2xl p-8 relative overflow-hidden"
            style={{
              background: "rgba(255, 255, 255, 0.04)",
              backdropFilter: "blur(20px)",
              border: "1px solid rgba(255, 255, 255, 0.1)",
              boxShadow: "0 8px 32px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.08)",
            }}
          >
            <div className="absolute inset-0 rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-300"
              style={{ background: "linear-gradient(135deg, rgba(59,130,246,0.1) 0%, transparent 60%)" }} />

            <div className="relative">
              <div className="w-14 h-14 rounded-xl flex items-center justify-center mb-5"
                style={{ background: "linear-gradient(135deg, rgba(59,130,246,0.2), rgba(99,102,241,0.2))", border: "1px solid rgba(59,130,246,0.3)" }}>
                <Users size={26} className="text-blue-400" />
              </div>

              <h2 className="text-2xl font-black text-white mb-2">HR Portal</h2>
              <p className="text-white/50 text-sm leading-relaxed mb-6">
                Employee management, payroll processing, attendance tracking, leave management, and workforce analytics.
              </p>

              <div className="flex flex-wrap gap-2 mb-6">
                {["Employees", "Payroll", "Attendance", "Leaves", "Reports"].map(tag => (
                  <span key={tag} className="text-xs px-2.5 py-1 rounded-full font-medium"
                    style={{ background: "rgba(59,130,246,0.15)", color: "#93c5fd", border: "1px solid rgba(59,130,246,0.2)" }}>
                    {tag}
                  </span>
                ))}
              </div>

              <div className="flex items-center gap-2 text-blue-400 font-semibold text-sm group-hover:gap-3 transition-all">
                <span>Enter HR Portal</span>
                <ArrowRight size={16} className="group-hover:translate-x-1 transition-transform" />
              </div>
            </div>
          </motion.div>

          {/* ERP Portal Card */}
          <motion.div
            initial={{ opacity: 0, x: 40 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.6, delay: 0.3, ease: "easeOut" }}
            whileHover={{ scale: 1.02, y: -4 }}
            onClick={() => navigate("/erp-login")}
            className="group cursor-pointer rounded-2xl p-8 relative overflow-hidden"
            style={{
              background: "rgba(255, 255, 255, 0.04)",
              backdropFilter: "blur(20px)",
              border: "1px solid rgba(255, 255, 255, 0.1)",
              boxShadow: "0 8px 32px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.08)",
            }}
          >
            <div className="absolute inset-0 rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-300"
              style={{ background: "linear-gradient(135deg, rgba(6,182,212,0.1) 0%, transparent 60%)" }} />

            <div className="relative">
              <div className="w-14 h-14 rounded-xl flex items-center justify-center mb-5"
                style={{ background: "linear-gradient(135deg, rgba(6,182,212,0.2), rgba(20,184,166,0.2))", border: "1px solid rgba(6,182,212,0.3)" }}>
                <BarChart3 size={26} className="text-cyan-400" />
              </div>

              <h2 className="text-2xl font-black text-white mb-2">ERP Portal</h2>
              <p className="text-white/50 text-sm leading-relaxed mb-6">
                Production planning, merchandising, inventory, fabric management, order tracking, and supply chain operations.
              </p>

              <div className="flex flex-wrap gap-2 mb-6">
                {["Production", "Inventory", "Orders", "Quality", "Finance"].map(tag => (
                  <span key={tag} className="text-xs px-2.5 py-1 rounded-full font-medium"
                    style={{ background: "rgba(6,182,212,0.15)", color: "#67e8f9", border: "1px solid rgba(6,182,212,0.2)" }}>
                    {tag}
                  </span>
                ))}
              </div>

              <div className="flex items-center gap-2 font-semibold text-sm group-hover:gap-3 transition-all" style={{ color: "#67e8f9" }}>
                <span>Enter ERP Portal</span>
                <ArrowRight size={16} className="group-hover:translate-x-1 transition-transform" />
              </div>

              <div className="absolute top-4 right-4 text-xs px-2.5 py-1 rounded-full font-bold"
                style={{ background: "rgba(251,191,36,0.15)", color: "#fbbf24", border: "1px solid rgba(251,191,36,0.3)" }}>
                Phase 2
              </div>
            </div>
          </motion.div>
        </div>

        {/* Footer */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.8 }}
          className="mt-14 text-center"
        >
          <p className="text-white/20 text-xs">
            UKTextiles Enterprise Platform &nbsp;|&nbsp; On-Premise &nbsp;|&nbsp; Confidential
          </p>
          <p className="text-white/10 text-xs mt-1">
            <a href="https://uktextiles.in" className="hover:text-white/30 transition-colors">uktextiles.in</a>
          </p>
        </motion.div>
      </div>
    </div>
  );
}

import { useLocation } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import { useEffect } from "react";
import { Users, BarChart3, ArrowRight } from "lucide-react";

export default function Landing() {
  const [, navigate] = useLocation();
  const { isAuthenticated, user } = useAuth();

  useEffect(() => {
    if (isAuthenticated && user) {
      navigate(user.role === "hr" ? "/hr/dashboard" : "/employee/dashboard");
    }
  }, [isAuthenticated, user, navigate]);

  return (
    <div
      className="min-h-screen relative overflow-hidden flex flex-col items-center justify-center px-6 py-12"
      style={{
        background: "linear-gradient(135deg, #f0f5fa 0%, #e8f2f8 50%, #eef4fc 100%)",
        fontFamily: "'Hanken Grotesk', 'Inter', sans-serif",
      }}
    >
      {/* ── Ambient blobs ── */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div
          className="blob-animate absolute top-[-15%] right-[-10%] w-[550px] h-[550px] rounded-full opacity-25"
          style={{ background: "radial-gradient(circle at 40% 40%, #4FB8F0 0%, transparent 65%)" }}
        />
        <div
          className="blob-animate absolute bottom-[-15%] left-[-10%] w-[500px] h-[500px] rounded-full opacity-18"
          style={{
            background: "radial-gradient(circle at 60% 60%, #006496 0%, transparent 65%)",
            animationDelay: "3s",
          }}
        />
        <div
          className="blob-animate absolute top-[35%] left-[20%] w-[350px] h-[350px] rounded-full opacity-12"
          style={{
            background: "radial-gradient(circle, #5dbbff 0%, transparent 65%)",
            animationDelay: "6s",
          }}
        />
      </div>

      {/* ── Brand Header ── */}
      <div className="relative text-center mb-14 clay-fade-in">
        <div className="flex items-center justify-center gap-5 mb-5">
          {/* UKT SVG Logo */}
          <div
            className="p-3 rounded-2xl"
            style={{
              background: "#ffffff",
              boxShadow:
                "10px 10px 24px rgba(0,100,150,0.12), -6px -6px 18px rgba(255,255,255,0.9), inset 3px 3px 8px rgba(255,255,255,0.7)",
            }}
          >
            <svg viewBox="0 0 1536 1024" className="h-14 w-auto" aria-label="UKTextiles Logo">
              <defs>
                <mask id="ukt-landing-ring-gap">
                  <rect x="0" y="0" width="1536" height="1024" fill="white" />
                  <ellipse cx="793" cy="512" rx="595" ry="382" fill="black" />
                </mask>
              </defs>
              <ellipse cx="793" cy="512" rx="608" ry="391" fill="#4FB8F0" mask="url(#ukt-landing-ring-gap)" />
              <ellipse cx="793" cy="512" rx="585" ry="375" fill="#4FB8F0" />
              <path
                fill="#FFFFFF"
                d="M 447,215 L 448,642 L 452,674 L 461,710 L 476,744 L 493,768 L 510,784 L 524,793 L 556,805 L 582,809 L 616,809 L 642,804 L 668,793 L 691,774 L 708,750 L 727,707 L 836,804 L 923,805 L 771,669 L 824,494 L 905,267 L 974,266 L 975,805 L 1027,805 L 1027,267 L 1124,266 L 1124,216 L 875,216 L 777,487 L 733,629 L 732,216 L 681,216 L 681,638 L 677,673 L 667,710 L 658,727 L 641,745 L 618,755 L 586,756 L 559,749 L 539,736 L 519,711 L 507,682 L 499,633 L 499,215 Z"
              />
            </svg>
          </div>

          <div className="text-left">
            <p
              className="text-[11px] font-bold tracking-[0.35em] uppercase mb-1"
              style={{ color: "rgba(0,100,150,0.45)" }}
            >
              Est. 2020
            </p>
            <h1 className="text-5xl lg:text-6xl font-black leading-none tracking-tight" style={{ color: "#006496" }}>
              UK<span style={{ color: "#4FB8F0" }}>Textiles</span>
            </h1>
          </div>
        </div>

        <p className="text-base max-w-lg mx-auto leading-relaxed font-medium" style={{ color: "rgba(0,80,120,0.6)" }}>
          Enterprise Management Platform — HR &amp; ERP for precision manufacturing operations
        </p>

        {/* Stats */}
        {/* <div className="flex items-center justify-center gap-8 mt-8">
          {[
            { value: "500+", label: "Employees" },
            { value: "12", label: "Departments" },
            { value: "100%", label: "Data Control" },
          ].map(({ value, label }) => (
            <div
              key={label}
              className="text-center px-5 py-3 rounded-2xl"
              style={{
                background: "#ffffff",
                boxShadow:
                  "8px 8px 18px rgba(0,100,150,0.10), -4px -4px 12px rgba(255,255,255,0.85), inset 2px 2px 5px rgba(255,255,255,0.6)",
              }}
            >
              <p className="text-2xl font-black leading-none" style={{ color: "#006496" }}>{value}</p>
              <p className="text-[10px] uppercase tracking-widest mt-1 font-bold" style={{ color: "rgba(0,100,150,0.45)" }}>
                {label}
              </p>
            </div>
          ))}
        </div> */}
      </div>

      {/* ── Portal Cards ── */}
      <div className="relative grid md:grid-cols-2 gap-6 w-full max-w-3xl">

        {/* HR Portal Card */}
        <div
          onClick={() => navigate("/hr-login")}
          className="group cursor-pointer rounded-3xl p-8 relative overflow-hidden transition-all duration-300 hover:scale-[1.02] hover:-translate-y-1 clay-fade-in"
          style={{
            background: "#ffffff",
            boxShadow:
              "12px 12px 28px rgba(0,100,150,0.12), -6px -6px 20px rgba(255,255,255,0.9), inset 4px 4px 10px rgba(255,255,255,0.7), inset -4px -4px 12px rgba(0,100,150,0.04)",
            animationDelay: "0.1s",
          }}
        >
          {/* Hover glow */}
          <div
            className="absolute inset-0 rounded-3xl opacity-0 group-hover:opacity-100 transition-opacity duration-400 pointer-events-none"
            style={{ background: "linear-gradient(135deg, rgba(0,100,150,0.04) 0%, transparent 60%)" }}
          />

          <div className="relative">
            <div
              className="w-14 h-14 rounded-2xl flex items-center justify-center mb-5"
              style={{
                background: "linear-gradient(135deg, #006496, #0096c7)",
                boxShadow: "6px 6px 14px rgba(0,100,150,0.25), -3px -3px 8px rgba(255,255,255,0.6)",
              }}
            >
              <Users size={26} className="text-white" />
            </div>

            <h2 className="text-2xl font-black mb-2" style={{ color: "#1a3a4a" }}>HR Portal</h2>
            <p className="text-sm leading-relaxed mb-6 font-medium" style={{ color: "rgba(0,80,120,0.55)" }}>
              Employee management, payroll processing, attendance tracking, leave management, and workforce analytics.
            </p>

            <div className="flex flex-wrap gap-2 mb-6">
              {["Employees", "Payroll", "Attendance", "Leaves", "Reports"].map(tag => (
                <span
                  key={tag}
                  className="text-xs px-3 py-1 rounded-full font-semibold"
                  style={{
                    background: "rgba(0,100,150,0.07)",
                    color: "#006496",
                    boxShadow: "inset 2px 2px 4px rgba(0,100,150,0.05), inset -2px -2px 4px rgba(255,255,255,0.8)",
                  }}
                >
                  {tag}
                </span>
              ))}
            </div>

            <div
              className="flex items-center gap-2 font-bold text-sm group-hover:gap-3 transition-all"
              style={{ color: "#006496" }}
            >
              <span>Enter HR Portal</span>
              <ArrowRight size={16} className="group-hover:translate-x-1 transition-transform" />
            </div>
          </div>
        </div>

        {/* ERP Portal Card */}
        <div
          onClick={() => navigate("/erp-login")}
          className="group cursor-pointer rounded-3xl p-8 relative overflow-hidden transition-all duration-300 hover:scale-[1.02] hover:-translate-y-1 clay-fade-in"
          style={{
            background: "#ffffff",
            boxShadow:
              "12px 12px 28px rgba(0,100,150,0.12), -6px -6px 20px rgba(255,255,255,0.9), inset 4px 4px 10px rgba(255,255,255,0.7), inset -4px -4px 12px rgba(0,100,150,0.04)",
            animationDelay: "0.2s",
          }}
        >
          <div
            className="absolute inset-0 rounded-3xl opacity-0 group-hover:opacity-100 transition-opacity duration-400 pointer-events-none"
            style={{ background: "linear-gradient(135deg, rgba(0,150,199,0.04) 0%, transparent 60%)" }}
          />

          {/* Phase 2 badge */}
          <div
            className="absolute top-5 right-5 text-xs px-2.5 py-1 rounded-full font-bold"
            style={{
              background: "rgba(245,158,11,0.12)",
              color: "#d97706",
              boxShadow: "inset 2px 2px 4px rgba(245,158,11,0.08), inset -2px -2px 4px rgba(255,255,255,0.8)",
            }}
          >
            Phase 2
          </div>

          <div className="relative">
            <div
              className="w-14 h-14 rounded-2xl flex items-center justify-center mb-5"
              style={{
                background: "linear-gradient(135deg, #0096c7, #4FB8F0)",
                boxShadow: "6px 6px 14px rgba(0,150,199,0.2), -3px -3px 8px rgba(255,255,255,0.6)",
              }}
            >
              <BarChart3 size={26} className="text-white" />
            </div>

            <h2 className="text-2xl font-black mb-2" style={{ color: "#1a3a4a" }}>ERP Portal</h2>
            <p className="text-sm leading-relaxed mb-6 font-medium" style={{ color: "rgba(0,80,120,0.55)" }}>
              Production planning, merchandising, inventory, fabric management, order tracking, and supply chain operations.
            </p>

            <div className="flex flex-wrap gap-2 mb-6">
              {["Production", "Inventory", "Orders", "Quality", "Finance"].map(tag => (
                <span
                  key={tag}
                  className="text-xs px-3 py-1 rounded-full font-semibold"
                  style={{
                    background: "rgba(0,150,199,0.07)",
                    color: "#0096c7",
                    boxShadow: "inset 2px 2px 4px rgba(0,150,199,0.05), inset -2px -2px 4px rgba(255,255,255,0.8)",
                  }}
                >
                  {tag}
                </span>
              ))}
            </div>

            <div
              className="flex items-center gap-2 font-bold text-sm group-hover:gap-3 transition-all"
              style={{ color: "#0096c7" }}
            >
              <span>Enter ERP Portal</span>
              <ArrowRight size={16} className="group-hover:translate-x-1 transition-transform" />
            </div>
          </div>
        </div>
      </div>

      {/* ── Footer ── */}
      <div className="relative mt-12 text-center clay-fade-in" style={{ animationDelay: "0.3s" }}>
        <p className="text-xs font-medium" style={{ color: "rgba(0,100,150,0.3)" }}>
          UKTextiles Enterprise Platform &nbsp;·&nbsp; On-Premise &nbsp;·&nbsp; Role-Based Access Control &nbsp;·&nbsp; Confidential
        </p>
      </div>
    </div>
  );
}

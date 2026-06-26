import { Link, useLocation } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import { useState } from "react";
import {
  LayoutDashboard, Factory, Package, ShoppingCart, Boxes, Scissors,
  Layers, ClipboardCheck, Truck, Users, Building2, DollarSign,
  BarChart3, Settings, LogOut, Menu, X, ChevronRight, Shirt,
  Wand2, Waves, Zap, PackageCheck, Globe,
} from "lucide-react";

const navItems = [
  { path: "/erp/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { path: "/erp/production", label: "Production Planning", icon: Factory },
  { path: "/erp/merchandising", label: "Merchandising", icon: Shirt },
  { path: "/erp/purchase", label: "Purchase Management", icon: ShoppingCart },
  { path: "/erp/inventory", label: "Inventory Management", icon: Boxes },
  { path: "/erp/fabric", label: "Fabric Management", icon: Layers },
  { path: "/erp/accessories", label: "Accessories", icon: Package },
  { path: "/erp/orders", label: "Order Management", icon: ClipboardCheck },
  { path: "/erp/sampling", label: "Sampling", icon: Wand2 },
  { path: "/erp/quality", label: "Quality Control", icon: Zap },
  { path: "/erp/cutting", label: "Cutting", icon: Scissors },
  { path: "/erp/sewing", label: "Sewing", icon: Waves },
  { path: "/erp/finishing", label: "Finishing", icon: PackageCheck },
  { path: "/erp/packing", label: "Packing", icon: Package },
  { path: "/erp/shipment", label: "Shipment Management", icon: Truck },
  { path: "/erp/vendors", label: "Vendor Management", icon: Building2 },
  { path: "/erp/customers", label: "Customer Management", icon: Globe },
  { path: "/erp/finance", label: "Accounts & Finance", icon: DollarSign },
  { path: "/erp/reports", label: "Reports", icon: BarChart3 },
  { path: "/erp/settings", label: "Settings", icon: Settings },
];

export default function ErpLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { user, logout } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="flex h-screen" style={{ background: "#f0f4f8" }}>
      <aside className={`
        fixed inset-y-0 left-0 z-50 flex flex-col w-64 overflow-hidden
        transform transition-transform duration-200
        ${mobileOpen ? "translate-x-0" : "-translate-x-full"}
        lg:relative lg:translate-x-0
      `} style={{
        background: "linear-gradient(180deg, #0d2137 0%, #0f2a1e 100%)",
        borderRight: "1px solid rgba(255,255,255,0.06)",
      }}>
        {/* Brand */}
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center"
              style={{ background: "linear-gradient(135deg, #06b6d4, #14b8a6)" }}>
              <Factory size={16} className="text-white" />
            </div>
            <div>
              <p className="text-[10px] font-bold tracking-[0.3em] uppercase text-cyan-400/80">ERP Portal</p>
              <h1 className="text-base font-black text-white leading-none">UKTextiles</h1>
            </div>
          </div>
          <button onClick={() => setMobileOpen(false)} className="lg:hidden text-white/40 hover:text-white">
            <X size={18} />
          </button>
        </div>

        <div className="px-5 py-3" style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white"
              style={{ background: "linear-gradient(135deg, #06b6d4, #14b8a6)" }}>
              {(user?.name ?? "E").charAt(0).toUpperCase()}
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-white truncate">{user?.name ?? "ERP Admin"}</p>
              <p className="text-xs text-white/40">ERP Manager</p>
            </div>
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto py-3 px-3">
          {navItems.map(({ path, label, icon: Icon }) => {
            const active = location === path;
            return (
              <Link key={path} href={path} onClick={() => setMobileOpen(false)}>
                <div className={`flex items-center gap-3 px-3 py-2 rounded-lg mb-0.5 cursor-pointer transition-all text-sm ${
                  active ? "bg-white/10 text-white" : "text-white/50 hover:bg-white/5 hover:text-white/80"
                }`}>
                  <Icon size={16} />
                  <span className="flex-1 font-medium">{label}</span>
                  {active && <ChevronRight size={12} className="opacity-60" />}
                </div>
              </Link>
            );
          })}
        </nav>

        <div className="px-3 py-3" style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}>
          <button onClick={logout}
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-white/50 hover:text-white hover:bg-white/5 transition-all text-sm font-medium">
            <LogOut size={16} />
            <span>Sign Out</span>
          </button>
        </div>
      </aside>

      {mobileOpen && (
        <div className="fixed inset-0 z-40 bg-black/60 lg:hidden" onClick={() => setMobileOpen(false)} />
      )}

      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <header className="flex items-center gap-4 px-4 py-3 lg:hidden bg-white border-b">
          <button onClick={() => setMobileOpen(true)}><Menu size={20} /></button>
          <h1 className="font-bold text-lg text-gray-900">UKTextiles ERP</h1>
        </header>
        <main className="flex-1 overflow-y-auto p-4 lg:p-6">{children}</main>
      </div>
    </div>
  );
}

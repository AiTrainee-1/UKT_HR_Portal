import ErpLayout from "@/components/ErpLayout";
import { Construction, ArrowRight } from "lucide-react";

interface ErpPlaceholderProps {
  title: string;
  description: string;
  features: string[];
}

export function ErpPlaceholder({ title, description, features }: ErpPlaceholderProps) {
  return (
    <ErpLayout>
      <div className="max-w-3xl">
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-2">
            <h2 className="text-2xl font-black text-gray-900">{title}</h2>
            <span className="text-xs px-2.5 py-1 rounded-full font-bold bg-amber-50 text-amber-700 border border-amber-200">
              Phase 2
            </span>
          </div>
          <p className="text-muted-foreground text-sm">{description}</p>
        </div>

        <div className="rounded-2xl border-2 border-dashed border-gray-200 bg-gray-50 p-10 text-center mb-8">
          <Construction size={48} className="mx-auto text-gray-300 mb-4" />
          <h3 className="text-lg font-bold text-gray-700 mb-2">Under Development</h3>
          <p className="text-sm text-gray-400 max-w-md mx-auto">
            This module is being designed and will be available in Phase 2 of the ERP implementation.
            The UI structure and navigation are already in place.
          </p>
        </div>

        <div className="grid sm:grid-cols-2 gap-3">
          {features.map(feature => (
            <div key={feature} className="flex items-center gap-2.5 p-3 rounded-xl bg-white border hover:border-cyan-300 transition-colors">
              <ArrowRight size={14} className="text-cyan-500 shrink-0" />
              <span className="text-sm text-gray-700 font-medium">{feature}</span>
            </div>
          ))}
        </div>
      </div>
    </ErpLayout>
  );
}

// ── Individual ERP Module Pages ────────────────────────────────────────────

export function ErpDashboard() {
  return <ErpPlaceholder
    title="ERP Dashboard"
    description="Real-time production overview, KPIs, order status, and factory analytics"
    features={["Production KPI Cards", "Order Status Overview", "Fabric Consumption Tracker", "Worker Efficiency Chart", "Shipment Calendar", "Revenue vs Target"]}
  />;
}

export function ProductionPlanning() {
  return <ErpPlaceholder
    title="Production Planning"
    description="Plan and schedule production runs, assign resources, and track capacity"
    features={["Production Order Creation", "Line Balancing", "Capacity Planning", "Resource Allocation", "Delivery Schedule", "Production Calendar"]}
  />;
}

export function Merchandising() {
  return <ErpPlaceholder
    title="Merchandising"
    description="Manage buyer orders, tech packs, costing, and approval workflow"
    features={["Buyer Order Management", "Tech Pack Upload", "Sample Approval Workflow", "Cost Sheet", "PP Meeting Tracker", "Milestone Calendar"]}
  />;
}

export function PurchaseManagement() {
  return <ErpPlaceholder
    title="Purchase Management"
    description="Raise purchase orders, track supplier deliveries, and manage procurement"
    features={["Purchase Order Creation", "Supplier Management", "PO Approval Workflow", "GRN (Goods Receipt)", "Invoice Matching", "Purchase Analytics"]}
  />;
}

export function InventoryManagement() {
  return <ErpPlaceholder
    title="Inventory Management"
    description="Track stock levels, movements, and inventory valuation across all stores"
    features={["Stock Dashboard", "Item Master", "Stock Transfer", "Low Stock Alerts", "Inventory Valuation", "Barcode/QR Support"]}
  />;
}

export function FabricManagement() {
  return <ErpPlaceholder
    title="Fabric Management"
    description="Manage fabric receipts, inspection, shrinkage, and consumption tracking"
    features={["Fabric Receipt", "Quality Inspection", "Shrinkage Analysis", "Fabric Issue to Cutting", "Wastage Tracking", "Fabric Balance Report"]}
  />;
}

export function AccessoriesManagement() {
  return <ErpPlaceholder
    title="Accessories Management"
    description="Track buttons, zippers, labels, trims, and all accessory inventory"
    features={["Accessories Master", "Receipt & Issue", "Order-wise Allocation", "Consumption Tracking", "Reorder Alerts", "Accessories Report"]}
  />;
}

export function OrderManagement() {
  return <ErpPlaceholder
    title="Order Management"
    description="Track buyer orders from placement to shipment with complete traceability"
    features={["Order Register", "Style-wise Tracking", "Order Status Board", "Delivery Commitment", "Order Analytics", "Buyer Communication Log"]}
  />;
}

export function Sampling() {
  return <ErpPlaceholder
    title="Sampling"
    description="Manage development samples, approval stages, and sample library"
    features={["Sample Development Register", "Proto / Fit / PP / SMS Tracking", "Approval Status", "Sample Costing", "Sample Dispatch", "Approval History"]}
  />;
}

export function QualityControl() {
  return <ErpPlaceholder
    title="Quality Control"
    description="Inline, end-line, and final inspection with defect tracking and AQL"
    features={["Inline Inspection", "End-Line Audit", "Final Audit (AQL)", "Defect Register", "Alteration Tracking", "Quality Reports"]}
  />;
}

export function Cutting() {
  return <ErpPlaceholder
    title="Cutting"
    description="Manage cutting plans, marker efficiency, and fabric utilization"
    features={["Cutting Order", "Marker Planning", "Lay Sheet", "Bundle Generation", "Cutting Efficiency", "Size-wise Cut Report"]}
  />;
}

export function Sewing() {
  return <ErpPlaceholder
    title="Sewing"
    description="Track line production, WIP, worker efficiency, and line balancing"
    features={["Line-wise Production", "WIP Tracking", "Operator Efficiency", "Operation Breakdown", "Hour-wise Output", "Line Performance"]}
  />;
}

export function Finishing() {
  return <ErpPlaceholder
    title="Finishing"
    description="Manage ironing, final inspection, tagging, and packing readiness"
    features={["Finishing Input Register", "Ironing Tracking", "Final Inspection", "Alteration Queue", "Packing Ready Report", "Thread Cutting"]}
  />;
}

export function Packing() {
  return <ErpPlaceholder
    title="Packing"
    description="Track packing by order, style, size, and carton-level dispatch"
    features={["Packing Instruction", "Carton Management", "Packing List", "Label Generation", "Size Ratio Packing", "Dispatch Checklist"]}
  />;
}

export function ShipmentManagement() {
  return <ErpPlaceholder
    title="Shipment Management"
    description="Manage exports, shipping docs, container booking, and customs clearance"
    features={["Shipment Register", "Container Booking", "Packing List Export", "Invoice & BL", "Freight Tracker", "Customs Documentation"]}
  />;
}

export function VendorManagement() {
  return <ErpPlaceholder
    title="Vendor Management"
    description="Manage suppliers, sub-contractors, and vendor performance evaluation"
    features={["Vendor Master", "Sub-contractor Registry", "Vendor Rating", "Job Work Tracking", "Payment Terms", "Vendor Report"]}
  />;
}

export function CustomerManagement() {
  return <ErpPlaceholder
    title="Customer Management"
    description="Buyer directory, contacts, order history, and buyer-specific configurations"
    features={["Buyer Master", "Contact Directory", "Order History", "Communication Log", "Buyer Terms", "Country-wise Buyers"]}
  />;
}

export function Finance() {
  return <ErpPlaceholder
    title="Accounts & Finance"
    description="Manage invoicing, payments, expenses, and financial reporting"
    features={["Invoice Management", "Payment Tracking", "Expense Records", "P&L Overview", "Cash Flow", "Tax Reports"]}
  />;
}

export function ErpReports() {
  return <ErpPlaceholder
    title="ERP Reports"
    description="Cross-module analytics, production summaries, and business intelligence"
    features={["Production Summary", "Order Status Report", "Fabric Utilization", "Worker Efficiency", "Shipment Report", "Revenue Analytics"]}
  />;
}

export function ErpSettings() {
  return <ErpPlaceholder
    title="ERP Settings"
    description="Configure ERP modules, users, workflows, and system preferences"
    features={["ERP User Management", "Module Configuration", "Workflow Rules", "Notification Settings", "Integration Setup", "Data Management"]}
  />;
}

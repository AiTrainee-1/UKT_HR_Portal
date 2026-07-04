import HrLayout from "@/components/HrLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Gift, Info, Percent, Calendar, IndianRupee, Scale } from "lucide-react";

/**
 * Bonus module — informational placeholder.
 * Explains how bonus is typically calculated in the Indian garments industry
 * (Payment of Bonus Act, 1965). Calculation engine will be added once the
 * company's bonus policy is finalised.
 */
export default function Bonus() {
  return (
    <HrLayout>
      <div className="space-y-5 max-w-4xl">
        <div>
          <h2 className="text-2xl font-black text-gray-900">Bonus</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Statutory & festival bonus — garments industry reference
          </p>
        </div>

        <div className="flex items-start gap-2 p-3 bg-blue-50 border border-blue-100 rounded-xl text-xs text-blue-700">
          <Info size={14} className="shrink-0 mt-0.5" />
          <span>
            This module is in <strong>planning stage</strong>. The reference below shows how bonus
            is generally calculated in the Indian garments industry. Once your company's bonus
            policy is confirmed, the automatic calculation and payout workflow will be enabled here.
          </span>
        </div>

        {/* How bonus works in garments industry */}
        <div className="grid sm:grid-cols-2 gap-4">
          {[
            {
              icon: Scale,
              color: "text-blue-600 bg-blue-50",
              title: "Payment of Bonus Act, 1965",
              body: "Applies to factories with 20+ employees. Employees earning up to ₹21,000/month who have worked at least 30 days in the accounting year are eligible for statutory bonus.",
            },
            {
              icon: Percent,
              color: "text-green-600 bg-green-50",
              title: "Bonus Percentage",
              body: "Minimum 8.33% of annual earned wages (basic + DA), maximum 20%. The exact rate depends on the company's allocable surplus for the financial year.",
            },
            {
              icon: IndianRupee,
              color: "text-purple-600 bg-purple-50",
              title: "Calculation Ceiling",
              body: "For employees earning above ₹7,000/month, bonus is calculated on ₹7,000 or the state minimum wage for the scheduled employment, whichever is higher.",
            },
            {
              icon: Calendar,
              color: "text-amber-600 bg-amber-50",
              title: "When It's Paid",
              body: "In the garments industry, bonus is customarily paid before Diwali/Pongal. Statutorily it must be paid within 8 months of the close of the accounting year.",
            },
          ].map(({ icon: Icon, color, title, body }) => (
            <Card key={title} className="border">
              <CardContent className="p-5">
                <div className={`w-9 h-9 rounded-xl flex items-center justify-center mb-3 ${color}`}>
                  <Icon size={17} />
                </div>
                <p className="font-bold text-sm text-gray-900 mb-1">{title}</p>
                <p className="text-xs text-gray-500 leading-relaxed">{body}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Example calculation */}
        <Card className="border">
          <CardHeader className="pb-3 pt-4 px-5">
            <CardTitle className="text-sm font-bold flex items-center gap-2">
              <Gift size={15} className="text-pink-500" /> Example Calculation (8.33% minimum)
            </CardTitle>
          </CardHeader>
          <CardContent className="px-5 pb-5">
            <div className="bg-gray-50 rounded-xl p-4 text-sm space-y-2 font-mono text-gray-700">
              <p>Monthly wage (basic + DA):        ₹12,000</p>
              <p>Calculation base (ceiling):       ₹7,000</p>
              <p>Months worked in the year:        12</p>
              <p className="border-t border-gray-300 pt-2">
                Annual bonus = ₹7,000 × 12 × 8.33% = <strong className="text-green-700">₹6,997</strong>
              </p>
            </div>
            <p className="text-xs text-muted-foreground mt-3">
              Planned features: eligibility auto-detection from payroll data, per-employee bonus
              register, percentage configuration in Settings, payout batch generation, and Form C
              (bonus register) export.
            </p>
          </CardContent>
        </Card>
      </div>
    </HrLayout>
  );
}

import { useRoute } from "wouter";
import { useVerifyEmployee } from "@/lib/api-client/custom-hooks";
import { User, ShieldCheck, ShieldX, Building2, Droplets, Calendar } from "lucide-react";

const BRAND = "#4FB8F0";
const BRAND_DARK = "#006496";

/**
 * PUBLIC page opened by scanning the QR code on an employee ID card.
 * Route: /verify/:code
 */
export default function VerifyEmployee() {
  const [, params] = useRoute("/verify/:code");
  const code = params?.code ?? "";
  const { data, isLoading, isError } = useVerifyEmployee(code);

  const verified = data?.verified === true;

  return (
    <div
      className="min-h-screen flex items-center justify-center p-4"
      style={{
        background: "linear-gradient(135deg, #f0f5fa 0%, #e8f2f8 50%, #eef4fc 100%)",
        fontFamily: "'Hanken Grotesk', 'Inter', sans-serif",
      }}
    >
      <div className="w-full max-w-sm">
        <div className="bg-white rounded-3xl shadow-xl overflow-hidden border">
          {/* Header */}
          <div
            className="px-6 py-5 text-white text-center"
            style={{ background: `linear-gradient(120deg, ${BRAND_DARK}, ${BRAND})` }}
          >
            {data?.company?.logo ? (
              <img src={data.company.logo} alt="" className="h-12 w-12 object-contain bg-white rounded-full p-1 mx-auto mb-2" />
            ) : (
              <div className="h-12 w-12 rounded-full bg-white flex items-center justify-center mx-auto mb-2">
                <Building2 size={20} style={{ color: BRAND_DARK }} />
              </div>
            )}
            <p className="font-black text-lg leading-tight">{data?.company?.name ?? "UKTextiles"}</p>
            {data?.company?.address && (
              <p className="text-xs opacity-90">{data.company.address}</p>
            )}
          </div>

          {isLoading ? (
            <div className="p-10 text-center text-sm text-gray-400">Verifying…</div>
          ) : isError || !data?.employee ? (
            <div className="p-8 text-center space-y-2">
              <div className="w-14 h-14 rounded-full bg-red-50 flex items-center justify-center mx-auto">
                <ShieldX size={26} className="text-red-500" />
              </div>
              <p className="font-black text-red-600">Not Verified</p>
              <p className="text-xs text-gray-500">
                No employee record found for code <strong className="font-mono">{code}</strong>.
                This card may be invalid or revoked.
              </p>
            </div>
          ) : (
            <div className="p-6 space-y-4">
              {/* Verification badge */}
              <div
                className={`flex items-center justify-center gap-2 py-2.5 rounded-2xl font-black text-sm ${
                  verified
                    ? "bg-green-50 text-green-700 border border-green-200"
                    : "bg-amber-50 text-amber-700 border border-amber-200"
                }`}
              >
                {verified ? <ShieldCheck size={17} /> : <ShieldX size={17} />}
                {verified ? "VERIFIED EMPLOYEE" : `EMPLOYEE — ${String(data.status).toUpperCase()}`}
              </div>

              {/* Photo + identity */}
              <div className="flex flex-col items-center">
                <div
                  className="w-24 h-28 rounded-2xl overflow-hidden border-4 flex items-center justify-center bg-gray-50"
                  style={{ borderColor: BRAND }}
                >
                  {data.employee.photoUrl
                    ? <img src={data.employee.photoUrl} className="w-full h-full object-cover" alt="" />
                    : <User size={38} className="text-gray-300" />}
                </div>
                <p className="mt-2.5 font-black text-lg text-gray-900">{data.employee.name}</p>
                <p className="text-sm font-bold" style={{ color: BRAND_DARK }}>
                  {data.employee.designation ?? "—"}
                </p>
              </div>

              {/* Details */}
              <div className="space-y-1.5 text-sm">
                {[
                  { label: "Employee Code", value: data.employee.code, mono: true },
                  { label: "Department", value: data.employee.department ?? "—" },
                  { label: "Employment Type", value: data.employee.employmentType ?? "—", cap: true },
                ].map(row => (
                  <div key={row.label} className="flex justify-between border-b border-dashed border-gray-200 pb-1.5">
                    <span className="text-gray-400 text-xs font-semibold">{row.label}</span>
                    <span className={`font-bold text-gray-900 text-xs ${row.mono ? "font-mono" : ""} ${row.cap ? "capitalize" : ""}`}>
                      {row.value}
                    </span>
                  </div>
                ))}
                {data.employee.bloodGroup && (
                  <div className="flex justify-between border-b border-dashed border-gray-200 pb-1.5">
                    <span className="text-gray-400 text-xs font-semibold flex items-center gap-1">
                      <Droplets size={11} className="text-red-400" /> Blood Group
                    </span>
                    <span className="font-bold text-gray-900 text-xs">{data.employee.bloodGroup}</span>
                  </div>
                )}
                {data.employee.joinDate && (
                  <div className="flex justify-between pb-0.5">
                    <span className="text-gray-400 text-xs font-semibold flex items-center gap-1">
                      <Calendar size={11} className="text-gray-400" /> Joined
                    </span>
                    <span className="font-bold text-gray-900 text-xs font-mono">{data.employee.joinDate}</span>
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="px-6 py-3 bg-gray-50 border-t text-center">
            <p className="text-[10px] text-gray-400">
              Identity verification service · {data?.company?.name ?? "UKTextiles"} HRMS
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

import { cn } from "@/lib/utils";
import { formatPercent } from "./preview";
import { TextLink } from "./ui";

const STATUS = {
  on: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  off: "bg-slate-100 text-slate-500 ring-slate-200",
};

function Status({ on, children }: { on: boolean; children: string }) {
  return (
    <span className={cn("ml-1.5 rounded-full px-2 py-0.5 text-[10px] font-bold ring-1", on ? STATUS.on : STATUS.off)}>
      {children}
    </span>
  );
}

/**
 * The order production payroll follows for every payslip's PF and ESI (payroll_views.py _generate_production_payroll):
 * a matching salary band first, then the flat rates if their switch is on, else nothing. Two mechanisms for one
 * deduction, so both tabs that touch production pay show this, with the current state of each switch.
 */
export function ProductionPfOrder({
  bandsOn,
  bandCount,
  flatOn,
  pfRate,
  esiRate,
  links = true,
}: {
  bandsOn: boolean;
  bandCount: number;
  flatOn: boolean;
  pfRate: number;
  esiRate: number;
  /** Link each step to where it is set (off when the steps sit right next to those settings). */
  links?: boolean;
}) {
  return (
    <ol className="space-y-2 text-[12px] leading-snug text-gray-700" data-testid="production-pf-order">
      <li className="flex gap-2">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-100 text-[11px] font-black text-blue-700">
          1
        </span>
        <span>
          <strong>Salary bands</strong>
          <Status on={bandsOn}>{bandsOn ? `ON - ${bandCount} band${bandCount === 1 ? "" : "s"}` : "OFF"}</Status>
          <br />
          If they are on and the worker's estimated monthly pay (period pay x 4 on Weekly, x 2 on BiWeekly, x 1 on
          Monthly) falls in a band, that band's PF % and EF % are deducted - even while the flat-rate switch is off.
          {links && (
            <>
              {" "}
              <TextLink to="/hr/settings?tab=payroll#pf-ef-switch">Production PF/EF</TextLink>
            </>
          )}
        </span>
      </li>
      <li className="flex gap-2">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-100 text-[11px] font-black text-blue-700">
          2
        </span>
        <span>
          <strong>Flat rates</strong>
          <Status on={flatOn}>{flatOn ? "ON" : "OFF"}</Status>
          <br />
          Otherwise, while their switch is on: PF {formatPercent(pfRate)} and ESI {formatPercent(esiRate)} of the period
          pay (ESI only while the estimate is at or below the production ESI ceiling).
          {links && (
            <>
              {" "}
              <TextLink to="/hr/settings?tab=payroll#prod-pf-esi-switch">Flat rates</TextLink>
            </>
          )}
        </span>
      </li>
      <li className="flex gap-2">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-100 text-[11px] font-black text-blue-700">
          3
        </span>
        <span>Otherwise no PF or ESI is deducted from that payslip.</span>
      </li>
    </ol>
  );
}

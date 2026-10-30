import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import {
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  FileSearch,
  Loader2,
  ReceiptText,
  RefreshCw,
  Settings as SettingsIcon,
  Phone,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, BusyIcon, Chip, PayStatusChip } from "@/components/payroll/kit/parts";
import { ExportMenu, type ExportItem } from "@/components/payroll/kit/ExportMenu";
import { ago, dateTime } from "@/components/payroll/kit/format";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import {
  downloadDocumentPdf,
  previewDocumentPdf,
  type PayrollDetails,
  type PayrollKind,
} from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import type { Accent } from "./accent";

const titleCase = (text: string): string => (text ? text.charAt(0).toUpperCase() + text.slice(1) : text);

/** Where the "Settings" button goes: the Settings tab that holds this kind of payroll's rules. */
export const settingsPathFor = (kind: PayrollKind): string =>
  kind === "production" ? "/hr/settings?tab=production_payroll" : "/hr/settings?tab=payroll";

/**
 * The top of the page: the way back, the way along (Previous / Next payroll of the same period), who this payroll is
 * for, what state it is in and when it was computed, and everything that can be done with it (mark paid, the payslip,
 * export, the Settings behind it).
 */
export function DetailsHeader({
  details,
  kind,
  accent,
  switching,
  backLabel,
  onBack,
  onNeighbour,
  onMarkPaid,
  markingPaid,
  onRefresh,
  refreshing,
  exportItems,
}: {
  details: PayrollDetails;
  kind: PayrollKind;
  accent: Accent;
  /** The next payroll is loading: the actions would act on the wrong one. */
  switching: boolean;
  backLabel: string;
  onBack: () => void;
  onNeighbour: (payrollId: number) => void;
  onMarkPaid: () => void;
  markingPaid: boolean;
  onRefresh: () => void;
  refreshing: boolean;
  exportItems: ExportItem[];
}) {
  const { employee, period, neighbours } = details;
  const pending = details.status === "pending";
  const computed = details.generatedAt;
  const regenerated = !!details.firstGeneratedAt && details.firstGeneratedAt !== details.generatedAt;

  // While the next payroll loads the page is inert, which drops the keyboard focus from the button that was pressed:
  // give it back once the new payroll is in, so a reviewer can keep pressing Next without reaching for the mouse.
  const prevButton = useRef<HTMLButtonElement>(null);
  const nextButton = useRef<HTMLButtonElement>(null);
  const pressed = useRef<"prev" | "next" | null>(null);
  useEffect(() => {
    if (switching || !pressed.current) return;
    const which = pressed.current;
    pressed.current = null;
    const frame = requestAnimationFrame(() => (which === "next" ? nextButton : prevButton).current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [switching, details.payrollId]);

  return (
    <header
      className="clay-card relative overflow-hidden rounded-2xl border border-slate-100 p-4 pt-5 sm:p-5 sm:pt-6"
      data-testid="pd-header"
    >
      <span className={cn("absolute inset-x-0 top-0 h-1", accent.bar)} aria-hidden="true" data-testid="pd-header-bar" />
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Button variant="outline" size="sm" className="h-9 gap-2" onClick={onBack} data-testid="pd-back">
          <ArrowLeft size={14} /> {backLabel}
        </Button>
        <div className="flex flex-wrap items-center justify-end gap-x-5 gap-y-2" data-testid="pd-top-right">
          <div className="flex flex-wrap items-center gap-2 print:hidden" data-testid="pd-actions">
            {employee.phone && <PhoneButton phone={employee.phone} name={employee.name} />}
            {pending && (
              <Button
                size="sm"
                className="h-9 gap-2 bg-emerald-600 bg-none text-white hover:bg-emerald-700"
                disabled={switching || markingPaid}
                onClick={onMarkPaid}
                title="Update this payroll's status to Cleared"
                data-testid="pd-mark-paid"
              >
                <BusyIcon busy={markingPaid} icon={CheckCircle2} /> Mark as Cleared
              </Button>
            )}
            <PayslipMenu details={details} disabled={switching} />
            <ExportMenu items={exportItems} disabled={switching} />
            <Button asChild variant="outline" size="sm" className="h-9 gap-2">
              <Link href={settingsPathFor(kind)} data-testid="pd-settings-link">
                <SettingsIcon size={14} /> Settings
              </Link>
            </Button>
          </div>
          <div className="flex items-center gap-2" role="group" aria-label="Move between payrolls">
            <span className="text-xs font-medium tabular-nums text-muted-foreground" data-testid="pd-position">
              {neighbours.position} of {neighbours.total}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="h-9 gap-1.5 px-2.5 sm:px-3"
              aria-label="Previous payroll"
              ref={prevButton}
              disabled={neighbours.previousId === null || switching}
              onClick={() => {
                if (neighbours.previousId === null) return;
                pressed.current = "prev";
                onNeighbour(neighbours.previousId);
              }}
              data-testid="pd-prev"
            >
              <ChevronLeft size={14} /> <span className="hidden sm:inline">Previous</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-9 gap-1.5 px-2.5 sm:px-3"
              aria-label="Next payroll"
              ref={nextButton}
              disabled={neighbours.nextId === null || switching}
              onClick={() => {
                if (neighbours.nextId === null) return;
                pressed.current = "next";
                onNeighbour(neighbours.nextId);
              }}
              data-testid="pd-next"
            >
              <span className="hidden sm:inline">Next</span> <ChevronRight size={14} />
            </Button>
          </div>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
        <div className="flex min-w-0 items-start gap-3 sm:gap-4">
          <Avatar name={employee.name} size={56} className="text-base" />
          <div className="min-w-0">
            <h2 className="flex flex-wrap items-baseline gap-x-2 text-xl font-black text-gray-900 sm:text-2xl">
              <span data-testid="pd-employee-name">{employee.name}</span>
              <span className="font-mono text-sm font-semibold text-muted-foreground" data-testid="pd-employee-code">
                {employee.code}
              </span>
            </h2>
            <div className="mt-2 flex flex-wrap items-center gap-1.5" data-testid="pd-chips">
              {employee.department && <Chip>{employee.department}</Chip>}
              {employee.designation && <Chip>{employee.designation}</Chip>}
              {employee.employmentType && <Chip tone="accent">{titleCase(employee.employmentType)}</Chip>}
              {employee.branch && <Chip>{employee.branch}</Chip>}
              {kind === "production" && (employee.payCycle || period.cycleLabel) && (
                <Chip tone="caution">{period.cycleLabel ?? titleCase(employee.payCycle ?? "")} cycle</Chip>
              )}
              {details.kind === "legacy_session" && <Chip tone="neutral">Legacy session payroll</Chip>}
              {employee.status && employee.status !== "active" && (
                <Chip tone="danger">{titleCase(employee.status)} employee</Chip>
              )}
              <Chip tone="info" title="The period this payroll pays for" className="font-bold">
                {period.label}
              </Chip>
              <span data-testid="pd-status">
                <PayStatusChip status={details.status} />
              </span>
            </div>
            <p
              className="mt-2 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground"
              data-testid="pd-computed"
            >
              <span>
                Last computed <strong className="font-semibold text-slate-700">{dateTime(computed)}</strong>
                {computed ? ` (${ago(computed)})` : ""}
              </span>
              {regenerated && <span>· first generated {dateTime(details.firstGeneratedAt)}</span>}
              {details.slipNumber && <span>· payslip {details.slipNumber}</span>}
              <button
                type="button"
                onClick={onRefresh}
                disabled={refreshing}
                aria-label="Refresh this payroll's details"
                title="Load this payroll's details again"
                className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-medium text-slate-500 hover:bg-slate-100 disabled:opacity-60 print:hidden"
                data-testid="pd-refresh"
              >
                <RefreshCw size={11} className={cn(refreshing && "animate-spin")} /> Refresh
              </button>
            </p>
          </div>
        </div>
      </div>
    </header>
  );
}

/** The employee's phone number as a big button beside Mark as Cleared: a click copies it, so HR can paste it into a dialler. */
function PhoneButton({ phone, name }: { phone: string; name: string }) {
  const { toast } = useToast();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(phone);
      toast({ title: "Phone number copied", description: `${name}: ${phone}` });
    } catch {
      toast({ title: "Could not copy the number", description: phone, variant: "destructive" });
    }
  };
  return (
    <span data-view-safe>
      <Button
        type="button"
        variant="outline"
        className="h-10 gap-2 rounded-xl border-sky-200 bg-sky-50 px-4 text-sm font-bold text-sky-800 hover:bg-sky-100"
        onClick={() => void copy()}
        title={`${name}'s phone number: click to copy it`}
        data-testid="pd-phone"
      >
        <Phone size={16} />
        <span className="tabular-nums" data-testid="pd-employee-phone">
          {phone}
        </span>
      </Button>
    </span>
  );
}

/** View or download the payroll's stored payslip; switched off, with the reason on hover, when none was stored. */
function PayslipMenu({ details, disabled }: { details: PayrollDetails; disabled: boolean }) {
  const { token } = useAuth();
  const { toast } = useToast();
  const [busy, setBusy] = useState<"view" | "download" | null>(null);
  const slipId = details.slipId;

  const run = async (mode: "view" | "download") => {
    if (!slipId) return;
    setBusy(mode);
    try {
      const url = `/api/salary-slips/${slipId}/pdf`;
      if (mode === "view") await previewDocumentPdf(url, () => token);
      else await downloadDocumentPdf(url, () => token);
    } catch (err) {
      toast({
        title: "Failed to generate PDF",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  };

  const trigger = (
    <Button
      variant="outline"
      size="sm"
      className="h-9 gap-2"
      disabled={disabled || !slipId || !!busy}
      aria-label={slipId ? "Payslip" : "Payslip (not available)"}
      data-testid="pd-payslip-menu"
    >
      {busy ? <Loader2 size={14} className="animate-spin" /> : <ReceiptText size={14} />}
      Payslip
      <ChevronDown size={13} className="opacity-60" />
    </Button>
  );

  if (!slipId) {
    return (
      <span title="No payslip was stored for this payroll yet" data-testid="pd-payslip-unavailable">
        {trigger}
      </span>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem onSelect={() => void run("view")} data-testid="pd-payslip-view">
          <FileSearch size={14} /> View PDF
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void run("download")} data-testid="pd-payslip-download">
          <Download size={14} /> Download PDF
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

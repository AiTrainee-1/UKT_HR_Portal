import type { ComponentProps, ReactNode } from "react";
import { Link } from "wouter";
import { ArrowUpRight, Building2, Info } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { SaveBar } from "../kit/SaveBar";
import { SaveDock } from "../kit/SaveDock";
import type { Change } from "./sections";

/**
 * Small pieces the Payroll and Production Payroll tabs share. The kit (../kit) draws a setting; these are the controls
 * inside it: a number box whose label is the setting's own title (SettingBlock labelFor), so it has no second label.
 */

export function NumberInput({
  id,
  value,
  onChange,
  prefix,
  unit,
  error,
  hint,
  disabled,
  placeholder,
  className,
}: {
  id: string;
  value: string;
  onChange: (next: string) => void;
  /** Before the box ("₹"). */
  prefix?: string;
  /** After the box ("%", "minutes"). */
  unit?: string;
  error?: string | null;
  hint?: ReactNode;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}) {
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        {prefix && <span className="text-sm font-semibold text-gray-500">{prefix}</span>}
        <Input
          id={id}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          onChange={(e) => onChange(e.target.value)}
          className={cn("w-36 tabular-nums", error && "border-red-400 focus-visible:ring-red-400", className)}
        />
        {unit && <span className="text-xs font-semibold text-gray-500">{unit}</span>}
      </div>
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-xs font-medium text-red-600">
          {error}
        </p>
      ) : (
        hint && (
          <p id={`${id}-hint`} className="text-xs leading-snug text-gray-500">
            {hint}
          </p>
        )
      )}
    </div>
  );
}

export function SelectInput({
  id,
  value,
  onChange,
  options,
  disabled,
  className,
}: {
  id: string;
  value: string;
  onChange: (next: string) => void;
  options: { value: string; label: string; disabled?: boolean }[];
  disabled?: boolean;
  className?: string;
}) {
  return (
    <select
      id={id}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className={cn(
        "h-9 w-full max-w-sm rounded-md border border-input bg-background px-3 text-sm disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/**
 * The group's Save bar, kept in view at the bottom of the screen while the long list of settings above is scrolled.
 * `settings-dock` is the Settings skin's raised glass dock for exactly this (it restyles the bar inside it).
 */
export function StickySave(props: ComponentProps<typeof SaveBar>) {
  return (
    <SaveDock>
      <SaveBar {...props} />
    </SaveDock>
  );
}

/** A blue explanation box (not a setting). */
export function InfoBox({ children, testId, className }: { children: ReactNode; testId?: string; className?: string }) {
  return (
    <div
      className={cn(
        "flex gap-2 rounded-xl border border-blue-100 bg-blue-50/70 p-3 text-xs leading-relaxed text-blue-900",
        className,
      )}
      data-testid={testId}
    >
      <Info size={14} className="mt-0.5 shrink-0 text-blue-500" />
      <div className="min-w-0 space-y-1.5">{children}</div>
    </div>
  );
}

/** An in-app link written inside a sentence. */
export function TextLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link href={to} className="inline-flex items-center gap-0.5 font-semibold text-blue-700 hover:underline">
      {children}
      <ArrowUpRight size={11} />
    </Link>
  );
}

/**
 * Shown to a login assigned to a branch: what it saves on these tabs is a private overlay for that branch's employees,
 * and some readers only ever use the company values (the API reports this as companyWideRulesEditable = false).
 */
export function BranchNotice({ children }: { children: ReactNode }) {
  return (
    <div
      className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-[13px] leading-snug text-amber-900"
      data-testid="settings-branch-notice"
    >
      <Building2 size={15} className="mt-0.5 shrink-0" />
      <div>{children}</div>
    </div>
  );
}

/** Asks before a save that moves money (or can pay days twice), listing exactly what changes. */
export function ConfirmChanges({
  open,
  onOpenChange,
  title,
  changes,
  children,
  confirmLabel,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  changes: Change[];
  children?: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3 text-sm text-muted-foreground">
              {changes.length > 0 && (
                <ul className="space-y-1 rounded-xl bg-slate-50 p-3 text-[13px]">
                  {changes.map((c) => (
                    <li key={c.label} className="flex flex-wrap justify-between gap-x-3">
                      <span className="font-semibold text-gray-700">{c.label}</span>
                      <span className="tabular-nums text-gray-600">
                        {c.from} <span className="text-gray-400">-&gt;</span>{" "}
                        <strong className="text-gray-900">{c.to}</strong>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {children}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Go back</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm} data-testid="confirm-settings-save">
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

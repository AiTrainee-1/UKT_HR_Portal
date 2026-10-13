import type { ReactNode } from "react";
import { ArrowRight, IndianRupee, TriangleAlert } from "lucide-react";
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
import type { Change } from "./form";

/**
 * The last look before a save that re-judges history or changes pay for everyone: what is about to change (saved value
 * to new value, pay-affecting ones marked) and what that does. Nothing is sent until "Confirm and save".
 */
export function ConfirmSave({
  open,
  onOpenChange,
  title,
  changes,
  consequences,
  onConfirm,
  testId = "confirm-save",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  changes: Change[];
  consequences: ReactNode[];
  onConfirm: () => void;
  testId?: string;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-lg" data-testid={testId}>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <TriangleAlert size={18} className="text-amber-500" /> {title}
          </AlertDialogTitle>
          <AlertDialogDescription>Check what is about to change before it applies to everyone.</AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="space-y-1.5" data-testid={`${testId}-changes`}>
          {changes.map((c) => (
            <li
              key={c.key}
              className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg bg-slate-50 px-3 py-2 text-[13px]"
            >
              <span className="font-semibold text-gray-800">{c.label}</span>
              <span className="text-gray-500">{c.from}</span>
              <ArrowRight size={12} className="text-gray-400" />
              <span className="font-bold text-gray-900">{c.to}</span>
              {c.money && (
                <span className="ml-auto inline-flex items-center gap-0.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-800">
                  <IndianRupee size={9} /> pay
                </span>
              )}
            </li>
          ))}
        </ul>
        <ul className="space-y-1 text-[12px] leading-snug text-gray-600">
          {consequences.map((c, i) => (
            <li key={i} className="flex gap-1.5">
              <span className="mt-[6px] h-1 w-1 shrink-0 rounded-full bg-gray-400" />
              <span>{c}</span>
            </li>
          ))}
        </ul>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm} data-testid={`${testId}-confirm`}>
            Confirm and save
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

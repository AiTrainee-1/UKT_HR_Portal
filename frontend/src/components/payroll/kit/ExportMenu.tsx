import { useState, type ComponentType, type ReactNode } from "react";
import { ChevronDown, Download, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import { VIEW_SAFE_ATTR } from "@/lib/view-only-lock";

export type ExportItem = {
  key: string;
  label: string;
  /** One line under the label: "All 126 rows, styled like the printed statement". */
  hint?: string;
  icon?: ComponentType<{ size?: number; className?: string }>;
  /** Runs the export. A rejection becomes a toast; the menu shows a spinner until it settles. */
  run: () => void | Promise<void>;
  disabled?: boolean;
};

/**
 * One "Export" button that lists what can be exported (Excel, CSV, PDF, Print ...). The exports it offers only READ and
 * download, so the button and its popup are marked view-safe: a View Only role can still use them (the bank-transfer file
 * is the exception and stays a plain, lockable button on its page).
 */
export function ExportMenu({
  items,
  label = "Export",
  disabled,
  size = "sm",
  className,
  heading,
  testId = "export-menu",
  trailing,
}: {
  items: ExportItem[];
  label?: string;
  disabled?: boolean;
  size?: "sm" | "default";
  className?: string;
  /** A small heading inside the popup: "What to export". */
  heading?: ReactNode;
  testId?: string;
  trailing?: ReactNode;
}) {
  const { toast } = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const run = async (item: ExportItem) => {
    if (busy) return;
    setBusy(item.key);
    try {
      await item.run();
    } catch (err) {
      toast({
        title: `Could not export ${item.label}`,
        description: err instanceof Error ? err.message : "Something went wrong while building the file.",
        variant: "destructive",
      });
    } finally {
      setBusy(null);
      // the menu stays open while the file is built (its row shows a spinner) and closes once it is done
      setOpen(false);
    }
  };

  return (
    <span {...{ [VIEW_SAFE_ATTR]: "" }}>
      <DropdownMenu open={open} onOpenChange={(next) => !busy && setOpen(next)}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size={size}
            disabled={disabled || items.length === 0}
            className={className ?? "h-9 gap-2 border-emerald-200 text-emerald-700 hover:bg-emerald-50"}
            data-testid={testId}
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
            {label}
            <ChevronDown size={13} className="opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72" {...{ [VIEW_SAFE_ATTR]: "" }}>
          {heading && <DropdownMenuLabel className="text-xs text-muted-foreground">{heading}</DropdownMenuLabel>}
          {heading && <DropdownMenuSeparator />}
          {items.map((item) => {
            const Icon = item.icon ?? Download;
            return (
              <DropdownMenuItem
                key={item.key}
                disabled={item.disabled || !!busy}
                onSelect={(e) => {
                  e.preventDefault();
                  void run(item);
                }}
                className="items-start gap-2.5 py-2"
                data-testid={`${testId}-${item.key}`}
              >
                <span className="mt-0.5">
                  {busy === item.key ? <Loader2 size={15} className="animate-spin" /> : <Icon size={15} />}
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{item.label}</span>
                  {item.hint && (
                    <span className="block text-[11px] leading-snug text-muted-foreground">{item.hint}</span>
                  )}
                </span>
              </DropdownMenuItem>
            );
          })}
          {trailing}
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}

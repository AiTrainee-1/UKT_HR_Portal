import type { ReactNode } from "react";
import { Check, Eye, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import type { ThemeDef } from "@/lib/themes";
import { cn } from "@/lib/utils";
import { contrastText } from "../identity/colours";
import { ratioOf } from "./palettes";
import { paletteOf, PortalSketch, Swatches } from "./sketch";
import { THEME_LOOK } from "./text";

/**
 * One theme: a drawing of a portal page in its real colours, its name, what it looks like in words, how readable its
 * text is, the switch that makes it everyone's theme, Preview (this screen only) and, on the active theme, Customize.
 * The active theme is drawn with the custom colours everyone sees on it; the others as they come.
 */
export function ThemeCard({
  def,
  active,
  showing,
  custom,
  disabled,
  onActivate,
  onPreview,
  onCustomize,
  children,
}: {
  def: ThemeDef;
  /** Saved for everyone. */
  active: boolean;
  /** On this screen right now (active, or being previewed). */
  showing: boolean;
  /** The saved custom colours of the active theme. */
  custom: Record<string, string>;
  /** View-only role, branch login or a save in progress: no switching or customizing (Preview still works). */
  disabled: boolean;
  onActivate: () => void;
  onPreview: () => void;
  onCustomize: () => void;
  /** A strip under the buttons (the "switching drops the custom colours" question). */
  children?: ReactNode;
}) {
  const palette = paletteOf(def.id, active ? custom : undefined);
  const pageText = ratioOf(palette["--background"], palette["--foreground"]);
  const buttonText = ratioOf(palette["--primary"], palette["--primary-foreground"]);
  return (
    <div
      className={cn(
        "settings-glass space-y-2.5 rounded-2xl p-3",
        active ? "ring-2 ring-blue-400" : showing ? "ring-2 ring-amber-400" : undefined,
      )}
      data-testid={`theme-card-${def.id}`}
      data-active={active ? "true" : "false"}
      data-showing={showing ? "true" : "false"}
    >
      <PortalSketch theme={def.id} custom={active ? custom : undefined} label={def.label} />
      <Swatches palette={palette} />
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-sm font-bold text-gray-900">
            {def.label}
            {active && <Check size={13} className="shrink-0 text-blue-600" aria-label="active for everyone" />}
          </p>
          <p className="mt-0.5 text-[11px] leading-snug text-gray-600">{THEME_LOOK[def.id]}</p>
          <p className="mt-0.5 text-[11px] leading-snug text-gray-500" data-testid="theme-contrast">
            Text on the page {contrastText(pageText)}, on primary buttons {contrastText(buttonText)}
          </p>
        </div>
        <Switch
          checked={active}
          disabled={disabled}
          onCheckedChange={(on) => {
            if (on) onActivate();
          }}
          aria-label={`Enable ${def.label}`}
          className="mt-0.5 shrink-0"
        />
      </div>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="h-7 flex-1 gap-1.5 text-[11px]"
          onClick={onPreview}
          disabled={showing}
          data-view-safe
          data-testid={`theme-preview-${def.id}`}
        >
          <Eye size={12} /> {showing ? "Showing" : "Preview"}
        </Button>
        {active && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 flex-1 gap-1.5 text-[11px]"
            onClick={onCustomize}
            disabled={disabled}
            data-testid="theme-customize"
          >
            <SlidersHorizontal size={12} /> Customize
          </Button>
        )}
      </div>
      {children}
    </div>
  );
}

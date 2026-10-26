import type { ReactNode } from "react";
import { Check, Eye, Monitor, SlidersHorizontal } from "lucide-react";
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
 * text is, the switch that makes it everyone's theme, Preview (this screen only), "Use only on this device" (this
 * browser alone, nothing saved on the server) and, on the active theme, Customize. The active theme is drawn with the
 * custom colours everyone sees on it; the others as they come.
 */
export function ThemeCard({
  def,
  active,
  device,
  showing,
  custom,
  disabled,
  onActivate,
  onPreview,
  onUseOnDevice,
  onCustomize,
  children,
}: {
  def: ThemeDef;
  /** Saved for everyone. */
  active: boolean;
  /** This device's own choice (kept in this browser only). */
  device: boolean;
  /** On this screen right now (active, this device's choice, or being previewed). */
  showing: boolean;
  /** The saved custom colours of the active theme. */
  custom: Record<string, string>;
  /** View-only role, branch login or a save in progress: no switching or customizing (Preview still works). */
  disabled: boolean;
  onActivate: () => void;
  onPreview: () => void;
  /** Use this theme on this device only, or (when it already is the device's choice) stop doing so. */
  onUseOnDevice: () => void;
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
        active
          ? "ring-2 ring-blue-400"
          : device
            ? "ring-2 ring-emerald-400"
            : showing
              ? "ring-2 ring-amber-400"
              : undefined,
      )}
      data-testid={`theme-card-${def.id}`}
      data-active={active ? "true" : "false"}
      data-device={device ? "true" : "false"}
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
          {(active || device) && (
            <p className="mt-1 flex flex-wrap gap-1" data-testid="theme-status">
              {active && (
                <span
                  className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-bold text-blue-800"
                  data-testid="theme-status-everyone"
                >
                  Active for everyone
                </span>
              )}
              {device && (
                <span
                  className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-800"
                  data-testid="theme-status-device"
                >
                  Active on this device
                </span>
              )}
            </p>
          )}
          <p className="mt-0.5 text-[11px] leading-snug text-gray-600">{THEME_LOOK[def.id]}</p>
          <p className="mt-0.5 text-[11px] leading-snug text-gray-500" data-testid="theme-contrast">
            Text on the page {contrastText(pageText)}, on primary buttons {contrastText(buttonText)}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-center gap-0.5">
          <Switch
            checked={active}
            disabled={disabled}
            onCheckedChange={(on) => {
              if (on) onActivate();
            }}
            aria-label={`Enable ${def.label}`}
            className="mt-0.5"
          />
          <span className="text-[9px] font-semibold uppercase tracking-wide text-gray-500">Everyone</span>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
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
        <Button
          variant="outline"
          size="sm"
          className="h-7 flex-1 gap-1.5 text-[11px]"
          onClick={onUseOnDevice}
          aria-pressed={device}
          title={
            device
              ? "This device uses this theme on its own. Press to follow the theme for everyone again."
              : "Use this theme on this device only. Nobody else's screen changes."
          }
          data-view-safe
          data-testid={`theme-device-${def.id}`}
        >
          {device ? <Check size={12} /> : <Monitor size={12} />} {device ? "On this device" : "Use only on this device"}
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

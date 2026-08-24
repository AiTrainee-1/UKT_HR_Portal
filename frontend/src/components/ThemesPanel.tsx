import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useTheme } from "@/contexts/ThemeContext";
import {
  THEMES, CUSTOMIZABLE_TOKENS, hexToHslTriple, hslTripleToHex,
  type ThemeId,
} from "@/lib/themes";
import { Palette, Check, Eye, SlidersHorizontal, RotateCcw, Info } from "lucide-react";

function SwatchRow({ colors, active }: { colors: string[]; active: boolean }) {
  return (
    <div className="flex rounded-lg overflow-hidden h-12 border" aria-hidden>
      {colors.map((c, i) => (
        <div
          key={i}
          className="flex-1 transition-transform duration-200"
          style={{ background: c, transform: active ? "scaleY(1)" : "scaleY(0.92)" }}
        />
      ))}
    </div>
  );
}

/**
 * Live colour editing for the active theme. Values are held locally and
 * previewed through ThemeContext as you drag, so the whole portal updates
 * under the dialog -only Save writes them to the server for everyone.
 */
function CustomizeDialog({
  open, onClose, themeId, readOnly,
}: { open: boolean; onClose: () => void; themeId: ThemeId; readOnly: boolean }) {
  const { toast } = useToast();
  const { custom, save, preview, isSaving } = useTheme();
  const [draft, setDraft] = useState<Record<string, string>>({});

  // Seed from the saved overrides each time the dialog opens, and read any
  // token with no override straight off the rendered document so the picker
  // starts on the theme's real colour rather than black.
  useEffect(() => {
    if (!open) return;
    const computed = getComputedStyle(document.documentElement);
    const seeded: Record<string, string> = {};
    for (const { token } of CUSTOMIZABLE_TOKENS) {
      seeded[token] = custom[token] ?? computed.getPropertyValue(token).trim() ?? "0 0% 0%";
    }
    setDraft(seeded);
  }, [open, custom]);

  // Drop any unsaved preview when the dialog closes.
  useEffect(() => {
    if (!open) preview(null, null);
  }, [open, preview]);

  const update = (token: string, hex: string) => {
    const next = { ...draft, [token]: hexToHslTriple(hex) };
    setDraft(next);
    preview(themeId, next);
  };

  const handleSave = async () => {
    try {
      // Only persist tokens that actually differ from the theme's own value,
      // so switching themes later isn't silently overridden by stale colours.
      const base = getComputedStyle(document.documentElement);
      const changed: Record<string, string> = {};
      for (const [token, value] of Object.entries(draft)) {
        if (custom[token] !== undefined || value !== base.getPropertyValue(token).trim()) {
          changed[token] = value;
        }
      }
      await save(themeId, changed);
      toast({ title: "Theme customised", description: "Your colours are now live for everyone." });
      onClose();
    } catch (e: any) {
      toast({ title: "Failed to save colours", description: e?.data?.error ?? e?.message, variant: "destructive" });
    }
  };

  const handleReset = async () => {
    try {
      await save(themeId, {});
      toast({ title: "Colours reset", description: "Back to the theme's original palette." });
      onClose();
    } catch (e: any) {
      toast({ title: "Failed to reset", description: e?.data?.error ?? e?.message, variant: "destructive" });
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <SlidersHorizontal size={16} /> Customize theme
          </DialogTitle>
        </DialogHeader>

        <div className="flex gap-2 items-start rounded-lg bg-slate-50 border p-2.5 text-[11px] leading-relaxed text-slate-600">
          <Info size={13} className="mt-0.5 shrink-0" />
          <span>
            Changes preview instantly across the portal as you pick. They apply to
            everyone once you save.
          </span>
        </div>

        <div className="space-y-2.5 max-h-[45vh] overflow-y-auto pr-1">
          {CUSTOMIZABLE_TOKENS.map(({ token, label, hint }) => (
            <div key={token} className="flex items-center gap-3">
              <input
                type="color"
                value={hslTripleToHex(draft[token] ?? "0 0% 0%")}
                onChange={(e) => update(token, e.target.value)}
                disabled={readOnly}
                className="h-9 w-12 rounded border cursor-pointer disabled:cursor-not-allowed shrink-0"
                aria-label={label}
              />
              <div className="min-w-0">
                <p className="text-sm font-semibold leading-tight">{label}</p>
                <p className="text-[11px] text-muted-foreground">{hint}</p>
              </div>
              <code className="ml-auto text-[10px] text-muted-foreground shrink-0">
                {draft[token]}
              </code>
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between gap-2 pt-1">
          <Button
            variant="ghost" size="sm" className="gap-1.5 text-xs"
            onClick={handleReset} disabled={readOnly || isSaving}
          >
            <RotateCcw size={13} /> Reset to theme default
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" className="text-xs" onClick={onClose}>Cancel</Button>
            <Button size="sm" className="text-xs" onClick={handleSave} disabled={readOnly || isSaving}>
              {isSaving ? "Saving…" : "Save colours"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function ThemesPanel({ readOnly = false }: { readOnly?: boolean }) {
  const { toast } = useToast();
  const { theme, effectiveTheme, isPreviewing, custom, preview, save, isSaving } = useTheme();
  const [customizing, setCustomizing] = useState(false);

  // Leaving the page with a preview still showing would be confusing —
  // always fall back to the saved theme on unmount.
  useEffect(() => () => preview(null, null), [preview]);

  const activate = async (id: ThemeId) => {
    if (readOnly) return;
    try {
      // Custom colours belong to the theme they were tuned against, so
      // switching themes starts from that theme's own palette.
      await save(id, id === theme ? custom : {});
      const label = THEMES.find((t) => t.id === id)?.label ?? id;
      toast({ title: "Theme applied", description: `${label} is now active for everyone.` });
    } catch (e: any) {
      toast({ title: "Failed to apply theme", description: e?.data?.error ?? e?.message, variant: "destructive" });
    }
  };

  return (
    <Card className="border-0 shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Palette size={15} className="text-primary" /> Themes
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Sets the look of the HR portal for every user. Preview one first, then switch it on.
        </p>
      </CardHeader>

      <CardContent className="space-y-3">
        {isPreviewing && (
          <div className="flex items-center justify-between gap-2 rounded-lg bg-amber-50 border border-amber-200 p-2.5 text-[11px] text-amber-900">
            <span className="flex items-center gap-1.5">
              <Eye size={13} /> Previewing — nothing is saved until you switch a theme on.
            </span>
            <Button
              variant="outline" size="sm" className="h-7 text-[11px]"
              onClick={() => preview(null, null)}
            >
              Stop preview
            </Button>
          </div>
        )}

        <div className="grid sm:grid-cols-2 gap-3">
          {THEMES.map((t) => {
            const isActive = theme === t.id;
            const isShowing = effectiveTheme === t.id;
            return (
              <div
                key={t.id}
                className={`rounded-xl border p-3 space-y-2.5 transition-all duration-200 ${
                  isActive ? "border-primary ring-1 ring-primary/30" : "border-border hover:border-primary/40"
                }`}
              >
                <SwatchRow colors={t.swatches} active={isShowing} />

                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-bold flex items-center gap-1.5">
                      {t.label}
                      {isActive && <Check size={13} className="text-primary shrink-0" />}
                    </p>
                    <p className="text-[11px] text-muted-foreground leading-snug mt-0.5">
                      {t.description}
                    </p>
                  </div>
                  <Switch
                    checked={isActive}
                    disabled={readOnly || isSaving}
                    onCheckedChange={(on) => { if (on) activate(t.id); }}
                    aria-label={`Enable ${t.label}`}
                    className="shrink-0 mt-0.5"
                  />
                </div>

                <div className="flex items-center gap-2">
                  <Button
                    variant="outline" size="sm" className="h-7 gap-1.5 text-[11px] flex-1"
                    onClick={() => preview(t.id, null)}
                    disabled={isShowing}
                  >
                    <Eye size={12} /> {isShowing ? "Showing" : "Preview"}
                  </Button>
                  {isActive && (
                    <Button
                      variant="outline" size="sm" className="h-7 gap-1.5 text-[11px] flex-1"
                      onClick={() => setCustomizing(true)}
                      disabled={readOnly}
                    >
                      <SlidersHorizontal size={12} /> Customize
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {Object.keys(custom).length > 0 && (
          <p className="text-[11px] text-muted-foreground">
            {Object.keys(custom).length} custom colour
            {Object.keys(custom).length === 1 ? "" : "s"} applied on top of{" "}
            {THEMES.find((t) => t.id === theme)?.label}.
          </p>
        )}
      </CardContent>

      <CustomizeDialog
        open={customizing}
        onClose={() => setCustomizing(false)}
        themeId={theme}
        readOnly={readOnly}
      />
    </Card>
  );
}

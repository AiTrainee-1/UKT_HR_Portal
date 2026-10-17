import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useSharedGuide } from "@/lib/api-client/custom-hooks";
import { GuideView } from "./GuideView";
import { Notice } from "./ui";
import type { SectionProps } from "./sectionProps";

/** Guide: this endpoint's own documentation, written by the server from what is saved, ready to hand to a developer. */
export function GuideSection({ saved, dirty }: SectionProps) {
  const guide = useSharedGuide(saved?.id ?? null);

  if (!saved) {
    return (
      <Notice testId="guide-needs-save">
        Save the endpoint first. The guide is written from the saved endpoint: its address, its fields and its examples.
      </Notice>
    );
  }
  if (guide.isLoading) {
    return (
      <div className="space-y-3" data-testid="guide-loading">
        <Skeleton className="h-24 w-full rounded-xl" />
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    );
  }
  if (guide.isError || !guide.data) {
    return (
      <div
        className="flex flex-wrap items-center gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800"
        data-testid="guide-error"
      >
        The guide could not be loaded.
        <Button size="sm" variant="outline" onClick={() => void guide.refetch()}>
          Try again
        </Button>
      </div>
    );
  }
  return (
    <div className="space-y-4" data-testid="endpoint-guide">
      <p className="text-[13px] leading-relaxed text-slate-500">
        Give this page to the developer of the other application. It is written for exactly this endpoint, with a
        placeholder where the key goes.
      </p>
      {dirty && (
        <Notice tone="warn" testId="guide-saved-note">
          The guide describes the saved endpoint. Save your changes to see them here.
        </Notice>
      )}
      <GuideView guide={guide.data} />
    </div>
  );
}

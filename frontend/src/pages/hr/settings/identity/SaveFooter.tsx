import type { ComponentProps } from "react";
import { SaveBar } from "../kit/SaveBar";
import { SaveDock } from "../kit/SaveDock";

/**
 * The tab's SaveBar, kept in view at the bottom of the screen: a tab here is a long page of explained settings, and the
 * button should not be a scroll away from the field just changed.
 */
export function SaveFooter(props: ComponentProps<typeof SaveBar>) {
  return (
    <SaveDock>
      <SaveBar {...props} />
    </SaveDock>
  );
}

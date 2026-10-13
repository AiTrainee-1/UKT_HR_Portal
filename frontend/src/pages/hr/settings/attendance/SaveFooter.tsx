import type { ComponentProps } from "react";
import { SaveBar } from "../kit/SaveBar";
import { SaveDock } from "../kit/SaveDock";

/**
 * A group's SaveBar kept in view at the bottom of the screen while its settings are on screen: these tabs are long
 * pages of explained settings, and the button should not be a scroll away from the value just changed.
 */
export function SaveFooter(props: ComponentProps<typeof SaveBar>) {
  return (
    <SaveDock>
      <SaveBar {...props} />
    </SaveDock>
  );
}

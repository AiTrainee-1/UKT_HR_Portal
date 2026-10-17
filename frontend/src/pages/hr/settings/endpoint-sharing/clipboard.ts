/**
 * Puts text on the clipboard. The modern way is refused on an insecure address or when the browser says no; the old way
 * (select a hidden box and copy) often still works. Returns false when neither did, so the screen can say "press Ctrl+C".
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // refused: try the old way below
  }
  try {
    const box = document.createElement("textarea");
    box.value = text;
    box.setAttribute("readonly", "");
    box.style.position = "fixed";
    box.style.top = "0";
    box.style.opacity = "0";
    document.body.appendChild(box);
    box.select();
    const done = typeof document.execCommand === "function" && document.execCommand("copy");
    box.remove();
    return done === true;
  } catch {
    return false;
  }
}

/** Selects everything in an element, so the person can press Ctrl+C when copying was refused. */
export function selectAll(node: HTMLElement | null): void {
  if (!node || typeof window === "undefined") return;
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(node);
  selection.removeAllRanges();
  selection.addRange(range);
}

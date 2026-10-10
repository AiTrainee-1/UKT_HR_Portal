import { useEffect } from "react";

/**
 * Marks the first heading (h1 / h2) inside `root` as the page's title: data-md-title, the hook the type rule in
 * md-theme/typography.css uses to set a page's title in Whole Chomp. A page with a title row gets the mark from
 * embedded/headerRow.ts; this is for the pages the frame does not give a title row to (a form such as Add Employee, a
 * record such as an employee's profile), whose own heading is still that page's title. Follows the page while it loads,
 * and takes only the marks it put back off when the page goes away.
 */
export function useTitleMark(root: HTMLElement | null): void {
  useEffect(() => {
    if (!root) return;
    const marked = new Set<Element>();
    const mark = () => {
      const heading = root.querySelector("h1, h2");
      if (heading && !heading.hasAttribute("data-md-title")) {
        heading.setAttribute("data-md-title", "");
        marked.add(heading);
      }
    };
    mark();
    const observer = new MutationObserver(mark);
    observer.observe(root, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      for (const heading of marked) heading.removeAttribute("data-md-title");
    };
  }, [root]);
}

import { forwardRef, useId, type HTMLAttributes } from "react";

// Glowing round switch for the HR sidebar's collapse control -ported from
// the user's styled-components snippet to a scoped <style> tag (this
// codebase doesn't depend on styled-components, same as AttendanceLoader),
// recoloured from purple to the portal's own blue, and shrunk from a 90px
// hero button to fit the 68px icon rail.
//
// "On" (glowing) = sidebar expanded; "off" (flat, dull) = collapsed rail.
// The native checkbox is visually hidden rather than display:none, so the
// switch stays reachable and operable from the keyboard.

type Props = {
  collapsed: boolean;
  onToggle: () => void;
  /** Smaller disc for the expanded header, where it sits beside the logo;
   *  the collapsed rail uses the full 48x44 slot to match the rail icons. */
  compact?: boolean;
} & Omit<HTMLAttributes<HTMLSpanElement>, "onToggle">;

export const SidebarToggle = forwardRef<HTMLSpanElement, Props>(function SidebarToggle(
  { collapsed, onToggle, compact = false, className = "", ...rest },
  ref,
) {
  const id = useId();
  return (
    <span ref={ref} className={`ukt-sbt ${compact ? "ukt-sbt--sm" : ""} ${className}`} {...rest}>
      <input
        id={id}
        type="checkbox"
        className="ukt-sbt-input"
        checked={!collapsed}
        onChange={onToggle}
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        data-testid="button-sidebar-toggle"
      />
      <label htmlFor={id} className="ukt-sbt-switch">
        <svg viewBox="0 0 448 512" className="ukt-sbt-svg" aria-hidden="true">
          <path d="M0 96C0 78.3 14.3 64 32 64H416c17.7 0 32 14.3 32 32s-14.3 32-32 32H32C14.3 128 0 113.7 0 96zM0 256c0-17.7 14.3-32 32-32H416c17.7 0 32 14.3 32 32s-14.3 32-32 32H32c-17.7 0-32-14.3-32-32zM448 416c0 17.7-14.3 32-32 32H32c-17.7 0-32-14.3-32-32s14.3-32 32-32H416c17.7 0 32 14.3 32 32z" />
        </svg>
      </label>
      <style>{`
        .ukt-sbt {
          position: relative;
          display: flex;
          align-items: center;
          justify-content: center;
          width: 48px;
          height: 44px;
          flex-shrink: 0;
        }
        .ukt-sbt--sm {
          width: 36px;
          height: 36px;
        }
        .ukt-sbt--sm .ukt-sbt-switch {
          width: 34px;
          height: 34px;
          border-width: 1.5px;
        }
        .ukt-sbt-input {
          position: absolute;
          width: 1px;
          height: 1px;
          margin: -1px;
          overflow: hidden;
          clip: rect(0 0 0 0);
          white-space: nowrap;
          border: 0;
          padding: 0;
        }

        /* Off = collapsed: a flat, dull clay disc */
        .ukt-sbt-switch {
          position: relative;
          display: flex;
          align-items: center;
          justify-content: center;
          width: 40px;
          height: 40px;
          border-radius: 50%;
          cursor: pointer;
          background-color: #e3ecf3;
          border: 2px solid #c3d3e0;
          box-shadow: 0 0 3px rgba(0, 60, 100, 0.35) inset;
          transition: background-color 0.25s ease, border-color 0.25s ease, box-shadow 0.25s ease;
        }
        .ukt-sbt-switch:hover {
          background-color: #d9e6f0;
        }
        .ukt-sbt-svg {
          width: 44%;
          height: 44%;
          transition: filter 0.25s ease;
        }
        .ukt-sbt-svg path {
          fill: #6d8ca3;
          transition: fill 0.25s ease;
        }

        /* On = expanded: brand-blue glow, white icon */
        .ukt-sbt-input:checked + .ukt-sbt-switch {
          background-color: #006496;
          border-color: #ffffff;
          box-shadow:
            0 0 1px #4fb8f0 inset,
            0 0 3px #4fb8f0 inset,
            0 0 9px #4fb8f0 inset,
            0 0 10px rgba(79, 184, 240, 0.75),
            0 0 2px #4fb8f0;
        }
        .ukt-sbt-input:checked + .ukt-sbt-switch .ukt-sbt-svg {
          filter: drop-shadow(0 0 3px #7fd0ff);
        }
        .ukt-sbt-input:checked + .ukt-sbt-switch .ukt-sbt-svg path {
          fill: #ffffff;
        }

        .ukt-sbt-input:focus-visible + .ukt-sbt-switch {
          outline: 2px solid #4fb8f0;
          outline-offset: 2px;
        }
        @media (prefers-reduced-motion: reduce) {
          .ukt-sbt-switch, .ukt-sbt-svg, .ukt-sbt-svg path { transition: none; }
        }
      `}</style>
    </span>
  );
});

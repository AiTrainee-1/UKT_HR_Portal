import { GitBranch } from "lucide-react";

/**
 * For a login assigned to a branch (the server says so with companyWideRulesEditable = false): what it saves on the
 * Company and Salary Slip tabs is stored as that branch's private copy (backend/api/user_settings.py), and only the parts
 * of the portal that read settings "as this login" see it. Every PDF builder and report header reads the company's own
 * row, so they keep printing the company's values.
 */
export function BranchNote({ what }: { what: string }) {
  return (
    <div
      className="flex items-start gap-2 rounded-xl border border-violet-200 bg-violet-50 px-3 py-2.5 text-[12px] leading-snug text-violet-900"
      data-testid="branch-overlay-note"
    >
      <GitBranch size={14} className="mt-0.5 shrink-0" />
      <span>
        <b>You are signed in with a branch login.</b> {what} you save here are kept as your branch's own copy. They
        change what logins of your branch see in the sidebar, on the ID cards they open and in the emails they send.
        Letters, salary slip PDFs, report headers and the public QR verification page keep using the company's own
        values, which only an administrator (or a login with no branch) can change.
      </span>
    </div>
  );
}

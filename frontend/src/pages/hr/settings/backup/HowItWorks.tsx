import type { ReactNode } from "react";
import { ArrowRight, Cloud, Database, FolderOpen, Info, Upload } from "lucide-react";
import { SettingsSection } from "../kit/SettingBlock";

function Place({ icon: Icon, children, muted }: { icon: typeof Database; children: ReactNode; muted?: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-semibold ${
        muted ? "bg-slate-100 text-slate-500" : "bg-white text-slate-700 ring-1 ring-slate-200"
      }`}
    >
      <Icon size={12} /> {children}
    </span>
  );
}

function Route({ from, children }: { from: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-xl bg-slate-50 px-3 py-2">
      <span className="w-36 shrink-0 text-xs font-bold text-gray-800">{from}</span>
      <ArrowRight size={13} className="shrink-0 text-gray-400" />
      {children}
    </div>
  );
}

/** What a backup is, where its copies go and what Restore reads, drawn as the three routes a backup file takes. */
export function HowItWorks() {
  return (
    <SettingsSection
      icon={Database}
      title="How Backup & Restore Work"
      purpose="A backup is one zip file holding everything needed to bring the portal back exactly as it was: the whole database (every employee, attendance, payroll and settings record, users and roles included) and every uploaded file (documents, resumes, photos)."
      testId="backup-how-it-works"
    >
      <div className="space-y-2 pt-2" data-testid="backup-routes">
        <Route from="Run Backup Now">
          <Place icon={FolderOpen}>Backup folder on the server</Place>
          <Place icon={Database}>Copy in the database (what Download fetches)</Place>
          <Place icon={Cloud} muted>
            Not uploaded to Google Drive
          </Place>
        </Route>
        <Route from="Scheduled backup">
          <Place icon={FolderOpen}>Backup folder on the server</Place>
          <Place icon={Database}>Copy in the database</Place>
          <Place icon={Cloud}>Google Drive, when switched on</Place>
        </Route>
        <Route from="Restore reads">
          <Place icon={Upload}>Only a zip you upload under Restore Backup</Place>
          <Place icon={FolderOpen} muted>
            Never the backup folder or Google Drive
          </Place>
        </Route>
      </div>
      <ul className="mt-3 space-y-1.5 text-[12px] leading-snug text-gray-600">
        {[
          '"Keep the last" deletes old zips from the backup folder only. The copies in the database and on Google Drive are never deleted, so they keep growing, and every new backup contains the database copies of the earlier ones.',
          'A scheduled time that passes while the server is off or restarting is skipped, not made up later. The only sign of a failed automatic backup is the "Last run" line under Scheduled Backup.',
          "A backup holds all company data unencrypted, including salaries, login password hashes, the email App Password and the Google Drive key: keep downloaded files private.",
        ].map((fact) => (
          <li key={fact} className="flex items-start gap-1.5">
            <Info size={12} className="mt-0.5 shrink-0 text-blue-400" /> {fact}
          </li>
        ))}
      </ul>
    </SettingsSection>
  );
}

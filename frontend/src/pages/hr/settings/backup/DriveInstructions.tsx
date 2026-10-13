import type { ReactNode } from "react";

function Step({ title, children, note }: { title: string; children: ReactNode; note?: string }) {
  return (
    <div className="space-y-1.5">
      <p className="font-semibold text-gray-700">{title}</p>
      {note && <p className="italic">{note}</p>}
      <ol className="list-decimal space-y-1 pl-4">{children}</ol>
    </div>
  );
}

/** The one-time Google Cloud set-up that gives the server a service account key and a Shared Drive folder. */
export function DriveInstructions() {
  return (
    <div
      className="space-y-4 rounded-lg border border-gray-100 bg-gray-50 p-3 text-xs text-gray-500"
      data-testid="drive-instructions"
    >
      <p>
        These steps set up a <strong>service account</strong>: a robot Google account that lets this application put
        files in your Google Drive without anyone's personal Google password.
      </p>
      <Step title="1. Create a Google Cloud project">
        <li>Go to the Google Cloud Console and sign in with your Google account.</li>
        <li>In the top-left bar, click the project list (it may say "Select a project").</li>
        <li>
          Click <strong>New Project</strong> at the top right of the dialog.
        </li>
        <li>
          Give it a name (for example "Drive-Integration") and click <strong>Create</strong>. When it is ready, make
          sure it is selected in the top-left list.
        </li>
      </Step>
      <Step title="2. Switch on the Google Drive API">
        <li>
          In the new project, search the top bar for <strong>Google Drive API</strong>.
        </li>
        <li>Click it in the results.</li>
        <li>
          Click the blue <strong>Enable</strong> button.
        </li>
      </Step>
      <Step
        title="3. Create the service account and its JSON key"
        note="Keep the downloaded JSON file safe: it works like a password to your Drive files."
      >
        <li>
          Open the left menu and go to <strong>IAM &amp; Admin &gt; Service Accounts</strong>.
        </li>
        <li>
          Click <strong>+ Create Service Account</strong> at the top of the page.
        </li>
        <li>
          Give it a name and click <strong>Create and Continue</strong>, then <strong>Done</strong> (the optional roles
          can be skipped).
        </li>
        <li>
          Find the new service account in the list, open the three-dot menu next to it and choose{" "}
          <strong>Manage keys</strong>.
        </li>
        <li>
          Click <strong>Add Key &gt; Create new key</strong>.
        </li>
        <li>
          Choose <strong>JSON</strong> and click <strong>Create</strong>: the file downloads by itself.
        </li>
      </Step>
      <Step title="4. Give the service account access to the Drive">
        <li>Open the downloaded JSON file in any text editor.</li>
        <li>
          Copy the address next to <code>client_email</code> (it looks like{" "}
          <code>your-app@your-project.iam.gserviceaccount.com</code>). The box above shows it once the key is pasted.
        </li>
        <li>
          In Google Drive, open (or create) a <strong>Shared Drive</strong>. A folder in someone's own "My Drive" will
          not work: a service account has no storage of its own outside a Shared Drive.
        </li>
        <li>
          Right-click the Shared Drive (or a folder inside it) and choose <strong>Share</strong>.
        </li>
        <li>Paste the client_email address into "Add people and groups".</li>
        <li>
          Set the role to <strong>Content Manager</strong> (or Editor).
        </li>
        <li>
          Untick "Notify people" (nobody reads that inbox) and click <strong>Share</strong>.
        </li>
      </Step>
      <Step title="5. Copy the folder ID">
        <li>Open that Shared Drive or folder so you can see the files inside it.</li>
        <li>
          The address bar shows something like{" "}
          <code>https://drive.google.com/drive/folders/1aBcD2eFgH3iJkL4mNoP5qRsT6uVwXyZ</code>.
        </li>
        <li>
          The folder ID is the long string at the end. You can also paste the whole address: the box picks the ID out of
          it.
        </li>
      </Step>
      <p>
        With the folder ID and the key in the boxes above, click <strong>Test Connection</strong>, then save, then
        switch the upload on.
      </p>
    </div>
  );
}

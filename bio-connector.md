# Biometric Site Connector — install and connect guide

How to put the **UKT Biometric Site Connector** on a factory computer and connect it to the HRMS, step by step. Read it top to bottom the first time; after that use the checklist in section 9 for each new site.

> **In one sentence:** the cloud HRMS (Railway) cannot reach biometric devices at `192.168.x.x`, so a small Windows program sits **inside the factory network**, reaches the devices there, and calls **out** to the HRMS over HTTPS. Nothing is opened or forwarded in any firewall.

```
 factory network                                              the internet
┌───────────────────────────────────────┐                  ┌──────────────────────────┐
│  biometric devices  (ZK protocol 4370)│                  │  HRMS on Railway         │
│        ▲                               │   HTTPS, OUT     │  api.uktextiles.in       │
│        │ local network                 │ ───────────────▶ │  /api/connector/…        │
│  ┌─────┴───────────────┐               │  poll, report    │  jobs · punches · status │
│  │ UKT Site Connector  │ ◀─────────────│ ◀─ jobs in reply │                          │
│  │ Windows service     │               │                  └──────────────────────────┘
│  │ local screen :8765  │               │
│  └─────────────────────┘               │      nothing connects IN: no firewall rule needed
└───────────────────────────────────────┘
```

---

## 1. What you need

| | |
|---|---|
| **HRMS** | Deployed on Railway with the connector release (migrations `0115` and `0116` applied — they run with the normal `migrate`). Nothing else to switch on. |
| **A computer at the factory** | Windows 10 / 11 (or Server 2016+), **switched on and awake whenever attendance is to be managed**, on the **same network as the devices**, with internet (HTTPS to the HRMS address). Turn off sleep (Power & battery → Screen and sleep → Never). |
| **A login in the HRMS** | An account with **Edit on Settings** and **no branch limit** (adding connectors is for someone who is not limited to a branch). |
| **Device details** | Each device's **address on the factory network** (`192.168.x.x`), port (`4370`) and **Comm Key** (usually `0`). |
| **To build from the repo** | Git, and Python 3.10 or newer ([python.org](https://www.python.org/downloads/) — tick **Add Python to PATH**). Only the PC that *builds* needs Python; the factory PC that runs the finished program does not. |

The HRMS address the connector asks for is the **API address** (for UKT: `https://api.uktextiles.in`), not the address of the web pages.

---

## 2. Get the program: clone the repository

The connector lives in its own repository, **`biometric_connector`** (separate from the HRMS repository). On the computer where you will build or run it, open **PowerShell** and:

```powershell
git clone <REPO-URL> biometric_connector
```

> Replace `<REPO-URL>` with the repository's address, for example `https://github.com/<account>/biometric_connector.git`. For a private repository Git asks you to sign in the first time (use a personal access token or Git Credential Manager).

```powershell
cd biometric_connector
```

What is in it:

| Path | What |
|---|---|
| `src/ukt_connector/` | the program (Python package) |
| `packaging/` | `build.ps1` (makes the release), `install-service.ps1`, `uninstall-service.ps1`, `nssm.exe` (runs it as a Windows service), `README-INSTALL.txt` |
| `docs/PROTOCOL.md` | the exact contract between the connector and the HRMS |
| `tests/`, `scripts/e2e_with_hrms.py` | the automated tests, and an end-to-end check against a real HRMS backend |
| `README.md` | developer overview |

---

## 3. Install — pick one

### Option A — Release for a factory (recommended): build once, install as a Windows service

**On the build computer** (needs Git and Python), from the `biometric_connector` folder:

```powershell
powershell -ExecutionPolicy Bypass -File packaging\build.ps1
```

This makes its own Python environment, runs the tests, builds `ukt-connector.exe` and produces:

```
dist\UKT-Biometric-Connector-1.0.0.zip      (about 13 MB)
```

(Add `-SkipTests` to skip the test run. The first build needs internet to download the Python packages.)

**On the factory computer:**

1. Copy the zip over (USB stick, shared drive, e-mail …) and **unzip** it somewhere, e.g. `C:\Temp\UKT-Biometric-Connector`.
2. First create the connector in the HRMS and get its **pairing code** (section 4, step 1).
3. Right-click **Start → Terminal (Admin)** / **Windows PowerShell (Admin)**, go to the unzipped folder and run:

```powershell
.\install-service.ps1 -Server https://api.uktextiles.in -Code K7QM-4XWD
```

Use your own code. The installer: pairs first (if the code is wrong it stops **before touching** anything already installed), copies the program to `C:\Program Files\UKT Biometric Connector`, registers the Windows service **UKT Biometric Site Connector** (starts with Windows, restarts itself if it stops), locks the data folder to the system and administrators, and starts it.

> You can also run `.\install-service.ps1` alone and pair afterwards from the connector's own screen (section 4, step 2).

### Option B — Run from the source (testing on your own PC; nothing is installed)

```powershell
cd biometric_connector
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
.venv\Scripts\pip install -e .
.venv\Scripts\ukt-connector run
```

Leave that window open: it runs the connector until you press **Ctrl+C**. Open <http://127.0.0.1:8765> in a browser on the same PC. To pair from the command line instead of the screen:

```powershell
.venv\Scripts\ukt-connector pair --server https://api.uktextiles.in --code K7QM-4XWD
```

Use this to try things out. For a real factory use Option A so the connector survives reboots and logouts.

---

## 4. Connect everything — the order matters

### Step 1 — In the HRMS: add the connector and get a pairing code

1. Sign in to the HRMS web app.
2. **Biometric Connectors → Device Control → Site connectors → Add a connector**.
3. Name it after the site (e.g. `Head Office`). The HRMS shows a **pairing code** like `K7QM-4XWD` **once**. It works **one time** and expires after **24 hours**. Copy it.

(Lost it or expired? Open the connector → **New pairing code**.)

### Step 2 — At the factory: pair the connector

Do **one** of these:

- **With the installer:** `.\install-service.ps1 -Server https://api.uktextiles.in -Code K7QM-4XWD` (section 3, Option A).
- **From the connector's screen:** on the factory computer open <http://127.0.0.1:8765>, enter the HRMS address and the code, and press **Pair**. (This screen opens **only on that computer** — by design nothing else on the network can open it. Use Remote Desktop if you are not sitting there.)
- **From the command line:** `ukt-connector pair --server https://api.uktextiles.in --code K7QM-4XWD` (for the installed service the program is `C:\Program Files\UKT Biometric Connector\ukt-connector\ukt-connector.exe`), then restart the service: `Restart-Service UKTBiometricConnector`.

Within a few seconds the screen shows **Connected to the HRMS**, the connector's name, and *Last contact: just now*. In the HRMS the connector shows **Online**.

> Pairing only connects the connector to the HRMS. **It does not move any device yet** — that is step 3. (A paired connector with "Devices: 0" is normal at this point.)

### Step 3 — In the HRMS: assign the devices to the connector

This is the step that makes devices go through the connector.

1. **Settings → Devices** — open each device at this site (add it if it is not there yet).
2. **Connect via** → choose your connector.
3. **Host** = the device's address **on the factory network** (`192.168.x.x`, as the connector's computer sees it), **Port** = `4370`, **Comm Key/Password** = the device's Comm Key.
4. Save.

A device with **no** connector is still connected to directly by the server (which only works if the device is reachable from the internet). That is exactly what showed **"read failed"** before assignment.

Within about 5 seconds the connector's screen lists the devices under **Devices at this site**.

### Step 4 — Check that it all works

| Where | What you should see |
|---|---|
| Connector screen (`http://127.0.0.1:8765`) | *Connected to the HRMS*; each device **answering**; punches waiting to send **0** |
| HRMS → Device Control → **Overview** → **Check connections** | each device **Connected** with "via *connector name* (online)", and its user/record capacity |
| HRMS → Device Control → **Site connectors** | the connector **Online**, its devices, and when it last read their punches |
| HRMS → Device Control → **Data Fetch** → **Read them now** | the list fills with each device's users (it waits a few seconds for the connector) |
| Try one change | **Data Push** → add a test user to one device → check on the terminal that the user is there → delete the test user again |

If something is red, go to section 8.

### Step 5 — Continuous attendance (nothing to do, but know it)

- The connector reads each device's recent punches **every 15 minutes** (last **2 days**) and sends what is new. Change this under **Site connectors → the connector → Settings**.
- It is the **safety net**: the devices' own live push (ADMS) to the server keeps working as before. The HRMS ignores a punch it already has, so nothing is counted twice.
- Punches go into a local queue on the factory computer and are removed only when the HRMS has acknowledged them. An internet outage or a restart loses nothing; they are sent when the connection is back.
- **Attendance → Sync Biometric / Auto Sync** skip connector devices (the connector reads them itself).

---

## 5. Day to day

- It runs by itself: starts with Windows, restarts if it stops. Nothing to do.
- **Local screen:** <http://127.0.0.1:8765> on that computer — connection to the HRMS, each device, what is being done, punches waiting, a log.
  - **Find devices on this network** lists any biometric device the PC can see (address, serial number, whether the HRMS knows it) — handy to check addresses.
- **Status from a command line:**

```powershell
Get-Service UKTBiometricConnector
```

```powershell
& "C:\Program Files\UKT Biometric Connector\ukt-connector\ukt-connector.exe" status
```

- **Files** live in `C:\ProgramData\UKT Biometric Connector\`:

| File | What |
|---|---|
| `config.json` | which HRMS, the connector's name, and its key (**encrypted** with Windows DPAPI) |
| `connector.db` | the queue of punches not yet sent, results of changes not yet reported, and the HRMS's last settings (encrypted) |
| `logs\connector.log` | what it did (rotated) |
| `logs\service-out.log`, `service-err.log` | what the Windows service printed |

- The folder is readable only by the system and administrators — it holds the key and the devices' Comm Keys.

---

## 6. Operations

**Update to a new version** — on the build computer `git pull`, run `packaging\build.ps1` again, copy the new zip to the factory and run `.\install-service.ps1` again (no code needed). The pairing and any unsent punches are kept.

**Move the connector to another computer** — HRMS: Site connectors → the connector → **New pairing code**. Install on the new computer and pair with it. The old computer stops working at its next call. Remove the service there (below).

**Disconnect without uninstalling** — connector screen → **Disconnect from the HRMS**, or `ukt-connector unpair`. To pair again, get a new code.

**Switch a connector off** (HRMS) — Site connectors → **Disable connector** (asks to confirm; anything it is in the middle of is given up and the page says the device may or may not have been changed). It is locked out at its next call. **Enable connector** brings it back. **Remove** deletes it and sends its devices back to being connected directly.

**Uninstall** — PowerShell (Admin) in the unzipped folder:

```powershell
.\uninstall-service.ps1
```

This removes the service and the program and **keeps** the settings and any unsent punches. To forget the pairing too add `-RemoveData` (it asks you to type `DELETE`, because the database may hold punches that have not reached the HRMS yet).

**Several factories** — one connector per site, named after the site, each on its own computer; assign each site's devices to its own connector. One device belongs to one connector.

---

## 7. What it can and cannot do

| Can | Cannot / note |
|---|---|
| Add, change, delete users on a device (every change is read back from the device and compared) | Put a **photo or a face template** on a terminal (the network protocol has no command for it) |
| Read who is on a device, check each device every minute | Be an ADMS gateway — devices are **not** pointed at it; their own push to the server is unchanged |
| Fetch punches by hand (Data Fetch: preview and update) and read them every 15 min | Work while its computer is off, asleep or offline — the HRMS shows it **Offline** and changes nothing |
| Keep working through internet outages (punches queue up) | Serve two requests on one device at the same time — a terminal talks to one program at a time, so a change waits (up to 90 s) for the connector's routine reading to finish |

Because the connector reports through the same server that asked for the work, the HRMS **never waits for it inside a page request**: adding, changing, deleting or reading through a connector shows *"waiting for the connector…"* for a few seconds and then finishes. Direct devices (no connector) answer instantly as before.

---

## 8. Troubleshooting

**Start with the connector's screen** (`http://127.0.0.1:8765`) and the HRMS **Site connectors** tab — both say what is wrong, in words.

| What you see | Meaning | What to do |
|---|---|---|
| HRMS Device Control: devices **"read failed"** and the blue notice *"This server runs in the cloud, so it cannot reach the devices"* | The devices are **not assigned to a connector** (or no connector exists) | Step 3: Settings → Devices → **Connect via** |
| Connector screen: **Devices: 0**, "No device is assigned to this connector yet" | Paired, but no device assigned | Step 3 |
| *"That pairing code is not valid or has expired"* | The code was already used, is older than 24 h, or was mistyped (the dash and capitals do not matter) | HRMS → the connector → **New pairing code**. After 10 wrong tries from one address it waits a few minutes |
| *"Could not reach the HRMS at …"* | No internet, or the address is wrong | Check the PC's internet and that the address is the **API** address (`https://api.uktextiles.in`) |
| *"The secure connection to the HRMS failed (a firewall may be re-signing HTTPS …)"* | A firewall doing SSL inspection | Install the firewall's certificate on the computer (the connector uses the Windows certificate store). If it still fails, set `"caBundle": "C:\\certs\\firewall.pem"` in `config.json` |
| *"The answer did not come from the HRMS"* | A firewall block page, a captive portal or a sign-in page is answering instead | Open the HRMS address in a browser on that PC to see what shows. Punches are kept safe meanwhile |
| *"The HRMS address answered with a redirect"* | The address redirects somewhere else | Use the address it redirects to |
| The network only reaches the internet through a **web proxy** | A Windows service has none of a signed-in person's proxy settings | Stop the service, add `"proxy": "http://proxy-address:port"` to `config.json`, start it again |
| *"Switched off in the HRMS"* / *"This token is not recognised"* | The connector was disabled or removed in the HRMS, or re-paired elsewhere | **Enable connector**, or pair again with a new code |
| Device: **timeout / unreachable / refused** | The PC cannot reach the device | Check the device's power, cable, **IP address and port**; ping it from that PC; use **Find devices on this network**; check both are on the same network/VLAN |
| Device: **auth** / *wrong Comm Key* | The Comm Key in Settings → Devices is wrong | Fix it in Settings → Devices (usually `0`) |
| Device: **busy** | The device is serving another request | Wait a moment — it is not a fault |
| HRMS shows the connector **Offline** ("last heard from 3 minutes ago") | Not heard from in 45 s: the PC is off/asleep/offline or the service stopped | Wake the PC and check `Get-Service UKTBiometricConnector`; if stopped, `Start-Service UKTBiometricConnector` and read `logs\service-err.log` |
| Overview says **"has not checked this device yet"** / "pending" | The connector has not reported on the device yet | Wait up to a minute or press **Check connections** |
| **Punches waiting to send** stays above 0 | The HRMS is not reachable or not answering properly | Fix the connection; they are sent by themselves. A count under "set aside" means the HRMS refused one particular punch — it is tried again after 24 h |
| The service will not start | Often a settings/permissions problem | Read `C:\ProgramData\UKT Biometric Connector\logs\connector.log` and `service-err.log`. If a file called `config.json.bad-…` or `connector.db.bad-…` appeared, the connector found a damaged file, set it aside and started clean — **pair again** (an old, damaged database cannot be read) |
| *"The local screen could not start on port 8765"* | Another program uses that port | `ukt-connector run --port 8766` (for the service set `"uiPort"` in `config.json`) |
| The local screen will not open from **another** computer | By design: it listens on this computer only | Use Remote Desktop to that computer |
| First start of a freshly installed program is slow | The antivirus scans a new program | Wait a minute before judging it "hung" |

For anything else, `ukt-connector -v run` (more detail in the log) and `docs/PROTOCOL.md` in the repository describe exactly what the connector says and does.

---

## 9. New-site checklist

1. **HRMS:** Biometric Connectors → Device Control → Site connectors → **Add a connector** (name = site) → copy the pairing code.
2. **Factory PC:** Windows, always on, never sleeps, same network as the devices, internet.
3. **Factory PC:** copy the release zip, unzip, PowerShell (Admin):
   `.\install-service.ps1 -Server https://api.uktextiles.in -Code <code>`
4. Open `http://127.0.0.1:8765` on that PC → **Connected to the HRMS**.
5. **HRMS:** Settings → Devices → each device → **Connect via** = the connector, host = `192.168.x.x`, port `4370`, Comm Key.
6. Connector screen → devices **answering**. Device Control → **Check connections** → all **Connected**.
7. Data Fetch → **Read them now** → users appear.
8. One test change: add a test user → see it on the terminal → delete it.
9. Leave it. Look at **Site connectors** once the next day: *last read* should be recent and *waiting to be sent* **0**.

---

## 10. Security notes

- The connector only makes **outgoing HTTPS** calls to the HRMS. The HRMS never calls it; nothing listens on the factory network. Its own screen listens on `127.0.0.1` only (whatever the settings file says) and refuses to be shown inside another web page.
- Its key (token) is random and kept **encrypted** on the factory PC (Windows DPAPI); the HRMS keeps only a **hash** of it, and a keyed hash of the pairing code. Disabling or removing the connector in the HRMS locks it out at its next call.
- The devices' Comm Keys are sent to the connector so it can open sessions; they are stored encrypted on its computer in a folder only the system and administrators can read, and are removed from jobs once a job ends. A user's device password never leaves the device (the HRMS is told only *whether* there is one).
- Every change it makes and every late or lost report is written to the HRMS **audit log**.

---

## 11. Related documents

- `D:\Projects\biometric app\README.md` and `docs/PROTOCOL.md` (in the connector repository) — the developer overview and the exact protocol.
- [biometric-integration.md](biometric-integration.md) — the server side: devices, ADMS push, Device Control, Site Connectors (how jobs and operations work).
- [user-guide.md](user-guide.md) — Device Control and Site connectors as an HR user sees them.
- [clouddeployment.md](clouddeployment.md) — deploying the HRMS to Railway (run the migrations on each release).

---

## Appendix — publishing the connector repository (once, by whoever maintains it)

The connector folder (`D:\Projects\biometric app`) is not a Git repository until you make it one. Create an empty repository on GitHub named `biometric_connector`, then:

```powershell
cd "D:\Projects\biometric app"
git init -b main
git add .
git commit -m "UKT Biometric Site Connector 1.0.0"
git remote add origin <REPO-URL>
git push -u origin main
```

The `.gitignore` already keeps the build output (`dist/`), the virtual environment, logs, and any local `config.json` / `connector.db` out of the repository, so **no key, token or release zip is committed**. `packaging/nssm.exe` (the small service wrapper) *is* included so a build works from a plain clone. Put the finished release zip somewhere your team can download it (a shared drive, or a GitHub *Release* attachment) — it is not stored in Git.

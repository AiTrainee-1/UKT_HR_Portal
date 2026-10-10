# MD Portal — the Managing Director's executive view

The **MD portal** is a second, separate front door for one person: the Managing Director. It answers *"is the company
running as it should, where is money or time leaking, and what needs my decision?"* in minutes, without reading
employee-level screens. It has its own pages, its own API (`/api/md/*`) and a read-only **AI assistant** (Google Gemini,
text + voice) that explains every number it gives.

Nothing about the existing HR portal changes. Every other account keeps exactly the access it has today.

---

## 1. Who gets it (identity and security)

| Rule | How it is enforced |
|---|---|
| Exactly one MD at a time | partial unique index `uniq_single_md` on `hr_users(is_md) WHERE is_md` (migration `0111`) |
| Assigned by the super admin only, from **Account Management** (switch on the account form) | `hr_user_views` (`isMd`, `replaceMd`), audited ("Assigned MD…", "Removed MD access…") |
| A super admin cannot be the MD; the MD must be company-wide (no branch) and active | validated in `hr_user_views._apply_md` |
| Only the MD reaches `/api/md/*` | `@require_md` on every view (re-reads the DB per request, so removing the identity closes the door on the next request) **and** a lock in `permission_middleware` (a path nobody routed is still refused) |
| The MD is **not** a super admin | existing HR access still follows the account's role; a role-less MD gets 403 on HR endpoints and uses `/api/md/*` |
| The MD can read the whole Report Center, read-only | `reporting/access.py` (`permission_level` = view, `md_only` executive reports) |
| The portal is read-only | every MD view is a GET inside `common.read_only_db()`: **the database refuses any write**. The assistant has no tool that changes anything and runs in the same guard |
| The front end hides what the server would refuse | `AuthContext.isMd` (from `/auth/me`, never from the token), route guard in `App.tsx` |

`tests_md_identity.py` walks the whole `/api/md/` URL table and fails if any route answers anyone but the MD.

---

## 2. What an MD needs (the analysis behind the pages)

An MD reads in two-minute bursts. They want **exceptions first, trends second, detail on demand**, always compared with
something (yesterday, last month, the company average, a target) and always with a way to ask *why*. So every page has:

1. **Headline cards** with a change chip (good/bad coloured by direction) and a sparkline.
2. **"Needs your attention"**: auto-detected exceptions with severity, the number, where to look, and an *Explain* button.
3. **Trends** (not snapshots) and **comparisons** (department against department, unit against unit, period against previous).
4. **Drill-down** to a short ranked table, never a wall of rows.
5. **"How is this calculated?"** on every figure (the same provenance the assistant quotes).
6. **Ask AI** on every card: opens the assistant with a ready-made question about exactly what the card shows.

| Page | The question it answers | Headline figures | Exceptions it surfaces |
|---|---|---|---|
| **Dashboard** | How is the company today? | active headcount, today's attendance %, 30-day absenteeism, payroll cost (last closed month) and change, overtime, attrition, open positions, visitors/outpasses today | the top items from every page below, ranked by severity |
| **Attendance Analytics** | Are people turning up, on time, and at what overtime cost? | attendance %, absenteeism %, late %, average late minutes, overtime hours, half days, missing punches | a department or unit below baseline, chronic absentees and late-comers, long unexplained absences, weekday/after-holiday patterns, ADR coverage gaps |
| **Employees** | What is the shape of the workforce and how is it moving? | headcount, staff vs production, joiners, leavers, net change, attrition %, average tenure | early attrition (leavers within 90 days of joining), attrition hot-spots, thin departments, long-tenure milestones |
| **Outpass & Visitors** | Who is coming in, who is leaving during the shift, and is it controlled? | visitors, outpasses, hours lost to outpasses, pending approvals, rejection rate | repeat outpass users, outpasses never returned, long outpasses, after-hours visitors, approvals waiting too long |
| **Tea Break** | Is the break discipline costing production time? | breaks, average minutes, overrun %, minutes lost | departments/shifts with the worst overruns, repeat overrunners, worsening trend |
| **Payroll Analysis** | What does the workforce cost, and what changed? | gross, net, cost per head, overtime cost, deductions, advances outstanding | month-on-month cost bridge (headcount / rate / overtime / loss-of-pay / bonus), outliers, zero or negative pay, big variances |
| **Reports** | Give me the one-page summaries and the full report library | executive reports (daily brief, weekly workforce, monthly payroll, attrition & hiring, attendance exceptions) + the whole Report Center | — |
| **Recruitment** | Are we hiring enough, fast enough, and keeping people? | open positions, pipeline, interviews, joiners, resignations, time-to-fill | positions open too long, pending resignations, funnel drop-offs, hiring vs attrition gap |
| **Activity Logs** | What are people doing in the system, and is anything sensitive or unusual? | actions, active users, sensitive actions, after-hours activity, sign-ins | deletes, payroll finalisation, role/permission changes, settings changes, odd hours, new devices |

### Shared definitions (so a number means the same thing on every page and in the assistant)

* **Today** is the factory's date (`ist_today()`), never the browser's or the server OS's.
* **Active headcount** = `Employee.status == "active"`. Everyone else is a leaver.
* **Attendance %**, **absenteeism %**, **late %**: use the Report Center's attendance-analysis definitions
  (`reporting/definitions/attendance_analysis_*.py`) unless there is a stated reason not to, and say which in `provenance`.
  Approved leave and holidays are not absence; weekly offs are not scheduled days.
* **Payroll money** comes from `SalarySlip` (the paid record), never from `Payroll.final_salary`.
* **Attrition %** = leavers in the period ÷ average headcount × 100 (annualised only when labelled so).
  There is no headcount history table, so headcount at a past date is *reconstructed* (joiners and leavers) and the
  `provenance.caveats` must say so.
* **Percentages are 0–100 floats (1 place), money is a float (2 places), "no data" is `null` (never 0).**
* A figure whose data is incomplete says so in `notes[]` (for example attendance day records not yet computed).

---

## 3. Backend

```
backend/api/md_portal/
  pages.py        the nine pages: id, title, path, summary (the assistant may only suggest these)
  common.py       THE CONTRACT: Period, Scope, prov(), envelope(), cached(), md_get, read_only_db(), pct/money/change
  views.py        /api/md/me, /api/md/org
  urls.py         mounts routes/<page>.py under /api/md/<page>/
  routes/         one module per page: thin @md_get views            ← page owners write these
  analytics/      one module per page: pure read-only functions      ← page owners write these
  assistant/      Gemini client, tools, query DSL, privacy, engine, jobs (built separately)
```

### Writing an analytics function

```python
from ..common import Period, Scope, envelope, prov, pct, cached

@cached()                                   # 60 s in-process cache (off in tests); args must be simple / have .key()
def attendance_summary(scope: Scope, period: Period) -> dict:
    qs = AttendanceDayRecord.objects.filter(scope.employee_q("employee__"), date__range=(period.start, period.end))
    ...
    return envelope(
        {"attendancePct": 91.8, "absentDays": 412, ...},     # camelCase keys, plain JSON types (no date/Decimal objects)
        period=period, scope=scope,
        provenance=[prov("attendance-pct", "Attendance %", dataset="Attendance day records",
                         definition="Days present or on duty out of scheduled days.",
                         formula="(present + 0.5 × half-days) ÷ scheduled days", rows=n,
                         filters=["Approved leave excluded"], caveats=["Today is provisional until day end."])],
        notes=[],
    )
```

* Take a `Period` and a `Scope` (`common.resolve_period(params)` / `resolve_scope(params)`; both raise `MdParamError`,
  which the view turns into a 400 with a readable message and the assistant gets back so it can correct itself).
* `scope.employee_q(prefix)` filters any model that points at an employee (`prefix="employee__"`); `scope.employees()`
  gives `Employee` rows. **Always apply the scope**; an unscoped query is a bug.
* **Never write.** The database rejects it inside `read_only_db()`. Do not call `compute_*` helpers or `Model.get()`
  singletons that create rows; read the table directly (`.filter(pk=1).first()`).
* **Aggregate in the database** (`.values().annotate()`), `select_related` for names, no query per row. Heavy endpoints
  get a "query count does not grow with the data" test.
* Dates are ISO strings (`"2026-10-05"`); timestamps are the factory's wall clock, naive ISO (`"2026-10-05T10:42:10"`).
  Aware datetimes in UTC → `timezone.localtime(dt, FACTORY_TZ)`; group by day with `TruncDate("x", tzinfo=FACTORY_TZ)`.
* Lists are capped (`limit`, default 10, max 25 for ranked lists; paged tables use `page` / `pageSize` ≤ 100, `q` for search).

### Writing the REST route

```python
@md_get
def summary(request):
    params = request_params(request)
    return attendance_summary(resolve_scope(params), resolve_period(params, default="last_30_days"))

urlpatterns = [path("summary", summary)]       # → GET /api/md/attendance/summary?period=last_7_days&branch=Unit1
```

### The three things every page module also exports

1. **`TOOLS`**: the assistant's tools for this domain (`assistant/tools_base.tool(...)`). 4–8 tools, each an existing analytics
   function with a description written for an LLM (when to use it, what it returns, units). See `tools_base.py`.
   `tests_md_tools_contract.py` checks every tool automatically (well-formed, read-only, plain JSON, has provenance).
2. **`insights(*, today=None) -> list[dict]`**: company-wide exceptions for the Dashboard, cheap (< 1 s), at most 5, most severe
   first: `{"id": "attendance.dept-spike", "severity": "critical|warning|info|good", "title", "detail", "metric", "page": "<page id>", "ask": "<question for the assistant>"}`.
   Titles are plain English with the number in them ("Stitching absenteeism is 14%, double its 90-day average").
3. **`headline(*, today=None) -> dict`**: what the Dashboard card strip shows for this domain:
   `{"kpis": [{"id", "label", "value", "format": "number|pct|inr_compact|minutes|text", "sub", "delta": {"abs","pct","good": "up|down|null"}, "spark": [..], "page"}], "provenance": [...]}`
   (1–3 KPIs; `good` says which direction is good news so the card colours the change correctly).

### Tests

`backend/api/tests_md_<module>.py`, subclass `tests_md_support.MdApiTestCase` (`self.get("/api/md/...", period=...)`).
Build small, exact fixtures and assert **numbers**, not just shape: the figure the page shows must be recomputable by hand
from the fixture. Cover: empty database (no division by zero, `null` not 0), scope filtering (unit / department / type),
period edges (inclusive ends, previous-period), the exceptions logic, and the tools.
Run with a private test database so parallel runs do not collide:
`DB_TEST_NAME=test_uktex_<module> python manage.py test api.tests_md_<module> --noinput`.

---

## 4. Front end

```
frontend/src/
  lib/md/                  format.ts (₹ lakh/crore, %, minutes), period.ts (presets → query), types.ts, assistant-store.ts
  lib/api-client/custom-hooks/md.ts     useMdQuery<T>(path, params), useMdMe, useMdOrg
  components/md/           MdLayout, MdSidebar, md-nav.ts, assistant/ (panel), kit/ (below)
  components/md/kit/       StatCard, SectionCard, TrendChart, BarList, DonutChart, Heatmap, DataTable, InsightList,
                           FilterBar (PeriodBar + ScopeBar), MdPageHeader, AskAiButton, ProvenanceButton, states
  pages/md/Md<Page>.tsx    one per page ← page owners write these (plus pages/md/<page>/ for pieces and types)
  pages/md/testing/        renderMdPage(): smoke-render a page with fixture data
```

Design language: **the same clay/blue look as the HR portal** (cards are `SectionCard`, tiles `StatCard`, uppercase
`#006496/60` table headers, page gradient from `MdLayout`) plus the MD's **gold `#e0a83a`** as the identity accent
(AI, "Ask AI", the identity chip). Do not invent new card styles; compose the kit.

### Page recipe

```tsx
export default function MdAttendance() {
  const [period, setPeriod] = useState<PeriodChoice>({ preset: "last_30_days" });
  const [scope, setScope] = useState<ScopeChoice>(EVERYONE);
  const params = { ...periodParams(period), ...scopeParams(scope) };
  const org = useMdOrg();
  const summary = useMdQuery<AttendanceSummary>("attendance/summary", params);
  usePublishAssistantContext({ page: "attendance", title: "Attendance Analytics",
    filters: { Period: ..., Scope: ... }, summary: { "Attendance": ..., "Absenteeism": ... } });
  return (
    <MdLayout>
      <div className="mx-auto max-w-[1500px] space-y-5">
        <MdPageHeader icon={UserCheck} title="Attendance Analytics" subtitle="…" updatedAt={summary.data?.generatedAt} />
        <FilterBar><PeriodBar value={period} onChange={setPeriod} /><ScopeBar value={scope} onChange={setScope} org={org.data} /></FilterBar>
        {summary.isError && <ErrorBanner message={describeMdError(summary.error)} onRetry={() => summary.refetch()} />}
        <div className="grid grid-cols-2 gap-3 @3xl:grid-cols-4 @6xl:grid-cols-6">{/* StatCards */}</div>
        <SectionCard title="Needs your attention">…<InsightList items=… /></SectionCard>
        <div className="grid items-start gap-5 @2xl:grid-cols-2 @5xl:grid-cols-12">
          {/* SectionCards with charts, each with provenance + AskAiButton, e.g. className="@5xl:col-span-4" */}
        </div>
      </div>
    </MdLayout>
  );
}
```

* `loading` on a `SectionCard` only for the **first** load (`isPending`); a changed filter keeps the old data on screen (`placeholderData`).
* Show `envelope.notes` with `NoteBanner`. Empty states use `EmptyBlock` with a sentence that says why it is empty.
* Every card gets `provenance` (so "How is this calculated?" works) and, where a question makes sense, `AskAiButton`.
* Mobile first: the page works at 375 px (cards stack, tables scroll inside their card, no horizontal page scroll).
* **Layout answers to the page, not the screen.** `MdLayout`'s `<main>` is a container (`@container`), so columns are chosen
  with container variants (`@2xl:`, `@3xl:`, `@4xl:`, `@5xl:`, `@6xl:`), never with `sm:`/`md:`/`lg:`/`xl:`. The room a page has
  is the screen minus the sidebar (full or a rail) minus the assistant panel (444 px when open on a wide screen), so a 1440 px
  screen with the panel open has about 690 px for the page, the same as a 1000 px screen. Rules of thumb: KPI strips
  `@3xl:grid-cols-4` / `@6xl:grid-cols-6`; a row of three cards one column, then `@2xl:grid-cols-2` (the odd card
  `@2xl:col-span-2`), then `@5xl:grid-cols-12`; a row of two cards `@4xl:grid-cols-12`; always `items-start` so a short card is
  not stretched into a tall empty one. A kit component that must adapt to its own width (the donut's legend) wraps itself in
  its own `@container`.
* `data-testid="md-<page>-<thing>"` on the things an end-to-end test needs.
* Money/number/percent text comes only from `lib/md/format.ts` (`inrCompact`, `inr`, `num`, `pct`, `minutesText`, …).
* No `any`; types for each response live in `pages/md/<page>/types.ts`. Pure logic (shaping data for a chart, labels) goes
  in plain `.ts` files next to the page with their own `*.test.ts`.
* Smoke test: `pages/md/<page>/Md<Page>.test.tsx` using `renderMdPage` with fixtures for every endpoint the page calls
  (including one error response and one empty response). It must pass without a network.

Quality gates (all must pass): `npx prettier --check src/pages/md src/components/md`, `npx tsc --noEmit -p .`,
`npx eslint <your files>` (no new warnings), `npx vitest run src/pages/md/<page>`.

---

## 5. Data dictionary and gotchas (learned the hard way)

* `Employee.join_date` is **TEXT** (parse defensively). Exit date/reason are in the `exit_infos` relation. No headcount history.
* `AttendanceDayRecord` (ADR) is the payroll source of truth for daily status, but it is **computed lazily**: older or
  not-yet-processed days may have no row. Report the **coverage** (rows ÷ expected) and say when it is partial. *Today* is provisional.
* A Saturday (or other) day off is *not* an absence: once a day is computed the engine may store it as `absent`, so use the Report Center's day classification (`classify_day` / the Roster) rather than counting raw `absent` rows.
* `SalarySlip` is the money record; never sum `Payroll.final_salary`.
* Visitors have **no check-out**: "who is inside now" and dwell time cannot be derived, so do not show them.
* Tea-break minutes are *derived* with the current rule (see `reporting/definitions/gate_visitor_tea_common.py`), not stored.
* `AuditLog.user_id` is NULL for HR users: group by `user_name`.
* Timestamps in UTC vs factory time: see §3 (Dates).
* `compute_*` helpers and `*.get()` singletons write: they will raise inside `read_only_db()`; read the rows directly.
* `permission_middleware` fails *open* for unmapped path prefixes: that is why every `/api/md/*` route carries `@require_md`
  **and** the middleware has a lock for `/md/`.
* The Report Center (`reporting/`) already computes many of these figures; **reuse its helpers/definitions** rather than
  re-deriving (and keep the two consistent). `reporting.runner.run_report(...)` runs a report in-process (it does not check access).
* Branch isolation: the MD is company-wide (`request.hr_branch_id` is `None`); the filter bar's unit/department narrow the scope.

---

## 6. The AI assistant (Google Gemini, read-only, explainable, voice)

A side panel on every MD page (and nowhere else): the MD types or speaks a question, the assistant looks the answer up in
the company's data, replies in text (and, if wanted, in voice) and shows *how* it got there.

### How an answer is made

```
question ─► privacy (names → @emp-123 tokens) ─► Gemini ─► tool calls ─► read-only analytics ─► results ─► Gemini ─► submit_answer
                                                                             (inside read_only_db)                  │
   what the MD reads: answer + "How I got this" + page suggestions  ◄── names restored, explanation built by the server
```

* **A background job.** `POST /api/md/assistant/ask` stores the question and starts a thread (`assistant/jobs.py`); the browser
  polls `GET /api/md/assistant/messages/<id>` every ~1 s and shows live progress ("Looking at attendance summary…"). A job whose
  thread died is closed with a clear message the next time it is polled. Tests run jobs inline.
* **Tools, not SQL.** Gemini can only call (a) each analytics module's `TOOLS` (the same functions the pages use, so the assistant
  and a page can never disagree), (b) `query_data`, a whitelisted query language over 13 datasets (`assistant/query_dsl.py`: filter,
  group, count/sum/avg; max 2 groups, 4 metrics, 8 filters, 50 rows, an 8 s statement timeout) for questions no tool covers, and
  (c) `find_reports`, which finds the right report in the Report Center catalog. It ends by calling `submit_answer`, which gives a
  structured answer (answer, spoken summary, explanation, assumptions, suggested pages, follow-ups, confidence) on every model with
  no second request. At most `max_tool_rounds` rounds (default 5); on the last, only `submit_answer` is allowed.
* **Read-only, three ways.** There is no tool that changes anything; every tool runs inside `common.read_only_db()`, where the
  database refuses INSERT/UPDATE/DELETE; and the MD's login has no way to the HR write endpoints at all.
* **Explainable (XAI).** The "How I got this" panel is built by the server (`assistant/xai.py`) from the lookups that really
  happened, never from what the model says it did: *What I did* (each lookup, period, scope, records, time; a free-form query is
  shown in words), *Data used* (dataset, definition, formula, rows, filters, caveats from each figure's provenance), *Assumptions*
  (a defaulted period, a fuzzy-matched name, plus the model's own, labelled "in the assistant's words"), and a **confidence**
  (high only when it rests on successful built-in lookups with no caveats; the model can lower it, never raise it).
* **Privacy** (`assistant/privacy.py`). Free-tier Gemini content may be used by Google to improve its products and read by
  reviewers. So in privacy mode (default) employee names, in the MD's question and in tool results, become tokens
  (`@emp-1042`) before anything leaves the server, and are put back in what the MD reads. Phone, e-mail, address, date of birth,
  bank and government ids are **never** sent, in any mode. A tool declares extra person fields with `person_fields`.
* **Gemini specifics** (`assistant/gemini.py`, raw REST over `requests`): `x-goog-api-key` header; no `temperature`/`topP`/`topK`
  (ignored by Gemini 3); `thinkingConfig.thinkingLevel` on 3.x, `thinkingBudget` on 2.5; the model's reply is sent back **verbatim**
  (it carries a `thoughtSignature`); every `functionResponse` echoes the call's `id` and `name`; per-minute 429s are waited out,
  per-DAY 429s skip to the next model; 503/500 are retried with backoff then the next model; 404 skips the model. Models are
  settings (default `gemini-3.5-flash-lite`, fallbacks `gemini-3.1-flash-lite`, `gemini-3.8-flash`) because Google renames them.
* **Budget.** Every Gemini request is counted per model per Pacific day (when Google resets the free quota) in
  `md_assistant_usage`; when every model is out, the MD is told when it resets ("about 12:30 PM IST").
* **History.** Conversations and messages are stored (`md_conversations`, `md_messages`) so a conversation survives page changes
  and the explanation can be shown again; the MD can delete any or all. Nobody else can read them (every query is by the MD).

### The character (the radio, 2026-10-10)

The assistant's face is the radio character from the `page-mascot` package (`npm i page-mascot`; MIT, no dependencies). Its
two sheets, `public/mascots/radio-directions.webp` and `radio-reactions.webp` (3x3 grids of nine head directions and nine
expressions, transparent), are the character; any other of the package's characters can replace them by changing
`RADIO_SHEETS` in `components/md/assistant/mascot.tsx`.

* **`RadioMascot`** (the package's `Mascot`): the head follows the pointer and a poke gives a blink, a heart or sparkles
  (dizzy when poked repeatedly). It is the floating launcher (`Launcher.tsx`, bottom-right, with an "Ask AI" bubble; the poke
  opens the panel 280 ms later so the reaction is seen, at once with reduced motion, and Ctrl+J never waits) and the
  panel's welcome. The package names its button "Boop the ..."; the launcher renames it "Open the AI assistant".
* **`MascotFace`**: the same sheets as a still face for the small avatars (the panel header and each reply), because the
  package has no way to set an expression and many pointer-tracking copies would be wasteful. The expression follows what
  the assistant is doing: sparkles while an answer is made (`working`), dizzy when it failed, asleep when the MD stopped it,
  the plain face otherwise. The cell order is the package's (`DIRECTIONS`, `REACTIONS` in `dist/mascot.js`).

### Voice

* **Listening** (`components/md/assistant/voice/useVoiceInput.ts`): the browser's recogniser (Web Speech API) with live words in
  English (India), Tamil or Hindi; automatically falls back to recording + server transcription (`POST /api/md/assistant/transcribe`,
  Gemini audio) when the browser has no recogniser, when the MD chooses *Auto-detect*, or when the recogniser fails to start
  (Edge). A confident transcript (≥ 0.6) is sent at once; a doubtful one is put in the box for the MD to check. Half-duplex:
  speech is stopped before the microphone opens.
* **Speaking** (`useSpeechOutput.ts`): the browser's text-to-speech reads the short *spoken summary* (plain words, numbers spelled
  out) in sentence-sized pieces (Chrome cuts long utterances off); the voice is chosen by the language of the text; if the device has
  no Tamil/Hindi voice the answer is shown and the MD is told. A spoken question gets a spoken answer; "Reading aloud" does it
  for every answer; every answer has a Listen button.
* **Secure context.** The microphone needs HTTPS (or `localhost`); on a plain-HTTP LAN address the browser blocks it and the
  panel says so.

### Settings (super admin: Account Management → MD profile)

Enabled, model + fallbacks, thinking depth, lookup rounds, requests per minute, privacy mode, *Test connection* (one tiny request +
the models the key can use) and today's usage. **The API key is not here**: it is read from the server environment only.

### Testing

`tests_md_assistant_*.py` (client, privacy, engine with a scripted Gemini, HTTP API, settings), `tests_md_query_dsl.py`,
`tests_md_tools_contract.py` (every tool of every module); front end: `AssistantHost.test.tsx` + unit tests of the markdown
parser and voice rules; end to end: `e2e/md-assistant.spec.ts` against the real backend with `e2e/fake-gemini.mjs` standing in
for Google (it also records what was *sent*, so the no-names guarantee is asserted).

## 7. Setup

1. Create a key in Google AI Studio (the free tier is enough to start). Put it in `backend/.env` as `GEMINI_API_KEY=...` and
   restart the backend. The key is never stored in the database or shown in the UI.
2. Account Management → **MD profile** → *Create MD account* (or make an existing login the MD). The MD signs in at the usual
   HR login page and lands on the MD portal.
3. Account Management → MD profile → *Test connection*. If a model name has been retired, pick a current one from the list.
4. **Free tier and real data.** On Google's free tier what is sent may be used to improve Google's products and read by reviewers.
   Names are replaced by codes and contact/bank details are never sent, but payroll figures and workforce numbers are still
   company data. Before relying on the assistant with real data, enable billing on the Google project (the Paid Services terms
   do not allow training on prompts).
5. Voice needs HTTPS or `http://localhost`. On the on-premise LAN over plain HTTP the browser blocks the microphone: serve the
   portal over HTTPS (for example behind the same reverse proxy that serves the app).
6. Free-tier limits are small and change (Google no longer publishes per-model numbers): a handful of requests a minute and a few
   hundred a day. The assistant batches lookups into one step, caches repeats and counts what it uses.

---

## 8. Build map (who owns what)

| Module | Backend (`api/md_portal/`) | Front end (`src/pages/md/`) | Tests |
|---|---|---|---|
| attendance | `analytics/attendance.py`, `routes/attendance.py` | `MdAttendance.tsx`, `attendance/` | `tests_md_attendance.py` |
| employees | `analytics/employees.py`, `routes/employees.py` | `MdEmployees.tsx`, `employees/` | `tests_md_employees.py` |
| visitors (+ outpass) | `analytics/visitors.py`, `routes/visitors.py` | `MdVisitors.tsx`, `visitors/` | `tests_md_visitors.py` |
| tea break | `analytics/tea_break.py`, `routes/tea_break.py` | `MdTeaBreak.tsx`, `tea-break/` | `tests_md_tea_break.py` |
| payroll | `analytics/payroll.py`, `routes/payroll.py` | `MdPayroll.tsx`, `payroll/` | `tests_md_payroll.py` |
| recruitment | `analytics/recruitment.py`, `routes/recruitment.py` | `MdRecruitment.tsx`, `recruitment/` | `tests_md_recruitment.py` |
| activity | `analytics/activity.py`, `routes/activity.py` | `MdActivity.tsx`, `activity/` | `tests_md_activity.py` |
| reports | `reporting/definitions/md_*.py` | `MdReports.tsx`, `reports/` | `tests_md_reports.py` |
| dashboard | `analytics/dashboard.py`, `routes/dashboard.py` | `MdDashboard.tsx`, `dashboard/` | `tests_md_dashboard.py` |
| demo data | `management/commands/seed_md_demo.py` | — | `tests_md_demo_seed.py` |

Shared files are **frozen for module owners** (change requests go to the integrator): `common.py`, `pages.py`, `urls.py`,
`views.py`, `assistant/*`, `permission_middleware.py`, `kit/*`, `MdLayout`, `MdSidebar`, `md-nav.ts`, `lib/md/*`,
`custom-hooks/md.ts`, `App.tsx`, `package.json`. No migrations in a module (the portal reads existing tables).

---

## 9. Demo company and visual checks

* **Demo data.** `seed_md_demo` fills a throwaway database (its name must end in `_e2e`; it refuses anything else) with a realistic
  garment manufacturer: 4 units, ~240 people, 120 days of attendance with planted stories (a bad Monday, a weak department, a
  device outage, chronic absentees), tea breaks, visitors, outpasses, six payroll months (September has a bonus), recruitment, and
  an activity trail. `DB_NAME=uktex_demo_e2e python e2e_setup.py && DB_NAME=uktex_demo_e2e python manage.py seed_md_demo`, then
  sign in as `md_demo` (password `DEMO_PASSWORD` in `md_demo/common.py`; the other demo accounts are listed when it finishes).
  `--purge` removes exactly what it created (a machine-local `manifest-<db>.json`, git-ignored).
* **Look at it.** On that data every page, at 375 / 1024 / 1366 / 1920 px, with and without the assistant open, was checked for
  overflow, truncated labels and empty space (the checks are in `e2e/md-pages.spec.ts`). Things that went wrong once and are worth
  remembering: a grid with only container-query columns needs `grid-cols-1` for its base (otherwise a wide table makes the single
  column wider than the screen); recharts calls a tick formatter with `(value, index)`, so never pass `num` itself (`TrendChart`
  now wraps formatters); and every unit has its own "Stitching", so name the unit wherever departments are listed.
* **End to end.** `e2e/md-assistant.spec.ts` (identity, assistant, privacy, read-only, quota, voice) and `e2e/md-pages.spec.ts`
  (all nine pages, laptop / phone / assistant open: no 5xx, no console error, nothing wider than the screen).

---

## 10. The MD's copies of the HR pages (added 2026-10-10)

The MD portal is no longer only analytics. Fourteen HR pages exist in it **in full** (same components, same features, same
buttons, same API as the Super Admin has) with the MD's **Insights & AI** on top. Decisions taken with the product owner:

* **The MD can act**, like a super administrator, on exactly these pages' modules (add/edit employees, edit shifts,
  branches ...). This reverses section 1's "portal is read-only" **for these pages only**. `/api/md/*` (analytics) is still
  read-only (`read_only_db()`), and **the assistant still has no write tool**.
* **Exception (2026-10-10, the product owner: "the MD only needs to view those requests"): Leave & Holiday and Requests
  are look-only.** The MD sees every leave, permission and outpass request (and holidays, leave types) but cannot approve,
  reject, edit or delete them: HR and the department heads decide. Three layers, all driven by `MD_VIEW_ONLY`
  (`permission_registry.py`, a cap: a role on the MD account cannot raise it): (1) the permission middleware refuses the
  MD's writes on those modules with 403 "The Managing Director can view this section but cannot change it"
  (`tests_md_hr_access.py`); (2) `/auth/me` reports `leave` and `requests` as `view`, so the pages show the "View only"
  banner and the existing lock disables their other mutating buttons (and hides icon-only bins:
  `view-only-lock.ts lockIconOnlyDeletes`); (3) `MdHrApp` calls `setViewOnlyWorkflows(viewOnlyWorkflowsFor(user))`
  (`lib/md/view-only-requests.ts`) so `hrCanAct` / `hrCanReject` (`lib/approval-workflow.ts`), which every HR page asks
  before drawing Approve / Reject, answer no for the leave, permission and outpass workflows: that also covers the Outpass
  page's Requests tab. It is set in the `Page` guard because a page builds its buttons in its own render, before the frame
  around it renders. The dashboard's "Requests waiting" card (`pages/md/home/RequestsWaiting.tsx`) lists the pending
  requests, oldest first, with who each waits for, and no buttons. Geo Attendance's on-duty approvals, and the rest of
  the pages, are unchanged. To give the decisions back: remove the key from `MD_VIEW_ONLY`, set it to `edit` in
  `MD_HR_GRANTS`, and drop it from `REQUEST_WORKFLOW_MODULES`.
* The old analytics pages for Attendance, Employees, Outpass & Visitors and Tea Break **merged into** the pages they
  analyse (their content is now each page's Insights). `/md/visitors` and `/md/tea-break` redirect. Payroll, Reports,
  Recruitment and Activity Logs stay analytics pages.

### 10.1 The fourteen pages

| MD page (sidebar) | Address | page id | HR component | Insights domain (`analytics/<domain>.py`) |
|---|---|---|---|---|
| Dashboard | `/md/dashboard` | `dashboard` | `pages/hr/Dashboard` | `dashboard` (exists) |
| Employees | `/md/employees` | `employees` | `Employees` (+ `/new`, `/bulk-upload`, `/:id`, `/:id/edit`) | `employees` (exists) |
| Branches | `/md/branches` | `branches` | `Branches` | **`units`** (new) |
| Staff Attendance | `/md/attendance/staff` | `attendance` | `Attendance` | `attendance` (exists; scope `type=staff`) |
| Production Attendance | `/md/attendance/production` | `attendance-production` | `Attendance` | `attendance` (scope `type=production`) |
| Geo Attendance | `/md/geo-attendance` | `geo-attendance` | `GeoAttendance` | **`geo`** (new) |
| Attendance Search | `/md/attendance/search` | `attendance-search` | `AttendancePunchSearch` | **`punches`** (new) |
| Report Log | `/md/attendance/report-log` | `report-log` | `AttendanceReportLog` | **`reportlog`** (new) |
| Outpass | `/md/outpass-visitors/outpass` | `outpass` | `OutpassVisitors` | `visitors` (exists; outpass focus) |
| Visitors | `/md/outpass-visitors/visitors` | `visitors` | `OutpassVisitors` | `visitors` (visitor focus) |
| Tea Break | `/md/outpass-visitors/tea-break` | `tea-break` | `OutpassVisitors` | `tea_break` (exists) |
| Manage Shift | `/md/shifts` | `shifts` | `ManageShift` | **`shifts`** (new) |
| Leave & Holiday | `/md/leave` | `leave` | `LeaveHoliday` | **`leave`** (new) |
| Requests | `/md/requests` | `requests` | `ApprovedRequests` | **`requests`** (new) |

`backend/api/md_portal/pages.py` and `frontend/src/components/md/md-nav.ts` list the pages (ids, titles, paths, domains);
`md-nav.test.ts` fails if they drift.

### 10.2 How a copy runs (so you know what you can and cannot touch)

```
browser  /md/employees/5   ->  App.tsx catch-all  /md/*?   ->  components/md/MdHrApp.tsx
                                   nested wouter Router whose hook (lib/md/embed.ts useMdHrLocation) shows the page
                                   /hr/employees/5, and turns every /hr/... address a page navigates to into /md/...
HR page component   <HrLayout>  ->  (inside MdEmbedProvider)  HrLayout renders <MdLayout> instead of the HR shell
MdLayout            ->  <MdEmbeddedFrame>  =  the shared title row (10.2a) + [Strip] + page  (or the Insights tab)
```

* **The HR page components are untouched and must stay untouched** (the product owner's hard rule: "do not modify the
  existing pages"). Everything MD is added around them. If you believe an HR component must change, STOP and report.
* `Operations` is the HR page (stays mounted when the Insights tab is open, so filters and typing are kept).
  `Insights & AI` is the page's analytics, mounted only while open (so it can publish its own assistant context).
* **Your files**: `frontend/src/pages/md/embedded/<page id>/index.tsx` (folder name = the page id from the table):

```tsx
export default function Insights() { ... }   // the Insights & AI tab. No layout of its own (the frame is the layout).
export function Strip() { ... }              // optional: the strip above the page. Default: <BriefStrip page="<id>"/>
```
  They are found by `import.meta.glob` (`components/md/embedded/registry.tsx`): no registration edit is needed. Without
  them a page gets the generic brief (`components/md/embedded/brief.tsx`: the domain's `headline()` + `insights()` served
  by `GET /api/md/brief/<page id>`), so every page already shows something.
* Inside an embedded page `useLocation()` returns **`/hr/...` addresses** (the router hides the `/md` prefix), but your
  Insights modules and the kit use `/md/...` links (`MD_NAV_BY_ID[id].path`), which pass through unchanged. Links to a
  page that the portal does not copy go to the nearest MD page (`HR_TO_MD_PAGES` in `lib/md/embed.ts`).
* **The MD's access** to the modules behind the pages is `permission_registry.MD_HR_GRANTS` (edit on the pages' modules
  except `leave` and `requests`, which are `view` and capped by `MD_VIEW_ONLY`; `view` on `recruitment`), merged into
  `/auth/me` `permissions` (the role alone is `rolePermissions`), so the HR pages' own permission checks work unchanged.
  `tests_md_hr_access.py` pins it. One line makes the MD's copy of any module read-only.

### 10.2a The title row (the same on every MD page; changed 2026-10-10)

```
Title  (Live)  [ Operations | Insights & AI ]  ..............  [the page's own buttons]  |  Updated 10:31:22 am
date / what the page is for                                                              |  Refresh
```

* The pieces are in `components/md/kit/MdHeaderParts.tsx` (`LiveChip`, `ModeTabs`, `UpdatedRefresh`). The pages the MD
  portal owns (Payroll, Reports, Recruitment, Activity Logs) get the row from `kit/MdPageHeader`; the **Dashboard has no title strip** (owner's choice, 2026-10-10: the welcome card is the top of the page and its greeting is the page's `h1`) (`title`,
  `subtitle`, `actions`, `updatedAt`; `icon` is accepted and ignored). **Use it for any new MD-owned page.** Do not draw a
  title row of your own, and do not add a Refresh button: the stack has one (it reloads every query on screen).
* The HR pages' copies keep the HR page's own title row, and the frame slots the pieces into it
  (`embedded/headerRow.ts`, DOM side, unit-tested; `useHeaderAdoption.ts`, React side): the Live chip goes inside the
  heading, the switch right after the title block, the stack is pinned to the row's top-right corner (room is kept for it)
  and the strip goes under the row. The page's own Refresh buttons are hidden (the stack replaces them), its buttons are
  pushed right, titles are set to one size/colour, subtitles to a 34rem maximum, and a page's own padded `max-width`
  container (Report Log) loses its padding so every title starts at the same left edge. Below 720px of content width the
  stack goes back into the row's flow. **No HR file is touched.**
* The row is found by: the page's first `h1/h2`, then the nearest flex container above it that spreads its items out
  (else the nearest flex container). A page whose heading has no flex row (or none yet) gets the frame's own row above it
  (`MdPageHeader` with the tab switch): same look, nothing breaks. The Insights tab always draws the frame's own row, with
  the page's title and subtitle read from the page, so switching tabs does not move anything.
* A crowded row wraps (the switch or the buttons drop to a second line) instead of squeezing the buttons.
* Checked by `headerRow.test.ts`, `MdPageHeader` use in the page tests, and e2e `md-hr-pages.spec.ts` ("every MD page opens
  with the same title row": the same left edge and the same right edge on all 18 pages, Live on the title's line, the stack
  at the top of the row, one Refresh).
* **Seven pages are laid out as a grid instead (2026-10-10, section 11.6):** Employees, Staff Attendance, Production
  Attendance, Outpass, Visitors, Manage Shifts and Requests. Their own title rows differ in height, so the switch and the
  stack used to land at a different place on each. The other pages keep the flowing row described above.

### 10.3 What every Insights tab must contain

The MD reads in two-minute bursts (section 2). Each Insights tab is a small analytics page for **that page's subject**:

1. A filter bar (`PeriodBar` / `ScopeBar` from `kit/FilterBar`): period (default `last_30_days` unless the subject is
   "now") and scope (unit / department / type) where the data has them.
2. **A plain-English summary** composed by the SERVER from the numbers (like `dashboard.briefing`): 2-4 sentences, every
   figure in it taken from the same envelope, with an "Explain with AI" button. (No LLM call on page load: it would cost
   quota and send data to Google on every visit. The AI explains on demand, through the assistant.)
3. **KPI cards** (`KpiCard`): value, change against the previous period (`good` direction set), sparkline.
4. **Visual comparisons, at least three**: a trend over time (`TrendChart`), a comparison across groups (`BarList`,
   `DonutChart`, `Heatmap`, or a table with in-cell bars), and a before/after or this-vs-previous comparison. Say what the
   chart means in its subtitle.
5. **Needs your attention**: the exceptions (`InsightList`) with severity, the number, where to look and an *Explain* button
   (`ask:` question for the assistant). Computed in the domain's `insights()`.
6. **Ask AI** on every card (`AskAiButton`), `ProvenanceButton` ("how is this calculated?") on every figure.
7. `usePublishAssistantContext(...)` with the page id, title, filters and headline numbers, so the assistant knows what
   the MD is looking at.
8. Empty / error / loading states (`kit/states`), small screens (container queries: `@3xl:` / `@5xl:`, never `lg:`), the
   assistant panel open beside it (444 px).

### 10.4 Backend contract for a new domain (`units`, `geo`, `punches`, `reportlog`, `shifts`, `leave`, `requests`)

Follow section 3 exactly (it is the same kind of module): `analytics/<domain>.py` (pure read-only functions taking
`Scope`/`Period`, every figure with `provenance`, aggregated in the database, scope always applied, no query per row),
`routes/<domain>.py` (thin `@md_get` views; the stub already exists and is already mounted at `/api/md/<domain>/`),
`TOOLS` (4-8 tools for the assistant; the domain is already in `assistant/registry.TOOL_MODULES`), `insights()` (at most 5
company-wide exceptions) and `headline()` (1-3 KPIs), `tests_md_<domain>.py` (exact numbers, empty database, scope and
period edges, query budget, the tools). **No file outside your domain may be edited** except where §10.6 says.
Run tests with `DB_TEST_NAME=test_uktex_<domain> python manage.py test api.tests_md_<domain> --noinput` after verifying
`DB_HOST=localhost` in `backend/.env` (read only that line; never print credentials).

### 10.5 Gates (ratchets: only tighten)

* Backend: `ruff format` + `ruff check` clean on every file you add; your tests pass; `tests_md_tools_contract` and
  `tests_md_identity` still pass (they walk every route and tool).
* Frontend: `npx tsc -p tsconfig.json --noEmit` clean; **ESLint adds zero warnings** (`npm run lint` is at its 83 ceiling);
  `npx prettier --write` on your files (`src/pages/md`, `src/components/md`, `src/lib/md` are format-enforced); vitest
  tests for your components (fixtures in your folder; assert what the MD sees, not implementation) and your pure logic.
* **Do not run Playwright, the QA stack, `e2e_setup.py`, `seed_md_demo` against the shared databases, or start servers**:
  they share ports and the `uktex_e2e` database, so parallel runs corrupt each other. The integrator runs the browser
  checks and screenshots and sends findings back.
* Never leave a QA MD account in a database; the user's dev servers (:8000/:5173) are theirs: do not touch them.

### 10.6 Files with one owner

`pages.py`, `md-nav.ts`, `urls.py`, `assistant/registry.py`, `assistant/suggestions.ts`, `analytics/dashboard.py` (its
`SOURCES`), `analytics/brief.py`, `common.py`, `permission_registry.py`, `lib/md/embed.ts`, `components/md/embedded/*`,
`components/md/MdLayout.tsx`, `kit/*` (existing components), `backend/.format-enforced`, `seed_md_demo.py`: the integrator.
Ask (in your final report) for a change there; do not make it. New generic kit components are allowed under
`components/md/kit/` only with a name that cannot clash (prefix with your domain) and a test.

### 10.7 Where things are checked

`e2e/md-hr-pages.spec.ts` opens every copy and fails on any refused API call (a 403 means `MD_HR_GRANTS` lacks a module the
page reads); `e2e/md-insights.spec.ts` checks the Insights tabs; `tests_md_hr_access.py` pins the access;
`lib/md/embed.test.ts` the address mapping; `md-nav.test.ts` the page list.

## 11. The skin: wine, indigo and sand (2026-10-10)

The MD portal has its own colours; **the HR portal, the login pages and the employee app keep theirs.** The product owner's
palette: **Wine red #7F011F**, **Midnight indigo #282B4A**, and three light backgrounds **Light sand #F5EBD0**, **Vanilla
#EEEBDA**, **Alabaster #F3EFE7** (given as "#F3FE7", five digits; #F3EFE7 is the reading used, one variable to change:
`--md-alabaster`). Backgrounds use the three light colours; wine and indigo are for everything else (text, icons, buttons,
borders, charts, the dark hero). Everything below lives in `frontend/src/md-theme/`.

### 11.1 How it is scoped (read this before touching a colour)

* `MdLayout` calls `useMdTheme()` (`lib/md/theme.ts`), which puts **`data-md-theme` on `<html>`** while an MD page is
  mounted. It is on `<html>`, not on the page root, because dialogs, menus, toasts and tooltips render in a portal under
  `<body>`. It is removed when the MD leaves the portal.
* Every rule that **changes how an existing thing looks** is scoped to `html[data-md-theme]`: `base.css`
  (shadcn tokens `--background`, `--primary` ..., page background), `tailwind-remap.css` (Tailwind's own `blue`, `slate`,
  `teal`, `green`, `red`, `amber` ... colour families are re-pointed at the palette ramps, so `text-blue-700` or
  `bg-slate-50` inside an embedded HR page takes the new colours with no edit to that page), `hr-copies.css` (the shared
  `.clay-*` classes and the shared components that the HR pages use), and the `[data-slot="button"]` part of `glass.css`.
  `md-theme.test.ts` fails if a selector in those files is not scoped. **Do not edit an HR page to change how it looks in
  the MD portal; add a scoped rule to `hr-copies.css`.**
* New classes for MD code (`.md-card`, `.md-btn` ...) and the palette variables (`tokens.css`) are not scoped: nothing
  outside MD code uses them.

### 11.2 Vocabulary

| | |
| --- | --- |
| Palette variables | `--md-wine`, `--md-indigo`, `--md-sand`, `--md-vanilla`, `--md-alabaster`; ramps `--md-wine-50..950`, `--md-ink-50..950` (ink = indigo), `--md-n-*` (warm neutrals), `--md-info-*` (periwinkle), `--md-sky-*`, `--md-rose-*`, `--md-sage-*`, `--md-success-*`, `--md-warning-*` (ochre), `--md-danger-*` (crimson), `--md-clay-*`, `--md-mauve-*` |
| Tailwind utilities | `text-md-wine`, `bg-md-ink/10`, `border-md-line`, `from-md-wine-500`, `text-md-ink-soft`, `bg-md-sand`, `bg-md-warning-100`, `text-md-success`, `border-md-n-200` ... (any ramp shade 50-900 and the five colours; opacity works) |
| Roles | text `text-md-ink` (11.9:1 on the backgrounds), secondary text `text-md-ink-soft` (6.4:1) or `text-md-ink-600`; never ink-400 for text. Brand / links / key figures / active states `text-md-wine`, `bg-md-wine`. Hairlines `border-md-line`. Good `md-success`, watch `md-warning`, bad `md-danger` (a brighter red than the wine, on purpose), information `md-info`. |
| Glass classes | `.md-card` (a surface: translucent white, blur, light edge, soft indigo shadow; `.md-card-strong` more opaque), `.md-panel` / `.md-panel-sand` / `.md-panel-wine` (quiet inner surfaces, no blur), `.md-hero` (the dark indigo statement card with a wine glow), `.md-btn` + `.md-btn-primary` (wine glass) / `-ink` (indigo glass) / `-soft` (frosted white) / `-ghost` / `-danger` and sizes `-sm`, `-lg`, `-icon`, `.md-chip` (+ `-wine`, `-ink`, `-sand`, `-success`, `-warning`, `-danger`), `.md-seg` + `.md-seg-item` (segmented switch, chosen item = wine glass), `.md-field` (text field), `.md-icon-tile` (+ `-ink`, `-solid`), `.md-app-bg` (the page background) |
| Shared Button | `components/ui/button.tsx` carries `data-slot="button"` and `data-variant`; in the MD portal `default` is wine glass, `outline` frosted white, `secondary` sand glass, `destructive` crimson glass, `ghost` clear until hovered, `link` wine text (`glass.css`) |
| Charts | colours come from `MD_CHART` (`lib/md/theme.ts`) / `CHART` (`kit/chartTheme.ts`): wine, indigo, dusty rose, ochre, sage, periwinkle ... Never a hex in a chart file |
| JS constants | `MD_PALETTE`, `MD_CHART` in `lib/md/theme.ts`; `md-theme.test.ts` keeps them equal to `tokens.css` |

### 11.3 Rules for MD-owned code

1. **No hard-coded colours** (`#...`, `rgb(...)` of the old blue/gold) in `components/md`, `pages/md`, `lib/md`: use the
   vocabulary. `md-theme/no-hard-coded-colours.test.ts` counts lines with a hex and may only go down (goal: 0). White is
   `white` / `#fff`.
2. **Surfaces are glass, controls are glass.** A card is `md-card`; do not stack blur inside blur (inside a card use
   `md-panel` or a plain tint). Every `<button>` is an `md-btn` (or the shared `Button`) or an `md-chip` / `md-seg-item`;
   no flat, unstyled, or old gold-gradient buttons. Icon-only buttons get `md-btn md-btn-ghost md-btn-icon` and an `aria-label`.
3. **Backgrounds are the three light colours** (page: `md-app-bg`; panels: sand / vanilla / alabaster tints). Dark surfaces
   are midnight indigo (`md-hero`, the sidebar's active detail). Wine is the accent, not a background.
4. **Contrast**: body text `text-md-ink` or `text-md-ink-soft` on light glass; white or sand on wine and indigo; verify any
   new pairing is at least 4.5:1 (3:1 for large text and icons).
5. **Motion**: transitions 150-250 ms, hover lift at most 2 px, nothing that moves without `motion-safe:`; reduced motion
   is already handled in `glass.css`.
6. **Mobile (390 px)**: glass cards stack, nothing overflows sideways, tap targets at least 36 px.
7. The AI character (the radio, section 6) stays as it is; around it, the launcher bubble and the panel use the palette.
8. Status colours keep their meaning (sage good, ochre watch, crimson bad); never use wine for "bad".

### 11.4 Who edits what

`md-theme/tokens.css`, `tailwind-remap.css`, `base.css`, `glass.css`: the integrator (add a class to `glass.css` only through
the integrator). `md-theme/hr-copies.css` and `components/ui/*` (additive `data-slot` markers only): the HR-copies skin
owner. Pages and components: whoever owns the folder (section 10.6).

### 11.5 Type (2026-10-10)

| | |
| --- | --- |
| **Whole Chomp** | the **title of each page** (Employees, Manage Branch, Staff Attendance, Payroll Analysis, Add New Employee ...): `[data-md-title]` (the heading of an embedded HR page: `embedded/headerRow.ts` marks it, and `embedded/titleMark.ts` marks the first heading of a page that has no title row, such as a form or a record) and `[data-testid="md-page-title"]` (`kit/MdPageHeader`). |
| The dashboard | keeps **all its headings** in Whole Chomp (the greeting and the card headings): the rule is under `[data-testid="md-dashboard-page"]`. The owner asked for the dashboard's fonts to stay as they were. |
| Everything else | the previous fonts (Hanken Grotesk, then Inter): card and section headings on other pages, dialogs, the sidebar (the "UK Textiles" brand), the AI assistant, figures. |
| Times New Roman | **not used anywhere.** It was applied to Reports and to money / key figures and then withdrawn by the owner ("for everything else, restore the previous fonts"). To bring it back, add a `font-family` rule where the owner names. |
| Scope | the MD portal only: the rules are under `html[data-md-theme]` (`md-theme/typography.css`). |

* **The font file is the free 1001Fonts cut and draws only the 52 letters A-Z / a-z.** Its digits, punctuation, brackets, accented
  letters and the rupee sign are empty glyphs (they take room and draw nothing; `fontTools` shows `bounds None`). So the
  `@font-face` is limited with `unicode-range: U+0041-005A, U+0061-007A` and declared for weights 100-900 (no faked bold):
  everything else in a title is drawn by Hanken Grotesk at the title's own weight. If a full version of the font is bought,
  widen the range (or remove it) and check the digits.
* **Licence:** `frontend/public/fonts/1001fonts-whole-chomp-eula.txt` says "free for personal use": business use (websites, apps
  for companies) needs written permission or a paid licence from the author (Decograph Studio). The files were supplied by the
  product owner; settle the licence before production. The font is not modified (the EULA forbids it); it is served as supplied.
* **Rules for MD code:** a page's title is a real `h1` / `h2` and needs nothing else; do not set `font-family` in components.

### 11.6 The title row of the seven tall pages (2026-10-10)

The owner reported the header alignment as wrong on Employees, Staff Attendance, Production Attendance, Outpass, Visitors,
Manage Shifts and Requests, and asked for those pages only to be made uniform. Their own title rows are tall (a subtitle, a
sub-tab strip, a group of buttons), so with the switch and the stack slotted into a flowing row the switch landed at a
different x on each page and the stack at a different y.

```
[ Title (Live) ] ........................... [ Operations | Insights & AI ]  |  Updated 10:31:22 am
[ what the page is for ] ..........................................................  |  Refresh
[ the page's own tabs / strip ] ......... [ the page's own buttons, right edge = the stack's ]
```

* **Opt-in, by page id:** `GRID_HEADER_PAGES` in `embedded/MdEmbeddedFrame.tsx` -> `useHeaderAdoption(root, grid)` ->
  `adoptHeaderRow(root, { grid: true })`. Adding a page to that set is the whole change for a new page; every other page
  is untouched.
* **DOM side (`embedded/headerRow.ts`):** only markers are added, nothing of the page is restyled by script: `data-md-aligned`
  (the row is one of the seven, wide or narrow), `data-md-grid` (wide: 720px of content or more, the row is a grid and the stack
  is a cell of it, not pinned), `data-md-titleblock` (the block holding the heading, subtitle and strip; not set when the
  block is the heading itself) and `data-md-actions` (every other child of the row: the page's buttons). The grid is not used
  when the heading is nested deeper than the title block's first level (the block cannot be dissolved into the grid).
* **CSS side (`md-theme/areas/shell.css`, "the title row of the embedded HR pages laid out as a grid"):** columns
  `auto minmax(0,1fr) auto auto`; the title block is `display: contents` so the heading, subtitle and strip are cells; the
  title and the switch and the stack are in row 1 (so they share a centre line whatever the subtitle is), the subtitle in row 2
  (max 52rem), the strip and the buttons in row 3. A page's own icon before its title (Outpass, Visitors, Requests) is hidden
  so all seven titles start at the same x. Narrow (below 720px) the row flows as on every page, and the page's buttons wrap
  instead of running off a phone.
* **Title decorations keep the previous font:** a Live chip or a "26 pending" badge inside a title is set in Hanken Grotesk
  (`typography.css`), not in Whole Chomp.
* Checked by `headerRow.test.ts` ("the grid layout") and e2e `md-hr-pages.spec.ts` ("the seven pages with a tall title row
  line up alike": same title x, same title / switch / stack centre lines relative to the row, buttons ending on the stack's
  right edge, no icon before the title).

# Session Turnaround Dashboard

Demandii's view of every content session from brainstorm to Planable, grouped by studio and client, with RED / AMBER / CLIENT LATE flags.

**The Google Sheet is the source of truth.** All the rules (the 5-day promise, when a session turns RED or AMBER, the 48-hour client target) live in the sheet's formulas and its Settings tab. This app only shows what the sheet says and writes today's date when a producer clicks a button. To change a rule, change the sheet, not the code.

Tracker sheet: https://docs.google.com/spreadsheets/d/1ytC6cHvDoIiLy_hI3RC5SwEYdr_nRFLuTPKdb-SIDW8/edit

## What producers can do

| Button | Writes to the Sessions tab |
|---|---|
| Brainstorm done | Brainstorm complete = today |
| Mark recorded | Recorded = the date picked (today by default, up to 14 days back). The 5-day clock starts here |
| Mark sent | Sent to client = today (stops the 5-day clock) |
| Nudge client | Nudge requested = today (Zapier picks this up for GHL) |
| Client approved | Client responded + Approved = today |
| Client wants rework | Client responded = today, decision = Rework |
| Rework returned | Rework returned = today |
| Mark scheduled | Scheduled in Planable = today |
| + Add client (Ops, CP Trainer) | Adds a row to the Clients tab: name, studio, contacts, approver email. An existing client gets the extra studio |
| + Log session | Adds a new row: client, then studio (asked only when the client has two), then producer (defaults to you), then session name, then recording date (today by default) or "not recorded yet" |

Before writing, the server re-reads the row and checks the client, session and current stage still match, so an out-of-date screen can't write to the wrong session. To fix a mistaken click, edit the date in the sheet.

## One-time setup

You need three things: a Google service account (so the app can read and write the sheet), a Google sign-in client (so people log in with their demandii.com account), and the Render service.

### 1. Service account (app's access to the sheet)

1. Go to https://console.cloud.google.com and create a project, e.g. "Session Turnaround".
2. **APIs & Services → Library** → search "Google Sheets API" → **Enable**.
3. **APIs & Services → Credentials → Create credentials → Service account.** Name it `session-turnaround`. Skip the optional role steps.
4. Open the new service account → **Keys → Add key → Create new key → JSON.** A file downloads. Keep it private; never commit it.
5. Copy the service account's email (ends in `iam.gserviceaccount.com`). Open the tracker sheet → **Share** → paste that email → **Editor** → uncheck "Notify" → Share.

### 2. Google sign-in client

1. Same project → **APIs & Services → OAuth consent screen.** User type **Internal** (only demandii.com accounts). App name "Session Turnaround". Save.
2. **Credentials → Create credentials → OAuth client ID → Web application.**
3. Authorized redirect URI: `https://<your-render-url>/auth/callback` (fill in after step 3 below, then come back and add it).
4. Copy the **Client ID** and **Client secret**.

### 3. Render

1. In Render: **New → Blueprint** → pick this GitHub repo. Render reads `render.yaml`.
2. It will ask for the values marked `sync: false`:
   - `BASE_URL`: the service URL Render gives you, e.g. `https://session-turnaround.onrender.com` (no trailing slash)
   - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`: from step 2
   - `GOOGLE_SERVICE_ACCOUNT_JSON`: open the downloaded JSON key file and paste its entire contents
3. Deploy. Then add `https://<your-render-url>/auth/callback` to the OAuth client's redirect URIs (step 2.3).

The free plan sleeps after a period of no traffic, so the first visit after that takes about a minute to load. A paid instance stays awake.

## Run it locally

```
npm install
npm run dev
```

Opens on http://localhost:3000 with the sample data in `fixtures/mock.json` and sign-in skipped. Nothing is written to the real sheet in this mode.

## Sheet structure the app expects

- **Sessions** tab, row 1 headers by name (columns can be moved): Client, Studio, Producer, Session, Brainstorm complete, Recorded, Sent to client, Client responded, Client decision, Rework returned, Approved, Scheduled in Planable, Stage, Internal days (recorded to sent), Client wait days, Rework overdue, Days recorded to approval, Past 5-day promise (recorded to sent), Flag, Notes, Nudge requested, Last updated by.
- Formula columns are filled down to row 300. When the sheet gets close to that, copy the formulas further down and raise `LAST_FORMULA_ROW` in `lib/sheet.js`.
- **Clients** tab: Client, Studio, Contacts, Approver email. One row per studio the client works with.
- **Studios** tab: the list of studios. Producers work across studios, so each session picks both its studio and its producer on the Sessions tab.
- **Team** tab: Name, Google email, Role (Producer, CP Trainer or Ops). A Google email listed here identifies the person automatically; anyone at the domain who isn't listed can sign in as a viewer.

## Who sees what

| Who | After sign-in | Sees | Can update |
|---|---|---|---|
| Producer | Picks the studio they're in at every sign-in ("Switch" to change it) | Board opens on that studio; "My sessions" narrows to their own | Yes |
| CP Trainer (Tamika), Ops | Nothing to pick | Every studio, plus the Analytics view | Yes |
| Anyone else @demandii.com | Chooses "Just viewing" | Analytics view (by studio, by producer, clients affected), plus a read-only board | No |

The server enforces this: view-only users get no buttons, and any write they attempt is refused.
- Sessions column **Last updated by** records who clicked each button and when.
- **Settings** tab rows 2 to 6: promise days, RED day, AMBER day, client target days, rework days.

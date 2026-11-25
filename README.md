# Time clock

A personal time clock with daily task planning, a daily clock-out time and
editable session history. Plain HTML, CSS and JavaScript, one Cloudflare Worker
and one D1 database.

The phased plan and implementation status are in [PLAN.md](PLAN.md).

## Run locally

Use Node.js 22.13 or newer.

```sh
npm install
npm run dev
```

Open http://localhost:8787. The command applies migrations to local D1 before
starting the app. Local records persist in `.wrangler/state` between restarts.
Local development works without a Cloudflare account or login.

```sh
npm test
npm run check
npm run build
```

The tests exercise the Worker API against SQLite, including transactions,
constraints, expiry, retries, concurrent starts and history corrections.
The build command checks the Cloudflare bundle without deploying it.

## Using the app

- Choose the large **Start work** button on the timer card to begin immediately.
  Type the description directly on the timer card. It saves automatically after
  a half-second pause and when you leave the field. A status shows when the text
  is saving or saved. Failed saves retain the text and retry automatically.
- Enter a description and choose **Add task** to plan work for later.
- **Start task** begins work using the description entered in the task form.
- Planned start times are reminders. Press **Start** to begin tracking a task.
- Starting another task stops the current one. **Stop timer** ends work manually.
- Choose **Continue** on a finished session to pick up the same work from now.
  Each continuation records a new interval with the saved description. Pauses
  stay outside worked totals. Continuing from history opens today's view and
  uses today's clock-out time.
- Choose **Clock out** for the selected day and press **Save**. It applies across
  that day's task sessions. Each new day starts with no clock-out time.
- Use the date picker to review another day. **Edit** corrects task details or
  recorded session descriptions and timestamps.
- **This week** shows Monday–Sunday totals and a daily breakdown in Auckland
  time, including your running timer. Click a day to view its records.
- Removing or renaming a planned task preserves recorded session descriptions.

Times are shown in `Pacific/Auckland` and stored as UTC timestamps. A session
belongs to the work date on which it starts, including work that crosses midnight.
For the repeated hour when daylight saving ends, an entered time uses the first
occurrence.

Automatic clock-out uses the saved deadline. The browser caps elapsed time at
that deadline and the next API request writes it as the finish time. Closing
the app therefore does not extend recorded work. A passed deadline must be changed
or cleared before starting again.

The app requires a connection to its server to load or save data. Failed saves
retain your form input. Retrying a task or session creation reuses its request ID
if the response was lost, preventing duplicate records. Focus changes and a
30-second refresh update work from another device.

## Cloudflare setup later

Phases 1 and 2 are implemented for local use. The database ID in `wrangler.jsonc`
is a local-development placeholder. Production database provisioning, domain setup
and Cloudflare Access login are deferred.

# Personal time clock plan

Updated 25 November 2026.

Build a simple personal time clock with one-click tracking, daily task planning
and a chosen clock-out time. Target hosting cost is $0 within Cloudflare's free
allowances.

## Stack and defaults

- Plain HTML, CSS and JavaScript.
- One Cloudflare Worker serves the frontend and API.
- One D1 database stores days, tasks and sessions.
- One user, with an online browser app that works on desktop and mobile.
- Display times in `Pacific/Auckland` and store UTC timestamps.
- Sessions belong to the work date on which they start.
- Each day begins with an optional, blank clock-out time.

## Phase 1 — Timer

Completed locally.

- [x] Set up Wrangler, local D1 and migrations.
- [x] Put a prominent **Start work** button in the timer card.
- [x] Start immediately with an optional description.
- [x] Edit the description inline with autosave after a half-second pause.
- [x] Retain pending text and retry failed autosaves.
- [x] Stop manually and switch tasks.
- [x] Enforce one active session across devices.
- [x] Calculate elapsed time from saved timestamps.
- [x] Show the daily total, including the running timer.
- [x] Choose and change the clock-out time for each day.
- [x] Finalize expired sessions at their saved deadline on the next API request.
- [x] Finalize expiry before changing a deadline.

## Phase 2 — Planning and history

Completed locally.

- [x] Add, edit and remove tasks in a daily list.
- [x] Give tasks optional planned start times that act as reminders.
- [x] Start planned work on demand using the actual start time.
- [x] Record multiple sessions for the same task.
- [x] Review previous days using the date picker.
- [x] Correct recorded descriptions, start times and finish times.
- [x] Preserve recorded descriptions when planned tasks are renamed or removed.
- [x] Continue finished work in a new interval from now.
- [x] Carry the saved description into continued work, including unnamed work.
- [x] Keep pauses outside worked totals.
- [x] Show this week's total and daily Monday–Sunday breakdown in Auckland time.
- [x] Include the running timer in weekly hours.
- [x] Open a day's records by clicking its weekly summary.

## Phase 3 — Cloudflare login and deployment

Deferred at your request.

- [ ] Create the production D1 database.
- [ ] Replace the local database ID placeholder and apply migrations.
- [ ] Deploy the Worker on a subdomain of your existing domain.
- [ ] Configure Cloudflare Access email-code login.
- [ ] Restrict access to your email address.
- [ ] Protect the frontend and API through every public hostname, including
      default and preview hostnames.
- [ ] Verify login and shared saved data on desktop and phone browsers.

## Verification

The current implementation passes 40 automated tests, syntax checks and the
Worker build. Browser checks cover desktop and mobile layouts, starting,
switching, stopping, continuation, autosave, retry recovery and live weekly totals.

Local development commands and usage are in [README.md](README.md).

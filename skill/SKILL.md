---
name: meta-scheduler
description: Schedule Instagram + Facebook Page carousel posts AND Reels (video posts) to Meta Business Suite via the local meta-scheduler tool (Playwright-based). Use when the user wants to schedule one or many image carousels OR video Reels ("schedule a post to IG/FB", "queue 30 carousels", "schedule a Reel", "post this video", "post to Meta Business Suite", "set up daily posts"). Auto-detects post type from the input folder: folder of images → carousel; folder with one .mp4/.mov → Reel. Multi-account — supports separate Meta accounts via per-account configs. Cross-posts to both Facebook Page and linked Instagram by default. Does NOT use the Meta Graph API.
---

# meta-scheduler

> Made by [Antonio Automates](https://antonioautomates.com) and Claude to help you get your time back.

This skill drives the local **meta-scheduler** tool (a Playwright-based Node.js project) to schedule carousel posts AND video Reels to Meta Business Suite. The tool itself lives outside the skill — typically at `~/meta-scheduler/` (the install script's default).

**Post type is auto-detected from the input folder contents:**
- folder of `.png`/`.jpg` → carousel (multi-slide post; uploaded one-at-a-time to preserve order)
- folder with one `.mp4`/`.mov`/`.m4v`/`.webm` → Reel (single-video post via Meta's Reels composer)
- mixed → rejected with an error

## When to invoke

Trigger when the user asks for any of:

- "Schedule this carousel for Sunday at 9am to my Antonio Automates account"
- "Queue 28 daily posts starting tomorrow"
- "Post these 5 images + caption to IG and FB Page on May 15"
- "Schedule this Reel for tomorrow"
- "Post this video to my Page on Friday"
- "Set up the next 30 days of carousel posts"
- "Add a new client account and schedule their first post"

Do **not** invoke for:

- One-off comments / replies
- Stories (the composer flow differs; Reels ARE supported)
- Account / page management (creating Pages, changing roles)
- Anything Meta Graph API specific (the tool deliberately avoids the API to skip business verification)

## Prerequisites the user must have done

1. **Tool installed somewhere:** `git clone <meta-scheduler-repo>` (or unzip), `cd meta-scheduler`, `npm install`, `npx playwright install chromium`.
2. **Account config created:** `accounts/<account-name>.json` exists, copied from `accounts/example.json`. The `pageName` field must exactly match the Page label as shown in Meta's "Post to" picker.
3. **One-time login completed:** `node schedule-post.js --account <account-name> --setup` has been run, the user logged into Meta, and the Chromium window was closed.

If any of those is missing, walk the user through it before scheduling. Do not attempt to log them in on their behalf.

## Inputs you'll need from the user

For each post:

- **Account name** — which `accounts/<name>.json` to use. If the user has only one account configured, default to that. Otherwise ask which.
- **Asset location** — either a Day-NN convention (`--day 03`) which resolves through `imagesSubpath` / `captionSubpath` in the account config, OR explicit `--images <dir> --caption <file>` paths.
- **Datetime** — `YYYY-MM-DD HH:MM` in the user's local time. Validate it's between 20 minutes and 29 days from now.

For batches: a range (`--from N --to M --start-date YYYY-MM-DD --time HH:MM`) for sequential daily posts, or a JSON plan for arbitrary timing.

## How to drive the tool

All commands are run from the project's root (the meta-scheduler folder).

### Single post

```
node schedule-post.js --account <name> --day NN --datetime "YYYY-MM-DD HH:MM"
```

Add `--dry-run` first if you want to verify before clicking Schedule. Dry-run leaves the browser open for inspection.

### Batch — sequential daily

```
node batch-schedule.js --account <name> \
  --from 1 --to 28 --start-date 2026-05-10 --time 09:00 \
  --between-runs-secs 8 --retries 1
```

The batcher writes state to `state/<name>.batch-state.json`. To recover from interruptions: re-run with `--resume` (skips completed) or `--retry-failed` (retries only failures).

### Batch — arbitrary JSON plan

```
node batch-schedule.js --account <name> --plan ./plan.json
```

Plan format:

```json
[
  { "day": "01", "datetime": "2026-05-10 09:00" },
  { "id": "launch", "images": "...", "caption": "...", "datetime": "2026-05-12 17:30" }
]
```

## What to do during a run

The scripts print a structured log with bracketed phase tags: `[plan]`, `[nav]`, `[caption]`, `[upload]`, `[schedule]`, `[done]`, `[error]`. Stream those back to the user as they happen — they're informative without being noisy.

A typical successful run takes 60–90 seconds (≈30 seconds for batch-internal pacing + ~60 seconds per post in the tool itself).

## Failure handling

Common failures and what to do:

- **"Failed to create a ProcessSingleton"** — a previous Chromium is still alive (or crashed). Kill any leftover `playwright-meta-scheduler` processes and remove `SingletonLock` in the profile dir, then retry. The script attempts this on startup but a stuck process can defeat it.
- **"Date input row N did not commit; expected ...; got ..."** — Meta's locale displayed the month name in a form the script didn't expect. Check `schedule-post.js`'s `dateReadbackCandidates` and add the variant.
- **"Could not find caption field" or other selector miss** — Meta shipped a UI change. Use the dry-run + screenshot pattern: re-run with `--dry-run`, look at `screenshots/<account>/error-*.png`, identify the new selector, update the locator in `schedule-post.js`.
- **Schedule click reports done but post isn't in Planner** — verify by opening `https://business.facebook.com/latest/planner` directly. Most often this means the date/time fell outside Meta's 20-minute / 29-day window and Meta silently rejected the schedule.

## Onboarding a new account

If the user wants to schedule for a new client/brand:

1. `cp accounts/example.json accounts/<client-name>.json`
2. Edit: set `name`, `displayName`, `pageName` (must match Meta exactly), `carouselsRoot`, asset subpath patterns.
3. `node schedule-post.js --account <client-name> --setup` and have the user log in.
4. Smoke-test with `--dry-run` on one post before any batch.

Each account gets an isolated Chromium profile under `~/Library/Application Support/playwright-meta-scheduler/<name>/`, so accounts don't share login state and you can run multiple accounts in parallel.

## What the tool does not do

- No Meta Graph API. No tokens.
- No Stories. (Reels are supported as of v1.1 — drop a single video file in a folder and the tool auto-routes through Meta's Reels composer.)
- No edit / delete of existing scheduled posts (use the Meta Planner UI).
- No cross-machine portability of profiles — each machine logs in once.

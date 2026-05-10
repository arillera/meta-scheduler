# meta-scheduler

> Made by [Antonio Automates](https://antonioautomates.com) and Claude to help you get your time back.

Schedule Instagram + Facebook Page **carousel posts** AND **Reels (video posts)** to **Meta Business Suite** without:

- Writing 30 posts by hand in the composer
- Logging into the Graph API (no business verification, no app approval, no tokens)
- Trusting that uploading 5 slides at once will preserve their order (it doesn't)

Multi-account, batchable, Node.js + Playwright. Local-only — your Meta login lives in a Chromium profile on your machine and never leaves.

---

## What it does

Drives a Playwright-managed Chromium through Meta's web composer at `https://business.facebook.com/latest/composer/` to create a scheduled post on both Instagram and the linked Facebook Page.

**Auto-detects the post type** based on what's in the folder you point it at:

- Folder contains image files (`.png`, `.jpg`) → **carousel post**.
  1. Paste caption
  2. Upload each slide one at a time (preserves order deterministically)
  3. Set date + time on both rows
  4. Click Schedule
- Folder contains a single video file (`.mp4`, `.mov`, `.m4v`, `.webm`) → **Reel post**.
  1. Paste caption
  2. Upload video → wait for Meta processing
  3. Click Share tab → click Schedule pill
  4. Set date + time on both rows
  5. Click Schedule

Use the **batch** entry point to schedule many posts in one go (range mode for daily campaigns, JSON-plan mode for arbitrary timing). State is persisted, so a partial run can resume; failed posts can be retried in isolation. Same batch logic works for carousels and Reels — each post's type is detected from its folder.

## Prerequisites

- macOS (the file-picker bypass is tested here; Linux/Windows likely work but untested)
- Node.js ≥ 18
- A Meta Business Suite account with admin access on the Page you want to post to, and a linked Instagram Business/Creator account if you're posting to IG

## Quick start

```bash
git clone <this-repo>            # or unzip the folder
cd meta-scheduler
npm install
npx playwright install chromium  # ~92 MB, one time
```

Create your account file (copy and edit):

```bash
cp accounts/example.json accounts/myaccount.json
$EDITOR accounts/myaccount.json
```

In `accounts/myaccount.json`:

- `name` — short identifier (lowercase-dashed). This becomes the profile dir + state-file name.
- `displayName` — friendly label, only used in logs.
- `pageName` — exact label that appears in Meta's "Post to" picker. Must match.
- `carouselsRoot` — path to the folder containing your post assets, relative to the project root.
- `imagesSubpath`, `captionSubpath` — patterns with `{day}` placeholder.
- `captionStartLine` — line number where the actual post copy begins (everything before is preamble).

Log in once:

```bash
node schedule-post.js --account myaccount --setup
```

A Chromium window opens. Log into Meta, confirm the correct business is active in the top-left switcher, close the window. Login persists for all future runs.

## Schedule a single post

```bash
# Carousel (folder of slides)
node schedule-post.js --account myaccount \
  --images "/abs/path/to/slides-folder" \
  --caption "/abs/path/to/caption.md" \
  --datetime "2026-05-10 09:00"

# Reel (folder with one video)
node schedule-post.js --account myaccount \
  --images "/abs/path/to/folder-with-one-mp4" \
  --caption "/abs/path/to/caption.md" \
  --datetime "2026-05-10 09:00"

# Day-NN convention from your account config
node schedule-post.js --account myaccount \
  --day 01 --datetime "2026-05-10 09:00"

# Dry-run = does everything except clicking Schedule, leaves browser open for inspection
node schedule-post.js --account myaccount \
  --day 01 --datetime "2026-05-10 09:00" --dry-run
```

The `--images` flag points at a folder. The folder's contents determine the post type:
- **All images** → carousel (multiple slides, alphabetical order)
- **One video file** → Reel
- Mixing images + videos in one folder is rejected.

The `--day NN` form resolves the folder + caption from `carouselsRoot` using `imagesSubpath` and `captionSubpath` in your account config.

## Batch — daily campaign

```bash
# Range mode: schedule 28 posts, one per day, all at 9:00 AM local.
node batch-schedule.js --account myaccount \
  --from 1 --to 28 --start-date 2026-05-10 --time 09:00

# Resume from where the last run left off (skips posts already marked completed).
node batch-schedule.js --account myaccount \
  --from 1 --to 28 --start-date 2026-05-10 --time 09:00 --resume

# Re-attempt only the posts that failed on the previous batch.
node batch-schedule.js --account myaccount \
  --from 1 --to 28 --start-date 2026-05-10 --time 09:00 --retry-failed
```

State lives at `state/<account>.batch-state.json`. Each entry has `status` (`pending` / `in_progress` / `completed` / `failed`), attempt count, and last error.

## Batch — arbitrary plan

```bash
node batch-schedule.js --account myaccount --plan ./my-plan.json
```

```json
[
  { "day": "01", "datetime": "2026-05-10 09:00" },
  { "day": "02", "datetime": "2026-05-11 09:00" },
  { "id": "ad-hoc-launch",
    "images": "/abs/path/to/launch-slides",
    "caption": "/abs/path/to/launch-caption.md",
    "captionStartLine": 5,
    "datetime": "2026-05-12 17:30" }
]
```

## Caption file format

```
# Some heading you don't want posted

## Caption (copy/paste into Instagram)

Your real caption starts on line 5 (default). Multiple paragraphs OK.

#hashtags #here #also #fine

---

## Anything below the --- separator is ignored
- [ ] Like this checklist
```

The script reads from `captionStartLine` (default 5) until the first line that's exactly `---`, then trims trailing blank lines.

## Why one slide at a time

When you call Meta's media uploader with all 5 slides at once, Meta orders them by **upload-completion** time, not by selection order. With similarly-sized PNGs, that's a race. The script uploads sequentially, waiting briefly between each, so the carousel always reads slide-1 → slide-N regardless of file size.

## How auth works (and what you give the script)

You give the script a **persistent Chromium profile dir** at `~/Library/Application Support/playwright-meta-scheduler/<account>/`. That dir holds Meta's login cookies after `--setup`. There are no API keys, no tokens stored anywhere else. Profile dirs are not portable across machines — each machine logs in once.

## Known caveats

- **Date default is unreliable.** Meta defaults the schedule date to "today" or "tomorrow" depending on time of day. Always pass `--datetime` and let the script type the date explicitly.
- **Selectors are accessibility-based** (roles + aria-labels), not CSS-class-based, so they survive most cosmetic Meta redesigns. If a label rename ships ("Upload from desktop" → "Upload from this device"), the relevant locator strings are in `schedule-post.js` and easy to grep.
- **One run at a time per account** — Chromium can't open the same profile twice. The script clears `SingletonLock` on startup to recover from prior crashes, but you cannot run two batches against the same account concurrently. (Different accounts can run in parallel, since each has its own profile dir.)

## Use as a Claude Code skill

A `skill/SKILL.md` is included so Claude Code users can install this as a skill. Drop the project folder somewhere stable (e.g. `~/code/meta-scheduler`), then symlink the skill:

```bash
mkdir -p ~/.claude/skills
ln -s ~/code/meta-scheduler/skill ~/.claude/skills/meta-scheduler
```

Now in Claude Code, asking *"schedule these 30 carousel posts to my Meta account"* will trigger the skill and Claude will guide you through the rest.

## License

MIT — see `LICENSE`.

---

Built by [Antonio Automates](https://antonioautomates.com). If this saved you hours, the rest of what we build over there probably will too.

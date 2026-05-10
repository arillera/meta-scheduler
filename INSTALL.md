# Installing meta-scheduler

> Made by [Antonio Automates](https://antonioautomates.com) and Claude to help you get your time back.

Two install paths, depending on how you want to use it.

## Path A — Standalone CLI

Use this if you want to run the tool yourself from a terminal.

```bash
git clone <repo-url> meta-scheduler   # or unzip the folder
cd meta-scheduler
npm install
npx playwright install chromium       # ~92 MB, one time
```

Create your account file:

```bash
cp accounts/example.json accounts/myaccount.json
$EDITOR accounts/myaccount.json
```

(See README.md for what each field means.)

Log in once:

```bash
node schedule-post.js --account myaccount --setup
```

A Chromium window opens. Sign into Meta, confirm the right business is active, close the window. You're done — every future run is auto-logged-in.

## Path B — Claude Code skill

Use this if you want to ask Claude Code to schedule posts for you in plain English.

1. Install the tool exactly like Path A — clone, npm install, playwright install, set up an account file. The skill is a thin layer **on top of** the working tool, not a replacement.

2. Symlink the skill so Claude Code can find it:

   ```bash
   mkdir -p ~/.claude/skills
   ln -s "$(pwd)/skill" ~/.claude/skills/meta-scheduler
   ```

   (Adjust the source path if your meta-scheduler folder is somewhere other than the current directory.)

3. Restart Claude Code. From now on, when you say things like *"schedule these 30 carousels to my Antonio Automates account"*, Claude Code will pick up the skill and drive the tool for you.

You still need to do the one-time `--setup` login yourself; Claude won't (and shouldn't) log into Meta on your behalf.

## Verifying it works

Single dry-run smoke test:

```bash
node schedule-post.js --account myaccount \
  --images /path/to/some/test/slides \
  --caption /path/to/some/test/caption.md \
  --datetime "$(date -v+1d +%Y-%m-%d) 12:00" \
  --dry-run
```

If a Chromium window opens, the composer renders, your slides appear in order, and the date/time fields show tomorrow at noon — you're good. Close the window to exit. Re-run without `--dry-run` to actually schedule.

## Updating

`git pull` (or replace the folder). Your `accounts/`, `state/`, and the Chromium profile under `~/Library/Application Support/playwright-meta-scheduler/` are not touched by updates.

## Uninstalling

```bash
rm -rf <meta-scheduler dir>
rm -rf "~/Library/Application Support/playwright-meta-scheduler"
rm ~/.claude/skills/meta-scheduler   # if you installed the skill symlink
```

That removes the tool, all profiles (which means you'll re-login on reinstall), and the skill.

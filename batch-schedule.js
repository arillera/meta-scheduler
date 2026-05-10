#!/usr/bin/env node
// meta-scheduler — Made by Antonio Automates and Claude to help you get your time back.
// MIT licensed. See LICENSE.

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadAccount } from './lib/account.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const { values } = parseArgs({
  options: {
    account:      { type: 'string', default: process.env.META_SCHEDULER_ACCOUNT || 'default' },
    plan:         { type: 'string' },
    from:         { type: 'string' },
    to:           { type: 'string' },
    'start-date': { type: 'string' },
    time:         { type: 'string', default: '09:00' },
    'interval-days': { type: 'string', default: '1' },
    'between-runs-secs': { type: 'string', default: '8' },
    retries:      { type: 'string', default: '1' },
    resume:       { type: 'boolean', default: false },
    'retry-failed': { type: 'boolean', default: false },
    'dry-run':    { type: 'boolean', default: false },
    'stop-on-fail': { type: 'boolean', default: false },
    help:         { type: 'boolean', default: false },
  },
});

if (values.help || (!values.plan && (!values.from || !values.to || !values['start-date']))) {
  console.log(`
batch-schedule.js — orchestrate multiple meta-scheduler runs

Range mode (sequential daily):
  node batch-schedule.js --account myaccount \\
    --from 1 --to 30 --start-date 2026-05-10 --time 09:00

Plan mode (arbitrary):
  node batch-schedule.js --account myaccount --plan plan.json

Plan format:
  [{"day": "01", "datetime": "2026-05-10 09:00"}, ...]
  or with explicit asset paths:
  [{"images": "...", "caption": "...", "datetime": "..."}, ...]

Flags:
  --account NAME         Account config from accounts/<NAME>.json (or set META_SCHEDULER_ACCOUNT)
  --between-runs-secs N  Pause between posts (default 8)
  --retries N            Per-post retry count on failure (default 1)
  --resume               Skip posts already marked completed in state file
  --retry-failed         Re-attempt only the posts marked failed
  --stop-on-fail         Halt the batch on first unrecoverable failure
  --dry-run              Pass --dry-run to each underlying schedule-post.js call
  --help                 Print this help
`);
  process.exit(0);
}

const account = loadAccount(values.account);
console.log(`[batch] Account: ${account.displayName}`);
console.log(`[batch] State file: ${account.stateFile}`);

if (!existsSync(dirname(account.stateFile))) mkdirSync(dirname(account.stateFile), { recursive: true });

function loadState() {
  if (!existsSync(account.stateFile)) return { runs: [] };
  return JSON.parse(readFileSync(account.stateFile, 'utf8'));
}
function saveState(s) {
  writeFileSync(account.stateFile, JSON.stringify(s, null, 2));
}

function buildPlanFromRange() {
  const from = parseInt(values.from, 10);
  const to = parseInt(values.to, 10);
  const intervalDays = parseInt(values['interval-days'], 10);
  const [Y, M, D] = values['start-date'].split('-').map(Number);
  const start = new Date(Y, M - 1, D);
  const out = [];
  for (let i = 0; i <= (to - from); i++) {
    const day = String(from + i).padStart(2, '0');
    const date = new Date(start);
    date.setDate(start.getDate() + i * intervalDays);
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    out.push({ id: `day-${day}`, day, datetime: `${yyyy}-${mm}-${dd} ${values.time}` });
  }
  return out;
}

function loadPlanFromFile() {
  const raw = JSON.parse(readFileSync(values.plan, 'utf8'));
  return raw.map((entry, idx) => ({
    id: entry.id || (entry.day ? `day-${String(entry.day).padStart(2, '0')}` : `entry-${idx + 1}`),
    ...entry,
  }));
}

function runOne(entry) {
  return new Promise((resolveP) => {
    const args = ['schedule-post.js'];
    if (entry.day) {
      args.push('--day', String(entry.day));
    } else {
      args.push('--images', entry.images, '--caption', entry.caption);
      if (entry.captionStartLine) args.push('--caption-start-line', String(entry.captionStartLine));
    }
    args.push('--datetime', entry.datetime);
    args.push('--page', account.pageName);
    if (values['dry-run']) args.push('--dry-run');

    const child = spawn('node', args, {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, META_SCHEDULER_ACCOUNT: account.name },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); process.stdout.write(`  [${entry.id}] ${d}`); });
    child.stderr.on('data', (d) => { stderr += d.toString(); process.stderr.write(`  [${entry.id}] ${d}`); });
    child.on('close', (code) => resolveP({ code, stdout, stderr }));
  });
}

async function killStaleProfile() {
  // The profile may have a stale SingletonLock from a prior crash.
  return new Promise((resolveP) => {
    const lockFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
    for (const f of lockFiles) {
      const p = join(account.profileDir, f);
      try { if (existsSync(p)) require('node:fs').unlinkSync(p); } catch {}
    }
    resolveP();
  });
}

function findRun(state, id) {
  return state.runs.find((r) => r.id === id);
}

async function main() {
  const plan = values.plan ? loadPlanFromFile() : buildPlanFromRange();
  console.log(`[batch] Plan has ${plan.length} entries.`);

  let state = loadState();
  // Ensure state has entries for every plan id
  for (const e of plan) {
    if (!findRun(state, e.id)) state.runs.push({ id: e.id, status: 'pending', attempts: 0, datetime: e.datetime });
  }
  saveState(state);

  const retries = parseInt(values.retries, 10);
  const pauseSecs = parseInt(values['between-runs-secs'], 10);

  let okCount = 0, failCount = 0, skipCount = 0;
  for (const entry of plan) {
    const rec = findRun(state, entry.id);
    if (values.resume && rec.status === 'completed') {
      console.log(`[batch] ${entry.id}: already completed, skipping.`);
      skipCount++;
      continue;
    }
    if (values['retry-failed'] && rec.status !== 'failed') {
      console.log(`[batch] ${entry.id}: not failed, skipping (retry-failed mode).`);
      skipCount++;
      continue;
    }

    console.log(`\n[batch] ${entry.id}: scheduling for ${entry.datetime}`);
    let attempt = 0;
    let success = false;
    let lastErr = null;
    while (attempt <= retries) {
      attempt++;
      rec.attempts = (rec.attempts || 0) + 1;
      rec.status = 'in_progress';
      rec.lastAttemptAt = new Date().toISOString();
      saveState(state);

      await killStaleProfile();
      const result = await runOne(entry);
      if (result.code === 0) {
        rec.status = 'completed';
        rec.completedAt = new Date().toISOString();
        success = true;
        saveState(state);
        console.log(`[batch] ${entry.id}: ✓ scheduled`);
        break;
      }
      lastErr = `exit ${result.code}`;
      console.log(`[batch] ${entry.id}: attempt ${attempt} failed (${lastErr})`);
      if (attempt <= retries) {
        await new Promise((r) => setTimeout(r, 4000));
      }
    }
    if (success) {
      okCount++;
    } else {
      rec.status = 'failed';
      rec.lastError = lastErr;
      saveState(state);
      failCount++;
      if (values['stop-on-fail']) {
        console.error(`[batch] HALT: ${entry.id} failed after ${retries + 1} attempts.`);
        break;
      }
    }

    await new Promise((r) => setTimeout(r, pauseSecs * 1000));
  }

  console.log(`\n[batch] DONE. ok=${okCount} failed=${failCount} skipped=${skipCount}`);
  console.log(`[batch] State: ${account.stateFile}`);
  process.exit(failCount === 0 ? 0 : 2);
}

main().catch((e) => { console.error(e); process.exit(1); });

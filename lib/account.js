// meta-scheduler — Made by Antonio Automates and Claude to help you get your time back.
// MIT licensed. See LICENSE.

import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

export function expandHome(p) {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}

export function loadAccount(accountName) {
  const path = join(projectRoot, 'accounts', `${accountName}.json`);
  if (!existsSync(path)) {
    throw new Error(`Account "${accountName}" not found at ${path}. Create it under accounts/ to onboard a new client.`);
  }
  const cfg = JSON.parse(readFileSync(path, 'utf8'));
  cfg.profileDir = expandHome(`~/Library/Application Support/playwright-meta-scheduler/${cfg.name}`);
  cfg.carouselsRoot = resolve(projectRoot, cfg.carouselsRoot);
  cfg.stateFile = join(projectRoot, 'state', `${cfg.name}.batch-state.json`);
  cfg.screenshotsDir = join(projectRoot, 'screenshots', cfg.name);
  // composerUrl can be overridden per account to pin a specific business_id + asset_id
  // (Meta otherwise honors a server-side "current business" that drifts across sessions).
  if (!cfg.composerUrl) cfg.composerUrl = 'https://business.facebook.com/latest/composer/';
  if (!cfg.businessSuiteUrl) cfg.businessSuiteUrl = 'https://business.facebook.com/';
  if (!existsSync(cfg.profileDir)) mkdirSync(cfg.profileDir, { recursive: true });
  if (!existsSync(cfg.screenshotsDir)) mkdirSync(cfg.screenshotsDir, { recursive: true });
  return cfg;
}

export function dayPaths(account, dayNum) {
  const day = String(dayNum).padStart(2, '0');
  return {
    imagesDir: join(account.carouselsRoot, account.imagesSubpath.replace('{day}', day)),
    captionFile: join(account.carouselsRoot, account.captionSubpath.replace('{day}', day)),
    captionStartLine: account.captionStartLine,
  };
}

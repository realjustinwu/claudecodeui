import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Per-user workspace guard for platform deployments (wugong).
 *
 * Sessions may run anywhere the deployment allows, EXCEPT inside the
 * per-user workspace tree, where each account owns exactly one subtree:
 *
 *   <USER_ROOT>/<display-name>/...
 *
 * The email → display-name mapping lives in a JSON file maintained by the
 * deployment's onboarding scripts (add-user.sh / rename-user.sh /
 * delete-user.sh):
 *
 *   { "user@example.com": "张三", ... }
 *
 * Path is `WG_USER_DIRS` when set, otherwise `~/.cloudcli/user-dirs.json`.
 * Missing file or unparsable JSON degrades to an empty mapping — which denies
 * every path under the user tree (fail closed) while leaving all other
 * locations unaffected.
 */

const USER_ROOT = process.env.WG_USER_ROOT || '/home/agent/users';
const USER_DIRS_PATH =
  process.env.WG_USER_DIRS || path.join(homedir(), '.cloudcli', 'user-dirs.json');

type UserDirs = Record<string, string>;

let cachedMapping: UserDirs | null = null;
let cachedMtimeMs = -1;

function loadMapping(): UserDirs {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(USER_DIRS_PATH).mtimeMs;
  } catch {
    // Missing/unreadable file → empty mapping (fail closed for the user tree)
    cachedMapping = null;
    return {};
  }
  if (cachedMapping !== null && mtimeMs === cachedMtimeMs) {
    return cachedMapping;
  }
  try {
    const parsed = JSON.parse(readFileSync(USER_DIRS_PATH, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('mapping must be a JSON object');
    }
    const mapping: UserDirs = {};
    for (const [email, dir] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof dir === 'string' && dir && !dir.includes('/') && !dir.includes('\\')) {
        mapping[email] = dir;
      }
    }
    cachedMapping = mapping;
    cachedMtimeMs = mtimeMs;
    return mapping;
  } catch (error) {
    console.warn(
      `[user-dirs] failed to parse ${USER_DIRS_PATH}:`,
      error instanceof Error ? error.message : error
    );
    return {};
  }
}

/** True when `projectPath` sits inside the per-user workspace tree. */
export function isInsideUserTree(projectPath: string): boolean {
  return projectPath === USER_ROOT || projectPath.startsWith(`${USER_ROOT}/`);
}

/**
 * Whether `username` may run a session rooted at `projectPath`.
 * Non-user-tree paths are always allowed (shared service dirs, scratch space).
 */
export function isProjectPathAllowedForUser(projectPath: string, username: string): boolean {
  if (!isInsideUserTree(projectPath)) {
    return true;
  }
  const ownDir = loadMapping()[username];
  if (!ownDir) {
    return false;
  }
  const prefix = `${USER_ROOT}/${ownDir}`;
  return projectPath === prefix || projectPath.startsWith(`${prefix}/`);
}

/** The workspace dir name mapped for `username`, if onboarding registered one. */
export function userDirFor(username: string): string | null {
  return loadMapping()[username] ?? null;
}

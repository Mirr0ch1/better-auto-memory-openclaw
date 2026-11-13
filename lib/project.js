/**
 * projectKey 计算。
 *
 * 为什么需要自己算：
 *   agent_end 的 ctx **没有** activeProjectKeys（实测 —— before_prompt_build 有，
 *   agent_end 没有）。宿主在 dist/prompt-projects-*.mjs 里算过一次，
 *   但那个函数不是公开插件 API。
 *
 * 复刻宿主算法（dist/prompt-projects-*.mjs:26-52）：
 *   1. 优先用 agents.defaults.repoRoot（显式配置）
 *   2. 否则从 workspaceDir / cwd 往上找 git root
 *   3. projectKey = git remote origin 解析出的 host/path（小写 host）
 *      没有 remote 则退化成 path:<repoRoot>
 *
 * ⚠️ 注意：本机 ~/.openclaw 本身就是个 git repo 且没有 remote，
 *    所以算出来的 key 恒为 "path:/home/<user>/.openclaw"，区分度很低。
 *    这是宿主本身的行为，不是我们算错。默认 includeProjectTag=false 就是为了避开这个坑。
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const GIT_TIMEOUT_MS = 4000;

/** 从 path 往上找 .git 目录。 */
export function findGitRoot(startDir) {
  if (!startDir) return null;
  let current;
  try {
    current = fs.statSync(startDir).isDirectory() ? startDir : path.dirname(startDir);
  } catch {
    return null;
  }
  const seen = new Set();
  while (current && !seen.has(current)) {
    seen.add(current);
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/** git remote origin.url → host/path（host 小写）。 */
export function parseRemoteKey(url) {
  if (!url) return null;
  const trimmed = String(url).trim();
  if (!trimmed) return null;

  // git@github.com:owner/repo.git
  const ssh = /^[^@]+@([^:/]+)[:/](.+)$/.exec(trimmed);
  if (ssh) {
    const host = ssh[1].toLowerCase();
    const repo = ssh[2].replace(/\.git$/i, '').replace(/^\/+/, '');
    return repo.includes('/') ? `${host}/${repo}` : null;
  }
  // https://host/owner/repo.git
  const http = /^https?:\/\/([^/]+)\/(.+)$/i.exec(trimmed);
  if (http) {
    const host = http[1].toLowerCase();
    const repo = http[2].replace(/\.git$/i, '').replace(/^\/+/, '');
    return repo.includes('/') ? `${host}/${repo}` : null;
  }
  return null;
}

function gitRemoteUrl(repoRoot) {
  try {
    const out = execFileSync('git', ['-C', repoRoot, 'config', '--get', 'remote.origin.url'], {
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return String(out || '').trim();
  } catch {
    return '';
  }
}

/**
 * 计算 projectKey。
 * @param {object} cfg 完整 OpenClaw 配置
 * @param {string} workspaceDir
 * @returns {string|null}
 */
export function resolveProjectKey(cfg, workspaceDir) {
  const configured = cfg?.agents?.defaults?.repoRoot;
  if (typeof configured === 'string' && configured.trim()) {
    const resolved = path.resolve(configured.trim());
    try {
      if (fs.statSync(resolved).isDirectory()) return keyForRepo(resolved);
    } catch {
      // 忽略，走 git root 推断
    }
  }
  const root = findGitRoot(workspaceDir);
  return root ? keyForRepo(root) : null;
}

function keyForRepo(repoRoot) {
  const remote = gitRemoteUrl(repoRoot);
  const parsed = parseRemoteKey(remote);
  if (parsed) return parsed;
  return `path:${repoRoot}`;
}

/**
 * 写摘要到 <workspace>/memory/sessions/*.md
 *
 * 产物落在 memory/ 下面 ⇒ memory-core 的 watcher 会自动索引它
 * （dist/file-watcher-*.mjs 的 MemoryWatchPolicy 把 memory 列为 kind:"tree"，
 *   debounce 1500ms）⇒ 现有 embedding + memory_search + memory_get 直接可用。
 *
 * 命名：YYYY-MM-DD-<sessionSlug>.md，一个会话一个文件，每轮追加一节。
 * 目录 memory/sessions/ 与 cron 任务写的 memory/YYYY-MM-DD.md 日报分开，互不干扰。
 */

import fs from 'node:fs';
import path from 'node:path';

const SESSIONS_DIRNAME = 'sessions';

export function sessionsDir(workspaceDir) {
  return path.join(workspaceDir, 'memory', SESSIONS_DIRNAME);
}

/** 本地日期 YYYY-MM-DD。 */
export function localDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  return parts;
}

/** 本地时间 HH:MM。 */
export function localTime(now = new Date()) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now);
}

/**
 * 会话文件路径。
 * @param {string} workspaceDir
 * @param {string} sessionSlug
 * @param {Date} [now]
 */
export function sessionFile(workspaceDir, sessionSlug, now = new Date()) {
  return path.join(sessionsDir(workspaceDir), `${localDate(now)}-${sessionSlug}.md`);
}

/**
 * 追加一节摘要。
 *
 * @param {object} params
 * @param {string} params.workspaceDir
 * @param {string} params.sessionSlug
 * @param {string} params.heading 小节标题（如 "14:32 摘要"）
 * @param {string} params.body 摘要正文（markdown）
 * @param {string} params.runId 幂等标记用
 * @param {string} [params.projectTag] 已算好的 project 标注（整行追加）
 * @param {Date} [params.now]
 * @returns {{file: string, appended: boolean}}
 */
export function appendSummary({ workspaceDir, sessionSlug, heading, body, runId, projectTag, now = new Date() }) {
  const file = sessionFile(workspaceDir, sessionSlug, now);
  const marker = `<!-- run:${String(runId || '').replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 160)} -->`;

  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });

  let existing = '';
  try {
    existing = fs.readFileSync(file, 'utf8');
  } catch {
    existing = '';
  }

  // 幂等：同一 runId 已经写过就跳过
  if (marker && existing.includes(marker)) {
    return { file, appended: false };
  }

  const lines = [];
  if (!existing) {
    lines.push(`# ${localDate(now)} · ${sessionSlug}`, '');
  }
  lines.push(marker);
  lines.push(`## ${heading}`, '');
  lines.push(body.trim(), '');
  if (projectTag) lines.push(projectTag);

  fs.appendFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
  return { file, appended: true };
}

/**
 * 把 project 标注加到摘要正文里。
 * 由插件自己拼，不让模型输出 —— 写坏会导致该 chunk 永不召回。
 */
export function withProjectTag(body, projectKey) {
  if (!projectKey) return '';
  const safe = String(projectKey).replace(/[\r\n<>]/g, '');
  if (!safe) return '';
  return `<!-- project: ${safe} -->`;
}

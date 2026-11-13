/**
 * Outbox：先落盘、后压缩。
 *
 * 为什么要有这一层：
 *   - agent_end 是 observe hook，30s 超时且**超时不会取消**插件的工作；
 *     channel 路径还是 fire-and-forget（宿主不等）。
 *   - 压缩要调模型，耗时数秒。如果直接在 hook 里 await，Gateway 重启就丢了。
 *   - 所以第一段只做「把原始增量写进 outbox」（同步、原子、<10ms），
 *     第二段（调度器）再慢慢压缩。
 *   - Gateway 重启后 outbox 还在，下次继续压，不丢数据。
 *
 * 落盘位置：<workspace>/memory/.outbox/<sessionSlug>.jsonl
 *   - 在 workspace 下 ⇒ 天然按 agent 隔离（不同 agent 不同 workspace）
 *   - **必须用 .jsonl 而不是 .md**：memory-core 会递归 descend 进 memory/ 的子目录
 *     （dist/engine-storage-*.mjs:114 的 descend 只排除 .openclaw-repair），
 *     而只有 .md 会被索引（isAllowedMemoryFilePath，multimodal 默认关闭）。
 *     用 .md 的话，未压缩的原文会被 embedding，白花钱还污染检索。
 */

import fs from 'node:fs';
import path from 'node:path';

const OUTBOX_DIRNAME = '.outbox';

/** 会话 key → 安全的文件名 slug。 */
export function sessionSlug(sessionKey) {
  const raw = String(sessionKey || 'session');
  const parts = raw.split(':').filter(Boolean);
  const tail = parts.slice(-2).join('-') || 'session';
  const safe = tail.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60) || 'session';
  return safe;
}

export function outboxDir(workspaceDir) {
  return path.join(workspaceDir, 'memory', OUTBOX_DIRNAME);
}

export function outboxFile(workspaceDir, sessionKey) {
  return path.join(outboxDir(workspaceDir), `${sessionSlug(sessionKey)}.jsonl`);
}

/** 原子追加一行 JSON。 */
export function appendOutboxEntry(workspaceDir, sessionKey, entry) {
  const file = outboxFile(workspaceDir, sessionKey);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  return file;
}

/**
 * 读出待处理条目（跨该 workspace 下所有会话文件）。
 * @param {string} workspaceDir
 * @returns {Array<object>}
 */
export function readOutbox(workspaceDir) {
  const dir = outboxDir(workspaceDir);
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl'));
  } catch {
    return [];
  }

  const entries = [];
  for (const name of names) {
    const file = path.join(dir, name);
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        entries.push(parsed);
      } catch {
        // 坏行：跳过；重写文件时会被清掉
      }
    }
  }
  return entries;
}

/**
 * 更新已处理条目的重试次数（压缩失败时用）。
 * @param {string} workspaceDir
 * @param {Map<string, number>} attemptsByRunId runId → 新的尝试次数
 */
export function updateOutboxAttempts(workspaceDir, attemptsByRunId) {
  if (!attemptsByRunId || attemptsByRunId.size === 0) return;
  const dir = outboxDir(workspaceDir);
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl'));
  } catch {
    return;
  }

  for (const name of names) {
    const file = path.join(dir, name);
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const kept = [];
    let changed = false;
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        const next = attemptsByRunId.get(parsed.runId);
        if (next !== undefined && parsed.attempts !== next) {
          parsed.attempts = next;
          kept.push(JSON.stringify(parsed));
          changed = true;
          continue;
        }
      } catch {
        continue;
      }
      kept.push(trimmed);
    }
    if (!changed) continue;
    try {
      fs.writeFileSync(file, `${kept.join('\n')}\n`, { mode: 0o600 });
    } catch {
      // 写失败不影响主流程
    }
  }
}

/**
 * 删除已处理的条目（跨所有会话文件重写）。
 * @param {string} workspaceDir
 * @param {Set<string>} removeRunIds
 */
export function removeOutboxEntries(workspaceDir, removeRunIds) {
  if (!removeRunIds || removeRunIds.size === 0) return;
  const dir = outboxDir(workspaceDir);
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl'));
  } catch {
    return;
  }

  for (const name of names) {
    const file = path.join(dir, name);
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const kept = [];
    let changed = false;
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (removeRunIds.has(parsed.runId)) {
          changed = true;
          continue;
        }
      } catch {
        changed = true; // 坏行直接丢
        continue;
      }
      kept.push(trimmed);
    }
    if (!changed) continue;
    try {
      if (kept.length === 0) {
        fs.rmSync(file, { force: true });
      } else {
        fs.writeFileSync(file, `${kept.join('\n')}\n`, { mode: 0o600 });
      }
    } catch {
      // 写失败不影响主流程；下轮会重试（但 marker 幂等会挡住重复写）
    }
  }
}

/**
 * 水位线存储。
 *
 * 记的是「已经处理到哪」——结构是 { anchorKey, after }：
 *   anchorKey = 最后一条已消费的 user 消息的 idempotencyKey（稳定标识）
 *   after     = 该 user 消息**后面**还消费了多少条消息
 *
 * 为什么不能只用数组下标：compaction 会重写 session.messages
 * （实测 10 条 → 9 条，且插入 compactionSummary），下标会错位。
 * 为什么不能只用 anchorKey：assistant 的回复排在 user 消息**后面**，
 * 只记 anchor 的话下一轮会把上一轮的 assistant 回复重复计入。
 *
 * 存在 <workspace>/memory/.outbox/watermark.json（一个 workspace 一个文件，
 * 里面按 sessionKey 分组）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { outboxDir } from './outbox.js';
import { normalizeWatermark } from './messages.js';

function watermarkPath(workspaceDir) {
  return path.join(outboxDir(workspaceDir), 'watermark.json');
}

function readAll(workspaceDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(watermarkPath(workspaceDir), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 读某个会话的水位线。
 * @param {string} workspaceDir
 * @param {string} sessionKey
 * @returns {{anchorKey: string|null, after: number}}
 */
export function readWatermark(workspaceDir, sessionKey) {
  return normalizeWatermark(readAll(workspaceDir)[sessionKey]);
}

/**
 * 写某个会话的水位线。
 * @param {string} workspaceDir
 * @param {string} sessionKey
 * @param {{anchorKey: string|null, after: number}|null} watermark
 */
export function writeWatermark(workspaceDir, sessionKey, watermark) {
  const state = normalizeWatermark(watermark);
  if (!state.anchorKey) return;
  try {
    const file = watermarkPath(workspaceDir);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const all = readAll(workspaceDir);
    all[sessionKey] = state;
    fs.writeFileSync(file, JSON.stringify(all), { mode: 0o600 });
  } catch {
    // 水位线写失败不会丢数据：下一轮会重新处理同一段，
    // 靠 outbox 里的 runId marker 保证不会重复落盘。
  }
}

/**
 * 从 agent_end 的 event.messages 里提取本轮增量。
 *
 * 实测事实（2026-11-13 探针，OpenClaw 2026.11.3）：
 *   - event.messages 是**整个会话**的快照，不是本轮增量
 *   - role 有 4 种：user / assistant / toolResult / compactionSummary
 *   - user 消息带稳定的 idempotencyKey（形如 "<runId>:user"）
 *   - assistant 消息带 responseId，**没有** idempotencyKey
 *   - assistant 的 content 是数组，part 有 {type:'text'} 和 {type:'toolCall'} 两种，
 *     toolCall 没有 text
 *   - toolResult 消息的 content 数组里有 {type:'text'}，内容是完整工具输出
 *   - compactionSummary 消息没有 content 字段（只有 summary/tokensBefore/timestamp）
 *   - compaction 会让数组变短并插入 compactionSummary，但 user 的 idempotencyKey 保留
 *
 * 因此：
 *   - 水位线不能用「最后一条 user 消息」定位 —— assistant 的回复排在它**后面**，
 *     下一轮会被重复计入。所以水位线 = { anchorKey, after }：
 *     anchorKey 是最后一条已消费的 user 消息的 idempotencyKey，
 *     after 是「它后面还消费了多少条消息」。
 *   - 不能用数组下标（compaction 会重排）
 *   - toolResult 不进摘要（内容臃肿且可能含敏感信息），只抽文件路径
 *   - compactionSummary 不进摘要（它是压缩产物，重复了）
 */

/** 从 message 里取纯文本（只认 text 类 part）。 */
export function messageText(message) {
  if (!message || typeof message !== 'object') return '';
  const content = message.content ?? message.text;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      if (typeof part.text !== 'string') return '';
      return ['text', 'input_text', 'output_text'].includes(part.type) ? part.text : '';
    })
    .join('')
    .trim();
}

/** 消息里有没有可用文本（toolCall-only 的 assistant 消息没有）。 */
function hasText(message) {
  return messageText(message).length > 0;
}

/**
 * 找到锚点（最后一条已消费的 user 消息）的位置。
 * @returns {number} 索引；-1 表示没找到
 */
export function findWatermarkIndex(messages, anchorKey) {
  if (!Array.isArray(messages) || !anchorKey) return -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && typeof m === 'object' && m.idempotencyKey === anchorKey) return i;
  }
  return -1;
}

/**
 * 从 toolResult / assistant 文本里粗提文件路径，用于「涉及对象」小节。
 */
export function extractPaths(messages) {
  const found = new Set();
  const patterns = [
    // 绝对路径
    /(?<![\w/])(\/[\w.\-]+(?:\/[\w.\-]+){1,})/g,
    // 仓库内相对路径（带扩展名）
    /(?<![\w/])((?:[\w.\-]+\/){1,}[\w.\-]+\.[A-Za-z0-9]{1,8})(?![\w/])/g,
  ];
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    if (message.role !== 'toolResult' && message.role !== 'assistant') continue;
    const text = messageText(message);
    if (!text) continue;
    for (const re of patterns) {
      for (const match of text.matchAll(re)) {
        const p = match[1];
        if (!p || p.length > 200) continue;
        if (p.startsWith('/proc/') || p.startsWith('/sys/') || p.startsWith('/dev/')) continue;
        found.add(p);
        if (found.size >= 20) return [...found];
      }
    }
  }
  return [...found];
}

/**
 * 归一化水位线。
 * @param {unknown} raw
 * @returns {{anchorKey: string|null, after: number}}
 */
export function normalizeWatermark(raw) {
  if (!raw || typeof raw !== 'object') return { anchorKey: null, after: 0 };
  const anchorKey = typeof raw.anchorKey === 'string' && raw.anchorKey ? raw.anchorKey : null;
  const after = Number.isFinite(Number(raw.after)) && Number(raw.after) > 0 ? Math.floor(Number(raw.after)) : 0;
  return { anchorKey, after };
}

/**
 * 抽取本轮增量。
 *
 * @param {unknown[]} messages event.messages（整个会话）
 * @param {unknown} watermark 上次的水位线 {anchorKey, after}
 * @param {number} fallbackTail 锚点丢失时取尾部多少条
 * @returns {{items: Array<{role:string,text:string,key?:string}>, paths: string[], truncated: boolean, watermark: {anchorKey: string|null, after: number}}}
 */
export function extractDelta(messages, watermark, fallbackTail = 20) {
  const state = normalizeWatermark(watermark);
  const empty = { items: [], paths: [], truncated: false, watermark: state };
  if (!Array.isArray(messages) || messages.length === 0) return empty;

  const anchorIdx = findWatermarkIndex(messages, state.anchorKey);
  let slice;
  let truncated = false;
  if (anchorIdx >= 0) {
    // 锚点之后已经消费过 state.after 条 ⇒ 从这里继续
    const start = Math.min(anchorIdx + 1 + state.after, messages.length);
    slice = messages.slice(start);
  } else if (state.anchorKey) {
    // 锚点被 compaction 冲掉了 ⇒ 退化取尾部
    truncated = true;
    slice = messages.slice(-fallbackTail);
  } else {
    // 首轮
    slice = messages;
  }

  const items = [];
  let newAnchorKey = state.anchorKey;
  let newAnchorOffset = -1; // 新锚点在 slice 里的相对位置
  for (let i = 0; i < slice.length; i++) {
    const message = slice[i];
    if (!message || typeof message !== 'object') continue;
    const role = message.role;
    if (role === 'user') {
      if (!hasText(message)) continue;
      items.push({ role: 'user', text: messageText(message), key: message.idempotencyKey ?? null });
      if (typeof message.idempotencyKey === 'string' && message.idempotencyKey) {
        newAnchorKey = message.idempotencyKey;
        newAnchorOffset = i;
      }
    } else if (role === 'assistant') {
      if (!hasText(message)) continue;
      items.push({ role: 'assistant', text: messageText(message) });
    }
    // toolResult / compactionSummary 都不进摘要
  }

  // 新水位线：新锚点 + 它后面还有多少条
  let nextWatermark;
  if (newAnchorOffset >= 0) {
    nextWatermark = { anchorKey: newAnchorKey, after: slice.length - newAnchorOffset - 1 };
  } else {
    // 本轮没有新的 user 消息 ⇒ 锚点不动，after 累加
    nextWatermark = { anchorKey: state.anchorKey, after: state.after + slice.length };
  }

  const paths = extractPaths(slice);
  return { items, paths, truncated, watermark: nextWatermark };
}

/** 增量总字符数。 */
export function deltaChars(items) {
  let n = 0;
  for (const item of items) n += item.text.length;
  return n;
}

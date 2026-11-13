/**
 * 「谁在说话」—— 写进记忆文件的名字解析。
 *
 * 安全约束（ClawHub 安全扫描对 0.1.0 报的正是这一条）：
 *   **只有可信来源的名字能进可检索的长期记忆。**
 *
 *   - 渠道自带的显示名（channelContext.sender.name 等）是**发送者可控的自由文本**，
 *     「忽略之前的指令」这类内容一旦进了记忆，就是对以后 agent 行为的注入通道 ⇒ 不用。
 *   - ctx.senderId 同样可能被渠道填成自由 handle ⇒ 只用它的**哈希**，
 *     保留「区分不同发送者」的能力，但承载不了任何指令。
 *   - config.userNames[agentId] 是运行者自己写的 ⇒ 唯一能以原文进记忆的名字。
 */

/** 取非空字符串，否则 undefined。 */
export function pickString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * 清掉名字里的控制字符和 markdown 记号。
 *
 * 名字要进 markdown 记忆文件：换行会把一行记录劈成两行，
 * 尖括号 / 反引号能改变渲染。
 */
export function sanitizeName(value) {
  const raw = pickString(value);
  if (!raw) return undefined;
  const cleaned = raw
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[<>`*_[\]]/g, '')
    .trim();
  return cleaned ? cleaned.slice(0, 64) : undefined;
}

/**
 * 把 senderId 变成短的、不可注入的标识（`u_<8 hex>`）。
 *
 * 同一个 senderId 永远得到同一个值 ⇒ 仍然是稳定标识。
 */
export function hashSenderId(senderId) {
  const raw = pickString(senderId);
  if (!raw) return undefined;
  // 内联实现，避免为一个哈希引入 node:crypto 依赖
  let h = 0x811c9dc5;
  for (let i = 0; i < raw.length; i += 1) {
    h ^= raw.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `u_${h.toString(16).padStart(8, '0')}`;
}

/**
 * 解析「谁」在提问。
 *
 * @param {object} params
 * @param {Record<string,string>} [params.userNames] agentId → 显示名（运行者配置）
 * @param {string} [params.agentId]
 * @param {string} [params.senderId] 渠道 sender id（只用来哈希）
 * @returns {string|undefined} 显示名；没有可信来源 ⇒ undefined（渲染时省略方括号）
 */
export function resolveUserName({ userNames, agentId, senderId } = {}) {
  const configured = sanitizeName(userNames?.[agentId]);
  if (configured) return configured;
  return hashSenderId(senderId);
}

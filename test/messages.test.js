/**
 * 消息提取的单元测试。
 *
 * fixture 用的是 2026-11-13 探针实测的真实形状：
 *   - user 带 idempotencyKey（形如 "<runId>:user"）
 *   - assistant 的 content 是数组，part 有 text / toolCall 两种
 *   - toolResult 带 toolCallId / toolName / content
 *   - compactionSummary 没有 content 字段
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  messageText,
  findWatermarkIndex,
  extractDelta,
  extractPaths,
  deltaChars,
} from '../lib/messages.js';

const userMsg = (text, key) => ({
  role: 'user',
  content: text,
  timestamp: 1,
  idempotencyKey: key,
});

const assistantText = (text) => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
  api: 'openai-completions',
  provider: 'minimax-tp',
  model: 'MiniMax-M3.1-Flash',
  timestamp: 2,
});

const assistantToolCall = () => ({
  role: 'assistant',
  content: [{ type: 'toolCall', name: 'bash', arguments: {} }],
  timestamp: 3,
});

const toolResult = (text, toolName = 'bash') => ({
  role: 'toolResult',
  toolCallId: 'call-1',
  toolName,
  content: [{ type: 'text', text }],
  isError: false,
  timestamp: 4,
});

const compactionSummary = (summary) => ({
  role: 'compactionSummary',
  summary,
  tokensBefore: 41060,
  timestamp: 5,
});

test('messageText: 字符串 content', () => {
  assert.equal(messageText(userMsg('你好', 'k1')), '你好');
});

test('messageText: 数组 content 只取 text part，跳过 toolCall', () => {
  assert.equal(messageText(assistantText('回答')), '回答');
  assert.equal(messageText(assistantToolCall()), '');
});

test('messageText: 非对象返回空串', () => {
  assert.equal(messageText(null), '');
  assert.equal(messageText(undefined), '');
  assert.equal(messageText(42), '');
});

test('findWatermarkIndex: 从后往前找', () => {
  const msgs = [userMsg('a', 'k1'), assistantText('b'), userMsg('c', 'k2')];
  assert.equal(findWatermarkIndex(msgs, 'k1'), 0);
  assert.equal(findWatermarkIndex(msgs, 'k2'), 2);
  assert.equal(findWatermarkIndex(msgs, 'nope'), -1);
  assert.equal(findWatermarkIndex(msgs, null), -1);
});

test('extractDelta: 首轮取全部 user/assistant 文本', () => {
  const msgs = [userMsg('问题', 'k1'), assistantText('回答')];
  const d = extractDelta(msgs, null);
  assert.equal(d.items.length, 2);
  assert.equal(d.items[0].role, 'user');
  assert.equal(d.items[0].text, '问题');
  assert.equal(d.items[1].role, 'assistant');
  assert.equal(d.watermark.anchorKey, 'k1');
  assert.equal(d.watermark.after, 1, '锚点后还有 1 条（assistant 的回复）');
  assert.equal(d.truncated, false);
});

test('extractDelta: 有水位线时只取其后的部分（不重复计入上一轮的 assistant 回复）', () => {
  const msgs = [
    userMsg('第一问', 'k1'),
    assistantText('第一答'),
    userMsg('第二问', 'k2'),
    assistantText('第二答'),
  ];
  // 第一轮处理完 [k1, 第一答] 之后，水位线是 {anchorKey:'k1', after:1}
  const first = extractDelta(msgs.slice(0, 2), null);
  assert.equal(first.items.length, 2);
  assert.deepEqual(first.watermark, { anchorKey: 'k1', after: 1 });

  // 第二轮：应只拿到 [第二问, 第二答]
  const second = extractDelta(msgs, first.watermark);
  assert.equal(second.items.length, 2, `实际: ${JSON.stringify(second.items.map((i) => i.text))}`);
  assert.equal(second.items[0].text, '第二问');
  assert.equal(second.items[1].text, '第二答');
  assert.equal(second.watermark.anchorKey, 'k2');
});

test('extractDelta: 丢弃 toolResult 和 compactionSummary', () => {
  const msgs = [
    userMsg('跑个命令', 'k1'),
    assistantToolCall(),
    toolResult('probe-tool-test'),
    assistantText('输出是 probe-tool-test'),
    compactionSummary('历史摘要'),
  ];
  const d = extractDelta(msgs, null);
  const roles = d.items.map((i) => i.role);
  assert.deepEqual(roles, ['user', 'assistant']);
  assert.equal(d.items[1].text, '输出是 probe-tool-test');
  // toolResult 的内容不应出现在增量文本里
  assert.ok(!d.items.some((i) => i.text.includes('toolCall')));
});

test('extractDelta: 水位线丢失（compaction）时退化取尾部', () => {
  const msgs = [];
  for (let i = 0; i < 40; i++) {
    msgs.push(userMsg(`第${i}问`, `k${i}`), assistantText(`第${i}答`));
  }
  const d = extractDelta(msgs, { anchorKey: 'k-does-not-exist', after: 3 }, 20);
  assert.equal(d.truncated, true);
  assert.ok(d.items.length <= 20);
  assert.equal(d.watermark.anchorKey, 'k39');
});

test('extractDelta: 本轮没有新 user 消息时水位线 after 累加', () => {
  const msgs = [userMsg('问题', 'k1'), assistantText('答')];
  const first = extractDelta(msgs, null);
  // 第二轮只有 assistant（工具结果后的收尾）
  const second = extractDelta([...msgs, assistantText('补充')], first.watermark);
  assert.equal(second.items.length, 1);
  assert.equal(second.watermark.anchorKey, 'k1', '锚点不变');
  assert.equal(second.watermark.after, 2, 'after 累加');
});

test('extractDelta: 空数组', () => {
  const d = extractDelta([], null);
  assert.equal(d.items.length, 0);
  assert.equal(d.watermark.anchorKey, null);
});

test('extractDelta: user 消息没有 idempotencyKey 时水位线不推进', () => {
  const d = extractDelta([{ role: 'user', content: '无 key' }], null);
  assert.equal(d.items.length, 1);
  assert.equal(d.watermark.anchorKey, null, '没有稳定标识时不能建立水位线');
});

test('extractPaths: 从 toolResult 里抽路径', () => {
  const paths = extractPaths([
    toolResult('已修改 /home/tester/coding/foo/src/index.ts'),
    toolResult('读取 README.md 失败'),
  ]);
  assert.ok(paths.includes('/home/tester/coding/foo/src/index.ts'));
});

test('extractPaths: 过滤 /proc /sys /dev', () => {
  const paths = extractPaths([toolResult('cat /proc/self/status 和 /sys/kernel/x')]);
  assert.ok(!paths.some((p) => p.startsWith('/proc/')));
  assert.ok(!paths.some((p) => p.startsWith('/sys/')));
});

test('deltaChars: 统计字符数', () => {
  assert.equal(deltaChars([{ text: 'abc' }, { text: 'de' }]), 5);
  assert.equal(deltaChars([]), 0);
});

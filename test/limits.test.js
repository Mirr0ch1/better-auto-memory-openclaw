/**
 * maxChars / maxTokens 的行为测试。
 *
 * 约定：
 *   - 两者默认留空 = 不限制
 *   - maxTokens 留空 ⇒ 根本不传给宿主（用模型自己的默认上限）
 *   - maxChars 留空 ⇒ 正文不截断
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { clampSummaryText, buildSummaryRequest, runSummary } from '../lib/summary.js';

test('clampSummaryText: maxChars 未配置 ⇒ 不截断', () => {
  const long = 'x'.repeat(5000);
  assert.equal(clampSummaryText(long, undefined), long);
});

test('clampSummaryText: maxChars 已配置 ⇒ 截断并标注', () => {
  const out = clampSummaryText('x'.repeat(100), 10);
  assert.ok(out.startsWith('xxxxxxxxxx'));
  assert.ok(out.includes('已截断'));
  assert.ok(out.length < 100);
});

test('clampSummaryText: 短于上限 ⇒ 原样', () => {
  assert.equal(clampSummaryText('短', 800), '短');
});

test('runSummary: maxTokens 未配置 ⇒ 不传给宿主', async () => {
  let seen = null;
  const result = await runSummary({
    chain: [undefined],
    request: { messages: [{ role: 'user', content: 'x' }], systemPrompt: 's' },
    agentId: 'main',
    reasoning: 'low',
    timeoutMs: 1000,
    complete: async (params) => {
      seen = params;
      return { text: '## 主题\nx', provider: 'p', model: 'm' };
    },
  });
  assert.equal(result.ok, true);
  assert.equal('maxTokens' in seen, false, '未配置 maxTokens 时不应传该字段');
});

test('runSummary: maxTokens 已配置 ⇒ 传给宿主', async () => {
  let seen = null;
  await runSummary({
    chain: [undefined],
    request: { messages: [{ role: 'user', content: 'x' }], systemPrompt: 's' },
    agentId: 'main',
    reasoning: 'low',
    timeoutMs: 1000,
    maxTokens: 321,
    complete: async (params) => {
      seen = params;
      return { text: '## 主题\nx', provider: 'p', model: 'm' };
    },
  });
  assert.equal(seen.maxTokens, 321);
});

test('runSummary: maxChars 作用于模型返回的正文', async () => {
  const result = await runSummary({
    chain: [undefined],
    request: { messages: [{ role: 'user', content: 'x' }], systemPrompt: 's' },
    agentId: 'main',
    reasoning: 'low',
    timeoutMs: 1000,
    maxChars: 12,
    complete: async () => ({ text: 'y'.repeat(200), provider: 'p', model: 'm' }),
  });
  assert.ok(result.text.length < 200);
  assert.ok(result.text.includes('已截断'));
});

test('buildSummaryRequest: prompt 覆盖三类记录', () => {
  const req = buildSummaryRequest([{ role: 'user', text: '问题' }], {});
  assert.match(req.systemPrompt, /会话记录器/);
  assert.match(req.systemPrompt, /保留用户原有的确定性级别/);
  assert.match(req.systemPrompt, /不写待办/);
  assert.doesNotMatch(req.systemPrompt, /## 主题/);
});

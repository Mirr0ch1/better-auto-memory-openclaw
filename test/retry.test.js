/**
 * 重试上限 + 降级写原文 的单元测试。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildDegradedBody, decideSummaryOutcome } from '../lib/summary.js';
import { appendOutboxEntry, readOutbox, updateOutboxAttempts } from '../lib/outbox.js';

const MAX = 3;

function tmpWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'better-auto-memory-openclaw-retry-'));
}

test('decideSummaryOutcome: 首次失败 → 重试', () => {
  const o = decideSummaryOutcome({}, MAX);
  assert.equal(o.action, 'retry');
  assert.equal(o.attempts, 1);
  assert.equal(o.remaining, 2);
});

test('decideSummaryOutcome: 第二次失败 → 仍重试', () => {
  const o = decideSummaryOutcome({ attempts: 1 }, MAX);
  assert.equal(o.action, 'retry');
  assert.equal(o.attempts, 2);
  assert.equal(o.remaining, 1);
});

test('decideSummaryOutcome: 第三次失败 → 降级', () => {
  const o = decideSummaryOutcome({ attempts: 2 }, MAX);
  assert.equal(o.action, 'degrade');
  assert.equal(o.attempts, 3);
  assert.equal(o.remaining, 0);
});

test('decideSummaryOutcome: 超过上限仍然降级（不会无限重试）', () => {
  const o = decideSummaryOutcome({ attempts: 9 }, MAX);
  assert.equal(o.action, 'degrade');
  assert.equal(o.attempts, 10);
});

test('decideSummaryOutcome: 非法 attempts 按 0 处理', () => {
  const o = decideSummaryOutcome({ attempts: 'abc' }, MAX);
  assert.equal(o.action, 'retry');
  assert.equal(o.attempts, 1);
});

test('buildDegradedBody: 保留用户原话并标注降级原因', () => {
  const items = [
    { role: 'user', text: '问题内容' },
    { role: 'assistant', text: '回答内容' },
  ];
  const out = buildDegradedBody(items, 3);
  assert.ok(out.includes('自动摘要失败'));
  assert.ok(out.includes('3 次'));
  assert.ok(out.includes('问题内容'));
  // agent 的回答不进降级正文 —— 它是二手信息，不是事实来源
  assert.ok(!out.includes('回答内容'));
  assert.ok(out.includes('提出问题：'));
});

test('outbox: 重试次数可以写回并跨调用保留', () => {
  const ws = tmpWorkspace();
  try {
    appendOutboxEntry(ws, 'agent:main:main', { runId: 'r1', items: [{ role: 'user', text: 'x' }] });
    updateOutboxAttempts(ws, new Map([['r1', 2]]));

    const entries = readOutbox(ws);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].attempts, 2);
    assert.equal(entries[0].runId, 'r1');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('outbox: 重试次数累加不丢失其它字段', () => {
  const ws = tmpWorkspace();
  try {
    appendOutboxEntry(ws, 'agent:main:main', {
      runId: 'r1',
      items: [{ role: 'user', text: '内容' }],
      sessionKey: 'agent:main:main',
      heading: '10:00',
    });
    updateOutboxAttempts(ws, new Map([['r1', 1]]));
    updateOutboxAttempts(ws, new Map([['r1', 2]]));

    const entry = readOutbox(ws)[0];
    assert.equal(entry.attempts, 2);
    assert.equal(entry.heading, '10:00');
    assert.equal(entry.sessionKey, 'agent:main:main');
    assert.deepEqual(entry.items, [{ role: 'user', text: '内容' }]);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('outbox: 没有 attempts 字段时读出来是 undefined（首轮）', () => {
  const ws = tmpWorkspace();
  try {
    appendOutboxEntry(ws, 'agent:main:main', { runId: 'r1', items: [] });
    assert.equal(readOutbox(ws)[0].attempts, undefined);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

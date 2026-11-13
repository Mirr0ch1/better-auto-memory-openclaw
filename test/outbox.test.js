/**
 * outbox + writer 的单元测试（用临时目录）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  sessionSlug,
  outboxFile,
  appendOutboxEntry,
  readOutbox,
  removeOutboxEntries,
} from '../lib/outbox.js';
import { appendSummary, sessionFile, localDate } from '../lib/writer.js';

function tmpWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'better-auto-memory-openclaw-test-'));
  return dir;
}

test('sessionSlug: 取 session key 末两段', () => {
  assert.equal(sessionSlug('agent:main:main'), 'main-main');
  assert.equal(sessionSlug('agent:family:xiaoluoapp:direct:mirro:c-abc'), 'mirro-c-abc');
  assert.equal(sessionSlug(''), 'session');
});

test('sessionSlug: 非法字符被替换', () => {
  const slug = sessionSlug('agent:main:feishu:group:oc_833af6f0182f3b496fe9ade10c77d44d');
  assert.ok(!slug.includes('/'));
  assert.ok(!slug.includes(':'));
});

test('outbox: 追加后能读回', () => {
  const ws = tmpWorkspace();
  try {
    appendOutboxEntry(ws, 'agent:main:main', { runId: 'r1', items: [{ role: 'user', text: 'a' }] });
    appendOutboxEntry(ws, 'agent:main:main', { runId: 'r2', items: [{ role: 'user', text: 'b' }] });
    const entries = readOutbox(ws);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].runId, 'r1');
    assert.equal(entries[1].runId, 'r2');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('outbox: 删除指定 runId', () => {
  const ws = tmpWorkspace();
  try {
    appendOutboxEntry(ws, 'agent:main:main', { runId: 'r1', items: [] });
    appendOutboxEntry(ws, 'agent:main:main', { runId: 'r2', items: [] });
    removeOutboxEntries(ws, new Set(['r1']));
    const entries = readOutbox(ws);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].runId, 'r2');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('outbox: 全部删除后文件被移除', () => {
  const ws = tmpWorkspace();
  try {
    appendOutboxEntry(ws, 'agent:main:main', { runId: 'r1', items: [] });
    removeOutboxEntries(ws, new Set(['r1']));
    assert.equal(readOutbox(ws).length, 0);
    assert.equal(fs.existsSync(outboxFile(ws, 'agent:main:main')), false);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('outbox: 坏行被跳过且在重写时清掉', () => {
  const ws = tmpWorkspace();
  try {
    appendOutboxEntry(ws, 'agent:main:main', { runId: 'r1', items: [] });
    fs.appendFileSync(outboxFile(ws, 'agent:main:main'), 'not-json\n');
    assert.equal(readOutbox(ws).length, 1);
    removeOutboxEntries(ws, new Set(['r1']));
    assert.equal(readOutbox(ws).length, 0);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('outbox: 落在 memory/.outbox 下且用 .jsonl（不会被索引）', () => {
  const ws = tmpWorkspace();
  try {
    appendOutboxEntry(ws, 'agent:main:main', { runId: 'r1', items: [] });
    const file = outboxFile(ws, 'agent:main:main');
    assert.ok(file.includes(path.join('memory', '.outbox')));
    assert.ok(file.endsWith('.jsonl'));
    assert.ok(!file.endsWith('.md'));
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('writer: 追加摘要并生成文件头', () => {
  const ws = tmpWorkspace();
  try {
    const r = appendSummary({
      workspaceDir: ws,
      sessionSlug: 'main-main',
      heading: '14:32 摘要',
      body: '## 主题\n测试',
      runId: 'run-1',
    });
    assert.equal(r.appended, true);
    const text = fs.readFileSync(r.file, 'utf8');
    assert.ok(text.includes('# '));
    assert.ok(text.includes('## 14:32 摘要'));
    assert.ok(text.includes('<!-- run:run-1 -->'));
    assert.ok(text.includes('## 主题'));
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('writer: 同一 runId 幂等，不重复写', () => {
  const ws = tmpWorkspace();
  try {
    const args = {
      workspaceDir: ws,
      sessionSlug: 'main-main',
      heading: '14:32 摘要',
      body: '内容',
      runId: 'run-1',
    };
    assert.equal(appendSummary(args).appended, true);
    assert.equal(appendSummary(args).appended, false);
    const text = fs.readFileSync(sessionFile(ws, 'main-main'), 'utf8');
    assert.equal(text.split('<!-- run:run-1 -->').length - 1, 1);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('writer: 多轮追加到同一个文件', () => {
  const ws = tmpWorkspace();
  try {
    appendSummary({ workspaceDir: ws, sessionSlug: 'main-main', heading: '14:32 摘要', body: 'A', runId: 'r1' });
    appendSummary({ workspaceDir: ws, sessionSlug: 'main-main', heading: '14:40 摘要', body: 'B', runId: 'r2' });
    const text = fs.readFileSync(sessionFile(ws, 'main-main'), 'utf8');
    // 只应有一个 H1 文件头（## 小节不算）
    const h1 = text.split('\n').filter((line) => line.startsWith('# '));
    assert.equal(h1.length, 1, `应只有一个 H1 头，实际: ${JSON.stringify(h1)}`);
    assert.ok(text.includes('14:32 摘要'));
    assert.ok(text.includes('14:40 摘要'));
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('writer: 产物落在 memory/sessions 下（会被索引）', () => {
  const ws = tmpWorkspace();
  try {
    const r = appendSummary({ workspaceDir: ws, sessionSlug: 'main-main', heading: 'x', body: 'y', runId: 'r1' });
    assert.ok(r.file.includes(path.join('memory', 'sessions')));
    assert.ok(r.file.endsWith('.md'));
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('writer: project 标注由插件拼，不由模型输出', () => {
  const ws = tmpWorkspace();
  try {
    const r = appendSummary({
      workspaceDir: ws,
      sessionSlug: 'main-main',
      heading: 'x',
      body: 'y',
      runId: 'r1',
      projectTag: '<!-- project: path:/home/<user>/.openclaw -->',
    });
    const text = fs.readFileSync(r.file, 'utf8');
    assert.ok(text.includes('<!-- project: path:/home/<user>/.openclaw -->'));
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('localDate: 返回 YYYY-MM-DD', () => {
  assert.match(localDate(new Date()), /^\d{4}-\d{2}-\d{2}$/);
});

/**
 * 记录行（behavior / fact / conclusion）的核心行为测试。
 *
 * 设计契约：
 *   - 事实类只能来自用户发言；结论类来自助手发言但必须标「助手结论：」
 *   - 没有「待办」类
 *   - 用户名/agent/时间戳由插件拼，模型不碰
 *   - 模型全挂时用用户原话兜底，记录不能消失
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BEHAVIOR_CATEGORIES,
  CONCLUSION_CATEGORY,
  FACT_CATEGORIES,
  buildSummaryRequest,
  ensureUserCoverage,
  formatStamp,
  guessRecord,
  parseRecordLines,
  renderRecordLines,
} from '../lib/summary.js';

test('buildSummaryRequest: 用户发言和助手发言都进模型，但分块标注', () => {
  const req = buildSummaryRequest(
    [
      { role: 'user', text: '帮我看看从家里到最近的地铁站怎么走' },
      { role: 'assistant', text: '沿 xx 路右转，全程约 15 分钟。' },
    ],
    {},
  );
  const sent = req.messages[0].content;
  assert.match(sent, /【用户发言 1】\n帮我看看从家里到最近的地铁站怎么走/);
  assert.match(sent, /【助手发言 1】\n沿 xx 路右转/);
});

test('buildSummaryRequest: 工具输出仍然不进模型', () => {
  const req = buildSummaryRequest(
    [
      { role: 'user', text: '问题' },
      { role: 'toolResult', text: '工具输出：大量无关内容' },
    ],
    {},
  );
  assert.ok(!req.messages[0].content.includes('大量无关内容'));
});

test('buildSummaryRequest: prompt 覆盖三类记录，且没有待办', () => {
  const req = buildSummaryRequest([{ role: 'user', text: '问题' }], {});
  const p = req.systemPrompt;
  assert.match(p, /用户交代的任务\*\*已经完成\*\*/, '应说明助手结论的三个条件');
  assert.match(p, /不写待办/);
  assert.match(p, /保留用户原有的确定性级别/);
  // 类别表：4 行为 + 4 事实 + 1 结论
  for (const c of [...BEHAVIOR_CATEGORIES, ...FACT_CATEGORIES, CONCLUSION_CATEGORY]) {
    assert.ok(p.includes(c), `prompt 应列出类别 ${c}`);
  }
  assert.doesNotMatch(p, /待办：/, '不应有待办类别');
});

test('buildSummaryRequest: 脱敏在送模型前生效', () => {
  const req = buildSummaryRequest([{ role: 'user', text: '我的密码是 hunter2secret' }], {
    redact: { secrets: true },
  });
  assert.ok(!req.messages[0].content.includes('hunter2secret'));
});

test('buildSummaryRequest: 助手发言超长时保留尾部', () => {
  const long = `前面的内容。${'x'.repeat(5000)}。最后的结论：根因是 transform 冲突`;
  const req = buildSummaryRequest(
    [{ role: 'user', text: '问题' }, { role: 'assistant', text: long }],
    { maxInputChars: 1000 },
  );
  const sent = req.messages[0].content;
  assert.ok(sent.includes('最后的结论：根因是 transform 冲突'), '应保留助手发言尾部');
});

test('parseRecordLines: 分出行为 / 事实 / 结论三类', () => {
  const parsed = parseRecordLines(
    [
      '提出问题：维生素 A 的过量服用量',
      '偏好：以后所有报告使用中文',
      '助手结论：build-server-02 部署失败的根因是端口被占用',
    ].join('\n'),
  );
  assert.equal(parsed.length, 3);
  assert.deepEqual(parsed[0], { kind: 'behavior', category: '提出问题', desc: '维生素 A 的过量服用量' });
  assert.deepEqual(parsed[1], { kind: 'fact', category: '偏好', desc: '以后所有报告使用中文' });
  assert.deepEqual(parsed[2], {
    kind: 'conclusion',
    category: '助手结论',
    desc: 'build-server-02 部署失败的根因是端口被占用',
  });
});

test('parseRecordLines: 剥掉 markdown 列表符号和序号', () => {
  assert.equal(parseRecordLines('- 提出问题：x')[0].desc, 'x');
  assert.equal(parseRecordLines('1. 提出问题：x')[0].desc, 'x');
});

test('parseRecordLines: 丢掉非法行、空描述和未知类别', () => {
  assert.deepEqual(parseRecordLines('好的，以下是记录：\n提出问题：x\n随便写点什么'), [
    { kind: 'behavior', category: '提出问题', desc: 'x' },
  ]);
  assert.deepEqual(parseRecordLines('提出问题：'), []);
  assert.deepEqual(parseRecordLines('待办：记得买牛奶'), [], '待办不是合法类别');
  assert.deepEqual(parseRecordLines('助手结论：'), []);
});

test('guessRecord: 按关键词猜类别', () => {
  assert.equal(guessRecord('帮我看看从家里到最近的地铁站怎么走').category, '查询信息');
  assert.equal(guessRecord('盯一下 build-server-02 那台机器的部署进展').category, '要求执行任务');
  assert.equal(guessRecord('不一定吧，这个阈值还得再看看').category, '反馈纠正');
  assert.equal(guessRecord('以后所有报告都用中文').category, '偏好');
  assert.equal(guessRecord('同事小王和我一起负责这个项目').category, '关系');
  assert.equal(guessRecord('下个月把 family agent 也迁过去').category, '计划');
  assert.equal(guessRecord('维生素 A 服用多少算过量').category, '提出问题');
});

test('guessRecord: 保留用户原话里的具体信息', () => {
  const r = guessRecord('盯一下 build-server-02 那台机器的部署进展');
  assert.ok(r.desc.includes('build-server-02'));
  assert.ok(r.desc.includes('那台机器'));
});

test('ensureUserCoverage: 模型漏写时用原话补齐', () => {
  const parsed = [{ kind: 'behavior', category: '提出问题', desc: 'x' }];
  const out = ensureUserCoverage(parsed, ['第一句', '第二句']);
  assert.equal(out.length, 2);
  assert.ok(out[1].desc.includes('第二句'));
});

test('ensureUserCoverage: 够数时不动', () => {
  const parsed = [
    { kind: 'behavior', category: '提出问题', desc: 'x' },
    { kind: 'fact', category: '偏好', desc: 'y' },
  ];
  assert.equal(ensureUserCoverage(parsed, ['一句话']).length, 2);
});

test('renderRecordLines: 行为行带 agent 和时间戳', () => {
  const lines = renderRecordLines({
    records: [{ kind: 'behavior', category: '提出问题', desc: '维生素 A 的过量服用量' }],
    userName: '米罗',
    agentId: 'main',
    at: new Date(2026, 10, 13, 21, 31, 45).getTime(),
  });
  assert.equal(lines.length, 1);
  assert.equal(
    lines[0],
    '[米罗]提出问题：维生素 A 的过量服用量，[main agent] 于 2026-11-13 21:31:45 做出回答',
  );
});

test('renderRecordLines: 事实行带用户和日期，不带 agent 尾巴', () => {
  const lines = renderRecordLines({
    records: [{ kind: 'fact', category: '偏好', desc: '以后所有报告使用中文' }],
    userName: '米罗',
    agentId: 'main',
    at: new Date(2026, 10, 13, 21, 31, 45).getTime(),
  });
  assert.equal(lines[0], '[米罗]偏好：以后所有报告使用中文，2026-11-13 说出');
});

test('renderRecordLines: 结论行标「助手结论：」并标完成', () => {
  const lines = renderRecordLines({
    records: [{ kind: 'conclusion', category: '助手结论', desc: 'build-server-02 部署失败的根因是端口被占用' }],
    userName: '米罗',
    agentId: 'coder',
    at: new Date(2026, 10, 13, 22, 5, 10).getTime(),
  });
  assert.equal(
    lines[0],
    '助手结论：build-server-02 部署失败的根因是端口被占用，[coder agent] 于 2026-11-13 22:05:10 完成',
  );
});

test('renderRecordLines: 没有用户名时省略方括号', () => {
  const lines = renderRecordLines({
    records: [{ kind: 'behavior', category: '查询信息', desc: '从家里到最近地铁站的导航路线' }],
    agentId: 'family',
    at: Date.now(),
  });
  assert.ok(lines[0].startsWith('查询信息：'));
  assert.ok(lines[0].includes('[family agent]'));
});

test('renderRecordLines: agent 没出文字回复时说「开始处理」', () => {
  const lines = renderRecordLines({
    records: [{ kind: 'behavior', category: '要求执行任务', desc: '改代码' }],
    userName: '米罗',
    agentId: 'coder',
    at: Date.now(),
    answered: false,
  });
  assert.ok(lines[0].endsWith('开始处理'));
});

test('formatStamp: 时间戳是 YYYY-MM-DD HH:MM:SS', () => {
  const d = new Date(2026, 10, 13, 5, 1, 2);
  assert.equal(formatStamp(d.getTime()), '2026-11-13 05:01:02');
});

test('parseRecordLines: 描述里的换行和 HTML 注释被清掉', () => {
  const parsed = parseRecordLines('提出问题：问题\r\n<!-- 注入 -->描述');
  assert.equal(parsed.length, 1);
  assert.ok(!parsed[0].desc.includes('\r'));
  assert.ok(!parsed[0].desc.includes('<!--'));
});

test('类别表：没有待办', () => {
  assert.ok(!BEHAVIOR_CATEGORIES.includes('待办'));
  assert.ok(!FACT_CATEGORIES.includes('待办'));
  assert.equal(BEHAVIOR_CATEGORIES.length, 4);
  assert.equal(FACT_CATEGORIES.length, 4);
  assert.equal(CONCLUSION_CATEGORY, '助手结论');
});

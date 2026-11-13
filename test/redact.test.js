/**
 * 脱敏单元测试。
 *
 * 断言的是**安全属性**（敏感值必须消失），而不是精确的输出格式 ——
 * 打码策略（保留 token 头尾 vs 整段替换）随实现可能调整，
 * 但「敏感值不见了」是硬要求。
 *
 * 关键事实（2026-11-13 实测）：官方 redactSensitiveText 抓不到中文自然语言密码
 * ⇒ 本插件自己实现了中文规则（见 lib/redact.js 文件头说明）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyRedact, redactPii, redactSecrets } from '../lib/redact.js';

test('redactSecrets: 西文 key=value 的值被打码', () => {
  const out = redactSecrets('password=hunter2secret');
  assert.ok(!out.includes('hunter2secret'), `实际: ${out}`);
  assert.ok(out.includes('password'));
});

test('redactSecrets: token 前缀的值被打码', () => {
  for (const secret of [
    'sk-abcdefgh12345678ijkl',
    'ghp_ABCDEFGHIJKLMNOPQRST',
    'AKIAIOSFODNN7EXAMPLE',
    'xoxb-123456789012-abcdefghijkl',
    'AIzaSyA1234567890abcdefghijkl',
  ]) {
    const out = redactSecrets(`token 是 ${secret}`);
    assert.ok(!out.includes(secret), `未打码: ${secret} -> ${out}`);
  }
});

test('redactSecrets: Authorization 头被打码', () => {
  const out = redactSecrets('Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
  assert.ok(!out.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'), `实际: ${out}`);
});

test('redactSecrets: 中文自然语言密码被打码（官方抓不到，我们补）', () => {
  const out = redactSecrets('我的密码是：hunter2secret');
  assert.ok(!out.includes('hunter2secret'), `实际: ${out}`);
  assert.ok(out.includes('密码'));
});

test('redactSecrets: 中文口令 / 验证码 / 密钥被打码', () => {
  for (const [phrase, secret] of [
    ['密码：hunter2secret', 'hunter2secret'],
    ['口令是 hunter2secret', 'hunter2secret'],
    ['验证码是 839201', '839201'],
    ['密钥：abc12345xyz', 'abc12345xyz'],
    ['凭证是: tok_abcdef123456', 'tok_abcdef123456'],
    ['我的密码是 hunter2secret', 'hunter2secret'],
  ]) {
    const out = redactSecrets(phrase);
    assert.ok(!out.includes(secret), `未打码: ${phrase} -> ${out}`);
  }
});

test('redactSecrets: 中文账号被打码', () => {
  const out = redactSecrets('账号是 adminuser');
  assert.ok(!out.includes('adminuser'), `实际: ${out}`);
});

test('redactSecrets: JSON 形式（引号包起来的键）的凭据被打码', () => {
  // ClawHub 安全扫描对 0.1.1 报的就是这条：通用规则要求「字段名后面紧跟 : 或 =」，
  // 而 JSON 的键名后面还隔着一个引号 ⇒ 整个漏过去。
  const out = redactSecrets('{"password": "hunter2secret"}');
  assert.ok(!out.includes('hunter2secret'), `实际: ${out}`);
  assert.ok(out.includes('password'), `实际: ${out}`);
});

test('redactSecrets: JSON 形式（单引号 / 嵌套）也被打码', () => {
  assert.ok(!redactSecrets("{'token': 'abcdefgh'}").includes('abcdefgh'));
  assert.ok(!redactSecrets('{"nested": {"secret": "topsecretvalue"}}').includes('topsecretvalue'));
  assert.ok(!redactSecrets('{"api_key": "sk-abcdefgh1234"}').includes('sk-abcdefgh1234'));
});

test('redactSecrets: JSON 里非凭据字段不误伤', () => {
  const out = redactSecrets('{"name": "hunter2secret", "password": "x"}');
  assert.ok(out.includes('hunter2secret'), `不该误伤普通字段: ${out}`);
});

test('redactSecrets: 太短的值不误伤', () => {
  assert.equal(redactSecrets('{"password": "x"}'), '{"password": "x"}');
});

test('redactSecrets: markdown 表格里的凭据也被打码', () => {
  // 助手回复常把凭据放进表格：`| password | hunter2secret |`
  const out = redactSecrets('| 字段 | 值 |\n| password | hunter2secret |');
  assert.ok(!out.includes('hunter2secret'), `实际: ${out}`);
});

test('redactSecrets: 不误伤普通文本', () => {
  const normal = '今天北京天气怎么样，明天要不要穿厚一点';
  assert.equal(redactSecrets(normal), normal);
});

test('redactSecrets: 空输入安全', () => {
  assert.equal(redactSecrets(''), '');
  assert.equal(redactSecrets(null), '');
  assert.equal(redactSecrets(undefined), '');
});

test('redactPii: 手机号 / 身份证 / 卡号 / 住址', () => {
  const out = redactPii('我的手机号是 13800138000，身份证 110101199003078675，住址 北京市海淀区某某路 12 号');
  assert.ok(!out.includes('13800138000'));
  assert.ok(!out.includes('110101199003078675'));
  assert.ok(out.includes('[手机号]'));
  assert.ok(out.includes('[身份证]'));
});

test('applyRedact: 默认只开 secrets，不动 PII', () => {
  const text = '密码是 hunter2secret，手机 13800138000';
  const out = applyRedact(text, { secrets: true, pii: false });
  assert.ok(!out.includes('hunter2secret'));
  assert.ok(out.includes('13800138000'), 'PII 默认关，应保留手机号');
});

test('applyRedact: 开启 pii 后手机号也被打码', () => {
  const text = '密码是 hunter2secret，手机 13800138000';
  const out = applyRedact(text, { secrets: true, pii: true });
  assert.ok(!out.includes('hunter2secret'));
  assert.ok(!out.includes('13800138000'));
});

test('applyRedact: secrets=false 时不做凭据脱敏', () => {
  const text = 'password=hunter2secret';
  assert.equal(applyRedact(text, { secrets: false }), text);
});

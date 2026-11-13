/**
 * 候选模型链 + 配置归一化的单元测试。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCandidateChain, isModelOverrideAllowed } from '../lib/candidates.js';
import { readConfig } from '../lib/config.js';

const CFG = {
  agents: {
    defaults: {
      model: {
        primary: 'minimax-tp/MiniMax-M3.1-Flash',
        fallbacks: ['xiaomi-mimo/mimo-v2.6-pro', 'opencode-go/step-5-preview-free'],
      },
    },
    entries: {
      main: {},
      coder: {
        model: {
          primary: 'opencode-go/glm-5.3',
          fallbacks: ['opencode-go/deepseek-v4.1-flash'],
        },
      },
    },
  },
};

test('buildCandidateChain: 默认第一项是 undefined（用 agent 默认模型）', () => {
  const chain = buildCandidateChain(CFG, 'main', undefined);
  assert.equal(chain[0], undefined);
});

test('buildCandidateChain: 追加 defaults 的 fallbacks，保持配置顺序', () => {
  const chain = buildCandidateChain(CFG, 'main', undefined);
  assert.deepEqual(chain.slice(1), ['xiaomi-mimo/mimo-v2.6-pro', 'opencode-go/step-5-preview-free']);
});

test('buildCandidateChain: agent 级 model 覆盖 defaults', () => {
  const chain = buildCandidateChain(CFG, 'coder', undefined);
  assert.deepEqual(chain.slice(1), ['opencode-go/deepseek-v4.1-flash']);
});

test('buildCandidateChain: 用户指定模型时排最前，primary 作为备选', () => {
  const chain = buildCandidateChain(CFG, 'main', 'openai/gpt-5.6-sol');
  assert.equal(chain[0], 'openai/gpt-5.6-sol');
  assert.ok(chain.includes('minimax-tp/MiniMax-M3.1-Flash'));
});

test('buildCandidateChain: 去重', () => {
  const chain = buildCandidateChain(
    { agents: { defaults: { model: { primary: 'a/b', fallbacks: ['a/b', 'c/d'] } } } },
    'main',
    'a/b',
  );
  assert.equal(chain.filter((c) => c === 'a/b').length, 1);
});

test('buildCandidateChain: 没有 model 配置时只有 undefined', () => {
  const chain = buildCandidateChain({ agents: {} }, 'main', undefined);
  assert.deepEqual(chain, [undefined]);
});

test('isModelOverrideAllowed: 只有显式 true 才算允许', () => {
  assert.equal(isModelOverrideAllowed({ plugins: { entries: { x: { llm: { allowModelOverride: true } } } } }, 'x'), true);
  assert.equal(isModelOverrideAllowed({ plugins: { entries: { x: { llm: {} } } } }, 'x'), false);
  assert.equal(isModelOverrideAllowed({ plugins: { entries: { x: {} } } }, 'x'), false);
  assert.equal(isModelOverrideAllowed({}, 'x'), false);
});

test('readConfig: 默认值', () => {
  const cfg = readConfig({});
  assert.deepEqual(cfg.agents, ['main', 'coder']);
  assert.equal(cfg.summarize.enabled, true);
  assert.equal(cfg.summarize.reasoning, 'low');
  assert.equal(cfg.summarize.maxChars, undefined, 'maxChars 默认留空 = 不限制');
  assert.equal(cfg.summarize.maxTokens, undefined, 'maxTokens 默认留空 = 不限制');
  assert.equal(cfg.summarize.includeProjectTag, false);
});

test('readConfig: 用户覆盖', () => {
  const cfg = readConfig({
    agents: ['family'],
    summarize: {
      model: 'openai/gpt-5.6-sol',
      maxChars: 200,
      maxTokens: 400,
      redact: { pii: true },
    },
  });
  assert.deepEqual(cfg.agents, ['family']);
  assert.equal(cfg.summarize.model, 'openai/gpt-5.6-sol');
  assert.equal(cfg.summarize.maxChars, 200);
  assert.equal(cfg.summarize.maxTokens, 400);
  assert.equal(cfg.summarize.redact.pii, true);
  // 未指定的保持默认
  assert.equal(cfg.summarize.redact.secrets, true);
});

test('readConfig: 非法值回落为不限制', () => {
  const cfg = readConfig({ summarize: { maxChars: -5, maxTokens: 'abc', timeoutMs: 'abc', enabled: 'yes' } });
  assert.equal(cfg.summarize.maxChars, undefined);
  assert.equal(cfg.summarize.maxTokens, undefined);
  assert.equal(cfg.summarize.timeoutMs, 45000);
  assert.equal(cfg.summarize.enabled, true);
});

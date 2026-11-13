/**
 * 配置读取与归一化。
 *
 * 所有默认值集中在这里，方便测试和文档对齐。
 */

const DEFAULT_AGENTS = ['main', 'coder'];

const DEFAULT_SUMMARIZE = {
  enabled: true,
  model: undefined,
  reasoning: 'low',
  // maxChars / maxTokens：留空 = 不限制。
  // 默认不限制，靠 prompt 里的字数要求软约束；使用者需要硬上限时可自行开启。
  maxChars: undefined,
  maxTokens: undefined,
  maxInputChars: 6000,
  minDeltaChars: 120,
  timeoutMs: 45000,
  includeProjectTag: false,
  redact: {
    secrets: true,
    pii: false,
  },
};

function asString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function asPositiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** 未设置 / 非法值 ⇒ undefined（表示不限制）。 */
function asOptionalPositiveInt(value) {
  if (value === undefined || value === null) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

function asNonNegativeInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/** agentId → 显示名。用于在行为线索里写「谁」。 */
function asUserNames(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [agentId, name] of Object.entries(value)) {
    const key = asString(agentId);
    const display = asString(name);
    if (key && display) out[key] = display;
  }
  return out;
}

/**
 * @param {object} raw pluginConfig（api.pluginConfig）
 * @returns {object} 归一化后的配置
 */
export function readConfig(raw) {
  const cfg = raw && typeof raw === 'object' ? raw : {};
  const s = cfg.summarize && typeof cfg.summarize === 'object' ? cfg.summarize : {};
  const redact = s.redact && typeof s.redact === 'object' ? s.redact : {};

  const agents = Array.isArray(cfg.agents)
    ? cfg.agents.map((a) => asString(a)).filter(Boolean)
    : DEFAULT_AGENTS.slice();

  return {
    agents: agents.length ? agents : DEFAULT_AGENTS.slice(),
    userNames: asUserNames(cfg.userNames),
    summarize: {
      enabled: asBoolean(s.enabled, DEFAULT_SUMMARIZE.enabled),
      model: asString(s.model),
      reasoning: asString(s.reasoning) ?? DEFAULT_SUMMARIZE.reasoning,
      maxChars: asOptionalPositiveInt(s.maxChars),
      maxTokens: asOptionalPositiveInt(s.maxTokens),
      maxInputChars: asPositiveInt(s.maxInputChars, DEFAULT_SUMMARIZE.maxInputChars),
      minDeltaChars: asNonNegativeInt(s.minDeltaChars, DEFAULT_SUMMARIZE.minDeltaChars),
      timeoutMs: asPositiveInt(s.timeoutMs, DEFAULT_SUMMARIZE.timeoutMs),
      includeProjectTag: asBoolean(s.includeProjectTag, DEFAULT_SUMMARIZE.includeProjectTag),
      redact: {
        secrets: asBoolean(redact.secrets, DEFAULT_SUMMARIZE.redact.secrets),
        pii: asBoolean(redact.pii, DEFAULT_SUMMARIZE.redact.pii),
      },
    },
  };
}

export { DEFAULT_AGENTS, DEFAULT_SUMMARIZE };

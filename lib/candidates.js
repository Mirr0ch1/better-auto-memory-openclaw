/**
 * 候选模型链构造。
 *
 * 关键事实（2026-11-13 探针）：
 *   - api.runtime.llm.complete() **不做 fallback**，每次只解析一个模型，失败就抛
 *   - 所以插件必须自己遍历候选链
 *   - 不传 model 时宿主解析该 agent 的默认模型（实测 = agents.defaults.model.primary）
 *   - 传 agentId 时必须配 plugins.entries.<id>.llm.allowAgentIdOverride=true
 *   - api.runtime.modelConfig.resolveDefaultModelForAgent() 返回的是归一化 ref
 *     {provider, model}，**不含 fallbacks** ⇒ fallback 链要从 config 里读
 *
 * 优先级（与宿主内部一致）：
 *   agent 级 model.fallbacks  >  agents.defaults.model.fallbacks
 */

function modelConfigFor(cfg, agentId) {
  const entry = cfg?.agents?.entries?.[agentId];
  const agentModel = entry?.model;
  if (agentModel && typeof agentModel === 'object') return agentModel;
  const defaults = cfg?.agents?.defaults?.model;
  if (defaults && typeof defaults === 'object') return defaults;
  return {};
}

/**
 * 构造候选链。
 *
 * 第一项是 `undefined`（用 agent 默认模型）或用户显式指定的模型；
 * 后面按配置顺序追加 fallback。
 *
 * @param {object} cfg 完整 OpenClaw 配置
 * @param {string} agentId
 * @param {string|undefined} userModel 用户显式指定的压缩模型
 * @returns {Array<string|undefined>}
 */
export function buildCandidateChain(cfg, agentId, userModel) {
  const chain = [];
  const push = (value) => {
    if (value === undefined || value === null) return;
    const s = String(value).trim();
    if (!s) return;
    if (chain.includes(s)) return;
    chain.push(s);
  };

  // 第一候选：undefined = 用 agent 默认模型（宿主解析）
  if (userModel && String(userModel).trim()) {
    push(userModel);
  } else {
    chain.push(undefined);
  }

  const modelCfg = modelConfigFor(cfg, agentId);
  const primary = modelCfg.primary;
  // 显式指定了模型时，把 primary 也放进链里做备选
  if (userModel && primary) push(primary);

  const fallbacks = Array.isArray(modelCfg.fallbacks) ? modelCfg.fallbacks : [];
  for (const fb of fallbacks) push(fb);

  return chain;
}

/**
 * 用户配置的模型是否被宿主授权使用。
 * 没授权就静默忽略（跟官方 team-reports 的做法一致：delete summaryOptions.model）。
 *
 * @param {object} cfg 完整 OpenClaw 配置
 * @param {string} pluginId
 * @returns {boolean}
 */
export function isModelOverrideAllowed(cfg, pluginId) {
  const policy = cfg?.plugins?.entries?.[pluginId]?.llm;
  return policy?.allowModelOverride === true;
}

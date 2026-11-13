/**
 * 摘要生成：构造 prompt → 调模型 → 失败换下一个候选。
 */

import { applyRedact } from './redact.js';

/**
 * 记录类别。
 *
 * 行为类 = 用户这一轮做了什么；事实类 = 用户明确说过的（偏好/关系/计划/决定）；
 * 结论类 = 助手在完成用户交代的任务后得出的可复用结论。
 *
 * 没有「待办」类 —— 待办进记忆只会变成脏数据。
 */
export const BEHAVIOR_CATEGORIES = ['提出问题', '要求执行任务', '查询信息', '反馈纠正'];
export const FACT_CATEGORIES = ['偏好', '关系', '计划', '决定'];
export const CONCLUSION_CATEGORY = '助手结论';

/**
 * 构造摘要请求。
 *
 * 设计要点（2026-11-13 改版）：
 *   记三样东西：
 *     1. 用户这一轮做了什么（行为）
 *     2. 用户**明确说过**的偏好/关系/计划/决定（事实）
 *     3. 助手**实际完成**用户交代的任务后得出的**可复用**结论（标「助手结论：」）
 *   不记：待办、计划中的事、没做完的事、一次性的结果。
 *
 *   - 【用户发言】是关于用户的事实的唯一来源。
 *   - 【助手发言】只用来判断「用户交代的任务是否真的完成」和提取结论。
 *   - 用户名、agent 名、时间戳由插件自己拼，模型不参与，避免它抄错。
 *
 * 安全要点（抄 OpenClaw 官方 capture-summary 的写法）：
 *   对话正文是**不可信的原始素材**，可能包含指令，必须明确要求模型不要执行。
 */
export function buildSummaryRequest(delta, options) {
  const { maxInputChars = 6000, redact = {} } = options;

  const userTexts = (delta ?? [])
    .filter((item) => item.role === 'user')
    .map((item) => String(item.text ?? '').trim())
    .filter(Boolean);

  const assistantTexts = (delta ?? [])
    .filter((item) => item.role === 'assistant')
    .map((item) => String(item.text ?? '').trim())
    .filter(Boolean);

  // 用户发言是主来源，给 60% 预算；助手发言 40%。
  const userBudget = Math.max(200, Math.floor(maxInputChars * 0.6));
  const assistantBudget = Math.max(200, Math.floor(maxInputChars * 0.4));

  const userPart = userTexts
    .map((text, i) => `【用户发言 ${i + 1}】\n${text}`)
    .join('\n\n');
  // 助手发言超长时**保留尾部** —— 结论通常写在最后。
  const assistantPart = assistantTexts
    .map((text, i) => `【助手发言 ${i + 1}】\n${text}`)
    .join('\n\n');

  const clipped = [
    clipHead(applyRedact(userPart, redact), userBudget),
    clipTail(applyRedact(assistantPart, redact), assistantBudget),
  ]
    .filter(Boolean)
    .join('\n\n');

  const systemPrompt = [
    '你是一个会话记录器。把一轮对话压成若干条「记录行」，每行一条。',
    '',
    '【用户发言】是用户亲手说的话，是关于用户的事实的唯一来源。',
    '【助手发言】是 agent 的输出，只能用来判断「用户交代的任务是否真的完成」，以及提取结论。',
    '',
    '输出格式（每行一条，不换行、不加序号、不加解释、不加 markdown 标记）：',
    '<类别>：<描述>',
    '',
    '类别只能从下面九个里选：',
    '- 提出问题：用户提出一个知识、原理、判断类的问题',
    '- 要求执行任务：用户要求 agent 去做某件事',
    '- 查询信息：用户要获取某个具体信息（路线、状态、时间、价格、联系人、配置等）',
    '- 反馈纠正：用户否定或修正 agent 之前的说法，或提出异议',
    '- 偏好：用户明确说出的偏好、习惯、要求（例：以后所有报告用中文）',
    '- 关系：用户明确说出的人或事物之间的关系（例：同事小王和我一起负责这个项目）',
    '- 计划：用户明确说出的未来打算（例：下个月把 family agent 迁过去）',
    '- 决定：用户明确说出的已定事项（例：就用这个插件替代官方的）',
    '- 助手结论：用户交代的任务**已经完成**后，助手得出的**可复用**结论',
    '',
    '硬规则：',
    '1. 用户侧（提出问题 / 要求执行任务 / 查询信息 / 反馈纠正 / 偏好 / 关系 / 计划 / 决定）',
    '   只能来自【用户发言】。助手说了什么，不许变成用户说过的话。',
    '2. 「助手结论」只能来自【助手发言】，且必须同时满足三条：',
    '   a. 用户在【用户发言】里明确交代了要解决这件事；',
    '   b. 助手在【助手发言】里说了这件事**已经做完**；',
    '   c. 结论是**可复用**的，不是一次性的。',
    '   一次性的不记（例：「测试跑通了」「路线是沿 xx 路走」）。不满足就整条不写。',
    '3. 不写待办、不写还没做完的事、不写「待确认」「要不要」「下次再说」。',
    '   用户自己说的未来打算按「计划」记；其他一律不记。',
    '4. 保留用户原有的确定性级别。用户说「可能 / 大概 / 也许 / 不太确定」就保留这种不确定；',
    '   用户说「一定 / 必须 / 确定」就保留确定。不要把可能写成一定，也不要把一定写成可能。',
    '5. 助手结论也遵守第 4 条：助手说「大概是因为」就写「大概是因为」，不要写成确定原因。',
    '6. 保留可检索的具体信息：专有名词、数字、单位、路径、文件名、ID、型号、版本号、日期。',
    '7. 去掉寒暄、客套和纯口语填充：「帮我看看」「你说」「嗯」「麻烦」「一下吧」「能不能」。',
    '8. 每条【用户发言】块至少输出一行；同一块里有多个独立内容时可以拆成多行。',
    '',
    '示例 1：',
    '【用户发言】',
    '维生素 A 服用多少算过量？这个一粒含 5000 单位的维生素 A，我吃两粒会出什么问题吗？',
    '【助手发言】',
    '两粒合计 10,000 IU，一次性服用通常不会造成急性中毒……',
    '→ 提出问题：维生素 A 的过量服用量，以及一粒含 5000 单位时吃两粒的影响',
    '',
    '示例 2：',
    '【用户发言】',
    '盯一下 build-server-02 那台机器的部署进展，它干完活有了最终回答之后跟我说一声。',
    '【助手发言】',
    '那台机器 已经完成。根因是 transform 和入场动画冲突，改用 grid 居中后正常。',
    '→ 要求执行任务：监控 build-server-02 的部署，完成后回报最终结果',
    '→ 助手结论：build-server-02 部署失败的根因是端口被占用，改用 8081 后已修复',
    '',
    '示例 3：',
    '【用户发言】',
    '帮我看看从家里到最近的地铁站怎么走',
    '【助手发言】',
    '从家出发沿 xx 路到 xx 路口右转，全程约 15 分钟。',
    '→ 查询信息：从家里到最近地铁站的导航路线',
    '（路线是一次性的信息，不写助手结论）',
    '',
    '示例 4：',
    '【用户发言】',
    '以后所有报告都用中文。另外同事小王和我一起负责这个项目，下个月把 family agent 也迁过去。',
    '【助手发言】',
    '好的，都记下了。',
    '→ 偏好：以后所有报告使用中文',
    '→ 关系：同事小王和我一起负责这个项目',
    '→ 计划：下个月把 family agent 迁移过去',
  ].join('\n');

  return {
    systemPrompt,
    messages: [{ role: 'user', content: clipped }],
  };
}

/** 从头部截断（保留开头）。 */
function clipHead(text, limit) {
  if (!text) return '';
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[...内容过长已截断]`;
}

/** 从尾部截断（保留结尾 —— 结论通常在最后）。 */
function clipTail(text, limit) {
  if (!text) return '';
  if (text.length <= limit) return text;
  return `[...前文已省略]\n${text.slice(-limit)}`;
}

/**
 * 清掉描述里的控制字符和 HTML 注释。
 *
 * 描述最终进 markdown 记忆文件：换行会劈行，HTML 注释能藏内容。
 * 模型返回的是单行（解析时按 \n 切过），这里再兜一层。
 */
function sanitizeDescription(text) {
  return String(text ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * 解析模型输出，取出合法的记录行。
 *
 * 只认「<类别>：<描述>」这种一行一条的格式；前缀的 markdown 列表符号 /
 * 序号会被剥掉；不合法的行直接丢弃（宁可少一条，也不要写进错误内容）。
 *
 * @param {string} text 模型原始输出
 * @returns {Array<{kind:'behavior'|'fact'|'conclusion', category:string, desc:string}>}
 */
export function parseRecordLines(text) {
  const lines = String(text ?? '')
    .split('\n')
    .map((line) => line.trim().replace(/^[-*+]\s+/, '').replace(/^\d+[.)、]\s*/, '').trim())
    .filter(Boolean);

  const out = [];
  for (const line of lines) {
    if (line.startsWith(`${CONCLUSION_CATEGORY}：`)) {
      const desc = sanitizeDescription(line.slice(CONCLUSION_CATEGORY.length + 1));
      if (desc) out.push({ kind: 'conclusion', category: CONCLUSION_CATEGORY, desc });
      continue;
    }
    const category =
      BEHAVIOR_CATEGORIES.find((c) => line.startsWith(`${c}：`)) ??
      FACT_CATEGORIES.find((c) => line.startsWith(`${c}：`));
    if (!category) continue;
    const desc = sanitizeDescription(line.slice(category.length + 1));
    if (!desc) continue;
    out.push({
      kind: BEHAVIOR_CATEGORIES.includes(category) ? 'behavior' : 'fact',
      category,
      desc,
    });
  }
  return out;
}

/**
 * 模型全挂时的兜底：按关键词猜类别，描述用用户原话。
 *
 * 目的不是好看，而是**不丢用户行为** —— 记忆不能因为模型暂时不可用就消失。
 *
 * @param {string} text 用户原话
 * @returns {{kind:'behavior'|'fact', category:string, desc:string}}
 */
export function guessRecord(text) {
  const t = String(text ?? '').trim();
  const desc = t.replace(/\s+/g, ' ').slice(0, 160);

  const category = /不对|不是吧|错了|其实|我觉得不|再看看|不一定/.test(t)
    ? '反馈纠正'
    : /我(喜欢|讨厌|偏好|习惯)|以后|别再|不要|必须|要求/.test(t)
      ? '偏好'
      : /(儿子|女儿|老婆|老公|爸爸|妈妈|同事|朋友|搭档|伙伴|家人)/.test(t)
        ? '关系'
        : /下(个?月|周|年)|打算|准备|计划要|想要|准备做/.test(t)
          ? '计划'
          : /就(用|用这个|决定)|决定|定下来|以后就用|换成/.test(t)
            ? '决定'
            : /路线|导航|怎么走|在哪|地址|多少钱|几点|状态|进度|版本号/.test(t)
              ? '查询信息'
              : /帮.*(做|跑|改|写|查|看|加|删|装|部署|发布)|执行|部署|盯|监控|排查|调试|修|重启|推送|提交|下载|安装/.test(t)
                ? '要求执行任务'
                : '提出问题';

  const kind = BEHAVIOR_CATEGORIES.includes(category) ? 'behavior' : 'fact';
  return { kind, category, desc };
}

/**
 * 保证每条用户发言至少有一行记录。
 *
 * 模型可能漏写（少输出几行）—— 缺的部分用用户原话补上。
 * 模型通常按原顺序处理、从尾部漏，所以从末尾取用户发言来补。
 *
 * @param {Array<{kind:string}>} records 模型解析出的记录
 * @param {string[]} userTexts 用户发言列表
 * @returns {Array<object>} 补齐后的记录
 */
export function ensureUserCoverage(records, userTexts) {
  const userSide = (records ?? []).filter((r) => r.kind !== 'conclusion').length;
  const missing = (userTexts?.length ?? 0) - userSide;
  if (missing <= 0) return records;
  const fallbacks = userTexts.slice(-missing).map((text) => guessRecord(text));
  return [...records, ...fallbacks];
}

/**
 * 把记录行拼成最终写进记忆文件的内容。
 *
 * 用户名、agent 名、时间戳由插件提供，模型不碰 —— 它抄不对这些。
 *
 * @param {object} params
 * @param {Array<{kind:string,category:string,desc:string}>} params.records
 * @param {string} [params.userName] 用户显示名
 * @param {string} params.agentId agent id
 * @param {number} params.at 毫秒时间戳
 * @param {boolean} [params.answered] agent 是否有文字回复
 * @returns {string[]} 每行一条记录
 */
export function renderRecordLines({ records, userName, agentId, at, answered = true }) {
  const stamp = formatStamp(at);
  const day = stamp.slice(0, 10);
  const who = userName ? `[${userName}]` : '';
  const tail = answered ? '做出回答' : '开始处理';

  return (records ?? [])
    .filter((r) => r && r.desc)
    .map((r) => {
      if (r.kind === 'conclusion') {
        return `${CONCLUSION_CATEGORY}：${r.desc}，[${agentId} agent] 于 ${stamp} 完成`;
      }
      if (r.kind === 'fact') {
        return `${who}${r.category}：${r.desc}，${day} 说出`;
      }
      return `${who}${r.category}：${r.desc}，[${agentId} agent] 于 ${stamp} ${tail}`;
    });
}

/** 时间戳格式 YYYY-MM-DD HH:MM:SS。 */
export function formatStamp(at) {
  const d = at ? new Date(at) : new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/**
 * 压缩失败后的决策：继续重试，还是降级写原文。
 *
 * 纯函数，方便单测覆盖各种组合。
 *
 * @param {{attempts?: number}} item outbox 条目
 * @param {number} maxAttempts 上限
 * @returns {{action: 'retry'|'degrade', attempts: number, remaining: number}}
 */
export function decideSummaryOutcome(item, maxAttempts) {
  const attempts = (Number(item?.attempts) || 0) + 1;
  if (attempts >= maxAttempts) {
    return { action: 'degrade', attempts, remaining: 0 };
  }
  return { action: 'retry', attempts, remaining: maxAttempts - attempts };
}

/**
 * 降级正文：模型连续失败时，把用户原话按记录格式落盘。
 *
 * 目的不是"好看"，而是**不丢内容** —— 记忆不能因为模型暂时不可用就消失。
 *
 * @param {Array<{role:string,text:string}>} items
 * @param {number} attempts 已尝试次数
 * @returns {string}
 */
export function buildDegradedBody(items, attempts) {
  const userTexts = (items ?? [])
    .filter((item) => item.role === 'user')
    .map((item) => String(item.text ?? '').trim())
    .filter(Boolean);

  const lines = [
    `自动摘要失败（已尝试 ${attempts} 次，模型不可用），以下保留用户原始发言。`,
    '',
  ];
  for (const text of userTexts) {
    const r = guessRecord(text);
    lines.push(`${r.category}：${r.desc}`);
  }
  return lines.join('\n');
}

/**
 * 按 maxChars 截断正文。maxChars 未配置 ⇒ 不限制。
 * @param {string} text
 * @param {number|undefined} maxChars
 * @returns {string}
 */
export function clampSummaryText(text, maxChars) {
  const body = String(text ?? '');
  if (!maxChars || body.length <= maxChars) return body;
  return `${body.slice(0, maxChars)}\n[...已截断]`;
}

/**
 * 调模型生成摘要，失败自动换下一个候选。
 *
 * @param {object} params
 * @param {Array<string|undefined>} params.chain 候选链
 * @param {object} params.request buildSummaryRequest 的结果
 * @param {string} params.agentId
 * @param {string|undefined} params.reasoning
 * @param {number} params.timeoutMs
 * @param {(m: unknown) => Promise<any>} params.complete api.runtime.llm.complete
 * @param {(info: object) => void} [params.onAttempt]
 * @returns {Promise<{ok: boolean, text?: string, model?: string, provider?: string, attempts?: Array<object>, error?: string}>}
 */
export async function runSummary({
  chain,
  request,
  agentId,
  reasoning,
  timeoutMs,
  maxTokens,
  maxChars,
  complete,
  onAttempt,
}) {
  const attempts = [];
  for (const modelRef of chain) {
    const startedAt = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let result;
      try {
        result = await complete({
          messages: request.messages,
          systemPrompt: request.systemPrompt,
          model: modelRef,
          agentId,
          reasoning,
          purpose: 'better-auto-memory-openclaw summary',
          // 未配置 ⇒ 不传，让宿主用模型自己的默认上限
          ...(maxTokens ? { maxTokens } : {}),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      const text = String(result?.text ?? '').trim();
      const attempt = {
        model: modelRef ?? '(agent default)',
        provider: result?.provider,
        resolvedModel: result?.model,
        ok: Boolean(text),
        elapsedMs: Date.now() - startedAt,
      };
      attempts.push(attempt);
      onAttempt?.(attempt);

      if (text) {
        return { ok: true, text: clampSummaryText(text, maxChars), provider: result?.provider, model: result?.model, attempts };
      }
    } catch (error) {
      const attempt = {
        model: modelRef ?? '(agent default)',
        ok: false,
        elapsedMs: Date.now() - startedAt,
        error: String(error?.message ?? error),
      };
      attempts.push(attempt);
      onAttempt?.(attempt);
    }
  }
  return { ok: false, attempts, error: 'all candidates failed' };
}

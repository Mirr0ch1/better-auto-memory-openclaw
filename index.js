/**
 * better-auto-memory-openclaw —— OpenClaw 插件
 *
 * 目的：每轮对话结束后，把这一轮压成三类记录行，写进
 * <workspace>/memory/sessions/YYYY-MM-DD-<sessionSlug>.md，
 * 自动进入 memory-core 的索引，可被 memory_search / memory_get 检索。
 *
 * 记三类（2026-11-13 定稿）：
 *   - 行为：用户这一轮做了什么（提出问题/要求执行任务/查询信息/反馈纠正）
 *   - 事实：用户**明确说过**的偏好/关系/计划/决定
 *   - 结论：助手**实际完成**用户交代的任务后得出的**可复用**结论，标「助手结论：」
 * 不记：待办、没做完的事、一次性的结果。
 *
 * 事实只能来自用户发言；助手结论单独标注，召回时不会跟用户亲口说的混为一谈。
 * 用户名 / agent 名 / 时间戳由插件自己拼，模型不碰。
 *
 * 取代官方的两个机制（都往 memory/ 写 markdown）：
 *   - bundled session-memory：只在 /new / reset / auto-reset 时写，且写的是原文
 *   - compaction.memoryFlush：只在 compaction 前跑一次静默模型回合，依赖模型自己写
 *
 * 本插件**不动** embedding / memory_search / memory_get / memory-core 配置。
 *
 * 两段式：
 *   第一段 agent_end（同步、<10ms）：算增量 → 写 outbox → 立刻返回
 *   第二段 调度器：读 outbox → 调模型压缩 → 写 markdown → 删 outbox
 *   好处：不阻塞用户回复；Gateway 重启不丢数据。
 */

import { resolveUserName } from './lib/identity.js';
import { readConfig } from './lib/config.js';
import { extractDelta, deltaChars } from './lib/messages.js';
import { appendOutboxEntry, readOutbox, removeOutboxEntries, sessionSlug, updateOutboxAttempts } from './lib/outbox.js';
import { readWatermark, writeWatermark } from './lib/watermark.js';
import { buildCandidateChain, isModelOverrideAllowed } from './lib/candidates.js';
import {
  buildSummaryRequest,
  decideSummaryOutcome,
  ensureUserCoverage,
  guessRecord,
  parseRecordLines,
  renderRecordLines,
  runSummary,
} from './lib/summary.js';
import { applyRedact } from './lib/redact.js';
import { appendSummary, localTime, withProjectTag } from './lib/writer.js';
import { resolveProjectKey } from './lib/project.js';

const PLUGIN_ID = 'better-auto-memory-openclaw';

// 压缩失败最多重试几次；超过就降级写原文（不丢内容）
const MAX_SUMMARY_ATTEMPTS = 3;

// 自动化触发源：这些不该进「用户记忆」
// （实测 cron 运行确实会触发 agent_end；本机 56 个 cron + 30 分钟一次心跳）
const AUTOMATION_TRIGGERS = new Set(['cron', 'heartbeat', 'schedule', 'webhook', 'task']);

/** 取非空字符串，否则 undefined。 */
function pickString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export default function registerSessionNotes(api) {
  const cfg = readConfig(api.pluginConfig);
  const logger = api.logger ?? {};

  /**
   * 解析「谁」在提问 —— 写进记录行里。
   *
   * 细节和安全约束见 lib/identity.js：
   *   **只用可信来源** —— 运行者配置的显示名，或 senderId 的哈希。
   *   渠道自带的显示名是发送者可控的自由文本，绝不进可检索的长期记忆。
   */
  function resolveName(ctx) {
    return resolveUserName({
      userNames: cfg.userNames,
      agentId: ctx?.agentId,
      senderId: ctx?.senderId,
    });
  }

  function runtimeConfig() {
    try {
      return api.runtime?.config?.current?.() ?? {};
    } catch {
      return {};
    }
  }

  // ---- 启动自检：权限没配好会静默失效，这里主动 warn ----
  // 只在能读到 plugins.entries 时才判；CLI 的 cli-metadata 注册模式拿不到 runtime
  // config，那时报警是假阳性，会误导用户。
  try {
    const entries = runtimeConfig()?.plugins?.entries;
    const entry = entries?.[PLUGIN_ID];
    if (!entry) {
      // runtime config 不可用（CLI 元数据注册模式）⇒ 无法判断，跳过自检
    } else if (entry.hooks?.allowConversationAccess !== true) {
      logger.warn?.(
        '[better-auto-memory-openclaw] 缺少 plugins.entries.better-auto-memory-openclaw.hooks.allowConversationAccess=true —— agent_end 钩子不会被注册，功能不生效',
      );
    }
    if (entry?.llm?.allowAgentIdOverride !== true && entry) {
      logger.warn?.(
        '[better-auto-memory-openclaw] 缺少 plugins.entries.better-auto-memory-openclaw.llm.allowAgentIdOverride=true —— 无法按 agent 指定模型（会退化成 ambient owner）',
      );
    }
    if (entry?.llm?.allowModelOverride !== true && entry) {
      logger.warn?.(
        '[better-auto-memory-openclaw] 缺少 plugins.entries.better-auto-memory-openclaw.llm.allowModelOverride=true —— fallback 候选链里的显式模型会被宿主拒绝，只有 agent 默认模型可用',
      );
    }
  } catch (error) {
    logger.warn?.(`[better-auto-memory-openclaw] 启动自检失败: ${String(error?.message ?? error)}`);
  }

  // 本轮 drain 里待写回 outbox 的重试次数
  const pendingAttempts = new Map();

  /** 压缩并落盘单条记录。 */
  async function summarizeOne({ agentId, workspaceDir, item }) {
    const rcfg = runtimeConfig();

    // 用户指定的模型要先过授权检查（没授权就静默忽略，跟官方 team-reports 一致）
    let userModel = cfg.summarize.model;
    if (userModel && !isModelOverrideAllowed(rcfg, PLUGIN_ID)) {
      logger.warn?.('[better-auto-memory-openclaw] summarize.model 已配置但缺少 llm.allowModelOverride=true，已忽略该配置');
      userModel = undefined;
    }

    const chain = buildCandidateChain(rcfg, agentId, userModel);
    const request = buildSummaryRequest(item.items ?? [], {
      maxInputChars: cfg.summarize.maxInputChars,
      redact: cfg.summarize.redact,
    });

    // 用户发言块：一条用户发言 ⇒ 一条行为线索。
    const userTexts = (item.items ?? [])
      .filter((entry) => entry.role === 'user')
      .map((entry) => String(entry.text ?? '').trim())
      .filter(Boolean);

    // agent 这轮有没有文字回复（只有工具调用、没出文本时不能说「做出回答」）。
    const answered = (item.items ?? []).some(
      (entry) => entry.role === 'assistant' && String(entry.text ?? '').trim().length > 0,
    );

    let records;
    if (!cfg.summarize.enabled) {
      // 关闭压缩：直接用用户原话拼记录，不调模型
      records = userTexts.map((text) => guessRecord(text));
    } else {
      const result = await runSummary({
        chain,
        request,
        agentId,
        reasoning: cfg.summarize.reasoning,
        timeoutMs: cfg.summarize.timeoutMs,
        maxTokens: cfg.summarize.maxTokens,
        maxChars: cfg.summarize.maxChars,
        complete: (params) => api.runtime.llm.complete(params),
        onAttempt: (attempt) => {
          if (!attempt.ok) {
            logger.warn?.(
              `[better-auto-memory-openclaw] 模型 ${attempt.model} 失败: ${attempt.error ?? '空响应'}（${attempt.elapsedMs}ms）`,
            );
          }
        },
      });
      if (!result.ok) {
        // 全部候选都失败 → 计数 +1，超过上限就降级
        const outcome = decideSummaryOutcome(item, MAX_SUMMARY_ATTEMPTS);
        if (outcome.action === 'degrade') {
          logger.warn?.(
            `[better-auto-memory-openclaw] 连续 ${outcome.attempts} 次压缩失败，降级写用户原话: ${item.runId}`,
          );
          records = userTexts.map((text) => guessRecord(text));
        } else {
          logger.warn?.(
            `[better-auto-memory-openclaw] 候选模型全部失败（${outcome.attempts}/${MAX_SUMMARY_ATTEMPTS}），记录保留在 outbox 待重试: ${item.runId}`,
          );
          pendingAttempts.set(item.runId, outcome.attempts);
          return false;
        }
      } else {
        // 模型输出可能缺行（漏写/格式错）→ 每条用户发言至少要有一行，缺的用原话补齐。
        const parsed = parseRecordLines(result.text);
        if (!parsed.length) {
          logger.warn?.(
            `[better-auto-memory-openclaw] 模型输出不含合法记录行，改用用户原话: ${item.runId}`,
          );
        }
        records = parsed.length
          ? ensureUserCoverage(parsed, userTexts)
          : userTexts.map((text) => guessRecord(text));
      }
    }

    const body = renderRecordLines({
      records,
      userName: item.userName,
      agentId,
      at: item.at,
      answered,
    }).join('\n');

    let projectTag = '';
    if (cfg.summarize.includeProjectTag) {
      const key = resolveProjectKey(rcfg, workspaceDir);
      if (key) projectTag = withProjectTag('', key);
    }

    const written = appendSummary({
      workspaceDir,
      sessionSlug: sessionSlug(item.sessionKey ?? agentId),
      heading: `${item.heading ?? localTime(new Date(item.at ?? Date.now()))} 摘要`,
      body,
      runId: item.runId,
      projectTag,
    });

    if (written.appended) {
      logger.info?.(`[better-auto-memory-openclaw] 已写入 ${written.file}（run ${String(item.runId).slice(0, 8)}）`);
    }
    return true;
  }

  /** 处理所有 agent 的 outbox。 */
  async function drain(options = {}) {
    const deadline = options.deadlineMs ? Date.now() + options.deadlineMs : Infinity;
    const rcfg = runtimeConfig();
    let processed = 0;

    for (const agentId of cfg.agents) {
      const workspaceDir = rcfg?.agents?.entries?.[agentId]?.workspace;
      if (!workspaceDir) continue;

      const entries = readOutbox(workspaceDir);
      if (!entries.length) continue;

      const done = new Set();
      for (const item of entries) {
        if (Date.now() > deadline) break;
        if (!item?.items?.length) {
          done.add(item.runId);
          continue;
        }
        const ok = await summarizeOne({ agentId, workspaceDir, item });
        if (ok) done.add(item.runId);
      }
      if (done.size) removeOutboxEntries(workspaceDir, done);
      // 把失败条目的重试次数写回 outbox（跨重启累计）
      if (pendingAttempts.size) {
        updateOutboxAttempts(workspaceDir, new Map(pendingAttempts));
        pendingAttempts.clear();
      }
      processed += done.size;
    }

    if (processed) logger.info?.(`[better-auto-memory-openclaw] 本轮处理 ${processed} 条记录`);
    return processed;
  }

  // ---- 调度器引用 + 排程去重（agent_end 里要用来触发 drain）----
  let scheduler = null;
  let drainQueued = false;

  /**
   * 排一次 drain。
   *
   * ⚠️ delayMs 不能是 0：实测调度器的定时器需要一次真实 tick，
   * delayMs:0 的任务排进去后不会触发（2026-11-13 实测）。
   */
  function requestDrain() {
    if (!scheduler || drainQueued) return;
    drainQueued = true;
    try {
      scheduler.schedule({
        id: 'better-auto-memory-openclaw:drain',
        delayMs: 50,
        run: async () => {
          drainQueued = false;
          try {
            const n = await drain();
            if (n) logger.info?.(`[better-auto-memory-openclaw] drain 结束，处理 ${n} 条`);
          } catch (error) {
            logger.warn?.(`[better-auto-memory-openclaw] drain 失败: ${String(error?.message ?? error)}`);
          }
        },
      });
    } catch (error) {
      drainQueued = false;
      logger.warn?.(`[better-auto-memory-openclaw] 调度失败: ${String(error?.message ?? error)}`);
    }
  }

  // ---- 第一段：agent_end —— 只落盘，绝不调模型 ----
  api.on('agent_end', (event, ctx) => {
    try {
      if (!ctx || !cfg.agents.includes(ctx.agentId)) return;
      if (event?.success === false) return;
      if (AUTOMATION_TRIGGERS.has(ctx.trigger)) return;
      if (ctx.inputProvenance?.kind === 'internal_system') return;

      const workspaceDir = ctx.workspaceDir;
      if (!workspaceDir) return;

      const sessionKey = ctx.sessionKey ?? 'unknown';
      const watermark = readWatermark(workspaceDir, sessionKey);
      const delta = extractDelta(event.messages, watermark);

      if (!delta.items.length) return;

      if (deltaChars(delta.items) < cfg.summarize.minDeltaChars) {
        // 太短：跳过，但仍推进水位线，否则下轮会重复处理同一段
        writeWatermark(workspaceDir, sessionKey, delta.watermark);
        return;
      }

      // 先脱敏再落盘：outbox 是长期存在的文件，不能留明文凭据
      const items = delta.items.map((item) => ({
        role: item.role,
        text: applyRedact(item.text, cfg.summarize.redact),
        ...(item.key ? { key: item.key } : {}),
      }));

      appendOutboxEntry(workspaceDir, sessionKey, {
        runId: ctx.runId ?? `unknown-${Date.now()}`,
        at: Date.now(),
        heading: localTime(new Date()),
        agentId: ctx.agentId,
        sessionKey,
        userName: resolveName(ctx),
        items,
        paths: delta.paths,
        lastUserKey: delta.watermark.anchorKey,
      });

      writeWatermark(workspaceDir, sessionKey, delta.watermark);

      // 立刻排一次 drain（不然要等下次 Gateway 启动才会压）
      requestDrain();
    } catch (error) {
      logger.warn?.(`[better-auto-memory-openclaw] 写入 outbox 失败: ${String(error?.message ?? error)}`);
    }
  });

  // ---- 第二段：宿主调度器 —— 慢慢压缩 ----
  api.registerService({
    apiVersion: 2,
    id: PLUGIN_ID,
    start(ctx) {
      scheduler = ctx?.scheduler ?? null;
      logger.info?.(
        `[better-auto-memory-openclaw] service start；scheduler=${Boolean(scheduler)}；已启动（agents=${cfg.agents.join(',')}，summarize=${cfg.summarize.enabled ? 'on' : 'off'}，redact.secrets=${cfg.summarize.redact.secrets}，redact.pii=${cfg.summarize.redact.pii}）`,
      );
      // 启动时先压一次（重启前遗留的 outbox）
      requestDrain();
    },
    async stop(ctx) {
      try {
        await ctx?.scheduler?.stop?.();
      } catch {
        // 忽略
      }
      try {
        await drain({ deadlineMs: 4000 });
      } catch (error) {
        logger.warn?.(`[better-auto-memory-openclaw] 退出时 drain 失败: ${String(error?.message ?? error)}`);
      }
    },
  });
}

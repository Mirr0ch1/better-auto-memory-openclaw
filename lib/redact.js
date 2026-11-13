/**
 * 脱敏。两个独立开关：
 *   - secrets（默认开）：token / 密钥 / 账号密码 / 验证码
 *   - pii（默认关）：身份证 / 手机号 / 银行卡 / 住址
 *
 * 设计依据（2026-11-13 实测）：
 *   - OpenClaw 官方的 redactSensitiveText（openclaw/plugin-sdk/logging-core）能抓
 *     西文 key=value（password=xxx / api_key: xxx）和已知 token 前缀（sk- / ghp_ / AKIA ...）
 *   - 但**完全抓不到中文自然语言**：「我的密码是：xxx」「验证码是 xxx」「账号密码 admin/xxx」
 *     实测全部原样保留 ⇒ 必须自己加规则
 *   - 官方也不覆盖手机号 / 身份证 ⇒ PII 那部分自己实现
 *
 * 脱敏在**送模型之前**执行，所以云端模型也看不到敏感串。
 *
 * 关于宿主实现：官方有 redactSensitiveText（openclaw/plugin-sdk/logging-core），
 * 覆盖 95 条模式（vendor token 前缀 + 西文 key=value + Authorization 等），MIT 许可。
 * 但**拿不到**：
 *   - 它是 ESM 导出，只能用 import() 拿；而插件加载器用 require() 加载插件，
 *     require() 不能处理带 top-level await 的 ESM 图（实测 ERR_REQUIRE_ASYNC_MODULE），
 *     所以不能在模块顶层 await import()。
 *   - 用 createRequire 同步 require 一个纯 ESM 包也拿不到（ERR_REQUIRE_ESM）。
 * ⇒ 因此这里**自己实现**一份：把官方覆盖到的关键格式（vendor token 前缀、
 * 西文 key=value、Authorization、URL 内嵌凭据）+ **中文自然语言**（官方完全没有）
 * 全部写死。好处：行为确定、可单测、不依赖宿主内部结构、宿主升级不会突然变行为。
 */

// 本地实现：常见凭据格式。
// 覆盖官方 VENDOR_TOKEN_REDACT_PATTERNS 里实际会遇到的那些 +
// 西文 key=value + Authorization + URL 内嵌凭据。
const LOCAL_SECRET_PATTERNS = [
  // GitHub / OpenAI 风格
  /\b(?:sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}|gho_[A-Za-z0-9]{10,}|ghu_[A-Za-z0-9]{10,}|ghs_[A-Za-z0-9]{10,}|ghr_[A-Za-z0-9]{10,})\b/g,
  // GitLab / Slack / Google / Stripe / OpenAI / Anthropic
  /\b(?:glpat-[A-Za-z0-9._=-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|gsk_[A-Za-z0-9_-]{10,}|AIza[0-9A-Za-z_-]{20,}|npm_[A-Za-z0-9]{10,}|hf_[A-Za-z0-9]{10,}|sk_live_[A-Za-z0-9]{10,}|sk_test_[A-Za-z0-9]{10,}|pypi-[A-Za-z0-9_-]{10,})\b/g,
  // AWS
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  // JWT
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  // Telegram bot token
  /\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/g,
  // Authorization 头
  /(?<![A-Za-z0-9_])authorization(?![A-Za-z0-9_])\s*[:=]\s*["']?(?:Bearer|Basic|Bot)\s+[A-Za-z0-9_\-.=+/]{8,}["']?/gi,
  // URL 里内嵌的凭据 https://user:pass@host
  /\b(?:https?|wss?|ftp):\/\/[^\/\s:@]*:([^\/\s@]+)@/g,
];

/**
 * 引号包起来的字段名（JSON / YAML）：`"password": "value"`、`'token': 'value'`。
 *
 * 单独一条，因为通用规则要求「字段名后面紧跟 : 或 =」，
 * 而 JSON 的键名后面还隔着一个引号 —— `{"password": "x"}` 会整个漏过去。
 * （ClawHub 安全扫描对 0.1.1 报的就是这条）
 */
const QUOTED_SECRET_RE =
  /(["'])(api[_-]?key|access[_-]?key|secret[_-]?key|client[_-]?secret|private[_-]?key|password|passwd|passphrase|token|secret|auth[_-]?token|credential|authorization)(["']\s*[:=]\s*)(["'])((?:(?!\4)[^\\\n]){3,})(\4)/gi;

// api_key / access_key / secret 这类字段名（值要求 8 位以上）
const FIELD_SECRET_RE =
  /(?<![A-Za-z0-9_])(?:api[_-]?key|access[_-]?key|secret[_-]?key|client[_-]?secret|private[_-]?key)(?![A-Za-z0-9_])\s*[:=]\s*["']?[A-Za-z0-9_\-]{8,}["']?/gi;

// password / token / secret 这类字段名（值要求 4 位以上）
const FIELD_VALUE_RE =
  /(?<![A-Za-z0-9_])(?:password|passwd|passphrase|token|secret|auth[_-]?token|bearer)(?![A-Za-z0-9_])\s*[:=]\s*["']?[^\s"',;]{4,}["']?/gi;

function localRedactSecrets(text) {
  let out = String(text);

  // 厂商 token 前缀 / Authorization 头 / URL 内嵌凭据
  for (const re of LOCAL_SECRET_PATTERNS) {
    out = out.replace(re, (m) => {
      // 保留字段名（形如 "password="），只打码值
      const eq = m.indexOf('=');
      const colon = m.indexOf(':');
      let cut = -1;
      for (const idx of [eq, colon]) {
        if (idx >= 0 && (cut < 0 || idx < cut)) cut = idx;
      }
      if (cut >= 0) return `${m.slice(0, cut + 1)}***`;
      return '***';
    });
  }

  // 引号包起来的键先处理 —— 保留引号结构，只打码值
  out = out.replace(QUOTED_SECRET_RE, '$1$2$3$4***$6');

  // 西文字段名 + 分隔符
  for (const re of [FIELD_SECRET_RE, FIELD_VALUE_RE]) {
    out = out.replace(re, (m) => {
      // 保留字段名（形如 "password="），只打码值
      const eq = m.indexOf('=');
      const colon = m.indexOf(':');
      let cut = -1;
      for (const idx of [eq, colon]) {
        if (idx >= 0 && (cut < 0 || idx < cut)) cut = idx;
      }
      if (cut >= 0) return `${m.slice(0, cut + 1)}***`;
      return '***';
    });
  }
  return out;
}

// 中文场景里表示「凭据」的词。后面必须跟一个「是/为/:/：」和值。
const SECRET_LABEL =
  '(?:密码|口令|验证码|校验码|动态码|密钥|秘钥|凭证|凭据|密令|token|secret|passcode|password|passwd|otp|pin|api[_\\s-]?key|access[_\\s-]?key)';

// 「账号」「用户名」类标识
const ACCOUNT_LABEL =
  '(?:账号|帐号|账户|帐户|用户名|登录名|user(?:name)?|login|email|邮箱)';

// 中文规则：标签 + 分隔符 + 值 → 只保留标签
//
// 分成两组，因为两种写法结构不同：
//   A. 「密码：xxx」「密码是：xxx」「密码是: xxx」—— 标签后有分隔符（: = ： 是 为）
//   B. 「口令是 xxx」「验证码是 xxx」            —— 标签后直接跟值，中间是「是/为」
// 合成一条会漏掉 B（A 的分隔符必需）或误伤（「是」被当成值的一部分）。
const CN_SECRET_RE = new RegExp(
  `(${SECRET_LABEL})` +
    '([\\s]*(?:是|为)?[\\s]*(?:＝|=|:|：)[\\s]*)' +
    '("[^"\\n]{3,}"|\'[^\'\\n]{3,}\'|[^\\s，。,.;；\\n]{3,})',
  'gi',
);

const CN_SECRET_IS_RE = new RegExp(
  `(${SECRET_LABEL})([\\s]*(?:是|为)[\\s]*)` +
    '("[^"\\n]{3,}"|\'[^\'\\n]{3,}\'|[^\\s，。,.;；\\n]{3,})',
  'gi',
);

const CN_ACCOUNT_RE = new RegExp(
  `(${ACCOUNT_LABEL})` +
    '([\\s]*(?:是|为)?[\\s]*(?:＝|=|:|：)[\\s]*)' +
    '("[^"\\n]{2,}"|\'[^\'\\n]{2,}\'|[^\\s，。,.;；\\n]{2,})',
  'gi',
);

const CN_ACCOUNT_IS_RE = new RegExp(
  `(${ACCOUNT_LABEL})([\\s]*(?:是|为)[\\s]*)` +
    '("[^"\\n]{2,}"|\'[^\'\\n]{2,}\'|[^\\s，。,.;；\\n]{2,})',
  'gi',
);

// 「密码 xxx」这种没有「是」字但后面直接跟值的
const PASSWORD_TAIL_RE = new RegExp(
  '(密码|口令|验证码|密钥|秘钥|凭证|凭据|password|passwd|token|secret)' +
    '(\\s*[:：=＝]\\s*)' +
    '("[^"\\n]{3,}"|\'[^\'\\n]{3,}\'|[^\\s，。,.;；\\n]{3,})',
  'gi',
);

const MASK = '***';

/**
 * 中文规则层 —— 两条实现路径共用。
 * 官方 redactSensitiveText 完全抓不到这些（实测原样保留）。
 *
 * 顺序很关键：先跑「标签 + 分隔符」（A 形态），再跑「标签 + 是/为 + 值」（B 形态）。
 * 反过来的话，「密码是：xxx」会先被 B 匹配成「密码」+「是」+「：xxx」。
 */
function applyChineseSecretRules(text) {
  let out = text;
  // A 形态：标签 + 分隔符 + 值
  out = out.replace(CN_SECRET_RE, (_m, label, sep) => `${label}${sep}${MASK}`);
  out = out.replace(CN_ACCOUNT_RE, (_m, label, sep) => `${label}${sep}${MASK}`);
  // B 形态：标签 + 是/为 + 值
  out = out.replace(CN_SECRET_IS_RE, (_m, label, sep) => `${label}${sep}${MASK}`);
  out = out.replace(CN_ACCOUNT_IS_RE, (_m, label, sep) => `${label}${sep}${MASK}`);
  // 兜底：密码/口令后面直接跟值（即使没有「是」字，也没有分隔符）
  out = out.replace(PASSWORD_TAIL_RE, (_m, label, sep) => `${label}${sep}${MASK}`);
  return out;
}

/**
 * 凭据类脱敏（默认开）。
 *
 * = 西文/厂商格式层 + 中文规则层
 *
 * @param {string} text
 * @returns {string}
 */
export function redactSecrets(text) {
  if (!text) return '';
  return applyChineseSecretRules(localRedactSecrets(String(text)));
}

// 手机号（中国大陆）
const PHONE_RE = /(?<!\d)1[3-9]\d{9}(?!\d)/g;
// 身份证（18 位）
const ID_CARD_RE = /(?<![0-9A-Za-z])\d{17}[\dXx](?![0-9A-Za-z])/g;
// 银行卡 / 长数字串
const BANK_RE = /(?<!\d)\d{16,19}(?!\d)/g;
// 住址：省/市/区/县 + 路/街/号/栋/室
const ADDRESS_RE =
  /[\w一-龥]{2,4}(?:省|市|自治区|特别行政区)?[\w一-龥]{2,6}(?:区|县|市)[\w一-龥\d]{0,10}(?:路|街|道|号|栋|幢|单元|室|楼|院)/g;

/**
 * 真人身份信息脱敏（默认关）。
 * @param {string} text
 * @returns {string}
 */
export function redactPii(text) {
  if (!text) return text;
  let out = String(text);
  out = out.replace(ID_CARD_RE, '[身份证]');
  out = out.replace(BANK_RE, '[卡号]');
  out = out.replace(PHONE_RE, '[手机号]');
  out = out.replace(ADDRESS_RE, '[住址]');
  return out;
}

/**
 * 按开关执行脱敏。
 * @param {string} text
 * @param {{secrets?: boolean, pii?: boolean}} options
 * @returns {string}
 */
export function applyRedact(text, options = {}) {
  if (!text) return text;
  let out = String(text);
  if (options.secrets !== false) out = redactSecrets(out);
  if (options.pii === true) out = redactPii(out);
  return out;
}


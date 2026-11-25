/**
 * 上下文脱敏护栏（纯函数层，与 Rust `application::context::sanitize_context_text` 同源）。
 *
 * 停机红线护栏：严禁把本机密钥或环境变量混入上下文包。
 * 本模块仅做确定性文本/路径检测与替换，绝不读取 `process.env` 或任何宿主环境变量。
 */

export const REDACTED_SECRET_MARKER = '[REDACTED_SECRET]';

const SENSITIVE_BASENAMES = new Set([
  '.npmrc',
  '.pypirc',
  '.netrc',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'credentials.json',
  'secrets.json',
  'secrets.yaml',
  'secrets.yml',
  'secrets.toml',
  'service-account.json',
]);

const SENSITIVE_EXTENSIONS = ['.pem', '.key', '.p12', '.pfx', '.keystore'];

/** 判断相对路径是否属于密钥/环境变量敏感文件（绝不自动装入上下文包） */
export function isSensitiveSecretPath(filePath: string): boolean {
  const norm = filePath.replace(/\\/g, '/').toLowerCase();
  const base = norm.split('/').pop() ?? norm;
  if (
    base === '.env' ||
    (base.startsWith('.env.') &&
      !base.endsWith('.example') &&
      !base.endsWith('.sample') &&
      !base.endsWith('.template'))
  ) {
    return true;
  }
  if (SENSITIVE_BASENAMES.has(base)) return true;
  if (SENSITIVE_EXTENSIONS.some((ext) => base.endsWith(ext))) return true;
  return (
    norm.includes('/.ssh/') ||
    norm.startsWith('.ssh/') ||
    norm.includes('/.aws/') ||
    norm.startsWith('.aws/')
  );
}

const SENSITIVE_KEY_FRAGMENTS = [
  'API_KEY',
  'APIKEY',
  'API_SECRET',
  'ACCESS_KEY',
  'SECRET_KEY',
  'PRIVATE_KEY',
  'AUTH_TOKEN',
  'ACCESS_TOKEN',
  'REFRESH_TOKEN',
  'CLIENT_SECRET',
  'BEARER_TOKEN',
  'BOT_TOKEN',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'NPM_TOKEN',
  'OPENAI_KEY',
  'ANTHROPIC_KEY',
  'PASSWORD',
  'PASSWD',
  'DB_PASS',
  'CREDENTIAL',
  'SIGNING_SECRET',
  'WEBHOOK_SECRET',
  'ENCRYPTION_KEY',
  'MASTER_KEY',
];

function isSensitiveEnvKey(rawKey: string): boolean {
  const key = rawKey
    .trim()
    .replace(/^(?:export|set)\s+/i, '')
    .replace(/^["'`\-*\s]+|["'`\-*\s]+$/g, '')
    .toUpperCase();
  if (!key || key.length > 64) return false;
  if (!/^[A-Z0-9_.\-]+$/.test(key)) return false;
  if (SENSITIVE_KEY_FRAGMENTS.some((frag) => key.includes(frag))) return true;
  return key.endsWith('_SECRET') || key.endsWith('_TOKEN') || key === 'SECRET' || key === 'TOKEN';
}

function isPlaceholderValue(val: string): boolean {
  const v = val
    .trim()
    .replace(/^["'`,;\s]+|["'`,;\s]+$/g, '')
    .trim();
  if (!v) return true;
  const lower = v.toLowerCase();
  if (v === REDACTED_SECRET_MARKER) return true;
  if (/^[_*xX·.]+$/.test(v)) return true;
  if (lower.startsWith('<your') || lower.startsWith('${') || lower.startsWith('$env:')) return true;
  return ['null', 'none', 'false', 'true', 'changeme', 'example', 'placeholder', 'todo', 'redacted'].includes(lower);
}

const KNOWN_SECRET_TOKEN_RE =
  /(?<![A-Za-z0-9])(?:github_pat_[A-Za-z0-9_]{20,}|sk-(?:ant|proj|live)-[A-Za-z0-9_\-.+/=]{16,}|sk-[A-Za-z0-9_\-.+/=]{20,}|gh[pous]_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_\-]{16,}|xox[baprs]-[A-Za-z0-9\-]{12,}|AIza[A-Za-z0-9_\-]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16})/g;

const BEARER_TOKEN_RE = /Bearer ([A-Za-z0-9._~+/=-]{16,})/g;

const URL_CREDENTIALS_RE = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/\s"'@:]+:)([^/\s"'@]+)(@)/g;

function redactSensitiveKvLine(line: string): { line: string; hits: number } {
  for (const sep of ['=', ':'] as const) {
    const pos = line.indexOf(sep);
    if (pos <= 0) continue;
    const left = line.slice(0, pos);
    const right = line.slice(pos + 1);
    if (sep === ':' && right.startsWith('//')) continue;
    if (!isSensitiveEnvKey(left)) continue;
    const trimmedRight = right.trim();
    if (isPlaceholderValue(trimmedRight)) return { line, hits: 0 };
    const trailingComma = trimmedRight.endsWith(',') ? ',' : '';
    const quoted = trimmedRight.startsWith('"') || trimmedRight.startsWith("'");
    const spacer = right.startsWith(' ') ? ' ' : '';
    const replacement = quoted
      ? `${left}${sep}${spacer}"${REDACTED_SECRET_MARKER}"${trailingComma}`
      : `${left}${sep}${spacer}${REDACTED_SECRET_MARKER}${trailingComma}`;
    return { line: replacement, hits: 1 };
  }
  return { line, hits: 0 };
}

/** 确定性密钥/环境变量脱敏器（与 Rust 端逐规则同源） */
export function sanitizeContextText(input: string): { text: string; redactedCount: number } {
  if (!input) return { text: '', redactedCount: 0 };
  let redactedCount = 0;
  const outLines: string[] = [];
  let inPemBlock = false;

  for (const rawLine of input.split('\n')) {
    const trimmed = rawLine.trim();
    if (inPemBlock) {
      if (trimmed.startsWith('-----END ') && trimmed.includes('PRIVATE KEY-----')) {
        inPemBlock = false;
      }
      continue;
    }
    if (trimmed.startsWith('-----BEGIN ') && trimmed.includes('PRIVATE KEY-----')) {
      inPemBlock = true;
      redactedCount += 1;
      outLines.push(REDACTED_SECRET_MARKER);
      continue;
    }

    const kv = redactSensitiveKvLine(rawLine);
    let line = kv.line;
    redactedCount += kv.hits;

    line = line.replace(URL_CREDENTIALS_RE, (_m, prefix: string, pass: string, at: string) => {
      if (pass === REDACTED_SECRET_MARKER) return `${prefix}${pass}${at}`;
      redactedCount += 1;
      return `${prefix}${REDACTED_SECRET_MARKER}${at}`;
    });

    line = line.replace(BEARER_TOKEN_RE, (_m, tok: string) => {
      if (tok === REDACTED_SECRET_MARKER) return `Bearer ${tok}`;
      redactedCount += 1;
      return `Bearer ${REDACTED_SECRET_MARKER}`;
    });

    line = line.replace(KNOWN_SECRET_TOKEN_RE, () => {
      redactedCount += 1;
      return REDACTED_SECRET_MARKER;
    });

    outLines.push(line);
  }
  return { text: outLines.join('\n'), redactedCount };
}

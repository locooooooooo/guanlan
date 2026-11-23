/**
 * HTML 沙盒渲染预处理纯函数层（零 DOM 依赖，Node/SSR 可直接单测）。
 *
 * 安全红线：
 * 1. 所有 HTML 渲染一律运行在无 `allow-same-origin` 的隔离 `<iframe sandbox>` 中（不透明 `null` 源），
 *    宿主窗口、`window.__TAURI_INTERNALS__`、本地存储与本地 127.0.0.1 API 均不可触达；
 * 2. 默认注入离线 CSP（`default-src 'none'; connect-src data: blob:; form-action 'none'; base-uri 'none'`），
 *    拦截所有外部网络请求；用户显式勾选「允许 HTTPS 外链」时仅放开 `https:`（仍封锁 `http://127.0.0.1`）；
 * 3. 版本忠实原则：仅在查看文件当前最新版本时按需解析同工作区相对资源（图片走去重快照 raw URL，
 *    本地样式/经典脚本由调用方按快照读取后安全内联）；历史版本绝不混入磁盘当前资源。
 */

import type { FileRecord } from '../types/guanlan';
import { isPreviewableImageFormat, normalizeFormatToken } from './formatMeta';

export const MAX_INLINE_HTML_ASSET_BYTES = 512 * 1024;
export const MAX_INLINE_HTML_ASSET_COUNT = 8;

export interface HtmlFeatureSummary {
  /** 是否包含 <script> 标签或内联事件处理器 */
  hasScript: boolean;
  /** 是否包含 <canvas>（常见于 2D/3D 绘制、图表、WebGL） */
  hasCanvasOrWebgl: boolean;
  /** 是否包含 <script type="module" src="...">（需完整本地目录或服务运行） */
  hasExternalModuleScript: boolean;
  /** 检测到的外部 http(s):// / // 资源地址（不含普通 <a href> 超链接） */
  externalUrls: string[];
}

export interface LocalInlineAssetTarget {
  kind: 'stylesheet' | 'script';
  rawRef: string;
  normalizedPath: string;
  fileId: string;
  revisionId: string;
  sizeBytes: number;
}

export interface HtmlSandboxOptions {
  /** 是否允许沙盒内执行脚本（始终不含 allow-same-origin） */
  allowScripts: boolean;
  /** 是否允许加载外部 HTTPS 资源（如 CDN 样式/脚本/字体/图片） */
  allowExternalHttps: boolean;
  /** 当前 HTML 文件的工作区相对路径（仅当前最新版本传入，用于解析相对资源） */
  relativePath?: string;
  /** 工作区文件表（仅当前最新版本传入，用于解析相对图片与辅助资源） */
  workspaceFiles?: readonly FileRecord[];
  /** 将 revision_id 转为可读 raw URL（默认需为绝对 URL 或经 fallbackOrigin 补全） */
  resolveRevisionRawUrl?: (revisionId: string) => string;
  /** 当 resolveRevisionRawUrl 返回相对路径（同源浏览器模式）时用于拼成绝对 URL 的 origin */
  fallbackOrigin?: string;
  /** 已预取的同工作区文本资源正文（key 为归一化小写相对路径，供内联本地 CSS / 经典 JS） */
  inlinedAssets?: Readonly<Record<string, string>>;
}

export interface PreparedHtmlDocument {
  srcDoc: string;
  sandboxAttr: string;
  cspContent: string;
  features: HtmlFeatureSummary;
  resolvedLocalAssetCount: number;
  unresolvedLocalAssets: string[];
}

interface HtmlSegment {
  kind: 'markup' | 'comment' | 'script' | 'style';
  text: string;
}

/**
 * 线性 O(n) 切分 HTML 为普通标记、注释、<script> 与 <style> 四类片段，
 * 确保标记重写不会误伤脚本字符串或注释文本。
 */
function scanHtmlSegments(html: string): HtmlSegment[] {
  const segments: HtmlSegment[] = [];
  const lower = html.toLowerCase();
  const len = html.length;
  let pos = 0;
  let markupStart = 0;

  const flushMarkup = (end: number) => {
    if (end > markupStart) {
      segments.push({ kind: 'markup', text: html.slice(markupStart, end) });
    }
  };

  while (pos < len) {
    const lt = html.indexOf('<', pos);
    if (lt < 0) break;

    if (lower.startsWith('<!--', lt)) {
      flushMarkup(lt);
      const closeIdx = html.indexOf('-->', lt + 4);
      const end = closeIdx >= 0 ? closeIdx + 3 : len;
      segments.push({ kind: 'comment', text: html.slice(lt, end) });
      pos = end;
      markupStart = end;
      continue;
    }

    if (
      lower.startsWith('<script', lt) &&
      (lt + 7 >= len || /[\s/>]/.test(html[lt + 7]))
    ) {
      flushMarkup(lt);
      const openEnd = html.indexOf('>', lt + 7);
      if (openEnd < 0) {
        segments.push({ kind: 'script', text: html.slice(lt) });
        pos = len;
        markupStart = len;
        break;
      }
      const closeTag = lower.indexOf('</script', openEnd + 1);
      const end =
        closeTag >= 0
          ? (() => {
              const gt = html.indexOf('>', closeTag + 8);
              return gt >= 0 ? gt + 1 : len;
            })()
          : len;
      segments.push({ kind: 'script', text: html.slice(lt, end) });
      pos = end;
      markupStart = end;
      continue;
    }

    if (
      lower.startsWith('<style', lt) &&
      (lt + 6 >= len || /[\s/>]/.test(html[lt + 6]))
    ) {
      flushMarkup(lt);
      const openEnd = html.indexOf('>', lt + 6);
      if (openEnd < 0) {
        segments.push({ kind: 'style', text: html.slice(lt) });
        pos = len;
        markupStart = len;
        break;
      }
      const closeTag = lower.indexOf('</style', openEnd + 1);
      const end =
        closeTag >= 0
          ? (() => {
              const gt = html.indexOf('>', closeTag + 7);
              return gt >= 0 ? gt + 1 : len;
            })()
          : len;
      segments.push({ kind: 'style', text: html.slice(lt, end) });
      pos = end;
      markupStart = end;
      continue;
    }

    pos = lt + 1;
  }

  flushMarkup(len);
  return segments;
}

function normalizeWorkspacePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

function stripQueryAndHash(ref: string): string {
  let out = ref.trim();
  const hashIdx = out.indexOf('#');
  if (hashIdx >= 0) out = out.slice(0, hashIdx);
  const queryIdx = out.indexOf('?');
  if (queryIdx >= 0) out = out.slice(0, queryIdx);
  return out.trim();
}

export function isExternalHttpUrl(ref: string): boolean {
  const trimmed = ref.trim();
  return /^(?:https?:)?\/\//i.test(trimmed);
}

/**
 * 将 HTML 中的相对路径引用解析为工作区相对路径；
 * 跳过外部 URL、data:/blob:、根路径 `/` 或越出工作区顶层的 `..`。
 */
export function resolveRelativeAssetPath(
  htmlRelativePath: string,
  rawRef: string
): string | null {
  const trimmed = rawRef.trim();
  if (!trimmed) return null;
  if (
    /^(?:https?:|data:|blob:|mailto:|tel:|javascript:|file:|about:|#)/i.test(trimmed) ||
    trimmed.startsWith('//') ||
    trimmed.startsWith('/')
  ) {
    return null;
  }

  let cleaned = stripQueryAndHash(trimmed);
  if (!cleaned) return null;
  try {
    cleaned = decodeURIComponent(cleaned);
  } catch {
    // 保留原样继续解析
  }

  const baseNorm = normalizeWorkspacePath(htmlRelativePath);
  const baseParts = baseNorm.split('/');
  baseParts.pop(); // 去掉当前 HTML 文件名，仅留所在目录

  const relParts = cleaned.replace(/\\/g, '/').split('/');
  const resolved = [...baseParts];
  for (const part of relParts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (resolved.length === 0) return null;
      resolved.pop();
    } else {
      resolved.push(part);
    }
  }
  return resolved.length > 0 ? resolved.join('/') : null;
}

function extractAttr(tagOpen: string, attrName: string): string | null {
  const re = new RegExp(
    `(?:^|[\\s/])${attrName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\\x60]+))`,
    'i'
  );
  const m = re.exec(tagOpen);
  if (!m) return null;
  return (m[1] ?? m[2] ?? m[3] ?? '').trim();
}

function replaceAttrValue(tagOpen: string, attrName: string, nextValue: string): string {
  const escaped = nextValue.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  const re = new RegExp(
    `((?:^|[\\s/])${attrName}\\s*=\\s*)(?:"[^"]*"|'[^']*'|[^\\s"'=<>\\x60]+)`,
    'i'
  );
  return tagOpen.replace(re, `$1"${escaped}"`);
}

function parseOpeningTag(segmentText: string): { openTag: string; rest: string } {
  const gt = segmentText.indexOf('>');
  if (gt < 0) return { openTag: segmentText, rest: '' };
  return { openTag: segmentText.slice(0, gt + 1), rest: segmentText.slice(gt + 1) };
}

function buildFileLookup(
  workspaceFiles?: readonly FileRecord[]
): Map<string, FileRecord> {
  const map = new Map<string, FileRecord>();
  if (!workspaceFiles) return map;
  for (const f of workspaceFiles) {
    const key = normalizeWorkspacePath(f.relative_path).toLowerCase();
    if (!map.has(key)) map.set(key, f);
  }
  return map;
}

function getCurrentRevisionSnapshot(file: FileRecord) {
  const rev =
    file.revisions.find((r) => r.revision_id === file.current_revision_id) ??
    file.revisions[file.revisions.length - 1];
  if (!rev || !rev.snapshotAvailable) return null;
  return rev;
}

/**
 * 扫描 HTML 特性：是否含脚本、Canvas/WebGL、外部资源 URL 与模块脚本。
 */
export function inspectHtmlFeatures(rawHtml: string): HtmlFeatureSummary {
  const segments = scanHtmlSegments(rawHtml);
  let hasScript = false;
  let hasCanvasOrWebgl = false;
  let hasExternalModuleScript = false;
  const externalSet = new Set<string>();

  for (const seg of segments) {
    if (seg.kind === 'comment') continue;

    if (seg.kind === 'script') {
      hasScript = true;
      const { openTag } = parseOpeningTag(seg.text);
      const src = extractAttr(openTag, 'src');
      const typeAttr = (extractAttr(openTag, 'type') ?? '').toLowerCase();
      if (src) {
        if (isExternalHttpUrl(src)) {
          externalSet.add(src);
        } else if (typeAttr === 'module') {
          hasExternalModuleScript = true;
        }
      }
      if (typeAttr === 'importmap') {
        const mapUrlRe = /["'](https?:\/\/[^"'\s]+)["']/gi;
        let mm: RegExpExecArray | null;
        while ((mm = mapUrlRe.exec(seg.text)) !== null) {
          externalSet.add(mm[1]);
        }
      } else if (typeAttr === 'module') {
        const esmRe = /(?:from\s+|import\s*\(\s*|import\s+)['"](https?:\/\/[^'"\s]+)['"]/gi;
        let em: RegExpExecArray | null;
        while ((em = esmRe.exec(seg.text)) !== null) {
          externalSet.add(em[1]);
        }
      }
      if (/getContext\s*\(\s*['"](?:2d|webgl|webgl2|webgpu)['"]/i.test(seg.text)) {
        hasCanvasOrWebgl = true;
      }
      continue;
    }

    if (seg.kind === 'style') {
      const urlRe = /url\(\s*(['"]?)([^'")]+)\1\s*\)|@import\s+(?:url\(\s*)?['"]([^'"]+)['"]/gi;
      let m: RegExpExecArray | null;
      while ((m = urlRe.exec(seg.text)) !== null) {
        const ref = (m[2] ?? m[3] ?? '').trim();
        if (ref && isExternalHttpUrl(ref)) externalSet.add(ref);
      }
      continue;
    }

    // markup 片段
    if (/<canvas(?:[\s/>]|$)/i.test(seg.text)) {
      hasCanvasOrWebgl = true;
    }
    if (/\son[a-z]+\s*=/i.test(seg.text)) {
      hasScript = true;
    }

    const tagRe = /<(img|link|iframe|source|audio|video|object|embed)\b[^>]*>/gi;
    let tm: RegExpExecArray | null;
    while ((tm = tagRe.exec(seg.text)) !== null) {
      const tagName = tm[1].toLowerCase();
      const tagStr = tm[0];
      if (tagName === 'link') {
        const rel = (extractAttr(tagStr, 'rel') ?? '').toLowerCase();
        if (
          rel &&
          ['canonical', 'alternate', 'author', 'prev', 'next', 'license', 'help'].some((r) =>
            rel.split(/\s+/).includes(r)
          )
        ) {
          continue;
        }
      }
      const ref = tagName === 'link' ? extractAttr(tagStr, 'href') : extractAttr(tagStr, 'src');
      if (ref && isExternalHttpUrl(ref)) {
        externalSet.add(ref);
      }
    }
  }

  return {
    hasScript,
    hasCanvasOrWebgl,
    hasExternalModuleScript,
    externalUrls: Array.from(externalSet),
  };
}

/**
 * 收集 HTML 中引用的、存在于同工作区的相对 CSS 样式表与经典 JS 脚本目标，
 * 供阅读器在查看最新版本时按需预取并安全内联进沙盒文档。
 */
export function collectLocalInlineAssetTargets(
  rawHtml: string,
  htmlRelativePath: string | undefined,
  workspaceFiles?: readonly FileRecord[]
): LocalInlineAssetTarget[] {
  if (!htmlRelativePath || !workspaceFiles || workspaceFiles.length === 0) return [];
  const fileMap = buildFileLookup(workspaceFiles);
  const segments = scanHtmlSegments(rawHtml);
  const seen = new Set<string>();
  const targets: LocalInlineAssetTarget[] = [];

  const tryPush = (kind: 'stylesheet' | 'script', rawRef: string) => {
    if (targets.length >= MAX_INLINE_HTML_ASSET_COUNT) return;
    const resolved = resolveRelativeAssetPath(htmlRelativePath, rawRef);
    if (!resolved) return;
    const key = resolved.toLowerCase();
    if (seen.has(key)) return;
    const file = fileMap.get(key);
    if (!file) return;
    const rev = getCurrentRevisionSnapshot(file);
    if (!rev) return;
    if (rev.sizeBytes > MAX_INLINE_HTML_ASSET_BYTES) return;
    seen.add(key);
    targets.push({
      kind,
      rawRef,
      normalizedPath: key,
      fileId: file.file_id,
      revisionId: rev.revision_id,
      sizeBytes: rev.sizeBytes,
    });
  };

  for (const seg of segments) {
    if (seg.kind === 'script') {
      const { openTag } = parseOpeningTag(seg.text);
      const src = extractAttr(openTag, 'src');
      const typeAttr = (extractAttr(openTag, 'type') ?? '').toLowerCase();
      if (src && typeAttr !== 'module') {
        tryPush('script', src);
      }
      continue;
    }
    if (seg.kind === 'markup') {
      const linkRe = /<link\b[^>]*>/gi;
      let lm: RegExpExecArray | null;
      while ((lm = linkRe.exec(seg.text)) !== null) {
        const rel = (extractAttr(lm[0], 'rel') ?? '').toLowerCase();
        const href = extractAttr(lm[0], 'href');
        if (href && rel.split(/\s+/).includes('stylesheet')) {
          tryPush('stylesheet', href);
        }
      }
    }
  }

  return targets;
}

function toAbsoluteUrlForSrcDoc(rawUrl: string, fallbackOrigin?: string): string {
  if (/^https?:\/\//i.test(rawUrl)) return rawUrl;
  if (rawUrl.startsWith('/')) {
    const origin =
      fallbackOrigin ??
      (typeof window !== 'undefined' &&
      window.location?.origin &&
      window.location.origin !== 'null'
        ? window.location.origin
        : '');
    if (origin) return `${origin.replace(/\/+$/, '')}${rawUrl}`;
  }
  return rawUrl;
}

function extractRevisionPrefixForCsp(absoluteUrl: string): string | null {
  try {
    const u = new URL(absoluteUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `${u.origin}/api/v1/revisions/`;
  } catch {
    return null;
  }
}

function injectMetaIntoHead(html: string, metaTag: string): string {
  const segments = scanHtmlSegments(html);
  // 1) 在未进入 <body> / <script> 之前查找真实的 <head ...>
  let offset = 0;
  for (const seg of segments) {
    if (seg.kind === 'comment') {
      offset += seg.text.length;
      continue;
    }
    if (seg.kind === 'script' || seg.kind === 'style') {
      break;
    }
    const bodyMatch = /<body(?:[\s>]|$)/i.exec(seg.text);
    const headMatch = /<head(?:\s[^>]*)?>/i.exec(seg.text);
    if (headMatch && (!bodyMatch || headMatch.index < bodyMatch.index)) {
      const insertAt = offset + headMatch.index + headMatch[0].length;
      return `${html.slice(0, insertAt)}\n${metaTag}\n${html.slice(insertAt)}`;
    }
    const htmlMatch = /<html(?:\s[^>]*)?>/i.exec(seg.text);
    if (htmlMatch && (!bodyMatch || htmlMatch.index < bodyMatch.index)) {
      const insertAt = offset + htmlMatch.index + htmlMatch[0].length;
      return `${html.slice(0, insertAt)}\n<head><meta charset="utf-8">${metaTag}</head>\n${html.slice(insertAt)}`;
    }
    if (bodyMatch) break;
    offset += seg.text.length;
  }

  // 2) HTML 片段（无 <html>/<head>）：补齐标准 HTML5 壳并置入 CSP
  return `<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n${metaTag}\n</head>\n<body>\n${html}\n</body>\n</html>`;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/**
 * 构建可安全塞入 `<iframe sandbox="..." srcDoc="...">` 的 HTML 文档。
 */
export function buildHtmlSandboxDocument(
  rawHtml: string,
  options: HtmlSandboxOptions
): PreparedHtmlDocument {
  const features = inspectHtmlFeatures(rawHtml);
  const fileMap = buildFileLookup(options.workspaceFiles);
  const inlinedAssets = options.inlinedAssets ?? {};
  const localImgCspPrefixes = new Set<string>();
  const unresolvedSet = new Set<string>();
  let resolvedLocalAssetCount = 0;

  const segments = scanHtmlSegments(rawHtml);
  const rewrittenParts: string[] = [];

  for (const seg of segments) {
    if (seg.kind === 'comment' || seg.kind === 'style') {
      rewrittenParts.push(seg.text);
      continue;
    }

    if (seg.kind === 'script') {
      const { openTag } = parseOpeningTag(seg.text);
      const src = extractAttr(openTag, 'src');
      const typeAttr = (extractAttr(openTag, 'type') ?? '').toLowerCase();
      if (src && !isExternalHttpUrl(src) && options.relativePath) {
        const resolved = resolveRelativeAssetPath(options.relativePath, src);
        if (resolved) {
          const key = resolved.toLowerCase();
          if (typeAttr !== 'module' && typeof inlinedAssets[key] === 'string') {
            const safeJs = inlinedAssets[key].replace(/<\/(script)/gi, '<\\/$1');
            rewrittenParts.push(
              `<script data-guanlan-inlined="${escapeAttribute(resolved)}">\n${safeJs}\n</script>`
            );
            resolvedLocalAssetCount += 1;
            continue;
          }
          unresolvedSet.add(src);
        }
      }
      rewrittenParts.push(seg.text);
      continue;
    }

    // markup 片段：移除 <base>、内联相对 <link rel="stylesheet">、重写相对 <img/source src>
    let markup = seg.text.replace(/<base\b[^>]*>/gi, '');

    if (options.relativePath) {
      markup = markup.replace(/<link\b[^>]*>/gi, (tag) => {
        const rel = (extractAttr(tag, 'rel') ?? '').toLowerCase();
        const href = extractAttr(tag, 'href');
        if (!href || !rel.split(/\s+/).includes('stylesheet') || isExternalHttpUrl(href)) {
          return tag;
        }
        const resolved = resolveRelativeAssetPath(options.relativePath!, href);
        if (!resolved) return tag;
        const key = resolved.toLowerCase();
        if (typeof inlinedAssets[key] === 'string') {
          const safeCss = inlinedAssets[key].replace(/<\/(style)/gi, '<\\/$1');
          resolvedLocalAssetCount += 1;
          return `<style data-guanlan-inlined="${escapeAttribute(resolved)}">\n${safeCss}\n</style>`;
        }
        unresolvedSet.add(href);
        return tag;
      });

      markup = markup.replace(/<(img|source)\b[^>]*>/gi, (tag) => {
        const src = extractAttr(tag, 'src');
        if (!src || isExternalHttpUrl(src)) return tag;
        const resolved = resolveRelativeAssetPath(options.relativePath!, src);
        if (!resolved) return tag;
        const file = fileMap.get(resolved.toLowerCase());
        const rev = file ? getCurrentRevisionSnapshot(file) : null;
        const fmt = file ? normalizeFormatToken(file.format) : '';
        if (
          file &&
          rev &&
          options.resolveRevisionRawUrl &&
          (isPreviewableImageFormat(fmt) || fmt === 'svg')
        ) {
          const rawUrl = options.resolveRevisionRawUrl(rev.revision_id);
          const absUrl = toAbsoluteUrlForSrcDoc(rawUrl, options.fallbackOrigin);
          const prefix = extractRevisionPrefixForCsp(absUrl);
          if (prefix) localImgCspPrefixes.add(prefix);
          resolvedLocalAssetCount += 1;
          return replaceAttrValue(tag, 'src', absUrl);
        }
        unresolvedSet.add(src);
        return tag;
      });
    }

    rewrittenParts.push(markup);
  }

  const extHttps = options.allowExternalHttps ? ' https:' : '';
  const localImgCsp =
    localImgCspPrefixes.size > 0 ? ` ${Array.from(localImgCspPrefixes).join(' ')}` : '';
  const scriptSrc = options.allowScripts
    ? `'unsafe-inline' 'unsafe-eval' data: blob:${extHttps}`
    : "'none'";
  const workerSrc = options.allowScripts ? 'blob:' : "'none'";

  const cspContent = [
    "default-src 'none'",
    `style-src 'unsafe-inline' data: blob:${extHttps}`,
    `script-src ${scriptSrc}`,
    `img-src data: blob:${extHttps}${localImgCsp}`,
    `font-src data: blob:${extHttps}`,
    `media-src data: blob:${extHttps}`,
    `connect-src data: blob:${extHttps}`,
    `worker-src ${workerSrc}`,
    `child-src ${workerSrc}`,
    "frame-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');

  const metaTag = `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(cspContent)}">`;
  const srcDoc = injectMetaIntoHead(rewrittenParts.join(''), metaTag);

  return {
    srcDoc,
    sandboxAttr: options.allowScripts ? 'allow-scripts' : '',
    cspContent,
    features,
    resolvedLocalAssetCount,
    unresolvedLocalAssets: Array.from(unresolvedSet).slice(0, 12),
  };
}

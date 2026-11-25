/**
 * 观澜 · 品牌口径与司辰叙事单一真相源（SSOT）。
 *
 * 纯常量模块，禁止导入 React 或 .css，以便 node:test 直接导入核验。
 * 全站（顶栏、首页问候头、桌面首启引导、设置关于页、文档标题、安装包描述、README）共享此处口径，
 * 与桌面壳图标（native/crates/guanlan-desktop/gen-icon.mjs）及官方矢量标（public/guanlan-logo.svg）
 * 同承司辰「曜石银匣文件夹 + 弧形银翼 + 折耳朱砂眼与流沙漏」母题。
 */

export const BRAND_NAME = '观澜';
export const BRAND_NAME_EN = 'Guanlan';

/** 核心 Slogan（8 字四四对仗：司辰记时，观澜见脉） */
export const BRAND_SLOGAN = '司辰记时，观澜见脉';

/** 首页、首启引导与关于页副句：直接呼应「文件夹 + 沙漏」产品承诺，具体无虚词 */
export const BRAND_SLOGAN_NOTE = '档案在本地，每次改动与拍板都有迹可循';

/** 核心 Slogan + 副句完整单行表达 */
export const BRAND_SLOGAN_EXTENDED = `${BRAND_SLOGAN} · ${BRAND_SLOGAN_NOTE}`;

/** 英文版 Slogan 与副句（对应 README.en.md） */
export const BRAND_SLOGAN_EN = 'Chronos keeps time. Guanlan reveals the trace.';
export const BRAND_SLOGAN_NOTE_EN = 'Your folders stay local — every change and decision stays traceable.';
export const BRAND_SLOGAN_EXTENDED_EN = `${BRAND_SLOGAN_EN} ${BRAND_SLOGAN_NOTE_EN}`;

/** 浏览器标题 / 桌面安装包描述统一口径 */
export const BRAND_TITLE_FULL = `${BRAND_NAME} ${BRAND_NAME_EN} · ${BRAND_SLOGAN}`;
export const BRAND_SHORT_DESCRIPTION = `${BRAND_NAME}（${BRAND_NAME_EN}）— ${BRAND_SLOGAN} · 档案在本地的文件工作台`;
export const BRAND_LONG_DESCRIPTION = `${BRAND_SLOGAN}。${BRAND_SLOGAN_NOTE}：本地优先、零锁定的全格式文件时间线、决定证据锚定、离线事项胶囊与多智能体 MCP 安全上下文基座。`;

/** 司辰图标的完整视觉元描述（供 aria/文档核对，不随装饰漂移） */
export const BRAND_ICON_MOTIF =
  '司辰翼漏银匣徽（透明底曜石缎面文件夹、折耳权杖朱砂眼、温润象牙夹页、对称拉丝银翼与铂银朱砂流沙漏）';

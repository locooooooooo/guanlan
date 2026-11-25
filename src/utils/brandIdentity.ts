/**
 * 观澜 · 品牌口径与司辰叙事单一真相源（SSOT）。
 *
 * 纯常量模块，禁止导入 React 或 .css，以便 node:test 直接导入核验。
 * 全站（顶栏、首页问候头、桌面首启引导、设置关于页、文档标题）共享此处口径，
 * 与桌面壳图标（native/crates/guanlan-desktop/gen-icon.mjs）同承司辰「曜石银匣文件夹 + 弧形银翼 + 朱砂眼与流沙漏」母题。
 */

export const BRAND_NAME = '观澜';
export const BRAND_NAME_EN = 'Guanlan';

/** 核心 Slogan（8 字四四对仗：司辰记时，观澜见脉） */
export const BRAND_SLOGAN = '司辰记时，观澜见脉';

/** 首页与介绍页展宽副句：承接核心 Slogan，落回版本演变与拍板依据 */
export const BRAND_SLOGAN_NOTE = '让每一次演变与拍板都有迹可循';

/** 核心 Slogan + 副句完整单行表达 */
export const BRAND_SLOGAN_EXTENDED = `${BRAND_SLOGAN} · ${BRAND_SLOGAN_NOTE}`;

/** 英文版 Slogan（对应 README.en.md） */
export const BRAND_SLOGAN_EN = 'Chronos keeps time. Guanlan reveals the trace.';

/** 浏览器标题 / 桌面短描述统一口径 */
export const BRAND_TITLE_FULL = `${BRAND_NAME} ${BRAND_NAME_EN} · ${BRAND_SLOGAN}`;
export const BRAND_SHORT_DESCRIPTION = `${BRAND_NAME}（${BRAND_NAME_EN}）— ${BRAND_SLOGAN} · 本地可追溯文件工作台`;

/** 司辰图标的完整视觉元描述（供 aria/文档核对，不随装饰漂移） */
export const BRAND_ICON_MOTIF = '司辰翼漏银匣徽（透明底曜石缎面文件夹、折耳权杖朱砂眼、温润象牙夹页、对称拉丝银翼与铂银朱砂流沙漏）';

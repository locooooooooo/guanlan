import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * 观澜 · 统一样式合并工具（对齐 coss.com/ui 约定）。
 * 结合 clsx 条件拼接与 tailwind-merge 冲突消解，供 src/components/ui/* 原语复用。
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

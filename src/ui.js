// ui.js —— 终端界面渲染：配色、横幅、盒子、spinner、彩色 diff。
// 全部用原生 ANSI 转义码实现，零额外依赖。

import { stdout } from "node:process";

// ── 配色 ─────────────────────────────────────────────────────────────
export const c = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  italic: "\x1b[3m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
  bgGreen: "\x1b[42m",
  bgRed: "\x1b[41m",
};
export const paint = (color, s) => `${color}${s}${c.reset}`;

// 估算字符串显示宽度（中文/全角算 2 列），用于盒子对齐
export function strWidth(s) {
  // 先去掉 ANSI 转义码
  const clean = s.replace(/\x1b\[[0-9;]*m/g, "");
  let w = 0;
  for (const ch of clean) {
    const code = ch.codePointAt(0);
    // CJK、全角符号等占两列
    w += (code >= 0x1100 && (code <= 0x115f || (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x1f300 && code <= 0x1faff))) ? 2 : 1;
  }
  return w;
}

// ── 横幅 ─────────────────────────────────────────────────────────────
export function banner(info = {}) {
  const lines = [
    paint(c.bold + c.cyan, "✻ minicode") + paint(c.dim, "  迷你版 Claude Code"),
    "",
    paint(c.dim, `模型  ${info.model || "?"}`),
    paint(c.dim, `工具  ${info.toolCount ?? "?"} 个` + (info.mcp ? `（含 MCP）` : "")),
    paint(c.dim, `目录  ${info.cwd || process.cwd()}`),
    "",
    paint(c.dim, "/help 看命令 · exit 退出"),
  ];
  return box(lines, { color: c.cyan });
}

// ── 盒子（自动按显示宽度对齐，支持中文）──────────────────────────────
export function box(lines, { color = c.gray, pad = 1 } = {}) {
  const width = Math.max(...lines.map(strWidth));
  const top = color + "╭" + "─".repeat(width + pad * 2) + "╮" + c.reset;
  const bot = color + "╰" + "─".repeat(width + pad * 2) + "╯" + c.reset;
  const body = lines.map((line) => {
    const gap = " ".repeat(width - strWidth(line));
    return color + "│" + c.reset + " ".repeat(pad) + line + gap + " ".repeat(pad) + color + "│" + c.reset;
  });
  return [top, ...body, bot].join("\n");
}

// ── 一个会转的 "thinking" spinner ────────────────────────────────────
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export function startSpinner(text = "thinking") {
  let i = 0;
  stdout.write("\x1b[?25l"); // 隐藏光标
  const timer = setInterval(() => {
    stdout.write(`\r${paint(c.magenta, FRAMES[i++ % FRAMES.length])} ${paint(c.dim, text)}…  `);
  }, 80);
  // 返回一个停止函数：清掉这一行并恢复光标
  return () => {
    clearInterval(timer);
    stdout.write("\r\x1b[K\x1b[?25h");
  };
}

// ── 把多行内容缩进，便于在工具结果里展示 ────────────────────────────
export function indent(text, prefix = "     ") {
  return text.split("\n").map((l) => prefix + l).join("\n");
}

export function truncate(text, max = 800) {
  if (text.length <= max) return text;
  return text.slice(0, max) + paint(c.dim, ` …（省略 ${text.length - max} 字）`);
}

// ── edit_file 的彩色 diff（按行对比，简单直观）──────────────────────
export function renderDiff(oldStr, newStr) {
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");
  const out = [];
  for (const l of oldLines) out.push(paint(c.red, "  - " + l));
  for (const l of newLines) out.push(paint(c.green, "  + " + l));
  return out.join("\n");
}

// 轻量 Markdown 渲染（无依赖）：用于 AI 总结的格式化显示。
// 安全：所有文本先转义再套标签；不生成可点击链接（避免 webview 被导航走），只显示链接文字。
// 支持：标题 / 粗体 / 斜体 / 删除线 / 行内代码 / 代码块 / 引用 / 有序·无序列表（可嵌套）/ 表格 / 分隔线。
// 流式输出时可反复对「不完整的文本」调用（未闭合的代码块、半截表格都能容忍）。

import { esc } from './util.js';

function inline(raw) {
  const codes = [];
  let t = esc(raw).replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });
  t = t
    .replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_\n]+?)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+?)~~/g, '<del>$1</del>')
    .replace(/\[([^\]\n]+)\]\((?:https?:\/\/)[^)\s]+\)/g, '<span class="md-link">$1</span>');
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
}

const RE_FENCE = /^\s*```/;
const RE_HR = /^\s*([-*_])(\s*\1){2,}\s*$/;
const RE_HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RE_LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const RE_QUOTE = /^\s*>/;
const RE_TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

const indentOf = (s) => s.replace(/\t/g, '    ').length;

function splitRow(r) {
  let s = r.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

function isBlockStart(lines, i) {
  const l = lines[i];
  if (RE_FENCE.test(l) || RE_HR.test(l) || RE_HEADING.test(l) || RE_QUOTE.test(l) || RE_LIST.test(l)) return true;
  return l.includes('|') && i + 1 < lines.length && RE_TABLE_SEP.test(lines[i + 1]);
}

function parseList(lines, start, indent) {
  let i = start;
  const first = lines[i].match(RE_LIST);
  const ordered = /\d/.test(first[2]);
  const tag = ordered ? 'ol' : 'ul';
  const num = ordered ? parseInt(first[2], 10) : 1;
  let html = ordered && num !== 1 ? `<ol start="${num}">` : `<${tag}>`;
  while (i < lines.length) {
    const m = lines[i].match(RE_LIST);
    if (!m || indentOf(m[1]) !== indent) break;
    let item = inline(m[3]);
    let nested = '';
    i++;
    while (i < lines.length) {
      const l = lines[i];
      if (/^\s*$/.test(l)) {
        // 空行后若仍是更深缩进的列表项，则仍属当前条目
        let j = i + 1;
        while (j < lines.length && /^\s*$/.test(lines[j])) j++;
        const mm = j < lines.length ? lines[j].match(RE_LIST) : null;
        if (mm && indentOf(mm[1]) > indent) {
          i = j;
          continue;
        }
        break;
      }
      const mm = l.match(RE_LIST);
      if (mm) {
        const ind = indentOf(mm[1]);
        if (ind > indent) {
          const r = parseList(lines, i, ind);
          nested += r.html;
          i = r.next;
          continue;
        }
        break;
      }
      if (indentOf(l.match(/^\s*/)[0]) > indent && !isBlockStart(lines, i)) {
        item += '<br>' + inline(l.trim());
        i++;
        continue;
      }
      break;
    }
    html += `<li>${item}${nested}</li>`;
  }
  return { html: html + `</${tag}>`, next: i };
}

export function renderMarkdown(src) {
  const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }

    if (RE_FENCE.test(line)) {
      const code = [];
      i++;
      while (i < lines.length && !RE_FENCE.test(lines[i])) code.push(lines[i++]);
      i++; // 跳过结束围栏（流式时可能还没有）
      out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
      continue;
    }

    if (RE_HR.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }

    let m = line.match(RE_HEADING);
    if (m) {
      const n = m[1].length;
      out.push(`<h${n}>${inline(m[2])}</h${n}>`);
      i++;
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && RE_TABLE_SEP.test(lines[i + 1])) {
      const head = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map((c) =>
        c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : ''
      );
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && !/^\s*$/.test(lines[i])) rows.push(splitRow(lines[i++]));
      const cell = (tag, c, k) =>
        `<${tag}${aligns[k] ? ` style="text-align:${aligns[k]}"` : ''}>${inline(c)}</${tag}>`;
      out.push(
        '<div class="md-table-wrap"><table><thead><tr>' +
          head.map((c, k) => cell('th', c, k)).join('') +
          '</tr></thead><tbody>' +
          rows.map((r) => '<tr>' + head.map((_, k) => cell('td', r[k] ?? '', k)).join('') + '</tr>').join('') +
          '</tbody></table></div>'
      );
      continue;
    }

    if (RE_QUOTE.test(line)) {
      const inner = [];
      while (i < lines.length && RE_QUOTE.test(lines[i])) inner.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${renderMarkdown(inner.join('\n'))}</blockquote>`);
      continue;
    }

    m = line.match(RE_LIST);
    if (m) {
      const r = parseList(lines, i, indentOf(m[1]));
      out.push(r.html);
      i = r.next;
      continue;
    }

    // 段落：到空行或下一个块级元素为止，行内换行保留为 <br>
    const para = [];
    while (i < lines.length && !/^\s*$/.test(lines[i]) && (para.length === 0 || !isBlockStart(lines, i))) {
      para.push(inline(lines[i].trim()));
      i++;
    }
    out.push(`<p>${para.join('<br>')}</p>`);
  }
  return out.join('\n');
}

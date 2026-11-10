'use strict';
// Markdown → DOM for prompts and assistant text. Covers the CommonMark/GFM subset
// models write: headings, paragraphs, emphasis, strikethrough, code spans and fences,
// lists (nested, ordered, task), block quotes, tables, rules, links and autolinks.
// Single newlines inside a paragraph render as line breaks.
//
// Input is untrusted. Every node is built with h() (textContent), never innerHTML.
// Only http(s) and mailto links become anchors; other targets (file paths,
// javascript:, data:) render as plain text. Images render as links and are never
// loaded, so viewing a transcript makes no requests to hosts it names.

function renderMarkdown(src) {
  return h('div', { class: 'md' }, mdBlocks(src.replace(/\r\n?/g, '\n').split('\n')));
}

const MD = {
  fence: /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/,
  heading: /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/,
  hr: /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/,
  quote: /^ {0,3}> ?/,
  item: /^( {0,3})([-*+]|\d{1,9}[.)])([ \t]+|$)/,
  setext: /^ {0,3}(=+|-+)[ \t]*$/,
  tableSep: /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/,
  blank: /^[ \t]*$/,
};

const isTableStart = (lines, i) =>
  i + 1 < lines.length && lines[i].includes('|') && lines[i + 1].includes('-') &&
  MD.tableSep.test(lines[i + 1]) && splitRow(lines[i]).length === splitRow(lines[i + 1]).length;

// Lines that end a paragraph without a blank line in between.
function interrupts(lines, i) {
  const l = lines[i];
  if (MD.fence.test(l) || MD.heading.test(l) || MD.hr.test(l) || MD.quote.test(l) || isTableStart(lines, i)) return true;
  const m = MD.item.exec(l);
  return !!m && !MD.blank.test(l.slice(m[0].length)) && (/^[-*+]/.test(m[2]) || /^1[.)]/.test(m[2]));
}

function mdBlocks(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    let m;
    if (MD.blank.test(l)) { i++; continue; }

    if ((m = MD.fence.exec(l))) {
      const fence = m[1];
      const close = new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}[ \\t]*$`);
      const body = [];
      for (i++; i < lines.length && !close.test(lines[i]); i++) body.push(lines[i]);
      i++;
      out.push(h('pre', { class: 'md-code', 'data-lang': m[2] || null }, h('code', {}, body.join('\n'))));
      continue;
    }
    if ((m = MD.heading.exec(l))) {
      out.push(h('h' + m[1].length, {}, mdInline(m[2] || '')));
      i++;
      continue;
    }
    if (MD.hr.test(l)) { out.push(h('hr')); i++; continue; }

    if (MD.quote.test(l)) {
      const body = [];
      while (i < lines.length && !MD.blank.test(lines[i]) && (MD.quote.test(lines[i]) || !interrupts(lines, i))) {
        body.push(lines[i].replace(MD.quote, ''));
        i++;
      }
      out.push(h('blockquote', {}, mdBlocks(body)));
      continue;
    }
    if (isTableStart(lines, i)) { i = mdTable(lines, i, out); continue; }
    if (MD.item.test(l)) { i = mdList(lines, i, out); continue; }

    if (/^( {4}|\t)/.test(l)) {
      const body = [];
      while (i < lines.length && (/^( {4}|\t)/.test(lines[i]) || MD.blank.test(lines[i]))) body.push(lines[i++].replace(/^( {4}|\t)/, ''));
      while (body.length && MD.blank.test(body[body.length - 1])) body.pop();
      out.push(h('pre', { class: 'md-code' }, h('code', {}, body.join('\n'))));
      continue;
    }

    const para = [l];
    for (i++; i < lines.length && !MD.blank.test(lines[i]) && !interrupts(lines, i); i++) {
      if (MD.setext.test(lines[i])) break;
      para.push(lines[i]);
    }
    if (i < lines.length && MD.setext.test(lines[i]) && !MD.blank.test(lines[i])) {
      out.push(h(lines[i].trim()[0] === '=' ? 'h1' : 'h2', {}, mdInline(para.join('\n').trim())));
      i++;
      continue;
    }
    out.push(h('p', {}, mdInline(para.map((s) => s.replace(/^[ \t]+/, '')).join('\n').replace(/\s+$/, ''))));
  }
  return out;
}

function mdList(lines, i, out) {
  const first = MD.item.exec(lines[i]);
  const ordered = /\d/.test(first[2]);
  const marker = ordered ? first[2].slice(-1) : first[2];
  const list = h(ordered ? 'ol' : 'ul', { start: ordered && parseInt(first[2], 10) !== 1 ? parseInt(first[2], 10) : null });
  let loose = false;

  while (i < lines.length) {
    const m = MD.item.exec(lines[i]);
    if (!m || (ordered ? !/\d/.test(m[2]) || m[2].slice(-1) !== marker : m[2] !== marker)) break;
    const rest = lines[i].slice(m[0].length);
    // Content column: past the marker and up to four spaces after it.
    const pad = m[3].length > 4 || MD.blank.test(rest) ? 1 : m[3].length;
    const indent = m[1].length + m[2].length + pad;
    const body = [m[3].length > 4 ? m[3].slice(1) + rest : rest];
    let prevBlank = false;
    for (i++; i < lines.length; i++) {
      const l = lines[i];
      if (MD.blank.test(l)) { body.push(''); prevBlank = true; continue; }
      const lead = l.match(/^[ \t]*/)[0].replace(/\t/g, '    ').length;
      // A marker indented past this item's marker nests, even short of the content
      // column ("1. a" followed by "  - b").
      if (lead >= indent || (lead > m[1].length + 1 && MD.item.test(l))) {
        body.push(l.replace(/^[ \t]*/, ' '.repeat(Math.max(0, lead - indent))));
        prevBlank = false;
        continue;
      }
      if (!prevBlank && !interrupts(lines, i) && !MD.item.test(l)) { body.push(l); continue; }
      break;
    }
    while (body.length && body[body.length - 1] === '') { body.pop(); if (i < lines.length && MD.item.test(lines[i])) loose = true; }
    if (body.slice(0, -1).includes('')) loose = true;

    const kids = [];
    const task = /^\[([ xX])\][ \t]+/.exec(body[0]);
    if (task) {
      body[0] = body[0].slice(task[0].length);
      kids.push(h('span', { class: 'md-task' }, task[1] === ' ' ? '☐ ' : '☑ '));
    }
    list.append(h('li', {}, kids, mdBlocks(body)));
  }
  if (!loose) list.classList.add('tight');
  out.push(list);
  return i;
}

// Splits a table row on pipes that are not escaped or inside a code span.
function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let j = 0; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && s[j + 1] === '|') { cur += '|'; j++; continue; }
    if (c === '`') {
      const run = s.slice(j).match(/^`+/)[0];
      const end = s.indexOf(run, j + run.length);
      if (end > 0) { cur += s.slice(j, end + run.length); j = end + run.length - 1; continue; }
    }
    if (c === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

function mdTable(lines, i, out) {
  const head = splitRow(lines[i]);
  const align = splitRow(lines[i + 1]).map((c) =>
    c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : null);
  const cell = (tag, text, k) => h(tag, { style: align[k] ? `text-align:${align[k]}` : null }, mdInline(text || ''));
  const rows = [];
  for (i += 2; i < lines.length && !MD.blank.test(lines[i]) && lines[i].includes('|') && !interrupts(lines, i); i++) {
    const cells = splitRow(lines[i]);
    rows.push(h('tr', {}, head.map((_, k) => cell('td', cells[k], k))));
  }
  out.push(h('div', { class: 'md-table' }, h('table', {},
    h('thead', {}, h('tr', {}, head.map((t, k) => cell('th', t, k)))),
    rows.length ? h('tbody', {}, rows) : null)));
  return i;
}

// ------------------------------------------------------------ inline

const MD_PUNCT = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;

function safeHref(url) {
  try {
    const u = new URL(url);
    return ['http:', 'https:', 'mailto:'].includes(u.protocol) ? u.href : null;
  } catch (e) { return null; }
}

function mdLink(text, url, title) {
  const href = safeHref(url);
  return href ? h('a', { href, title: title || url, target: '_blank', rel: 'noopener noreferrer' }, text)
    : h('span', { class: 'md-link', title: url }, text);
}

// Index of the next unescaped `delim` at or after `from`, skipping code spans.
function findCloser(s, from, delim, ok) {
  for (let j = from; j < s.length; j++) {
    if (s[j] === '\\') { j++; continue; }
    if (s[j] === '`') {
      const run = s.slice(j).match(/^`+/)[0];
      const end = s.indexOf(run, j + run.length);
      if (end > 0) { j = end + run.length - 1; continue; }
      j += run.length - 1;
      continue;
    }
    if (s.startsWith(delim, j) && (!ok || ok(j))) return j;
  }
  return -1;
}

// Parses `[label](dest "title")` starting at the '['. Returns [label, dest, title, end] or null.
// Labels longer than MD_LABEL_MAX are not links, which keeps runs of stray '[' linear.
const MD_LABEL_MAX = 1000;
function parseLink(s, j) {
  let depth = 0, k = j;
  for (const stop = Math.min(s.length, j + MD_LABEL_MAX); k < stop; k++) {
    if (s[k] === '\\') { k++; continue; }
    if (s[k] === '`') { const run = s.slice(k).match(/^`+/)[0]; const e = s.indexOf(run, k + run.length); if (e > 0) k = e + run.length - 1; continue; }
    if (s[k] === '[') depth++;
    else if (s[k] === ']' && --depth === 0) break;
  }
  if (s[k] !== ']' || s[k + 1] !== '(') return null;
  let p = k + 2, dest = '';
  while (s[p] === ' ') p++;
  if (s[p] === '<') {
    const e = s.indexOf('>', p);
    if (e < 0) return null;
    dest = s.slice(p + 1, e);
    p = e + 1;
  } else {
    let par = 0;
    for (; p < s.length && !/\s/.test(s[p]); p++) {
      if (s[p] === '\\' && MD_PUNCT.test(s[p + 1] || '')) { dest += s[++p]; continue; }
      if (s[p] === '(') par++;
      else if (s[p] === ')') { if (par === 0) break; par--; }
      dest += s[p];
    }
  }
  while (s[p] === ' ') p++;
  let title = '';
  const q = s[p];
  if (q === '"' || q === "'") {
    const e = s.indexOf(q, p + 1);
    if (e < 0) return null;
    title = s.slice(p + 1, e);
    p = e + 1;
    while (s[p] === ' ') p++;
  }
  if (s[p] !== ')') return null;
  return [s.slice(j + 1, k), dest, title, p + 1];
}

const isWord = (c) => !!c && /[\p{L}\p{N}]/u.test(c);
const isSpace = (c) => !c || /\s/.test(c);

function mdInline(s) {
  const out = [];
  let buf = '';
  // Per delimiter, the earliest start from which no closer exists. Later searches
  // for that delimiter fail without rescanning, so unmatched runs stay linear.
  const dead = {};
  const flush = () => { if (buf) { out.push(buf); buf = ''; } };
  for (let j = 0; j < s.length; j++) {
    const c = s[j];

    if (c === '\\' && j + 1 < s.length) {
      if (s[j + 1] === '\n') { flush(); out.push(h('br')); j++; continue; }
      if (MD_PUNCT.test(s[j + 1])) { buf += s[++j]; continue; }
    }
    if (c === '\n') { buf = buf.replace(/ +$/, ''); flush(); out.push(h('br')); while (s[j + 1] === ' ') j++; continue; }

    if (c === '`') {
      const run = s.slice(j).match(/^`+/)[0];
      const end = (() => {
        for (let k = s.indexOf(run, j + run.length); k >= 0; k = s.indexOf(run, k + 1)) {
          if (s[k - 1] !== '`' && s[k + run.length] !== '`') return k;
        }
        return -1;
      })();
      if (end < 0) { buf += run; j += run.length - 1; continue; }
      let code = s.slice(j + run.length, end).replace(/\n/g, ' ');
      if (/^ .*[^ ].* $/.test(code)) code = code.slice(1, -1);
      flush();
      out.push(h('code', {}, code));
      j = end + run.length - 1;
      continue;
    }

    if (c === '!' && s[j + 1] === '[') {
      const link = parseLink(s, j + 1);
      if (link) {
        flush();
        out.push(mdLink('🖼 ' + (link[0] || 'image'), link[1], link[2] || link[1]));
        j = link[3] - 1;
        continue;
      }
    }
    if (c === '[') {
      const link = parseLink(s, j);
      if (link) {
        flush();
        out.push(mdLink(mdInline(link[0]), link[1], link[2]));
        j = link[3] - 1;
        continue;
      }
    }

    if (c === '<') {
      const m = /^<((?:https?|mailto):[^\s<>]+)>/i.exec(s.slice(j));
      if (m) { flush(); out.push(mdLink(m[1], m[1])); j += m[0].length - 1; continue; }
    }
    if ((c === 'h' || c === 'w') && !isWord(s[j - 1])) {
      const m = /^(?:https?:\/\/|www\.)[^\s<]*[^\s<?!.,:;*_~'")\]]/i.exec(s.slice(j));
      if (m) {
        let url = m[0];
        // Keep a trailing ')' only when it closes a '(' inside the URL.
        while (url.endsWith(')') && (url.match(/\(/g) || []).length < (url.match(/\)/g) || []).length) url = url.slice(0, -1);
        flush();
        out.push(mdLink(url, url.startsWith('www.') ? 'https://' + url : url));
        j += url.length - 1;
        continue;
      }
    }

    if (c === '*' || c === '_' || c === '~') {
      const run = s.slice(j).match(c === '~' ? /^~+/ : c === '*' ? /^\*+/ : /^_+/)[0];
      const n = c === '~' ? (run.length === 2 ? 2 : 0) : Math.min(run.length, 3);
      const next = s[j + run.length];
      const opens = n && !isSpace(next) && (c !== '_' || !isWord(s[j - 1]));
      if (opens) {
        const delim = c.repeat(n);
        const from = j + run.length;
        const end = dead[delim] <= from ? -1 : findCloser(s, from, delim, (k) =>
          !isSpace(s[k - 1]) && s[k + n] !== c && (c !== '_' || !isWord(s[k + n])));
        if (end < 0) dead[delim] = Math.min(dead[delim] ?? from, from);
        if (end > j + run.length - 1) {
          flush();
          if (run.length > n) buf += c.repeat(run.length - n);
          flush();
          const inner = mdInline(s.slice(j + run.length, end));
          out.push(c === '~' ? h('del', {}, inner)
            : n === 3 ? h('strong', {}, h('em', {}, inner))
            : h(n === 2 ? 'strong' : 'em', {}, inner));
          j = end + n - 1;
          continue;
        }
      }
      buf += run;
      j += run.length - 1;
      continue;
    }

    buf += c;
  }
  flush();
  return out;
}

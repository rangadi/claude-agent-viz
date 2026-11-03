'use strict';
// All transcript content is untrusted text: it reaches the DOM only through
// textContent (via h()), never innerHTML.

const app = document.getElementById('app');
const crumbs = document.getElementById('crumbs');

const state = {
  open: new Set(),          // keys of expanded collapsibles; survives live re-renders
  order: localStorage.getItem('order') || 'desc',
  live: localStorage.getItem('live') !== 'off',
  listFilter: '',
  listProject: '',
  pollTimer: null,
};

// ------------------------------------------------------------ DOM helpers

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

// A row that toggles a lazily-built body. `build` runs only while expanded.
function collapsible(cls, key, rowKids, build) {
  const wrap = h('div', { class: cls });
  const body = h('div', { class: 'body' });
  const row = h('div', { class: 'row' }, h('span', { class: 'caret' }, '▸'), rowKids);
  const set = (open) => {
    wrap.classList.toggle('open', open);
    body.replaceChildren();
    if (open) { body.append(...[].concat(build())); wrap.append(body); } else body.remove();
  };
  row.addEventListener('click', () => {
    const open = !state.open.has(key);
    open ? state.open.add(key) : state.open.delete(key);
    set(open);
  });
  wrap.append(row);
  if (state.open.has(key)) set(true);
  return wrap;
}

// ------------------------------------------------------------ formatting

function fmtMs(ms) {
  if (ms == null || isNaN(ms)) return '–';
  if (ms < 1000) return Math.round(ms) + 'ms';
  const s = ms / 1000;
  if (s < 60) return s.toFixed(s < 10 ? 1 : 0) + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ' + String(Math.round(s % 60)).padStart(2, '0') + 's';
  return Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm';
}
function fmtTok(n) {
  if (n == null) return '–';
  if (n < 1000) return String(n);
  if (n < 1e6) return (n / 1000).toFixed(n < 10000 ? 1 : 0) + 'k';
  return (n / 1e6).toFixed(1) + 'M';
}
function fmtBytes(n) {
  return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
}
function fmtTime(ms, withDate) {
  if (ms == null) return '';
  const d = new Date(ms);
  const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return withDate ? d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + t : t;
}
function fmtAgo(ms) {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  if (s < 86400 * 7) return Math.floor(s / 86400) + 'd ago';
  return new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}
function toolName(n) {
  return n.startsWith('mcp__') ? n.slice(5).replace(/__/, ' · ') : n;
}
function shortModel(m) {
  return (m || '?').replace(/^claude-/, '').replace(/-\d{8}$/, '');
}
function usageTotals(u) {
  u = u || {};
  return {
    input: (u.input_tokens || 0),
    cacheRead: (u.cache_read_input_tokens || 0),
    cacheWrite: (u.cache_creation_input_tokens || 0),
    output: (u.output_tokens || 0),
    thinking: (u.output_tokens_details || {}).thinking_tokens || 0,
  };
}

// ------------------------------------------------------------ API

async function api(path, params) {
  const qs = new URLSearchParams(params || {}).toString();
  const r = await fetch('/api/' + path + (qs ? '?' + qs : ''));
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json();
}

// Text that may be clipped server-side: {t, n?, k?}. Renders a "show all" link
// that fetches the full value.
function clipped(c, ids, cls) {
  const pre = h('pre', { class: cls || 'block' }, c ? c.t : '');
  if (!c || !c.k) return pre;
  const more = h('a', { href: '#', class: 'more' }, `show all (${fmtBytes(c.n)})`);
  more.addEventListener('click', async (e) => {
    e.preventDefault();
    more.textContent = 'loading…';
    try {
      const full = await api('full', { ...ids, k: c.k });
      pre.textContent = full.t;
      more.remove();
    } catch (err) { more.textContent = 'failed: ' + err.message; }
  });
  return h('div', {}, pre, more);
}

// ------------------------------------------------------------ router

function route() {
  clearInterval(state.pollTimer);
  const parts = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  if (parts[0] === 's' && parts[1] && parts[2]) {
    const ids = { p: parts[1], s: parts[2] };
    if (parts[3] === 'a' && parts[4]) ids.a = parts[4];
    showSession(ids);
  } else {
    showList();
  }
}
window.addEventListener('hashchange', route);

// ------------------------------------------------------------ session list

let listCache = null;

async function showList() {
  crumbs.textContent = 'sessions';
  document.title = 'Agent Traffic';
  if (!listCache) app.replaceChildren(h('div', { class: 'empty' }, 'Scanning sessions…'));
  try {
    listCache = await api('sessions');
  } catch (e) {
    app.replaceChildren(h('div', { class: 'empty' }, 'Failed to load sessions: ' + e.message));
    return;
  }
  renderList();
}

function renderList() {
  const { sessions, root } = listCache;
  const projects = [...new Set(sessions.map((s) => s.cwdShort))].sort();
  const listEl = h('div', { class: 'slist' });

  const draw = () => {
    const f = state.listFilter.toLowerCase();
    const rows = sessions.filter((s) => (!state.listProject || s.cwdShort === state.listProject) &&
      (!f || [s.title, s.firstPrompt, s.lastPrompt, s.cwdShort, s.gitBranch, s.session]
        .some((x) => x && x.toLowerCase().includes(f))));
    listEl.replaceChildren(...rows.map(sessionRow));
    if (!rows.length) listEl.append(h('div', { class: 'empty' }, 'No sessions match.'));
    count.textContent = `${rows.length} of ${sessions.length}`;
  };

  const search = h('input', { type: 'search', placeholder: 'Filter by title, prompt, project, branch…', value: state.listFilter });
  search.addEventListener('input', () => { state.listFilter = search.value; draw(); });
  const sel = h('select', {}, h('option', { value: '' }, 'All projects'),
    projects.map((p) => h('option', { value: p, selected: p === state.listProject }, p)));
  sel.addEventListener('change', () => { state.listProject = sel.value; draw(); });
  const count = h('span', { class: 'muted small' });

  app.replaceChildren(
    h('div', { class: 'toolbar' }, search, sel, h('button', { onclick: showList }, 'Refresh'), count),
    listEl,
    h('p', { class: 'muted small' }, 'Reading ', h('span', { class: 'mono' }, root)),
  );
  draw();
  search.focus();
}

function sessionRow(s) {
  const live = Date.now() - s.mtime < 120000;
  const title = s.title || s.firstPrompt || s.session;
  return h('a', { class: 'srow', href: `#/s/${encodeURIComponent(s.project)}/${encodeURIComponent(s.session)}` },
    h('div', { style: 'min-width:0' },
      h('div', { class: 'title' }, live ? h('span', { class: 'live-dot', title: 'updated in the last 2 minutes' }) : null, title),
      h('div', { class: 'prompt' }, s.lastPrompt && s.lastPrompt !== s.firstPrompt ? 'Last: ' + s.lastPrompt : (s.title ? s.firstPrompt : '') || '')),
    h('div', { class: 'where' }, h('div', {}, s.cwdShort), h('div', {}, s.gitBranch || ''),
      s.subagents ? h('div', {}, `${s.subagents} subagent${s.subagents > 1 ? 's' : ''}`) : null),
    h('div', { class: 'when' }, h('div', {}, fmtAgo(s.mtime)), h('div', {}, fmtBytes(s.size))));
}

// ------------------------------------------------------------ session view

async function showSession(ids) {
  crumbs.textContent = ids.a ? `session ${ids.s.slice(0, 8)} › subagent ${ids.a.slice(0, 8)}` : `session ${ids.s.slice(0, 8)}`;
  app.replaceChildren(h('div', { class: 'empty' }, 'Loading trace…'));
  let data, stat;
  const load = async () => {
    data = await api('session', ids);
    stat = { mtime: data.mtime, size: data.size };
    renderSession(ids, data);
  };
  try { await load(); } catch (e) {
    app.replaceChildren(h('div', { class: 'empty' }, 'Failed to load session: ' + e.message));
    return;
  }
  const hash = location.hash;
  state.pollTimer = setInterval(async () => {
    if (!state.live || location.hash !== hash || document.hidden) return;
    try {
      const s = await api('stat', ids);
      if (s.mtime !== stat.mtime || s.size !== stat.size) await load();
    } catch (e) { /* transient; try again next tick */ }
  }, 2500);
}

function summarize(turn) {
  const calls = turn.items.filter((i) => i.type === 'call');
  const tools = calls.flatMap((c) => c.tools);
  const tok = calls.reduce((a, c) => {
    const u = usageTotals(c.usage);
    for (const k in u) a[k] += u[k];
    return a;
  }, { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, thinking: 0 });
  const ends = [turn.ts, ...turn.items.map((i) => i.end || i.ts), ...tools.map((t) => t.resultTs)].filter((x) => x != null);
  const start = turn.ts != null ? turn.ts : Math.min(...ends);
  const end = ends.length ? Math.max(...ends) : start;
  return {
    calls, tools, tok, start, end,
    modelMs: calls.reduce((a, c) => a + Math.max(0, (c.end || 0) - (c.start || 0)), 0),
    toolMs: tools.reduce((a, t) => a + (t.durationMs || 0), 0),
    errors: tools.filter((t) => t.isError).length + calls.filter((c) => c.error).length,
  };
}

function renderSession(ids, data) {
  const sums = data.turns.map(summarize);
  const all = sums.reduce((a, s) => {
    a.calls += s.calls.length; a.tools += s.tools.length; a.modelMs += s.modelMs; a.toolMs += s.toolMs;
    a.errors += s.errors;
    for (const k in s.tok) a.tok[k] += s.tok[k];
    return a;
  }, { calls: 0, tools: 0, modelMs: 0, toolMs: 0, errors: 0, tok: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, thinking: 0 } });
  const humanTurns = data.turns.filter((t) => t.kind === 'human').length;
  const first = sums.length ? sums[0].start : null;
  const last = sums.length ? Math.max(...sums.map((s) => s.end)) : null;
  const agent = data.agent || {};
  const title = (ids.a && agent.description ? `${agent.agentType || 'agent'} — ${agent.description}` : null) ||
    data.title || data.agentName || (data.turns.find((t) => t.kind === 'human') || {}).preview || ids.s;
  document.title = title + ' — Agent Traffic';

  const stat = (v, label, tip) => h('div', { class: 'stat', title: tip || null }, h('b', {}, v), h('span', {}, label));
  const header = h('div', { class: 'shead' },
    ids.a ? h('div', { class: 'small' }, h('a', { href: `#/s/${encodeURIComponent(ids.p)}/${encodeURIComponent(ids.s)}` }, '← parent session')) : null,
    h('h1', {}, ids.a ? 'Subagent: ' + title : title),
    h('div', { class: 'muted small' },
      [data.cwd ? short(data.cwd) : null, data.gitBranch, data.models.map(shortModel).join(', '),
        first ? `${fmtTime(first, true)} → ${fmtTime(last, true)}` : null, data.version ? 'v' + data.version : null]
        .filter(Boolean).join('  ·  ')),
    data.prs.length ? h('div', { class: 'small' }, 'PRs: ', data.prs.map((u, i) => [i ? ', ' : '', h('a', { href: u, target: '_blank', rel: 'noopener' }, u.replace(/^https:\/\/github.com\//, ''))])) : null,
    h('div', { class: 'stats' },
      stat(humanTurns, 'prompts'),
      stat(all.calls, 'API round trips'),
      stat(all.tools, 'tool calls'),
      stat(fmtMs(all.modelMs), 'model time', 'Sum of request → last block, per API call'),
      stat(fmtMs(all.toolMs), 'tool time', 'Sum of tool_use → tool_result, per tool call. Includes approval and user-answer waits; parallel tools overlap.'),
      stat(fmtTok(all.tok.output), 'output tokens', `including ${fmtTok(all.tok.thinking)} thinking`),
      stat(fmtTok(all.tok.cacheRead), 'cache-read tokens'),
      stat(fmtTok(all.tok.cacheWrite + all.tok.input), 'uncached input', `${fmtTok(all.tok.cacheWrite)} cache writes + ${fmtTok(all.tok.input)} plain input`),
      data.cost != null ? stat('$' + data.cost.toFixed(2), 'cost (Claude Code estimate)') : null,
      all.errors ? stat(all.errors, 'errors') : null));

  const orderBtn = h('button', {}, state.order === 'desc' ? 'Newest first ↓' : 'Oldest first ↑');
  orderBtn.addEventListener('click', () => {
    state.order = state.order === 'desc' ? 'asc' : 'desc';
    localStorage.setItem('order', state.order);
    renderSession(ids, data);
  });
  const liveBox = h('input', { type: 'checkbox', checked: state.live });
  liveBox.addEventListener('change', () => { state.live = liveBox.checked; localStorage.setItem('live', state.live ? 'on' : 'off'); });
  const expandAll = h('button', {}, 'Expand all turns');
  expandAll.addEventListener('click', () => { data.turns.forEach((t) => state.open.add(turnKey(ids, t))); renderSession(ids, data); });
  const collapseAll = h('button', {}, 'Collapse all');
  collapseAll.addEventListener('click', () => { state.open.clear(); renderSession(ids, data); });

  // The newest turn starts expanded the first time a session is opened.
  const seenKey = 'seen:' + ids.s + (ids.a || '');
  if (!state.open.has(seenKey) && data.turns.length) {
    state.open.add(seenKey);
    state.open.add(turnKey(ids, data.turns[data.turns.length - 1]));
  }

  const idx = data.turns.map((_, i) => i);
  if (state.order === 'desc') idx.reverse();
  const scrollY = window.scrollY;
  app.replaceChildren(header,
    h('div', { class: 'toolbar' }, orderBtn, expandAll, collapseAll,
      h('label', { class: 'small muted' }, liveBox, ' live refresh'),
      h('span', { class: 'legend' }, h('i', { style: 'background:var(--model)' }), 'model', h('i', { style: 'background:var(--tool)' }), 'tools')),
    ...(idx.length ? idx.map((i) => turnCard(ids, data.turns[i], sums[i], i)) : [h('div', { class: 'empty' }, 'No activity in this transcript yet.')]));
  window.scrollTo(0, scrollY);
}

function short(p) { return p.replace(/^\/Users\/[^/]+/, '~'); }
function turnKey(ids, t) { return `turn:${ids.s}:${ids.a || ''}:${t.key}`; }

function turnCard(ids, turn, sum, i) {
  const kindBadge = turn.kind === 'task' ? h('span', { class: 'badge task' }, 'task notification')
    : turn.kind === 'start' ? h('span', { class: 'badge' }, 'session start') : null;
  const row = [
    h('span', { class: 'time', title: fmtTime(turn.ts, true) }, fmtTime(sum.start, true)),
    kindBadge,
    h('span', { class: 'grow' }, turn.preview || (turn.kind === 'start' ? '' : '(empty prompt)')),
    h('span', { class: 'right' },
      sum.errors ? h('span', { class: 'badge err' }, `${sum.errors} error${sum.errors > 1 ? 's' : ''}`) : null,
      h('span', { title: 'wall time, prompt → last activity' }, fmtMs(sum.end - sum.start)),
      h('span', {}, `${sum.calls.length} call${sum.calls.length === 1 ? '' : 's'}`),
      h('span', {}, `${sum.tools.length} tool${sum.tools.length === 1 ? '' : 's'}`),
      h('span', { title: 'output tokens' }, fmtTok(sum.tok.output) + ' out')),
  ];
  return collapsible('card', turnKey(ids, turn), row, () => {
    const parts = [];
    if (turn.kind !== 'start') {
      parts.push(collapsible('tool', `prompt:${ids.s}:${turn.key}`,
        [h('span', { class: 'tname' }, 'Prompt'), h('span', { class: 'grow muted' }, `${(turn.prompt.n || turn.prompt.t.length).toLocaleString()} chars${turn.images ? `, ${turn.images} image(s)` : ''} — raw text as sent`)],
        () => clipped(turn.prompt, ids)));
    }
    parts.push(timeline(sum), h('div', { class: 'legend' },
      `model ${fmtMs(sum.modelMs)} · tools ${fmtMs(sum.toolMs)} · ${fmtTok(sum.tok.cacheRead)} cache-read · ${fmtTok(sum.tok.cacheWrite)} cache-write · ${fmtTok(sum.tok.input)} input · ${fmtTok(sum.tok.output)} output`));
    const items = state.order === 'desc' ? [...turn.items].reverse() : turn.items;
    parts.push(...items.map((it) => it.type === 'call' ? callCard(ids, it) : metaRow(ids, it)));
    return parts;
  });
}

function timeline(sum) {
  const span = Math.max(1, sum.end - sum.start);
  const pos = (a, b, cls, tip) => {
    if (a == null || b == null) return null;
    const left = ((a - sum.start) / span) * 100;
    const width = Math.max(0.2, ((b - a) / span) * 100);
    return h('div', { class: cls, style: `left:${left}%;width:${width}%`, title: tip });
  };
  return h('div', { class: 'tl' },
    sum.calls.map((c) => pos(c.start, c.end, 'm', `#${c.n} ${shortModel(c.model)} ${fmtMs(c.end - c.start)}`)),
    sum.tools.map((t) => pos(t.start, t.resultTs, 't', `${toolName(t.name)} ${fmtMs(t.durationMs)}`)));
}

function metaRow(ids, it) {
  const label = it.type === 'compact' ? 'context compacted' : it.label;
  const preview = (it.text.t || '').replace(/\s+/g, ' ').slice(0, 160);
  return collapsible('meta' + (it.type === 'compact' ? ' compact' : ''), `meta:${ids.s}:${it.ts}:${label}`,
    [h('span', { class: 'time' }, fmtTime(it.ts)), h('span', { class: 'badge' }, label), h('span', { class: 'grow' }, preview)],
    () => clipped(it.text, ids));
}

function callCard(ids, c) {
  const u = usageTotals(c.usage);
  const latency = c.end - c.start;
  const errs = c.tools.filter((t) => t.isError).length;
  const firstText = c.texts.length ? c.texts[0].t.replace(/\s+/g, ' ').slice(0, 140) : '';
  const row = [
    h('span', { class: 'time' }, fmtTime(c.start)),
    h('span', { class: 'mono muted' }, '#' + c.n),
    h('span', { class: 'badge model' }, shortModel(c.model)),
    c.error ? h('span', { class: 'badge err' }, 'API error') : null,
    h('span', { class: 'grow' },
      c.tools.length ? h('span', { class: 'chips' }, c.tools.map((t) => h('span', { class: 'chip' + (t.isError ? ' err' : '') }, toolName(t.name) + (t.durationMs != null ? ' ' + fmtMs(t.durationMs) : ''))))
        : h('span', { class: 'muted' }, firstText)),
    h('span', { class: 'right' },
      errs ? h('span', { class: 'status-err' }, `${errs} failed`) : null,
      h('span', { title: 'request sent → last content block written' }, fmtMs(latency)),
      h('span', { title: `input ${u.input} · cache read ${u.cacheRead} · cache write ${u.cacheWrite}` }, fmtTok(u.input + u.cacheRead + u.cacheWrite) + ' in'),
      h('span', { title: `includes ${u.thinking} thinking tokens` }, fmtTok(u.output) + ' out'),
      h('span', {}, c.stopReason || '')),
  ];
  return collapsible('call', `call:${c.id}`, row, () => {
    const kv = [
      ['request → last block', fmtMs(latency)],
      ['request → first block', fmtMs(c.firstTs - c.start)],
      ['tokens', `input ${u.input.toLocaleString()} · cache read ${u.cacheRead.toLocaleString()} · cache write ${u.cacheWrite.toLocaleString()} · output ${u.output.toLocaleString()} (thinking ${u.thinking.toLocaleString()})`],
      ['stop reason', c.stopReason || '–'],
      ['model', c.model || '–'],
      ['message id', c.id],
      c.requestId ? ['request id', c.requestId] : null,
      c.usage && c.usage.iterations && c.usage.iterations.length > 1 ? ['server iterations', String(c.usage.iterations.length)] : null,
    ].filter(Boolean);
    const out = [h('div', { class: 'kv small' }, kv.map(([k, v]) => [h('div', { class: 'k', style: 'padding-top:0' }, k), h('div', { class: 'mono' }, v)]))];
    if (c.thinking) {
      out.push(h('div', { class: 'label' }, `thinking (${c.thinking} block${c.thinking > 1 ? 's' : ''}, ${fmtTok(u.thinking)} tokens)`));
      if (c.thinkingText) out.push(...c.thinkingText.map((t) => clipped(t, ids)));
      else out.push(h('div', { class: 'muted small' }, 'Thinking content is not stored in the transcript.'));
    }
    if (c.texts.length) {
      out.push(h('div', { class: 'label' }, 'assistant text'));
      out.push(...c.texts.map((t) => clipped(t, ids, 'block text-block')));
    }
    if (c.tools.length) {
      out.push(h('div', { class: 'label' }, `tool calls (${c.tools.length})`));
      out.push(...c.tools.map((t) => toolCard(ids, t)));
    }
    return out;
  });
}

function toolCard(ids, t) {
  const status = t.resultTs == null ? h('span', { class: 'status-pending', title: 'no result recorded' }, '…')
    : t.isError ? h('span', { class: 'status-err' }, '✗') : h('span', { class: 'status-ok' }, '✓');
  const row = [
    status,
    h('span', { class: 'tname', title: t.name }, toolName(t.name)),
    t.server ? h('span', { class: 'badge' }, 'server') : null,
    t.subagent ? h('span', { class: 'badge task' }, 'subagent') : null,
    h('span', { class: 'grow mono muted' }, t.summary),
    h('span', { class: 'right' }, h('span', { title: 'tool_use → tool_result' }, fmtMs(t.durationMs))),
  ];
  return collapsible('tool', `tool:${t.id}`, row, () => {
    const out = [];
    if (t.subagent) {
      const href = `#/s/${encodeURIComponent(ids.p)}/${encodeURIComponent(ids.s)}/a/${encodeURIComponent(t.subagent.agentId)}`;
      out.push(h('div', { class: 'small', style: 'margin:4px 0' },
        h('a', { href }, `Open subagent trace → ${t.subagent.agentType || ''} “${t.subagent.description || t.subagent.agentId}”`),
        t.agentStats ? h('span', { class: 'muted' }, `  ·  ${fmtTok(t.agentStats.tokens)} tokens · ${t.agentStats.toolUses} tool uses`) : null));
    }
    if (t.reportedMs != null && Math.abs(t.reportedMs - (t.durationMs || 0)) > 1000) {
      out.push(h('div', { class: 'small muted' }, `tool-reported duration: ${fmtMs(t.reportedMs)}`));
    }
    const keys = Object.keys(t.input);
    out.push(h('div', { class: 'label' }, 'input'));
    out.push(keys.length ? h('div', { class: 'kv' }, keys.map((k) => [h('div', { class: 'k mono' }, k), clipped(t.input[k], ids)]))
      : h('div', { class: 'muted small' }, '(no arguments)'));
    out.push(h('div', { class: 'label' }, t.isError ? 'output (error)' : 'output'));
    out.push(t.output ? clipped(t.output, ids) : h('div', { class: 'muted small' }, 'No result recorded.'));
    out.push(h('div', { class: 'small muted', style: 'margin-top:6px' }, `id ${t.id} · started ${fmtTime(t.start)}${t.resultTs ? ' · finished ' + fmtTime(t.resultTs) : ''}`));
    return out;
  });
}

route();

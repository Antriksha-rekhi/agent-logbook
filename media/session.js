const vs = acquireVsCodeApi()
const $ = s => document.querySelector(s)
const el = (t, c, txt) => { const n = document.createElement(t); if (c) n.className = c; if (txt != null) n.textContent = txt; return n }
const send = m => vs.postMessage(m)
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

const nfmt = n => n >= 1e9 ? (n / 1e9).toFixed(1) + 'B'
  : n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M'
  : n >= 1e3 ? (n / 1e3).toFixed(0) + 'K' : String(Math.round(n))
const money = n => n >= 100 ? '$' + n.toFixed(0) : '$' + n.toFixed(n < 1 ? 4 : 2)
const dur = ms => {
  const s = Math.round(ms / 1000)
  if (s < 60) return s + 's'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`     // 793h means nothing; 33d does
}
const pct = (a, b) => b ? Math.round(a / b * 100) : 0
const when = ts => new Date(ts).toLocaleString(undefined,
  { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

const COLORS = ['#d97757', '#e8a87c', '#7fb069', '#e0a33e', '#b08968', '#9a8c98']
let A = null

// ---------------------------------------------------------------- tooltips
const tip = $('#tip')
function attachTips (root) {
  for (const n of root.querySelectorAll('[data-tip]')) {
    n.onmousemove = e => {
      tip.innerHTML = n.dataset.tip
      tip.hidden = false
      const pad = 14
      let x = e.clientX + pad, y = e.clientY + pad
      const b = tip.getBoundingClientRect()
      if (x + b.width > window.innerWidth - 8) x = e.clientX - b.width - pad
      if (y + b.height > window.innerHeight - 8) y = e.clientY - b.height - pad
      tip.style.left = x + 'px'
      tip.style.top = y + 'px'
    }
    n.onmouseleave = () => { tip.hidden = true }
  }
}
const tipRows = rows => rows.map(([k, v]) => `<div class="row"><span>${k}</span><b>${v}</b></div>`).join('')

/** A labelled figure with an optional note - the building block of these panels. */
function stat (box, label, value, note, tipHtml) {
  const row = el('div', 'srow')
  row.append(el('span', 'slabel', label), el('b', 'svalue', value))
  if (note) row.appendChild(el('span', 'snote', note))
  if (tipHtml) row.dataset.tip = tipHtml
  box.appendChild(row)
}

/** A proportion, drawn as a bar with its share written on the right. */
function meter (box, label, value, total, color, note) {
  const row = el('div', 'meter')
  const head = el('div', 'mhead')
  head.append(el('b', '', label), el('span', '', `${nfmt(value)} · ${pct(value, total)}%`))
  const track = el('div', 'mtrack')
  const fill = el('i')
  fill.style.width = `${Math.max(0.5, value / Math.max(1, total) * 100)}%`
  fill.style.background = color
  track.appendChild(fill)
  row.append(head, track)
  if (note) row.appendChild(el('p', '', note))
  box.appendChild(row)
}

function draw (a) {
  A = a
  $('#title').textContent = a.title || '(untitled)'
  $('#sub').textContent =
    `${a.project} · started ${when(a.firstTs)} · ${a.messages} messages · ${a.requests} requests`
  $('#open').onclick = () => send({ type: 'openChat', id: a.id })

  // --- the four numbers people open this for, money first
  const kpis = $('#kpis')
  kpis.innerHTML = ''
  const card = (label, value, note, tipHtml) => {
    const c = el('div', 'kpi')
    c.append(el('span', 'klabel', label), el('b', 'kvalue', value))
    if (note) c.appendChild(el('span', 'knote', note))
    if (tipHtml) c.dataset.tip = tipHtml
    kpis.appendChild(c)
  }
  card('Spent', money(a.cost), `${a.requests} requests at API prices`)
  card('Fullest context', nfmt(a.peak), `${a.pctWindow}% of the ${nfmt(a.window)} window`,
    `<b>The largest single request</b>${tipRows([
      ['Request', a.peak.toLocaleString()], ['Window', a.window.toLocaleString()],
    ])}`)
  card('Tokens moved', nfmt(a.tokens), `${nfmt(a.output)} written by Claude`)
  card('Read back from cache', `${(a.cacheHit * 100).toFixed(1)}%`, `${nfmt(a.cacheRead)} tokens`)
  attachTips(kpis)

  drawCost(a)
  drawTokens(a)
  drawModels(a)
  drawContext(a)
  drawCold(a)
  drawPace(a)
  drawShape(a)
  drawTools(a)
  drawAgents(a)
  drawFiles(a)
}

/** The context line, request by request, against the window - with compactions
    and cold restarts marked, since those are what make it drop or jump. */
function drawContext (a) {
  const box = $('#ctx')
  box.innerHTML = ''
  const pts = a.growth
  if (pts.length < 2) { box.appendChild(el('p', 'empty', 'Not enough requests to plot.')); return }
  $('#ctxmeta').textContent =
    `fullest ${nfmt(a.peak)} · now ${nfmt(a.latest)} · about +${nfmt(a.risePerRequest)} per request`

  const W = 900, H = 240, L = 46, R = 10, T = 12, B = 26
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`)
  svg.setAttribute('class', 'ctxchart')
  const add = (tag, attrs, cls) => {
    const n = document.createElementNS(ns, tag)
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v)
    if (cls) n.setAttribute('class', cls)
    svg.appendChild(n)
    return n
  }

  const top = Math.max(a.window, a.peak) * 1.08
  const x = i => L + i / (pts.length - 1) * (W - L - R)
  const y = v => H - B - (v / top) * (H - T - B)

  // a gridline every quarter, labelled in tokens
  for (let i = 0; i <= 4; i++) {
    const v = top / 4 * i
    add('path', { d: `M${L} ${y(v)}H${W - R}` }, 'grid')
    add('text', { x: L - 8, y: y(v) + 3.5, 'text-anchor': 'end' }, 'ylabel').textContent = nfmt(v)
  }
  // the window ceiling
  add('path', { d: `M${L} ${y(a.window)}H${W - R}` }, 'ceiling')
  add('text', { x: W - R, y: y(a.window) - 5, 'text-anchor': 'end' }, 'ceilinglabel')
    .textContent = `window ${nfmt(a.window)}`

  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.ctx).toFixed(1)}`).join('')
  add('path', { d: `${line}L${x(pts.length - 1)} ${H - B}L${L} ${H - B}Z` }, 'cfill')
  add('path', { d: line }, 'cline')

  const at = req => {
    const i = pts.findIndex(p => p.request >= req)
    return x(i < 0 ? pts.length - 1 : i)
  }
  for (const c of a.compactions) {
    const px = at(c.request)
    add('path', { d: `M${px} ${T}V${H - B}` }, 'markline compaction')
    add('circle', { cx: px, cy: y(c.to), r: 3.2 }, 'markdot compaction')
  }
  for (const r of a.cold.restarts) {
    const px = at(r.request)
    add('path', { d: `M${px} ${T}V${H - B}` }, 'markline cold')
    add('path', { d: `M${px} ${T - 3}l3.5 3.5L${px} ${T + 4}l-3.5-3.5Z` }, 'markdot cold')
  }

  // request numbers along the bottom
  const step = Math.max(1, Math.round(pts.length / 7))
  for (let i = 0; i < pts.length; i += step) {
    add('text', { x: x(i), y: H - 8, 'text-anchor': 'middle' }, 'xlabel')
      .textContent = String(pts[i].request)
  }
  box.appendChild(svg)

  const key = el('div', 'legendrow')
  const chip = (cls, text) => {
    const k = el('span', 'lkey')
    k.append(el('i', cls), el('span', '', text))
    key.appendChild(k)
  }
  chip('kline', 'Context')
  chip('kceiling', `Window ${nfmt(a.window)}`)
  if (a.compactions.length) chip('kcompact', `Compacted ×${a.compactions.length}`)
  if (a.cold.restarts.length) chip('kcold', `Went cold ×${a.cold.restarts.length}`)
  box.appendChild(key)
}

/** Breaks long enough that the stored conversation had to be written out again. */
function drawCold (a) {
  const c = a.cold
  if (!c.restarts.length) return
  $('#coldpanel').hidden = false
  const box = $('#coldkpis')
  box.innerHTML = ''
  const card = (label, value, note, warn) => {
    const k = el('div', 'kpi' + (warn ? ' warn' : ''))
    k.append(el('span', 'klabel', label), el('b', 'kvalue', value))
    if (note) k.appendChild(el('span', 'knote', note))
    box.appendChild(k)
  }
  card('Extra cost', money(c.extra), `${(c.extraShare * 100).toFixed(1)}% of what this chat cost`, true)
  card('Cold restarts', String(c.restarts.length), 'breaks longer than the cache lasts', true)
  card('Sent again', nfmt(c.resent), 'tokens written to the cache a second time')
  card('Time away', dur(c.away), 'those breaks added together')

  const t = $('#cold')
  t.innerHTML = `<thead><tr>
    <th>Back at</th><th>Request</th><th>Away for</th><th>Context then</th>
    <th>Sent again</th><th>Extra cost</th></tr></thead>`
  const body = el('tbody')
  for (const r of c.restarts) {
    const tr = el('tr')
    tr.innerHTML = `<td class="name">${when(r.at)}</td><td>#${r.request}</td>
      <td>${dur(r.away)}</td><td>${nfmt(r.context)}</td><td>${nfmt(r.resent)}</td>
      <td class="extra">${money(r.extra)}</td>`
    body.appendChild(tr)
  }
  const tr = el('tr', 'total')
  tr.innerHTML = `<td class="name">All breaks</td><td></td><td>${dur(c.away)}</td><td></td>
    <td>${nfmt(c.resent)}</td><td class="extra">${money(c.extra)}</td>`
  body.appendChild(tr)
  t.appendChild(body)
  $('#coldnote').textContent =
    `Claude only keeps a conversation cached for a while. Come back after that and the next request ` +
    `writes the whole context out again at the cache-write price; within the window it would have ` +
    `been read back for a tenth of the input price.`
}

/** What each kind of token came to, as a share of everything the chat moved. */
function drawTokens (a) {
  const box = $('#tokens')
  box.innerHTML = ''
  box.appendChild(el('h3', 'subhead', 'By kind of token'))
  const total = Math.max(1, a.tokens)
  meter(box, 'Read from cache', a.cacheRead, total, COLORS[0], 'earlier context, billed at a tenth of input')
  meter(box, 'Written to cache', a.cacheWrite, total, COLORS[1], 'stored so later requests can reuse it, 1.25× input')
  meter(box, 'Claude\'s replies', a.output, total, COLORS[2], 'output')
  meter(box, 'New input', a.input, total, COLORS[3], 'what you sent that was not cached')
  if (a.cacheHour || a.cacheFiveMin) {
    const extra = el('div', 'stats')
    if (a.cacheHour) stat(extra, 'Kept for an hour', nfmt(a.cacheHour), 'cache writes with the long lifetime')
    if (a.cacheFiveMin) stat(extra, 'Kept for five minutes', nfmt(a.cacheFiveMin), 'cache writes with the short lifetime')
    box.appendChild(extra)
  }
  attachTips(box)
}

/** Cost per model, then the same total per request and per message. */
function drawCost (a) {
  const box = $('#cost')
  box.innerHTML = ''
  box.appendChild(el('h3', 'subhead', 'By model'))
  if (!a.models.length) { box.appendChild(el('p', 'empty', 'No billable requests.')); return }
  a.models.forEach((m, i) => {
    meter(box, m.name, m.cost, a.cost || 1, COLORS[i % COLORS.length],
      `${m.requests} request${m.requests === 1 ? '' : 's'} · ${money(m.cost)}`)
  })
  const extra = el('div', 'stats')
  stat(extra, 'All of it', money(a.cost))
  stat(extra, 'Each request', money(a.cost / Math.max(1, a.requests)), 'on average')
  stat(extra, 'Each message you sent', money(a.cost / Math.max(1, a.prompts)), 'on average')
  box.appendChild(extra)
  attachTips(box)
}

/** How long it ran, how many replies each message drew, and how long those replies were. */
function drawPace (a) {
  const box = $('#pace')
  box.innerHTML = ''
  const stats = el('div', 'stats')
  stat(stats, 'Start to finish', dur(a.durationMs), `${when(a.firstTs)} to ${when(a.lastTs)}`)
  stat(stats, 'Actually working', dur(a.activeMs),
    `${pct(a.activeMs, a.durationMs)}% of that time`)
  stat(stats, 'Messages you sent', String(a.prompts))
  stat(stats, 'Replies to each', a.repliesPerAsk.toFixed(1),
    `up to ${a.longestRun} in a row`)
  const o = a.replyTokens
  stat(stats, 'Reply size', `${o.typical.toLocaleString()} tokens`,
    `usually; from ${o.shortest.toLocaleString()} to ${o.longest.toLocaleString()}`)
  stat(stats, 'Claude wrote', `${nfmt(a.output)} tokens`, 'in all')
  box.appendChild(stats)
  attachTips(box)
}

function drawTools (a) {
  const box = $('#tools')
  box.innerHTML = ''
  if (!a.tools.length) { box.appendChild(el('p', 'empty', 'No tools were used.')); return }
  const most = a.tools[0].n
  for (const t of a.tools.slice(0, 10)) meter(box, t.name, t.n, most, COLORS[0])
  attachTips(box)
}

function drawModels (a) {
  const t = $('#models')
  t.innerHTML = `<thead><tr>
    <th>Model</th><th>Cost</th><th>Share</th><th>Requests</th><th>New input</th>
    <th>Replies</th><th>From cache</th><th>To cache</th></tr></thead>`
  const body = el('tbody')
  for (const m of a.models) {
    const tr = el('tr')
    tr.innerHTML = `<td class="name">${esc(m.name)}</td><td class="cost">${money(m.cost)}</td>
      <td>${pct(m.cost, a.cost)}%</td><td>${m.requests}</td>
      <td>${nfmt(m.input)}</td><td>${nfmt(m.output)}</td>
      <td>${nfmt(m.cacheRead)}</td><td>${nfmt(m.cacheWrite)}</td>`
    body.appendChild(tr)
  }
  t.appendChild(body)
}

function drawAgents (a) {
  if (!a.agents.length) return
  $('#agentspanel').hidden = false
  const t = $('#agents')
  t.innerHTML = `<thead><tr>
    <th>Agent</th><th>Status</th><th>Messages</th><th>Tool calls</th><th>Tokens</th>
    <th>Ran for</th><th>Cost</th></tr></thead>`
  const body = el('tbody')
  let tokens = 0, cost = 0
  a.agents.forEach((g, i) => {
    tokens += g.tokens; cost += g.cost
    const tr = el('tr')
    // the name comes from the transcript, so it is written as text, not markup
    const name = el('td', 'name')
    name.textContent = g.name || `Run ${i + 1}`
    if (g.model) name.title = g.model
    tr.appendChild(name)
    const st = el('td', 'astatus ' + (g.status || ''))
    st.textContent = g.status || ''
    tr.appendChild(st)
    const rest = el('td'); rest.textContent = g.messages
    tr.appendChild(rest)
    tr.insertAdjacentHTML('beforeend',
      `<td>${g.tools}</td><td>${nfmt(g.tokens)}</td><td>${dur(g.ms)}</td>` +
      `<td class="cost">${money(g.cost)}</td>`)
    body.appendChild(tr)
  })
  const tr = el('tr', 'total')
  tr.innerHTML = `<td class="name">All agents · ${pct(tokens, a.tokens)}% of the chat's tokens</td><td></td><td></td><td></td>
    <td>${nfmt(tokens)}</td><td></td><td class="cost">${money(cost)}</td>`
  body.appendChild(tr)
  t.appendChild(body)
}

function drawShape (a) {
  const box = $('#shape')
  box.innerHTML = ''
  const stops = Object.entries(a.stops).sort((x, y) => y[1] - x[1])
  const total = stops.reduce((n, s) => n + s[1], 0)
  const toolUse = a.stops.tool_use || 0
  const label = { tool_use: 'Paused to run a tool', end_turn: 'Finished what it was saying',
    max_tokens: 'Ran out of room for the reply', stop_sequence: 'Reached a stop sequence' }
  for (const [k, n] of stops) meter(box, label[k] || k, n, total, COLORS[0])
  const stats = el('div', 'stats')
  stat(stats, 'Mostly', pct(toolUse, total) > 60 ? 'Running tools' : 'Talking',
    `${pct(toolUse, total)}% of replies stopped for a tool`)
  stat(stats, 'Thinking blocks', String(a.thinking),
    a.thinking ? `in ${a.thinkingTurns} replies` : '')
  if (a.queued) stat(stats, 'Interrupted', String(a.queued), 'times you stopped a reply')
  stat(stats, 'Steepest rise', `+${nfmt(a.steepestRise)}`, 'context added by one request')
  if (a.steepestFall < 0) {
    stat(stats, 'Steepest fall', `-${nfmt(-a.steepestFall)}`, 'after a compaction or a cold restart')
  }
  box.appendChild(stats)
  attachTips(box)
}

function drawFiles (a) {
  if (!a.files.length) return
  $('#filespanel').hidden = false
  const adds = a.files.reduce((n, f) => n + f.adds, 0)
  const dels = a.files.reduce((n, f) => n + f.dels, 0)
  $('#filesmeta').textContent = `${a.files.length} files · +${adds} -${dels}`
  const t = $('#files')
  t.innerHTML = '<thead><tr><th>File</th><th>Edits</th><th>Added</th><th>Removed</th></tr></thead>'
  const body = el('tbody')
  for (const f of a.files) {
    const tr = el('tr')
    tr.innerHTML = `<td class="name">${esc(f.path.split('/').pop())}</td><td>${f.edits}</td>
      <td class="adds">+${f.adds}</td><td class="dels">-${f.dels}</td>`
    tr.title = f.path
    tr.onclick = () => send({ type: 'openFile', path: f.path })
    body.appendChild(tr)
  }
  t.appendChild(body)
}

window.addEventListener('message', e => { if (e.data.type === 'analytics') draw(e.data.data) })
send({ type: 'ready' })

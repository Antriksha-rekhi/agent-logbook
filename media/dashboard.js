const vs = acquireVsCodeApi()
const $ = s => document.querySelector(s)
const el = (t, c, txt) => { const n = document.createElement(t); if (c) n.className = c; if (txt != null) n.textContent = txt; return n }
const send = m => vs.postMessage(m)
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

const nfmt = n => n >= 1e9 ? (n / 1e9).toFixed(1) + 'B'
  : n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M'
  : n >= 1e3 ? (n / 1e3).toFixed(0) + 'K' : String(Math.round(n))
const money = n => n >= 100 ? '$' + n.toFixed(0) : '$' + n.toFixed(2)
const dur = ms => { const m = Math.round(ms / 6e4); return m < 60 ? m + 'm' : (m / 60).toFixed(m / 60 >= 10 ? 0 : 1) + 'h' }
const pct = (a, b) => b ? Math.round(a / b * 100) : 0
/** 0.998 reads as 99.8%, not 100% - rounding away a real remainder is a lie. */
const shareText = (part, whole, alone) => {
  if (!whole) return '0%'
  const p = part / whole * 100
  if (!alone && p > 99.5 && p < 100) return p.toFixed(1) + '%'
  if (!alone && p > 0 && p < 0.5) return p < 0.05 ? '<0.1%' : p.toFixed(1) + '%'
  return Math.round(p) + '%'
}
const dayName = d => new Date(d + 'T12:00').toLocaleDateString(undefined, { weekday: 'short' })
const niceDay = d => new Date(d + 'T12:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
const hour = h => `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? 'am' : 'pm'}`

// clay first, then warm supports, so the charts read as part of the panel
const COLORS = ['#d97757', '#e8a87c', '#7fb069', '#e0a33e', '#b08968', '#9a8c98']
let DATA = null, SORT = 'cost'

// ---------------------------------------------------------------- tooltips
// One popover that follows the cursor, rather than native titles that arrive
// half a second late and cannot show a breakdown.
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

// ---------------------------------------------------------------- ranges
$('#ranges').onclick = e => {
  const b = e.target.closest('button')
  if (!b) return
  document.querySelectorAll('#ranges button').forEach(x => x.classList.toggle('on', x === b))
  send({ type: 'dashboard', days: Number(b.dataset.days) })
}
$('#sortby').onchange = () => { SORT = $('#sortby').value; drawChats() }
document.querySelectorAll('.tab').forEach(b => b.onclick = () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('on', x === b))
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('on', v.id === 'v-' + b.dataset.tab))
})

// ---------------------------------------------------------------- render
function draw (d) {
  DATA = d
  const t = d.totals
  const days = Object.entries(d.byDay)
  const active = days.filter(([, v]) => v.tokens).length

  $('#sub').textContent =
    `${d.days ? `Last ${d.days} days` : 'All time'} · ${t.sessions} chats · built from the transcripts on this machine`

  // --- KPI cards
  const kpis = $('#kpis')
  kpis.innerHTML = ''
  const card = (label, value, note, tipHtml) => {
    const c = el('div', 'kpi')
    c.append(el('span', 'klabel', label), el('b', 'kvalue', value))
    if (note) c.appendChild(el('span', 'knote', note))
    if (tipHtml) c.dataset.tip = tipHtml
    kpis.appendChild(c)
    return c
  }
  // The token total can span two CLIs while the cost only covers one, so the
  // cards say which share is priced rather than leaving the gap unexplained.
  const sp = d.bySource
  const mixed = !!(sp && sp.codex.tokens > 0 && sp.claude.tokens > 0)
  card('Cost at API prices', money(t.cost),
    mixed ? 'Claude only - Codex bills against a plan'
      : active ? `${money(t.cost / active)} on an average working day` : '',
    `<b>What you would have paid on the API</b>${tipRows([
      ['Input', nfmt(t.input)], ['Output', nfmt(t.output)],
      ['Cache writes', nfmt(t.cacheWrite)], ['Cache reads', nfmt(t.cacheRead)],
    ])}<hr><div class="row"><span>Total</span><b>${money(t.cost)}</b></div>`)
  card('Tokens', nfmt(t.tokens), mixed
    ? `${pct(sp.claude.tokens, t.tokens)}% Claude · ${pct(sp.codex.tokens, t.tokens)}% Codex`
    : `${nfmt(t.output)} of it written by Claude`,
  mixed ? `<b>Where the tokens came from</b>${tipRows([
    ['Claude Code', `${nfmt(sp.claude.tokens)} · ${money(sp.claude.cost)}`],
    ['Codex', `${nfmt(sp.codex.tokens)} · no price`],
  ])}` : '')
  card('Chats', String(t.sessions), mixed
    ? `${sp.claude.sessions} Claude · ${sp.codex.sessions} Codex`
    : `${t.messages.toLocaleString()} messages`)
  card('File edits', t.edits.toLocaleString(), `across ${d.projects.length} project${d.projects.length === 1 ? '' : 's'}`)
  card('Time spent', dur(t.activeMs), `${active} of ${days.length} days worked`)
  card('Streak', `${d.streaks.current}d`, `best ${d.streaks.best} days · ${d.streaks.totalDays} days ever`)
  attachTips(kpis)

  drawTrend(days)
  drawHeat(d.heatmap)
  drawModels(d.models, t.tokens)
  drawModelTurns(d.models)
  drawSplit(t)
  drawHours(d.byHour)
  drawHourCost(d.byHourCost)
  drawWeekdays(d.byWeekday)
  drawDayTable(days)
  drawProjects(d.projects, t)
  drawProjShare(d.projects, t)
  drawFiles(d.files)
  drawOps(d.ops)
  drawEfficiency(d)
  drawPlan(d.limits)
  drawChats()

}

function drawTrend (days) {
  const peak = Math.max(1, ...days.map(([, v]) => v.cost))
  const total = days.reduce((n, [, v]) => n + v.cost, 0)
  const best = days.reduce((a, b) => (b[1].cost > (a?.[1]?.cost || 0) ? b : a), null)
  $('#trendmeta').textContent = best && best[1].cost
    ? `peak ${money(best[1].cost)} on ${niceDay(best[0])}` : ''
  const wrap = el('div', 'bars')
  for (const [d, v] of days) {
    const col = el('div', 'bar' + (v.cost ? '' : ' idle'))
    const fill = el('i')
    if (v.cost) fill.style.height = `${Math.max(2, v.cost / peak * 100)}%`
    col.appendChild(fill)
    col.dataset.tip = `<b>${niceDay(d)}</b>${tipRows([
      ['Cost', money(v.cost)], ['Tokens', nfmt(v.tokens)],
      ['Messages', String(v.messages)], ['File edits', String(v.edits)],
    ])}<hr><div class="row"><span>Share of period</span><b>${pct(v.cost, total)}%</b></div>`
    wrap.appendChild(col)
  }
  const box = $('#trend')
  box.innerHTML = ''
  box.appendChild(wrap)
  // a label every few days, so the axis stays readable at 90 days
  const axis = el('div', 'axis')
  const step = Math.ceil(days.length / 8)
  days.forEach(([d], i) => {
    const c = el('span', '', i % step === 0 ? niceDay(d) : '')
    axis.appendChild(c)
  })
  box.appendChild(axis)
  attachTips(box)
}

function drawModels (models, total) {
  const box = $('#models')
  box.innerHTML = ''
  if (!models.length) { box.appendChild(el('p', 'empty', 'No usage in this window.')); return }
  const bar = el('div', 'stack')
  models.forEach((m, i) => {
    const seg = el('i')
    const share = m.tokens / Math.max(1, total)
    seg.style.width = `${share * 100}%`
    seg.style.background = COLORS[i % COLORS.length]
    // the segment only carries text when there is room for it
    const label = shareText(m.tokens, total, models.length === 1)
    if (share >= 0.2) seg.textContent = `${m.name} ${label}`
    else if (share >= 0.08) seg.textContent = label
    seg.dataset.tip = `<b>${esc(m.name)}</b>${tipRows([
      ['Tokens', nfmt(m.tokens)], ['Cost', m.cost ? money(m.cost) : 'no price'], ['Share', label],
    ])}`
    bar.appendChild(seg)
  })
  box.appendChild(bar)
  for (const [i, m] of models.entries()) {
    const row = el('div', 'legend')
    const dot = el('i'); dot.style.background = COLORS[i % COLORS.length]
    row.append(dot, el('span', 'lname', m.name),
      el('span', 'lval', nfmt(m.tokens)),
      el('span', 'lcost', m.cost ? money(m.cost) : '-'))
    box.appendChild(row)
  }
  attachTips(box)
}

function drawSplit (t) {
  const parts = [
    ['Cache reads', t.cacheRead, 'replayed context, billed at a tenth of input'],
    ['Cache writes', t.cacheWrite, 'context stored for reuse, billed at 1.25× input'],
    ['Output', t.output, 'what Claude wrote'],
    ['Input', t.input, 'new text you sent'],
  ]
  const total = Math.max(1, parts.reduce((n, p) => n + p[1], 0))
  const box = $('#split')
  box.innerHTML = ''
  parts.forEach(([name, v, why], i) => {
    const row = el('div', 'meter')
    const head = el('div', 'mhead')
    head.append(el('b', '', name), el('span', '', `${nfmt(v)} · ${pct(v, total)}%`))
    const track = el('div', 'mtrack')
    const fill = el('i')
    fill.style.width = `${Math.max(0.5, v / total * 100)}%`
    fill.style.background = COLORS[i % COLORS.length]
    track.appendChild(fill)
    row.append(head, track, el('p', '', why))
    row.dataset.tip = `<b>${esc(name)}</b>${tipRows([['Tokens', nfmt(v)], ['Share', pct(v, total) + '%']])}`
    box.appendChild(row)
  })
  attachTips(box)
}

function drawHours (byHour) {
  const peak = Math.max(1, ...Object.values(byHour))
  const box = $('#hours')
  box.innerHTML = ''
  const wrap = el('div', 'bars tall')
  for (let h = 0; h < 24; h++) {
    const n = byHour[h] || 0
    const col = el('div', 'bar' + (n ? '' : ' idle'))
    const fill = el('i')
    if (n) fill.style.height = `${Math.max(3, n / peak * 100)}%`
    col.appendChild(fill)
    col.dataset.tip = `<b>${hour(h)}</b>${tipRows([['Messages', String(n)]])}`
    wrap.appendChild(col)
  }
  box.appendChild(wrap)
  const axis = el('div', 'axis')
  for (let h = 0; h < 24; h++) axis.appendChild(el('span', '', h % 6 === 0 ? hour(h) : ''))
  box.appendChild(axis)
  attachTips(box)
}

function drawWeekdays (byWeekday) {
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const peak = Math.max(1, ...Object.values(byWeekday))
  const box = $('#weekdays')
  box.innerHTML = ''
  for (let i = 0; i < 7; i++) {
    const v = byWeekday[i] || 0
    const row = el('div', 'meter compact')
    const head = el('div', 'mhead')
    head.append(el('b', '', names[i]), el('span', '', nfmt(v)))
    const track = el('div', 'mtrack')
    const fill = el('i')
    fill.style.width = `${Math.max(0.5, v / peak * 100)}%`
    fill.style.background = i === 0 || i === 6 ? '#b08968' : '#d97757'
    track.appendChild(fill)
    row.append(head, track)
    row.dataset.tip = `<b>${names[i]}</b>${tipRows([['Tokens', nfmt(v)]])}`
    box.appendChild(row)
  }
  attachTips(box)
}

function drawProjects (projects, totals) {
  const t = $('#projects')
  t.innerHTML = `<thead><tr>
    <th>Project</th><th>Chats</th><th>Tokens</th><th>File edits</th>
    <th>Time spent</th><th>Cost</th><th>Share</th></tr></thead>`
  const body = el('tbody')
  for (const p of projects) {
    const share = pct(p.cost, totals.cost)
    const tr = el('tr')
    tr.innerHTML = `<td class="name">${esc(p.name)}</td>
      <td>${p.sessions}</td><td>${nfmt(p.tokens)}</td><td>${p.edits}</td>
      <td>${dur(p.activeMs)}</td><td class="cost">${money(p.cost)}</td>
      <td><div class="minibar"><i style="width:${share}%"></i></div><span class="mini">${share}%</span></td>`
    tr.dataset.tip = `<b>${esc(p.name)}</b>${tipRows([
      ['Chats', String(p.sessions)], ['Tokens', nfmt(p.tokens)],
      ['File edits', String(p.edits)], ['Time spent', dur(p.activeMs)],
      ['Cost', money(p.cost)],
    ])}`
    body.appendChild(tr)
  }
  t.appendChild(body)
  attachTips(t)
}

function drawChats () {
  if (!DATA) return
  const rows = [...DATA.chats].sort((a, b) => b[SORT] - a[SORT]).slice(0, 25)
  const t = $('#chats')
  t.innerHTML = `<thead><tr>
    <th>Chat</th><th>Project</th><th>Dates</th><th>Messages</th><th>File edits</th>
    <th>Tokens</th><th>Cache hit</th><th>Time spent</th><th>Cost</th></tr></thead>`
  const body = el('tbody')
  for (const c of rows) {
    const tr = el('tr')
    const span = c.firstTs && new Date(c.firstTs).toDateString() !== new Date(c.lastTs).toDateString()
      ? `${niceDay(new Date(c.firstTs).toISOString().slice(0, 10))} – ${niceDay(new Date(c.lastTs).toISOString().slice(0, 10))}`
      : niceDay(new Date(c.lastTs).toISOString().slice(0, 10))
    tr.innerHTML = `<td class="name">${esc(c.title)}</td>
      <td class="dim">${esc(c.project)}</td><td class="dim">${span}</td>
      <td>${c.messages}</td><td>${c.edits}</td>
      <td>${nfmt(c.tokens)}</td><td>${(c.cacheHit * 100).toFixed(1)}%</td>
      <td>${dur(c.activeMs)}</td><td class="cost">${money(c.cost)}</td>`
    tr.title = 'Open this chat'
    tr.onclick = () => send({ type: 'openChat', id: c.id })
    body.appendChild(tr)
  }
  t.appendChild(body)
}


// ---------------------------------------------------------------- new panels
/** A year as a calendar grid, one square per day. */
function drawHeat (map) {
  const box = $('#heat')
  box.innerHTML = ''
  const vals = Object.values(map).filter(Boolean)
  if (!vals.length) { box.appendChild(el('p', 'empty', 'Nothing recorded yet.')); return }
  const peak = Math.max(...vals)
  const start = new Date(Date.now() - 364 * 864e5)
  start.setDate(start.getDate() - start.getDay())          // begin on a Sunday
  const grid = el('div', 'heat')
  const months = el('div', 'heatmonths')
  let lastMonth = -1
  for (let w = 0; w < 53; w++) {
    const col = el('div', 'hweek')
    for (let dow = 0; dow < 7; dow++) {
      const dt = new Date(start.getTime() + (w * 7 + dow) * 864e5)
      const key = dt.toISOString().slice(0, 10)
      const v = map[key] || 0
      const cell = el('i')
      // five steps, so a quiet day still reads as different from nothing
      const step = !v ? 0 : v / peak > 0.6 ? 4 : v / peak > 0.35 ? 3 : v / peak > 0.15 ? 2 : 1
      cell.className = 'h' + step
      if (dt > new Date()) cell.classList.add('future')
      cell.dataset.tip = `<b>${niceDay(key)}</b>${tipRows([['Tokens', v ? nfmt(v) : 'none']])}`
      col.appendChild(cell)
    }
    // one label cell per week, fixed width; the text overflows without moving anything
    const when = new Date(start.getTime() + w * 7 * 864e5)
    const m = when.getMonth()
    const lab = el('span', '', m !== lastMonth
      ? when.toLocaleDateString(undefined, { month: 'short' }) : '')
    months.appendChild(lab)
    lastMonth = m
    grid.appendChild(col)
  }
  // months and weeks live in one scroller, so they can never drift apart
  const scroll = el('div', 'heatscroll')
  const inner = el('div', 'heatinner')
  inner.append(months, grid)
  scroll.appendChild(inner)
  box.appendChild(scroll)
  const legend = el('div', 'heatlegend')
  legend.append(el('span', '', 'less'))
  for (let i = 0; i <= 4; i++) { const c = el('i', 'h' + i); legend.appendChild(c) }
  legend.append(el('span', '', 'more'))
  box.appendChild(legend)
  attachTips(box)
}

function drawHourCost (byHourCost) {
  const peak = Math.max(1, ...Object.values(byHourCost))
  const box = $('#hourcost')
  box.innerHTML = ''
  const wrap = el('div', 'bars tall')
  for (let h = 0; h < 24; h++) {
    const v = byHourCost[h] || 0
    const col = el('div', 'bar' + (v ? '' : ' idle'))
    const fill = el('i')
    if (v) { fill.style.height = `${Math.max(3, v / peak * 100)}%`; fill.style.background = '#e0a33e' }
    col.appendChild(fill)
    col.dataset.tip = `<b>${hour(h)}</b>${tipRows([['Cost', money(v)]])}`
    wrap.appendChild(col)
  }
  box.appendChild(wrap)
  const axis = el('div', 'axis')
  for (let h = 0; h < 24; h++) axis.appendChild(el('span', '', h % 6 === 0 ? hour(h) : ''))
  box.appendChild(axis)
  attachTips(box)
}

function drawDayTable (days) {
  const t = $('#daytable')
  t.innerHTML = `<thead><tr>
    <th>Date</th><th>Chats</th><th>Messages</th><th>Input</th><th>Output</th>
    <th>Cache written</th><th>Cache read</th><th>File edits</th><th>Cost</th></tr></thead>`
  const body = el('tbody')
  for (const [d, v] of [...days].reverse()) {
    if (!v.tokens) continue
    const tr = el('tr')
    tr.innerHTML = `<td class="name">${d}</td><td>${v.sessions}</td><td>${v.messages}</td>
      <td>${nfmt(v.input)}</td><td>${nfmt(v.output)}</td>
      <td>${nfmt(v.cacheWrite)}</td><td>${nfmt(v.cacheRead)}</td>
      <td>${v.edits}</td><td class="cost">${money(v.cost)}</td>`
    body.appendChild(tr)
  }
  if (!body.children.length) body.innerHTML = '<tr><td class="name">Nothing in this period.</td></tr>'
  t.appendChild(body)
}

function drawProjShare (projects, totals) {
  const box = $('#projshare')
  box.innerHTML = ''
  if (!projects.length) { box.appendChild(el('p', 'empty', 'No projects in this window.')); return }
  const bar = el('div', 'stack')
  projects.forEach((p, i) => {
    const share = p.cost / Math.max(0.01, totals.cost)
    const seg = el('i')
    seg.style.width = `${share * 100}%`
    seg.style.background = COLORS[i % COLORS.length]
    const label = shareText(p.cost, totals.cost, projects.length === 1)
    if (share >= 0.2) seg.textContent = `${p.name} ${label}`
    else if (share >= 0.08) seg.textContent = label
    seg.dataset.tip = `<b>${esc(p.name)}</b>${tipRows([
      ['Cost', money(p.cost)], ['Share', label],
      ['Chats', String(p.sessions)], ['Tokens', nfmt(p.tokens)],
    ])}`
    bar.appendChild(seg)
  })
  box.appendChild(bar)
  projects.forEach((p, i) => {
    const row = el('div', 'legend')
    const dot = el('i'); dot.style.background = COLORS[i % COLORS.length]
    row.append(dot, el('span', 'lname', p.name), el('span', 'lval', nfmt(p.tokens)),
      el('span', 'lcost', money(p.cost)))
    box.appendChild(row)
  })
  attachTips(box)
}

function drawModelTurns (models) {
  const box = $('#modelturns')
  box.innerHTML = ''
  const withTurns = models.filter(m => m.turns)
  if (!withTurns.length) { box.appendChild(el('p', 'empty', 'No replies in this window.')); return }
  const peak = Math.max(...withTurns.map(m => m.turns))
  withTurns.forEach((m, i) => {
    const row = el('div', 'meter')
    const head = el('div', 'mhead')
    head.append(el('b', '', m.name), el('span', '', `${m.turns.toLocaleString()} replies`))
    const track = el('div', 'mtrack')
    const fill = el('i')
    fill.style.width = `${m.turns / peak * 100}%`
    fill.style.background = COLORS[i % COLORS.length]
    track.appendChild(fill)
    row.append(head, track)
    row.dataset.tip = `<b>${esc(m.name)}</b>${tipRows([
      ['Replies', m.turns.toLocaleString()], ['Tokens', nfmt(m.tokens)],
      ['Cost', m.cost ? money(m.cost) : 'no price'],
    ])}`
    box.appendChild(row)
  })
  attachTips(box)
}

function drawFiles (files) {
  const box = $('#files')
  box.innerHTML = ''
  if (!files.length) { box.appendChild(el('p', 'empty', 'No files changed in this window.')); return }
  const peak = files[0].n
  for (const f of files) {
    const row = el('div', 'filerow')
    const name = f.path.split('/').pop()
    const dir = f.path.replace(/\/[^/]+$/, '').split('/').slice(-2).join('/')
    const head = el('div', 'mhead')
    head.append(el('b', '', name), el('span', '', `${f.n}×`))
    const track = el('div', 'mtrack')
    const fill = el('i')
    fill.style.width = `${f.n / peak * 100}%`
    track.appendChild(fill)
    row.append(head, track, el('p', '', '…/' + dir))
    row.dataset.tip = `<b>${esc(name)}</b>${tipRows([['Changes', String(f.n)]])}<hr>
      <div class="row"><span>${esc(f.path)}</span></div>`
    row.onclick = () => send({ type: 'openFile', path: f.path })
    box.appendChild(row)
  }
  attachTips(box)
}

function drawOps (ops) {
  const box = $('#ops')
  box.innerHTML = ''
  const names = { edit: 'Edits to part of a file', write: 'Whole files written',
    notebook: 'Notebook cells', delete: 'Deletes run in the shell' }
  const rows = Object.entries(ops).filter(([, n]) => n).sort((a, b) => b[1] - a[1])
  if (!rows.length) { box.appendChild(el('p', 'empty', 'No changes in this window.')); return }
  const total = rows.reduce((n, r) => n + r[1], 0)
  const bar = el('div', 'stack')
  rows.forEach(([k, n], i) => {
    const share = n / total
    const seg = el('i')
    seg.style.width = `${share * 100}%`
    seg.style.background = COLORS[i % COLORS.length]
    const label = shareText(n, total, rows.length === 1)
    if (share >= 0.2) seg.textContent = `${k} ${label}`
    else if (share >= 0.08) seg.textContent = label
    seg.dataset.tip = `<b>${names[k] || k}</b>${tipRows([['Count', String(n)], ['Share', label]])}`
    bar.appendChild(seg)
  })
  box.appendChild(bar)
  rows.forEach(([k, n], i) => {
    const row = el('div', 'legend')
    const dot = el('i'); dot.style.background = COLORS[i % COLORS.length]
    row.append(dot, el('span', 'lname', names[k] || k), el('span', 'lval', String(n)))
    box.appendChild(row)
  })
  attachTips(box)
}

function drawEfficiency (d) {
  const e = d.efficiency
  const box = $('#effkpis')
  box.innerHTML = ''
  const card = (label, value, note) => {
    const c = el('div', 'kpi')
    c.append(el('span', 'klabel', label), el('b', 'kvalue', value))
    if (note) c.appendChild(el('span', 'knote', note))
    box.appendChild(c)
  }
  card('Cache hit rate', `${(e.cacheHit * 100).toFixed(1)}%`, 'of context served from cache')
  card('Cost per message', '$' + e.costPerMsg.toFixed(4), 'at API prices')
  card('Tokens per message', nfmt(e.tokensPerMsg), 'context replayed each turn')
  card('Replies', d.totals.turns.toLocaleString(), 'messages you sent')

  const t = $('#efftable')
  t.innerHTML = `<thead><tr>
    <th>Chat</th><th>Messages</th><th>Cache hit</th><th>Cost per message</th>
    <th>Tokens per message</th><th>Cost</th></tr></thead>`
  const body = el('tbody')
  for (const c of [...d.chats].sort((a, b) => b.cost - a.cost).slice(0, 25)) {
    const tr = el('tr')
    tr.innerHTML = `<td class="name">${esc(c.title)}</td><td>${c.messages}</td>
      <td>${(c.cacheHit * 100).toFixed(1)}%</td>
      <td>$${c.costPerMsg.toFixed(4)}</td><td>${nfmt(c.tokensPerMsg)}</td>
      <td class="cost">${money(c.cost)}</td>`
    tr.onclick = () => send({ type: 'openChat', id: c.id })
    body.appendChild(tr)
  }
  t.appendChild(body)
}

function drawPlan (limits) {
  const box = $('#plankpis')
  box.innerHTML = ''
  // the sidebar strip hides the all-models weekly for space; here there is room
  // for every window Anthropic reports
  const order = { session: 0, weekly_all: 1, weekly_scoped: 2 }
  const items = [...(limits?.items || [])].sort((a, b) => (order[a.key] ?? 9) - (order[b.key] ?? 9))
  if (!items.length) {
    box.appendChild(el('p', 'empty', 'No plan usage recorded yet.'))
  }
  for (const x of items) {
    const left = Math.max(0, 100 - x.percent)
    const c = el('div', 'kpi')
    c.append(el('span', 'klabel', x.label), el('b', 'kvalue', `${left}% left`))
    const track = el('div', 'mtrack')
    const fill = el('i')
    fill.style.width = `${left}%`
    fill.style.background = left > 40 ? '#7fb069' : left > 15 ? '#e0a33e' : '#d9534f'
    track.appendChild(fill)
    c.appendChild(track)
    c.appendChild(el('span', 'knote', x.resetsAt
      ? `resets in ${untilText(x.resetsAt)}` : 'rolling window'))
    box.appendChild(c)
  }
  $('#planexplain').innerHTML = `
    <div class="phead"><h2>What these windows mean</h2></div>
    <p class="note">Claude Code enforces a rolling five-hour window and a weekly one, with a
    separate weekly allowance for Fable. The figures come straight from Anthropic, refreshed
    when this page opens - they are about your plan, not about the API prices used elsewhere
    on this dashboard.</p>
    <p class="note">Read ${limits?.fetchedAt ? relTime(limits.fetchedAt) : 'never'}.
    ${limits?.lastError ? `Last refresh failed: ${esc(limits.lastError)}.` : ''}</p>`
}

const untilText = ms => {
  const m = Math.max(0, Math.round((ms - Date.now()) / 6e4))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`
}
const relTime = ts => {
  const s = (Date.now() - ts) / 1000
  return s < 90 ? 'just now' : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`
}

window.addEventListener('message', e => { if (e.data.type === 'dashboard') draw(e.data.data) })
send({ type: 'dashboard', days: 30 })

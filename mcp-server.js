#!/usr/bin/env node
/**
 * Agent Logbook's MCP server: your Claude Code and Codex history, offered to
 * any agent that speaks MCP. Claude Code or Codex starts it on its own (stdio),
 * so it works with the editor closed and never needs a port.
 *
 * Read-only. Everything stays on this machine.
 *
 *   node mcp-server.js [--project-only]
 *
 * --project-only limits every tool to chats that ran in the folder the agent
 * was started in, or beneath it.
 */
const fs = require('node:fs')
const path = require('node:path')
const readline = require('node:readline')
const scan = require('./scan.js')

const VERSION = '1.0.0'
const PROJECT_ONLY = process.argv.includes('--project-only')
const ROOT = process.cwd()

// --------------------------------------------------------------- helpers
// Started in the home folder (or /), "beneath it" would be every project there is,
// so there the scope is that folder's own chats and nothing under it.
const BROAD = ROOT === require('node:os').homedir() || ROOT === path.parse(ROOT).root
const inScope = rec => !PROJECT_ONLY ||
  (rec.cwd && (rec.cwd === ROOT || (!BROAD && rec.cwd.startsWith(ROOT + path.sep))))
const sessions = () => scan.index().filter(inScope)
const when = ts => ts ? new Date(ts).toISOString().replace('T', ' ').slice(0, 16) : ''
const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n) + ` … [${s.length - n} more chars]` : s }

/** A session by full id or a unique prefix of one, as people paste them. */
function find (id) {
  const want = String(id || '').trim()
  if (!want) throw new Error('id is required')
  const all = sessions()
  const exact = all.find(s => s.id === want)
  if (exact) return exact
  const hits = all.filter(s => s.id.startsWith(want))
  if (hits.length === 1) return hits[0]
  if (hits.length > 1) throw new Error(`"${want}" matches ${hits.length} sessions - give more of the id`)
  throw new Error(`No session ${want}${PROJECT_ONLY ? ' in this project' : ''}`)
}

const line = s => `- ${s.title || '(untitled)'} · ${s.provider || 'claude'} · ${s.project || scan.projectName(s.cwd || '')} · ` +
  `last active ${when(s.lastTs)} · ${s.messages || 0} messages · id ${s.id}`

/** Compact line diff of an edit: removed lines, then added ones. */
function diffOf (e) {
  const out = [`--- ${e.path} (${e.tool}, +${e.adds} -${e.dels})`]
  if (e.old) for (const l of String(e.old).split('\n')) out.push('- ' + l)
  if (e.new) for (const l of String(e.new).split('\n')) out.push('+ ' + l)
  return out.join('\n')
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

// Old chats hold whatever a terminal printed: .env files, keys, tokens. An agent
// that reads them could be talked into passing them on, so nothing that looks
// like a secret leaves this server. The value goes; the name next to it stays,
// so "which chat set the Stripe key" still has an answer.
const HIDDEN = '[redacted secret]'
const PLAIN = /^(?:\d+|true|false|null|undefined|required|optional|string|number|boolean|none|\[redacted.*)$/i
const SECRETS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, HIDDEN],
  [/\bsk-ant-[\w-]{10,}/g, HIDDEN],                                   // Anthropic
  [/\bsk-(?:proj-|svcacct-|admin-)?[\w-]{20,}/g, HIDDEN],             // OpenAI
  [/\b(?:sk|rk|pk)_(?:live|test)_\w{10,}/g, HIDDEN],                  // Stripe
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, HIDDEN],                         // AWS access key id
  [/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_\w{30,})/g, HIDDEN],   // GitHub
  [/\bglpat-[\w-]{20,}/g, HIDDEN],                                    // GitLab
  [/\bxox[abprs]-[\w-]{10,}/g, HIDDEN],                               // Slack
  [/\bAIza[\w-]{35}\b/g, HIDDEN],                                     // Google
  [/\bnpm_[A-Za-z0-9]{36}\b/g, HIDDEN],                               // npm
  [/\beyJ[\w-]{10,}\.eyJ[\w-]{10,}\.[\w-]{10,}/g, HIDDEN],            // JWT
  [/\b(Bearer|Basic)\s+[\w.~+/=-]{16,}/gi, '$1 [redacted]'],
  [/(:\/\/[^\s:/@"']+:)[^\s@/"']+@/g, '$1[redacted]@'],                // user:password@host
  // name = value, name: "value", "name":"value" (also as escaped JSON) for
  // anything secret-sounding; numbers and the like are left alone
  [/((?:pass(?:word|wd)?|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|authorization|auth[_-]?token|credentials?)[\w-]*\\?["']?\s*[:=]\s*\\?["']?)([^\s"'\\,;{}]{8,})/gi,
    (m, name, value) => PLAIN.test(value) ? m : `${name}[redacted]`],
]
const redact = text => SECRETS.reduce((s, [rx, to]) => s.replace(rx, to), String(text ?? ''))

// A pattern an agent sends runs over megabytes of text in one go, and nothing
// can interrupt a regular expression once it starts. Refuse the shapes that
// backtrack without end - a repeated group that itself repeats, a repeated
// group holding an alternation, and back-references.
function safeRegex (pattern) {
  const p = String(pattern)
  if (p.length > 200) throw new Error('pattern is too long (200 characters at most)')
  if (/\((?:[^()\\]|\\.)*[+*}|](?:[^()\\]|\\.)*\)\s*[+*{]/.test(p) || /\\\d/.test(p) ||
      /\)\s*[+*{?]\s*\)?\s*[+*{]/.test(p) ||
      /\((?:[^()\\]|\\.)*\([\s\S]*\)(?:[^()\\]|\\.)*\)\s*[+*{]/.test(p)) {
    throw new Error('pattern has a repeated group inside a repetition, an alternation inside a repeated group, or a back-reference, which can take forever - simplify it')
  }
  return new RegExp(p, 'i')
}

// --------------------------------------------------------------- tools
const TOOLS = [
  {
    name: 'recent_chats',
    description: 'The Claude Code and Codex chats on this machine, most recently active first, one line each with its title, ' +
      'tool, project, last activity and id. Start here for "what was I doing yesterday" or to pick a chat to carry on.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'How many (default 20, max 100)' },
        project: { type: 'string', description: 'Only chats whose project or folder contains this text' },
        provider: { type: 'string', enum: ['claude', 'codex'], description: 'Only one tool\'s chats' },
      },
    },
    run ({ limit = 20, project, provider }) {
      let all = sessions()
      if (project) { const p = project.toLowerCase(); all = all.filter(s => `${s.project} ${s.cwd}`.toLowerCase().includes(p)) }
      if (provider) all = all.filter(s => (s.provider || 'claude') === provider)
      const shown = all.slice(0, Math.min(100, limit))
      return shown.length ? shown.map(line).join('\n') : 'No sessions found.'
    },
  },
  {
    name: 'search_chats',
    description: 'Looks through the conversation itself - what the person asked and what the agent answered - and returns ' +
      'the chats that mention the words, each with a few quoted lines. Command output and file contents are not ' +
      'searched here; find_text covers those.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Words or a phrase, case-insensitive' },
        limit: { type: 'number', description: 'Most sessions to return (default 10)' },
      },
    },
    run ({ query, limit = 10 }) {
      // secrets are redacted before matching, so a query cannot probe for them
      const r = scan.search(query, { limit: 200, perChat: 3, sanitize: redact })
      const chats = r.chats.filter(c => inScope(c)).slice(0, limit)
      if (!chats.length) return `Nothing matches "${query}".`
      return chats.map(c => [line(c), ...c.hits.map(h => `    ${h.role === 'user' ? 'you' : 'agent'}: ${clip(h.text, 300)}`)].join('\n')).join('\n\n')
    },
  },
  {
    name: 'read_chat',
    description: 'Everything needed to carry on with one chat where it stopped: its title and folder, every file it ' +
      'edited with line counts, the request that started it, and its most recent messages. Take the id from ' +
      'recent_chats or search_chats.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'The chat id; the first few characters are enough if they are unique' },
        messages: { type: 'number', description: 'Recent messages to include (default 12, up to 60)' },
      },
    },
    run ({ id, messages: turns = 12 }) {
      const rec = find(id)
      const t = scan.transcript(rec.id)
      if (!t) throw new Error('Could not read that session')
      const said = t.turns.filter(x => (x.role === 'user' || x.role === 'assistant') && x.text)
      const first = said.find(x => x.role === 'user')
      const recent = said.slice(-Math.min(60, turns))
      const files = new Map()
      for (const x of t.turns) for (const e of x.edits || []) {
        const f = files.get(e.path) || { adds: 0, dels: 0, n: 0 }
        f.adds += e.adds; f.dels += e.dels; f.n++
        files.set(e.path, f)
      }
      const out = [
        `# ${t.title || '(untitled)'}`,
        `id ${t.id} · ${t.provider || 'claude'} · folder ${t.cwd || ''}`,
        `${when(t.firstTs || t.lastTs)} → ${when(t.lastTs)} · ${t.messages || said.length} messages`,
        '',
      ]
      if (files.size) {
        out.push(`## Files changed (${files.size})`)
        for (const [p, f] of [...files].sort((a, b) => (b[1].adds + b[1].dels) - (a[1].adds + a[1].dels)).slice(0, 30)) {
          out.push(`- ${p} (+${f.adds} -${f.dels}, ${f.n} edit${f.n > 1 ? 's' : ''})`)
        }
        out.push('')
      }
      // redact before clipping: a clip that cuts a key in half leaves a piece
      // the final redaction pass no longer recognises
      if (first && !recent.includes(first)) out.push('## First request', clip(redact(first.text), 2000), '')
      out.push(`## Latest ${recent.length} messages`)
      for (const x of recent) out.push(`### ${x.role === 'user' ? 'User' : 'Agent'} · ${x.ts ? when(Date.parse(x.ts)) : ''}`, clip(redact(x.text), 2500), '')
      return out.join('\n')
    },
  },
  {
    name: 'find_text',
    description: 'Finds exact text anywhere in the saved transcripts, including tool calls, command output and file ' +
      'contents an agent read - the places search_chats does not look. Good for an error message, a command, ' +
      'a config key or a path.',
    inputSchema: {
      type: 'object',
      required: ['text'],
      properties: {
        text: { type: 'string', description: 'What to look for, ignoring case; read as a regular expression when regex is true' },
        regex: { type: 'boolean' },
        limit: { type: 'number', description: 'Most chats to return (default 15)' },
      },
    },
    run ({ text: pattern, regex = false, limit = 15 }) {
      if (!pattern || String(pattern).length < 2) throw new Error('text needs at least 2 characters')
      const rx = regex ? safeRegex(pattern) : new RegExp(String(pattern).slice(0, 200).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      const out = []
      for (const s of sessions()) {
        if (out.length >= limit) break
        let raw; try { raw = fs.readFileSync(s.file, 'utf8') } catch { continue }
        if (!rx.test(raw)) continue       // cheap prefilter only - never decides the answer
        const snips = []
        for (const full of raw.split('\n')) {
          if (full.length > 200000 || !rx.test(full)) continue
          // Matched against the redacted line, and ONLY the redacted line decides
          // whether anything is reported. Matching the raw text and then hiding it
          // was an oracle: "does any chat contain sk-ant-a…?" asked letter by
          // letter reads a whole key out, one bit per query.
          const l = redact(full)
          const m = rx.exec(l)
          if (!m) continue
          // show the match in its own words, not the JSON around it
          const at = m.index
          snips.push(l.slice(Math.max(0, at - 120), at + 180).replace(/\\n/g, ' ').replace(/\\"/g, '"'))
          if (snips.length >= 3) break
        }
        // a match that exists only inside a secret is not reported at all - even
        // naming the session would confirm the secret to whoever asked
        if (!snips.length) continue
        out.push([line(s), ...snips.map(x => `    … ${x} …`)].join('\n'))
      }
      return out.length ? out.join('\n\n') : `No transcript contains "${pattern}".`
    },
  },
  {
    name: 'chat_edits',
    description: 'What one chat did to files. Without lines it gives each file once with how many lines went in and out; ' +
      'with lines: true it shows the removed and added lines of every edit. Narrow it with path when a chat touched many files.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'The chat id, or a unique start of it' },
        lines: { type: 'boolean', description: 'Show the edited lines, not just the counts' },
        path: { type: 'string', description: 'Only files whose path contains this' },
      },
    },
    run ({ id, lines = false, path: file }) {
      const format = lines ? 'diff' : 'summary'
      const rec = find(id)
      const t = scan.transcript(rec.id)
      if (!t) throw new Error('Could not read that session')
      const want = file ? String(file).toLowerCase() : ''
      const edits = []
      for (const x of t.turns) for (const e of x.edits || []) if (!want || e.path.toLowerCase().includes(want)) edits.push(e)
      if (!edits.length) return file ? `${t.title}: no changes to files matching "${file}".` : `${t.title}: changed no files.`
      if (format !== 'diff') {
        const files = new Map()
        for (const e of edits) {
          const f = files.get(e.path) || { adds: 0, dels: 0, n: 0, tools: new Set() }
          f.adds += e.adds; f.dels += e.dels; f.n++; f.tools.add(e.tool)
          files.set(e.path, f)
        }
        return [`${t.title} · ${files.size} files`, ...[...files].map(([p, f]) =>
          `- ${p}: +${f.adds} -${f.dels} over ${f.n} edit${f.n > 1 ? 's' : ''} (${[...f.tools].join(', ')})`)].join('\n')
      }
      const parts = []
      let size = 0
      for (const e of edits) {
        const full = scan.editAt(rec.id, e.ti, e.ei) || e
        const d = diffOf(full)
        if (size + d.length > 60000) { parts.push(`… ${edits.length - parts.length} more edits not shown - narrow it with path`); break }
        parts.push(d); size += d.length
      }
      return parts.join('\n\n')
    },
  },
  {
    name: 'file_history',
    description: 'Which chats edited a given file, most recent first, and by how many lines. Any part of the path works, ' +
      'from the full path down to the file name. To see the edits themselves, pass a chat it returns to chat_edits.',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string', description: 'The file, or part of its path (3 characters or more)' },
        limit: { type: 'number', description: 'Most chats to return (default 15)' },
      },
    },
    run ({ path: file, limit = 15 }) {
      const want = String(file || '').toLowerCase()
      if (want.length < 3) throw new Error('path needs at least 3 characters')
      const wantRx = new RegExp(want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      const out = []
      for (const s of sessions()) {
        if (out.length >= limit) break
        if (!s.edits) continue
        let raw; try { raw = fs.readFileSync(s.file, 'utf8') } catch { continue }
        if (!wantRx.test(raw)) continue     // cheap check - no lowercasing tens of megabytes
        // only the lines that edit a matching file are parsed - reading the
        // whole chat for each candidate took seconds
        const hit = new Map()
        for (const l of raw.split('\n')) {
          if (!l.includes('"tool_use"') || !wantRx.test(l)) continue
          let e; try { e = JSON.parse(l) } catch { continue }
          for (const b of e.message?.content || []) {
            if (b.type !== 'tool_use' || !EDIT_TOOLS.has(b.name)) continue
            const p = b.input?.file_path || b.input?.notebook_path || ''
            if (!p.toLowerCase().includes(want)) continue
            const n = t => t ? String(t).split('\n').length : 0
            const pairs = b.name === 'MultiEdit' ? (b.input.edits || []) : [b.input]
            const f = hit.get(p) || { adds: 0, dels: 0, n: 0 }
            for (const x of pairs) { f.adds += n(x.new_string ?? x.content ?? x.new_source); f.dels += n(x.old_string) }
            f.n++
            hit.set(p, f)
          }
        }
        if (hit.size) out.push([line(s), ...[...hit].map(([p, f]) => `    ${p}: +${f.adds} -${f.dels} over ${f.n} edit${f.n > 1 ? 's' : ''}`)].join('\n'))
      }
      return out.length ? out.join('\n\n') : `No session changed a file matching "${file}".`
    },
  },
]

// --------------------------------------------------------------- activity log
// Every lookup is written down, so you can see which agent read which of your
// chats and what it searched for - the Agents page in Agent Logbook shows it.
// Arguments only, never the answers; the file is trimmed as it grows.
const LOG = process.env.AGENT_LOGBOOK_LOG || path.join(require('node:os').homedir(), '.agent-logbook', 'activity.jsonl')
const LOG_MAX = 2 * 1024 * 1024
let CLIENT = ''
const IDS = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g
/**
 * The chat that is asking. The server is started by the agent's own process,
 * so its parent is that chat: Claude Code says which session a process runs,
 * and a Codex process holds its rollout file open. Looked up again now and
 * then, since /resume or /clear can move the same process to another chat.
 */
let CALLER = null, CALLER_AT = 0
function caller (ppid = process.ppid) {
  if (Date.now() - CALLER_AT < 30000) return CALLER
  CALLER_AT = Date.now()
  const { execFileSync } = require('node:child_process')
  try {
    const list = JSON.parse(execFileSync('claude', ['agents', '--json'], { encoding: 'utf8', timeout: 4000 }))
    const hit = list.find(a => a.pid === ppid)
    if (hit) return (CALLER = hit.sessionId)
  } catch {}
  try {
    const open = execFileSync('lsof', ['-p', String(ppid), '-Fn'], { encoding: 'utf8', timeout: 4000 })
    const m = /rollout-[^\n]*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl/.exec(open)
    if (m) return (CALLER = m[1])
  } catch {}
  try {
    // last resort: a resumed chat names itself on its command line
    const cmd = execFileSync('ps', ['-o', 'command=', '-p', String(ppid)], { encoding: 'utf8', timeout: 2000 })
    const m = /--resume\s+([0-9a-f-]{36})/.exec(cmd)
    if (m) return (CALLER = m[1])
  } catch {}
  return (CALLER = null)
}

/** Arguments as the log keeps them: secrets hidden, and no value longer than a line. */
function logArgs (args) {
  const out = {}
  for (const [k, v] of Object.entries(args || {}).slice(0, 10)) {
    out[String(k).slice(0, 40)] = typeof v === 'string' ? redact(v).slice(0, 300)
      : typeof v === 'number' || typeof v === 'boolean' ? v : redact(JSON.stringify(v) ?? '').slice(0, 300)
  }
  return out
}

function logCall (tool, args, text, ok, ms) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true, mode: 0o700 })
    // the chats it touched: the one asked for, or the ones it found
    let ids = [...new Set([...(String(text || '').match(IDS) || [])])].slice(0, 12)
    // a single chat asked for is the only one read, whatever ids its text mentions
    if (args.id) { try { ids = [find(args.id).id] } catch { ids = [] } }
    const entry = { ts: Date.now(), client: CLIENT, from: caller(), cwd: ROOT, scope: PROJECT_ONLY ? 'project' : 'all',
      tool, args: logArgs(args), ok, ms, ids: [...new Set(ids)], chars: String(text || '').length }
    fs.appendFileSync(LOG, JSON.stringify(entry) + '\n', { mode: 0o600 })
    const size = fs.statSync(LOG).size
    if (size > LOG_MAX) {
      const keep = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).slice(-2000)
      fs.writeFileSync(LOG, keep.join('\n') + '\n', { mode: 0o600 })
    }
  } catch {}
}

// --------------------------------------------------------------- protocol
// MCP over stdio: one JSON-RPC message per line in, one per line out.
const send = msg => process.stdout.write(JSON.stringify(msg) + '\n')
const reply = (id, result) => send({ jsonrpc: '2.0', id, result })
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } })

function handle (msg) {
  const { id, method, params } = msg
  if (method === 'initialize') {
    CLIENT = params?.clientInfo?.name || ''
    return reply(id, {
      protocolVersion: params?.protocolVersion || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'agent-logbook', version: VERSION },
      instructions: 'Read-only access to the Claude Code and Codex chats on this machine' +
        (PROJECT_ONLY ? `, limited to ${ROOT}` : '') +
        '. recent_chats and search_chats find a chat, read_chat picks up its work, chat_edits shows what it edited, ' +
        'find_text looks for exact text including command output, and file_history lists the chats that edited a file.',
    })
  }
  if (method === 'tools/list') {
    return reply(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) })
  }
  if (method === 'tools/call') {
    const tool = TOOLS.find(t => t.name === params?.name)
    if (!tool) return fail(id, -32602, `Unknown tool ${params?.name}`)
    const args = params.arguments || {}
    const started = Date.now()
    try {
      const text = redact(tool.run(args))
      logCall(tool.name, args, text, true, Date.now() - started)
      return reply(id, { content: [{ type: 'text', text }] })
    } catch (err) {
      logCall(tool.name, args, '', false, Date.now() - started)
      return reply(id, { content: [{ type: 'text', text: redact(String(err.message || err)) }], isError: true })
    }
  }
  if (method === 'ping') return reply(id, {})
  if (id !== undefined) fail(id, -32601, `Method not found: ${method}`)   // notifications need no answer
}

if (require.main === module) {
  const rl = readline.createInterface({ input: process.stdin })
  rl.on('line', l => {
    if (!l.trim()) return
    let msg; try { msg = JSON.parse(l) } catch { return fail(null, -32700, 'Parse error') }
    try { handle(msg) } catch (err) { if (msg.id !== undefined) fail(msg.id, -32603, String(err.message || err)) }
  })
}

module.exports = { TOOLS, handle, caller, redact }

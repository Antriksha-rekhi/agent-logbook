# Security

Agent Logbook reads your Claude Code and Codex transcripts, which can contain
code, secrets and private conversations. This page says exactly what it can
reach, so you or your security team can check it.

## What it accesses

| | What | Why |
|---|---|---|
| Reads | `~/.claude/projects`, `~/.codex/sessions` | The transcripts it lists, searches and shows |
| Reads | `~/.claude/**/memory`, `~/.codex/memories` | Memory notes shown next to chats |
| Reads | Your Claude OAuth token (macOS Keychain, or `~/.claude/.credentials.json`) | To ask Anthropic for your plan usage, the same request Claude Code makes |
| Writes | Its own cache and flags under `~/.claude` | Speed and settings |
| Writes | A `custom-title` line in a Claude transcript, only when you rename a chat | How Claude Code reads the new name |
| Moves | Deleted chats to `~/.claude/trashed-sessions` | Nothing is unlinked |
| Writes | Only if you connect the MCP server: the server and its activity log under `~/.agent-logbook`, a skill in `~/.claude/skills`, and an entry in `~/.claude.json` / `~/.codex/config.toml` (backed up first) | So your agents can read chat history |
| Writes | Exports and saved share cards, only where you choose | When you export or save |

## Network

The extension makes **one** network request: your plan usage, sent to
`api.anthropic.com` with your own token. It sends no transcripts, no
telemetry and no analytics, and loads nothing remote into its panels.

The optional MCP server runs locally. It sends nothing itself, but whatever an
agent reads through it becomes part of that agent's conversation with its own
model provider (Anthropic or OpenAI).

## How changes are controlled

- Every change to `main` goes through a pull request and an automated check
  that rejects network calls, new dependencies, code built from strings,
  shell command strings and committed transcripts.
- The extension has no dependencies and no build step: the published package
  is the source in this repo, file for file.
- Releases are built and published by the maintainer only, after a security
  review of everything changed since the previous release tag.

## Reporting a problem

Please do not open a public issue. Use **Report a vulnerability** on this
repo's Security tab.

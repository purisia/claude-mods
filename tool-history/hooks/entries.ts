import type { Entry, Status } from '../types'

// 세션 하나에 쌓아 두는 최대 건수 (오래된 것부터 버린다)
export const MAX_ENTRIES = 2000
const NOTE_CHARS = 300
const DETAIL_CHARS = 1000

type Input = Record<string, unknown>
type Described = { title: string; detail: string; isWork: boolean }

const str = (v: unknown) => (typeof v === 'string' ? v : '')
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

// 경로는 끝 두 마디만 (D:\_code\repo\a\b.md → a/b.md)
export function shortPath(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean)
  return parts.slice(-2).join('/')
}

// 임시 폴더·세션 작업 폴더의 파일은 사용자 산출물이 아니다
const isScratch = (p: string) => /[\\/](Temp|tmp|scratchpad)[\\/]/i.test(p)

// ── 셸 명령을 업무 언어로 ──────────────────────────────────────────

const tokens = (s: string) => (s.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(t => t.replace(/^["']|["']$/g, ''))

const GIT_WRITE: Record<string, string> = {
  commit: '커밋',
  push: '푸시',
  pull: '받기(pull)',
  merge: '병합',
  rebase: '리베이스',
  reset: '되돌리기(reset)',
  revert: '되돌리기(revert)',
  checkout: '브랜치 전환',
  switch: '브랜치 전환',
  clone: '복제',
  tag: '태그',
  stash: '임시 보관',
}

function commitMessage(cmd: string): string {
  const heredoc = cmd.match(/<<-?\s*'?EOF'?\s*\n\s*([^\n]+)/)
  if (heredoc?.[1]) return heredoc[1].trim()
  const quoted = cmd.match(/-m\s+(?:"([^"\n]*)|'([^'\n]*))/)
  return (quoted?.[1] ?? quoted?.[2] ?? '').trim()
}

function describeGit(cmd: string): Described | undefined {
  const ops = [...cmd.matchAll(/\bgit\s+(?:-C\s+\S+\s+)?([a-z-]+)/g)].map(m => m[1] ?? '')
  if (ops.length === 0) return undefined
  const writes = ops.filter(op => op in GIT_WRITE)
  if (writes.length === 0) return { title: `git 확인 (${[...new Set(ops)].join('·')})`, detail: cmd, isWork: false }
  const parts = [...new Set(writes)].map(op => {
    const label = GIT_WRITE[op] ?? op
    const msg = op === 'commit' ? commitMessage(cmd) : ''
    return msg ? `${label}: ${clip(msg, 60)}` : label
  })
  return { title: `git ${parts.join(' · ')}`, detail: cmd, isWork: true }
}

export function describeShell(cmd: string, description: string): Described {
  const detail = clip(cmd, DETAIL_CHARS)
  // 스킬 스크립트 실행: .claude/skills/<스킬>/scripts/<파일> <하위명령> <인자>
  const skill = cmd.match(/[\\/]skills[\\/]([\w.-]+)[\\/](?:scripts[\\/])?([\w.-]+)\.(?:py|js|mjs|ts|sh|ps1)["']?([^|;&\n]*)/)
  if (skill) {
    const args = tokens(skill[3] ?? '')
      .filter(t => !t.startsWith('-'))
      .slice(0, 3)
      .map(t => clip(t, 30))
    return { title: oneLine(`스킬 ${skill[1]} · ${skill[2]} ${args.join(' ')}`), detail, isWork: true }
  }
  const git = describeGit(cmd)
  if (git) return { ...git, detail }

  const plugin = cmd.match(/\bclaude\s+plugin\s+(install|uninstall|update|enable|disable|marketplace\s+\w+)\s*([^\s|;&]*)/)
  if (plugin) {
    const verb: Record<string, string> = { install: '설치', uninstall: '제거', update: '업데이트', enable: '켜기', disable: '끄기' }
    return { title: oneLine(`플러그인 ${verb[plugin[1] ?? ''] ?? plugin[1]}: ${plugin[2] ?? ''}`), detail, isWork: true }
  }
  const install = cmd.match(/\b(pip3?|npm|pnpm|yarn|winget|choco|brew|uv)\s+(?:install|add|i)\b([^\n|;&]*)/)
  if (install) return { title: oneLine(`설치 (${install[1]}): ${clip(oneLine(install[2] ?? ''), 60)}`), detail, isWork: true }

  const ssh = cmd.match(/\b(ssh|scp)\s+(?:-\S+\s+)*([\w.@-]+)/)
  if (ssh) return { title: `원격 ${ssh[1] === 'scp' ? '복사' : '실행'}: ${ssh[2]}${description ? ` · ${description}` : ''}`, detail, isWork: true }

  const web = cmd.match(/\b(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod)\b[^\n]*?https?:\/\/([^\s"'/]+)/)
  if (web) return { title: `웹 요청: ${web[1]}${description ? ` · ${description}` : ''}`, detail, isWork: true }

  const del = cmd.match(/(?:^|[;&|]\s*)(?:rm|del|rmdir|Remove-Item)\s+((?:-\S+\s+)*)([^\n;&|]+)/)
  if (del) return { title: `삭제: ${clip(oneLine(del[2] ?? ''), 60)}`, detail, isWork: true }

  return { title: `명령: ${clip(oneLine(description || cmd), 80)}`, detail, isWork: false }
}

// ── MCP 서버 이름 ──────────────────────────────────────────────

const SERVER_LABEL: Record<string, string> = {
  claude_ai_Slack: 'Slack',
  claude_ai_Gmail: 'Gmail',
  claude_ai_Google_Calendar: 'Google 캘린더',
  claude_ai_Google_Drive: 'Google 드라이브',
  claude_ai_Claude_Docs: 'Claude Docs',
  'chrome-devtools': '브라우저',
  'claude-in-chrome': '브라우저',
  'db-catalog': 'DB 카탈로그',
  'kb-rag': 'KB-RAG',
  'ai-hosting-mcp': 'AI 호스팅',
}
// 사용자 작업이 아니라 Claude가 일하며 쓰는 보조 서버
const INTERNAL_SERVERS = ['notes', 'plugin-authoring']

export function splitMcp(tool: string): { server: string; name: string } | undefined {
  if (!tool.startsWith('mcp__')) return undefined
  const [, server = '', ...rest] = tool.split('__')
  return { server, name: rest.join('__') }
}

export function toolName(tool: string): string {
  const mcp = splitMcp(tool)
  if (!mcp) return tool
  const label = SERVER_LABEL[mcp.server] ?? mcp.server.replace(/^claude_ai_|^plugin_/, '').replace(/_/g, ' ')
  return `${label} › ${mcp.name}`
}

function describeMcp(tool: string, input: Input): Described {
  const mcp = splitMcp(tool) ?? { server: '', name: tool }
  const label = toolName(tool).split(' › ')[0] ?? mcp.server
  const prefix = (label.split(' ')[0] ?? '').toLowerCase()
  const action = mcp.name.replace(new RegExp(`^${prefix}_`, 'i'), '').replace(/_/g, ' ')
  const first = Object.values(input).find(v => typeof v === 'string' && v.trim() !== '')
  const arg = first ? ` · ${clip(oneLine(str(first)), 50)}` : ''
  return {
    title: `${label} ${action}${arg}`,
    detail: clip(JSON.stringify(input), DETAIL_CHARS),
    isWork: !INTERNAL_SERVERS.includes(mcp.server),
  }
}

// ── 도구 호출 하나를 업무 언어로 ─────────────────────────────────

export function describe(tool: string, input: Input): Described {
  const path = str(input.file_path) || str(input.notebook_path)
  switch (tool) {
    case 'Skill':
      return {
        title: oneLine(`스킬 ${str(input.skill)}${input.args ? ` · ${clip(str(input.args), 60)}` : ''}`),
        detail: oneLine(`${str(input.skill)} ${str(input.args)}`),
        isWork: true,
      }
    case 'Bash':
    case 'PowerShell':
      return describeShell(str(input.command), oneLine(str(input.description)))
    case 'Edit':
    case 'NotebookEdit':
      return { title: `파일 수정: ${shortPath(path)}`, detail: path, isWork: !isScratch(path) }
    case 'Write':
      return { title: `파일 작성: ${shortPath(path)}`, detail: path, isWork: !isScratch(path) }
    case 'Read':
      return { title: `파일 읽기: ${shortPath(path)}`, detail: path, isWork: false }
    case 'Grep':
      return { title: `내용 검색: "${clip(oneLine(str(input.pattern)), 40)}"`, detail: JSON.stringify(input), isWork: false }
    case 'Glob':
      return { title: `파일 찾기: ${str(input.pattern)}`, detail: JSON.stringify(input), isWork: false }
    case 'ToolSearch':
      return { title: `도구 불러오기: ${clip(str(input.query), 50)}`, detail: str(input.query), isWork: false }
    case 'WebSearch':
      return { title: `웹 검색: ${clip(str(input.query), 60)}`, detail: str(input.query), isWork: true }
    case 'WebFetch': {
      const host = str(input.url).match(/^https?:\/\/([^/]+)/)?.[1] ?? str(input.url)
      return { title: `웹 페이지: ${host}`, detail: str(input.url), isWork: true }
    }
    case 'Agent':
      return {
        title: oneLine(`서브에이전트: ${str(input.subagent_type) || 'general-purpose'} · ${str(input.description)}`),
        detail: clip(str(input.prompt), DETAIL_CHARS),
        isWork: true,
      }
    case 'SendMessage':
      return { title: `에이전트에게 메시지: ${str(input.to)}`, detail: clip(str(input.message), DETAIL_CHARS), isWork: true }
    case 'AskUserQuestion': {
      const q = Array.isArray(input.questions) ? str((input.questions[0] as Input | undefined)?.question) : ''
      return { title: `질문: ${clip(oneLine(q), 60)}`, detail: q, isWork: true }
    }
    case 'Artifact':
      return {
        title: `Artifact ${str(input.action) || '게시'}${path ? `: ${shortPath(path)}` : ''}`,
        detail: clip(JSON.stringify(input), DETAIL_CHARS),
        isWork: true,
      }
  }
  if (tool.startsWith('mcp__')) return describeMcp(tool, input)
  return { title: tool, detail: clip(JSON.stringify(input), DETAIL_CHARS), isWork: false }
}

export function noteOf(text: string | undefined): string | undefined {
  if (!text) return undefined
  const t = text.trim()
  return t ? t.slice(0, NOTE_CHARS) : undefined
}

export type ToolUse = {
  tool_use_id: string
  tool: string
  input: Input
  text?: string
  isError?: true
  agentId?: string
}

export function fromToolUse(use: ToolUse, agent?: string): Entry {
  const answered = use.text !== undefined
  const status: Status = !answered ? 'run' : use.isError ? 'error' : 'ok'
  return {
    id: use.tool_use_id,
    kind: 'tool',
    tool: use.tool,
    ...describe(use.tool, use.input ?? {}),
    status,
    agent,
    source: 'transcript',
    note: use.isError ? noteOf(use.text) : undefined,
  }
}

// ── 요청·슬래시 명령 ─────────────────────────────────────────────

// 화면 관리용 내장 명령: 업무가 아니므로 전체 보기에서만
const UTILITY_COMMANDS = [
  'reload-plugins', 'tool-history', 'clear', 'compact', 'model', 'config', 'plugin', 'plugins', 'mcp', 'help',
  'status', 'cost', 'context', 'memory', 'resume', 'rename', 'effort', 'fast', 'theme', 'exit', 'login', 'logout',
]

export function fromCommand(id: string, name: string, args: string, source: Entry['source']): Entry {
  const a = oneLine(args)
  return {
    id,
    kind: 'command',
    tool: `/${name}`,
    title: clip(`/${name}${a ? ` ${a}` : ''}`, 120),
    detail: clip(a, DETAIL_CHARS),
    isWork: !UTILITY_COMMANDS.includes(name),
    status: 'ok',
    source,
  }
}

export function fromPrompt(id: string, text: string, source: Entry['source']): Entry {
  return {
    id,
    kind: 'prompt',
    tool: 'prompt',
    title: clip(oneLine(text), 200),
    detail: clip(text.trim(), DETAIL_CHARS),
    isWork: true,
    status: 'ok',
    source,
  }
}

// 대화 기록의 사용자 메시지: 슬래시 명령 태그와 시스템 덧붙임을 걷어 내고 사람이 쓴 글만 남긴다
export function parseUserText(text: string): { commands: { name: string; args: string }[]; prompt: string } {
  const commands: { name: string; args: string }[] = []
  const re = /<command-name>\/?([^<]+)<\/command-name>(?:[\s\S]*?<command-args>([\s\S]*?)<\/command-args>)?/g
  for (const m of text.matchAll(re)) commands.push({ name: (m[1] ?? '').trim(), args: oneLine(m[2] ?? '') })
  const prompt = text
    .replace(
      /<(system-reminder|local-command-caveat|local-command-stdout|local-command-stderr|command-name|command-message|command-args|task-notification)>[\s\S]*?<\/\1>/g,
      '',
    )
    .trim()
  const isSystem = /^(This session is being continued|Caveat:|\[Request interrupted)/.test(prompt)
  return { commands, prompt: isSystem ? '' : prompt }
}

// 같은 내용의 몇 번째 것인지로 id를 만든다 — 대화 기록에서 다시 읽어도 같은 id가 나와 겹치지 않는다
export function occurrenceId(list: Entry[], base: string): string {
  const n = list.filter(x => x.id.startsWith(`${base}#`)).length
  return `${base}#${n}`
}

export function hash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

export const promptBase = (text: string) => `p:${hash(oneLine(text))}`
export const commandBase = (name: string, args: string) => `cmd:${name}:${oneLine(args)}`

// 대화 기록에서 읽은 목록(older)과 mod가 잰 목록(current)을 합친다.
// mod가 처음 본 호출보다 앞선 기록만 앞에 붙인다 (그 뒤는 mod가 직접 봤다).
// 둘 다 있으면 시각·소요시간이 있는 current를 남기되 아직 '실행 중'이면 기록의 결과로 채운다.
export function merge(current: Entry[], older: Entry[]): Entry[] {
  const known = new Set(current.map(e => e.id))
  const firstKnown = older.findIndex(e => known.has(e.id))
  const head = (firstKnown === -1 ? older : older.slice(0, firstKnown)).filter(e => !known.has(e.id))
  const fromTranscript = new Map(older.map(e => [e.id, e]))
  const body = current.map(e => {
    const t = fromTranscript.get(e.id)
    return e.status === 'run' && t && t.status !== 'run' ? { ...e, status: t.status, note: e.note ?? t.note } : e
  })
  return [...head, ...body].slice(-MAX_ENTRIES)
}

// ── 요청 단위 묶음 ──────────────────────────────────────────────

export type Group = { id: string; head?: Entry; items: Entry[] }

// 요청(또는 업무용 슬래시 명령)이 나올 때마다 새 묶음을 연다
export function groupsOf(list: Entry[]): Group[] {
  const groups: Group[] = []
  let cur: Group | undefined
  for (const e of list) {
    const opens = e.kind === 'prompt' || (e.kind === 'command' && e.isWork)
    if (opens) {
      cur = { id: e.id, head: e, items: [] }
      groups.push(cur)
    } else {
      if (!cur) {
        cur = { id: 'start', items: [] }
        groups.push(cur)
      }
      cur.items.push(e)
    }
  }
  return groups
}

export const isFailed = (e: Entry) => e.status === 'error' || e.status === 'deny'

// 연달아 같은 줄(같은 제목·같은 결과)은 ×N으로 접는다
export function compress(items: Entry[]): { entry: Entry; count: number; ms?: number }[] {
  const out: { entry: Entry; count: number; ms?: number }[] = []
  for (const e of items) {
    const last = out[out.length - 1]
    if (last && last.entry.title === e.title && last.entry.status === e.status) {
      last.count++
      last.ms = last.ms === undefined && e.ms === undefined ? undefined : (last.ms ?? 0) + (e.ms ?? 0)
    } else {
      out.push({ entry: e, count: 1, ms: e.ms })
    }
  }
  return out
}

export function kstTime(ms: number): string {
  return new Date(ms + 9 * 3_600_000).toISOString().slice(11, 16)
}

export function duration(ms: number | undefined): string {
  if (ms === undefined) return ''
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
}

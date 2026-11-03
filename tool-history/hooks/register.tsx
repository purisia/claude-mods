import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Entry, Status } from '../types'
import {
  commandBase,
  compress,
  describe,
  duration,
  fromCommand,
  fromPrompt,
  fromToolUse,
  groupsOf,
  isFailed,
  kstTime,
  MAX_ENTRIES,
  merge,
  noteOf,
  occurrenceId,
  parseUserText,
  promptBase,
} from './entries'
import type { Group } from './entries'

const PANE = 'tool-history'
const TITLE = '작업 이력'
// 처음 펼쳐 두는 최근 요청 수
const OPEN_GROUPS = 3
// 한 번에 그리는 최대 요청 수
const MAX_GROUPS = 40

// Entry 필드를 바꾸면 태그도 바꾼다: 이전 버전이 저장한 값은 재로드 뒤에도 남는다.
const entries = atom({ plugin: 'tool-history', key: 'entries' } as const, [], { shape: 'entries-2' })
const showAll = atom({ plugin: 'tool-history', key: 'showAll' } as const, false)
const toggled = atom({ plugin: 'tool-history', key: 'toggled' } as const, [])
const expanded = atom({ plugin: 'tool-history', key: 'expanded' } as const, null)
const isLoading = atom({ plugin: 'tool-history', key: 'isLoading' } as const, false)

const GLYPH: Record<Status, string> = { run: '…', ok: '✓', error: '✗', deny: '⊘' }
const COLOR: Record<Status, string> = { run: 'suggestion', ok: 'success', error: 'error', deny: 'warning' }
const STATUS_TEXT: Record<Status, string> = { run: '실행 중', ok: '성공', error: '오류', deny: '거부됨' }

const push = ($: EngineInterface, entry: Entry) =>
  update($, entries, list => [...list, entry].slice(-MAX_ENTRIES)).catch(() => undefined)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'tool-history',
      description: '이 세션에서 한 일(요청별 스킬·파일 수정·외부 서비스·실패)을 우측 패널로 열기',
    })
    // 재로드·재개된 세션이면 대화 기록에 이미 있는 것을 채운다
    void backfill($)
    return next(e)
  })

  on('command.run', { command: 'tool-history' }, async $ => {
    // 패널 배경은 칠하지 않고 터미널 배경을 그대로 쓴다
    await $.ui.open({ id: PANE, title: TITLE, backgroundColor: 'transparent' })
    void backfill($)
    return { text: '작업 이력 패널을 열었습니다.' }
  })

  // 사람이 친 슬래시 명령 (/doctor, 스킬 명령, /reload-plugins 등)
  on('command.run', async ($, e, next) => {
    const ran = await next(e)
    if (e.command !== 'tool-history') {
      const startedAt = await $.clock.now()
      await update($, entries, list => {
        const id = occurrenceId(list, commandBase(e.command, e.args))
        return [...list, { ...fromCommand(id, e.command, e.args, 'live'), startedAt }].slice(-MAX_ENTRIES)
      }).catch(() => undefined)
    }
    return ran
  }).catch(($, e, next) => next(e))

  // 사람이 보낸 요청: 이후 도구 호출을 이 요청 아래로 묶는다
  on('prompt.submit', async ($, e, next) => {
    const ran = await next(e)
    if (!e.command && !e.isMeta && e.text.trim() !== '') {
      const startedAt = await $.clock.now()
      await update($, entries, list => {
        const id = occurrenceId(list, promptBase(e.text))
        return [...list, { ...fromPrompt(id, e.text, 'live'), startedAt }].slice(-MAX_ENTRIES)
      }).catch(() => undefined)
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const startedAt = await $.clock.now()
    const entry: Entry = {
      id: e.tool_use_id,
      kind: 'tool',
      tool: e.tool,
      ...describe(e.tool, e as unknown as Record<string, unknown>),
      status: 'run',
      agent: e.agentId,
      source: 'live',
      startedAt,
    }
    await push($, entry)

    let status: Status = 'error'
    let note: string | undefined
    try {
      const ran = await next(e)
      if (ran.deny !== undefined) {
        status = 'deny'
        note = noteOf(ran.deny)
      } else if (ran.isError) {
        note = noteOf(ran.text)
      } else {
        status = 'ok'
      }
      return ran
    } catch (err) {
      note = noteOf(String(err))
      throw err
    } finally {
      const ms = (await $.clock.now()) - startedAt
      await update($, entries, list => list.map(x => (x.id === entry.id ? { ...x, status, note, ms } : x))).catch(
        () => undefined,
      )
    }
  }).catch(($, e, next) => next(e)) // 이력 기록이 실패해도 도구 호출은 그대로 진행한다

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, entries)
    const all = await read($, showAll)
    const flipped = await read($, toggled)
    const open = await read($, expanded)
    const loading = await read($, isLoading)
    const width = Math.max(24, (e.props.bodyColumns ?? 50) - 2)

    const visible = (x: Entry) => all || x.isWork || isFailed(x)
    const tools = list.filter(x => x.kind !== 'prompt')
    const failures = tools.filter(x => isFailed(x) && (all || x.isWork))
    const groups = groupsOf(list).reverse()
    const requests = groups.filter(g => g.head?.kind === 'prompt').length
    const works = tools.filter(x => x.isWork && x.kind === 'tool').length

    // 한 줄: ✓ 제목 ×N  소요시간 — 누르면 원문·사유가 펼쳐진다
    const row = (keyPrefix: string, x: Entry, count = 1, ms = x.ms, indent = 2) => {
      const key = `${keyPrefix}-${x.id}`
      const isOpen = open === key
      const tail = `${count > 1 ? `  ×${count}` : ''}${ms !== undefined ? `  ${duration(ms)}` : ''}`
      const room = width - indent - 2 - (x.agent ? 2 : 0) - cells(tail)
      return (
        <Box key={`box-${key}`} flexDirection="column" paddingLeft={indent}>
          <Button key={key} plain onPress={() => void update($, expanded, cur => (cur === key ? null : key))}>
            <Text color={COLOR[x.status]}>{GLYPH[x.status]} </Text>
            {x.agent ? <Text dimColor>↳ </Text> : ''}
            <Text dimColor={x.isWork ? undefined : true}>{fit(x.title, room)}</Text>
            <Text dimColor>{tail}</Text>
          </Button>
          {isOpen && (
            <Box flexDirection="column" paddingLeft={2} marginBottom={1}>
              {x.detail !== '' && x.detail !== x.title && <Text wrap="wrap">{x.detail}</Text>}
              <Text dimColor wrap="wrap">
                {[
                  x.startedAt === undefined ? '패널 켜기 전' : kstTime(x.startedAt),
                  x.tool,
                  x.agent ? `서브에이전트 ${x.agent.slice(0, 8)}` : '',
                  STATUS_TEXT[x.status],
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
              {x.note && (
                <Text color={COLOR[x.status]} wrap="wrap">
                  {x.note}
                </Text>
              )}
            </Box>
          )}
        </Box>
      )
    }

    const group = (g: Group, index: number) => {
      const isOpen = (index < OPEN_GROUPS) !== flipped.includes(g.id)
      const shown = g.items.filter(visible)
      const hidden = g.items.length - shown.length
      const failed = g.items.filter(x => isFailed(x) && (all || x.isWork)).length
      const work = g.items.filter(x => x.isWork).length
      const at = g.head?.startedAt ?? g.items.find(x => x.startedAt !== undefined)?.startedAt
      const time = at === undefined ? '켜기 전' : kstTime(at)
      const title = g.head ? (g.head.kind === 'prompt' ? `"${g.head.title}"` : g.head.title) : '세션 시작'
      const counts = `${work ? `  작업 ${work}` : ''}${hidden && !all ? `  내부 ${hidden}` : ''}`
      const room = width - 2 - cells(time) - 1 - cells(counts) - (failed ? cells(`  ✗ ${failed}`) : 0)
      return (
        <Box key={`group-${g.id}`} flexDirection="column" marginTop={1}>
          <Button
            key={`head-${g.id}`}
            plain
            onPress={() =>
              void update($, toggled, cur => (cur.includes(g.id) ? cur.filter(id => id !== g.id) : [...cur, g.id]))
            }
          >
            <Text dimColor>{isOpen ? '▾ ' : '▸ '}</Text>
            <Text dimColor>{time} </Text>
            <Text bold>{fit(title, room)}</Text>
            {failed ? <Text color="error">{`  ✗ ${failed}`}</Text> : ''}
            <Text dimColor>{counts}</Text>
          </Button>
          {isOpen && shown.length === 0 && (
            <Box paddingLeft={2}>
              <Text dimColor>{g.items.length ? '내부 동작만 있음 (전체 보기에서 확인)' : '도구를 쓰지 않음'}</Text>
            </Box>
          )}
          {isOpen && compress(shown).map(c => row('row', c.entry, c.count, c.ms))}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" width="100%" paddingX={1}>
        <Box flexDirection="row" justifyContent="space-between" marginTop={1}>
          <Text>
            <Text bold>{`요청 ${requests}`}</Text>
            <Text>{`  작업 ${works}`}</Text>
            <Text color={failures.length ? 'error' : undefined} dimColor={failures.length ? undefined : true}>
              {`  ✗ 실패 ${failures.length}`}
            </Text>
          </Text>
          <Box flexDirection="row" columnGap={2}>
            <Button
              key="show-all"
              plain
              hotkey="a"
              dimColor={all ? undefined : true}
              label={all ? '업무만 보기' : '전체 보기'}
              onPress={() => void update($, showAll, v => !v)}
            />
            <Button
              key="reload"
              plain
              dimColor
              hotkey="r"
              label={loading ? '읽는 중…' : '다시 읽기'}
              onPress={() => void backfill($)}
            />
          </Box>
        </Box>
        <Text dimColor wrap="wrap">
          {all
            ? '파일 읽기·검색 같은 Claude 내부 동작까지 모두 보는 중'
            : '스킬·파일 수정·외부 서비스·git 같은 작업만 보는 중'}
        </Text>

        {failures.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text color="error" bold>{`실패 ${failures.length}건 — 눌러서 사유 보기`}</Text>
            {failures
              .slice(-10)
              .reverse()
              .map(x => row('fail', x, 1, x.ms, 0))}
          </Box>
        )}

        <Text dimColor>{'─'.repeat(width)}</Text>
        {list.length === 0 && <Text dimColor>{loading ? '대화 기록을 읽는 중…' : '아직 기록이 없습니다.'}</Text>}
        {groups.slice(0, MAX_GROUPS).map(group)}
        {groups.length > MAX_GROUPS && <Text dimColor>{`이전 요청 ${groups.length - MAX_GROUPS}개는 생략`}</Text>}
      </Box>
    )
  })
}

// 대화 기록(메인 + 서브에이전트)에서 요청·슬래시 명령·도구 호출을 읽어 합친다
async function backfill($: EngineInterface) {
  if (await read($, isLoading)) return
  await update($, isLoading, () => true)
  try {
    const messages = await $.session.messages()
    const older: Entry[] = []
    for (const m of messages) {
      if (m.role === 'user') {
        const { commands, prompt } = parseUserText(m.text)
        for (const cmd of commands) {
          if (cmd.name === 'tool-history') continue
          older.push(fromCommand(occurrenceId(older, commandBase(cmd.name, cmd.args)), cmd.name, cmd.args, 'transcript'))
        }
        if (prompt) older.push(fromPrompt(occurrenceId(older, promptBase(prompt)), prompt, 'transcript'))
      }
      for (const use of m.toolUses) {
        older.push(fromToolUse(use))
        if (use.tool === 'Agent' && use.agentId) {
          const sub = await $.session.messages({ agentId: use.agentId })
          if (!Array.isArray(sub)) continue
          for (const sm of sub) for (const su of sm.toolUses) older.push(fromToolUse(su, use.agentId))
        }
      }
    }
    await update($, entries, list => merge(list, older))
  } catch (err) {
    $.ui.log(`tool-history: 대화 기록을 읽지 못했습니다 (${String(err)})`, { to: 'debug' })
  } finally {
    await update($, isLoading, () => false)
  }
}

// 터미널 칸 수 (한글·전각은 2칸)
function cells(s: string): number {
  let n = 0
  for (const ch of s) n += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1
  return n
}

function fit(s: string, room: number): string {
  if (room < 4) return ''
  if (cells(s) <= room) return s
  let out = ''
  let n = 0
  for (const ch of s) {
    const w = cells(ch)
    if (n + w > room - 1) break
    out += ch
    n += w
  }
  return `${out}…`
}

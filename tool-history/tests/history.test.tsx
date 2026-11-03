import { expect, test } from 'claude-code/testing'

import { compress, describe, groupsOf, merge, parseUserText } from '../hooks/entries'
import type { Entry } from '../types'

const PANE = {
  plugin: 'tool-history',
  component: 'Pane',
  requestId: 'tool-history',
  props: { title: '작업 이력', isFocused: false, bodyColumns: 80, placement: 'dock' },
} as never

// 테스트 엔진이 답할 것만 채운다
const engine = (on: any) => {
  let now = 1_000
  on('clock.now', () => ({ value: (now += 250) }))
  on('command.register', () => ({ value: { command: 'tool-history' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
}

test('셸 명령을 업무 언어로 바꾼다', async () => {
  const jira = describe('Bash', {
    command: 'py "D:\\_code\\repo\\.claude\\skills\\cafe24-jira-wiki\\scripts\\jira_api.py" comment DIGITALINFRA-7687 "내용"',
  })
  expect(jira.title).toBe('스킬 cafe24-jira-wiki · jira_api comment DIGITALINFRA-7687 내용')
  expect(jira.isWork).toBe(true)

  const git = describe('Bash', { command: 'git add -A && git commit -m "fix: 로그" && git push origin main' })
  expect(git.title).toBe('git 커밋: fix: 로그 · 푸시')
  expect(describe('Bash', { command: 'git status --short' }).isWork).toBe(false)

  expect(describe('Bash', { command: 'pip install requests' }).title).toBe('설치 (pip): requests')
  expect(describe('Bash', { command: 'claude plugin install tool-history@cylim-mods' }).title).toBe(
    '플러그인 설치: tool-history@cylim-mods',
  )
  const plain = describe('Bash', { command: 'npx tsc -p .', description: '타입 검사' })
  expect(plain.title).toBe('명령: 타입 검사')
  expect(plain.isWork).toBe(false)
})

test('도구별 업무/내부 구분', async () => {
  expect(describe('Edit', { file_path: 'D:\\_code\\repo\\CLAUDE.md' }).title).toBe('파일 수정: repo/CLAUDE.md')
  expect(describe('Edit', { file_path: 'C:\\Users\\a\\AppData\\Local\\Temp\\x.md' }).isWork).toBe(false)
  expect(describe('Read', { file_path: '/a/b.md' }).isWork).toBe(false)
  expect(describe('mcp__notes__notes_check', { tab: 'x' }).isWork).toBe(false)
  const slack = describe('mcp__claude_ai_Slack__slack_send_message', { channel_id: 'C1', message: 'hi' })
  expect(slack.title).toBe('Slack send message · C1')
  expect(slack.isWork).toBe(true)
})

test('사용자 메시지에서 명령과 요청 글을 나눈다', async () => {
  const text =
    '<local-command-caveat>Caveat</local-command-caveat>\n<command-name>/reload-plugins</command-name>\n<command-args></command-args>\n<local-command-stdout>ok</local-command-stdout>\n도구 이력 고쳐줘'
  const out = parseUserText(text)
  expect(out.commands).toEqual([{ name: 'reload-plugins', args: '' }])
  expect(out.prompt).toBe('도구 이력 고쳐줘')
})

const base = { detail: '', isWork: true, source: 'live', status: 'ok' } as const
const tool = (id: string, title: string, extra: Partial<Entry> = {}): Entry => ({
  ...base,
  id,
  kind: 'tool',
  tool: 'Bash',
  title,
  ...extra,
})

test('요청마다 묶고, 같은 줄은 ×N으로 접는다', async () => {
  const list: Entry[] = [
    tool('t0', '명령: 준비', { isWork: false }),
    { ...base, id: 'p1', kind: 'prompt', tool: 'prompt', title: '첫 요청' },
    tool('t1', '파일 수정: a.md'),
    tool('t2', '파일 수정: a.md'),
    { ...base, id: 'c1', kind: 'command', tool: '/reload-plugins', title: '/reload-plugins', isWork: false },
    { ...base, id: 'p2', kind: 'prompt', tool: 'prompt', title: '둘째 요청' },
  ]
  const groups = groupsOf(list)
  expect(groups.map(g => g.id)).toEqual(['start', 'p1', 'p2'])
  expect(groups[1]?.items.map(x => x.id)).toEqual(['t1', 't2', 'c1'])
  expect(compress(groups[1]?.items ?? []).map(c => c.count)).toEqual([2, 1])
})

test('대화 기록은 mod가 처음 본 것보다 앞선 것만 붙인다', async () => {
  const current: Entry[] = [tool('b', 'B', { status: 'run', startedAt: 1 })]
  const older: Entry[] = [
    tool('a', 'A', { source: 'transcript' }),
    tool('b', 'B', { source: 'transcript', status: 'error', note: 'boom' }),
    { ...base, id: 'p9', kind: 'prompt', tool: 'prompt', title: '뒤 요청', source: 'transcript' },
  ]
  const out = merge(current, older)
  expect(out.map(x => x.id)).toEqual(['a', 'b'])
  expect(out[1]?.status).toBe('error')
  expect(out[1]?.startedAt).toBe(1)
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: 요청 아래 작업이 보이고 내부 동작은 전체 보기에서만`, async ($, on) => {
    engine(on)
    on('session.messages', () => ({ value: [] }))
    on('prompt.submit', (_: unknown, e: { text: string }) => ({ text: e.text }))
    on('tool.call', (_: unknown, e: { tool: string }) =>
      e.tool === 'Edit' ? { result: {}, isError: true, text: 'file not found' } : { result: {} },
    )
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    await $.prompt.submit({ text: 'CLAUDE.md 고쳐줘' } as never)
    await $.tool.call({ tool: 'Read', file_path: '/repo/CLAUDE.md' })
    await $.tool.call({ tool: 'Edit', file_path: '/repo/CLAUDE.md', old_string: 'a', new_string: 'b' })

    const ui = await $.ui.mount({ ...(PANE as object), surface } as never)
    expect(await ui.find({ type: 'Text', text: /CLAUDE\.md 고쳐줘/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /실패 1건/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /파일 읽기/ })).toBeUndefined()

    // 실패 줄을 누르면 사유가 보인다
    const fail = (await ui.findAll({ type: 'Button' })).find(b => b.key?.startsWith('fail-'))
    await ui.press({ key: fail?.key ?? '' })
    expect(await ui.find({ type: 'Text', text: /file not found/ })).toBeDefined()

    await ui.press({ key: 'show-all' })
    expect(await ui.find({ type: 'Text', text: /파일 읽기/ })).toBeDefined()
    await ui.unmount()
  })
}

test('다시 읽기로 패널 켜기 전 요청·명령·스킬을 채운다', async ($, on) => {
  engine(on)
  on('session.messages', () => ({
    value: [
      { role: 'user', text: '<command-name>/doctor</command-name><command-args>prompt-audit</command-args>', toolUses: [] },
      {
        role: 'assistant',
        text: '',
        toolUses: [{ tool_use_id: 't1', tool: 'Skill', input: { skill: 'wiki-lint' }, text: 'ok' }],
      },
      { role: 'user', text: '위키 점검 결과 정리해줘', toolUses: [] },
    ],
  }))
  const ui = await $.ui.mount({ ...(PANE as object), surface: 'desktop' } as never)
  await ui.press({ key: 'reload' })
  expect(await ui.find({ type: 'Text', text: /\/doctor prompt-audit/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /스킬 wiki-lint/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /위키 점검 결과 정리해줘/ })).toBeDefined()
  await ui.unmount()
})

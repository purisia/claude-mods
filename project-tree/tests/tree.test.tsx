import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'project-tree',
  component: 'Pane',
  requestId: 'project-tree',
  props: {
    title: '📁 프로젝트',
    isFocused: false,
    bodyColumns: 50,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const BAND = {
  plugin: 'project-tree',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 100 },
} as const

const ROOT = 'C:\\work\\my-project'

const FILES: Record<string, { name: string; kind: 'file' | 'dir' }[]> = {
  '': [
    { name: 'README.md', kind: 'file' },
    { name: 'data', kind: 'dir' },
    { name: '.git', kind: 'dir' },
    { name: 'zz.json', kind: 'file' },
  ],
  data: [{ name: 'dates.json', kind: 'file' }],
}

const OK = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }

function engine(on: any) {
  const panes = { open: [] as string[], closed: [] as string[] }
  on('command.register', () => ({ value: { command: 'tree' } }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: ROOT }))
  on('ui.open', (_: unknown, e: any) => (panes.open.push(e.id), { value: { isPlaced: true } }))
  on('ui.close', (_: unknown, e: any) => (panes.closed.push(e.id), { value: undefined }))
  on('fs.list', (_: unknown, e: any) => ({
    value: (FILES[e.path.slice(ROOT.length + 1)] ?? []).map((one: any) => ({
      ...one,
      size: 0,
      mtimeMs: 0,
      isLink: false,
    })),
  }))
  // 아래 플러그인(택시미터) 대신 그리는 띠
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)

    return <Text>METER</Text>
  })

  return panes
}

async function start($: any, on: any) {
  const panes = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  return panes
}

// 목록 영역(Client 'tree')이 그린 글자를 줄마다 모은다
function linesOf(node: any): string[] {
  const text = (one: any): string =>
    typeof one === 'string' ? one : Array.isArray(one) ? one.map(text).join('') : one?.children ? text(one.children) : ''
  const children = Array.isArray(node?.children) ? node.children : []

  return children.map(text)
}

// 트리 줄: 맨 앞 거터(커서 ›) 1칸과 오른쪽 끝 빈 표시 칸은 떼고 본다
async function lines(ui: any): Promise<string[]> {
  return linesOf(await ui.drawn({ in: 'tree' })).map(line => line.slice(1).trimEnd())
}

// 목록의 y줄 x칸을 마우스로 누르고 뗀다
async function click(ui: any, y: number, x = 2) {
  await ui.pointer({ type: 'down', x, y, button: 'left', in: 'tree' })
  await ui.pointer({ type: 'up', x, y, button: 'left', in: 'tree' })
}

test('세션이 시작되면 오른쪽 탭이 열리고, 목록에 폴더가 먼저 찍히며 .git은 빠진다', async ($, on) => {
  const panes = await start($, on)
  expect(panes.open).toEqual(['project-tree'])

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Button', key: 'folder:' }))?.text).toMatch(/my-project/)
  // 폴더 이름 뒤에 폴더 열기 📂
  expect(await lines(ui)).toEqual(['▸ data/ 📂', '  README.md', '  zz.json'])
  await ui.unmount()

  // 펼쳐져 있을 때 프롬프트 위 띠에는 손대지 않는다
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
  expect(await band.find({ type: 'Button', key: 'unfold' })).toBeUndefined()
  expect(await band.find({ type: 'Text', text: /^METER$/ })).toBeDefined()
  await band.unmount()
})

test('접으면 탭이 닫히고 띠의 펼치기 버튼으로 다시 열린다', async ($, on) => {
  const panes = await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'fold' })
  await ui.unmount()
  expect(panes.closed).toEqual(['project-tree'])

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
  expect(await band.find({ type: 'Text', text: /^METER$/ })).toBeDefined()
  await band.press({ key: 'unfold' })
  expect(panes.open).toEqual(['project-tree', 'project-tree'])
  expect(await band.find({ type: 'Button', key: 'unfold' })).toBeUndefined()
  await band.unmount()
})

test('/tree 로도 접고 펼친다', async ($, on) => {
  const panes = await start($, on)
  await $.command.run({ command: 'tree', args: '' } as any)
  expect(panes.closed).toEqual(['project-tree'])
  await $.command.run({ command: 'tree', args: '' } as any)
  expect(panes.open).toEqual(['project-tree', 'project-tree'])
})

test('폴더 줄을 누르면 펼쳐지고 다시 누르면 접힌다', async ($, on) => {
  await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await click(ui, 0)
  expect(await lines(ui)).toContain('    dates.json')
  await click(ui, 0)
  expect((await lines(ui)).join('\n')).not.toMatch(/dates\.json/)
  await ui.unmount()
})

test('끌다가 다른 줄에서 떼면 아무것도 누르지 않는다', async ($, on) => {
  await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.pointer({ type: 'down', x: 2, y: 0, button: 'left', in: 'tree' })
  await ui.pointer({ type: 'move', x: 4, y: 1, button: 'left', in: 'tree' })
  await ui.pointer({ type: 'up', x: 4, y: 1, button: 'left', in: 'tree' })
  expect((await lines(ui))[0]).toMatch(/^▸ data\//)
  await ui.unmount()
})

test('파일을 누르면 목록 안에 [열기]·[경로 복사]가 뜨고, 열기는 연결된 프로그램으로 연다 (확장자 제한 없음)', async ($, on) => {
  const runs: string[][] = []
  on('process.run', (_: unknown, e: any) => (runs.push(e.argv), { value: { ...OK, exitCode: 1 } }))
  await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  // 누르면 그 줄 아래에 [열기]·[경로 복사] 줄이 생긴다
  await click(ui, 1)
  expect((await lines(ui))[2]).toBe('  └ [ 열기 ]  [ 경로 복사 ]')
  // 같은 파일을 다시 누르면 닫힌다
  await click(ui, 1)
  expect((await lines(ui)).join('\n')).not.toMatch(/경로 복사/)
  expect(runs).toEqual([])

  // 거터 1 + 들여쓰기 2 + '└ ' 2 = 5칸부터 '[ 열기 ]', 15칸부터 '[ 경로 복사 ]'
  await click(ui, 1)
  await click(ui, 2, 6)
  expect(runs).toEqual([['explorer.exe', `${ROOT}\\README.md`]])
  expect((await lines(ui)).join('\n')).not.toMatch(/경로 복사/)

  // .json처럼 어떤 파일이든 연다
  await click(ui, 2)
  expect((await lines(ui))[3]).toMatch(/경로 복사/)
  await click(ui, 3, 6)
  expect(runs[1]).toEqual(['explorer.exe', `${ROOT}\\zz.json`])
  await ui.unmount()
})

test('[경로 복사]는 절대 경로를 클립보드에 넣고 줄을 닫는다', async ($, on) => {
  const copies: string[] = []
  const toasts: string[] = []
  on('ui.copy', (_: unknown, e: any) => (copies.push(e.text), { value: { isCopied: true } }))
  on('ui.toast', (_: unknown, e: any) => (toasts.push(e.text), { value: undefined }))
  await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await click(ui, 1)
  await click(ui, 2, 16)
  expect(copies).toEqual([`${ROOT}\\README.md`])
  expect(toasts.at(-1)).toBe(`경로를 복사했습니다: ${ROOT}\\README.md`)
  expect((await lines(ui)).join('\n')).not.toMatch(/경로 복사/)

  // 폴더 안 파일도 '\'로 이어 붙인 절대 경로
  await click(ui, 0)
  await click(ui, 1)
  await click(ui, 2, 18)
  expect(copies[1]).toBe(`${ROOT}\\data\\dates.json`)
  await ui.unmount()
})

test('마우스로만 쓴다: 키를 눌러도 아무것도 하지 않는다', async ($, on) => {
  const runs: string[][] = []
  on('process.run', (_: unknown, e: any) => (runs.push(e.argv), { value: { ...OK, exitCode: 1 } }))
  await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const before = await lines(ui)
  await ui.key({ key: 'down', in: 'tree' }).catch(() => undefined)
  await ui.key({ key: 'return', in: 'tree' }).catch(() => undefined)
  expect(await lines(ui)).toEqual(before)
  expect(runs).toEqual([])
  await ui.unmount()
})

test('폴더 이름 옆 📂와 머리줄의 프로젝트 이름으로 탐색기를 연다', async ($, on) => {
  const runs: string[][] = []
  const encoded: string[] = []
  on('process.run', (_: unknown, e: any) => {
    runs.push([e.argv[0], e.init?.env?.REVEAL_FOLDER, e.init?.env?.REVEAL_NAME])
    encoded.push(e.argv[e.argv.length - 1])

    return { value: OK }
  })
  await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'folder:' })
  // 거터 1 + '▸ data/' 7칸 = 8칸부터 ' 📂' 3칸
  await click(ui, 0, 9)
  expect(runs).toEqual([
    ['powershell.exe', ROOT, ''],
    ['powershell.exe', `${ROOT}\\data`, ''],
  ])
  // -EncodedCommand는 UTF-16LE base64: 앞부분을 풀어 스크립트가 맞게 실렸는지 본다
  const head = encoded[0] ?? ''
  expect(head.length % 4).toBe(0)
  expect(head.startsWith('CgBBAGQAZAAtAFQAeQBwAGUA')).toBe(true)
  await ui.unmount()
})

test('Enter로 검색하면 프로젝트 전체에서 이름이 맞는 파일을 경로째 보여 준다', async ($, on) => {
  await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.input({ key: 'search-0', text: 'DATES', kind: 'submit' })
  expect(await lines(ui)).toEqual(['  data/dates.json'])

  await ui.input({ key: 'search-0', text: 'nothing-here', kind: 'submit' })
  expect(await ui.find({ type: 'Text', text: /맞는 파일이 없습니다/ })).toBeDefined()

  await ui.press({ key: 'clear' })
  expect((await lines(ui))[0]).toMatch(/^▸ data\//)
  await ui.unmount()
})

test('Claude가 새 파일을 만들면 그 폴더까지 펼쳐 +로 표시하고, 최근 작업에서 파일 열기·폴더 열기를 고른다', async ($, on) => {
  const runs: string[][] = []
  const made = `${ROOT}\\data\\new.csv`
  const data = FILES.data ?? []
  let isWritten = false
  on('fs.exists', (_: unknown, e: any) => ({ value: e.path === made && isWritten }))
  on('tool.call', () => {
    isWritten = true
    data.push({ name: 'new.csv', kind: 'file' })

    return { result: {} }
  })
  on('process.run', (_: unknown, e: any) => {
    runs.push(e.argv[0] === 'powershell.exe' ? [e.argv[0], e.init?.env?.REVEAL_FOLDER, e.init?.env?.REVEAL_NAME] : e.argv)

    return { value: OK }
  })
  await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await $.tool.call({ tool: 'Write', file_path: made, content: 'a,b' } as any)
  expect(await lines(ui)).toContain('    new.csv +')
  expect((await lines(ui))[0]).toMatch(/^▾ data\//)
  // 아래 목록도 Client 영역('made'): 0줄 제목, 1줄 파일, 펼치면 2줄에 파일 열기·폴더 열기
  const made1 = async () => linesOf(await ui.drawn({ in: 'made' }))
  const press = async (y: number, x = 2) => {
    await ui.pointer({ type: 'down', x, y, button: 'left', in: 'made' })
    await ui.pointer({ type: 'up', x, y, button: 'left', in: 'made' })
  }
  expect(await made1()).toEqual(['─ 최근 작업 ─ 비우기', '+ new.csv  data'])

  // 누르면 고르는 줄이 펼쳐지고, 다시 누르면 닫힌다
  await press(1)
  expect((await made1())[2]).toBe('  └ [ 파일 열기 ]  [ 폴더 열기 ]')
  await press(1)
  expect(await made1()).toHaveLength(2)

  // '  └ ' 4칸 + '[ 파일 열기 ]' 13칸 + 2칸 = 19칸부터 폴더 열기
  await press(1)
  await press(2, 20)
  expect(runs).toEqual([['powershell.exe', `${ROOT}\\data`, 'new.csv']])
  expect(await made1()).toHaveLength(2)

  await press(1)
  await press(2, 5)
  expect(runs[1]).toEqual(['explorer.exe', made])

  // 제목줄 오른쪽 끝 '비우기'
  await ui.resize({ columns: 40, rows: 2, in: 'made' })
  await press(0, 38)
  expect(await ui.find({ type: 'Client', key: 'made' })).toBeUndefined()
  data.pop()
  await ui.unmount()
})

test('밖에서 만든 파일도 몇 초 안에 목록에 저절로 나타난다 (새로고침·찾기 버튼은 없다)', async ($, on) => {
  // 시계: 3초마다 한 번씩 돈다고 답한다
  on('clock.every', () => ({ value: undefined }))
  await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', key: 'refresh' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'find' })).toBeUndefined()

  FILES['']?.push({ name: 'later.txt', kind: 'file' })
  await ui.advance(3000)
  expect(await lines(ui)).toContain('  later.txt')
  FILES['']?.pop()
  await ui.unmount()
})

test('Client가 없는 화면(VS Code)에서는 같은 목록을 버튼으로 그린다', async ($, on) => {
  await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect((await ui.find({ type: 'Button', key: 'dir:data' }))?.props.label).toBe('▸ data/')
  await ui.press({ key: 'dir:data' })
  expect(await ui.find({ type: 'Button', key: 'open:data/dates.json' })).toBeDefined()
  await ui.unmount()
})


test('Claude가 고친 파일은 ~로, 최근 작업에도 올라간다 (만든 뒤 고친 파일은 +로 남고, 접힌 폴더엔 •)', async ($, on) => {
  const readme = `${ROOT}/README.md`
  const made = `${ROOT}/data/new.csv`
  const data = FILES.data ?? []
  const present = new Set([readme])
  const norm = (path: string) => path.replace(/\\/g, '/')
  on('fs.exists', (_: unknown, e: any) => ({ value: [...present].some(one => norm(one) === norm(e.path)) }))
  on('tool.call', (_: unknown, e: any) => {
    if (e.tool === 'Write') {
      present.add(made)
      data.push({ name: 'new.csv', kind: 'file' })
    }

    return { result: {} }
  })
  await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await $.tool.call({ tool: 'Edit', file_path: readme, old_string: 'a', new_string: 'b' } as any)
  expect(await lines(ui)).toContain('  README.md ~')
  expect(linesOf(await ui.drawn({ in: 'made' }))[1]).toBe('~ README.md')

  // 새로 만든 뒤 고쳐도 +
  await $.tool.call({ tool: 'Write', file_path: made, content: 'a' } as any)
  await $.tool.call({ tool: 'Edit', file_path: made, old_string: 'a', new_string: 'b' } as any)
  expect(await lines(ui)).toContain('    new.csv +')

  // data/를 접으면 안에 만든 파일이 있다는 • 가 붙는다
  await click(ui, 0)
  expect((await lines(ui))[0]).toBe('▸ data/ 📂 •')
  data.pop()
  await ui.unmount()
})

test('설정에서 남겨 둘 개수를 바꾸면 저장되고 넘치는 오래된 것은 빠진다', async ($, on) => {
  const stored: Record<string, unknown> = {}
  on('store.get', (_: unknown, e: any) => ({ value: stored[e.key] }))
  on('store.set', (_: unknown, e: any) => ((stored[e.key] = e.value), { value: undefined }))
  on('fs.exists', () => ({ value: true }))
  on('tool.call', () => ({ result: {} }))
  await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  for (const name of ['a.txt', 'b.txt', 'c.txt']) {
    await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/${name}`, old_string: 'x', new_string: 'y' } as any)
  }
  expect(linesOf(await ui.drawn({ in: 'made' }))).toHaveLength(4)

  await ui.press({ key: 'settings' })
  expect(await ui.find({ type: 'Text', text: /^8개$/ })).toBeDefined()
  await ui.press({ key: 'limit-up' })
  expect(stored.recentLimit).toBe(9)
  for (let i = 0; i < 7; i++) await ui.press({ key: 'limit-down' })
  expect(stored.recentLimit).toBe(2)
  await ui.press({ key: 'settings' })
  // 최근 것 둘만 남는다
  expect(linesOf(await ui.drawn({ in: 'made' }))).toEqual(['─ 최근 작업 ─ 비우기', '~ c.txt', '~ b.txt'])
  await ui.unmount()
})

test('눌러도 커서·선택 표시(›)는 남지 않는다', async ($, on) => {
  await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const gutters = async () => linesOf(await ui.drawn({ in: 'tree' })).map(line => line[0])
  expect(await gutters()).not.toContain('›')

  await click(ui, 0)
  expect(await gutters()).not.toContain('›')
  await ui.unmount()
})

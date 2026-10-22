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

async function lines(ui: any): Promise<string[]> {
  return linesOf(await ui.drawn({ in: 'tree' }))
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
  expect(await lines(ui)).toEqual(['▸ data/ 📂', '  📄 README.md', '  zz.json'])
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
  expect((await lines(ui))[0]).toBe('▸ data/ 📂')
  await ui.unmount()
})

test('md·그림 파일을 누르면 목록 안에서 묻고, 열기를 누를 때만 연결된 프로그램으로 연다', async ($, on) => {
  const runs: string[][] = []
  on('process.run', (_: unknown, e: any) => (runs.push(e.argv), { value: { ...OK, exitCode: 1 } }))
  await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  // 누르면 그 줄 아래에 묻는 줄이 생기고, 취소하면 사라진다
  await click(ui, 1)
  expect((await lines(ui))[2]).toBe('    열까요? [ 열기 ]  [ 취소 ]')
  // 들여쓰기 4 + '열까요? ' 8 = 12칸부터 '[ 열기 ]', 22칸부터 '[ 취소 ]'
  await click(ui, 2, 23)
  expect((await lines(ui)).join('\n')).not.toMatch(/열까요/)
  expect(runs).toEqual([])

  // 같은 파일을 다시 누르면 묻는 줄이 닫힌다
  await click(ui, 1)
  await click(ui, 1)
  expect((await lines(ui)).join('\n')).not.toMatch(/열까요/)

  await click(ui, 1)
  await click(ui, 2, 13)
  expect(runs).toEqual([['explorer.exe', `${ROOT}\\README.md`]])
  expect((await lines(ui)).join('\n')).not.toMatch(/열까요/)

  // 그 밖의 파일 줄은 눌러도 아무것도 하지 않는다
  await click(ui, 2)
  expect((await lines(ui)).join('\n')).not.toMatch(/열까요/)
  await ui.unmount()
})

test('키보드: ↓로 옮기고 Enter로 누르며, 묻는 줄이 뜨면 커서가 열기로 간다', async ($, on) => {
  const runs: string[][] = []
  on('process.run', (_: unknown, e: any) => (runs.push(e.argv), { value: { ...OK, exitCode: 1 } }))
  await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.key({ key: 'down', in: 'tree' })
  await ui.key({ key: 'return', in: 'tree' })
  expect((await lines(ui))[2]).toMatch(/열까요/)
  await ui.key({ key: 'return', in: 'tree' })
  expect(runs).toEqual([['explorer.exe', `${ROOT}\\README.md`]])
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
  // '▸ data/' 7칸 + 띄운 1칸 뒤 8칸부터 📂
  await click(ui, 0, 8)
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
  expect((await lines(ui))[0]).toBe('▸ data/ 📂')
  await ui.unmount()
})

test('Claude가 새 파일을 만들면 그 폴더까지 펼치고, 탐색기에서 보기로 그 파일을 고른다', async ($, on) => {
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
    runs.push([e.argv[0], e.init?.env?.REVEAL_FOLDER, e.init?.env?.REVEAL_NAME])

    return { value: OK }
  })
  await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await $.tool.call({ tool: 'Write', file_path: made, content: 'a,b' } as any)
  expect(await lines(ui)).toContain('    new.csv ✨')
  expect((await lines(ui))[0]).toBe('▾ data/ 📂')
  expect((await ui.find({ type: 'Button', key: `reveal:${made}` }))?.text).toMatch(/data\/new\.csv/)

  await ui.press({ key: `reveal:${made}` })
  expect(runs).toEqual([['powershell.exe', `${ROOT}\\data`, 'new.csv']])

  await ui.press({ key: 'forget' })
  expect(await ui.find({ type: 'Button', key: `reveal:${made}` })).toBeUndefined()
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
  expect(await ui.find({ type: 'Text', text: /dates\.json/ })).toBeDefined()
  await ui.unmount()
})

test('설정에서 여는 파일의 확장자를 더하고 빼며, html은 기본으로 열린다', async ($, on) => {
  const stored: Record<string, unknown> = {}
  on('store.get', (_: unknown, e: any) => ({ value: stored[e.key] }))
  on('store.set', (_: unknown, e: any) => ((stored[e.key] = e.value), { value: undefined }))
  FILES['']?.push({ name: 'index.html', kind: 'file' })
  await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await lines(ui)).toContain('  🌐 index.html')

  await ui.press({ key: 'settings' })
  expect(await ui.find({ type: 'Button', key: 'ext:md' })).toBeDefined()
  // json 추가, md 빼기
  await ui.input({ key: 'ext-add-0', text: '.json, PDF', kind: 'submit' })
  await ui.press({ key: 'ext:md' })
  expect(stored.openExtensions).toContain('json')
  expect(stored.openExtensions).toContain('pdf')
  expect(stored.openExtensions).not.toContain('md')

  await ui.press({ key: 'settings' })
  expect(await lines(ui)).toContain('  📎 zz.json')
  expect(await lines(ui)).toContain('  README.md')

  await ui.press({ key: 'settings' })
  await ui.press({ key: 'ext-reset' })
  await ui.press({ key: 'settings' })
  expect(await lines(ui)).toContain('  📄 README.md')
  FILES['']?.pop()
  await ui.unmount()
})

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Entry, ListAct, ListProps, ListRow, MadeAct, MadeItem, MadeProps, TouchKind, Touched } from '../types'

const PANE = 'project-tree'
// 오른쪽 탭의 폭 (터미널 폭의 45%까지만 열린다)
const COLUMNS = 50
// 오른쪽 탭의 배경색 (테마마다 다르게 칠해지지 않도록 터미널 배경을 그대로 쓴다)
const BACKGROUND = 'transparent'
// 한 폴더에서 보여 줄 최대 항목 수
const LIMIT = 300
// 검색할 때 훑는 최대 파일 수와 보여 줄 최대 결과 수
const INDEX_LIMIT = 20_000
const RESULT_LIMIT = 300
const SKIP = new Set(['.git', 'node_modules'])

const isFolded = atom({ plugin: 'project-tree', key: 'isFolded' } as const, false)
const opened = atom({ plugin: 'project-tree', key: 'opened' } as const, [''])
const listings = atom({ plugin: 'project-tree', key: 'listings' } as const, {})
const query = atom({ plugin: 'project-tree', key: 'query' } as const, '')
const resets = atom({ plugin: 'project-tree', key: 'resets' } as const, 0)
const index = atom({ plugin: 'project-tree', key: 'index' } as const, null)
const recent = atom({ plugin: 'project-tree', key: 'recent' } as const, [])
// 열기 전에 탭 안에서 묻고 있는 파일 (잘못 누를 수 있어서)
const pending = atom({ plugin: 'project-tree', key: 'pending' } as const, null)
const isSettings = atom({ plugin: 'project-tree', key: 'isSettings' } as const, false)
// 최근 작업 파일 중 파일 보기·폴더 보기를 펼쳐 둔 것
const choosing = atom({ plugin: 'project-tree', key: 'choosing' } as const, null)
// 최근 작업 파일 목록에 남겨 둘 개수 (설정 화면에서 바꾼다, 세션을 넘어 $.store에 둔다)
const DEFAULT_RECENT_LIMIT = 8
const MIN_RECENT_LIMIT = 1
const MAX_RECENT_LIMIT = 30
const RECENT_LIMIT_KEY = 'recentLimit'
const recentLimit = atom({ plugin: 'project-tree', key: 'recentLimit' } as const, DEFAULT_RECENT_LIMIT)
// 만든 파일은 +, 고친 파일은 ~ (diff의 추가·변경 표기)
const MARKS: Record<TouchKind, string> = { new: '+', edit: '~' }

// 탐색기 열기가 왜 안 됐는지 남기는 줄: claude --debug 로그에만 쓴다
async function note($: EngineInterface, line: string) {
  try {
    $.ui.log(`project-tree: ${line}`, { to: 'debug' })
  } catch {
    // 기록은 못 해도 탭은 돌아간다
  }
}

function baseName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path
}

function join(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name
}

function clampLimit(value: number): number {
  return Math.max(MIN_RECENT_LIMIT, Math.min(MAX_RECENT_LIMIT, Math.round(value)))
}

async function loadRecentLimit($: EngineInterface) {
  const stored = await $.store.get(RECENT_LIMIT_KEY).catch(() => undefined)
  await update($, recentLimit, () => (typeof stored === 'number' ? clampLimit(stored) : DEFAULT_RECENT_LIMIT))
}

// 개수를 바꾸면 넘치는 오래된 것은 바로 버린다
async function saveRecentLimit($: EngineInterface, value: number) {
  const limit = clampLimit(value)
  await update($, recentLimit, () => limit)
  await update($, recent, list => list.slice(0, limit))
  await $.store.set(RECENT_LIMIT_KEY, limit).catch(() => undefined)
}

// 경로는 프로젝트 루트 기준으로 들고 다니고, 읽을 때만 루트를 붙인다
async function absolute($: EngineInterface, path: string): Promise<string> {
  const root = (await $.session.root()).replace(/[\\/]+$/, '')

  return path ? `${root}/${path}` : root
}

async function list($: EngineInterface, path: string): Promise<Entry[]> {
  try {
    const entries = await $.fs.list(await absolute($, path))

    return entries
      .filter(one => !SKIP.has(one.name))
      .map(one => ({ name: one.name, isDir: one.kind === 'dir' }))
      .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
  } catch {
    return []
  }
}

// 펼친 폴더와 검색용 전체 목록을 다시 읽는다 (파일이 생기거나 지워졌을 때)
async function refresh($: EngineInterface) {
  const paths = await read($, opened)
  const fresh: Record<string, Entry[]> = {}
  for (const path of paths) fresh[path] = await list($, path)
  await update($, listings, () => fresh)
  await buildIndex($)
}

// 탭이 열려 있는 동안 펼친 폴더를 가볍게 다시 읽어, 탐색기 등 밖에서 만들거나 지운 파일도 보이게 한다.
// 바뀐 것이 있을 때만 목록을 고쳐 쓰고 검색용 목록도 새로 만든다 (바뀐 게 없으면 다시 그리지 않는다)
const WATCH_MS = 3000

async function watch($: EngineInterface) {
  if (await read($, isFolded)) return
  const paths = await read($, opened)
  const before = await read($, listings)
  const fresh: Record<string, Entry[]> = {}
  for (const path of paths) fresh[path] = await list($, path)
  if (JSON.stringify(fresh) === JSON.stringify(before)) return

  await update($, listings, () => fresh)
  await buildIndex($)
}

// 검색용으로 프로젝트의 모든 파일 경로를 모은다
async function buildIndex($: EngineInterface) {
  const files: string[] = []
  const queue = ['']
  while (queue.length > 0 && files.length < INDEX_LIMIT) {
    const dir = queue.shift() as string
    for (const one of await list($, dir)) {
      const path = join(dir, one.name)
      if (one.isDir) queue.push(path)
      else files.push(path)
    }
  }
  await update($, index, () => files)
}

async function search($: EngineInterface, text: string) {
  await update($, query, () => text)
  if (text && (await read($, index)) === null) await buildIndex($)
}

async function toggle($: EngineInterface, path: string) {
  const paths = await read($, opened)
  if (paths.includes(path)) {
    // 접으면 그 아래 펼쳐 둔 폴더도 같이 접는다
    await update($, opened, list => list.filter(one => one !== path && !one.startsWith(`${path}/`)))
    return
  }

  const entries = await list($, path)
  await update($, listings, all => ({ ...all, [path]: entries }))
  await update($, opened, list => [...list, path])
}

// OS에 연결된 기본 프로그램으로 연다 (윈도우 explorer, 맥 open, 리눅스 xdg-open)
// path는 프로젝트 루트 기준 경로이거나, 방금 만든 파일처럼 이미 절대 경로다
async function openWithDefault($: EngineInterface, path: string) {
  const full = /^([A-Za-z]:[\\/]|\/)/.test(path) ? path : await absolute($, path)
  const isWindows = /^[A-Za-z]:[\\/]/.test(full)
  const commands = isWindows ? [['explorer.exe', full.replace(/\//g, '\\')]] : [['open', full], ['xdg-open', full]]

  for (const argv of commands) {
    try {
      const { exitCode } = await $.process.run(argv, { timeoutMs: 5000 })
      // explorer는 열고 나서도 1을 돌려준다
      if (exitCode === 0 || isWindows) return
    } catch {
      // 다음 명령으로
    }
  }
  $.ui.toast(`열지 못했습니다: ${baseName(path)}`)
}

// 프로젝트 루트 아래면 루트 기준 경로('/' 구분), 밖이면 ''
function relativeTo(root: string, full: string): string {
  const norm = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '')
  const base = `${norm(root)}/`
  const path = norm(full)

  return path.toLowerCase().startsWith(base.toLowerCase()) ? path.slice(base.length) : ''
}

// 탐색기를 열고 그 파일을 골라 둔다 (맥은 Finder, 리눅스는 담긴 폴더)
async function revealInExplorer($: EngineInterface, full: string) {
  const isWindows = /^[A-Za-z]:[\\/]/.test(full)
  const folder = full.replace(/[\\/][^\\/]*$/, '')
  if (isWindows) {
    await showInWindowsExplorer($, folder, baseName(full))
    return
  }
  await runFirst($, [['open', '-R', full], ['xdg-open', folder]], false, `탐색기를 열지 못했습니다: ${folder}`)
}

// 폴더 자체를 탐색기로 연다
async function openFolder($: EngineInterface, full: string) {
  if (/^[A-Za-z]:[\\/]/.test(full)) {
    await showInWindowsExplorer($, full, '')
    return
  }
  await runFirst($, [['open', full], ['xdg-open', full]], false, `폴더를 열지 못했습니다: ${full}`)
}

// explorer.exe를 그냥 띄우면 창이 터미널 뒤에 열리고 누를 때마다 쌓인다.
// 그 폴더를 보여 주는 창이 있으면 그 창을 쓰고, 파일을 골라 두고, 맨 앞으로 가져온다
const REVEAL_FUNCTION = `
Add-Type -Namespace W -Name U -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);
'@
$shell = New-Object -ComObject Shell.Application
function Reveal($folder, $name) {
  $url = 'file:///' + $folder.Replace('\\', '/')
  $find = { @($shell.Windows()) | Where-Object { $_.LocationURL -eq $url } | Select-Object -Last 1 }
  $window = & $find
  $isNew = -not $window
  if ($isNew) {
    $shell.Open($folder)
    for ($i = 0; $i -lt 40 -and -not $window; $i++) { Start-Sleep -Milliseconds 50; $window = & $find }
  }
  if (-not $window) { return $false }
  $h = [IntPtr]$window.HWND
  # Claude Code는 자식 프로세스를 창 숨김으로 띄워서 새 탐색기 창도 숨은 채로 생긴다. 다 만들어진 뒤 보이게 한다
  for ($i = 0; $i -lt 20 -and -not [W.U]::IsWindowVisible($h); $i++) {
    if ($isNew) { Start-Sleep -Milliseconds 50 }
    $window.Visible = $true
    [W.U]::ShowWindow($h, 5) | Out-Null
  }
  if ($name) {
    try { $item = $window.Document.Folder.ParseName($name); if ($item) { $window.Document.SelectItem($item, 1 + 4 + 8 + 16) } } catch {}
  }
  if ([W.U]::IsIconic($h)) { [W.U]::ShowWindow($h, 9) | Out-Null }
  [W.U]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [W.U]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
  [W.U]::SetForegroundWindow($h) | Out-Null
  return $true
}
`

// 한 번만 띄우는 경우 (상주 프로세스가 아직 준비되지 않았을 때)
const REVEAL_ONCE = `${REVEAL_FUNCTION}
if (-not (Reveal $env:REVEAL_FOLDER $env:REVEAL_NAME)) { exit 2 }
`

// 상주 프로세스: 시작할 때 한 번만 준비(PowerShell 기동·Add-Type 컴파일)해 두고,
// 요청 파일이 생기면 바로 처리한다. 누를 때마다 1~2초 걸리던 준비 시간이 없어진다
const REVEAL_SERVER = `${REVEAL_FUNCTION}
$queue = Join-Path $env:TEMP ('project-tree-' + $PID + '.req')
Remove-Item $queue -ErrorAction SilentlyContinue
# 첫 창 목록 조회가 1초쯤 걸려서 미리 한 번 해 둔다
@($shell.Windows()) | ForEach-Object { $_.LocationURL } | Out-Null
[Console]::Out.WriteLine('READY ' + $queue)
[Console]::Out.Flush()
while ($true) {
  if (Test-Path $queue) {
    try {
      $lines = Get-Content $queue -Encoding UTF8
      Remove-Item $queue -ErrorAction SilentlyContinue
      foreach ($line in $lines) {
        $parts = $line.Split([char]9)
        if ($parts[0]) { $ok = Reveal $parts[0] $parts[1]; [Console]::Out.WriteLine('DONE ' + $ok); [Console]::Out.Flush() }
      }
    } catch { [Console]::Out.WriteLine('FAIL ' + $_); [Console]::Out.Flush() }
  }
  Start-Sleep -Milliseconds 40
}
`

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

// powershell -EncodedCommand가 받는 UTF-16LE base64 (따옴표가 섞여도 인자가 깨지지 않게)
function encodeCommand(script: string): string {
  const bytes: number[] = []
  for (let i = 0; i < script.length; i++) {
    const code = script.charCodeAt(i)
    bytes.push(code & 0xff, code >> 8)
  }
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += BASE64.charAt((n >> 18) & 63) + BASE64.charAt((n >> 12) & 63)
    out += i + 1 < bytes.length ? BASE64.charAt((n >> 6) & 63) : '='
    out += i + 2 < bytes.length ? BASE64.charAt(n & 63) : '='
  }

  return out
}

function powershell(script: string): string[] {
  return ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodeCommand(script)]
}

// 상주 프로세스가 알려 준 요청 파일 경로. 준비 전이거나 프로세스가 끝나면 null
let revealQueue: string | null = null

// 세션 동안 떠 있는 탐색기 도우미를 띄운다 (윈도우에서만)
function startRevealServer($: EngineInterface) {
  void (async () => {
    try {
      for await (const piece of $.process.spawn({ argv: powershell(REVEAL_SERVER) })) {
        if (!('text' in piece)) continue
        const ready = /READY (.+?)\r?\n/.exec(piece.text)
        if (ready?.[1]) revealQueue = ready[1]
        if (piece.text.trim()) await note($, `server ${piece.stream}: ${piece.text.trim().slice(0, 200)}`)
      }
    } catch (error) {
      await note($, `server threw ${String(error)}`)
    }
    revealQueue = null
  })()
}

async function showInWindowsExplorer($: EngineInterface, folder: string, name: string) {
  const target = folder.replace(/\//g, '\\')
  if (revealQueue) {
    try {
      await $.fs.write(revealQueue, `${target}\t${name}\n`)
      await note($, `reveal queued ${target} ${name}`)
      return
    } catch (error) {
      await note($, `reveal queue failed ${String(error)}`)
    }
  }

  const argv = powershell(REVEAL_ONCE)
  const env = { REVEAL_FOLDER: target, REVEAL_NAME: name }
  try {
    const { exitCode, stderr } = await $.process.run(argv, { env, timeoutMs: 15000 })
    await note($, `reveal ${folder} ${name} exit=${exitCode} stderr=${stderr.slice(0, 200)}`)
    if (exitCode === 0) return
  } catch (error) {
    await note($, `reveal ${folder} ${name} threw ${String(error)}`)
  }
  $.ui.toast(`탐색기를 열지 못했습니다: ${folder}`)
}

// 차례로 돌려 보고 처음 된 것에서 멈춘다. explorer는 열고 나서도 1을 돌려줘서 윈도우는 시작만 되면 된 것으로 본다
async function runFirst($: EngineInterface, commands: string[][], isWindows: boolean, failure: string) {
  for (const argv of commands) {
    try {
      const { exitCode, stderr } = await $.process.run(argv, { timeoutMs: 5000 })
      await note($, `run ${JSON.stringify(argv)} exit=${exitCode} stderr=${stderr.slice(0, 200)}`)
      if (exitCode === 0 || isWindows) return
    } catch (error) {
      await note($, `run ${JSON.stringify(argv)} threw ${String(error)}`)
    }
  }
  $.ui.toast(failure)
}

// 0.1.0은 경로 문자열만 담았다: 세션 상태에 남은 그 모양도 '만든 파일'로 읽는다
function touchedList(stored: readonly unknown[]): Touched[] {
  return stored.flatMap(one =>
    typeof one === 'string'
      ? [{ path: one, kind: 'new' as const }]
      : one && typeof one === 'object' && typeof (one as Touched).path === 'string'
        ? [{ path: (one as Touched).path, kind: (one as Touched).kind === 'edit' ? ('edit' as const) : ('new' as const) }]
        : [],
  )
}

// Claude가 만들거나 고친 파일을 목록에 올리고, 트리에서 그 폴더까지 펼친다.
// 만든 뒤에 고친 파일은 '만든 파일'로 남긴다
async function reveal($: EngineInterface, full: string, kind: TouchKind) {
  const limit = await read($, recentLimit)
  await update($, recent, stored => {
    const list = touchedList(stored)
    const before = list.find(one => one.path === full)
    const touched: Touched = { path: full, kind: before?.kind === 'new' ? 'new' : kind }

    return [touched, ...list.filter(one => one.path !== full)].slice(0, limit)
  })
  const rel = relativeTo(await absolute($, ''), full)
  if (!rel) return

  const parts = rel.split('/')
  let dir = ''
  for (const part of parts.slice(0, -1)) {
    dir = join(dir, part)
    if (!(await read($, opened)).includes(dir)) await toggle($, dir)
  }
  await refresh($)
  await $.ui.scroll({ to: { key: `row:${rel}` }, in: PANE, block: 'center' }).catch(() => undefined)
}

// 목록에서 누른 것을 처리한다 (Client 영역의 post, 또는 Client가 없는 화면의 버튼)
async function listAct($: EngineInterface, { act, path }: ListAct) {
  if (act === 'toggle') await toggle($, path)
  // 다른 파일을 누르면 묻는 줄이 그쪽으로 옮겨 가고, 같은 파일을 다시 누르면 닫힌다
  else if (act === 'ask') await update($, pending, value => (value === path ? null : path))
  else if (act === 'cancel') await update($, pending, () => null)
  else if (act === 'confirm') {
    await update($, pending, () => null)
    await openWithDefault($, path)
  } else if (act === 'folder') await openFolder($, await absolute($, path))
}

// '최근 작업 파일'에서 누른 것을 처리한다 (made-list.tsx의 post, 또는 Client가 없는 화면의 버튼)
async function madeAct($: EngineInterface, request: MadeAct) {
  if (request.act === 'forget') {
    await update($, recent, () => [])
    return
  }
  const { act, path } = request
  if (act === 'pick') {
    await update($, choosing, value => (value === path ? null : path))
    return
  }
  await update($, choosing, () => null)
  if (act === 'file') await openWithDefault($, path)
  else await revealInExplorer($, path)
}

function openTab($: EngineInterface) {
  return $.ui.open({ id: PANE, title: '프로젝트', columns: COLUMNS, backgroundColor: BACKGROUND })
}

// 탭을 접으면 닫고, 프롬프트 위에 다시 펼칠 버튼만 남긴다
async function fold($: EngineInterface, isFolding: boolean) {
  await update($, isFolded, () => isFolding)
  if (isFolding) {
    await $.ui.close({ id: PANE })
    return
  }
  await refresh($)
  await openTab($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'tree',
      description: '오른쪽 프로젝트 탭 접기·펼치기',
    })
    await loadRecentLimit($)
    await refresh($)
    if (!(await read($, isFolded))) void openTab($)
    if (/^[A-Za-z]:[\\/]/.test(await absolute($, '').catch(() => ''))) startRevealServer($)
    // 앞선 읽기가 끝나기 전에는 다음 읽기를 건너뛴다
    let isWatching = false
    $.clock.every(WATCH_MS, () => {
      if (isWatching) return
      isWatching = true
      void watch($)
        .catch(() => undefined)
        .finally(() => {
          isWatching = false
        })
    })

    return next(e)
  })

  on('command.run', { command: 'tree' }, async $ => {
    const isFolding = !(await read($, isFolded))
    await fold($, isFolding)

    return { text: isFolding ? '프로젝트 탭을 접었습니다.' : '프로젝트 탭을 펼쳤습니다.' }
  })

  // Esc나 ctrl+x x로 닫아도 접힌 것으로 본다
  on('ui.close', { id: PANE }, async ($, e, next) => {
    const done = await next(e)
    if (e.origin.kind === 'person') await update($, isFolded, () => true)

    return done
  })

  // 턴이 끝나면 Claude가 만들거나 지운 파일이 보이도록 다시 읽는다
  // Claude가 Write로 새 파일을 만들면 트리에서 그 자리를 보여 준다 (있던 파일을 고쳐 쓴 것은 빼고)
  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const path = String(e.file_path ?? '')
    const existed = path ? await $.fs.exists(path).catch(() => true) : true
    const done = await next(e)
    if (path && !done.isError && (await $.fs.exists(path).catch(() => false))) {
      await reveal($, path, existed ? 'edit' : 'new')
    }

    return done
  })

  // 있던 파일을 Edit·NotebookEdit로 고친 것도 '고친 파일'로 보여 준다
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const done = await next(e)
    const path = String(e.file_path ?? '')
    if (path && !done.isError) await reveal($, path, 'edit')

    return done
  })

  on('tool.call', { tool: 'NotebookEdit' }, async ($, e, next) => {
    const done = await next(e)
    const path = String(e.notebook_path ?? '')
    if (path && !done.isError) await reveal($, path, 'edit')

    return done
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (!e.agentId) await refresh($)

    return done
  })

  // 목록 영역(tree-list.tsx)이 보낸 누르기
  on('ui.message', { element: 'tree' }, async ($, e) => {
    const data = e.data as Partial<ListAct> | null
    if (data && typeof data.path === 'string' && typeof data.act === 'string') await listAct($, data as ListAct)

    return {}
  })

  // '최근 작업 파일' 영역(made-list.tsx)이 보낸 누르기
  on('ui.message', { element: 'made' }, async ($, e) => {
    const data = e.data as Partial<{ act: string; path: string }> | null
    if (data?.act === 'forget') await madeAct($, { act: 'forget' })
    else if ((data?.act === 'pick' || data?.act === 'file' || data?.act === 'folder') && typeof data.path === 'string') {
      await madeAct($, { act: data.act, path: data.path })
    }

    return {}
  })

  // 접혀 있을 때만 프롬프트 위 오른쪽 끝에 펼치기 버튼을 둔다
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, isFolded))) return next(e)

    const below = await next(e)
    const { Box, Button } = $.ui.resolve(e)
    const root = baseName(await $.session.root().catch(() => '프로젝트'))

    return (
      <Box flexDirection="column">
        <Box justifyContent="flex-end">
          <Button key="unfold" label={`« ${root}`} plain onPress={() => fold($, false)} />
        </Box>
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Button, Text } = elements
    const root = baseName(await $.session.root().catch(() => '프로젝트'))
    const paths = await read($, opened)
    const all = await read($, listings)
    const text = await read($, query)
    const asking = await read($, pending)
    const made = touchedList(await read($, recent))
    const picking = await read($, choosing)
    const rootPath = await absolute($, '')

    // 모양: 배경색 칩·이모지 없이 글자색과 1칸 기호만. 강조는 cyan, 만듦 green, 고침 yellow
    // 섹션 제목은 이름표 붙은 가로줄: '─ 제목 ──────'
    const rule = (title: string, right: RenderChildren = null) => (
      <Box>
        <Text dimColor>─ </Text>
        <Text bold>{title} </Text>
        <Box flexGrow={1} height={1} overflow="hidden">
          <Text dimColor>{'─'.repeat(200)}</Text>
        </Box>
        {right}
      </Box>
    )

    // 설정 화면: 최근 작업에 남겨 둘 개수를 고른다
    if (await read($, isSettings)) {
      const limit = await read($, recentLimit)
      return (
        <Box flexDirection="column">
          <Box justifyContent="space-between">
            <Text bold>설정</Text>
            <Button key="settings" label="← 돌아가기" plain onPress={() => update($, isSettings, () => false)}>
              <Text color="cyan">← 돌아가기</Text>
            </Button>
          </Box>

          <Box marginTop={1}>{rule('최근 작업 개수')}</Box>
          <Box justifyContent="space-between">
            <Box gap={2}>
              <Button key="limit-down" label="−" dimColor={limit <= MIN_RECENT_LIMIT} onPress={() => saveRecentLimit($, limit - 1)} />
              <Text bold>{`${limit}개`}</Text>
              <Button key="limit-up" label="+" dimColor={limit >= MAX_RECENT_LIMIT} onPress={() => saveRecentLimit($, limit + 1)} />
            </Box>
            <Text dimColor>{`${MIN_RECENT_LIMIT}~${MAX_RECENT_LIMIT} · 기본 ${DEFAULT_RECENT_LIMIT}`}</Text>
          </Box>
        </Box>
      )
    }
    // 트리에서 표시할 손댄 파일: 프로젝트 루트 기준 경로 → 만듦/고침
    const touched = new Map(made.map(one => [relativeTo(rootPath, one.path), one.kind] as const).filter(([rel]) => rel))
    const markOf = (path: string) => touched.get(path)
    const dirMarkOf = (dir: string): TouchKind | undefined => {
      let found: TouchKind | undefined
      for (const [rel, kind] of touched) {
        if (!rel.startsWith(`${dir}/`)) continue
        if (kind === 'new') return 'new'
        found = 'edit'
      }

      return found
    }

    // 드래그해도 복사되지 않도록 목록은 Client 영역에 그린다 (Client가 있는 화면에서만)
    const hasClient = 'Client' in elements && (e.surface === 'terminal' || e.surface === 'desktop')

    // Claude가 방금 만들거나 고친 파일: 누르면 바로 아래에 파일 보기·폴더 보기를 펼치고, 다시 누르면 닫는다
    // 이름은 앞에, 폴더는 뒤에: 경로가 길어도 파일 이름과 표시가 잘리지 않게
    const items: MadeItem[] = made.map(one => {
      const rel = relativeTo(rootPath, one.path)
      const parts = (rel || one.path).split(/[\\/]/).filter(Boolean)
      const name = parts.pop() ?? one.path
      const dir = rel ? parts.join('/') : `${parts.length > 2 ? '…/' : ''}${parts.slice(-2).join('/')}`

      return { path: one.path, kind: one.kind, name, dir }
    })
    const madeBox =
      made.length === 0 ? null : hasClient ? (
        <Box marginTop={1}>
          <elements.Client
            key="made"
            module="./made-list.tsx"
            width="100%"
            props={{ items, picking } satisfies MadeProps}
          />
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {rule('최근 작업', <Button key="forget" label=" 비우기" plain dimColor onPress={() => madeAct($, { act: 'forget' })} />)}
          {items.map(one => (
            <Box key={`made:${one.path}`} flexDirection="column">
              <Button key={`reveal:${one.path}`} label={one.name} plain onPress={() => madeAct($, { act: 'pick', path: one.path })}>
                <Text color={one.kind === 'new' ? 'green' : 'yellow'} bold>
                  {MARKS[one.kind]}
                </Text>{' '}
                {one.name}
                <Text dimColor>{one.dir ? `  ${one.dir}` : ''}</Text>
              </Button>
              {picking === one.path ? (
                <Box gap={2}>
                  <Text dimColor>{'  └'}</Text>
                  <Button key="made-open-file" label="파일 열기" variant="primary" onPress={() => madeAct($, { act: 'file', path: one.path })} />
                  <Button key="made-open-folder" label="폴더 열기" onPress={() => madeAct($, { act: 'folder', path: one.path })} />
                </Box>
              ) : null}
            </Box>
          ))}
        </Box>
      )

    // 목록은 줄 데이터로 만들어 Client 영역(tree-list.tsx)에 넘긴다
    const rows: ListRow[] = []
    const file = (path: string, label: string, depth: number) => {
      // Client props에는 undefined를 담을 수 없어 표시가 있을 때만 mark를 넣는다
      const mark = markOf(path)
      // 어떤 파일이든 누르면 연다 (열기 전에 묻는다)
      rows.push({ id: path, kind: 'file', depth, label, ...(mark ? { mark } : {}) })
      // 누른 파일 줄 바로 아래에 열지 묻는 줄을 끼운다
      if (asking === path) rows.push({ id: path, kind: 'confirm', depth, label: '' })
    }
    // 펼친 폴더를 따라 내려가며 한 줄씩 늘어놓는다
    const walk = (path: string, depth: number) => {
      const entries = all[path] ?? []
      for (const one of entries.slice(0, LIMIT)) {
        const child = join(path, one.name)
        if (one.isDir) {
          const isOpen = paths.includes(child)
          // 접힌 폴더 안에 Claude가 손댄 파일이 있으면 오른쪽 끝에 • (만든 게 있으면 만듦 색)
          const inside = isOpen ? undefined : dirMarkOf(child)
          rows.push({ id: child, kind: 'dir', depth, label: one.name, isOpen, ...(inside ? { mark: inside } : {}) })
          if (isOpen) walk(child, depth + 1)
        } else {
          file(child, one.name, depth)
        }
      }
      if (entries.length > LIMIT) {
        rows.push({ id: `${path}/…`, kind: 'note', depth, label: `… ${entries.length - LIMIT}개 더` })
      }
    }

    // 검색어가 있으면 트리 대신 이름이 맞는 파일을 경로째 늘어놓는다
    if (text) {
      const files = (await read($, index)) ?? []
      const needle = text.toLowerCase()
      const found = files.filter(path => baseName(path).toLowerCase().includes(needle))
      for (const path of found.slice(0, RESULT_LIMIT)) file(path, path, 0)
      if (found.length > RESULT_LIMIT) {
        rows.push({ id: '…', kind: 'note', depth: 0, label: `… ${found.length - RESULT_LIMIT}개 더` })
      }
    } else {
      walk('', 0)
    }

    // Client가 없는 화면(VS Code·모바일)에서는 같은 줄을 버튼으로 그린다
    const fallback = (row: ListRow) => {
      const indent = '  '.repeat(row.depth)
      const mark = row.mark ? (
        <Text color={row.mark === 'new' ? 'green' : 'yellow'} bold>
          {row.kind === 'dir' ? ' •' : ` ${MARKS[row.mark]}`}
        </Text>
      ) : null
      if (row.kind === 'dir') {
        return (
          <Box key={`row:${row.id}`}>
            <Button
              key={`dir:${row.id}`}
              label={`${indent}${row.isOpen ? '▾' : '▸'} ${row.label}/`}
              plain
              onPress={() => listAct($, { act: 'toggle', path: row.id })}
            />
            <Button key={`folder:${row.id}`} label=" 📂" plain dimColor onPress={() => listAct($, { act: 'folder', path: row.id })} />
            {mark}
          </Box>
        )
      }
      if (row.kind === 'file') {
        return (
          <Box key={`row:${row.id}`}>
            <Button key={`open:${row.id}`} label={`${indent}  ${row.label}`} plain onPress={() => listAct($, { act: 'ask', path: row.id })} />
            {mark}
          </Box>
        )
      }
      if (row.kind === 'confirm') {
        return (
          <Box key={`confirm:${row.id}`} gap={2}>
            <Text>
              <Text dimColor>{`${indent}  └ `}</Text>열까요?
            </Text>
            <Button key="confirm-open" label="열기" variant="primary" onPress={() => listAct($, { act: 'confirm', path: row.id })} />
            <Button key="confirm-cancel" label="취소" onPress={() => listAct($, { act: 'cancel', path: row.id })} />
          </Box>
        )
      }

      return (
        <Text dimColor italic={row.kind === 'note'}>
          {`${indent}  ${row.label}`}
          {mark}
        </Text>
      )
    }
    const list =
      rows.length === 0 ? (
        <Text dimColor>{text ? '맞는 파일이 없습니다.' : '비어 있습니다.'}</Text>
      ) : hasClient ? (
        <elements.Client
          key="tree"
          module="./tree-list.tsx"
          width="100%"
          props={{ rows } satisfies ListProps}
        />
      ) : (
        rows.map(fallback)
      )

    // Input은 모바일에 없다. 입력 중에 value를 다시 그리거나 목록을 크게 바꾸면 포커스가 풀려서
    // 값은 필드에 맡기고 Enter에서만 검색한다. ✕로 지울 때만 key를 바꿔 빈 필드로 새로 그린다
    const field = `search-${await read($, resets)}`
    const clear = async () => {
      await update($, resets, n => n + 1)
      await search($, '')
      await $.ui.focus({ requestId: e.requestId, key: `search-${await read($, resets)}` }).catch(() => undefined)
    }
    const searchBox =
      'Input' in elements ? (
        <Box key="search-row" justifyContent="space-between">
          <elements.Input
            key={field}
            label="/ "
            placeholder="파일 이름 검색 · Enter"
            submitLabel="검색"
            autoFocus
            onSubmit={async value => {
              await search($, value.trim())
              await $.ui.focus({ requestId: e.requestId, key: field }).catch(() => undefined)
            }}
          />
          <Button key="clear" label="×" plain dimColor={!text} onPress={clear} />
        </Box>
      ) : null

    // 머리줄 한 줄(왼쪽 프로젝트 📂, 오른쪽 설정·접기), 그 아래 검색칸·트리, 맨 밑에 최근 작업
    // (목록은 저절로 다시 읽으므로 새로고침 버튼은 두지 않는다)
    return (
      <Box flexDirection="column">
        <Box justifyContent="space-between">
          <Box flexShrink={1}>
            <Button key="folder:" label={`${root} 📂`} plain onPress={() => openFolder($, rootPath)}>
              <Text bold>{root}</Text>
              <Text dimColor> 📂</Text>
            </Button>
          </Box>
          <Box gap={2} flexShrink={0} marginLeft={2}>
            <Button key="settings" label="설정" plain onPress={() => update($, isSettings, () => true)} />
            <Button key="fold" label="접기 »" plain onPress={() => fold($, true)} />
          </Box>
        </Box>
        {searchBox}
        {list}
        {madeBox}
      </Box>
    )
  })
}

import type { ClientModule, ClientSurface } from 'claude-code'

import type { ListAct, ListProps, ListRow } from '../types'

// 파일 목록을 Client 영역에 그린다. 이 영역에서는 마우스를 눌러 끌어도 화면이 글자를 고르지 않아
// 클립보드로 복사되지 않는다. 대신 누르기·키 입력을 여기서 직접 받아 hooks 모듈에 post로 넘긴다
type State = { cursor: number; hover: number | null; down: number | null; focus: string | null }

// 확인 줄의 버튼 자리 (글자 칸): '열까요? ' 8칸 뒤 '[ 열기 ]' 8칸, 2칸 띄고 '[ 취소 ]' 8칸
const ASK = '열까요? '
const OPEN = '[ 열기 ]'
const CANCEL = '[ 취소 ]'
const ASK_CELLS = 8
const BUTTON_CELLS = 8
const GAP = '  '
// 폴더 이름 바로 뒤에 붙는 📂 (앞의 한 칸 포함)
const FOLDER = ' 📂'

function indentOf(row: ListRow): string {
  return '  '.repeat(row.depth) + (row.kind === 'dir' ? '' : row.kind === 'confirm' ? '    ' : '  ')
}

// 터미널에서 글자가 차지하는 칸 수: 한글·한자·전각·이모지는 2칸, 결합 문자는 0칸
function cells(text: string): number {
  let width = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if ((code >= 0x300 && code <= 0x36f) || code === 0x200d || (code >= 0xfe00 && code <= 0xfe0f)) continue
    const isWide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faff) ||
      code >= 0x20000
    width += isWide ? 2 : 1
  }

  return width
}

function dirName(row: ListRow): string {
  return `${row.isOpen ? '▾' : '▸'} ${row.label}/`
}

// 한 줄에서 x칸을 누르면 무엇을 할지
function actAt(row: ListRow, x: number): ListAct | null {
  if (row.kind === 'dir') {
    // 이름 뒤 📂 (띄운 한 칸 빼고 2칸)을 누르면 탐색기, 나머지는 펼치기·접기
    const start = cells(indentOf(row) + dirName(row)) + 1
    const isFolder = x >= start && x < start + 2
    return { act: isFolder ? 'folder' : 'toggle', path: row.id }
  }
  if (row.kind === 'file') return { act: 'ask', path: row.id }
  if (row.kind === 'confirm') {
    const open = indentOf(row).length + ASK_CELLS
    const cancel = open + BUTTON_CELLS + GAP.length
    if (x >= open && x < open + BUTTON_CELLS) return { act: 'confirm', path: row.id }
    if (x >= cancel && x < cancel + BUTTON_CELLS) return { act: 'cancel', path: row.id }
  }

  return null
}

// Enter로 누를 때: 확인 줄이면 열기, 나머지는 이름을 누른 것과 같다
function actOnEnter(row: ListRow): ListAct | null {
  if (row.kind === 'confirm') return { act: 'confirm', path: row.id }

  return actAt(row, 0)
}

function listen(surface: ClientSurface<State>, props: () => ListProps) {
  const now = (): State => surface.state ?? { cursor: 0, hover: null, down: null, focus: null }
  const rowAt = (y: number) => (y >= 0 && y < props().rows.length ? y : null)

  surface.onPointer(event => {
    const state = now()
    const at = rowAt(event.y)
    if (event.type === 'down') {
      surface.setState({ ...state, down: at, cursor: at ?? state.cursor })
    } else if (event.type === 'up') {
      // 누른 줄에서 뗐을 때만 누른 것으로 친다 (끌다가 다른 줄에서 떼면 아무것도 안 함)
      const row = at !== null && at === state.down ? props().rows[at] : undefined
      const act = row ? actAt(row, event.x) : null
      if (act) surface.post(act)
      surface.setState({ ...state, down: null })
    } else if (event.type === 'move' && event.button === undefined) {
      if (at !== state.hover) surface.setState({ ...state, hover: at })
    } else if (event.type === 'leave' && state.hover !== null) {
      surface.setState({ ...state, hover: null })
    }
  })

  surface.onKey(event => {
    const state = now()
    const { rows } = props()
    if (rows.length === 0) return
    const last = rows.length - 1
    if (event.key === 'up') surface.setState({ ...state, cursor: Math.max(0, state.cursor - 1) })
    else if (event.key === 'down') surface.setState({ ...state, cursor: Math.min(last, state.cursor + 1) })
    else if (event.key === 'home') surface.setState({ ...state, cursor: 0 })
    else if (event.key === 'end') surface.setState({ ...state, cursor: last })
    else if (event.key === 'pageup') surface.setState({ ...state, cursor: Math.max(0, state.cursor - 10) })
    else if (event.key === 'pagedown') surface.setState({ ...state, cursor: Math.min(last, state.cursor + 10) })
    else {
      const row = rows[Math.min(state.cursor, last)]
      if (!row) return
      if (event.key === 'return') {
        const act = actOnEnter(row)
        if (act) surface.post(act)
      } else if (event.key === 'o' && row.kind === 'dir') {
        surface.post({ act: 'folder', path: row.id })
      }
    }
  })
}

const TreeList: ClientModule<ListProps, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  let state = surface.state
  if (state === undefined) {
    state = { cursor: 0, hover: null, down: null, focus: null }
    surface.setState(state)
    // 리스너는 한 번만 단다. 최신 props는 마지막으로 받은 것을 읽는다
    listen(surface, () => latest)
  }
  latest = props

  // hooks가 커서를 옮겨 달라고 한 줄이 새로 생기면 (확인 줄) 그리로 간다
  if (props.focus !== state.focus) {
    const at = props.rows.findIndex(row => row.id === props.focus && row.kind === 'confirm')
    state = { ...state, focus: props.focus, cursor: at >= 0 ? at : state.cursor }
    surface.setState(state)
  }
  const cursor = Math.min(state.cursor, Math.max(0, props.rows.length - 1))

  return (
    <Box flexDirection="column">
      {props.rows.map((row, i) => {
        const isCursor = i === cursor
        const isHover = i === state?.hover
        const indent = indentOf(row)
        if (row.kind === 'confirm') {
          return (
            <Text>
              <Text color="yellow">{`${indent}${ASK}`}</Text>
              <Text color="green" bold inverse={isCursor}>
                {OPEN}
              </Text>
              <Text>{GAP}</Text>
              <Text dimColor>{CANCEL}</Text>
            </Text>
          )
        }
        if (row.kind === 'note') return <Text dimColor>{`${indent}${row.label}`}</Text>

        const name = row.kind === 'dir' ? dirName(row) : `${row.label}${row.isNew ? ' ✨' : ''}`
        return (
          <Text wrap="truncate-end">
            <Text
              inverse={isCursor}
              underline={isHover && !isCursor}
              color={row.isNew ? 'yellow' : row.kind === 'dir' ? 'cyan' : undefined}
              dimColor={row.kind === 'plain' && !row.isNew}
            >
              {`${indent}${name}`}
            </Text>
            {row.kind === 'dir' ? <Text dimColor={!isHover}>{FOLDER}</Text> : null}
          </Text>
        )
      })}
    </Box>
  )
}

// 리스너가 읽는 마지막 props (모듈은 인스턴스 하나만 그린다)
let latest: ListProps = { rows: [], focus: null }

export default TreeList

import type { ClientModule, ClientSurface } from 'claude-code'

import type { ListAct, ListProps, ListRow } from '../types'

// 파일 목록을 Client 영역에 그린다. 이 영역에서는 마우스를 눌러 끌어도 화면이 글자를 고르지 않아
// 클립보드로 복사되지 않는다. 대신 누르기·키 입력을 여기서 직접 받아 hooks 모듈에 post로 넘긴다
type State = { hover: number | null; down: number | null }

// 모양: 배경색 없이 글자색과 1칸 기호만 쓴다 (이모지는 터미널마다 폭이 달라 쓰지 않는다)
// 줄 = 거터 1칸(커서 ›) + 들여쓰기 + 이름 … + 오른쪽 끝 표시 2칸(+ 만듦, ~ 고침, • 바뀐 것을 품은 접힌 폴더)
const ASK = '└ '
const OPEN = '[ 열기 ]'
const COPY = '[ 경로 복사 ]'
const GAP = '  '
// 폴더 열기: 폴더 이름 바로 뒤 📂 (U+1F4C2, VS16 없이 늘 2칸). 평소엔 흐리게, 마우스를 올리면 또렷하게
const FOLDER = ' 📂'
const MARKS = { new: ' +', edit: ' ~' } as const
const COLORS = { new: 'green', edit: 'yellow' } as const

// 거터 1칸 + 깊이마다 2칸 + 파일·확인 줄은 폴더 기호 자리 2칸
function indentOf(row: ListRow): string {
  return ` ${'  '.repeat(row.depth)}${row.kind === 'dir' ? '' : '  '}`
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

function caretOf(row: ListRow): string {
  return row.isOpen ? '▾ ' : '▸ '
}

// 한 줄에서 x칸을 누르면 무엇을 할지
function actAt(row: ListRow, x: number): ListAct | null {
  if (row.kind === 'dir') {
    // 이름 뒤 ' 📂' 3칸(앞 공백 포함)을 누르면 탐색기, 나머지는 펼치기·접기
    const start = cells(indentOf(row) + caretOf(row) + row.label + '/')
    const isFolder = x >= start && x < start + cells(FOLDER)
    return { act: isFolder ? 'folder' : 'toggle', path: row.id }
  }
  if (row.kind === 'file') return { act: 'ask', path: row.id }
  if (row.kind === 'confirm') {
    const open = cells(indentOf(row) + ASK)
    const copy = open + cells(OPEN + GAP)
    if (x >= open && x < open + cells(OPEN)) return { act: 'confirm', path: row.id }
    if (x >= copy && x < copy + cells(COPY)) return { act: 'copy', path: row.id }
  }

  return null
}

// 마우스로만 쓴다 (키보드 조작·커서는 두지 않는다)
function listen(surface: ClientSurface<State>, props: () => ListProps) {
  const now = (): State => surface.state ?? { hover: null, down: null }
  const rowAt = (y: number) => (y >= 0 && y < props().rows.length ? y : null)

  surface.onPointer(event => {
    const state = now()
    const at = rowAt(event.y)
    if (event.type === 'down') {
      surface.setState({ ...state, down: at })
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
}

const TreeList: ClientModule<ListProps, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  let state = surface.state
  if (state === undefined) {
    state = { hover: null, down: null }
    surface.setState(state)
    // 리스너는 한 번만 단다. 최신 props는 마지막으로 받은 것을 읽는다
    listen(surface, () => latest)
  }
  latest = props

  return (
    <Box flexDirection="column">
      {props.rows.map((row, i) => {
        const isHover = i === state?.hover
        // 거터 1칸은 비워 둔다 (커서·선택 표시는 그리지 않는다. 클릭 위치 계산은 이 칸을 센다)
        const gutter = <Text> </Text>
        const indent = indentOf(row).slice(1)

        if (row.kind === 'confirm') {
          return (
            <Text wrap="truncate-end">
              {gutter}
              <Text>{indent}</Text>
              <Text dimColor>{ASK}</Text>
              <Text color="green" bold>
                {OPEN}
              </Text>
              <Text>{GAP}</Text>
              <Text>{COPY}</Text>
            </Text>
          )
        }
        if (row.kind === 'note') {
          return (
            <Text wrap="truncate-end">
              {gutter}
              <Text dimColor italic>{`${indent}${row.label}`}</Text>
            </Text>
          )
        }

        // 오른쪽 끝 2칸: 파일은 + / ~, 접힌 폴더는 안에 손댄 파일이 있다는 •
        const mark = row.mark ? (
          <Text color={COLORS[row.mark]} bold>
            {row.kind === 'dir' ? ' •' : MARKS[row.mark]}
          </Text>
        ) : (
          <Text>{'  '}</Text>
        )

        if (row.kind === 'dir') {
          return (
            <Box width="100%">
              <Box flexGrow={1} flexShrink={1}>
                <Text wrap="truncate-end">
                  {gutter}
                  <Text>{indent}</Text>
                  <Text dimColor>{caretOf(row)}</Text>
                  <Text color="cyan">{`${row.label}/`}</Text>
                  <Text dimColor={!isHover}>{FOLDER}</Text>
                </Text>
              </Box>
              {mark}
            </Box>
          )
        }

        // 만든 파일은 green, 고친 파일은 yellow, 나머지는 기본색
        return (
          <Box width="100%">
            <Box flexGrow={1} flexShrink={1}>
              <Text wrap="truncate-end">
                {gutter}
                <Text>{indent}</Text>
                <Text color={row.mark ? COLORS[row.mark] : undefined}>{row.label}</Text>
              </Text>
            </Box>
            {mark}
          </Box>
        )
      })}
    </Box>
  )
}

// 리스너가 읽는 마지막 props (모듈은 인스턴스 하나만 그린다)
let latest: ListProps = { rows: [] }

export default TreeList

import type { ClientModule, ClientSurface } from 'claude-code'

import type { MadeAct, MadeItem, MadeProps } from '../types'

// '최근 작업'을 Client 영역에 그린다. tree-list.tsx처럼 이 영역을 끌어도 복사되지 않고,
// 누르기·키 입력을 여기서 받아 hooks 모듈에 post로 넘긴다
type State = { hover: number | null; down: number | null }

// 줄: 제목, 파일들, (펼쳐 둔 파일 아래) 고르는 줄
type Line = { kind: 'title' } | { kind: 'item'; item: MadeItem } | { kind: 'choice'; item: MadeItem }

// 제목은 이름표 붙은 가로줄: '─ 최근 작업 ─────── 비우기'
const TITLE_HEAD = '─ '
const TITLE = '최근 작업 '
const FORGET = ' 비우기'
const CHOICE_INDENT = '  └ '
const OPEN_FILE = '[ 파일 열기 ]'
const OPEN_FOLDER = '[ 폴더 열기 ]'
const GAP = '  '
// 앞 칸이 분류 열: + 만듦(green), ~ 고침(yellow)
const MARKS = { new: '+', edit: '~' } as const
const COLORS = { new: 'green', edit: 'yellow' } as const

// 터미널에서 글자가 차지하는 칸 수: 한글·한자·전각·이모지는 2칸, 결합 문자는 0칸 (tree-list.tsx와 같다)
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

function linesOf(props: MadeProps): Line[] {
  const lines: Line[] = [{ kind: 'title' }]
  for (const item of props.items) {
    lines.push({ kind: 'item', item })
    if (props.picking === item.path) lines.push({ kind: 'choice', item })
  }

  return lines
}

// 한 줄에서 x칸을 누르면 무엇을 할지
function actAt(line: Line, x: number, columns: number): MadeAct | null {
  if (line.kind === 'title') {
    // 오른쪽 끝 '비우기' (앞 공백 빼고)
    return columns > 0 && x >= columns - cells(FORGET.trim()) ? { act: 'forget' } : null
  }
  if (line.kind === 'item') return { act: 'pick', path: line.item.path }

  const file = cells(CHOICE_INDENT)
  const folder = file + cells(OPEN_FILE + GAP)
  if (x >= file && x < file + cells(OPEN_FILE)) return { act: 'file', path: line.item.path }
  if (x >= folder && x < folder + cells(OPEN_FOLDER)) return { act: 'folder', path: line.item.path }

  return null
}

// 마우스로만 쓴다 (키보드 조작·커서는 두지 않는다)
function listen(surface: ClientSurface<State>, props: () => MadeProps) {
  const now = (): State => surface.state ?? { hover: null, down: null }
  const lineAt = (y: number) => {
    const lines = linesOf(props())

    return y >= 0 && y < lines.length ? y : null
  }

  surface.onPointer(event => {
    const state = now()
    const at = lineAt(event.y)
    if (event.type === 'down') {
      surface.setState({ ...state, down: at })
    } else if (event.type === 'up') {
      // 누른 줄에서 뗐을 때만 누른 것으로 친다
      const line = at !== null && at === state.down ? linesOf(props())[at] : undefined
      const act = line ? actAt(line, event.x, surface.columns) : null
      if (act) surface.post(act)
      surface.setState({ ...state, down: null })
    } else if (event.type === 'move' && event.button === undefined) {
      if (at !== state.hover) surface.setState({ ...state, hover: at })
    } else if (event.type === 'leave' && state.hover !== null) {
      surface.setState({ ...state, hover: null })
    }
  })
}

// 리스너가 읽는 마지막 props (모듈은 인스턴스 하나만 그린다)
let latest: MadeProps = { items: [], picking: null }

const MadeList: ClientModule<MadeProps, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  let state = surface.state
  if (state === undefined) {
    state = { hover: null, down: null }
    surface.setState(state)
    listen(surface, () => latest)
  }
  latest = props

  const lines = linesOf(props)
  // 제목 가로줄 채움: 영역 폭에서 앞뒤 글자를 뺀 만큼 (처음 그릴 때는 폭을 몰라 1칸)
  const fill = Math.max(1, surface.columns - cells(TITLE_HEAD + TITLE + FORGET))

  return (
    <Box flexDirection="column">
      {lines.map((line, i) => {
        const isHover = i === state?.hover
        if (line.kind === 'title') {
          return (
            <Text wrap="truncate-end">
              <Text dimColor>{TITLE_HEAD}</Text>
              <Text bold>{TITLE}</Text>
              <Text dimColor>{'─'.repeat(fill)}</Text>
              <Text dimColor={!isHover}>{FORGET}</Text>
            </Text>
          )
        }
        if (line.kind === 'choice') {
          return (
            <Text wrap="truncate-end">
              <Text dimColor>{CHOICE_INDENT}</Text>
              <Text color="green" bold>
                {OPEN_FILE}
              </Text>
              <Text>{GAP}</Text>
              <Text>{OPEN_FOLDER}</Text>
            </Text>
          )
        }

        // 분류 기호만 칠하고 이름은 기본색, 폴더는 뒤에 흐리게: 좁으면 폴더 쪽 끝이 잘린다
        const { item } = line
        return (
          <Text wrap="truncate-end">
            <Text color={COLORS[item.kind]} bold>
              {MARKS[item.kind]}
            </Text>
            <Text> </Text>
            <Text bold={isHover}>{item.name}</Text>
            <Text dimColor>{item.dir ? `  ${item.dir}` : ''}</Text>
          </Text>
        )
      })}
    </Box>
  )
}

export default MadeList

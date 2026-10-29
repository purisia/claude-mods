import type { ClientModule, ClientSurface } from 'claude-code'

import type { ListAct, ListProps, ListRow } from '../types'

// 파일 목록을 Client 영역에 그린다. 이 영역에서는 마우스를 눌러 끌어도 화면이 글자를 고르지 않아
// 클립보드로 복사되지 않는다. 대신 누르기·키 입력을 여기서 직접 받아 hooks 모듈에 post로 넘긴다
type State = { hover: number | null; down: number | null }

// 모양: 배경색 없이 글자색과 1칸 기호만 쓴다 (이모지는 터미널마다 폭이 달라 쓰지 않는다)
// 줄 = 거터 1칸(커서 ›) + 들여쓰기 + 이름 … + 오른쪽 끝 표시 2칸(+ 만듦, ~ 고침, • 바뀐 것을 품은 접힌 폴더)
// 고른 줄은 배경을 뒤집는다(inverse): 터미널 테마가 무엇이든 글자와 배경이 늘 대비된다
const MARKS = { new: ' +', edit: ' ~' } as const
const COLORS = { new: 'green', edit: 'yellow' } as const

// modern(opencode 식): 폴더는 흐리게, 강조색은 고른 줄에만, 이름은 칠하지 않고 오른쪽 표시 칸만 칠한다
// 고른 줄은 뒤집지 않고 강조색(/config 의 강조색, props.accent)·굵게, 들여쓰기는 깊이마다 흐린 세로줄 '│ '

// 거터 1칸 + 깊이마다 2칸 + 파일 줄은 폴더 기호 자리 2칸
function indentOf(row: ListRow): string {
  return ` ${'  '.repeat(row.depth)}${row.kind === 'dir' ? '' : '  '}`
}

// modern 들여쓰기: 깊이마다 '│ ' (폭은 classic과 같아 누르는 자리는 그대로다)
function railOf(row: ListRow): string {
  return '│ '.repeat(row.depth)
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

// 고른 줄 오른쪽 끝(표시 칸 앞)에 작게 붙는 '열기 복사' (/config 의 actionsAt이 right일 때, row.hasActions)
// 줄 = … 이름 … + ' 열기 복사' 10칸 + 표시 2칸: 들여쓰기·트리 모양은 그대로다
const OPEN = '열기'
const COPY = '복사'
const ACTIONS = ` ${OPEN} ${COPY}`

// 줄을 누르면 무엇을 할지: 폴더는 펼치거나 접으며 고르고, 파일은 고른다 (줄 어디를 눌러도 같다)
// 고른 줄 오른쪽 '열기'·'복사' 위를 누르면 그것을 한다 (columns는 목록 영역의 폭)
function actOf(row: ListRow, x: number, columns: number): ListAct | null {
  if (row.hasActions && columns > 0) {
    const open = columns - 2 - cells(ACTIONS) + 1
    const copy = open + cells(`${OPEN} `)
    if (x >= open && x < open + cells(OPEN)) return { act: 'open', path: row.id, isDir: row.kind === 'dir' }
    if (x >= copy && x < copy + cells(COPY)) return { act: 'copy', path: row.id }
  }
  if (row.kind === 'dir') return { act: 'toggle', path: row.id }
  if (row.kind === 'file') return { act: 'select', path: row.id }

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
      const act = row ? actOf(row, event.x, surface.columns) : null
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

  // 고른 줄 오른쪽의 '열기 복사': 열기는 강조색(classic 기본이면 green), 복사는 기본색, 둘 다 굵게
  const actions = (row: ListRow) =>
    row.hasActions ? (
      <Text>
        <Text> </Text>
        <Text color={props.accent || 'green'} bold>
          {OPEN}
        </Text>
        <Text> </Text>
        <Text bold>{COPY}</Text>
      </Text>
    ) : null

  if (props.look === 'modern') {
    return (
      <Box flexDirection="column">
        {props.rows.map((row, i) => {
          const isHover = i === state?.hover
          const isSelected = row.isSelected === true
          if (row.kind === 'note') {
            return (
              <Text wrap="truncate-end">
                <Text dimColor>{` ${railOf(row)}  `}</Text>
                <Text dimColor italic>
                  {row.label}
                </Text>
              </Text>
            )
          }
          const mark = row.mark ? (
            <Text color={COLORS[row.mark]} bold>
              {row.kind === 'dir' ? ' •' : MARKS[row.mark]}
            </Text>
          ) : (
            <Text>{'  '}</Text>
          )
          const lead = row.kind === 'dir' ? caretOf(row) : '  '
          // 폴더는 흐리게, 파일은 기본색, 고른 줄만 강조색·굵게, 마우스를 올린 줄은 굵게
          const name = row.kind === 'dir' ? `${row.label}/` : row.label

          return (
            <Box width="100%">
              <Box flexGrow={1} flexShrink={1}>
                <Text wrap="truncate-end">
                  <Text dimColor>{` ${railOf(row)}${lead}`}</Text>
                  <Text
                    {...(isSelected ? { color: props.accent } : {})}
                    dimColor={row.kind === 'dir' && !isSelected && !isHover}
                    bold={isSelected || isHover}
                  >
                    {name}
                  </Text>
                  {row.detail ? <Text dimColor>{`  ${row.detail}`}</Text> : null}
                </Text>
              </Box>
              {actions(row)}
              {mark}
            </Box>
          )
        })}
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      {props.rows.map((row, i) => {
        const isHover = i === state?.hover
        // 거터 1칸은 비워 둔다 (커서 표시는 그리지 않는다. 고른 줄은 거터 뒤부터 뒤집는다)
        const gutter = <Text> </Text>
        const indent = indentOf(row).slice(1)
        const isSelected = row.isSelected === true
        // 고른 줄은 오른쪽 표시 칸 앞까지 빈칸을 채워 줄 전체가 뒤집혀 보이게 한다 (처음 그릴 때는 폭을 몰라 채우지 않는다)
        // 오른쪽에 '열기 복사'가 붙은 줄은 그 폭만큼 덜 채운다
        const fill = (text: string) =>
          isSelected
            ? ' '.repeat(Math.max(0, surface.columns - cells(` ${text}`) - 2 - (row.hasActions ? cells(ACTIONS) : 0)))
            : ''

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

        // 마우스를 올린 줄은 이름을 굵게
        if (row.kind === 'dir') {
          const name = `${row.label}/`
          return (
            <Box width="100%">
              <Box flexGrow={1} flexShrink={1}>
                <Text wrap="truncate-end">
                  {gutter}
                  <Text inverse={isSelected}>
                    <Text>{indent}</Text>
                    <Text dimColor={!isSelected}>{caretOf(row)}</Text>
                    <Text color={props.accent || 'cyan'} bold={isHover}>
                      {name}
                    </Text>
                    <Text>{fill(indent + caretOf(row) + name)}</Text>
                  </Text>
                </Text>
              </Box>
              {actions(row)}
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
                <Text inverse={isSelected}>
                  <Text>{indent}</Text>
                  <Text color={row.mark ? COLORS[row.mark] : undefined} bold={isHover}>
                    {row.label}
                  </Text>
                  <Text>{fill(indent + row.label)}</Text>
                </Text>
              </Text>
            </Box>
            {actions(row)}
            {mark}
          </Box>
        )
      })}
    </Box>
  )
}

// 리스너가 읽는 마지막 props (모듈은 인스턴스 하나만 그린다)
let latest: ListProps = { rows: [], look: 'modern', accent: 'suggestion' }

export default TreeList

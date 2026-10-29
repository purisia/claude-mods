// 폴더 하나의 목록: 폴더 먼저, 이름순
export type Entry = { name: string; isDir: boolean }

// Claude가 손댄 파일: 새로 만들었는지(new), 있던 것을 고쳤는지(edit)
export type TouchKind = 'new' | 'edit'
export type Touched = { path: string; kind: TouchKind }

// 목록(Client 영역)의 한 줄. id는 프로젝트 루트 기준 경로
// dir: 폴더(누르면 펼치거나 접고 고른다), file: 파일(누르면 고른다), note: 안내 글
// 고른 줄은 배경을 뒤집어 그리고, 열기·경로 복사는 검색칸 아래 액션 줄에서 한다
export type ListRow = {
  id: string
  kind: 'dir' | 'file' | 'note'
  depth: number
  label: string
  isOpen?: boolean
  isSelected?: boolean
  // Claude가 방금 만든 파일(new)이나 고친 파일(edit)
  mark?: TouchKind
}

// 목록이 hooks 모듈에 보내는 요청
export type ListAct = { act: 'toggle' | 'select'; path: string }

// 목록 영역이 받는 props
export type ListProps = { rows: ListRow[] }

// 최근 작업 파일 영역(made-list.tsx)이 받는 props와 보내는 요청.
// name은 파일 이름, dir은 뒤에 흐리게 붙일 폴더(프로젝트 안이면 루트 기준, 밖이면 끝 두 단계),
// picking은 파일 보기·폴더 보기를 펼쳐 둔 파일
export type MadeItem = { path: string; kind: TouchKind; name: string; dir: string }
export type MadeProps = { items: MadeItem[]; picking: string | null }
export type MadeAct = { act: 'pick' | 'file' | 'folder' | 'copy'; path: string } | { act: 'forget' }

declare module 'claude-code' {
  interface PluginState {
    'project-tree': {
      // 펼친 폴더의 경로 (프로젝트 루트 기준, 루트는 '')
      opened: string[]
      // 읽어 둔 폴더 목록, 경로별
      listings: Record<string, Entry[]>
      // 검색어, 비어 있으면 트리를 보여 준다
      query: string
      // ✕로 검색칸을 비운 횟수: 검색칸 key에 붙여 빈 필드로 새로 그린다
      resets: number
      // 검색용 전체 파일 경로, 아직 안 만들었으면 null
      index: string[] | null
      // Claude가 새로 만들거나 고친 파일(절대 경로), 최근 것부터
      recent: Touched[]
      // 목록에서 고른 파일·폴더 (프로젝트 루트 기준), 없으면 null
      selected: string | null
      // 최근 작업 파일 중 파일 보기·폴더 보기를 펼쳐 둔 것 (절대 경로)
      choosing: string | null
      // 최근 작업 파일에 남겨 둘 개수 (/config 의 recentLimit)
      recentLimit: number
    }
  }
}

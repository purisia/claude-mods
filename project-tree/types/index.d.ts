// 폴더 하나의 목록: 폴더 먼저, 이름순
export type Entry = { name: string; isDir: boolean }

// 목록(Client 영역)의 한 줄. id는 프로젝트 루트 기준 경로
// dir: 폴더(누르면 펼치기, 오른쪽 📂는 탐색기), file: 연결 프로그램으로 여는 파일, plain: 그 밖의 파일,
// confirm: file 아래에 끼우는 '열까요?' 줄, note: 안내 글
export type ListRow = {
  id: string
  kind: 'dir' | 'file' | 'plain' | 'confirm' | 'note'
  depth: number
  label: string
  isOpen?: boolean
  isNew?: boolean
}

// 목록이 hooks 모듈에 보내는 요청
export type ListAct = { act: 'toggle' | 'ask' | 'confirm' | 'cancel' | 'folder'; path: string }

// 목록 영역이 받는 props: focus는 커서를 옮겨 둘 줄의 id
export type ListProps = { rows: ListRow[]; focus: string | null }

declare module 'claude-code' {
  interface PluginState {
    'project-tree': {
      // 패널 전체를 접었는지
      isFolded: boolean
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
      // Claude가 새로 만든 파일의 절대 경로, 최근 것부터
      recent: string[]
      // 열지 묻고 있는 파일 (프로젝트 루트 기준), 없으면 null
      pending: string | null
      // 누르면 여는 파일의 확장자 (점 없이 소문자)
      extensions: string[]
      // 설정 화면을 보고 있는지
      isSettings: boolean
    }
  }
}

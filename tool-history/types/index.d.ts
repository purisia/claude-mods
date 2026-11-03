// run: 실행 중 · ok: 성공 · error: 도구가 오류를 냄 · deny: 권한·훅이 막음
export type Status = 'run' | 'ok' | 'error' | 'deny'

// prompt: 사용자가 보낸 요청 · command: 슬래시 명령 · tool: Claude가 부른 도구
export type Kind = 'prompt' | 'command' | 'tool'

export type Entry = {
  id: string
  kind: Kind
  // 도구 이름 (명령은 '/doctor'처럼 슬래시 포함, 요청은 'prompt')
  tool: string
  // 업무 언어로 쓴 한 줄: '스킬 cafe24-jira-wiki · get DIGITALINFRA-7687', 'git 커밋: …'
  title: string
  // 펼쳤을 때 보이는 원문 (명령 전체, 경로 전체 등)
  detail: string
  // 사용자가 알아야 할 작업인지 (false면 파일 읽기·검색 같은 내부 동작: 전체 보기에서만)
  isWork: boolean
  status: Status
  // 서브에이전트 안에서 부른 호출이면 그 에이전트 id
  agent?: string
  // live: mod가 켜진 뒤 직접 잰 호출 (시각·소요시간 있음) · transcript: 대화 기록에서 읽어 온 호출
  source: 'live' | 'transcript'
  startedAt?: number
  ms?: number
  // 실패·거부 사유 (앞부분만)
  note?: string
}

declare module 'claude-code' {
  interface PluginState {
    'tool-history': {
      entries: Shaped<Entry[]>
      showAll: boolean
      // 기본 펼침/접힘을 사람이 뒤집은 요청 묶음 id
      toggled: string[]
      expanded: string | null
      isLoading: boolean
    }
  }
}

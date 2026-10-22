import { atom, read, update } from 'claude-code'
import type { Register, SessionRateLimit, StateDollar } from 'claude-code'

import type { Effort } from '../types'

// 값이 바뀔 때마다 올려서 band를 다시 그리게 하는 신호
const tick = atom({ plugin: 'taxi-meter', key: 'tick' } as const, 0)
// 메인 대화가 마지막 요청에 실은 effort
const effort = atom({ plugin: 'taxi-meter', key: 'effort' } as const, null)
// /taxi 로 이 세션에서만 켜고 끈다
const isOn = atom({ plugin: 'taxi-meter', key: 'isOn' } as const, true)

// 컨텍스트가 이 비율을 넘으면 '할증' 등이 켜진다
const SURCHARGE_PERCENT = 80
const GAUGE = 10
const FUEL = 8
const DEFAULT_RATE = 1400

const GEARS: Record<string, number> = { low: 1, medium: 2, high: 3, xhigh: 4, max: 5 }
const WINDOWS: Record<string, string> = { five_hour: '5h', seven_day: '7d' }
const DAYS = ['일', '월', '화', '수', '목', '금', '토']

// 일반택시는 노랑, Fable은 검정 바탕에 금색인 모범택시
const THEMES = {
  taxi: { name: '🚕 CLAUDE TAXI', accent: 'yellow', border: 'yellow', body: undefined },
  deluxe: { name: '🚖 모범택시 DELUXE', accent: '#D4AF37', border: '#D4AF37', body: 'black' },
} as const

// claude-opus-5-5[1m] → Opus 5.5 1M
function carName(id: string): string {
  const m = /claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?/i.exec(id)
  if (!m) return id
  const [, family, major, minor, big] = m

  return `${family[0].toUpperCase()}${family.slice(1)} ${minor ? `${major}.${minor}` : major}${big ? ' 1M' : ''}`
}

function km(tokens: number): string {
  if (tokens >= 1_000_000) return `${+(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${+(tokens / 1_000).toFixed(1)}k`

  return String(tokens)
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

// 5h는 시:분, 7d는 월/일(요일)
function resetLabel(limit: SessionRateLimit): string {
  if (!limit.resetsAt) return ''
  const d = new Date(limit.resetsAt)
  if (Number.isNaN(d.getTime())) return ''
  if (limit.kind === 'five_hour') return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`

  return `${d.getMonth() + 1}/${d.getDate()}(${DAYS[d.getDay()]})`
}

function bump($: StateDollar) {
  return update($, tick, n => n + 1)
}

// 행선지 = 프로젝트(저장소 루트 폴더명), 노선 = 브랜치
type Place = { project: string; branch: string | null }

function baseName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path
}

async function git($: StateDollar, args: string[]): Promise<string> {
  try {
    const { exitCode, stdout } = await $.process.run(['git', ...args], { timeoutMs: 3000 })

    return exitCode === 0 ? stdout.trim() : ''
  } catch {
    return ''
  }
}

async function loadPlace($: StateDollar): Promise<Place> {
  const repo = await $.session.repo().catch(() => null)
  const project = baseName(repo?.root ?? (await $.session.root().catch(() => '')))
  if (!repo) return { project, branch: null }

  // 브랜치가 없으면(detached HEAD) 짧은 커밋 해시
  const branch = (await git($, ['branch', '--show-current'])) || (await git($, ['rev-parse', '--short', 'HEAD']))

  return { project, branch: branch || null }
}

export const register: Register = (on, options) => {
  const rate = Number(options.krwPerUsd) > 0 ? Number(options.krwPerUsd) : DEFAULT_RATE
  // 그릴 때마다 git을 돌리지 않도록 세션 시작·턴 끝에서만 새로 읽는다
  let place: Place | undefined

  on('session.start', async ($, e, next) => {
    place = await loadPlace($)
    await $.command.register({
      name: 'taxi',
      description: '택시미터 켜기·끄기 (/taxi on, /taxi off, 그냥 /taxi 는 전환)',
    })
    await $.command.register({
      name: 'taxi-rate',
      description: '택시미터 환율 보기·바꾸기 (예: /taxi-rate 1385)',
    })
    await bump($)

    return next(e)
  })

  on('command.run', { command: 'taxi' }, async ($, e) => {
    const arg = String(e.args ?? '').trim().toLowerCase()
    const want = arg === 'on' ? true : arg === 'off' ? false : !(await read($, isOn))
    await update($, isOn, () => want)

    return { text: want ? '🚕 택시미터를 켰습니다.' : '택시미터를 껐습니다. (/taxi on 으로 다시 켜기)' }
  })

  on('command.run', { command: 'taxi-rate' }, async ($, e) => {
    const arg = String(e.args ?? '').replace(/[,원\s]/g, '')
    if (arg === '') return { text: `현재 환율: 1달러 = ${rate.toLocaleString('ko-KR')}원 (바꾸기: /taxi-rate 1385)` }

    const value = Number(arg)
    if (!Number.isFinite(value) || value <= 0) return { text: `환율은 양수로 입력해 주세요: /taxi-rate 1385` }

    const { deny } = await $.config.set({ key: 'taxi-meter.krwPerUsd', value })
    if (deny) return { text: `환율을 바꾸지 못했습니다: ${deny}` }

    return { text: `환율을 1달러 = ${value.toLocaleString('ko-KR')}원으로 바꿨습니다.` }
  })

  on('session.measure', async ($, e, next) => {
    await bump($)

    return next(e)
  })

  // 서브에이전트의 요청은 빼고 메인 대화의 effort만 기록한다
  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) {
      const level: Effort = e.effort === undefined ? null : String(e.effort)
      if ((await read($, effort)) !== level) await update($, effort, () => level)
    }

    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (!e.agentId) place = await loadPlace($)
    await bump($)

    return done
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, isOn))) return next(e)

    await read($, tick)
    if (!place) place = await loadPlace($)
    const level = await read($, effort)
    const [usage, model] = await Promise.all([$.session.usage(), $.session.model()])
    const { Box, Text } = $.ui.resolve(e)

    const theme = /fable/i.test(model) ? THEMES.deluxe : THEMES.taxi
    const usd = usage.cost?.usd ?? 0
    // 실제 미터기처럼 100원 단위로 올라간다
    const fare = Math.floor((usd * rate) / 100) * 100
    const { tokens, window, percent } = usage.context
    const filled = Math.min(GAUGE, Math.round(((percent ?? 0) / 100) * GAUGE))
    const isDriving = e.props.isWorking
    const isSurcharge = (percent ?? 0) >= SURCHARGE_PERCENT
    const limits = usage.rateLimits.filter(one => WINDOWS[one.kind])
    const gear = level === null ? 0 : (GEARS[level] ?? 0)

    const lamps = (
      <Text>
        <Text backgroundColor={isDriving ? undefined : 'red'} color={isDriving ? 'gray' : 'white'} bold={!isDriving}>
          {' 빈차 '}
        </Text>
        <Text> </Text>
        <Text backgroundColor={isDriving ? 'green' : undefined} color={isDriving ? 'black' : 'gray'} bold={isDriving}>
          {isDriving ? ' 🐎주행 ' : ' 주행 '}
        </Text>
        <Text> </Text>
        <Text backgroundColor={isSurcharge ? 'red' : undefined} color={isSurcharge ? 'white' : 'gray'} bold={isSurcharge}>
          {' 할증 '}
        </Text>
      </Text>
    )

    const header = (
      <Text wrap="truncate-end">
        <Text color={theme.accent} bold>
          {`${theme.name} `}
        </Text>
        <Text color="gray">│ 차종 </Text>
        <Text color={theme.body ? theme.accent : undefined} bold>
          {carName(model)}
        </Text>
        <Text color="gray"> │ 엔진 </Text>
        {level === null ? (
          <Text dimColor>—</Text>
        ) : (
          <Text>
            <Text bold>{`${level} `}</Text>
            <Text color={theme.accent}>{'●'.repeat(gear)}</Text>
            <Text color="gray">{'○'.repeat(gear ? 5 - gear : 0)}</Text>
          </Text>
        )}
      </Text>
    )

    const meter = (
      <Text wrap="truncate-end">
        <Text color={theme.accent}>요금 </Text>
        <Text backgroundColor="black" color="redBright" bold>
          {` ₩ ${fare.toLocaleString('ko-KR').padStart(7)} `}
        </Text>
        <Text dimColor>{` $${usd.toFixed(2)} @${rate.toLocaleString('ko-KR')}원 `}</Text>
        <Text color="gray">│ </Text>
        <Text color={theme.accent}>거리 </Text>
        <Text>{tokens === undefined ? '—' : km(tokens)}</Text>
        <Text dimColor>{`/${km(window)} `}</Text>
        <Text color={isSurcharge ? 'red' : 'green'}>{'▰'.repeat(filled)}</Text>
        <Text color="gray">{'▱'.repeat(GAUGE - filled)}</Text>
        <Text>{` ${percent ?? 0}%`}</Text>
      </Text>
    )

    // 사용 한도는 남은 양을 연료 게이지로
    const fuel =
      limits.length === 0 ? null : (
        <Text wrap="truncate-end">
          <Text color={theme.accent}>연료 </Text>
          {limits.map((one, i) => {
            const left = Math.max(0, Math.min(100, 100 - one.percentUsed))
            const bars = Math.round((left / 100) * FUEL)
            const color = left < 20 ? 'red' : left < 50 ? 'yellow' : 'green'

            return (
              <Text key={one.kind}>
                {i > 0 ? <Text color="gray"> │ </Text> : null}
                <Text bold>{`${WINDOWS[one.kind]} `}</Text>
                <Text color="gray">E</Text>
                <Text color={color}>{'▮'.repeat(bars)}</Text>
                <Text color="gray">{'▯'.repeat(FUEL - bars)}</Text>
                <Text color="gray">F</Text>
                <Text>{` ${Math.round(left)}% `}</Text>
                <Text dimColor>{resetLabel(one)}</Text>
              </Text>
            )
          })}
        </Text>
      )

    const route = (
      <Text wrap="truncate-end">
        <Text color={theme.accent}>행선지 </Text>
        <Text bold>{place.project}</Text>
        {place.branch ? (
          <Text>
            <Text color="gray"> ⎇ </Text>
            <Text color="cyan">{place.branch}</Text>
          </Text>
        ) : null}
      </Text>
    )

    // 테두리 2줄 + 머리줄 + 요금줄 + 연료줄 + 행선지줄
    const rows = 5 + (fuel ? 1 : 0)
    if (e.props.maxRows < rows) {
      return (
        <Box>
          <Text wrap="truncate-end">
            <Text color={theme.accent}>{theme.name.slice(0, 2)} </Text>
            <Text bold>{carName(model)} </Text>
          </Text>
          {meter}
        </Box>
      )
    }

    return (
      <Box
        borderStyle="round"
        borderColor={theme.border}
        backgroundColor={theme.body}
        flexDirection="column"
        paddingX={1}
      >
        <Box justifyContent="space-between">
          {header}
          {lamps}
        </Box>
        {meter}
        {fuel}
        {route}
      </Box>
    )
  })
}

import { expect, test } from 'claude-code/testing'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: true, maxRows: 20 } } as const

const USAGE = {
  startedAt: 0,
  context: { tokens: 850_000, window: 1_000_000, percent: 85 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 38, resetsAt: '2026-10-07T15:20:00+09:00' },
    { kind: 'seven_day', percentUsed: 70, resetsAt: '2026-10-09T09:00:00+09:00' },
  ],
  cost: { usd: 8.79 },
}

test('모델·요금·환율·컨텍스트·연료가 미터기에 찍힌다', { options: { krwPerUsd: 1400 } }, async ($, on) => {
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: USAGE }))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'taxi-meter', surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: /CLAUDE TAXI/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Opus 5\.5/ })).toBeDefined()
    // 8.79 × 1400 = 12,306 → 100원 단위 12,300
    expect(await ui.find({ type: 'Text', text: /12,300/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /@1,400원/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /850k/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /5h/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: / 62% / })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: / 30% / })).toBeDefined()
    await ui.unmount()
  }
})

test('Fable은 모범택시로 달린다', async ($, on) => {
  on('session.model', () => ({ value: 'claude-fable-5-1' }))
  on('session.usage', () => ({ value: { ...USAGE, rateLimits: [] } }))

  const ui = await $.ui.mount({ plugin: 'taxi-meter', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /모범택시/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Fable 5\.1/ })).toBeDefined()
  await ui.unmount()
})

test('/taxi off 하면 미터기가 사라지고 on 하면 돌아온다', async ($, on) => {
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: USAGE }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })

  await $.command.run({ command: 'taxi', args: 'off' })
  let ui = await $.ui.mount({ plugin: 'taxi-meter', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /CLAUDE TAXI/ })).toBeUndefined()
  await ui.unmount()

  await $.command.run({ command: 'taxi', args: 'on' })
  ui = await $.ui.mount({ plugin: 'taxi-meter', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /CLAUDE TAXI/ })).toBeDefined()
  await ui.unmount()
})

test('행선지에 프로젝트와 브랜치가 찍힌다', async ($, on) => {
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: USAGE }))
  on('session.repo', () => ({
    value: { root: 'D:\_code\O-MI-INFRA2-agi-cylim', remote: null, internal: false, name: null },
  }))
  on('process.run', ($, e) => ({
    value: {
      exitCode: 0,
      stdout: e.argv.includes('--show-current') ? 'master\n' : '',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'taxi-meter', surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: /O-MI-INFRA2-agi-cylim/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^master$/ })).toBeDefined()
    await ui.unmount()
  }
})

test('git 저장소 밖이면 프로젝트만 찍힌다', async ($, on) => {
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { ...USAGE, rateLimits: [] } }))
  on('session.repo', () => ({ value: null }))
  on('session.root', () => ({ value: '/home/me/notes/' }))

  const ui = await $.ui.mount({ plugin: 'taxi-meter', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /^notes$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: / ⎇ / })).toBeUndefined()
  await ui.unmount()
})

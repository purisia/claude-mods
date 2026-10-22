export type Tick = number
export type Effort = string | null

declare module 'claude-code' {
  interface PluginState {
    'taxi-meter': { tick: Tick; effort: Effort; isOn: boolean }
  }
}

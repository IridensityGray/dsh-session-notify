/**
 * Host half of the session-notify bundle.
 *
 * This plugin watches every Session directly on the Host, so a reminder never
 * depends on a browser page, an HTTP round-trip, or a command channel: the
 * Host sees the durable events as they are appended and reacts to them.
 *
 * Reminder kinds: a turn finished, a question awaits an answer, an approval
 * awaits a decision, a turn failed, a turn was interrupted, or a conversation
 * has been idle for a while.
 *
 * Delivery is a Windows notification plus an audible chime. Only the display
 * text and switches travel; no Session data is written.
 */

import { spawn } from 'node:child_process'
import { existsSync, copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, basename } from 'node:path'

/** Plugin name, used to document the row in the profile patch. */
export const name = 'session-notify'

/** `sessionProjections` is optional; the rest is plain Host event observation. */
export const inject = []

/** Reminder kinds and their display labels. */
const LABELS = {
  question: '等你选择',
  approval: '等你授权',
  completed: '已完成',
  failed: '出错',
  interrupted: '已中断',
  idle: '等你输入',
}

/** Accent colour per kind, used by the notification title. */
const COLORS = {
  question: '#2F6FEB',
  approval: '#D97706',
  completed: '#16A34A',
  failed: '#DC2626',
  interrupted: '#D97706',
  idle: '#5F6672',
}

/** Session whose events are tracked: the derived state the decisions need. */
function createState() {
  return {
    turn: 0,
    runningTurn: false,
    pendingApproval: null,
    questions: new Map(),
    failed: false,
    lastUserText: '',
    assistantText: '',
    idleTimer: null,
    announced: new Set(),
  }
}

/**
 * Turn one text line into a PowerShell single-quoted literal.
 * @param {string} text - raw text.
 * @returns the quoted literal.
 */
function psLiteral(text) {
  return `'${String(text).replaceAll("'", "''")}'`
}

/** Escape text for the toast XML payload. */
function xmlText(text) {
  return String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/** Clip display text on one line. */
function clip(text, limit) {
  const flat = String(text ?? '').replace(/\s+/gu, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat
}

/** First text block of a recorded message content array. */
function textOf(content) {
  if (!Array.isArray(content)) return ''
  const block = content.find(item => item !== null && typeof item === 'object' && item.type === 'text')
  return typeof block?.text === 'string' ? block.text : ''
}

/**
 * Run one hidden PowerShell helper.
 * @param {string[]} lines - script lines.
 * @param {number} timeoutMs - hard deadline.
 * @returns exit success and the first error or output line.
 */
async function runPowerShell(lines, timeoutMs) {
  const encoded = Buffer.from(lines.join('\n'), 'utf16le').toString('base64')
  const child = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded,
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  return await new Promise((resolve) => {
    let output = ''
    let failure = ''
    let settled = false
    const finish = (ok, detail) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok, detail })
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(false, 'helper timed out')
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { output += String(chunk) })
    child.stderr.on('data', (chunk) => { failure += String(chunk) })
    child.on('error', (error) => { finish(false, error.message) })
    child.on('close', (code) => { finish(code === 0, (failure.trim() || output.trim()).slice(0, 400)) })
  })
}

/**
 * Whether the Harness window is currently in the foreground.
 *
 * The Host has no browser API for this, so it asks Windows for the foreground
 * window's title. A missing answer reads as "not in front", because a reminder
 * that is too eager is less harmful than one that never shows.
 * @returns true when the foreground window looks like Harness.
 */
async function isHarnessInFront() {
  if (process.platform !== 'win32') return false
  const script = [
    '$ErrorActionPreference = "SilentlyContinue"',
    'Add-Type -Language CSharp @"',
    'using System;',
    'using System.Text;',
    'using System.Runtime.InteropServices;',
    'public class HNForeground {',
    '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
    '  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);',
    '  public static string Title() {',
    '    var h = GetForegroundWindow();',
    '    var sb = new StringBuilder(512);',
    '    GetWindowText(h, sb, sb.Capacity);',
    '    return sb.ToString();',
    '  }',
    '}',
    '"@',
    'Write-Output ([HNForeground]::Title())',
  ]
  const result = await runPowerShell(script, 8_000)
  const title = (result.detail || '').toLowerCase()
  return title.includes('harness') || title.includes('deepseek')
}

/**
 * Copy a chime WAV next to the notification identity, once.
 * @param {string} dir - folder that holds the notification identity.
 * @returns the absolute WAV path, or an empty string when none was found.
 */
function ensureChimeFile(dir) {
  const target = join(dir, 'harness-notify.wav')
  if (existsSync(target)) return target
  const windir = process.env.WINDIR ?? 'C:\\Windows'
  const candidates = [
    join(windir, 'Media', 'Windows Notify System Generic.wav'),
    join(windir, 'Media', 'Windows Notify.wav'),
    join(windir, 'Media', 'Windows Ding.wav'),
    join(windir, 'Media', 'Alarm01.wav'),
  ]
  for (const source of candidates) {
    if (!existsSync(source)) continue
    try {
      copyFileSync(source, target)
      return target
    } catch { /* try the next candidate */ }
  }
  return ''
}

/** Folder holding the Start-menu shortcut that gives the toast its identity. */
function identityFolder() {
  const base = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
  return join(base, 'Microsoft', 'Windows', 'Start Menu', 'Programs')
}

/**
 * Create the Start-menu shortcut that gives Windows an identity for the toast.
 * @param {string} shortcutPath - absolute `.lnk` path.
 * @returns true when the shortcut exists afterwards.
 */
async function ensureShortcut(shortcutPath) {
  const script = [
    '$ErrorActionPreference = "Stop"',
    `$lnk = ${psLiteral(shortcutPath)}`,
    'if (-not (Test-Path -LiteralPath (Split-Path -Parent $lnk))) {',
    '  New-Item -ItemType Directory -Path (Split-Path -Parent $lnk) -Force | Out-Null',
    '}',
    'if (-not (Test-Path -LiteralPath $lnk)) {',
    '  $shell = New-Object -ComObject WScript.Shell',
    '  $link = $shell.CreateShortcut($lnk)',
    `  $link.TargetPath = ${psLiteral(process.execPath)}`,
    '  $link.Arguments = "--window-position-marker"',
    '  $link.WorkingDirectory = (Split-Path -Parent $lnk)',
    '  $link.Description = "Harness notifications"',
    '  $link.Save()',
    '}',
    'Write-Output "ok"',
  ]
  const result = await runPowerShell(script, 20_000)
  return result.ok
}

/**
 * Show one notification that stays in the notification centre.
 * @param {string} title - first text line.
 * @param {string} body - second text line.
 * @returns the WinRT failure text, or an empty string on success.
 */
async function showNotification(title, body) {
  const folder = identityFolder()
  const shortcut = join(folder, 'Harness Notify.lnk')
  if (!(await ensureShortcut(shortcut))) return '无法创建通知快捷方式'
  const payload = '<toast scenario="reminder"><visual><binding template="ToastGeneric">'
    + `<text>${xmlText(title)}</text><text>${xmlText(body)}</text>`
    + '</binding></visual><audio silent="true" /></toast>'
  const script = [
    '$ErrorActionPreference = "Stop"',
    'try {',
    '  [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]',
    '  [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]',
    '  $xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
    `  $xml.LoadXml(${psLiteral(payload)})`,
    '  $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)',
    `  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(${psLiteral(shortcut.slice(0, -4))}).Show($toast)`,
    '  Write-Output "ok"',
    '} catch {',
    '  Write-Output ("err: " + $_.Exception.Message)',
    '  exit 3',
    '}',
  ]
  const result = await runPowerShell(script, 20_000)
  if (result.ok) return ''
  return result.detail.replace(/^err:\s*/u, '') || 'toast failed'
}

/**
 * Play the chime through `winmm.dll` `PlaySoundW`.
 *
 * Synchronous on purpose: this Host process outlives the call, and an
 * asynchronous play would be cut off when the helper spawns and exits around
 * it. `SND_SYSTEM` keeps a per-application volume from muting the reminder.
 * @param {string} wav - absolute WAV path.
 * @returns an empty string when the system accepted the sound.
 */
async function playChime(wav) {
  const script = [
    '$ErrorActionPreference = "Stop"',
    'Add-Type -Language CSharp @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public class HarnessNotifyPlay {',
    '  [DllImport("winmm.dll", EntryPoint = "PlaySoundW", CharSet = CharSet.Unicode, SetLastError = true)]',
    '  public static extern bool PlaySound(string sound, IntPtr module, uint flags);',
    '}',
    '"@',
    `$wav = ${psLiteral(wav)}`,
    'if (-not (Test-Path -LiteralPath $wav)) { Write-Output "err: WAV not found"; exit 4 }',
    '$flags = 0x00020000 -bor 0x00000002 -bor 0x00200000',
    '$ok = [HarnessNotifyPlay]::PlaySound($wav, [IntPtr]::Zero, $flags)',
    'Start-Sleep -Milliseconds 200',
    'if ($ok) { Write-Output "ok" } else { Write-Output "err: PlaySound returned false"; exit 3 }',
  ]
  const result = await runPowerShell(script, 20_000)
  return result.ok ? '' : (result.detail || 'sound failed')
}

/**
 * Register the reminder watcher.
 * @param {any} ctx - the Host plugin context.
 * @param {{ completed?: boolean, question?: boolean, approval?: boolean, failed?: boolean, interrupted?: boolean, idle?: boolean, idleMinutes?: number, whenPresent?: boolean }} rawConfig - reminder switches.
 */
export function apply(ctx, rawConfig = {}) {
  const config = {
    completed: rawConfig.completed ?? true,
    question: rawConfig.question ?? true,
    approval: rawConfig.approval ?? true,
    failed: rawConfig.failed ?? true,
    interrupted: rawConfig.interrupted ?? true,
    idle: rawConfig.idle ?? true,
    idleMinutes: rawConfig.idleMinutes ?? 5,
    // Send reminders even while the Harness window is in front.
    whenPresent: rawConfig.whenPresent ?? true,
  }
  const states = new Map()
  let ready = false

  /** Title of a Session for display: its durable title, else its folder name. */
  function titleOf(session, state) {
    try {
      const titled = ctx.get('sessionTitle')?.get?.(session)
      if (titled !== undefined && typeof titled.title === 'string' && titled.title.trim() !== '') {
        return clip(titled.title, 60)
      }
    } catch { /* title service is optional */ }
    const cwd = session?.header?.cwd
    if (typeof cwd === 'string' && cwd !== '') {
      const name = basename(cwd.replaceAll('/', '\\'))
      if (name !== '') return clip(name, 60)
    }
    return state.lastUserText === '' ? 'Harness 会话' : clip(state.lastUserText, 48)
  }

  /** Compose the notification body for one kind. */
  function bodyOf(kind, state, extra) {
    if (kind === 'question') {
      const first = [...state.questions.values()][0]
      return clip(first?.question || '有新的问题等你回答', 150)
    }
    if (kind === 'approval') {
      const tool = state.pendingApproval?.toolName
      return `等待你批准${typeof tool === 'string' && tool !== '' ? ` ${tool}` : '一次操作'}`
    }
    if (kind === 'failed') {
      const detail = extra?.error?.message ?? extra?.error?.code ?? '本轮执行出错'
      return clip(String(detail), 150)
    }
    if (kind === 'interrupted') return clip(state.assistantText, 150) || '这一轮被中断了。'
    if (kind === 'idle') {
      return state.lastUserText === '' ? '会话已空闲，等待你的输入。' : clip(`待处理：${state.lastUserText}`, 150)
    }
    return clip(state.assistantText, 150) || '这一轮已经完成，等你下一步。'
  }

  /**
   * Announce one reminder, at most once per turn and kind.
   * @param {Session} session - the Session the reminder is about.
   * @param {string} kind - reminder kind.
   * @param {object} [extra] - failure details for `failed`.
   */
  function announce(session, kind, extra) {
    if (config[kind] !== true) return
    const id = String(session?.header?.id ?? session?.id ?? '')
    const state = states.get(id) ?? createState()
    states.set(id, state)
    // A page-free Host still should not replay history as fresh reminders.
    if (!ready && kind !== 'question' && kind !== 'approval') return
    const stamp = `${kind}|${state.turn}`
    if (state.announced.has(stamp)) return
    state.announced.add(stamp)
    if (state.announced.size > 200) state.announced.clear()

    const title = titleOf(session, state)
    const body = bodyOf(kind, state, extra)
    const line = `${LABELS[kind]} · ${title}`
    void deliver(line, body)
  }

  /** Deliver one reminder: notification plus chime. */
  async function deliver(title, body) {
    try {
      if (!config.whenPresent && await isHarnessInFront()) return
      const results = await Promise.all([
        showNotification(title, body),
        (async () => {
          const chime = ensureChimeFile(identityFolder())
          return chime === '' ? '找不到提示音文件' : playChime(chime)
        })(),
      ])
      const errors = results.filter(text => text !== '')
      if (errors.length > 0) ctx.logger?.warn?.(`session-notify: ${errors.join('; ')}`)
    } catch (error) {
      ctx.logger?.warn?.(`session-notify: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Restart the idle timer of one Session. */
  function armIdle(session, state) {
    if (state.idleTimer !== null) clearTimeout(state.idleTimer)
    state.idleTimer = null
    if (!config.idle) return
    const minutes = Number(config.idleMinutes)
    if (!Number.isFinite(minutes) || minutes <= 0) return
    state.idleTimer = setTimeout(() => {
      state.idleTimer = null
      if (state.runningTurn) return
      state.turn += 1
      announce(session, 'idle')
    }, Math.min(minutes, 120) * 60_000)
    state.idleTimer.unref?.()
  }

  // ---- event folding ----------------------------------------------------
  ctx.on('session/event', (session, event) => {
    const id = String(session?.header?.id ?? session?.id ?? '')
    const state = states.get(id) ?? createState()
    states.set(id, state)
    const data = event?.data ?? {}
    switch (event?.type) {
      case 'turn/start':
        state.turn = Number(data.turn ?? state.turn + 1)
        state.runningTurn = true
        state.failed = false
        state.assistantText = ''
        if (state.idleTimer !== null) {
          clearTimeout(state.idleTimer)
          state.idleTimer = null
        }
        return
      case 'assistant/message':
        state.assistantText = textOf(data.message?.content)
        return
      case 'user/message': {
        const text = textOf(data.content)
        if (text !== '') state.lastUserText = text
        if (state.idleTimer !== null) {
          clearTimeout(state.idleTimer)
          state.idleTimer = null
        }
        return
      }
      case 'tool/call':
        if (data.name === 'ask_user_question') {
          const args = (() => {
            try { return JSON.parse(data.arguments) } catch { return undefined }
          })()
          const first = args?.questions?.[0]
          state.questions.set(data.callId, { question: clip(first?.question ?? first?.header ?? '', 150) })
          announce(session, 'question')
        }
        return
      case 'tool/result':
        // A answered or abandoned question leaves the pending set; the turn-end
        // or the next event reports the outcome, so nothing is announced here.
        state.questions.delete(data.message?.toolCallId)
        return
      case 'approval/asked':
        state.pendingApproval = { id: data.id, toolName: data.toolName }
        announce(session, 'approval')
        return
      case 'approval/decided':
        if (state.pendingApproval !== null && state.pendingApproval.id === data.id) state.pendingApproval = null
        return
      case 'turn/end': {
        const kind = data.reason?.kind ?? 'completed'
        state.runningTurn = false
        state.failed = kind === 'error'
        if (kind === 'error') announce(session, 'failed', data.reason?.error)
        else if (kind === 'completed') announce(session, 'completed')
        else if (kind === 'aborted' || kind === 'max-tokens') announce(session, 'interrupted')
        armIdle(session, state)
        return
      }
      default:
        return
    }
  }, { global: true })

  // ---- lifecycle --------------------------------------------------------
  ctx.on('session/created', (session) => {
    const id = String(session?.header?.id ?? session?.id ?? '')
    if (!states.has(id)) states.set(id, createState())
  }, { global: true })

  ctx.on('session/disposed', (session) => {
    const id = String(session?.header?.id ?? session?.id ?? '')
    const state = states.get(id)
    if (state?.idleTimer != null) clearTimeout(state.idleTimer)
    states.delete(id)
  }, { global: true })

  ctx.effect(() => {
    ready = true
    return () => {
      ready = false
      for (const state of states.values()) {
        if (state.idleTimer != null) clearTimeout(state.idleTimer)
      }
      states.clear()
    }
  }, 'session-notify: lifecycle')
}

/**
 * Browser half of the session-notify bundle.
 *
 * Loaded by the Harness client module loader through `window.__ModuleLoader__`:
 * the loader calls `factory(require)` and reads `inject` / `apply` off the returned
 * object, where `require` only resolves names from the shared module table
 * (`react`, `react/jsx-runtime`, `cordis`, `zod`, ...). This file therefore uses no
 * ES module syntax and no bundler.
 *
 * Watches every conversation the Client can see and reminds the user when one
 * pauses: the agent asked something, a permission prompt waits, a turn
 * finished or failed while the user was elsewhere, or a conversation was left
 * idle for a while.
 *
 * Delivery: the Host half draws the Windows notification and the sound; this
 * half draws the small on-screen card stack.
 */

window.__ModuleLoader__.load({
  id: '@iridensity_gray/dsh-session-notify',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const PREFIX = 'dsh-session-notify'
    const STORAGE_KEY = `${PREFIX}.settings.v1`
    const MAX_CARDS = 4
    const CARD_TTL_MS = 15_000
    const QUESTION_TOOL = 'ask_user_question'

    const KIND_LABEL = {
      question: '等你选择',
      approval: '等你授权',
      completed: '已完成',
      idle: '等你输入',
      failed: '出错',
      interrupted: '已中断',
    }
    const KIND_LABEL_EN = {
      question: 'Needs a choice',
      approval: 'Needs approval',
      completed: 'Finished',
      idle: 'Idle',
      failed: 'Failed',
      interrupted: 'Interrupted',
    }

    const DEFAULT_SETTINGS = {
      enabled: true,
      question: true,
      approval: true,
      completed: true,
      idle: true,
      idleMinutes: 5,
      failed: true,
      interrupted: true,
      whenPresent: 'off',
      card: true,
      awayOnly: false,
    }

    /** Snapshot store: one value with plain listeners. */
    function createStore(initial) {
      let value = initial
      const listeners = new Set()
      const emit = () => { for (const listener of [...listeners]) listener() }
      return {
        getSnapshot: () => value,
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        set(next) {
          if (value === next) return
          value = next
          emit()
        },
      }
    }

    function loadSettings() {
      try {
        const raw = window.localStorage?.getItem(STORAGE_KEY)
        const parsed = raw ? JSON.parse(raw) : undefined
        return { ...DEFAULT_SETTINGS, ...(parsed && typeof parsed === 'object' ? parsed : {}) }
      } catch {
        return { ...DEFAULT_SETTINGS }
      }
    }

    function saveSettings(settings) {
      try { window.localStorage?.setItem(STORAGE_KEY, JSON.stringify(settings)) } catch { /* storage unavailable */ }
    }

    /** True when the user is not looking at the Harness window right now. */
    function isUserAway() {
      try { return document.visibilityState !== 'visible' || document.hasFocus() !== true } catch { return true }
    }

    function clip(text, limit) {
      const flat = String(text ?? '').replace(/\s+/gu, ' ').trim()
      return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat
    }

    function textOf(content) {
      if (!Array.isArray(content)) return ''
      const block = content.find(item => item !== null && typeof item === 'object' && item.type === 'text')
      return typeof block?.text === 'string' ? block.text : ''
    }

    function parseJson(text) {
      try { return JSON.parse(text) } catch { return undefined }
    }

    /** One conversation's derived facts. */
    function createFold() {
      return {
        turn: 0,
        activeTurn: false,
        tools: new Map(),
        pendingApproval: null,
        failed: false,
        lastUserText: '',
        assistantText: '',
        lastSeq: -1,
        questionProjection: undefined,
      }
    }

    /** Apply one durable event; return the turn verdict when this event ends a turn. */
    function applyEvent(fold, event) {
      const data = event?.data ?? {}
      switch (event?.type) {
        case 'turn/start':
          fold.turn = Number(data.turn ?? fold.turn + 1)
          fold.activeTurn = true
          fold.assistantText = ''
          fold.failed = false
          return undefined
        case 'turn/end': {
          const kind = data.reason?.kind ?? 'completed'
          fold.activeTurn = false
          fold.failed = kind === 'error'
          return { kind, reason: data.reason }
        }
        case 'step/start':
          fold.assistantText = ''
          return undefined
        case 'assistant/message':
          fold.assistantText = textOf(data.message?.content)
          return undefined
        case 'user/message': {
          const source = data.source ?? {}
          const text = textOf(data.content)
          if (text !== '') fold.lastUserText = text
          void source
          return undefined
        }
        case 'tool/call':
          fold.tools.set(data.callId, { name: data.name, arguments: data.arguments })
          return undefined
        case 'tool/result': {
          fold.tools.delete(data.message?.toolCallId)
          return undefined
        }
        case 'approval/asked':
          fold.pendingApproval = { id: data.id, toolName: data.toolName }
          return undefined
        case 'approval/decided':
          if (fold.pendingApproval !== null && fold.pendingApproval.id === data.id) fold.pendingApproval = null
          return undefined
        default:
          return undefined
      }
    }

    /** Live question requests, from the projection or from unfinished tool calls. */
    function questionFacts(fold) {
      const found = []
      const projection = fold.questionProjection
      if (Array.isArray(projection?.active)) {
        for (const item of projection.active) {
          const first = item?.questions?.[0]
          found.push({
            callId: item.callId,
            question: clip(first?.question ?? first?.header ?? '', 130),
            count: item.questions?.length ?? 1,
          })
        }
      }
      if (found.length === 0) {
        for (const [callId, call] of fold.tools) {
          if (call.name !== QUESTION_TOOL) continue
          const args = parseJson(call.arguments)
          const first = args?.questions?.[0]
          found.push({ callId, question: clip(first?.question ?? first?.header ?? '', 130), count: args?.questions?.length ?? 1 })
        }
      }
      return found
    }

    function composeBody(fold, kind, reason) {
      if (kind === 'question') {
        const [first] = questionFacts(fold)
        const asked = first?.question || '有新的问题等你回答'
        const more = first !== undefined && first.count > 1 ? `（共 ${first.count} 个问题）` : ''
        return clip(`${asked}${more}`, 160)
      }
      if (kind === 'approval') {
        const tool = fold.pendingApproval?.toolName
        return `等待你批准${typeof tool === 'string' && tool !== '' ? ` ${tool}` : '一次操作'}`
      }
      if (kind === 'failed') {
        const detail = reason?.error?.message ?? reason?.error?.code ?? '本轮执行出错'
        return clip(String(detail), 160)
      }
      const answer = clip(fold.assistantText, 150)
      if (kind === 'completed') return answer || '这一轮已经完成，等你下一步。'
      if (kind === 'interrupted') return answer || '这一轮被中断了。'
      return fold.lastUserText === '' ? '会话已空闲，等待你的输入。' : clip(`待处理：${fold.lastUserText}`, 150)
    }

    /* ------------------------------------------------------------------ */
    /* Services                                                            */
    /* ------------------------------------------------------------------ */

    function build(ctx, shared) {
      const { settingsStore, cardsStore, hostErrorStore } = shared
      const folds = new Map()
      const seen = new Map()
      const idleTimers = new Map()
      const watched = new Map()
      const previousRunning = new Map()
      let primed = false

      const settings = () => settingsStore.getSnapshot()

      function allowed(row, kind) {
        const config = settings()
        if (!config.enabled || config[kind] !== true) return false
        if (config.whenPresent === 'off' && !isUserAway()) return false
        if (config.awayOnly && !isUserAway()) {
          const mainView = row?.retainedBy?.mainView ?? 0
          if (mainView > 0) return false
        }
        return true
      }

      function titleOf(row, fold) {
        const title = row?.title ?? row?.displayTitle
        if (typeof title === 'string' && title.trim() !== '' && !title.startsWith('session-')) return title
        const cwd = row?.cwd
        if (typeof cwd === 'string' && cwd !== '') {
          const parts = cwd.split(/[\\/]+/u).filter(part => part !== '')
          if (parts.length > 0) return parts[parts.length - 1]
        }
        return fold.lastUserText === '' ? 'Harness 会话' : clip(fold.lastUserText, 48)
      }

      /** Deliver one reminder at most once per turn and kind. */
      function announce(sessionId, kind, reason) {
        const state = ctx.sessions.list.getSnapshot()
        const row = state.byId[sessionId]
        const trace = (...parts) => {
          const log = globalThis['dsh-session-notify']?.trace
          if (typeof log === 'function') log(sessionId, kind, parts.join(' '))
        }
        if (row === undefined) {
          trace('skipped: no catalog row')
          return false
        }
        // A freshly loaded page must not replay history as new reminders.
        const interactive = kind === 'question' || kind === 'approval'
        if (!interactive && (!primed || state.phase !== 'ready')) {
          trace('skipped: not primed')
          return false
        }
        const fold = folds.get(sessionId) ?? createFold()
        folds.set(sessionId, fold)
        const stamp = `${sessionId}|${kind}|${fold.turn}`
        if (seen.has(stamp)) {
          trace(`skipped: duplicate (turn ${fold.turn})`)
          return false
        }
        seen.set(stamp, Date.now())
        if (seen.size > 400) {
          const cutoff = Date.now() - 6 * 60 * 60 * 1000
          for (const [key, at] of seen) if (at < cutoff) seen.delete(key)
        }
        const title = titleOf(row, fold)
        const body = composeBody(fold, kind, reason)
        const request = { kind, title, body, present: !isUserAway() }
        if (!allowed(row, kind)) {
          trace(`skipped: settings (present=${request.present}, awayOnly=${settings().awayOnly})`)
          return false
        }

        if (settings().card) {
          const card = { key: `${stamp}|${Date.now()}`, sessionId, kind, title, body, at: Date.now() }
          const next = [card, ...cardsStore.getSnapshot()].slice(0, MAX_CARDS)
          cardsStore.set(next)
        }

        return true
      }

      function scheduleIdle(sessionId) {
        clearTimeout(idleTimers.get(sessionId))
        idleTimers.delete(sessionId)
        const config = settings()
        if (!config.idle) return
        const minutes = Number(config.idleMinutes)
        if (!Number.isFinite(minutes) || minutes <= 0) return
        idleTimers.set(sessionId, setTimeout(() => {
          idleTimers.delete(sessionId)
          const row = ctx.sessions.list.getSnapshot().byId[sessionId]
          if (row === undefined || row.running) return
          announce(sessionId, 'idle')
        }, Math.min(minutes, 120) * 60_000))
      }

      /**
       * Read the durable events of a Session window.
       *
       * `eventSource.getSnapshot()` returns `SessionEventWindow`, whose array
       * lives on `.entries` (each entry is `{ type: 'event' | 'transient', event }`).
       * Reading a wrong property here made the whole watcher throw before it
       * could subscribe, which is why no reminder ever fired.
       * @returns the durable Session events in append order.
       */
      function windowEvents(session) {
        try {
          const snapshot = session?.eventSource?.getSnapshot?.()
          const entries = Array.isArray(snapshot?.entries) ? snapshot.entries : []
          const events = []
          for (const entry of entries) {
            if (entry === null || typeof entry !== 'object') continue
            if (entry.type === 'transient') continue
            const event = entry.event ?? entry
            if (event !== null && typeof event === 'object' && typeof event.type === 'string') events.push(event)
          }
          return events
        } catch {
          return []
        }
      }

      /** Rebuild the fold from the Session's current event window. */
      function rebuild(sessionId) {
        const fold = createFold()
        const session = ctx.sessions.binding(sessionId)?.session
        for (const event of windowEvents(session)) {
          applyEvent(fold, event)
          const seq = Number(event.seq)
          if (Number.isFinite(seq)) fold.lastSeq = Math.max(fold.lastSeq, seq)
        }
        const projection = session?.projections?.faceOf('userQuestions')?.getSnapshot()
        fold.questionProjection = projection
        folds.set(sessionId, fold)
      }

      function currentEvents(session) {
        return windowEvents(session)
      }

      /** Watch one bound Session: durable events plus the question projection. */
      function watch(sessionId) {
        if (watched.has(sessionId)) return
        const session = ctx.sessions.binding(sessionId)?.session
        if (session === undefined || typeof session.eventSource?.subscribe !== 'function') return
        rebuild(sessionId)

        const consume = (fresh) => {
          const fold = folds.get(sessionId) ?? createFold()
          const verdicts = []
          let questionRaised = false
          for (const event of fresh) {
            if (event === undefined) continue
            const seq = Number(event.seq)
            if (Number.isFinite(seq)) {
              if (seq <= fold.lastSeq) continue
              fold.lastSeq = seq
            }
            // An unanswered question lives in the projection (which also keeps
            // `continued` questions after their tool result); the fold alone
            // cannot tell an answered call from a pending one.
            const beforeQuestion = questionFacts(fold).length > 0
            const verdict = applyEvent(fold, event)
            if (verdict !== undefined) verdicts.push(verdict)
            const questions = questionFacts(fold)
            if (questions.length > 0) questionRaised = questionRaised || !beforeQuestion
          }
          if (questionRaised) announce(sessionId, 'question')
          for (const verdict of verdicts) {
            if (fold.pendingApproval === null) {
              if (questionFacts(fold).length > 0) announce(sessionId, 'question')
              else if (verdict.kind === 'error') announce(sessionId, 'failed', verdict)
              else if (verdict.kind === 'completed') announce(sessionId, 'completed')
              else if (verdict.kind === 'aborted' || verdict.kind === 'max-tokens') announce(sessionId, 'interrupted')
            }
            scheduleIdle(sessionId)
          }
        }

        let known = new Set()
        for (const event of currentEvents(session)) {
          const seq = Number(event.seq)
          if (Number.isFinite(seq)) known.add(seq)
        }

        const onEvents = () => {
          const fresh = []
          for (const event of currentEvents(session)) {
            const seq = Number(event.seq)
            if (Number.isFinite(seq)) {
              if (known.has(seq)) continue
              known.add(seq)
            }
            fresh.push(event)
          }
          if (fresh.length > 0) consume(fresh)
          const fold = folds.get(sessionId)
          if (fold !== undefined && fold.pendingApproval !== null) announce(sessionId, 'approval')
        }

        const onQuestions = () => {
          const fold = folds.get(sessionId) ?? createFold()
          const before = questionFacts(fold).length > 0
          fold.questionProjection = session.projections.faceOf('userQuestions').getSnapshot()
          const questions = questionFacts(fold)
          if (questions.length > 0 && !before) announce(sessionId, 'question')
        }

        const offEvents = session.eventSource.subscribe(onEvents)
        const offQuestions = session.projections.faceOf('userQuestions').subscribe(onQuestions)
        watched.set(sessionId, () => { offEvents(); offQuestions() })
      }

      function forget(sessionId) {
        watched.get(sessionId)?.()
        watched.delete(sessionId)
        folds.delete(sessionId)
        clearTimeout(idleTimers.get(sessionId))
        idleTimers.delete(sessionId)
      }

      /** Follow the catalog: watch bound conversations and reconcile running state. */
      function reconcile() {
        const state = ctx.sessions.list.getSnapshot()
        const ids = state.ids
        for (const id of ids) watch(id)
        for (const id of [...watched.keys()]) if (!ids.includes(id)) forget(id)
        for (const id of [...idleTimers.keys()]) {
          if (!ids.includes(id)) {
            clearTimeout(idleTimers.get(id))
            idleTimers.delete(id)
          }
        }
        for (const id of ids) {
          const row = state.byId[id]
          const was = previousRunning.get(id)
          previousRunning.set(id, row.running)
          if (!primed || was === undefined) continue
          if (was === true && row.running === false) {
            const fold = folds.get(id) ?? createFold()
            folds.set(id, fold)
            if (fold.pendingApproval !== null) announce(id, 'approval')
            else if (questionFacts(fold).length > 0) announce(id, 'question')
            else if (fold.failed) announce(id, 'failed')
            else announce(id, 'completed')
            scheduleIdle(id)
          } else if (was === false && row.running === true) {
            clearTimeout(idleTimers.get(id))
            idleTimers.delete(id)
          }
        }
        if (state.phase === 'ready') primed = true
      }

      /**
       * Play a short two-tone chime with the Web Audio API.
       *
       * The settings buttons need to prove the page can make a sound, and the
       * page has no channel to the Host half (the Client exposes no "run a Host
       * command" service), so this test chime is generated here instead of being
       * delegated. Real reminders are still sounded by the Host half.
       */
      function playTestChime() {
        try {
          const AudioContext = window.AudioContext ?? window.webkitAudioContext
          if (typeof AudioContext !== 'function') return
          const audio = new AudioContext()
          const start = audio.currentTime
          for (const [index, hz] of [880, 1180].entries()) {
            const oscillator = audio.createOscillator()
            const gain = audio.createGain()
            oscillator.type = 'sine'
            oscillator.frequency.value = hz
            const at = start + index * 0.16
            gain.gain.setValueAtTime(0.0001, at)
            gain.gain.exponentialRampToValueAtTime(0.22, at + 0.02)
            gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.15)
            oscillator.connect(gain)
            gain.connect(audio.destination)
            oscillator.start(at)
            oscillator.stop(at + 0.16)
          }
          setTimeout(() => { void audio.close() }, 800)
        } catch { /* audio may be unavailable; the card still shows */ }
      }

      /** Show a sample reminder of one kind (used by the settings tests). */
      function test(kind) {
        const state = ctx.sessions.list.getSnapshot()
        const row = Object.values(state.byId).find(candidate => (candidate.retainedBy?.mainView ?? 0) > 0)
          ?? Object.values(state.byId)[0]
        const fold = createFold()
        fold.lastUserText = '示例：这条提醒是否正常弹出？'
        fold.assistantText = '示例：这一轮已经完成，等你下一步。'
        fold.pendingApproval = { id: 'sample', toolName: 'pwsh' }
        fold.tools.set('sample-call', {
          name: QUESTION_TOOL,
          arguments: JSON.stringify({ questions: [{ id: 'q', question: '要不要按推荐方案继续？' }] }),
        })
        const title = row === undefined ? 'Harness 会话（示例）' : titleOf(row, fold)
        const body = composeBody(fold, kind)
        if (settings().card) {
          const card = { key: `test-${kind}-${Date.now()}`, sessionId: row?.id ?? '', kind, title, body, at: Date.now() }
          cardsStore.set([card, ...cardsStore.getSnapshot()].slice(0, MAX_CARDS))
        }
        // The button proves the page's own audio path; the Host half sounds real
        // reminders, so a silent test here means the browser, not the plugin.
        playTestChime()
      }

      /**
       * Jump to the conversation a card is about.
       *
       * `ctx.uiWorkspace.openSession(id)` is the Client's documented way to
       * select a session (the same call the sidebar's session rows use); the
       * workspace browser owns selection, so `ctx.sessions` alone cannot open
       * one. Falling back to `retain` at least materialises the binding.
       * @param sessionId - the catalogued Session to show.
       */
      function openSession(sessionId) {
        if (typeof sessionId !== 'string' || sessionId === '') return
        try { ctx.layout?.selectPanel?.(null) } catch { /* panel selection is best effort */ }
        const workspace = ctx.uiWorkspace
        if (workspace !== undefined && typeof workspace.openSession === 'function') {
          try {
            workspace.openSession(sessionId)
            return
          } catch { /* fall through to the local fallback */ }
        }
        try {
          const reference = ctx.sessions.retain(sessionId, { source: 'notification' })
          reference.release()
        } catch { /* the row may have been archived meanwhile */ }
      }

      function dismiss(key) {
        cardsStore.set(cardsStore.getSnapshot().filter(card => card.key !== key))
      }

      function setSettings(patch) {
        const next = { ...settings(), ...patch }
        settingsStore.set(next)
        saveSettings(next)
        for (const id of [...idleTimers.keys()]) {
          clearTimeout(idleTimers.get(id))
          idleTimers.delete(id)
        }
        if (next.idle) {
          for (const id of ctx.sessions.list.getSnapshot().ids) {
            const row = ctx.sessions.list.getSnapshot().byId[id]
            if (row !== undefined && !row.running) scheduleIdle(id)
          }
        }
      }

      return { reconcile, test, openSession, dismiss, setSettings }
    }

    /* ------------------------------------------------------------------ */
    /* Views                                                               */
    /* ------------------------------------------------------------------ */

    const TONE = {
      question: '#2f6feb',
      approval: '#d97706',
      completed: '#16a34a',
      idle: '#5f6672',
      failed: '#dc2626',
      interrupted: '#d97706',
    }

    /** Literal palette: this build passes token values as literals, not CSS variables. */
    const INK = '#1f2329'
    const INK_MUTED = '#5f6672'
    const LINE = 'rgba(127, 127, 127, 0.28)'

    /**
     * Warning palette for the reminder control's hover state.
     *
     * The three sidebar foot controls sit at the same visual level, so this one
     * stays transparent until the pointer or focus lands on it and only then
     * takes the warning hue — the same interaction as the delete control beside
     * it, which turns red on hover.
     */
    const WARN_BG = '#fdf1dc'
    const WARN_INK = '#8a5a00'

    /**
     * One reminder card.
     *
     * Close paths, in order of robustness: the corner button is absolutely
     * positioned (flex layout cannot push it out of view), the whole card is a
     * button that closes on click, and the stack retires the card after
     * CARD_TTL_MS on its own.
     */
    function CardView({ card, onOpen, onDismiss }) {
      const tone = TONE[card.kind] ?? TONE.idle
      return h('div', {
        role: 'status',
        // The plate is the click target: clicking anywhere on the card closes it.
        onClick: () => { onDismiss(card.key) },
        title: '点击关闭提醒',
        style: {
          position: 'relative',
          boxSizing: 'border-box',
          width: '100%',
          maxWidth: '100%',
          overflow: 'hidden',
          padding: '10px 34px 10px 12px',
          // Only the card takes pointer events; the stack around it stays click-through.
          pointerEvents: 'auto',
          cursor: 'pointer',
          borderRadius: 10,
          border: `1px solid ${LINE}`,
          borderLeft: `3px solid ${tone}`,
          background: '#ffffff',
          color: INK,
          boxShadow: '0 6px 24px rgba(0, 0, 0, 0.18)',
          fontSize: 13,
          lineHeight: '18px',
        },
      },
      h('div', {
        style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3, minWidth: 0 },
      },
      h('span', {
        style: {
          flex: 'none', fontSize: 11, fontWeight: 600, padding: '0 6px', borderRadius: 6,
          color: tone, background: 'rgba(127, 127, 127, 0.12)',
        },
      }, KIND_LABEL[card.kind] ?? '提醒'),
      h('span', {
        title: card.title,
        style: {
          flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
          whiteSpace: 'nowrap', fontWeight: 600, fontSize: 12.5,
        },
      }, card.title)),
      h('div', {
        style: {
          color: INK_MUTED, fontSize: 12.5, overflow: 'hidden', wordBreak: 'break-word',
          display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical',
        },
      }, card.body),
      h('button', {
        type: 'button',
        'aria-label': '关闭提醒',
        title: '关闭提醒',
        onClick: (event) => { event.stopPropagation(); onDismiss(card.key) },
        style: {
          position: 'absolute', top: 6, right: 6, width: 20, height: 20, padding: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          borderRadius: 6, cursor: 'pointer', border: 'none', background: 'transparent',
          color: INK_MUTED, fontSize: 15, lineHeight: 1,
        },
      }, '×'),
      h('button', {
        type: 'button',
        'aria-label': '打开会话',
        onClick: (event) => { event.stopPropagation(); onOpen(card.sessionId); onDismiss(card.key) },
        style: {
          marginTop: 6, padding: '2px 9px', borderRadius: 8, cursor: 'pointer',
          border: `1px solid ${LINE}`, background: 'transparent',
          color: '#2f6feb', fontSize: 12, fontWeight: 600,
        },
      }, '查看'))
    }

    /** Frame-wide stack of reminder cards, newest on top. */
    function CardsOverlay({ cards, onOpen, onDismiss }) {
      // `cards` is the observable store, not an array: read its snapshot and
      // re-render on change. Reading it directly is what keeps this component
      // from crashing, which is what made the first two versions un-clickable.
      const list = React.useSyncExternalStore
        ? React.useSyncExternalStore(cards.subscribe, cards.getSnapshot, cards.getSnapshot)
        : cards.getSnapshot()
      const [tick, setTick] = React.useState(0)
      React.useEffect(() => {
        if (list.length === 0) return undefined
        const timer = setInterval(() => { setTick(value => value + 1) }, 1000)
        return () => { clearInterval(timer) }
      }, [list.length])
      if (list.length === 0) return null
      const now = Date.now()
      for (const card of list) if (now - card.at > CARD_TTL_MS) onDismiss(card.key)
      const visible = list.filter(card => now - card.at <= CARD_TTL_MS)
      if (visible.length === 0) return null
      return h('div', {
        'aria-live': 'polite',
        style: {
          // Anchored to the frame's overlay layer, not the viewport: `fixed`
          // would lift the stack out of the frame and cover the whole window.
          // Top inset clears the Windows caption row (`--dsh-windows-titlebar-height`
          // when the shell publishes it) so minimize/maximize/close stay clickable.
          position: 'absolute',
          top: 'calc(var(--dsh-windows-titlebar-height, 0px) + 12px)',
          right: 12,
          width: 320,
          maxWidth: 'calc(100vw - 24px)',
          maxHeight: 'calc(100vh - 80px)',
          overflow: 'auto',
          display: 'flex', flexDirection: 'column', gap: 8,
          // The wrapper is a pass-through area; only cards take pointer events.
          pointerEvents: 'none',
        },
      }, visible.map(card => h(CardView, { key: card.key, card, onOpen, onDismiss })))
    }

    function Toggle({ label, checked, onChange }) {
      return h('label', {
        style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '5px 0', fontSize: 13 },
      },
      h('span', { style: { color: INK } }, label),
      h('input', { type: 'checkbox', checked: checked === true, onChange: event => onChange(event.target.checked) }))
    }

    function OutlineButton({ children, onClick }) {
      return h('button', {
        type: 'button',
        onClick,
        style: {
          padding: '3px 10px', borderRadius: 8, cursor: 'pointer', fontSize: 12,
          border: `1px solid ${LINE}`, background: 'transparent', color: INK,
        },
      }, children)
    }

    /** Settings dialog raised from the sidebar bell. */
    function SettingsOverlay({ open, settings, error, onPatch, onClose, onTest }) {
      // Each injected source is the observable store itself; read it through a
      // subscription so edits in the panel re-render, and never treat a store as
      // a plain value (that crash is what froze the page in earlier versions).
      const useSnapshot = (store) => (React.useSyncExternalStore
        ? React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
        : store.getSnapshot())
      const isOpen = useSnapshot(open)
      const values = useSnapshot(settings)
      const errorState = useSnapshot(error)
      React.useEffect(() => {
        if (!isOpen) return undefined
        const onKey = (event) => { if (event.key === 'Escape') onClose() }
        window.addEventListener('keydown', onKey)
        return () => { window.removeEventListener('keydown', onKey) }
      }, [isOpen, onClose])
      if (!isOpen) return null
      const errorText = typeof errorState === 'string' && errorState.includes('|') ? errorState.split('|').slice(1).join('|') : ''
      const divider = h('div', { style: { height: 1, background: LINE, margin: '8px 0' } })
      const dialog = h('div', {
        // The dialog is modal: stop clicks from reaching the page underneath.
        onClick: event => { event.stopPropagation() },
        style: {
          width: 430, maxWidth: '100%', maxHeight: '85vh', overflow: 'auto', padding: '16px 18px',
          borderRadius: 14, background: '#ffffff', border: `1px solid ${LINE}`,
          boxShadow: '0 16px 48px rgba(0, 0, 0, 0.28)', color: INK,
        },
      },
      h('div', { style: { fontSize: 15, fontWeight: 600, marginBottom: 4 } }, '对话停止提醒'),
      h('div', { style: { fontSize: 12, color: INK_MUTED, marginBottom: 10 } },
        '会话等你选择、等授权、完成、空闲或出错时：屏幕右上角弹小卡片，并弹 Windows 通知和提示音。'),
      h(Toggle, { label: '启用提醒', checked: values.enabled, onChange: value => onPatch({ enabled: value }) }),
      divider,
      h(Toggle, { label: '等你选择选项', checked: values.question, onChange: value => onPatch({ question: value }) }),
      h(Toggle, { label: '等你授权', checked: values.approval, onChange: value => onPatch({ approval: value }) }),
      h(Toggle, { label: '任务完成', checked: values.completed, onChange: value => onPatch({ completed: value }) }),
      h(Toggle, {
        label: '出错 / 中断',
        checked: values.failed && values.interrupted,
        onChange: (value) => { onPatch({ failed: value, interrupted: value }) },
      }),
      h(Toggle, { label: '空闲等待输入', checked: values.idle, onChange: value => onPatch({ idle: value }) }),
      h('label', {
        style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '5px 0', fontSize: 13 },
      },
      h('span', null, '空闲多久后提醒（分钟）'),
      h('input', {
        type: 'number', min: 1, max: 120, value: values.idleMinutes,
        onChange: (event) => {
          const value = Number(event.target.value)
          if (Number.isFinite(value)) onPatch({ idleMinutes: Math.min(120, Math.max(1, Math.round(value))) })
        },
        style: {
          width: 70, padding: '3px 8px', borderRadius: 8, textAlign: 'right',
          border: `1px solid ${LINE}`, background: '#ffffff', color: INK,
        },
      })),
      divider,
      h(Toggle, { label: '只在窗口不在前台时提醒', checked: values.whenPresent, onChange: value => onPatch({ whenPresent: value }) }),
      h(Toggle, { label: '只提醒当前没在看的会话', checked: values.awayOnly, onChange: value => onPatch({ awayOnly: value }) }),
      h(Toggle, { label: '屏幕小卡片', checked: values.card, onChange: value => onPatch({ card: value }) }),
      h('div', { style: { display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' } },
        h(OutlineButton, { onClick: () => onTest('question') }, '测试提问'),
        h(OutlineButton, { onClick: () => onTest('approval') }, '测试授权'),
        h(OutlineButton, { onClick: () => onTest('completed') }, '测试完成'),
        h(OutlineButton, { onClick: () => onTest('idle') }, '测试空闲')),
      errorText === '' ? null : h('div', {
        style: { marginTop: 10, fontSize: 12, color: '#dc2626' },
      }, `系统通知失败：${clip(errorText, 200)}`),
      h('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: 14 } },
        h(OutlineButton, { onClick: onClose }, '完成')))
      return h('div', {
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': '对话停止提醒设置',
        onClick: (event) => { if (event.target === event.currentTarget) onClose() },
        style: {
          // Absolute inside the frame's overlay layer; this is the only element
          // of the plugin that may cover the page, and only while it is open.
          position: 'absolute', inset: 0, background: 'rgba(0, 0, 0, 0.35)', display: 'flex',
          alignItems: 'center', justifyContent: 'center', padding: 16, pointerEvents: 'auto',
        },
      }, dialog)
    }

    /** Sidebar foot control: bell and the number of reminders still on screen. */
    function BellButton({ wide, count, open, onClick }) {
      // Both injected sources are observable stores, not plain values.
      const useSnapshot = (store) => (React.useSyncExternalStore
        ? React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
        : store.getSnapshot())
      const cardCount = useSnapshot(count)
      const isOpen = useSnapshot(open)
      // Hover deepens the tint, mirroring how the delete control reacts, so the
      // three footer controls share one interaction language in different hues.
      const [hot, setHot] = React.useState(false)
      return h('button', {
        type: 'button',
        'aria-label': cardCount > 0 ? `对话停止提醒（${cardCount} 张卡片）` : '对话停止提醒',
        'aria-expanded': isOpen === true,
        onClick,
        onMouseEnter: () => setHot(true),
        onMouseLeave: () => setHot(false),
        onFocus: () => setHot(true),
        onBlur: () => setHot(false),
        title: '对话停止提醒设置',
        style: {
          position: 'relative', display: 'flex', alignItems: 'center', justifyContent: wide ? 'flex-start' : 'center',
          gap: 8, width: wide ? 'auto' : '100%', height: 34, padding: wide ? '0 8px' : 0, flex: wide ? '1 1 0' : 'none',
          borderRadius: 10, border: 'none',
          // Transparent at rest, warning hue on hover/focus: the delete control
          // beside it behaves the same way in its own red hue.
          background: hot ? WARN_BG : 'transparent',
          cursor: 'pointer', color: hot ? WARN_INK : INK_MUTED, fontSize: 13, fontFamily: 'inherit',
        },
      },
      h('span', { style: { position: 'relative', display: 'inline-flex' } },
        h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
          h('path', {
            d: 'M6.5 9.5a5.5 5.5 0 0 1 11 0c0 3 .6 4.6 1.5 5.8.4.5 0 1.2-.7 1.2H5.7c-.7 0-1.1-.7-.7-1.2 0.9-1.2 1.5-2.8 1.5-5.8Z',
            stroke: 'currentColor', strokeWidth: 1.6, strokeLinejoin: 'round',
          }),
          h('path', { d: 'M9.9 19.2a2.3 2.3 0 0 0 4.2 0', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' })),
        cardCount > 0 ? h('span', {
          'aria-hidden': true,
          style: {
            position: 'absolute', top: -5, right: -7, minWidth: 15, height: 15, padding: '0 3px',
            borderRadius: 8, fontSize: 10, fontWeight: 700, lineHeight: '15px', textAlign: 'center',
            background: WARN_INK, color: '#ffffff',
          },
        }, cardCount > 9 ? '9+' : String(cardCount)) : null),
      wide ? h('span', { style: { flex: '0 0 auto', textAlign: 'left', whiteSpace: 'nowrap' } }, '提醒') : null)
    }

    /* ------------------------------------------------------------------ */
    /* Plugin body                                                         */
    /* ------------------------------------------------------------------ */

    /** Services this plugin reads off the Client context. */
    const inject = ['slots', 'sessions', 'layout', 'uiWorkspace']

    /** Mount the plugin: catalog follow, overlay cards, settings dialog, sidebar bell. */
    function apply(ctx) {
        const model = {
          settings: createStore(loadSettings()),
          cards: createStore([]),
          error: createStore(''),
          open: createStore(false),
        }
        const services = build(ctx, {
          settingsStore: model.settings,
          cardsStore: model.cards,
          hostErrorStore: model.error,
        })
        const t = (key) => key

        const reconcile = () => { services.reconcile() }
        ctx.effect(() => {
          const off = ctx.sessions.list.subscribe(reconcile)
          reconcile()
          return off
        }, 'session-notify: catalog follow')
        ctx.effect(() => {
          const timer = setInterval(reconcile, 3000)
          return () => { clearInterval(timer) }
        }, 'session-notify: binding sweep')

        const toggleSettings = () => { model.open.set(!model.open.getSnapshot()) }

        ctx.slots.inject('shell.overlay', function* () {
          yield ctx.slots.register({
            name: 'shell.overlay',
            id: `${PREFIX}.cards`,
            inject: () => ({
              cards: model.cards,
              onOpen: services.openSession,
              onDismiss: services.dismiss,
            }),
          }, CardsOverlay)
          yield ctx.slots.register({
            name: 'shell.overlay',
            id: `${PREFIX}.settings`,
            inject: () => ({
              open: model.open,
              settings: model.settings,
              error: model.error,
              onPatch: services.setSettings,
              onClose: () => { model.open.set(false) },
              onTest: services.test,
            }),
          }, SettingsOverlay)
        })
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: `${PREFIX}.bell`,
          order: 10,
          inject: () => ({ count: model.cards, open: model.open, onClick: toggleSettings }),
        }, BellButton))

        // Debug handle for the console; the UI itself never needs it.
        globalThis[PREFIX] = {
          model,
          services,
          t,
          settings: () => model.settings.getSnapshot(),
          setSettings: patch => services.setSettings(patch),
          /** Last 40 reminder decisions with the reason each was taken or skipped. */
          trace: (() => {
            const lines = []
            const log = (sessionId, kind, detail) => {
              lines.push(`${new Date().toISOString().slice(11, 19)} ${kind} ${detail}`)
              if (lines.length > 40) lines.shift()
            }
            log.history = lines
            return log
          })(),
        }
    }
    return { inject, apply }
  },
})

/**
 * dsh-pet — browser half.
 *
 * This half draws NOTHING. The pet itself is the floating desktop window the
 * host half starts; a second sprite in the app window was one pet too many.
 *
 * What is left is the traffic that only the app window can carry:
 *
 *   out   whether the agent is generating. `useSessionStatus` is a root-scoped
 *         standard prop published by ui-session, and registering into
 *         `shell.overlay` is what makes it available — the slot renders a
 *         component that returns null purely to receive those props. Each change
 *         goes to the host half, which the pet reads back from `GET /state`.
 *
 *   in    clicks on the pet. The pet cannot open a chat: it is a separate
 *         process with no access to the UI. It sets a flag on the host half,
 *         collected here, and this half owns the session list needed to know
 *         which chat to show.
 *
 * Shape of this file: a hand-written ModuleLoader bundle. No build step, and no
 * dependency beyond the `react` the shell already seeds.
 */
window.__ModuleLoader__.load({
  id: 'dsh-pet',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { useEffect, useRef } = React

    const API = '/api/dsh-pet'
    /** How often the pet's click flag is collected. A local request, and cheap. */
    const POLL_MS = 1500

    /**
     * The busy condition: any session currently generating.
     *
     * Returns a primitive, so the component re-renders only when the answer
     * flips rather than on every status-map change.
     */
    const selectAnyRunning = snapshot => {
      if (snapshot === undefined || snapshot === null) return false
      if (typeof snapshot.values !== 'function') return false
      for (const status of snapshot.values()) {
        if (status !== undefined && status !== null && status.running === true) return true
      }
      return false
    }

    /**
     * Which chat the pet's click should open.
     *
     * "The last working chat" is the one on screen if there is one, and otherwise
     * the most recently touched session. This mirrors what the shipped sidebar
     * does with the same rows:
     *
     *   Object.values(byId).find(s => (s.retainedBy.mainView ?? 0) > 0)?.id
     *
     * Returning an id — a primitive — keeps the hook from re-rendering on every
     * unrelated session-list change.
     */
    const pickSession = state => {
      const rows = state?.byId
      if (rows === undefined || rows === null || typeof rows !== 'object') return undefined
      let newest
      let newestAt = -Infinity
      for (const id of Object.keys(rows)) {
        const row = rows[id]
        if (row === undefined || row === null) continue
        // A session held by the main view is, by definition, the current chat.
        if ((row.retainedBy?.mainView ?? 0) > 0) return id
        const at = Number(row.updatedAt)
        if (Number.isFinite(at) && at > newestAt) {
          newestAt = at
          newest = id
        }
      }
      return newest
    }

    /**
     * The kind of interaction the agent is blocked on, if any.
     *
     * `pendingInteraction` arrives either as a bare kind string or as an object
     * carrying `kind`, depending on which UI published it, so both shapes are
     * accepted rather than betting on one.
     */
    const selectPending = snapshot => {
      if (snapshot === undefined || snapshot === null) return null
      if (typeof snapshot.values !== 'function') return null
      for (const status of snapshot.values()) {
        const interaction = status?.pendingInteraction
        if (interaction === undefined || interaction === null) continue
        const kind = typeof interaction === 'string' ? interaction : interaction.kind
        if (typeof kind === 'string' && kind !== '') return kind
      }
      return null
    }

    /**
     * Whether the harness considers a finished turn unlooked-at.
     *
     * This is the app's own notion of "done, and you have not seen it": it clears
     * when the session is opened, which is exactly when the tick should go away.
     */
    const selectUnread = snapshot => {
      if (snapshot === undefined || snapshot === null) return false
      if (typeof snapshot.values !== 'function') return false
      for (const status of snapshot.values()) {
        if (status !== undefined && status !== null && status.completionUnread === true) return true
      }
      return false
    }

    /** Stable no-op used when ui-session is absent, so the hook call stays unconditional. */
    const useNoStatus = () => false

    /**
     * Build the component against a live cordis context.
     *
     * The context is captured here rather than reached for during a click, so
     * everything the click needs is resolved against a context that is known to
     * be alive.
     */
    const makeBridge = ctx => {
      /**
       * Reach a cordis service by whichever route answers.
       *
       * `ctx.get(name)` and `ctx[name]` are not always interchangeable — a
       * context can expose a service through one and not the other, and a click
       * must not fail because the wrong one was asked.
       */
      const service = name => {
        const viaGet = typeof ctx.get === 'function' ? ctx.get(name) : undefined
        if (viaGet !== undefined) return viaGet
        try {
          return ctx[name]
        } catch {
          return undefined
        }
      }

      /**
       * The sessions-list rows, from whichever source is available.
       *
       * The `useSessions` prop is the documented route, but a click must not
       * hinge on one prop being present: the `sessions` service exposes the very
       * same snapshot (`list.getSnapshot().byId`), and that is where ui-session
       * reads it from too.
       */
      const sessionRows = fromProp => {
        if (fromProp !== undefined) return { rows: { [fromProp]: { id: fromProp } }, source: 'prop' }
        const live = service('sessions')?.list?.getSnapshot?.()
        if (live?.byId !== undefined) return { rows: live.byId, source: 'service' }
        return { rows: undefined, source: 'none' }
      }

      const openChat = fromProp => {
        const workspace = service('uiWorkspace')
        const layout = service('layout')
        const { rows } = sessionRows(fromProp)
        const sessionId = fromProp !== undefined ? fromProp : pickSession({ byId: rows })

        if (sessionId !== undefined && typeof workspace?.openSession === 'function') {
          workspace.openSession(sessionId)
          return true
        }
        // No session to pick, or no workspace service: at least bring the
        // conversation panel forward so the click still does something visible.
        if (typeof layout?.selectPanel === 'function') {
          layout.selectPanel(null)
          return true
        }
        return false
      }

      return function PetBridge(props) {
        const { useSessionStatus = useNoStatus, useSessions, usePanelInfo } = props
        const running = useSessionStatus(selectAnyRunning)
        const pending = useSessionStatus(selectPending)
        const unread = useSessionStatus(selectUnread)
        const target = useSessions === undefined ? undefined : useSessions(pickSession)

        // The poll callback outlives any single render, so the target is read
        // through a ref rather than closed over.
        const targetRef = useRef(target)
        targetRef.current = target

        /**
         * The tick stays until the user acknowledges it.
         *
         * Clicking the pet is one way, and the host clears it on `/open-chat`.
         * Reaching a conversation by any other route counts just as much, so the
         * pet watches where the user is looking. The host ignores an ack that
         * arrives when no tick is showing, which keeps this side stateless.
         */
        const panel = usePanelInfo === undefined
          ? undefined
          : usePanelInfo(info => (info?.activePanelId === undefined ? 'conversation' : info.activePanelId))
        const seenPlace = useRef(undefined)
        useEffect(() => {
          const viewing = panel === undefined || panel === null || panel === 'conversation'
          const place = `${viewing ? 'chat' : panel}|${target ?? ''}`
          if (seenPlace.current === undefined) {
            // The first render is not a navigation.
            seenPlace.current = place
            return
          }
          if (seenPlace.current === place) return
          seenPlace.current = place
          if (!viewing) return
          fetch(`${API}/ack`, { method: 'POST' })
            .catch(() => { /* the host half is absent or going away */ })
        }, [panel, target])

        const last = useRef(undefined)
        useEffect(() => {
          // One report for all three signals: they describe a single situation,
          // and sending them separately would let the pet see torn states.
          const key = `${running}|${pending ?? ''}|${unread}`
          if (last.current === key) return
          last.current = key
          fetch(`${API}/status`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ running, pending, unread }),
          }).catch(() => { /* the host half is absent or going away */ })
        }, [running, pending, unread])

        useEffect(() => {
          const id = setInterval(() => {
            fetch(`${API}/events`, { cache: 'no-store' })
              .then(response => response.json())
              .then(events => {
                if (events?.openChat === true) openChat(targetRef.current)
              })
              .catch(() => { /* nothing to do while the host half is down */ })
          }, POLL_MS)
          return () => clearInterval(id)
        }, [])

        return null
      }
    }

    /** Cordis services this browser half needs before it applies. */
    const inject = ['slots']

    function apply(ctx) {
      // `inject` waits for the slot to exist, so this is correct regardless of
      // whether ui-layout's root registration has happened yet. A list slot
      // needs its own id, and a fresh one is added beside the shipped entries.
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'dsh-pet',
        order: 100,
        label: 'Pet bridge',
      }, makeBridge(ctx)))
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'dsh-pet'
    return module.exports
  },
})

window.__ModuleLoader__.load({
  id: '@kadaliao/dsh-prompt-en',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useRef, useState } = React;

    const NS = 'prompt-en';
    const STATE_ROUTE = '/__dsh_prompt_en/state';

    const C = {
      label: 'var(--dsw-alias-brand-primary)',
      primary: 'var(--dsw-alias-label-primary)',
      muted: 'var(--dsw-alias-label-secondary)',
      faint: 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))',
      ok: 'var(--dsw-alias-state-success-primary)',
      fix: 'var(--dsw-alias-state-warn-primary)',
    };

    // --- the session's answers -------------------------------------------------

    // One poller per open Session, shared by every row it draws.
    const sessions = new Map();

    function sessionState(sessionId) {
      let state = sessions.get(sessionId);
      if (state === undefined) {
        state = {
          items: new Map(),
          listeners: new Set(),
          timer: null,
          inflight: false,
          alive: false,
        };
        sessions.set(sessionId, state);
      }
      return state;
    }

    function notify(state) {
      for (const listener of state.listeners) listener();
    }

    function load(state, sessionId) {
      if (state.inflight) return;
      state.inflight = true;
      const url = `${STATE_ROUTE}?session=${encodeURIComponent(String(sessionId))}`;
      fetch(url, { cache: 'no-store', credentials: 'same-origin' })
        .then((response) => (response.ok ? response.json() : null))
        .then((body) => {
          if (!state.alive || body === null || !Array.isArray(body.items)) return;
          const next = new Map();
          if (body.enabled === false) {
            state.items = next;
            notify(state);
            return;
          }
          for (const item of body.items) {
            if (item && typeof item === 'object') next.set(String(item.messageId ?? `${item.seq}`), item);
          }
          const changed = next.size !== state.items.size || [...next].some(([key, value]) => state.items.get(key) !== value);
          state.items = next;
          if (changed) notify(state);
        })
        .catch(() => {})
        .finally(() => {
          state.inflight = false;
          schedule(state, sessionId);
        });
    }

    function schedule(state, sessionId) {
      if (!state.alive) return;
      let pending = false;
      for (const item of state.items.values()) {
        if (item.status === 'pending') {
          pending = true;
          break;
        }
      }
      const delay = pending ? 700 : 2500;
      state.timer = setTimeout(() => {
        state.timer = null;
        load(state, sessionId);
      }, delay);
    }

    function useSessionItems(sessionId) {
      const state = sessionState(sessionId);
      const [, bump] = useState(0);
      useEffect(() => {
        const listener = () => bump((n) => n + 1);
        state.listeners.add(listener);
        state.alive = true;
        if (state.timer === null && !state.inflight) load(state, sessionId);
        else notify(state);
        return () => {
          state.listeners.delete(listener);
          if (state.listeners.size === 0) {
            state.alive = false;
            if (state.timer !== null) {
              clearTimeout(state.timer);
              state.timer = null;
            }
          }
        };
      }, [sessionId]);
      return state;
    }

    // --- drawing -----------------------------------------------------------------

    const cells = (s) => s.length;
    const fmtChars = (n) => (n < 1000 ? `${n}` : `${Math.round(n / 100) / 10}k`);

    const textStyle = {
      fontSize: 'var(--dsh-content-font-size-secondary, 12.5px)',
      lineHeight: 'calc(19px + var(--dsh-content-font-delta-secondary, 0px))',
      color: C.muted,
      minWidth: 0,
      wordBreak: 'break-word',
      whiteSpace: 'pre-wrap',
      userSelect: 'text',
    };

    function RunText({ runs }) {
      return h(
        'span',
        null,
        runs.map((run, i) =>
          run.isNew ? h('span', { key: i, style: { color: C.ok } }, run.text) : h('span', { key: i }, run.text),
        ),
      );
    }

    function Alts({ alts }) {
      const parts = [];
      alts.forEach((alt, i) => {
        if (i > 0) parts.push(h('span', { key: `sep-${i}`, style: { color: C.faint } }, ' · '));
        parts.push(h('span', { key: `alt-${i}` }, i === 0 ? `also ${alt}` : alt));
      });
      return h('span', null, parts);
    }

    function beacon(payload) {
      try {
        fetch('/__dsh_prompt_en/debug', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          keepalive: true,
        }).catch(() => {});
      } catch {
        // Diagnostics never break the row.
      }
    }

    function PromptEnRow({ node, sessionId, t: translate }) {
      const t =
        typeof translate === 'function'
          ? translate
          : (key, params) => {
              const template = DICTIONARY.en[key] ?? key;
              if (!params) return template;
              return template.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? ''));
            };
      const data = node.data ?? {};
      const messageId = String(data.messageId ?? '');
      const state = useSessionItems(sessionId);
      const [expanded, setExpanded] = useState(false);
      const ref = useRef(null);
      const reported = useRef(null);

      const item = state.items.get(messageId) ?? state.items.get(String(data.seq));

      useEffect(() => {
        const key = `${messageId}:${item?.status ?? 'miss'}`;
        if (reported.current === key) return;
        reported.current = key;
        const el = ref.current;
        const chain = [];
        let up = el;
        for (let i = 0; up && i < 9; i += 1, up = up.parentElement) {
          let display = '';
          let visibility = '';
          let h = 0;
          try {
            const cs = window.getComputedStyle(up);
            display = cs.display;
            visibility = cs.visibility;
            h = Math.round(up.getBoundingClientRect().height);
          } catch {
            // A detached ancestor still names itself.
          }
          chain.push({
            tag: up.tagName,
            cls: String(up.className ?? '').slice(0, 80),
            display,
            visibility,
            h,
            hidden: up.getAttribute('aria-hidden') ?? undefined,
          });
        }
        let rect = null;
        try {
          const box = el?.getBoundingClientRect();
          if (box) rect = { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) };
        } catch {
          // No box for a null element.
        }
        beacon({
          kind: 'row',
          sessionId: String(sessionId ?? ''),
          messageId,
          seq: data.seq,
          hasItem: item !== undefined,
          status: item?.status ?? null,
          rendered: el !== null,
          text: String(el?.innerText ?? '').slice(0, 140),
          rect,
          chain,
          rows: typeof document === 'undefined' ? 0 : document.querySelectorAll('[data-dsh-prompt-en]').length,
          viewport: { w: window.innerWidth ?? 0, h: window.innerHeight ?? 0 },
        });
      }, [item?.status, messageId, expanded]);

      if (item === undefined) return null;

      const isReview = item.kind === 'review';
      const isDone = item.status === 'done';
      const isPending = item.status === 'pending';

      const glyph = !isReview || !isDone ? null : item.verdict === 'ok' ? '✓' : '✎';
      const glyphColor = item.verdict === 'fix' ? C.fix : item.verdict === 'polish' ? C.label : C.ok;

      const label = h(
        'span',
        { style: { color: isDone ? C.label : C.faint, fontWeight: 600, flex: 'none' } },
        t('label'),
        glyph !== null ? h('span', { key: 'glyph', style: { color: glyphColor } }, ` ${glyph}`) : null,
      );

      let body;
      if (isPending) {
        const doing = isReview ? t('reviewing') : item.isCondensed ? t('condensing') : t('translating');
        body = h('span', { style: { fontStyle: 'italic', color: C.faint } }, doing);
      } else if (!isDone) {
        const what = isReview ? t('noReview') : t('noTranslation');
        body = h('span', { style: { color: C.faint } }, `${what} (${item.reason ?? 'unknown'})`);
      } else if (!isReview) {
        body = h(
          'span',
          null,
          item.text,
          item.isCondensed
            ? h('span', { style: { color: C.faint } }, ` · ${t('gist', { chars: fmtChars(item.sourceChars ?? 0) })}`)
            : null,
        );
      } else if (item.verdict === 'ok') {
        const alts = item.alts ?? [];
        body = alts.length === 0 ? h('span', { style: { color: C.faint } }, t('readsNaturally')) : h(Alts, { alts });
      } else if (!item.text) {
        const fixes = item.fixes ?? (item.note ? [item.note] : []);
        const parts = [];
        fixes.forEach((fix, i) => {
          if (i > 0) parts.push(h('span', { key: `sep-${i}`, style: { color: C.faint } }, ' · '));
          parts.push(h('span', { key: `fix-${i}` }, fix));
        });
        body = h('span', null, parts);
      } else {
        body = h(
          'span',
          null,
          item.runs && item.runs.length > 0 ? h(RunText, { runs: item.runs }) : item.text,
          item.note ? h('span', { style: { color: C.faint } }, ` · ${item.note}`) : null,
        );
      }

      const long = isDone && !isPending && (item.text ?? '').length > 240;
      const clampStyle = long && !expanded
        ? {
            display: '-webkit-box',
            WebkitLineClamp: 4,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }
        : null;

      return h(
        'div',
        {
          ref,
          'data-dsh-prompt-en': true,
          style: {
            display: 'flex',
            justifyContent: 'flex-end',
            padding: '1px 0 2px',
          },
        },
        h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'baseline',
              columnGap: 8,
              maxWidth: 'min(calc(var(--dsh-chat-content-width, 748px) * 0.702), 82%)',
              minWidth: 0,
              paddingRight: 2,
            },
          },
          label,
          h(
            'div',
            {
              style: { ...textStyle, ...(clampStyle ?? {}) },
              title: long && !expanded ? item.text : undefined,
              onClick: long ? () => setExpanded((v) => !v) : undefined,
              role: long ? 'button' : undefined,
              tabIndex: long ? 0 : undefined,
              onKeyDown: long
                ? (event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      setExpanded((v) => !v);
                    }
                  }
                : undefined,
            },
            body,
          ),
          long
            ? h(
                'button',
                {
                  key: 'more',
                  type: 'button',
                  onClick: () => setExpanded((v) => !v),
                  style: {
                    flex: 'none',
                    border: 'none',
                    background: 'none',
                    padding: 0,
                    cursor: 'pointer',
                    color: C.faint,
                    font: 'inherit',
                    fontSize: '11px',
                    lineHeight: '16px',
                  },
                },
                expanded ? t('less') : t('more'),
              )
            : null,
        ),
      );
    }

    // --- the conversation row ----------------------------------------------------

    // One row per human prompt, anchored just after that prompt's own row.
    const promptEnDefinition = {
      kind: 'prompt-en',
      target: 'chat',
      match: (event) =>
        event.type === 'user/message' &&
        event.surfaceOp === 'append' &&
        event.data?.source?.kind === 'user'
          ? { id: String(event.data.id), role: 'start' }
          : null,
      start: (_context, match) => ({
        messageId: String(match.event.data.id),
        seq: match.event.seq,
        time: match.event.time,
      }),
      update: (context) => context.state,
      buildViewNode: (context) => {
        if (context.state === undefined) return null;
        return {
          key: context.key,
          kind: 'prompt-en',
          id: context.id,
          target: 'chat',
          // A fraction after the prompt keeps this row below it and before the turn.
          anchorSeq: context.state.seq + 0.1,
          location: context.start.location,
          visibility: 'visible',
          // Stay at input level so the Turn-process fold never hides this row.
          groupTree: 'input',
          data: context.state,
        };
      },
    };

    const DICTIONARY = {
      en: {
        label: 'EN',
        translating: 'translating…',
        condensing: 'condensing…',
        reviewing: 'reviewing…',
        noTranslation: 'no translation',
        noReview: 'no review',
        readsNaturally: 'reads naturally',
        gist: 'gist of {chars} chars',
        more: 'more',
        less: 'less',
      },
      zh: {
        label: 'EN',
        translating: '翻译中…',
        condensing: '压缩中…',
        reviewing: '审阅中…',
        noTranslation: '没有译文',
        noReview: '没有审阅',
        readsNaturally: '表达自然',
        gist: '要点，原文 {chars} 字符',
        more: '展开',
        less: '收起',
      },
    };

    return {
      inject: ['uiConversation', 'slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, DICTIONARY), 'prompt-en: dictionaries');
        ctx.uiConversation.events.register(promptEnDefinition);
        ctx.slots.inject('conversation.chat.node', () =>
          ctx.slots.register(
            {
              name: 'conversation.chat.node',
              key: 'prompt-en',
              locale: NS,
            },
            PromptEnRow,
          ),
        );
      },
    };
  },
});

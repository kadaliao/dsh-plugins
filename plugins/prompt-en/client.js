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
      const t = typeof translate === 'function' ? translate : fallbackT;
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

    // --- the vocabulary book -------------------------------------------------------

    const VOCAB_ROUTE = '/__dsh_prompt_en/vocab';
    const VOCAB_LIST_ROUTE = '/__dsh_prompt_en/vocab/list';
    const VOCAB_GRADE_ROUTE = '/__dsh_prompt_en/vocab/grade';
    const VOCAB_DROP_ROUTE = '/__dsh_prompt_en/vocab/drop';
    const VOCAB_IMPORT_ROUTE = '/__dsh_prompt_en/vocab/import';
    const VOCAB_NOTICE_ROUTE = '/__dsh_prompt_en/vocab/notice';

    // The sidebar tab's identity and the kind `openTab` names; namespaced, since a
    // kind that collides with another registration throws.
    const VOCAB_TAB_ID = '@kadaliao/dsh-prompt-en/vocab';
    const VOCAB_TAB_KIND = 'prompt-en-vocab';
    const GUIDE_ORDER = 40;
    // A forgotten card comes round again in the sitting while it has room.
    const PER_SITTING = 20;
    const BOXES = 6;
    const DAY_MS = 86_400_000;

    // The product's own controls when this harness serves them; plain ones otherwise.
    let primitives = null;
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    } catch {
      primitives = null;
    }

    const getJson = (url) =>
      fetch(url, { cache: 'no-store', credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null));
    const postJson = (url, body) =>
      fetch(url, {
        method: 'POST',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      }).then((r) => (r.ok ? r.json() : null));

    // Set by `/vocab`, so the tab it opens takes the keyboard.
    let wantFocus = false;

    function fmtWhen(t, due, now) {
      const ms = due - now;
      if (ms <= 0) return t('vocab.now');
      if (ms < 3_600_000) return t('vocab.inMinutes', { n: Math.max(1, Math.round(ms / 60_000)) });
      if (ms < DAY_MS) return t('vocab.inHours', { n: Math.round(ms / 3_600_000) });
      return t('vocab.inDays', { n: Math.round(ms / DAY_MS) });
    }

    const meter = (box) => '●'.repeat(box) + '○'.repeat(Math.max(0, BOXES - box));

    // Where `words` stand in `text`, spacing and case aside, or null.
    function locate(text, words) {
      const parts = String(words ?? '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
      if (parts.length === 0) return null;
      const m = new RegExp(parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'), 'i').exec(text);
      return m ? { at: m.index, end: m.index + m[0].length } : null;
    }

    function VocabIcon({ size = 20, className }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          className,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: 'M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z' }),
        h('path', { d: 'M4 20.5A2.5 2.5 0 0 0 6.5 23H20v-5' }),
        h('path', { d: 'M8.5 8h7M8.5 11.5h5' }),
      );
    }

    function PlainButton({ onClick, children, hotkey, primary = false, dim = false, disabled = false }) {
      // The hint takes the button's own color, dimmed, so it reads on a dark button too.
      const label = hotkey ? [children, h('span', { key: 'k', style: { opacity: 0.55, marginLeft: 6, fontSize: 11 } }, hotkey)] : children;
      const Button = primitives?.Button;
      if (typeof Button === 'function') {
        return h(Button, { variant: primary ? 'primary' : 'outline', size: 'sm', onClick, disabled, type: 'button' }, label);
      }
      return h(
        'button',
        {
          type: 'button',
          onClick,
          disabled,
          style: {
            font: 'inherit',
            fontSize: 12.5,
            padding: '4px 10px',
            borderRadius: 8,
            cursor: disabled ? 'default' : 'pointer',
            border: '1px solid var(--dsw-alias-border-primary, rgba(127,127,127,.35))',
            background: primary ? C.label : 'transparent',
            color: primary ? 'var(--dsw-alias-label-on-brand, #fff)' : dim ? C.faint : C.primary,
          },
        },
        label,
      );
    }

    // One row of a card: a dim label, then the body, as two cells of the card's grid
    // (the labels take the width of the longest). Given `words`, a dim body marks them
    // where they stand in it, bold, or green for the English answer. `gap` sets the
    // row apart from the one above.
    function CardRow({ label, body, dim = false, words, isAnswer = false, gap = false, children }) {
      const hit = dim && words !== undefined ? locate(body ?? '', words) : null;
      let content;
      if (children !== undefined) content = children;
      else if (hit === null) content = h('span', { style: { color: dim ? C.muted : C.primary } }, body);
      else {
        content = [
          hit.at > 0 ? h('span', { key: 'b', style: { color: C.muted } }, body.slice(0, hit.at)) : null,
          h(
            'span',
            { key: 'm', style: { fontWeight: 600, color: isAnswer ? C.ok : C.primary } },
            body.slice(hit.at, hit.end),
          ),
          hit.end < body.length ? h('span', { key: 'a', style: { color: C.muted } }, body.slice(hit.end)) : null,
        ];
      }
      const top = gap ? { marginTop: 10 } : null;
      return h(
        React.Fragment ?? 'div',
        null,
        h('span', { style: { color: C.faint, fontSize: 12, whiteSpace: 'nowrap', lineHeight: 'inherit', ...top } }, label),
        h(
          'div',
          { style: { minWidth: 0, wordBreak: 'break-word', whiteSpace: 'pre-wrap', userSelect: 'text', ...top } },
          content,
        ),
      );
    }

    const cardGrid = {
      display: 'grid',
      gridTemplateColumns: 'max-content minmax(0, 1fr)',
      columnGap: 14,
      rowGap: 6,
      alignItems: 'baseline',
    };

    function VocabPane(props) {
      const t = typeof props.t === 'function' ? props.t : fallbackT;
      const info = typeof props.useTabInfo === 'function' ? props.useTabInfo() : null;
      const visible = info?.tab?.visible !== false;
      const [view, setView] = useState('review');
      const [quiz, setQuiz] = useState(null);
      const [list, setList] = useState(null);
      const [importing, setImporting] = useState(null);
      const [failed, setFailed] = useState(false);
      const ref = useRef(null);
      const alive = useRef(true);
      const quizRef = useRef(null);
      quizRef.current = quiz;

      const begin = (ahead) => {
        getJson(`${VOCAB_ROUTE}${ahead ? '?ahead=1' : ''}`)
          .then((body) => {
            if (!alive.current) return;
            if (body === null || !Array.isArray(body.cards)) {
              setFailed(true);
              return;
            }
            setFailed(false);
            setImporting(body.importing ?? null);
            setQuiz({
              cards: body.cards,
              index: 0,
              isRevealed: false,
              tally: { again: 0, hard: 0, good: 0 },
              deckSize: body.deckSize ?? body.cards.length,
              nextDue: body.nextDue,
              now: body.now ?? Date.now(),
              collect: body.collect !== false,
            });
          })
          .catch(() => alive.current && setFailed(true));
      };
      const loadList = () => {
        getJson(VOCAB_LIST_ROUTE)
          .then((body) => {
            if (!alive.current || body === null) return;
            setImporting(body.importing ?? null);
            setList(body);
          })
          .catch(() => {});
      };

      useEffect(() => {
        alive.current = true;
        return () => {
          alive.current = false;
        };
      }, []);

      // A sitting starts when the tab shows and none is under way.
      useEffect(() => {
        if (!visible) return;
        const q = quizRef.current;
        if (q === null || q.index >= q.cards.length) begin(false);
        if (wantFocus) {
          wantFocus = false;
          ref.current?.focus?.();
        }
      }, [visible]);

      // While an import runs, its progress; when it ends, the book as it now stands.
      useEffect(() => {
        if (importing === null || !visible) return undefined;
        const timer = setTimeout(() => {
          getJson(VOCAB_ROUTE)
            .then((body) => {
              if (!alive.current || body === null) return;
              setImporting(body.importing ?? null);
              if (body.importing === null) {
                if (view === 'list') loadList();
                const q = quizRef.current;
                if (q === null || q.index >= q.cards.length) begin(false);
              }
            })
            .catch(() => {});
        }, 1500);
        return () => clearTimeout(timer);
      }, [importing, visible, view]);

      const card = quiz?.cards[quiz.index];

      const reveal = () => setQuiz((q) => (q && q.cards[q.index] ? { ...q, isRevealed: true } : q));
      const grade = (g) => {
        const q = quizRef.current;
        const current = q?.cards[q.index];
        if (!q || !current || !q.isRevealed) return;
        const isRetry = g === 'again' && q.cards.length < PER_SITTING * 2;
        setQuiz({
          ...q,
          cards: isRetry ? [...q.cards, current] : q.cards,
          index: q.index + 1,
          isRevealed: false,
          tally: { ...q.tally, [g]: q.tally[g] + 1 },
        });
        void postJson(VOCAB_GRADE_ROUTE, { id: current.id, grade: g }).catch(() => {});
      };
      const drop = () => {
        const q = quizRef.current;
        const current = q?.cards[q.index];
        if (!q || !current) return;
        setQuiz({
          ...q,
          cards: q.cards.filter((c, i) => i <= q.index || c.id !== current.id),
          index: q.index + 1,
          isRevealed: false,
          deckSize: Math.max(0, q.deckSize - 1),
        });
        void postJson(VOCAB_DROP_ROUTE, { id: current.id }).catch(() => {});
      };
      const startImport = () => {
        postJson(VOCAB_IMPORT_ROUTE, {})
          .then((body) => {
            if (!alive.current || body === null) return;
            setImporting(body.importing ?? { done: 0, total: 0 });
            wakeNotices();
          })
          .catch(() => {});
      };
      const showList = () => {
        setView('list');
        loadList();
      };

      const onKeyDown = (event) => {
        const tag = event.target?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || event.target?.isContentEditable) return;
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        const key = event.key;
        let handled = true;
        if (view !== 'review' || !quiz) handled = false;
        else if (card === undefined) {
          if (key === 'm' && quiz.deckSize > 0) begin(true);
          else handled = false;
        } else if (!quiz.isRevealed) {
          if (key === 'f' || key === ' ' || key === 'Enter') reveal();
          else handled = false;
        } else if (key === '1') grade('again');
        else if (key === '2') grade('hard');
        else if (key === '3' || key === 'Enter') grade('good');
        else if (key === 'x') drop();
        else handled = false;
        if (handled) event.preventDefault();
      };

      // --- what the tab shows ---
      const header = (extra) =>
        h(
          'div',
          { style: { display: 'flex', alignItems: 'baseline', columnGap: 8, flexWrap: 'wrap' } },
          h('span', { style: { color: C.label, fontWeight: 600 } }, t('vocab.title')),
          extra ? h('span', { style: { color: C.faint, fontSize: 12 } }, extra) : null,
        );

      const toolbar = h(
        'div',
        {
          style: {
            display: 'flex',
            columnGap: 8,
            rowGap: 6,
            flexWrap: 'wrap',
            alignItems: 'center',
            borderTop: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.2))',
            paddingTop: 10,
            marginTop: 'auto',
          },
        },
        view === 'review'
          ? h(PlainButton, { key: 'list', onClick: showList, dim: true }, t('vocab.list'))
          : h(PlainButton, { key: 'review', onClick: () => { setView('review'); begin(false); }, dim: true }, t('vocab.review')),
        importing !== null
          ? h(
              'span',
              { key: 'importing', style: { color: C.faint, fontSize: 12 } },
              importing.total > 0 ? t('vocab.importing', { done: importing.done, total: importing.total }) : t('vocab.importStarting'),
            )
          : h(PlainButton, { key: 'import', onClick: startImport, dim: true }, t('vocab.import')),
      );

      let body;
      if (failed) body = h('div', { style: { color: C.faint } }, t('vocab.unavailable'));
      else if (view === 'list') {
        if (list === null) body = h('div', { style: { color: C.faint } }, '…');
        else if (list.cards.length === 0) body = h('div', { style: { color: C.muted } }, t('vocab.empty'));
        else {
          body = h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', rowGap: 8 } },
            header(t('vocab.listHead', { size: list.deckSize, due: list.due })),
            h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', rowGap: 4 } },
              list.cards.map((c) =>
                h(
                  'div',
                  { key: c.id, style: { display: 'flex', columnGap: 10, alignItems: 'baseline', minWidth: 0 } },
                  h('span', { style: { color: C.label, flex: 'none', fontSize: 10, letterSpacing: 1 }, title: t('vocab.boxTitle', { box: c.box }) }, meter(c.box)),
                  h(
                    'span',
                    { style: { minWidth: 0, wordBreak: 'break-word', color: C.primary } },
                    c.kind === 'pattern' && c.cue.length > 24 ? `${c.cue.slice(0, 23)}…` : c.cue,
                    h('span', { style: { color: C.faint } }, ' → '),
                    h('span', { style: { color: c.kind === 'pattern' ? C.label : C.ok } }, c.kind === 'pattern' ? c.pattern : c.answer),
                    c.why ? h('span', { style: { color: C.faint } }, ` · ${c.why}`) : null,
                    c.seen > 1 ? h('span', { style: { color: C.faint } }, ` ×${c.seen}`) : null,
                  ),
                ),
              ),
            ),
            list.deckSize > list.cards.length
              ? h('div', { style: { color: C.faint, fontSize: 12 } }, t('vocab.listMore', { n: list.deckSize - list.cards.length }))
              : null,
          );
        }
      } else if (quiz === null) body = h('div', { style: { color: C.faint } }, '…');
      else if (quiz.deckSize === 0 && quiz.cards.length === 0) {
        body = h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', rowGap: 10 } },
          header(),
          h('div', { style: { color: C.muted } }, quiz.collect ? t('vocab.empty') : t('vocab.off')),
        );
      } else if (card === undefined) {
        const { again, hard, good } = quiz.tally;
        const did = again + hard + good;
        const summary =
          did === 0
            ? quiz.nextDue
              ? t('vocab.noneDueNext', { size: quiz.deckSize, when: fmtWhen(t, quiz.nextDue, quiz.now) })
              : t('vocab.noneDue', { size: quiz.deckSize })
            : t('vocab.sittingDone', { good, hard, again });
        body = h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', rowGap: 12 } },
          header(),
          h('div', { style: { color: C.primary } }, summary),
          quiz.deckSize > 0
            ? h('div', null, h(PlainButton, { onClick: () => begin(true), hotkey: 'm' }, t('vocab.more')))
            : null,
        );
      } else {
        const isFix = card.kind === 'fix';
        const isPattern = card.kind === 'pattern';
        const progress = t('vocab.progress', { at: quiz.index + 1, total: quiz.cards.length, size: quiz.deckSize });
        const seen = card.seen > 1 ? ` · ${t('vocab.seen', { n: card.seen })}` : '';
        body = h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', rowGap: 14 } },
          header(`${progress}${seen}`),
          h(
            'div',
            { style: cardGrid },
            h(CardRow, { label: isFix ? t('vocab.youWrote') : t('vocab.yourWords'), body: card.cue }),
            card.context !== undefined
              ? h(CardRow, { label: isPattern ? t('vocab.from') : t('vocab.context'), body: card.context, dim: true, words: card.cue })
              : null,
            quiz.isRevealed
              ? h(
                  CardRow,
                  { label: isFix ? t('vocab.better') : t('vocab.english'), gap: true },
                  h('span', { style: { color: C.ok, fontWeight: 600 } }, card.answer),
                  card.why !== undefined ? h('span', { style: { color: C.faint } }, ` · ${card.why}`) : null,
                )
              : null,
            quiz.isRevealed && isPattern && card.pattern !== undefined
              ? h(CardRow, { label: t('vocab.pattern') }, h('span', { style: { color: C.label } }, card.pattern))
              : null,
            quiz.isRevealed && card.example !== undefined
              ? h(CardRow, { label: t('vocab.example'), body: card.example, dim: true, words: card.answer, isAnswer: true })
              : null,
          ),
          quiz.isRevealed
            ? h(
                'div',
                { style: { display: 'flex', columnGap: 8, rowGap: 8, flexWrap: 'wrap' } },
                h(PlainButton, { key: 'again', onClick: () => grade('again'), hotkey: '1' }, t('vocab.again')),
                h(PlainButton, { key: 'hard', onClick: () => grade('hard'), hotkey: '2' }, t('vocab.hard')),
                h(PlainButton, { key: 'good', onClick: () => grade('good'), hotkey: '3', primary: true }, t('vocab.good')),
                h(PlainButton, { key: 'drop', onClick: drop, hotkey: 'x', dim: true }, t('vocab.drop')),
              )
            : h('div', null, h(PlainButton, { key: 'reveal', onClick: reveal, hotkey: 'f', primary: true }, t('vocab.reveal'))),
        );
      }

      return h(
        'div',
        {
          ref,
          tabIndex: -1,
          onKeyDown,
          'data-dsh-prompt-en-vocab': true,
          style: {
            display: 'flex',
            flexDirection: 'column',
            rowGap: 16,
            height: '100%',
            boxSizing: 'border-box',
            padding: '16px 16px 12px',
            overflowY: 'auto',
            outline: 'none',
            fontSize: 'var(--dsh-content-font-size, 13.5px)',
            lineHeight: 1.6,
            color: C.primary,
          },
        },
        body,
        toolbar,
      );
    }

    // --- notices: import done, cards due -------------------------------------------

    let lastNotice = 0;
    const noticeListeners = new Set();
    // Ask again now, and keep asking often while an import runs.
    function wakeNotices() {
      for (const listener of noticeListeners) listener();
    }

    function FallbackToast({ text, onDone }) {
      useEffect(() => {
        const timer = setTimeout(onDone, 6000);
        return () => clearTimeout(timer);
      }, [text]);
      return h(
        'div',
        {
          role: 'status',
          style: {
            position: 'fixed',
            top: 16,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 1000,
            maxWidth: 'min(560px, calc(100vw - 32px))',
            padding: '8px 14px',
            borderRadius: 10,
            fontSize: 13,
            background: 'var(--dsw-alias-bg-elevated, rgba(30,30,30,.92))',
            color: 'var(--dsw-alias-label-primary, #fff)',
            boxShadow: '0 4px 16px rgba(0,0,0,.18)',
          },
        },
        text,
      );
    }

    function VocabNotice() {
      const [queue, setQueue] = useState([]);
      useEffect(() => {
        let timer = null;
        let stopped = false;
        let importing = false;
        const poll = () => {
          timer = null;
          if (stopped) return;
          if (typeof document !== 'undefined' && document.hidden) {
            schedule();
            return;
          }
          getJson(`${VOCAB_NOTICE_ROUTE}?after=${lastNotice}`)
            .then((body) => {
              if (stopped || body === null) return;
              importing = body.importing !== null && body.importing !== undefined;
              const fresh = (body.notices ?? []).filter((n) => n.id > lastNotice);
              if (typeof body.latest === 'number') lastNotice = Math.max(lastNotice, body.latest);
              if (fresh.length > 0) setQueue((q) => [...q, ...fresh]);
            })
            .catch(() => {})
            .finally(schedule);
        };
        const schedule = () => {
          if (stopped || timer !== null) return;
          timer = setTimeout(poll, importing ? 3000 : 60_000);
        };
        const wake = () => {
          if (timer !== null) clearTimeout(timer);
          importing = true;
          timer = setTimeout(poll, 500);
        };
        noticeListeners.add(wake);
        // Let the page settle before the first reminder.
        timer = setTimeout(poll, 3000);
        return () => {
          stopped = true;
          noticeListeners.delete(wake);
          if (timer !== null) clearTimeout(timer);
        };
      }, []);

      const shown = queue[0];
      if (shown === undefined) return null;
      const onDone = () => setQueue((q) => q.slice(1));
      const Toast = typeof primitives?.Toast === 'function' ? primitives.Toast : FallbackToast;
      return h(Toast, { key: shown.id, text: shown.text, onDone });
    }

    /** Open the vocabulary tab on the right Sidebar; false where there is none. */
    function openVocab(ctx) {
      try {
        const face = ctx.get?.('sidebarRight');
        if (!face || typeof face.openTab !== 'function') return false;
        wantFocus = true;
        face.openTab.call(face, VOCAB_TAB_KIND);
        return true;
      } catch {
        return false;
      }
    }

    /**
     * The vocabulary tab, its guide entry, and the bare `/vocab` that opens it. Both
     * ride deferred injects: a harness without a right Sidebar or client commands
     * keeps the translation rows and leaves `/vocab` to the host.
     */
    function registerVocab(ctx, tr) {
      if (typeof ctx.inject !== 'function') return;
      ctx.inject(['sidebarRightTabs'], (scope) => {
        const tabs = scope.sidebarRightTabs;
        if (tabs === undefined || typeof tabs.register !== 'function') return undefined;
        const disposers = [];
        const own = (result) => {
          if (typeof result === 'function') disposers.push(result);
        };
        try {
          own(
            tabs.register({
              id: VOCAB_TAB_ID,
              kind: VOCAB_TAB_KIND,
              title: () => tr('vocab.title'),
              guide: [
                {
                  order: GUIDE_ORDER,
                  title: () => tr('vocab.title'),
                  description: () => tr('vocab.guide'),
                  icon: VocabIcon,
                },
              ],
            }),
          );
          own(
            scope.slots.inject('sidebar.right.pane.tab', () =>
              scope.slots.register({ name: 'sidebar.right.pane.tab', key: VOCAB_TAB_ID, locale: NS }, VocabPane),
            ),
          );
        } catch {
          for (const dispose of disposers) dispose();
          return undefined;
        }
        return () => {
          for (const dispose of disposers) dispose();
        };
      });
      ctx.inject(['commandUi'], (scope) => {
        scope.effect(
          () =>
            scope.commandUi.decorate({
              name: 'vocab',
              available: () => typeof ctx.get?.('sidebarRight')?.openTab === 'function',
              ui: { kind: 'action', run: () => void openVocab(ctx) },
            }),
          'prompt-en: /vocab opens the vocabulary tab',
        );
      });
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
        'vocab.title': 'Vocabulary',
        'vocab.guide': 'Review the English prompt-en taught you',
        'vocab.youWrote': 'You wrote',
        'vocab.yourWords': 'Yours',
        'vocab.context': 'Sentence',
        'vocab.from': 'From',
        'vocab.better': 'Better',
        'vocab.english': 'English',
        'vocab.pattern': 'Pattern',
        'vocab.example': 'Example',
        'vocab.reveal': 'Show answer',
        'vocab.again': 'Forgot',
        'vocab.hard': 'Unsure',
        'vocab.good': 'Knew it',
        'vocab.drop': 'Drop card',
        'vocab.more': 'A few more',
        'vocab.progress': '{at} / {total} · {size} in the book',
        'vocab.seen': 'seen {n} times',
        'vocab.sittingDone': 'Sitting done: knew {good} · unsure {hard} · forgot {again}.',
        'vocab.noneDue': 'Nothing to review today. {size} in the book.',
        'vocab.noneDueNext': 'Nothing to review today. {size} in the book; the next is due {when}.',
        'vocab.now': 'now',
        'vocab.inMinutes': 'in {n} min',
        'vocab.inHours': 'in {n} h',
        'vocab.inDays': 'in {n} days',
        'vocab.empty': 'The vocabulary book is empty. The corrections prompt-en makes to your English, and the phrases and patterns worth learning in its translations, are filed here as you go. Import files the prompts from before.',
        'vocab.off': 'The vocabulary book is off (collectVocab: false).',
        'vocab.list': 'List',
        'vocab.review': 'Review',
        'vocab.import': 'Import earlier prompts',
        'vocab.importStarting': 'Importing…',
        'vocab.importing': 'Importing {done} / {total}',
        'vocab.listHead': '{size} cards, {due} due',
        'vocab.listMore': '… and {n} more',
        'vocab.boxTitle': 'Box {box} of 6',
        'vocab.unavailable': 'The vocabulary book is not reachable. Refresh the page, or check the plugin is enabled.',
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
        'vocab.title': '生词本',
        'vocab.guide': '复习 prompt-en 教过你的英文',
        'vocab.youWrote': '你写的',
        'vocab.yourWords': '中文',
        'vocab.context': '原句',
        'vocab.from': '出自',
        'vocab.better': '更地道',
        'vocab.english': '英文',
        'vocab.pattern': '句型',
        'vocab.example': '例句',
        'vocab.reveal': '显示答案',
        'vocab.again': '忘了',
        'vocab.hard': '模糊',
        'vocab.good': '记得',
        'vocab.drop': '删掉这张',
        'vocab.more': '再练几张',
        'vocab.progress': '{at} / {total} · 共 {size} 条',
        'vocab.seen': '第 {n} 次遇到',
        'vocab.sittingDone': '这一轮复习完了：记得 {good} · 模糊 {hard} · 忘了 {again}。',
        'vocab.noneDue': '今天没有要复习的。共 {size} 条。',
        'vocab.noneDueNext': '今天没有要复习的。共 {size} 条，下一条 {when}到期。',
        'vocab.now': '现在',
        'vocab.inMinutes': '{n} 分钟后',
        'vocab.inHours': '{n} 小时后',
        'vocab.inDays': '{n} 天后',
        'vocab.empty': '生词本还是空的。prompt-en 纠正或润色过的英文说法，和中文 prompt 译文里的地道表达、句型，会自动收进来。点「导入以前的」可以把以前的也导进来。',
        'vocab.off': '生词本已关闭（collectVocab: false）。',
        'vocab.list': '列表',
        'vocab.review': '复习',
        'vocab.import': '导入以前的',
        'vocab.importStarting': '导入中…',
        'vocab.importing': '导入中 {done} / {total}',
        'vocab.listHead': '共 {size} 条，{due} 条到期',
        'vocab.listMore': '… 还有 {n} 条',
        'vocab.boxTitle': '第 {box} 格，共 6 格',
        'vocab.unavailable': '连不上生词本。刷新页面，或确认插件已启用。',
      },
    };

    /** The English dictionary, for a seat that brought no `t`. */
    function fallbackT(key, params) {
      const template = DICTIONARY.en[key] ?? key;
      if (!params) return template;
      return template.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? ''));
    }

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
        // Toasts that outlive any one panel: an import done, cards due.
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'prompt-en.vocab-notice', locale: NS }, VocabNotice),
        );
        let bound = null;
        const tr = (key, params) => {
          try {
            if (bound === null && typeof ctx.locale.bind === 'function') bound = ctx.locale.bind(NS);
            if (typeof bound === 'function') return bound(key, params);
          } catch {
            // The English below.
          }
          return fallbackT(key, params);
        };
        registerVocab(ctx, tr);
      },
    };
  },
});

window.__ModuleLoader__.load({
  id: '@kadaliao/dsh-bots',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useRef, useState } = React;
    let ReactDOM = null;
    try {
      ReactDOM = require('react-dom');
    } catch {
      ReactDOM = null;
    }
    // The product's own Markdown renderer (the main chat's) when the shell serves it.
    let primitives = null;
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    } catch {
      primitives = null;
    }

    const NS = 'bots';
    const PANEL_ID = 'bots';
    const R = '/__dsh_bots/';
    const STATE_POLL_MS = 5000;
    const CHAT_POLL_MS = 3000;
    const SCHEDULE_POLL_MS = 10000;
    const TOOL_NAMES = ['bot_send_message', 'bot_create', 'bot_update', 'bot_delete', 'bot_list', 'bot_schedule'];

    const C = {
      base: 'var(--dsw-alias-bg-base)',
      layer1: 'var(--dsw-alias-bg-layer-1)',
      layer2: 'var(--dsw-alias-bg-layer-2)',
      layer3: 'var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-2))',
      border: 'var(--dsw-alias-border-l2, rgba(127,127,127,.25))',
      border1: 'var(--dsw-alias-border-l1, rgba(127,127,127,.15))',
      label: 'var(--dsw-alias-brand-primary)',
      primary: 'var(--dsw-alias-label-primary)',
      muted: 'var(--dsw-alias-label-secondary)',
      faint: 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))',
      hover: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12))',
      error: 'var(--dsw-alias-state-error-primary, #f25a5a)',
      ok: 'var(--dsw-alias-state-success-primary, #22c55e)',
      warn: 'var(--dsw-alias-state-warn-primary, #f59e0b)',
    };
    const FONT = 'var(--dsh-content-font-size, 13.5px)';
    const SMALL = 'var(--dsh-content-font-size-secondary, 12.5px)';
    const TINY = '11.5px';
    const tint = (color, pct) => `color-mix(in srgb, ${color} ${pct}%, transparent)`;

    const COLORS = ['#7c5cff', '#3b82f6', '#06b6d4', '#10b981', '#84cc16', '#f59e0b', '#f97316', '#ef4444', '#ec4899', '#64748b'];
    const PERSONAS = [
      { id: 'researcher', color: '#3b82f6' },
      { id: 'coder', color: '#10b981' },
      { id: 'writer', color: '#ec4899' },
      { id: 'analyst', color: '#f59e0b' },
      { id: 'ops', color: '#64748b' },
      { id: 'custom', color: '#7c5cff' },
    ];
    const HANDLE_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
    const SERVER_RE = /^[A-Za-z0-9_-]{1,32}$/;

    // --- initials (the same rules as the Host's lib/store.mjs) ------------------------------

    const PINYIN_BOUNDS = '阿八嚓哒妸发旮哈丌咔垃妈拏噢妑七呥仨他屲夕丫帀';
    const PINYIN_LETTERS = 'ABCDEFGHJKLMNOPQRSTWXYZ';
    let pinyinCollator = null;
    /** The pinyin initial of one Han character, by collation against the first character of each letter. */
    function pinyinInitial(ch) {
      try {
        pinyinCollator ??= new Intl.Collator('zh-Hans-u-co-pinyin');
      } catch {
        return '';
      }
      let letter = '';
      for (let i = 0; i < PINYIN_BOUNDS.length; i += 1) {
        if (pinyinCollator.compare(ch, PINYIN_BOUNDS[i]) >= 0) letter = PINYIN_LETTERS[i];
        else break;
      }
      return letter;
    }
    /**
     * Up to two letters for an avatar: first letters of the first two words
     * ("Data Scout" → DS, "Atlas" → AT), or pinyin initials of a Chinese name
     * ("研究员" → YJ). Other scripts keep their first character.
     */
    function initialsOf(name) {
      const text = String(name ?? '').trim();
      if (text === '') return '?';
      const chars = [...text];
      if (/[\u4e00-\u9fff]/.test(chars[0])) {
        const han = chars.filter((c) => /[\u4e00-\u9fff]/.test(c)).slice(0, 2);
        const letters = han.map((c) => pinyinInitial(c)).join('');
        return letters.length === han.length && letters !== '' ? letters : han.join('');
      }
      const words = text.split(/[\s_\-·.]+/).filter(Boolean);
      const first = (c) => (/[\u4e00-\u9fff]/.test(c) ? pinyinInitial(c) || c : c.toUpperCase());
      if (words.length >= 2) return first([...words[0]][0]) + first([...words[1]][0]);
      const w = [...words[0]];
      if (/^[A-Za-z]/.test(w[0])) {
        // camelCase gives its capitals ("DataBot" → DB); else the first two letters.
        const caps = w.filter((c, i) => i > 0 && /[A-Z]/.test(c));
        return (w[0] + (caps[0] ?? w[1] ?? '')).toUpperCase();
      }
      return w[0];
    }
    /** The letters an avatar shows: its own override, else the name's initials. */
    const avatarLetters = (avatar, name) => {
      const own = avatar && typeof avatar.text === 'string' ? [...avatar.text.trim()].slice(0, 2).join('').toUpperCase() : '';
      return own || initialsOf(name);
    };
    /** Pick the current language's side of a `{en, zh}` label. */
    const pick = (v, lang) => (v && typeof v === 'object' ? str(v[lang] ?? v.en ?? v.zh) : str(v));
    const langOf = (t) => (typeof t === 'function' && t('lang') === 'zh' ? 'zh' : 'en');

    // --- fetch -------------------------------------------------------------------------

    const getJson = (path) =>
      fetch(`${R}${path}`, { cache: 'no-store', credentials: 'same-origin' }).then((r) => (r && r.ok ? r.json() : null));
    const postJson = (path, body) =>
      fetch(`${R}${path}`, {
        method: 'POST',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
        .then((r) => (r && r.ok ? r.json() : { ok: false, reason: `HTTP ${r ? r.status : '?'}` }))
        .catch((e) => ({ ok: false, reason: e?.message ?? 'network error' }));

    // --- the shared store: one /state fetch for the panel, tool views and badges ------------

    const store = {
      state: null,
      failed: false,
      subs: new Set(),
      timer: null,
      inflight: null,
      catalog: null,
      catalogP: null,
      teams: null,
      library: null,
      external: null,
      settings: null,
      nav: { botId: null, view: null, ticket: null, tick: 0 },
      focusBound: false,
      tickets: new Map(),
    };
    const notify = () => {
      for (const fn of [...store.subs]) {
        try {
          fn();
        } catch {
          // One subscriber's failure leaves the rest.
        }
      }
    };
    function refreshState() {
      if (store.inflight) return store.inflight;
      let p;
      try {
        p = Promise.resolve(getJson('state'));
      } catch {
        p = Promise.resolve(null);
      }
      store.inflight = p
        .then((s) => {
          if (s && Array.isArray(s.bots)) {
            store.state = s;
            store.failed = false;
          } else if (!store.state) store.failed = true;
        })
        .catch(() => {
          if (!store.state) store.failed = true;
        })
        .then(() => {
          store.inflight = null;
          notify();
          return store.state;
        });
      return store.inflight;
    }
    const visible = () => {
      try {
        return typeof document === 'undefined' || document.visibilityState !== 'hidden';
      } catch {
        return true;
      }
    };
    const onFocus = () => void refreshState();
    function subscribe(fn) {
      store.subs.add(fn);
      if (store.subs.size === 1) {
        if (!store.state && !store.inflight) void refreshState();
        try {
          store.timer = setInterval(() => {
            if (visible()) void refreshState();
          }, STATE_POLL_MS);
          store.timer?.unref?.();
        } catch {
          store.timer = null;
        }
        try {
          if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
            window.addEventListener('focus', onFocus);
            store.focusBound = true;
          }
        } catch {
          // No focus events.
        }
      }
      return () => {
        store.subs.delete(fn);
        if (store.subs.size === 0) {
          try {
            if (store.timer) clearInterval(store.timer);
          } catch {
            // Gone already.
          }
          store.timer = null;
          try {
            if (store.focusBound) window.removeEventListener('focus', onFocus);
          } catch {
            // Nothing bound.
          }
          store.focusBound = false;
        }
      };
    }
    function useStore() {
      const [, force] = useState(0);
      useEffect(() => subscribe(() => force((n) => n + 1)), []);
      return store;
    }
    function loadCatalog(force = false) {
      if (store.catalogP && !force) return store.catalogP;
      store.catalogP = Promise.resolve()
        .then(() => getJson('catalog'))
        .then((c) => {
          store.catalog = c && typeof c === 'object' ? c : store.catalog;
          if (!c) store.catalogP = null;
          notify();
          return store.catalog;
        })
        .catch(() => {
          store.catalogP = null;
          return store.catalog;
        });
      return store.catalogP;
    }
    function useCatalog() {
      const s = useStore();
      useEffect(() => {
        void loadCatalog();
      }, []);
      return s.catalog;
    }
    /** A GET loaded once per page and shared (`teams`, `library`, `external`); `force` reloads. */
    function loadOnce(key, path, force = false) {
      const pk = `${key}P`;
      if (store[pk] && !force) return store[pk];
      store[pk] = Promise.resolve()
        .then(() => getJson(path))
        .then((r) => {
          if (r) store[key] = r;
          else store[pk] = null;
          notify();
          return store[key];
        })
        .catch(() => {
          store[pk] = null;
          return store[key];
        });
      return store[pk];
    }
    function useLoaded(key, path) {
      const s = useStore();
      useEffect(() => {
        void loadOnce(key, path);
      }, []);
      return s[key];
    }
    const teamsOf = () => (Array.isArray(store.teams) ? store.teams : []);
    const botsOf = () => (Array.isArray(store.state?.bots) ? store.state.bots : []);
    const botById = (id) => botsOf().find((b) => b.id === id) ?? null;
    /** A bot by id, @handle or name, as a model writes it. */
    function findBot(ref) {
      if (!ref || typeof ref !== 'string') return null;
      const key = ref.trim().replace(/^@/, '').toLowerCase();
      return botsOf().find((b) => b.id === ref || String(b.handle).toLowerCase() === key || String(b.name).toLowerCase() === key) ?? null;
    }
    /** Ask the panel to show `botId` (or a view, or one task) once it renders. */
    function navigate(botId, view = null, ticket = null) {
      store.nav = { botId: botId ?? null, view, ticket: ticket ?? null, tick: store.nav.tick + 1 };
      notify();
    }
    /** Show one task's detail in the panel. */
    const openTicket = (id) => navigate(null, 'tasks', id);

    // --- tasks (tickets in the Host; "tasks" on screen) ----------------------------------

    /** How the dispatcher works ('router' | 'hands-on'), a team setting: the polled state's, else the settings'; router unless either says otherwise. */
    const dispatcherOf = () => {
      const v = store.state?.dispatcher ?? store.settings?.settings?.dispatcher;
      return v === 'hands-on' ? 'hands-on' : 'router';
    };
    /**
     * Whether the dispatcher routes now: router mode, and a teammate to hand work to (the Host's
     * `routerActive`). The only bot of a team works hands-on whatever the setting says.
     */
    const routerActiveOf = (state = store.state) => dispatcherOf() === 'router' && state?.routerActive !== false;
    /** Keep the shared copies of the settings after a save, so the page shows them before the next poll. */
    function tookSettings(next) {
      if (next && typeof next === 'object') {
        store.settings = { ...(store.settings ?? {}), settings: next };
        // Until the next poll says, router mode is in effect when the dispatcher has a teammate.
        if (store.state && typeof next.dispatcher === 'string') store.state = { ...store.state, dispatcher: next.dispatcher, routerActive: next.dispatcher === 'router' && (store.state.bots?.length ?? 0) > 1 };
        notify();
      }
    }
    /** The one-time notice after an upgrade moved the dispatcher to router mode; its Host names live here only. */
    // It waits while the dispatcher is the only bot: there is nothing to hand out yet.
    const routerNotice = {
      pending: (state) => state?.routerNoticePending === true && routerActiveOf(state),
      dismiss: () => postJson('router-notice/dismiss', {}),
    };
    /** One task as the Host shows it, shared by every card on the page and refreshed when older than `maxAge`. */
    function loadTicket(id, maxAge = 10_000) {
      if (!id) return Promise.resolve(null);
      const hit = store.tickets.get(id);
      if (hit?.p) return hit.p;
      if (hit && Date.now() - hit.at < maxAge) return Promise.resolve(hit.view);
      const p = Promise.resolve()
        .then(() => getJson(`tickets/${encodeURIComponent(id)}`))
        .then((r) => {
          const view = ticketViewOf(r);
          store.tickets.set(id, { view: view ?? hit?.view ?? null, at: Date.now() });
          notify();
          return view;
        })
        .catch(() => {
          store.tickets.set(id, { view: hit?.view ?? null, at: Date.now() });
          return null;
        });
      store.tickets.set(id, { ...(hit ?? { view: null }), at: hit?.at ?? 0, p });
      return p;
    }
    /** A TicketView from a route's answer: the view itself, or `{ticket: view}`. */
    function ticketViewOf(r) {
      if (!r || typeof r !== 'object' || r.ok === false) return null;
      if (r.ticket && typeof r.ticket === 'object') return r.ticket;
      return typeof r.id === 'string' ? r : null;
    }

    // --- small utilities -------------------------------------------------------------

    const str = (v) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
    const clone = (v) => {
      try {
        return JSON.parse(JSON.stringify(v ?? null));
      } catch {
        return v;
      }
    };
    const rid = (prefix) => `${prefix}-${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-3)}`;
    function slugify(name) {
      const s = str(name)
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 32)
        .replace(/-+$/g, '');
      return s;
    }
    /** A free handle for a name: its slug, or for a name with no Latin letters its lowercase initials ("研究员" → yj). */
    function autoHandle(name) {
      let base = slugify(name);
      if (!base && str(name).trim()) {
        const letters = initialsOf(name).toLowerCase();
        base = /^[a-z0-9]+$/.test(letters) ? letters : 'bot';
      }
      if (!base) return '';
      let out = base;
      for (let i = 2; botsOf().some((b) => b.handle === out); i += 1) out = `${base}-${i}`;
      return out;
    }
    const toMs = (v) => {
      if (typeof v === 'number') return v;
      const n = Date.parse(str(v));
      return Number.isFinite(n) ? n : NaN;
    };
    function fmtAgo(t, at, now = Date.now()) {
      const ms = toMs(at);
      if (!Number.isFinite(ms)) return '';
      const d = now - ms;
      const a = Math.abs(d);
      const future = d < 0;
      if (a < 45_000) return future ? t('inMoment') : t('justNow');
      let key;
      let n;
      if (Math.round(a / 60_000) < 60) [key, n] = ['Min', Math.round(a / 60_000)];
      else if (Math.round(a / 3_600_000) < 24) [key, n] = ['Hour', Math.round(a / 3_600_000)];
      else if (Math.round(a / 86_400_000) < 30) [key, n] = ['Day', Math.round(a / 86_400_000)];
      else return fmtDate(ms);
      return t(future ? `in${key}` : `ago${key}`, { n });
    }
    function fmtDate(ms) {
      try {
        return new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      } catch {
        return '';
      }
    }
    function fmtClock(ms) {
      try {
        const d = new Date(ms);
        const today = new Date();
        const sameDay = d.toDateString() === today.toDateString();
        return sameDay ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : fmtDate(ms);
      } catch {
        return '';
      }
    }
    const localZone = () => {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      } catch {
        return 'UTC';
      }
    };
    function copyText(text) {
      try {
        if (navigator?.clipboard?.writeText) void navigator.clipboard.writeText(text).catch(() => {});
      } catch {
        // The clipboard is a convenience.
      }
    }

    // --- schedule timing ---------------------------------------------------------------

    const hhmm = (time) => str(time).slice(0, 5);
    /** Human words for a timing object (API form). */
    function describeTiming(t, timing, fallback) {
      const k = timing?.kind;
      try {
        if (k === 'daily' && timing.daily) return t('timingDaily', { time: hhmm(timing.daily.time), zone: timing.daily.time_zone ?? '' });
        if (k === 'weekly' && timing.weekly) {
          const days = (timing.weekly.weekdays ?? []).slice().sort((a, b) => a - b);
          const label = days.length === 7 ? t('everyDay') : days.length === 5 && days.join() === '1,2,3,4,5' ? t('weekdays') : days.map((d) => t(`wd${d}`)).join(t('listSep'));
          return t('timingWeekly', { days: label, time: hhmm(timing.weekly.time), zone: timing.weekly.time_zone ?? '' });
        }
        if (k === 'every' && Number(timing.every_seconds) > 0) {
          const s = Number(timing.every_seconds);
          if (s % 86400 === 0) return t('timingEveryDays', { n: s / 86400 });
          if (s % 3600 === 0) return t('timingEveryHours', { n: s / 3600 });
          return t('timingEveryMinutes', { n: Math.max(1, Math.round(s / 60)) });
        }
        if (k === 'cron' && timing.cron) return t('timingCron', { expr: timing.cron.expression ?? '', zone: timing.cron.time_zone ?? '' });
        if (k === 'at' && timing.at) return t('timingAt', { when: fmtDate(toMs(timing.at)) });
        if (k === 'rrule' && timing.rrule) return t('timingRrule', { rule: str(timing.rrule).split('\n').pop() });
      } catch {
        // Fall through to the Host's words.
      }
      return fallback || t('timingUnknown');
    }
    const pad = (n) => String(n).padStart(2, '0');
    function localInput(ms) {
      const d = new Date(ms);
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
    /** The builder's form for a timing (or a fresh one). */
    function formFromTiming(timing, zone) {
      const base = { mode: 'daily', at: localInput(Date.now() + 3_600_000), everyN: 1, everyUnit: 'hours', time: '09:00', weekdays: [1, 2, 3, 4, 5], cron: '0 9 * * 1-5', tz: zone || localZone() };
      const k = timing?.kind;
      if (k === 'daily' && timing.daily) return { ...base, mode: 'daily', time: hhmm(timing.daily.time) || base.time, tz: timing.daily.time_zone || base.tz };
      if (k === 'weekly' && timing.weekly) return { ...base, mode: 'weekly', time: hhmm(timing.weekly.time) || base.time, weekdays: timing.weekly.weekdays ?? base.weekdays, tz: timing.weekly.time_zone || base.tz };
      if (k === 'every') {
        const s = Number(timing.every_seconds) || 3600;
        return s % 3600 === 0 ? { ...base, mode: 'every', everyN: s / 3600, everyUnit: 'hours' } : { ...base, mode: 'every', everyN: Math.max(1, Math.round(s / 60)), everyUnit: 'minutes' };
      }
      if (k === 'cron' && timing.cron) return { ...base, mode: 'cron', cron: timing.cron.expression || base.cron, tz: timing.cron.time_zone || base.tz };
      if (k === 'at' && timing.at) {
        const ms = toMs(timing.at);
        return { ...base, mode: 'at', at: Number.isFinite(ms) ? localInput(ms) : base.at };
      }
      return base;
    }
    /** The API timing for a builder form, or `{error}` naming what is missing. */
    function buildTiming(form) {
      const tz = str(form.tz).trim() || localZone();
      const time = /^\d{1,2}:\d{2}$/.test(str(form.time)) ? `${hhmm(form.time.padStart(5, '0'))}:00` : null;
      switch (form.mode) {
        case 'at': {
          const ms = Date.parse(str(form.at));
          if (!Number.isFinite(ms)) return { error: 'errAt' };
          return { kind: 'at', at: new Date(ms).toISOString() };
        }
        case 'every': {
          const n = Number(form.everyN);
          if (!Number.isFinite(n) || n <= 0) return { error: 'errEvery' };
          const seconds = Math.round(n * (form.everyUnit === 'minutes' ? 60 : 3600));
          if (seconds < 60) return { error: 'errEvery' };
          return { kind: 'every', every_seconds: seconds };
        }
        case 'daily':
          if (!time) return { error: 'errTime' };
          return { kind: 'daily', daily: { time, time_zone: tz } };
        case 'weekly': {
          if (!time) return { error: 'errTime' };
          const weekdays = [...new Set((form.weekdays ?? []).map(Number).filter((d) => d >= 1 && d <= 7))].sort((a, b) => a - b);
          if (weekdays.length === 0) return { error: 'errWeekdays' };
          return { kind: 'weekly', weekly: { time, time_zone: tz, weekdays } };
        }
        case 'cron': {
          const expression = str(form.cron).trim().replace(/\s+/g, ' ');
          if (expression.split(' ').length !== 5) return { error: 'errCron' };
          return { kind: 'cron', cron: { expression, time_zone: tz } };
        }
        default:
          return { error: 'errTime' };
      }
    }

    // --- icons ---------------------------------------------------------------------------

    const svg = (size, paths, extra = {}) =>
      h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', style: { flex: 'none' }, ...extra },
        ...paths.map((d, i) => h('path', { key: i, d })),
      );
    const Icon = {
      plus: (s = 15) => svg(s, ['M12 5v14', 'M5 12h14']),
      search: (s = 14) => svg(s, ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'M20 20l-4-4']),
      dots: (s = 16) => svg(s, ['M5 12h.01M12 12h.01M19 12h.01'], { strokeWidth: 3 }),
      close: (s = 15) => svg(s, ['M6 6l12 12', 'M18 6L6 18']),
      chat: (s = 15) => svg(s, ['M20 11.5a7.5 7.5 0 0 1-10.9 6.7L4 19.5l1.3-4.6A7.5 7.5 0 1 1 20 11.5z']),
      send: (s = 15) => svg(s, ['M5 12l14-7-5 14-2.5-5.5L5 12z', 'M11.5 13.5L19 5']),
      crown: (s = 13) => svg(s, ['M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5L3 8z'], { fill: 'currentColor', strokeWidth: 1.2 }),
      activity: (s = 15) => svg(s, ['M3 12h4l3-8 4 16 3-8h4']),
      arrow: (s = 12) => svg(s, ['M5 12h14', 'M13 6l6 6-6 6']),
      clock: (s = 14) => svg(s, ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7v5l3 2']),
      play: (s = 13) => svg(s, ['M7 5l12 7-12 7V5z']),
      pause: (s = 13) => svg(s, ['M8 5v14', 'M16 5v14']),
      edit: (s = 13) => svg(s, ['M4 20h4L19 9l-4-4L4 16v4z', 'M14 6l4 4']),
      trash: (s = 13) => svg(s, ['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 13h10l1-13']),
      check: (s = 13) => svg(s, ['M5 12.5l4.5 4.5L19 7']),
      upload: (s = 14) => svg(s, ['M12 16V4', 'M7 9l5-5 5 5', 'M4 20h16']),
      open: (s = 14) => svg(s, ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5']),
      star: (s = 14) => svg(s, ['M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9L12 3z']),
      puzzle: (s = 14) => svg(s, ['M10 4a2 2 0 1 1 4 0v2h4v4h-2a2 2 0 1 0 0 4h2v4h-4v-2a2 2 0 1 0-4 0v2H6v-4h2a2 2 0 1 0 0-4H6V6h4V4z']),
      sparkle: (s = 14) => svg(s, ['M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6']),
      user: (s = 14) => svg(s, ['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M4 20a8 8 0 0 1 16 0']),
      refresh: (s = 14) => svg(s, ['M20 11a8 8 0 1 0-2.3 5.7', 'M20 4v7h-7']),
      alert: (s = 14) => svg(s, ['M12 4l9 16H3l9-16z', 'M12 10v4', 'M12 17h.01']),
      download: (s = 14) => svg(s, ['M12 4v12', 'M7 11l5 5 5-5', 'M4 20h16']),
      eye: (s = 14) => svg(s, ['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z']),
      eyeOff: (s = 14) => svg(s, ['M3 3l18 18', 'M10.6 5.1A10.7 10.7 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.1', 'M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a10 10 0 0 0 5.4-1.6', 'M9.9 9.9a3 3 0 0 0 4.2 4.2']),
      team: (s = 14) => svg(s, ['M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z', 'M2.5 20a6.5 6.5 0 0 1 13 0', 'M16 4.3a3.5 3.5 0 0 1 0 6.4', 'M18 14.2a6.5 6.5 0 0 1 3.5 5.8']),
      layers: (s = 14) => svg(s, ['M12 3l9 5-9 5-9-5 9-5z', 'M3 13l9 5 9-5']),
      folder: (s = 14) => svg(s, ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z']),
      github: (s = 14) => svg(s, ['M9 19c-4 1.5-4-2-6-2.5', 'M15 21v-3.5a3 3 0 0 0-.8-2.3c2.8-.3 5.8-1.4 5.8-6.2a4.8 4.8 0 0 0-1.3-3.3 4.5 4.5 0 0 0-.1-3.3s-1-.3-3.4 1.3a11.6 11.6 0 0 0-6 0C6.8 2.1 5.8 2.4 5.8 2.4a4.5 4.5 0 0 0-.1 3.3A4.8 4.8 0 0 0 4.4 9c0 4.8 3 5.9 5.8 6.2a3 3 0 0 0-.8 2.3V21']),
      wand: (s = 14) => svg(s, ['M4 20l11-11', 'M13 7l4 4', 'M18 3v4', 'M16 5h4', 'M8 3v2', 'M7 4h2']),
      chevron: (s = 12) => svg(s, ['M6 9l6 6 6-6']),
      back: (s = 12) => svg(s, ['M19 12H5', 'M11 6l-6 6 6 6']),
      tasks: (s = 14) => svg(s, ['M10 6h10', 'M10 12h10', 'M10 18h10', 'M3.5 6l1.5 1.5L7.5 5', 'M3.5 12l1.5 1.5 2.5-2.5', 'M3.5 18l1.5 1.5 2.5-2.5']),
      stop: (s = 13) => svg(s, ['M7 7h10v10H7z']),
      chart: (s = 14) => svg(s, ['M4 20V10', 'M10 20V4', 'M16 20v-7', 'M21 20H3']),
      brain: (s = 14) => svg(s, ['M9 4a3 3 0 0 0-3 3v.2A3 3 0 0 0 4 10a3 3 0 0 0 1 2.2A3 3 0 0 0 6 17a3 3 0 0 0 3 3h0V4z', 'M15 4a3 3 0 0 1 3 3v.2A3 3 0 0 1 20 10a3 3 0 0 1-1 2.2A3 3 0 0 1 18 17a3 3 0 0 1-3 3h0V4z']),
      gear: (s = 14) => svg(s, ['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z']),
    };
    function BotsGlyph(props) {
      const size = Number(props?.size) > 0 ? Number(props.size) : 18;
      const ink = props?.active ? C.label : 'currentColor';
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: ink, strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
        h('path', { key: 'a', d: 'M12 3.5v3' }),
        h('circle', { key: 'b', cx: 12, cy: 3, r: 1, fill: ink }),
        h('rect', { key: 'c', x: 4.5, y: 6.5, width: 15, height: 12, rx: 3.5 }),
        h('circle', { key: 'd', cx: 9.3, cy: 12, r: 1.3, fill: props?.active ? C.label : 'currentColor', stroke: 'none' }),
        h('circle', { key: 'e', cx: 14.7, cy: 12, r: 1.3, fill: props?.active ? C.label : 'currentColor', stroke: 'none' }),
        h('path', { key: 'f', d: 'M9.5 15.5h5' }),
        h('path', { key: 'g', d: 'M2.5 11v3M21.5 11v3' }),
        h('path', { key: 'h', d: 'M8.5 18.5v2M15.5 18.5v2' }),
      );
    }

    // --- styles ----------------------------------------------------------------------------

    const CSS = `
.dshb,.dshb *{box-sizing:border-box}
.dshb{font-size:${FONT};color:${C.primary};line-height:1.45}
.dshb-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;padding:0 12px;border-radius:8px;border:1px solid ${C.border};background:${C.layer1};color:${C.primary};font:inherit;font-size:${SMALL};font-weight:500;cursor:pointer;white-space:nowrap;transition:background .12s,border-color .12s,opacity .12s,filter .12s;user-select:none}
.dshb-btn:hover{background:${C.hover}}
.dshb-btn:focus-visible{outline:2px solid ${C.label};outline-offset:1px}
.dshb-btn:disabled{opacity:.45;cursor:default}
.dshb-btn-primary{background:${C.label};border-color:transparent;color:#fff}
.dshb-btn-primary:hover{background:${C.label};filter:brightness(1.1)}
.dshb-btn-ghost{background:transparent;border-color:transparent;color:${C.muted}}
.dshb-btn-ghost:hover{color:${C.primary}}
.dshb-btn-danger{color:${C.error}}
.dshb-btn-danger.dshb-btn-primary{background:${C.error};color:#fff}
.dshb-btn-sm{height:26px;padding:0 9px;border-radius:7px}
.dshb-btn-icon{width:30px;padding:0}
.dshb-btn-sm.dshb-btn-icon{width:26px}
.dshb-input{display:block;width:100%;height:32px;padding:0 10px;border-radius:8px;border:1px solid ${C.border};background:${C.layer1};color:${C.primary};font:inherit;font-size:${FONT};outline:none;transition:border-color .12s,box-shadow .12s}
.dshb-input::placeholder{color:${C.faint}}
.dshb-input:focus{border-color:${C.label};box-shadow:0 0 0 3px ${tint(C.label, 18)}}
.dshb-input[data-invalid=true]{border-color:${C.error}}
textarea.dshb-input{height:auto;padding:8px 10px;line-height:1.55;resize:vertical;min-height:64px}
select.dshb-input{padding-right:6px}
.dshb-mono{font-family:var(--dsh-code-font, ui-monospace, SFMono-Regular, Menlo, monospace);font-size:12.5px}
.dshb-row{display:flex;align-items:center;gap:10px;width:100%;padding:8px 10px;border:none;border-radius:10px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;transition:background .1s}
.dshb-row:hover{background:${C.hover}}
.dshb-row[data-active=true]{background:${tint(C.label, 13)}}
.dshb-tab{position:relative;height:38px;padding:0 2px;margin-right:18px;border:none;background:transparent;color:${C.muted};font:inherit;font-size:${SMALL};font-weight:600;cursor:pointer}
.dshb-tab:hover{color:${C.primary}}
.dshb-tab[data-active=true]{color:${C.primary}}
.dshb-tab[data-active=true]::after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:2px;border-radius:2px;background:${C.label}}
.dshb-card{border:1px solid ${C.border1};border-radius:12px;background:${C.layer1};padding:12px 14px}
.dshb-chip{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 10px;border-radius:999px;border:1px solid ${C.border};background:transparent;color:${C.muted};font:inherit;font-size:${SMALL};cursor:pointer;white-space:nowrap;transition:all .12s}
.dshb-chip:hover{color:${C.primary};background:${C.hover}}
.dshb-chip[data-active=true]{color:${C.label};border-color:${C.label};background:${tint(C.label, 10)}}
.dshb-scroll{overflow:auto;scrollbar-width:thin;min-height:0}
.dshb-spinner{display:inline-block;flex:none;width:14px;height:14px;border-radius:50%;border:2px solid ${tint(C.label, 25)};border-top-color:${C.label};animation:dshb-spin .8s linear infinite}
.dshb-appcard{display:flex;flex-direction:column;gap:8px;padding:12px;border:1px solid ${C.border1};border-radius:12px;background:${C.layer1};transition:border-color .12s,box-shadow .12s;min-width:0}
.dshb-appcard:hover{border-color:${C.border};box-shadow:0 2px 10px rgba(0,0,0,.06)}
.dshb-clamp2{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.dshb-extlink{display:inline-flex;align-items:center;gap:3px;color:${C.label};font-size:${TINY};text-decoration:none;white-space:nowrap}
.dshb-extlink:hover{text-decoration:underline}
.dshb-swatch{width:22px;height:22px;border-radius:50%;border:2px solid transparent;cursor:pointer;padding:0;box-shadow:inset 0 0 0 1px rgba(0,0,0,.12)}
.dshb-swatch[data-active=true]{border-color:${C.primary}}
.dshb-switch{position:relative;flex:none;width:32px;height:18px;border-radius:999px;border:none;padding:0;cursor:pointer;background:${C.border};transition:background .15s}
.dshb-switch[data-on=true]{background:${C.label}}
.dshb-switch::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .15s}
.dshb-switch[data-on=true]::after{transform:translateX(14px)}
.dshb-switch:disabled{opacity:.5;cursor:default}
.dshb-menu-item{display:flex;align-items:center;gap:8px;width:100%;padding:7px 10px;border:none;border-radius:7px;background:transparent;color:${C.primary};font:inherit;font-size:${SMALL};text-align:left;cursor:pointer;white-space:nowrap}
.dshb-menu-item:hover{background:${C.hover}}
.dshb-link{border:none;background:none;padding:0;color:${C.label};font:inherit;cursor:pointer}
.dshb-link:hover{text-decoration:underline}
.dshb-fade{animation:dshb-in .18s ease-out}
.dshb-md{white-space:pre-wrap;word-break:break-word;user-select:text}
.dshb-md a{color:inherit;text-decoration:underline;text-underline-offset:2px;word-break:break-all}
.dshb-md-light a{color:#fff}
.dshb-rich{min-width:0;word-break:break-word;user-select:text;overflow-wrap:anywhere}
.dshb-rich table{border-collapse:collapse;font-size:${SMALL};margin:6px 0}
.dshb-rich th,.dshb-rich td{border:1px solid ${C.border};padding:5px 9px;vertical-align:top;text-align:left}
.dshb-rich th{background:${C.layer1};font-weight:650}
.dshb-rich > :first-child,.dshb-rich > * > :first-child{margin-top:0}
.dshb-rich > :last-child,.dshb-rich > * > :last-child{margin-bottom:0}
.dshb-mdf p{margin:0 0 8px}
.dshb-mdf h3,.dshb-mdf h4,.dshb-mdf h5,.dshb-mdf h6,.dshb-mdf h7,.dshb-mdf h8{margin:12px 0 6px;font-size:1em;font-weight:700;line-height:1.4}
.dshb-mdf h3{font-size:1.15em}
.dshb-mdf ul,.dshb-mdf ol{margin:0 0 8px;padding-left:1.4em}
.dshb-mdf li{margin:2px 0}
.dshb-mdf li.dshb-mdf-task{list-style:none;margin-left:-1.2em}
.dshb-mdf li.dshb-mdf-task input{margin:0 6px 0 0;vertical-align:-1px}
.dshb-mdf blockquote{margin:0 0 8px;padding:2px 0 2px 10px;border-left:3px solid ${C.border};color:${C.muted}}
.dshb-mdf hr{border:none;border-top:1px solid ${C.border};margin:10px 0}
.dshb-mdf code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.88em;padding:1px 5px;border-radius:5px;background:${C.layer3}}
.dshb-mdf pre{margin:0 0 8px;padding:10px 12px;border-radius:9px;background:${C.layer1};border:1px solid ${C.border1};overflow:auto}
.dshb-mdf pre code{padding:0;background:none;white-space:pre}
.dshb-mdf a{color:${C.label};text-decoration:none}
.dshb-mdf a:hover{text-decoration:underline}
.dshb-mdf-table{overflow-x:auto;margin:0 0 8px}
.dshb-lc{display:flex;width:100%;max-width:480px;min-width:0;border:1px solid ${C.border1};border-radius:14px;background:${C.layer1};color:${C.primary};text-decoration:none;overflow:hidden;box-sizing:border-box;transition:border-color .15s,background .15s}
a.dshb-lc:hover{border-color:${C.border};background:${C.layer2}}
.dshb-lc a{color:inherit}
.dshb-lc-loading{flex-direction:column;gap:7px;padding:11px 13px}
.dshb-lc-slim{align-items:center;gap:7px;padding:8px 11px;font-size:${SMALL};border-radius:10px}
.dshb-lc-image{max-width:360px;background:${C.layer2}}
.dshb-lc-site{display:flex;align-items:center;gap:6px;font-size:${TINY};color:${C.muted};min-width:0}
.dshb-lc-title{font-weight:650;font-size:${SMALL};line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.dshb-lc-desc{font-size:${TINY};color:${C.muted};line-height:1.45;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.dshb-skel{height:10px;border-radius:5px;background:${C.layer3};animation:dshb-blink 1.4s infinite}
.dshb-play{position:absolute;inset:0;border:none;padding:0;margin:0;cursor:pointer;background:#000;display:block;width:100%;height:100%}
.dshb-play-btn{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);display:inline-flex;filter:drop-shadow(0 2px 6px rgba(0,0,0,.45));transition:transform .15s}
.dshb-play:hover .dshb-play-btn{transform:translate(-50%,-50%) scale(1.08)}
@keyframes dshb-pulse{0%{box-shadow:0 0 0 0 rgba(34,197,94,.6)}70%{box-shadow:0 0 0 5px rgba(34,197,94,0)}100%{box-shadow:0 0 0 0 rgba(34,197,94,0)}}
@keyframes dshb-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
@keyframes dshb-blink{0%,100%{opacity:.25}50%{opacity:1}}
@keyframes dshb-spin{to{transform:rotate(360deg)}}
`;
    const Style = () => h('style', { 'data-dsh-bots-style': true }, CSS);
    const portal = (node) => (ReactDOM && typeof ReactDOM.createPortal === 'function' && typeof document !== 'undefined' && document.body ? ReactDOM.createPortal(node, document.body) : node);

    // --- primitives ------------------------------------------------------------------------

    function Btn({ kind = 'default', size, icon, onClick, disabled, title, children, type = 'button', style, ...rest }) {
      const cls = ['dshb-btn', kind !== 'default' ? `dshb-btn-${kind}` : '', size === 'sm' ? 'dshb-btn-sm' : '', !children && icon ? 'dshb-btn-icon' : ''].filter(Boolean).join(' ');
      return h('button', { type, className: cls, onClick, disabled, title, 'aria-label': title, style, ...rest }, icon ?? null, children ?? null);
    }
    function Switch({ on, onChange, disabled, title, ...rest }) {
      return h('button', {
        ...rest,
        type: 'button',
        role: 'switch',
        'aria-checked': Boolean(on),
        'aria-label': title,
        title,
        className: 'dshb-switch',
        'data-on': Boolean(on),
        disabled,
        onClick: (e) => {
          e?.stopPropagation?.();
          onChange?.(!on);
        },
      });
    }
    function Field({ label, hint, error, children, right, style }) {
      return h(
        'label',
        { style: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0, ...style } },
        label || right
          ? h(
              'span',
              { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 } },
              h('span', { style: { fontSize: SMALL, fontWeight: 600, color: C.primary } }, label),
              right ?? null,
            )
          : null,
        children,
        error ? h('span', { style: { fontSize: TINY, color: C.error } }, error) : hint ? h('span', { style: { fontSize: TINY, color: C.faint, lineHeight: 1.5 } }, hint) : null,
      );
    }
    const Input = (props) => h('input', { className: `dshb-input${props.mono ? ' dshb-mono' : ''}`, ...props, mono: undefined });
    const TextArea = (props) => h('textarea', { className: `dshb-input${props.mono ? ' dshb-mono' : ''}`, ...props, mono: undefined });
    const Section = ({ title, hint, right, children }) =>
      h(
        'section',
        { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 10 } },
          h(
            'div',
            { style: { minWidth: 0 } },
            h('div', { style: { fontSize: SMALL, fontWeight: 700, letterSpacing: '.02em', textTransform: 'uppercase', color: C.muted } }, title),
            hint ? h('div', { style: { fontSize: TINY, color: C.faint, marginTop: 3, lineHeight: 1.5 } }, hint) : null,
          ),
          right ?? null,
        ),
        children,
      );
    const Empty = ({ icon, title, body, action }) =>
      h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '36px 20px', textAlign: 'center', color: C.muted } },
        icon ? h('div', { style: { fontSize: 30, lineHeight: 1, opacity: 0.85 } }, icon) : null,
        title ? h('div', { style: { fontWeight: 600, color: C.primary } }, title) : null,
        body ? h('div', { style: { fontSize: SMALL, maxWidth: 380, lineHeight: 1.6 } }, body) : null,
        action ?? null,
      );
    const Badge = ({ children, color = C.label, title, ...rest }) =>
      h(
        'span',
        { title, ...rest, style: { display: 'inline-flex', alignItems: 'center', gap: 4, height: 20, padding: '0 7px', borderRadius: 999, fontSize: TINY, fontWeight: 600, color, background: tint(color, 13), whiteSpace: 'nowrap', flex: 'none' } },
        children,
      );

    /** A circle: initials on a colour, or the uploaded / generated picture. */
    function Avatar({ avatar, name, size = 32, status, title, ring }) {
      const a = avatar && typeof avatar === 'object' ? avatar : { kind: 'initials', color: COLORS[0] };
      const color = str(a.color) || COLORS[0];
      const letters = avatarLetters(a, name);
      const wide = [...letters].length > 1 && !/[\u3000-\u9fff]/.test(letters);
      const face =
        a.kind === 'image' && a.url
          ? h('img', { src: a.url, alt: '', draggable: false, style: { width: '100%', height: '100%', objectFit: 'cover', display: 'block', borderRadius: '50%' } })
          : h(
              'span',
              {
                'data-dsh-bots-initials': letters,
                style: {
                  color: '#fff',
                  fontSize: Math.max(7, Math.round(size * (wide ? 0.38 : 0.42))),
                  fontWeight: 680,
                  lineHeight: 1,
                  letterSpacing: size >= 28 ? '0.02em' : 0,
                  textShadow: size >= 28 ? '0 1px 1px rgba(0,0,0,.18)' : 'none',
                  fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", "PingFang SC", "Helvetica Neue", sans-serif',
                  fontFeatureSettings: '"tnum" 0',
                  WebkitFontSmoothing: 'antialiased',
                  whiteSpace: 'nowrap',
                },
              },
              letters,
            );
      const dot = Math.max(7, Math.round(size * 0.28));
      return h(
        'span',
        {
          title,
          'data-dsh-bots-avatar': true,
          style: {
            position: 'relative',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            flex: 'none',
            width: size,
            height: size,
            borderRadius: '50%',
            background: `linear-gradient(150deg, color-mix(in srgb, ${color} 82%, #fff) 0%, ${color} 48%, color-mix(in srgb, ${color} 80%, #000) 100%)`,
            boxShadow: ring ? `0 0 0 2px ${C.base}, 0 0 0 4px ${tint(color, 55)}` : 'inset 0 0 0 1px rgba(255,255,255,.10)',
            userSelect: 'none',
          },
        },
        face,
        status ? h(StatusDot, { status, size: dot, style: { position: 'absolute', right: -1, bottom: -1, boxShadow: `0 0 0 2px ${C.base}` } }) : null,
      );
    }
    function StatusDot({ status, size = 8, style, title }) {
      const running = status === 'running';
      const offline = status === 'offline';
      return h('span', {
        title,
        'data-dsh-bots-status': status,
        style: {
          display: 'inline-block',
          flex: 'none',
          width: size,
          height: size,
          borderRadius: '50%',
          background: running ? '#22c55e' : offline ? C.base : '#9aa0a6',
          border: offline ? `1.5px solid ${C.faint}` : 'none',
          animation: running ? 'dshb-pulse 1.6s ease-out infinite' : undefined,
          ...style,
          ...(running && style?.boxShadow ? { boxShadow: undefined } : {}),
        },
      });
    }

    /** A small popover menu anchored at its parent's corner. */
    function Menu({ items, onClose, align = 'right' }) {
      const ref = useRef(null);
      useEffect(() => {
        if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined;
        const away = (e) => {
          if (ref.current && !ref.current.contains(e.target)) onClose();
        };
        const key = (e) => {
          if (e.key === 'Escape') onClose();
        };
        document.addEventListener('mousedown', away, true);
        document.addEventListener('keydown', key, true);
        return () => {
          document.removeEventListener('mousedown', away, true);
          document.removeEventListener('keydown', key, true);
        };
      }, []);
      return h(
        'div',
        {
          ref,
          role: 'menu',
          className: 'dshb-fade',
          style: { position: 'absolute', top: 'calc(100% + 6px)', [align]: 0, zIndex: 20, minWidth: 180, padding: 4, borderRadius: 10, background: C.layer3, border: `1px solid ${C.border}`, boxShadow: '0 10px 30px rgba(0,0,0,.28)' },
        },
        items.map((it) =>
          h(
            'button',
            {
              key: it.id,
              type: 'button',
              role: 'menuitem',
              className: 'dshb-menu-item',
              disabled: it.disabled,
              style: { color: it.danger ? C.error : undefined, opacity: it.disabled ? 0.5 : 1 },
              onClick: () => {
                onClose();
                it.run();
              },
            },
            it.icon ?? null,
            it.label,
          ),
        ),
      );
    }

    /** A centred dialog over a dimmed page; Escape and a click outside close it. */
    function Modal({ title, onClose, children, footer, width = 520, closeLabel = 'Close' }) {
      useEffect(() => {
        if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined;
        const key = (e) => {
          if (e.key === 'Escape') onClose();
        };
        document.addEventListener('keydown', key, true);
        return () => document.removeEventListener('keydown', key, true);
      }, []);
      return portal(
        h(
          'div',
          {
            className: 'dshb',
            role: 'dialog',
            'aria-modal': true,
            'aria-label': title,
            onMouseDown: (e) => {
              if (e.target === e.currentTarget) onClose();
            },
            style: { position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, background: 'rgba(0,0,0,.45)', backdropFilter: 'blur(2px)' },
          },
          h(Style),
          h(
            'div',
            {
              className: 'dshb-fade',
              style: { width, maxWidth: '100%', maxHeight: 'calc(100vh - 40px)', display: 'flex', flexDirection: 'column', borderRadius: 16, background: C.layer1, border: `1px solid ${C.border}`, boxShadow: '0 24px 64px rgba(0,0,0,.35)', overflow: 'hidden' },
            },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 18px', borderBottom: `1px solid ${C.border1}` } },
              h('div', { style: { fontWeight: 700, fontSize: 15 } }, title),
              h(Btn, { kind: 'ghost', size: 'sm', icon: Icon.close(), title: closeLabel, onClick: onClose }),
            ),
            h('div', { className: 'dshb-scroll', style: { padding: 18, display: 'flex', flexDirection: 'column', gap: 16 } }, children),
            footer ? h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '12px 18px', borderTop: `1px solid ${C.border1}`, background: C.base } }, footer) : null,
          ),
        ),
      );
    }
    function Confirm({ t, title, body, confirmLabel, onConfirm, onClose }) {
      const [busy, setBusy] = useState(false);
      return h(
        Modal,
        {
          title,
          closeLabel: t('close'),
          width: 420,
          onClose,
          footer: [
            h(Btn, { key: 'c', onClick: onClose }, t('cancel')),
            h(
              Btn,
              {
                key: 'd',
                kind: 'primary',
                className: 'dshb-btn dshb-btn-primary dshb-btn-danger',
                disabled: busy,
                onClick: () => {
                  setBusy(true);
                  Promise.resolve()
                    .then(onConfirm)
                    .finally(() => {
                      setBusy(false);
                      onClose();
                    });
                },
              },
              confirmLabel,
            ),
          ],
        },
        h('div', { style: { fontSize: FONT, color: C.muted, lineHeight: 1.6 } }, body),
      );
    }
    /** A pill at the bottom of the panel; `toast = {text, kind}`. */
    function Toast({ toast }) {
      if (!toast) return null;
      const color = toast.kind === 'error' ? C.error : C.ok;
      return h(
        'div',
        {
          role: 'status',
          className: 'dshb-fade',
          'data-dsh-bots-toast': toast.kind ?? 'ok',
          style: { position: 'absolute', left: '50%', bottom: 18, transform: 'translateX(-50%)', zIndex: 30, display: 'flex', alignItems: 'center', gap: 8, maxWidth: '80%', padding: '8px 14px', borderRadius: 999, background: C.layer3, border: `1px solid ${C.border}`, boxShadow: '0 8px 24px rgba(0,0,0,.25)', fontSize: SMALL },
        },
        h('span', { style: { width: 7, height: 7, borderRadius: '50%', background: color, flex: 'none' } }),
        h('span', null, toast.text),
      );
    }
    function useToast() {
      const [toast, setToast] = useState(null);
      const timer = useRef(null);
      useEffect(
        () => () => {
          if (timer.current) clearTimeout(timer.current);
        },
        [],
      );
      const show = (text, kind = 'ok') => {
        setToast({ text, kind });
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setToast(null), kind === 'error' ? 5000 : 2600);
      };
      return [toast, show];
    }
    /** Run fn on an interval while mounted and visible; fn also runs at once. */
    function usePoll(fn, ms, deps) {
      const ref = useRef(fn);
      ref.current = fn;
      useEffect(() => {
        let id = null;
        try {
          void ref.current();
          id = setInterval(() => {
            if (visible()) void ref.current();
          }, ms);
          id?.unref?.();
        } catch {
          id = null;
        }
        return () => {
          if (id) clearInterval(id);
        };
      }, deps);
    }

    // --- the panel: left rail ----------------------------------------------------------

    /** Bots grouped by `team` (team order = first appearance, the dispatcher's first); null when no bot has a team. */
    function groupByTeam(t, lang, bots) {
      if (!bots.some((b) => b.team)) return null;
      const groups = [];
      for (const b of bots) {
        const id = b.team || '';
        let g = groups.find((x) => x.id === id);
        if (!g) groups.push((g = { id, bots: [] }));
        g.bots.push(b);
      }
      const label = (id) => {
        if (!id) return t('otherBots');
        const team = teamsOf().find((x) => x.id === id);
        return team ? pick(team.name, lang) : id;
      };
      return groups.sort((a, b) => (a.id === '' ? 1 : b.id === '' ? -1 : 0)).map((g) => ({ ...g, label: label(g.id) }));
    }

    function Rail({ t, bots, primaryId, selected, onSelect, onNew, onTeams, view, onActivity, messageCount, onUsage, onMemory, onSettings, teamNotes, onTasks, attention = 0, openTasks = 0 }) {
      const lang = langOf(t);
      const [q, setQ] = useState('');
      const [menu, setMenu] = useState(false);
      const needle = q.trim().toLowerCase();
      const shown = bots
        .filter((b) => !needle || [b.name, b.handle, b.bio].some((s) => str(s).toLowerCase().includes(needle)))
        .sort((a, b) => (a.id === primaryId ? -1 : b.id === primaryId ? 1 : 0));
      const groups = needle ? null : groupByTeam(t, lang, shown);
      const row = (b) =>
        h(
          'button',
          { key: b.id, type: 'button', className: 'dshb-row', 'data-active': view === 'bot' && b.id === selected, 'data-dsh-bots-row': b.id, onClick: () => onSelect(b.id) },
          h(Avatar, { avatar: b.avatar, name: b.name || b.handle, size: 36, status: b.status ?? 'offline', title: t(`status_${b.status ?? 'offline'}`) }),
          h(
            'span',
            { style: { display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 } },
            h(
              'span',
              { style: { display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 } },
              h('span', { style: { fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, b.name || b.handle),
              b.id === primaryId ? h('span', { title: t('dispatcher'), style: { color: '#f5b301', display: 'inline-flex' } }, Icon.crown(12)) : null,
              h('span', { style: { color: C.faint, fontSize: TINY, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, `@${b.handle}`),
            ),
            h('span', { style: { fontSize: TINY, color: C.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1 } }, b.bio || t('noBio')),
          ),
        );
      return h(
        'aside',
        { 'data-dsh-bots-rail': true, style: { width: 264, flex: 'none', display: 'flex', flexDirection: 'column', borderRight: `1px solid ${C.border1}`, background: C.base, minHeight: 0 } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '14px 14px 10px' } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, fontSize: 15 } }, h(BotsGlyph, { size: 18, active: true }), t('title')),
          h(
            'div',
            { style: { position: 'relative', display: 'flex', alignItems: 'center', gap: 4 } },
            onSettings ? h(Btn, { kind: 'ghost', size: 'sm', icon: Icon.gear(14), title: t('settings'), onClick: onSettings, 'data-dsh-bots-settings': true }) : null,
            h(Btn, { kind: 'primary', size: 'sm', icon: Icon.plus(13), onClick: () => setMenu((v) => !v), 'data-dsh-bots-new': true }, t('newBot'), Icon.chevron(11)),
            menu
              ? h(Menu, {
                  onClose: () => setMenu(false),
                  items: [
                    { id: 'blank', label: t('blankBot'), icon: Icon.plus(13), run: onNew },
                    { id: 'team', label: t('fromTeam'), icon: Icon.team(13), run: onTeams },
                  ],
                })
              : null,
          ),
        ),
        h(
          'div',
          { style: { position: 'relative', padding: '0 14px 8px' } },
          h('span', { style: { position: 'absolute', left: 24, top: 9, color: C.faint, pointerEvents: 'none' } }, Icon.search(13)),
          h(Input, { value: q, placeholder: t('search'), onChange: (e) => setQ(e.target.value), style: { paddingLeft: 30, height: 30, fontSize: SMALL } }),
        ),
        h(
          'div',
          { className: 'dshb-scroll', style: { flex: 1, padding: '2px 8px 8px', display: 'flex', flexDirection: 'column', gap: 2 } },
          shown.length === 0
            ? h('div', { style: { padding: '18px 10px', fontSize: SMALL, color: C.faint, textAlign: 'center' } }, bots.length ? t('noMatch') : t('noBotsShort'))
            : groups
              ? groups.map((g) =>
                  h(
                    'div',
                    { key: g.id || '-', 'data-dsh-bots-group': g.id || 'other', style: { display: 'flex', flexDirection: 'column', gap: 2 } },
                    h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px 3px', fontSize: TINY, fontWeight: 700, color: C.faint, letterSpacing: '.02em' } }, g.label, h('span', { style: { fontWeight: 500 } }, g.bots.length)),
                    g.bots.map(row),
                  ),
                )
              : shown.map(row),
        ),
        h(
          'div',
          { style: { padding: 8, borderTop: `1px solid ${C.border1}` } },
          onTasks
            ? h(
                'button',
                { type: 'button', className: 'dshb-row', 'data-active': view === 'tasks', 'data-dsh-bots-tasks-entry': true, onClick: onTasks },
                h('span', { style: { width: 36, height: 36, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: C.layer2, color: C.label, flex: 'none' } }, Icon.tasks(16)),
                h(
                  'span',
                  { style: { display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 } },
                  h('span', { style: { fontWeight: 600 } }, t('tasks')),
                  h('span', { style: { fontSize: TINY, color: attention > 0 ? C.warn : C.muted } }, attention > 0 ? t('tasksNeedYou', { n: attention }) : openTasks > 0 ? t('tasksInProgress', { n: openTasks }) : t('tasksHint')),
                ),
                attention > 0
                  ? h(
                      'span',
                      { 'data-dsh-bots-tasks-badge': attention, 'aria-label': t('tasksNeedYou', { n: attention }), style: { minWidth: 20, height: 20, padding: '0 6px', borderRadius: 999, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: C.error, color: '#fff', fontSize: TINY, fontWeight: 700, fontVariantNumeric: 'tabular-nums', flex: 'none' } },
                      attention > 99 ? '99+' : String(attention),
                    )
                  : null,
              )
            : null,
          h(
            'button',
            { type: 'button', className: 'dshb-row', 'data-active': view === 'activity', 'data-dsh-bots-activity': true, onClick: onActivity },
            h('span', { style: { width: 36, height: 36, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: C.layer2, color: C.label, flex: 'none' } }, Icon.activity(16)),
            h('span', { style: { display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 } }, h('span', { style: { fontWeight: 600 } }, t('activity')), h('span', { style: { fontSize: TINY, color: C.muted } }, t('activityHint', { n: messageCount ?? 0 }))),
          ),
          onUsage
            ? h(
                'button',
                { type: 'button', className: 'dshb-row', 'data-active': view === 'usage', 'data-dsh-bots-usage-entry': true, onClick: onUsage },
                h('span', { style: { width: 36, height: 36, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: C.layer2, color: C.label, flex: 'none' } }, Icon.chart(16)),
                h('span', { style: { display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 } }, h('span', { style: { fontWeight: 600 } }, t('usage')), h('span', { style: { fontSize: TINY, color: C.muted } }, t('usageHint', { tokens: fmtNum(bots.reduce((n, b) => n + (Number(b.usageToday) || 0), 0)) }))),
              )
            : null,
          onMemory
            ? h(
                'button',
                { type: 'button', className: 'dshb-row', 'data-active': view === 'memory', 'data-dsh-bots-memory-entry': true, onClick: onMemory },
                h('span', { style: { width: 36, height: 36, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: C.layer2, color: C.label, flex: 'none' } }, Icon.brain(16)),
                h('span', { style: { display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 } }, h('span', { style: { fontWeight: 600 } }, t('teamMemoryTitle')), h('span', { style: { fontSize: TINY, color: C.muted } }, t('teamMemoryHint', { n: teamNotes ?? 0 }))),
              )
            : null,
          h(
            'button',
            { type: 'button', className: 'dshb-row', 'data-active': view === 'teams', 'data-dsh-bots-teams-entry': true, onClick: onTeams },
            h('span', { style: { width: 36, height: 36, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: C.layer2, color: C.label, flex: 'none' } }, Icon.team(16)),
            h('span', { style: { display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 } }, h('span', { style: { fontWeight: 600 } }, t('teamTemplates')), h('span', { style: { fontSize: TINY, color: C.muted } }, t('teamTemplatesHint'))),
          ),
        ),
      );
    }

    // --- the panel: messages ---------------------------------------------------------------

    /** A chat thread's key (`kind:app:chat[:root]`, lib/threads.mjs), not the panel's own. */
    const isChatThread = (key) => typeof key === 'string' && /^[a-z][a-z0-9-]*:/.test(key) && !key.startsWith('panel:') && key.split(':').length >= 3;
    /** Who wrote in each chat thread of a timeline, so a thread reads by a name rather than its chat id. */
    function threadNamesOf(items) {
      const names = new Map();
      for (const m of items ?? []) if (isChatThread(m?.thread) && str(m.who).trim()) names.set(m.thread, str(m.who).trim());
      return names;
    }
    /** A chat thread as people read it (the Host's `threadLabel`): `Telegram · Kada`, `Slack · C042 · thread`. */
    function threadName(t, key, names) {
      const [kind, , chat, root] = str(key).split(':');
      const unescape = (s) => str(s).replace(/%(25|3A)/gi, (_, c) => (c === '25' ? '%' : ':'));
      const parts = [channelName(kind, t), names?.get(key) || unescape(chat)];
      if (root) parts.push(kind === 'telegram' ? t('threadTopic') : t('threadPart'));
      return parts.join(' · ');
    }

    /** Who a message end is: a bot face, the user, or the scheduler. */
    function party(t, id) {
      if (id === 'user') return { kind: 'user', name: t('you') };
      if (id === 'schedule') return { kind: 'schedule', name: t('scheduler') };
      if (id === 'system') return { kind: 'system', name: t('title') };
      const b = botById(id);
      return b ? { kind: 'bot', bot: b, name: b.name || `@${b.handle}` } : { kind: 'unknown', name: str(id) || '?' };
    }
    function PartyAvatar({ p, size = 28 }) {
      if (p.kind === 'bot') return h(Avatar, { avatar: p.bot.avatar, name: p.bot.name || p.bot.handle, size });
      const glyph = p.kind === 'user' ? Icon.user(Math.round(size * 0.5)) : p.kind === 'schedule' ? Icon.clock(Math.round(size * 0.5)) : Icon.sparkle(Math.round(size * 0.5));
      return h('span', { style: { width: size, height: size, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: C.layer3, color: C.muted, flex: 'none' } }, glyph);
    }

    /** A thread of one bot: the user's prompts right, the bot's replies left, DMs as cards. */
    function MessageList({ t, items, botId, empty }) {
      const count = items.length;
      if (count === 0) return empty;
      const names = threadNamesOf(items);
      const rows = [];
      let lastDay = '';
      items.forEach((m, i) => {
        const at = toMs(m.at);
        let day = '';
        try {
          day = new Date(at).toDateString();
        } catch {
          day = '';
        }
        if (day && day !== lastDay) {
          lastDay = day;
          let label = '';
          try {
            label = day === new Date().toDateString() ? t('today') : new Date(at).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
          } catch {
            label = '';
          }
          rows.push(
            h(
              'div',
              { key: `d${i}`, style: { display: 'flex', alignItems: 'center', gap: 10, margin: '8px 0', color: C.faint, fontSize: TINY } },
              h('span', { style: { flex: 1, height: 1, background: C.border1 } }),
              label,
              h('span', { style: { flex: 1, height: 1, background: C.border1 } }),
            ),
          );
        }
        const prev = items[i - 1];
        // Answers to two chats of one turn keep their own headers (where each went), and so do two tasks.
        const grouped = prev && prev.from === m.from && prev.to === m.to && prev.kind === m.kind && prev.via === m.via && prev.thread === m.thread && messageTicket(prev) === messageTicket(m) && at - toMs(prev.at) < 5 * 60_000;
        rows.push(h(MessageRow, { key: m.id ?? i, t, m, botId, grouped, names }));
      });
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, padding: '8px 0', maxWidth: 880, margin: '0 auto' } }, rows);
    }

    function MessageRow({ t, m, botId, grouped, names }) {
      if (m.kind === 'topic') {
        const at = toMs(m.at);
        return h(
          'div',
          { 'data-dsh-bots-msg': 'topic', style: { display: 'flex', alignItems: 'center', gap: 10, margin: '14px 0 8px', color: C.label, fontSize: TINY, fontWeight: 600 } },
          h('span', { style: { flex: 1, height: 1, background: tint(C.label, 35) } }),
          h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 5 } }, Icon.plus(11), t('topicDivider', { reason: t(`topicReason_${m.text}`) }), Number.isFinite(at) ? h('span', { style: { color: C.faint, fontWeight: 500 } }, fmtClock(at)) : null),
          h('span', { style: { flex: 1, height: 1, background: tint(C.label, 35) } }),
        );
      }
      const from = party(t, m.from);
      const to = party(t, m.to);
      const at = toMs(m.at);
      const time = Number.isFinite(at) ? fmtClock(at) : '';
      const mine = m.from === 'user';
      // A DM between two bots, or something addressed to another bot: an "A → B" card.
      const between = (m.kind === 'dm' || m.kind === 'report') && m.from !== 'user' && m.to !== 'user';
      // A delegation that opened a task shows the task; a worker's report shows its status, and a
      // notice that the task is stuck or failed its stage.
      const ticketId = messageTicket(m);
      const report = messageReport(m);
      const notice = messageNotice(m);
      if (between || m.kind === 'system') {
        return h(
          'div',
          { 'data-dsh-bots-msg': m.kind, className: 'dshb-fade', style: { display: 'flex', padding: '4px 0 4px 40px' } },
          h(
            'div',
            { style: { width: 'min(600px, 100%)', borderLeft: `3px solid ${m.kind === 'system' ? C.warn : tint(C.label, 60)}`, border: `1px solid ${C.border1}`, borderRadius: 12, background: C.layer2, padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 5 } },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: TINY, color: C.muted, minWidth: 0 } },
              h(PartyAvatar, { p: from, size: 18 }),
              h('span', { style: { fontWeight: 600, color: C.primary } }, from.name),
              h('span', { style: { color: C.faint, display: 'inline-flex' } }, Icon.arrow(11)),
              h(PartyAvatar, { p: to, size: 18 }),
              h('span', { style: { fontWeight: 600, color: C.primary } }, to.name),
              report ? h(ReportChip, { t, status: report }) : null,
              notice ? h(StageChip, { t, stage: notice }) : null,
              (report || notice) && ticketId ? h('button', { type: 'button', className: 'dshb-link', 'data-dsh-bots-report-task': ticketId, onClick: () => openTicket(ticketId), style: { fontSize: TINY } }, t('openTask')) : null,
              h('span', { style: { marginLeft: 'auto', color: C.faint } }, m.kind === 'system' ? `${t('scheduled')} · ${time}` : time),
            ),
            ticketId && !report && !notice ? h(TaskCard, { t, id: ticketId, botId: m.to, title: firstLine(m.text) }) : null,
            h(Clamp, { t, text: m.text, lines: ticketId && !report && !notice ? 3 : 6, style: { fontSize: SMALL, color: C.primary } }),
            h(LinkCards, { t, text: m.text }),
          ),
        );
      }
      if (mine) {
        return h(
          'div',
          { 'data-dsh-bots-msg': 'user', className: 'dshb-fade', style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3, marginTop: grouped ? 0 : 6 } },
          grouped
            ? null
            : h(
                'span',
                { style: { fontSize: TINY, color: C.faint, display: 'inline-flex', alignItems: 'center', gap: 6 } },
                m.via ? h(Badge, { color: CHANNEL_COLORS[m.via] ?? C.muted, 'data-dsh-bots-via': m.via }, t('viaChannel', { app: channelName(m.via, t), who: str(m.who) || t('you') })) : null,
                m.to !== botId && to.kind === 'bot' ? `${t('toName', { name: to.name })} · ${time}` : time,
                // A message from a chat that went straight to the task it follows up on.
                ticketId ? h('button', { type: 'button', className: 'dshb-link', 'data-dsh-bots-report-task': ticketId, title: m.via ? t('followUpHint') : undefined, onClick: () => openTicket(ticketId), style: { fontSize: TINY } }, t(m.via ? 'followUpTask' : 'openTask')) : null,
              ),
          h('div', { style: { maxWidth: '78%', padding: '8px 12px', borderRadius: '14px 14px 4px 14px', background: C.label, color: '#fff', fontSize: FONT } }, h(Clamp, { t, text: m.text, lines: 14, light: true })),
          h('div', { style: { width: 'min(480px, 78%)', display: 'flex', justifyContent: 'flex-end' } }, h(LinkCards, { t, text: m.text, align: 'flex-end' })),
        );
      }
      // Where a reply went: its chat by name when the Host says which (`→ Telegram · Kada`), else the app.
      const place = m.via ? (isChatThread(m.thread) ? threadName(t, m.thread, names) : channelName(m.via, t)) : '';
      // With several chats in the turn, plain text reached none of them (bot_reply says where each answer goes).
      const choices = m.notSent === true && Array.isArray(m.choices) ? m.choices.filter(isChatThread) : [];
      return h(
        'div',
        { 'data-dsh-bots-msg': m.kind || 'reply', className: 'dshb-fade', style: { display: 'flex', gap: 10, alignItems: 'flex-start', marginTop: grouped ? 0 : 8 } },
        h('div', { style: { width: 30, flex: 'none' } }, grouped ? null : h(PartyAvatar, { p: from, size: 30 })),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0, maxWidth: '82%' } },
          grouped
            ? null
            : h(
                'div',
                { style: { display: 'flex', alignItems: 'baseline', gap: 6, fontSize: TINY } },
                h('span', { style: { fontWeight: 700, fontSize: SMALL, color: C.primary } }, from.name),
                from.kind === 'bot' ? h('span', { style: { color: C.faint } }, `@${from.bot.handle}`) : null,
                m.to !== 'user' && to.kind === 'bot' && m.to !== botId ? h('span', { style: { color: C.faint } }, `→ ${to.name}`) : null,
                h('span', { style: { color: C.faint } }, time),
                m.via ? h(Badge, { color: CHANNEL_COLORS[m.via] ?? C.muted, title: t('sentToChannel', { app: place }), 'data-dsh-bots-via': m.via }, `→ ${place}`) : null,
                report ? h(ReportChip, { t, status: report }) : null,
                notice ? h(StageChip, { t, stage: notice }) : null,
                ticketId ? h('button', { type: 'button', className: 'dshb-link', 'data-dsh-bots-report-task': ticketId, onClick: () => openTicket(ticketId), style: { fontSize: TINY } }, t('openTask')) : null,
              ),
          h('div', { style: { padding: '8px 12px', borderRadius: '4px 14px 14px 14px', background: C.layer2, border: `1px solid ${C.border1}`, fontSize: FONT, minWidth: 0 } }, h(Clamp, { t, text: m.text, lines: 24 })),
          choices.length
            ? h(
                'div',
                { 'data-dsh-bots-not-sent': choices.length, style: { display: 'flex', alignItems: 'flex-start', gap: 5, fontSize: TINY, color: C.muted, lineHeight: 1.5 } },
                h('span', { style: { color: C.warn, display: 'inline-flex', paddingTop: 2 } }, Icon.alert(11)),
                t('notSentChats', { chats: choices.map((k) => threadName(t, k, names)).join(t('listSep')) }),
              )
            : null,
          h(LinkCards, { t, text: m.text }),
        ),
      );
    }

    /** Long text folded to about `lines` lines, with a toggle. Bot text renders as Markdown; the user's own bubble stays plain with live links. */
    function Clamp({ t, text, lines = 6, style, light }) {
      const [open, setOpen] = useState(false);
      const s = str(text);
      const long = s.length > lines * 90 || s.split('\n').length > lines;
      const folded = long && !open;
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'stretch', minWidth: 0 } },
        h(
          'div',
          {
            'data-dsh-bots-folded': folded ? 'true' : undefined,
            style: {
              lineHeight: 1.55,
              minWidth: 0,
              ...style,
              ...(folded ? { maxHeight: `${lines * 1.55}em`, overflow: 'hidden', WebkitMaskImage: 'linear-gradient(180deg,#000 70%,transparent)', maskImage: 'linear-gradient(180deg,#000 70%,transparent)' } : {}),
            },
          },
          light ? h('div', { className: 'dshb-md dshb-md-light' }, linkify(s, 'l')) : h(RichText, { t, text: s }),
        ),
        long ? h('button', { type: 'button', className: 'dshb-link', style: { fontSize: TINY, alignSelf: 'flex-start', color: light ? 'rgba(255,255,255,.85)' : C.label }, onClick: () => setOpen((v) => !v) }, open ? t('showLess') : t('showMore')) : null,
      );
    }

    /** Preview cards for the links in `text` (at most MAX_CARDS). */
    function LinkCards({ t, text, align = 'flex-start' }) {
      const links = linksIn(text).slice(0, MAX_CARDS);
      if (!links.length) return null;
      return h('div', { 'data-dsh-bots-cards': links.length, style: { display: 'flex', flexDirection: 'column', gap: 8, alignItems: align, width: '100%', minWidth: 0 } }, links.map((u) => h(LinkCard, { key: u, t, url: u })));
    }

    // --- Markdown -------------------------------------------------------------------------

    let mdLabelCache = { key: '', labels: null };
    /** One stable labels object per language, so the shell renderer keeps its parse. */
    function mdLabels(t) {
      const parts = [t('md_copy'), t('md_copied'), t('md_code'), t('md_wrap'), t('md_unwrap'), t('md_footnotes')];
      const key = parts.join('\u0000');
      if (mdLabelCache.key !== key) {
        mdLabelCache = { key, labels: { code: { copyLabel: parts[0], copiedLabel: parts[1], toolbarLabels: { codeLabel: parts[2], wrapLabel: parts[3], unwrapLabel: parts[4] } }, footnotes: parts[5] } };
      }
      return mdLabelCache.labels;
    }

    /** Markdown through the product's own renderer (the same as the main chat), else a small built-in one. */
    /**
     * Amounts stay amounts: the Harness renderer reads `$…$` as inline math, so "$9 monthly / $90 annual"
     * would turn into a formula. A `$` right before a digit is escaped, outside code.
     */
    function moneySafe(text) {
      return str(text)
        .split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g)
        .map((part, i) => (i % 2 ? part : part.replace(/(^|[^\\])\$(?=\d)/g, '$1\\$')))
        .join('');
    }
    function RichText({ t, text }) {
      const Md = primitives && primitives.MarkdownText;
      if (Md && (typeof Md === 'function' || typeof Md === 'object')) {
        return h('div', { className: 'dshb-rich', 'data-dsh-bots-md': 'harness' }, h(Md, { text: moneySafe(text), labels: mdLabels(t), variant: 'compact' }));
      }
      return h('div', { className: 'dshb-rich dshb-mdf', 'data-dsh-bots-md': 'builtin' }, miniMarkdown(text));
    }

    const URL_RE = /\bhttps?:\/\/[^\s<>()"'`\]]*[^\s<>()"'`\].,;:!?。，；：！？、）】》」』]/g;
    /** Distinct http(s) links in `text`, in order, ignoring code. */
    function linksIn(text) {
      const plain = str(text).replace(/```[\s\S]*?(```|$)/g, ' ').replace(/`[^`\n]*`/g, ' ');
      const out = [];
      for (const m of plain.matchAll(URL_RE)) {
        let u = m[0];
        // A closing paren that belongs to the URL: wikipedia/Foo_(bar).
        if (plain[m.index + u.length] === ')' && u.includes('(')) u += ')';
        try {
          const href = new URL(u).href;
          if (!out.includes(href)) out.push(href);
        } catch {
          // Not a URL after all.
        }
      }
      return out;
    }
    const safeHref = (u) => {
      try {
        const p = new URL(u, 'http://x/').protocol;
        return p === 'http:' || p === 'https:' || p === 'mailto:' ? u : null;
      } catch {
        return null;
      }
    };
    /** Plain text with its bare links as anchors. */
    function linkify(text, keyBase) {
      const s = str(text);
      const out = [];
      let at = 0;
      let i = 0;
      for (const m of s.matchAll(URL_RE)) {
        if (m.index > at) out.push(s.slice(at, m.index));
        out.push(h('a', { key: `${keyBase}${i++}`, href: m[0], target: '_blank', rel: 'noreferrer noopener' }, m[0]));
        at = m.index + m[0].length;
      }
      if (at < s.length) out.push(s.slice(at));
      return out;
    }

    /** Inline Markdown: code, links, bold, italic, strike, bare URLs. */
    function mdInline(text, kb) {
      const s = str(text);
      const re = /(`+)([\s\S]*?[^`])\1(?!`)|!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|~~([\s\S]+?)~~|(?<![\w*])\*(?!\s)([^*\n]+?)\*(?!\w)|(?<![\w_])_(?!\s)([^_\n]+?)_(?!\w)|(https?:\/\/[^\s<>()"'`\]]*[^\s<>()"'`\].,;:!?。，；：！？、）】》」』])/g;
      const out = [];
      let at = 0;
      let i = 0;
      for (const m of s.matchAll(re)) {
        if (m.index > at) out.push(s.slice(at, m.index));
        const key = `${kb}.${i++}`;
        if (m[2] !== undefined) out.push(h('code', { key }, m[2].trim() || m[2]));
        else if (m[4] !== undefined) out.push(safeHref(m[4]) ? h('img', { key, src: m[4], alt: m[3], referrerPolicy: 'no-referrer', loading: 'lazy', style: { maxWidth: '100%', borderRadius: 8 } }) : m[0]);
        else if (m[6] !== undefined) out.push(safeHref(m[6]) ? h('a', { key, href: m[6], target: '_blank', rel: 'noreferrer noopener' }, mdInline(m[5], key)) : m[5]);
        else if (m[7] !== undefined || m[8] !== undefined) out.push(h('strong', { key }, mdInline(m[7] ?? m[8], key)));
        else if (m[9] !== undefined) out.push(h('del', { key }, mdInline(m[9], key)));
        else if (m[10] !== undefined || m[11] !== undefined) out.push(h('em', { key }, mdInline(m[10] ?? m[11], key)));
        else if (m[12] !== undefined) out.push(h('a', { key, href: m[12], target: '_blank', rel: 'noreferrer noopener' }, m[12]));
        at = m.index + m[0].length;
      }
      if (at < s.length) out.push(s.slice(at));
      return out;
    }
    const tableCells = (line) => {
      let l = line.trim();
      if (l.startsWith('|')) l = l.slice(1);
      if (l.endsWith('|') && !l.endsWith('\\|')) l = l.slice(0, -1);
      return l.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
    };
    const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
    const LIST_RE = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;

    /** A small block-level Markdown renderer: the fallback when the shell's renderer is absent. */
    function miniMarkdown(text) {
      const lines = str(text).replace(/\r\n?/g, '\n').split('\n');
      const blocks = [];
      let i = 0;
      let k = 0;
      const para = [];
      const flush = () => {
        if (!para.length) return;
        const key = `p${k++}`;
        const kids = [];
        para.forEach((l, j) => {
          if (j) kids.push(h('br', { key: `${key}b${j}` }));
          kids.push(...mdInline(l, `${key}.${j}`));
        });
        blocks.push(h('p', { key }, kids));
        para.length = 0;
      };
      while (i < lines.length) {
        const line = lines[i];
        const fence = /^\s*(```+|~~~+)\s*([\w+-]*)/.exec(line);
        if (fence) {
          flush();
          const body = [];
          i += 1;
          while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
          i += 1;
          blocks.push(h('pre', { key: `c${k++}` }, h('code', { className: fence[2] ? `language-${fence[2]}` : undefined }, body.join('\n'))));
          continue;
        }
        if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
          flush();
          const head = tableCells(line);
          const aligns = tableCells(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : undefined));
          i += 2;
          const rows = [];
          while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(tableCells(lines[i++]));
          const key = `t${k++}`;
          blocks.push(
            h(
              'div',
              { key, className: 'dshb-mdf-table' },
              h(
                'table',
                null,
                h('thead', null, h('tr', null, head.map((c, j) => h('th', { key: j, style: { textAlign: aligns[j] } }, mdInline(c, `${key}h${j}`))))),
                h('tbody', null, rows.map((r, ri) => h('tr', { key: ri }, head.map((_, j) => h('td', { key: j, style: { textAlign: aligns[j] } }, mdInline(r[j] ?? '', `${key}r${ri}.${j}`)))))),
              ),
            ),
          );
          continue;
        }
        const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
        if (heading) {
          flush();
          const key = `h${k++}`;
          blocks.push(h(`h${Math.min(6, heading[1].length + 2)}`, { key }, mdInline(heading[2], key)));
          i += 1;
          continue;
        }
        if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
          flush();
          blocks.push(h('hr', { key: `r${k++}` }));
          i += 1;
          continue;
        }
        if (/^\s{0,3}>/.test(line)) {
          flush();
          const body = [];
          while (i < lines.length && /^\s{0,3}>/.test(lines[i])) body.push(lines[i++].replace(/^\s{0,3}>\s?/, ''));
          blocks.push(h('blockquote', { key: `q${k++}` }, miniMarkdown(body.join('\n'))));
          continue;
        }
        const li = LIST_RE.exec(line);
        if (li) {
          flush();
          const ordered = /\d/.test(li[2]);
          const items = [];
          while (i < lines.length) {
            const m = LIST_RE.exec(lines[i]);
            if (m && /\d/.test(m[2]) === ordered && m[1].length < 2) {
              items.push([m[3]]);
              i += 1;
            } else if (items.length && lines[i].trim() && /^\s{2,}/.test(lines[i])) {
              items[items.length - 1].push(lines[i].replace(/^\s{2,4}/, ''));
              i += 1;
            } else break;
          }
          const key = `l${k++}`;
          const start = ordered ? Number.parseInt(li[2], 10) : undefined;
          blocks.push(
            h(
              ordered ? 'ol' : 'ul',
              { key, start: start && start !== 1 ? start : undefined },
              items.map((it, j) => {
                const task = /^\[([ xX])\]\s+(.*)$/.exec(it[0]);
                const first = task ? task[2] : it[0];
                const rest = it.slice(1).join('\n');
                return h(
                  'li',
                  { key: j, className: task ? 'dshb-mdf-task' : undefined },
                  task ? h('input', { type: 'checkbox', checked: task[1] !== ' ', readOnly: true, disabled: true }) : null,
                  mdInline(first, `${key}.${j}`),
                  rest ? miniMarkdown(rest) : null,
                );
              }),
            ),
          );
          continue;
        }
        if (!line.trim()) {
          flush();
          i += 1;
          continue;
        }
        para.push(line);
        i += 1;
      }
      flush();
      return blocks;
    }

    // --- link cards -----------------------------------------------------------------------

    const MAX_CARDS = 3;
    const unfurls = new Map();
    /** The preview of `url` from the Host (`null` while it loads), shared and cached across cards. */
    function useUnfurl(url) {
      const [, bump] = useState(0);
      useEffect(() => {
        if (!url) return undefined;
        let entry = unfurls.get(url);
        // A failure is retried by a mount a minute later.
        if (entry && entry.card && !entry.card.ok && Date.now() - entry.at > 60_000) entry = null;
        if (!entry) {
          entry = { card: null, at: 0, listeners: new Set() };
          unfurls.set(url, entry);
          Promise.resolve()
            .then(() => getJson(`unfurl?url=${encodeURIComponent(url)}`))
            .catch(() => null)
            .then((card) => {
              entry.card = card && typeof card === 'object' ? card : { ok: false, url, reason: 'unavailable' };
              entry.at = Date.now();
              for (const fn of entry.listeners) fn();
            });
        }
        if (entry.card) return undefined;
        const fn = () => bump((n) => n + 1);
        entry.listeners.add(fn);
        return () => entry.listeners.delete(fn);
      }, [url]);
      return url ? unfurls.get(url)?.card ?? null : null;
    }

    const hostOf = (u) => {
      try {
        return new URL(u).hostname.replace(/^www\./, '');
      } catch {
        return str(u);
      }
    };
    const fmtCount = (n) => {
      if (!Number.isFinite(n)) return '';
      try {
        return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n);
      } catch {
        return String(n);
      }
    };
    const fmtPostDate = (ms) => {
      try {
        return new Date(ms).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
      } catch {
        return '';
      }
    };
    const XGlyph = (s = 13) =>
      h('svg', { width: s, height: s, viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': 'true', style: { flex: 'none' } }, h('path', { d: 'M17.75 3h3.07l-6.7 7.66L22 21h-6.17l-4.83-6.32L5.47 21H2.4l7.17-8.2L2 3h6.33l4.37 5.78L17.75 3zm-1.08 16.17h1.7L7.4 4.73H5.58l11.09 14.44z' }));
    const YtGlyph = (s = 14) =>
      h('svg', { width: s, height: s, viewBox: '0 0 24 24', 'aria-hidden': 'true', style: { flex: 'none' } }, h('path', { fill: '#ff0033', d: 'M23 7.2a3 3 0 0 0-2.1-2.1C19 4.6 12 4.6 12 4.6s-7 0-8.9.5A3 3 0 0 0 1 7.2 31 31 0 0 0 .5 12c0 1.6.2 3.3.5 4.8a3 3 0 0 0 2.1 2.1c1.9.5 8.9.5 8.9.5s7 0 8.9-.5a3 3 0 0 0 2.1-2.1c.3-1.5.5-3.2.5-4.8s-.2-3.3-.5-4.8z' }), h('path', { fill: '#fff', d: 'M9.75 15.5V8.5L15.8 12l-6.05 3.5z' }));

    /** An image that removes itself when it fails to load. */
    function Img({ src, alt = '', style, className }) {
      const [bad, setBad] = useState(false);
      if (!src || bad) return null;
      return h('img', { src, alt, className, loading: 'lazy', referrerPolicy: 'no-referrer', draggable: false, onError: () => setBad(true), style });
    }

    /** One rich preview: a playable YouTube video, an X post or profile, or a page's OpenGraph card. */
    function LinkCard({ t, url }) {
      const card = useUnfurl(url);
      const host = hostOf(url);
      if (!card) {
        return h(
          'div',
          { className: 'dshb-lc dshb-lc-loading', 'data-dsh-bots-card': 'loading' },
          h('div', { className: 'dshb-lc-site' }, h(Img, { src: `https://${host}/favicon.ico`, style: { width: 14, height: 14, borderRadius: 3 } }), host),
          h('div', { className: 'dshb-skel', style: { width: '70%' } }),
          h('div', { className: 'dshb-skel', style: { width: '45%' } }),
        );
      }
      if (card.kind === 'youtube' && card.ok) return h(YouTubeCard, { t, card });
      if ((card.kind === 'x' || card.kind === 'x-profile') && card.ok) return card.kind === 'x' ? h(XPostCard, { t, card }) : h(XProfileCard, { t, card });
      if (card.kind === 'image' && card.ok) {
        return h('a', { className: 'dshb-lc dshb-lc-image', href: card.url, target: '_blank', rel: 'noreferrer noopener', 'data-dsh-bots-card': 'image' }, h(Img, { src: card.image, alt: card.title, style: { display: 'block', maxWidth: '100%', maxHeight: 360 } }));
      }
      if (card.ok && card.kind === 'page') return h(PageCard, { card });
      // No preview: a slim link row still says where it goes.
      return h(
        'a',
        { className: 'dshb-lc dshb-lc-slim', href: url, target: '_blank', rel: 'noreferrer noopener', title: card.reason || url, 'data-dsh-bots-card': 'link' },
        card.kind === 'x' ? XGlyph(13) : h(Img, { src: `https://${host}/favicon.ico`, style: { width: 14, height: 14, borderRadius: 3, flex: 'none' } }),
        h('span', { style: { fontWeight: 600, color: C.primary, flex: 'none' } }, host),
        h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: C.muted } }, url.replace(/^https?:\/\/(www\.)?/, '')),
        h('span', { style: { color: C.faint, display: 'inline-flex', flex: 'none' } }, Icon.open(11)),
      );
    }

    function PageCard({ card }) {
      const large = card.large && card.image;
      const site = h(
        'div',
        { className: 'dshb-lc-site' },
        h(Img, { src: card.icon, style: { width: 14, height: 14, borderRadius: 3 } }),
        h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, card.site || card.host),
        card.author ? h('span', { style: { color: C.faint } }, `· ${card.author}`) : null,
      );
      const body = h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, flex: 1, padding: '10px 12px' } },
        site,
        card.title ? h('div', { className: 'dshb-lc-title' }, card.title) : null,
        card.description ? h('div', { className: 'dshb-lc-desc' }, card.description) : null,
      );
      return h(
        'a',
        { className: 'dshb-lc', href: card.finalUrl || card.url, target: '_blank', rel: 'noreferrer noopener', 'data-dsh-bots-card': 'page', style: large ? { flexDirection: 'column' } : { flexDirection: 'row' } },
        large ? h(Img, { src: card.image, alt: card.title, style: { display: 'block', width: '100%', aspectRatio: '1.91 / 1', objectFit: 'cover', background: C.layer3 } }) : null,
        body,
        !large && card.image ? h(Img, { src: card.image, alt: '', style: { width: 104, minHeight: 104, alignSelf: 'stretch', objectFit: 'cover', flex: 'none', background: C.layer3 } }) : null,
      );
    }

    function YouTubeCard({ t, card }) {
      const [playing, setPlaying] = useState(false);
      const ratio = card.short ? '9 / 16' : '16 / 9';
      const src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(card.videoId)}?autoplay=1&rel=0&playsinline=1${card.start ? `&start=${card.start}` : ''}`;
      return h(
        'div',
        { className: 'dshb-lc', 'data-dsh-bots-card': 'youtube', style: { flexDirection: 'column', width: card.short ? 280 : undefined } },
        h(
          'div',
          { style: { position: 'relative', width: '100%', aspectRatio: ratio, background: '#000' } },
          playing
            ? h('iframe', { src, title: card.title || 'YouTube', allow: 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share', allowFullScreen: true, referrerPolicy: 'strict-origin-when-cross-origin', style: { position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0 } })
            : h(
                'button',
                { type: 'button', className: 'dshb-play', 'data-dsh-bots-play': card.videoId, title: t('link_play'), 'aria-label': t('link_play'), onClick: () => setPlaying(true) },
                h(Img, { src: card.image, alt: card.title, style: { position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' } }),
                h('span', { className: 'dshb-play-btn' }, YtGlyph(64)),
              ),
        ),
        h(
          'a',
          { href: card.url, target: '_blank', rel: 'noreferrer noopener', style: { display: 'flex', flexDirection: 'column', gap: 3, padding: '9px 12px', color: 'inherit', textDecoration: 'none' } },
          h('div', { className: 'dshb-lc-site' }, YtGlyph(14), h('span', null, 'YouTube'), card.author ? h('span', { style: { color: C.faint } }, `· ${card.author}`) : null),
          card.title ? h('div', { className: 'dshb-lc-title' }, card.title) : null,
        ),
      );
    }

    function XAuthor({ a, small }) {
      const size = small ? 18 : 36;
      return h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: small ? 6 : 9, minWidth: 0 } },
        a.avatar ? h(Img, { src: a.avatar, alt: '', style: { width: size, height: size, borderRadius: '50%', flex: 'none', objectFit: 'cover' } }) : null,
        h(
          'div',
          { style: { display: 'flex', flexDirection: small ? 'row' : 'column', gap: small ? 5 : 0, minWidth: 0, lineHeight: 1.3 } },
          h(
            'span',
            { style: { fontWeight: 700, color: C.primary, fontSize: small ? TINY : SMALL, display: 'inline-flex', alignItems: 'center', gap: 3, overflow: 'hidden', whiteSpace: 'nowrap' } },
            a.name || a.handle,
            a.verified ? h('svg', { width: 13, height: 13, viewBox: '0 0 24 24', 'aria-hidden': 'true', style: { flex: 'none' } }, h('path', { fill: '#1d9bf0', d: 'M12 1.5l2.6 2 3.2-.3 1 3.1 2.8 1.6-.9 3.1 1.3 3-2.5 2-.4 3.2-3.2.4-2 2.5-3-1.3-3.1.9-1.6-2.8-3.1-1 .3-3.2-2-2.6 2-2.6-.3-3.2 3.1-1 1.6-2.8 3.1.9z' }), h('path', { d: 'M8 12.3l2.6 2.6L16.2 9', stroke: '#fff', strokeWidth: 2.2, fill: 'none', strokeLinecap: 'round', strokeLinejoin: 'round' })) : null,
          ),
          a.handle ? h('span', { style: { color: C.faint, fontSize: TINY } }, `@${a.handle}`) : null,
        ),
      );
    }

    function XMedia({ media }) {
      if (!media || !media.length) return null;
      const one = media.length === 1;
      return h(
        'div',
        { className: 'dshb-xmedia', 'data-count': media.length, style: { display: 'grid', gridTemplateColumns: one ? '1fr' : '1fr 1fr', gap: 2, borderRadius: 12, overflow: 'hidden', border: `1px solid ${C.border1}` } },
        media.map((m, i) =>
          m.type === 'photo'
            ? h('a', { key: i, href: m.url, target: '_blank', rel: 'noreferrer noopener', style: { display: 'block', gridRow: media.length === 3 && i === 0 ? 'span 2' : undefined } }, h(Img, { src: m.url, alt: '', style: { display: 'block', width: '100%', height: one ? 'auto' : '100%', maxHeight: one ? 420 : 200, aspectRatio: one ? undefined : '1 / 1', objectFit: 'cover' } }))
            : h('video', { key: i, src: m.url, poster: m.thumb, controls: true, playsInline: true, preload: 'none', loop: m.type === 'gif', muted: m.type === 'gif', autoPlay: m.type === 'gif', style: { display: 'block', width: '100%', maxHeight: 420, background: '#000' } }),
        ),
      );
    }

    function XPostCard({ t, card }) {
      const stats = [
        [card.replies, 'M4 5h16v11H8l-4 4z'],
        [card.retweets, 'M7 7h10v6M17 17H7v-6M4 10l3-3 3 3M20 14l-3 3-3-3'],
        [card.likes, 'M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z'],
        [card.views, 'M5 20V12M10 20V6M15 20v-9M20 20V4'],
      ].filter(([n]) => Number.isFinite(n) && n > 0);
      return h(
        'div',
        { className: 'dshb-lc', 'data-dsh-bots-card': 'x', style: { flexDirection: 'column', gap: 8, padding: '11px 13px' } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'flex-start', gap: 8 } },
          h('div', { style: { flex: 1, minWidth: 0 } }, h(XAuthor, { a: card.author })),
          h('a', { href: card.url, target: '_blank', rel: 'noreferrer noopener', title: t('link_open'), style: { color: C.primary, display: 'inline-flex', padding: 2 } }, XGlyph(16)),
        ),
        card.text ? h('div', { className: 'dshb-md', style: { fontSize: FONT, lineHeight: 1.5, color: C.primary } }, linkify(card.text, 'x')) : null,
        h(XMedia, { media: card.media }),
        card.quote
          ? h(
              'a',
              { href: card.quote.url, target: '_blank', rel: 'noreferrer noopener', style: { display: 'flex', flexDirection: 'column', gap: 5, padding: '8px 10px', border: `1px solid ${C.border1}`, borderRadius: 12, color: 'inherit', textDecoration: 'none' } },
              h(XAuthor, { a: card.quote.author, small: true }),
              card.quote.text ? h('div', { className: 'dshb-md', style: { fontSize: SMALL, color: C.primary, display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical', overflow: 'hidden' } }, card.quote.text) : null,
              h(XMedia, { media: card.quote.media.slice(0, 1) }),
            )
          : null,
        h(
          'a',
          { href: card.url, target: '_blank', rel: 'noreferrer noopener', style: { display: 'flex', alignItems: 'center', gap: 14, color: C.faint, fontSize: TINY, textDecoration: 'none', flexWrap: 'wrap' } },
          card.createdAt ? h('span', null, fmtPostDate(card.createdAt)) : null,
          stats.map(([n, d], i) => h('span', { key: i, style: { display: 'inline-flex', alignItems: 'center', gap: 4 } }, svg(13, [d]), fmtCount(n))),
        ),
      );
    }

    function XProfileCard({ t, card }) {
      return h(
        'a',
        { className: 'dshb-lc', href: card.url, target: '_blank', rel: 'noreferrer noopener', 'data-dsh-bots-card': 'x-profile', style: { flexDirection: 'column' } },
        card.banner ? h(Img, { src: card.banner, alt: '', style: { display: 'block', width: '100%', aspectRatio: '3 / 1', objectFit: 'cover' } }) : null,
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 13px' } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } }, h('div', { style: { flex: 1, minWidth: 0 } }, h(XAuthor, { a: card.author })), XGlyph(16)),
          card.text ? h('div', { className: 'dshb-md', style: { fontSize: SMALL, color: C.primary } }, card.text) : null,
          h(
            'div',
            { style: { display: 'flex', gap: 14, fontSize: TINY, color: C.muted } },
            Number.isFinite(card.following) ? h('span', null, h('b', { style: { color: C.primary } }, fmtCount(card.following)), ' ', t('link_following')) : null,
            Number.isFinite(card.followers) ? h('span', null, h('b', { style: { color: C.primary } }, fmtCount(card.followers)), ' ', t('link_followers')) : null,
          ),
        ),
      );
    }

    /** `value`, once it has stopped changing for `ms`. */
    function useDebounced(value, ms) {
      const [v, setV] = useState(value);
      useEffect(() => {
        if (v === value) return undefined;
        const id = setTimeout(() => setV(value), ms);
        return () => clearTimeout(id);
      }, [value]);
      return v;
    }

    function useMessages(botId, active = true) {
      const [items, setItems] = useState(null);
      const [failed, setFailed] = useState(false);
      const alive = useRef(true);
      useEffect(() => {
        alive.current = true;
        setItems(null);
        return () => {
          alive.current = false;
        };
      }, [botId]);
      const load = () =>
        Promise.resolve()
          .then(() => getJson(`messages?limit=200${botId ? `&bot=${encodeURIComponent(botId)}` : ''}`))
          .then((r) => {
            if (!alive.current) return;
            if (r && Array.isArray(r.items)) {
              setFailed(false);
              setItems((prev) => (prev && prev.length === r.items.length && prev[prev.length - 1]?.id === r.items[r.items.length - 1]?.id ? prev : r.items));
            } else setFailed(true);
          })
          .catch(() => {
            if (alive.current) setFailed(true);
          });
      usePoll(() => (active ? load() : undefined), CHAT_POLL_MS, [botId, active]);
      return { items, failed, reload: load };
    }

    /** A first chat: the bot's bio and three opening messages to start from. */
    function ChatEmpty({ t, bot, onPick }) {
      const primary = bot.role === 'primary' || bot.id === store.state?.primaryId;
      const ids = primary ? ['p1', 'p2', 'p3'] : ['b1', 'b2', 'b3'];
      return h(
        'div',
        { 'data-dsh-bots-chat-empty': true, style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: '48px 20px 20px', textAlign: 'center', maxWidth: 560, margin: '0 auto' } },
        h(Avatar, { avatar: bot.avatar, name: bot.name, size: 56, ring: primary }),
        h('div', { style: { fontWeight: 700, fontSize: 16 } }, t('chatEmptyTitle', { name: bot.name })),
        h('div', { style: { fontSize: SMALL, color: C.muted, lineHeight: 1.6 } }, bot.bio || t('chatEmptyBody')),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 8, width: '100%', marginTop: 8 } },
          ids.map((id) =>
            h(
              'button',
              { key: id, type: 'button', className: 'dshb-row', 'data-dsh-bots-suggestion': id, onClick: () => onPick(t(`suggest_${id}`)), style: { border: `1px solid ${C.border1}`, background: C.layer1, padding: '10px 14px', justifyContent: 'space-between' } },
              h('span', { style: { fontSize: SMALL } }, t(`suggest_${id}`)),
              h('span', { style: { color: C.faint, display: 'inline-flex' } }, Icon.arrow(12)),
            ),
          ),
        ),
      );
    }

    /**
     * Keep a scrolling thread at its bottom while the reader is there: when a message arrives, and when
     * something already shown grows later (a link card or picture loading, the "working" line appearing).
     * Scrolled up to read, the reader is left alone; `stick()` brings them back (after they send).
     */
    function useStickToBottom(lastKey) {
      const box = useRef(null);
      const content = useRef(null);
      const pinned = useRef(true);
      const toBottom = () => {
        const el = box.current;
        if (el) el.scrollTop = el.scrollHeight;
      };
      useEffect(() => {
        if (pinned.current) toBottom();
      }, [lastKey]);
      useEffect(() => {
        if (typeof ResizeObserver !== 'function' || !content.current) return undefined;
        const ro = new ResizeObserver(() => {
          if (pinned.current) toBottom();
        });
        ro.observe(content.current);
        return () => ro.disconnect();
      }, [content.current]);
      const onScroll = (e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      };
      const stick = () => {
        pinned.current = true;
        toBottom();
      };
      return { box, content, onScroll, stick };
    }

    function ChatTab({ t, bot, env, toast }) {
      const { items, failed, reload } = useMessages(bot.id);
      const [text, setText] = useState('');
      const [sending, setSending] = useState(false);
      const running = bot.status === 'running';
      const thread = useStickToBottom(`${items?.length ?? 0}:${items?.[items.length - 1]?.id ?? ''}:${running}`);
      const [topicBusy, setTopicBusy] = useState(false);
      const startTopic = () => {
        setTopicBusy(true);
        postJson('topic/new', { id: bot.id })
          .then((r) => {
            if (r?.ok) {
              toast(t('newTopicDone', { name: bot.name || `@${bot.handle}` }));
              void reload();
              void refreshState();
            } else toast(r?.reason || t('actionFailed'), 'error');
          })
          .finally(() => setTopicBusy(false));
      };
      const send = () => {
        const body = text.trim();
        if (!body || sending) return;
        setSending(true);
        thread.stick();
        postJson('send', { to: bot.id, text: body })
          .then((r) => {
            if (r?.ok) {
              setText('');
              thread.stick();
              void reload();
              void refreshState();
            } else toast(r?.reason || t('sendFailed'), 'error');
          })
          .finally(() => setSending(false));
      };
      // A pasted link previews above the composer, as it will in the thread.
      const previewUrl = linksIn(useDebounced(text, 400))[0] ?? '';
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 } },
        h(
          'div',
          { className: 'dshb-scroll', 'data-dsh-bots-thread': bot.id, ref: thread.box, onScroll: thread.onScroll, style: { flex: 1, padding: '6px 24px' } },
          h(
            'div',
            { ref: thread.content },
          items === null
            ? h('div', { style: { padding: 24, color: C.faint, fontSize: SMALL, textAlign: 'center' } }, failed ? t('unavailable') : t('loading'))
            : h(MessageList, {
                t,
                items,
                botId: bot.id,
                empty: h(ChatEmpty, { t, bot, onPick: setText }),
              }),
          running
            ? h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0 4px', color: C.muted, fontSize: SMALL, maxWidth: 880, margin: '0 auto' } },
                h(Avatar, { avatar: bot.avatar, name: bot.name, size: 22 }),
                h('span', null, t('working', { name: bot.name })),
                h('span', { style: { display: 'inline-flex', gap: 3 } }, [0, 1, 2].map((i) => h('span', { key: i, style: { width: 4, height: 4, borderRadius: '50%', background: C.muted, animation: `dshb-blink 1.2s ${i * 0.2}s infinite` } }))),
              )
            : null,
          ),
        ),
        h(
          'div',
          { style: { padding: '10px 24px 16px', borderTop: `1px solid ${C.border1}`, background: C.base } },
          h(
            'div',
            { style: { maxWidth: 880, margin: '0 auto' } },
          previewUrl ? h('div', { 'data-dsh-bots-composer-preview': previewUrl, style: { marginBottom: 8, maxHeight: 260, overflow: 'auto' } }, h(LinkCard, { t, url: previewUrl })) : null,
          h(
            'div',
            { style: { display: 'flex', alignItems: 'flex-end', gap: 8, padding: 6, borderRadius: 14, border: `1px solid ${C.border}`, background: C.layer1 } },
            h('textarea', {
              'data-dsh-bots-composer': true,
              value: text,
              rows: Math.min(8, Math.max(1, text.split('\n').length)),
              placeholder: t('composer', { handle: bot.handle }),
              onChange: (e) => setText(e.target.value),
              onKeyDown: (e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !e.nativeEvent?.isComposing) {
                  e.preventDefault();
                  send();
                }
              },
              style: { flex: 1, minHeight: 32, maxHeight: 200, resize: 'none', border: 'none', outline: 'none', background: 'transparent', color: C.primary, font: 'inherit', fontSize: FONT, lineHeight: 1.5, padding: '6px 8px' },
            }),
            h(Btn, { kind: 'primary', icon: Icon.send(15), title: t('send'), disabled: !text.trim() || sending, onClick: send, style: { borderRadius: 10, width: 34, height: 34 } }),
          ),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 7, fontSize: TINY, color: C.faint } },
            h('span', null, t('composerHint')),
            h('span', { style: { flex: 1 } }),
            bot.topic ? h('span', { 'data-dsh-bots-topic': true, title: t('topicNow', { when: fmtAgo(t, bot.topic.startedAt), n: bot.topic.tasks, ctx: fmtNum(bot.topic.context) }) }, t('topicShort', { n: bot.topic.tasks, ctx: fmtNum(bot.topic.context) })) : null,
            h('button', { type: 'button', className: 'dshb-link', title: t('newTopicHint'), disabled: running || topicBusy || !bot.sessionId, onClick: startTopic, 'data-dsh-bots-new-topic': 'chat', style: { fontSize: TINY, display: 'inline-flex', alignItems: 'center', gap: 4, opacity: running || !bot.sessionId ? 0.5 : 1 } }, Icon.plus(11), t('newTopic')),
            env.canOpen() ? h('span', { style: { color: C.faint } }, '·') : null,
            env.canOpen() ? h('button', { type: 'button', className: 'dshb-link', style: { fontSize: TINY, display: 'inline-flex', alignItems: 'center', gap: 4 }, onClick: () => env.openBot(bot) }, Icon.open(11), t('fullTranscript')) : null,
          ),
          ),
        ),
      );
    }

    function ActivityView({ t, bots }) {
      const { items, failed } = useMessages(null);
      const [filter, setFilter] = useState('');
      const shown = (items ?? []).filter((m) => !filter || m.from === filter || m.to === filter).slice().reverse();
      const names = threadNamesOf(items);
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 12, padding: '18px 24px 12px', borderBottom: `1px solid ${C.border1}` } },
          h('span', { style: { width: 44, height: 44, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: C.layer2, color: C.label } }, Icon.activity(20)),
          h('div', { style: { flex: 1, minWidth: 0 } }, h('div', { style: { fontWeight: 700, fontSize: 17 } }, t('activity')), h('div', { style: { fontSize: SMALL, color: C.muted } }, t('activitySub'))),
          h(
            'select',
            { className: 'dshb-input', value: filter, onChange: (e) => setFilter(e.target.value), style: { width: 200, height: 30, fontSize: SMALL }, 'aria-label': t('filterBot') },
            h('option', { value: '' }, t('allBots')),
            bots.map((b) => h('option', { key: b.id, value: b.id }, `${b.name} (@${b.handle})`)),
          ),
        ),
        h(
          'div',
          { className: 'dshb-scroll', 'data-dsh-bots-timeline': true, style: { flex: 1, padding: '8px 24px 24px' } },
          h(
            'div',
            { style: { maxWidth: 960, margin: '0 auto' } },
          items === null
            ? h('div', { style: { padding: 24, color: C.faint, fontSize: SMALL, textAlign: 'center' } }, failed ? t('unavailable') : t('loading'))
            : shown.length === 0
              ? h(Empty, { icon: Icon.activity(28), title: t('activityEmptyTitle'), body: t('activityEmptyBody') })
              : shown.map((m, i) => {
                  const from = party(t, m.from);
                  const to = party(t, m.to);
                  return h(
                    'div',
                    { key: m.id ?? i, 'data-dsh-bots-event': m.kind, style: { display: 'flex', gap: 12, padding: '12px 0', borderBottom: `1px solid ${C.border1}` } },
                    h(
                      'div',
                      { style: { position: 'relative', width: 40, height: 34, flex: 'none' } },
                      h('span', { style: { position: 'absolute', left: 0, top: 0 } }, h(PartyAvatar, { p: from, size: 30 })),
                      h('span', { style: { position: 'absolute', left: 21, top: 19, display: 'inline-flex', borderRadius: '50%', boxShadow: `0 0 0 2px ${C.base}` } }, h(PartyAvatar, { p: to, size: 17 })),
                    ),
                    h(
                      'div',
                      { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 } },
                      h(
                        'div',
                        { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: SMALL, flexWrap: 'wrap' } },
                        h('span', { style: { fontWeight: 600 } }, from.name),
                        h('span', { style: { color: C.faint, display: 'inline-flex' } }, Icon.arrow(11)),
                        h('span', { style: { fontWeight: 600 } }, to.name),
                        h(Badge, { color: m.kind === 'dm' ? C.label : m.kind === 'system' ? C.warn : C.muted }, t(`kind_${m.kind}`) || m.kind),
                        messageReport(m) ? h(ReportChip, { t, status: messageReport(m) }) : null,
                        messageNotice(m) ? h(StageChip, { t, stage: messageNotice(m) }) : null,
                        messageTicket(m) ? h('button', { type: 'button', className: 'dshb-link', 'data-dsh-bots-event-task': messageTicket(m), onClick: () => openTicket(messageTicket(m)), style: { fontSize: TINY } }, t('openTask')) : null,
                        m.via ? h(Badge, { color: CHANNEL_COLORS[m.via] ?? C.muted, 'data-dsh-bots-via': m.via }, m.from === 'user' && m.who ? `${channelName(m.via, t)} · ${str(m.who)}` : isChatThread(m.thread) ? threadName(t, m.thread, names) : channelName(m.via, t)) : null,
                        m.notSent === true ? h(Badge, { color: C.warn, 'data-dsh-bots-not-sent': true, title: (Array.isArray(m.choices) ? m.choices.filter(isChatThread) : []).map((k) => threadName(t, k, names)).join(t('listSep')) }, t('notSent')) : null,
                        h('span', { style: { marginLeft: 'auto', color: C.faint, fontSize: TINY }, title: fmtDate(toMs(m.at)) }, fmtAgo(t, m.at)),
                      ),
                      h(Clamp, { t, text: m.kind === 'topic' ? t('topicDivider', { reason: t(`topicReason_${m.text}`) }) : m.text, lines: 3, style: { fontSize: SMALL, color: C.muted } }),
                    ),
                  );
                }),
          ),
        ),
      );
    }

    // --- tasks: the list, one task, a bot's open tasks, cards in the timeline ---------------

    const NEEDS_YOU = ['question', 'failed', 'stalled'];
    const FINISHED = ['done', 'stopped'];
    const STAGE_COLOR = { question: C.warn, failed: C.error, stalled: C.warn, queued: C.muted, working: C.ok, done: C.label, stopped: C.muted };
    const REPORT_STATUSES = ['progress', 'done', 'blocked', 'question'];
    const REPORT_COLOR = { progress: C.muted, done: C.ok, blocked: C.error, question: C.warn };
    /** Open tasks of a bot, from the polled counts. */
    const openTaskCount = (bot) => ['working', 'question', 'stalled', 'queued'].reduce((n, k) => n + (Number(bot?.tickets?.[k]) || 0), 0);
    const DONE_PAGE = 20;
    const groupOf = (row) => (NEEDS_YOU.includes(row?.stage) ? 'needs' : FINISHED.includes(row?.stage) ? 'done' : 'progress');
    const newestFirst = (a, b) => (toMs(b.updatedAt ?? b.createdAt) || 0) - (toMs(a.updatedAt ?? a.createdAt) || 0);
    const taskTitle = (t, row) => str(row?.title).trim() || t('untitledTask');
    const firstLine = (text) => (str(text).split('\n').find((l) => l.trim() !== '') ?? '').trim().slice(0, 120);
    /** The task a timeline message belongs to (a delegation, or a report on it), or ''. */
    function messageTicket(m) {
      const v = m?.ticket && typeof m.ticket === 'object' ? m.ticket.id : (m?.ticket ?? m?.ticketId);
      return typeof v === 'string' ? v : '';
    }
    /** The status of a worker's report on a timeline message, or ''. */
    function messageReport(m) {
      const v = m?.report && typeof m.report === 'object' ? m.report.status : (m?.report ?? m?.status);
      return REPORT_STATUSES.includes(v) ? v : '';
    }
    /** The stage a watchdog notice on a timeline message tells of (a task stuck, or failed for good), or ''. */
    const messageNotice = (m) => (m?.kind === 'dm' && messageTicket(m) && (m.status === 'stalled' || m.status === 'failed') ? m.status : '');
    function StageChip({ t, stage }) {
      if (!STAGE_COLOR[stage]) return null;
      return h(Badge, { color: STAGE_COLOR[stage], 'data-dsh-bots-stage': stage }, stage === 'working' ? h(StatusDot, { status: 'running', size: 6 }) : null, t(`stage_${stage}`));
    }
    const ReportChip = ({ t, status }) => (REPORT_COLOR[status] ? h(Badge, { color: REPORT_COLOR[status], 'data-dsh-bots-report': status }, t(`report_${status}`)) : null);
    /** Who asked for a task: you, or a bot (the dispatcher, or the bot of a parent task). */
    const requesterBot = (row) => {
      const r = row?.requester ?? {};
      return r.kind === 'user' || typeof r.botId !== 'string' || !r.botId ? null : r.botId;
    };
    const requesterText = (t, row) => (requesterBot(row) ? t('askedBy', { name: botName(t, requesterBot(row)) }) : t('askedByYou'));
    const requesterName = (t, row) => (requesterBot(row) ? botName(t, requesterBot(row)) : t('you'));
    /** The chat a task came in from, as a badge (a scheduled run's task says so). */
    function viaBadge(t, via, who) {
      if (!via || typeof via !== 'string') return null;
      if (via === 'schedule') return h(Badge, { color: C.warn, 'data-dsh-bots-task-via': via }, t('trigger_schedule'));
      const label = via === 'panel' ? t('viaPanel') : channelName(via, t);
      return h(Badge, { color: CHANNEL_COLORS[via] ?? C.muted, 'data-dsh-bots-task-via': via }, who ? `${label} · ${str(who)}` : label);
    }
    const BotFace = ({ id, size }) => {
      const b = botById(id);
      return b ? h(Avatar, { avatar: b.avatar, name: b.name || b.handle, size }) : h(PartyAvatar, { p: { kind: 'unknown' }, size });
    };
    const dotSep = () => h('span', { style: { color: C.faint } }, '·');

    /** One task in a list: title and stage, then bot, who asked, where from and when, then the last report. */
    function TaskRow({ t, row, onOpen = openTicket, showBot = true }) {
      const at = row.updatedAt ?? row.createdAt;
      const last = row.lastReport && typeof row.lastReport === 'object' ? row.lastReport : null;
      return h(
        'button',
        { type: 'button', className: 'dshb-row', 'data-dsh-bots-task': row.id, 'data-stage': row.stage, onClick: () => onOpen(row.id), style: { alignItems: 'flex-start', padding: '9px 10px' } },
        showBot ? h('span', { style: { paddingTop: 1, display: 'inline-flex' } }, h(BotFace, { id: row.botId, size: 30 })) : null,
        h(
          'span',
          { style: { display: 'flex', flexDirection: 'column', gap: 3, flex: 1, minWidth: 0 } },
          h(
            'span',
            { style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 } },
            h('span', { style: { fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1 } }, taskTitle(t, row)),
            h(StageChip, { t, stage: row.stage }),
          ),
          h(
            'span',
            { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: TINY, color: C.muted, minWidth: 0, flexWrap: 'wrap' } },
            showBot ? h('span', { style: { fontWeight: 600, color: C.primary } }, botName(t, row.botId)) : null,
            showBot ? dotSep() : null,
            h('span', null, requesterText(t, row)),
            viaBadge(t, row.via),
            h('span', { style: { color: C.faint }, title: fmtDate(toMs(at)) }, fmtAgo(t, at)),
          ),
          last && str(last.preview).trim()
            ? h(
                'span',
                { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: TINY, color: C.muted, minWidth: 0 } },
                h(ReportChip, { t, status: last.status }),
                h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 } }, str(last.preview)),
              )
            : null,
        ),
      );
    }
    const TaskList = ({ rows, children, attr }) =>
      h('div', { [attr ?? 'data-dsh-bots-task-list']: true, className: 'dshb-card', style: { padding: 4, display: 'flex', flexDirection: 'column', gap: 2 } }, rows, children ?? null);

    /** A task in a timeline or a tool card: title, the bot doing it and its stage; it opens the detail. */
    // Its seat (the panel, or a tool view) is subscribed to the store and re-renders it when the task loads.
    function TaskCard({ t, id, botId, title, stage, face, onOpen = openTicket }) {
      usePoll(() => loadTicket(id), 10_000, [id]);
      const v = store.tickets.get(id)?.view ?? null;
      const bot = botById(v?.botId ?? botId) ?? (face && typeof face === 'object' && (face.name || face.handle) ? face : null);
      return h(
        'button',
        {
          type: 'button',
          className: 'dshb-row',
          'data-dsh-bots-task-card': id,
          title: t('openTask'),
          onClick: (e) => {
            e?.stopPropagation?.();
            onOpen(id);
          },
          style: { border: `1px solid ${C.border1}`, background: C.layer1, padding: '7px 10px', gap: 9, maxWidth: 560 },
        },
        h('span', { style: { width: 26, height: 26, borderRadius: 8, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: tint(C.label, 14), color: C.label, flex: 'none' } }, Icon.tasks(14)),
        h(
          'span',
          { style: { display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0, flex: 1 } },
          h('span', { style: { fontWeight: 600, fontSize: SMALL, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, str(v?.title).trim() || str(title).trim() || t('untitledTask')),
          h(
            'span',
            { style: { display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: TINY, color: C.muted, minWidth: 0 } },
            bot ? h(Avatar, { avatar: bot.avatar, name: bot.name || bot.handle, size: 14 }) : null,
            h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, t('taskOf', { name: bot ? bot.name || `@${bot.handle}` : t('removedBot') })),
          ),
        ),
        h(StageChip, { t, stage: v?.stage ?? stage }),
        h('span', { style: { color: C.faint, display: 'inline-flex' } }, Icon.arrow(11)),
      );
    }

    /** Every task: what needs you, what is moving, what finished lately. */
    function TasksView({ t, bots, focusBot = '', onOpen = openTicket }) {
      const [bot, setBot] = useState(focusBot);
      const [doneShown, setDoneShown] = useState(DONE_PAGE);
      useEffect(() => {
        setBot(focusBot);
      }, [focusBot]);
      // The newest 200 (the Host's page limit): open tasks are touched often, so they are near the top.
      const { data, failed } = useJson(`tickets?limit=200${bot ? `&bot=${encodeURIComponent(bot)}` : ''}`, STATE_POLL_MS);
      const items = (Array.isArray(data?.items) ? data.items : []).filter((r) => r && typeof r.id === 'string' && (!bot || r.botId === bot));
      // The polled list of what needs you fills in when the page is not loaded yet, or is longer than a page.
      const attention = (Array.isArray(store.state?.attention) ? store.state.attention : []).filter((r) => r && typeof r.id === 'string' && (!bot || r.botId === bot) && !items.some((x) => x.id === r.id));
      const all = [...items, ...attention];
      const groups = [
        { id: 'needs', title: t('tasksNeeds'), empty: t('tasksNeedsEmpty') },
        { id: 'progress', title: t('tasksProgress'), empty: t('tasksProgressEmpty') },
        { id: 'done', title: t('tasksDone'), empty: t('tasksDoneEmpty') },
      ].map((g) => ({ ...g, rows: all.filter((r) => groupOf(r) === g.id).sort(newestFirst) }));
      const doneCount = groups[2].rows.length;
      groups[2].rows = groups[2].rows.slice(0, doneShown);
      let body;
      if (!data && all.length === 0) body = h('div', { style: { padding: 24, color: C.faint, fontSize: SMALL, textAlign: 'center' } }, failed ? t('tasksUnavailable') : t('loading'));
      else if (all.length === 0) body = h(Empty, { icon: Icon.tasks(28), title: bot ? t('tasksEmptyBotTitle', { name: botName(t, bot) }) : t('tasksEmptyTitle'), body: t('tasksEmptyBody') });
      else {
        body = h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 24 } },
          groups.map((g) =>
            h(
              'div',
              { key: g.id, 'data-dsh-bots-task-group': g.id, 'data-count': g.rows.length },
              h(
                Section,
                { title: [g.title, h('span', { key: 'n', style: { marginLeft: 6, fontWeight: 500, color: C.faint } }, g.id === 'done' ? doneCount : g.rows.length)] },
                g.rows.length === 0 ? h('div', { style: { fontSize: SMALL, color: C.faint, padding: '2px 2px 4px' } }, g.empty) : h(TaskList, { rows: g.rows.map((r) => h(TaskRow, { key: r.id, t, row: r, onOpen })) }),
                g.id === 'done' && doneCount > doneShown ? h('div', null, h(Btn, { size: 'sm', kind: 'ghost', onClick: () => setDoneShown((n) => n + DONE_PAGE), 'data-dsh-bots-tasks-more': true }, t('showMore'))) : null,
              ),
            ),
          ),
        );
      }
      return h(
        'div',
        { 'data-dsh-bots-tasks': true, style: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 12, padding: '18px 24px 12px', borderBottom: `1px solid ${C.border1}` } },
          h('span', { style: { width: 44, height: 44, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: C.layer2, color: C.label } }, Icon.tasks(20)),
          h('div', { style: { flex: 1, minWidth: 0 } }, h('div', { style: { fontWeight: 700, fontSize: 17 } }, t('tasks')), h('div', { style: { fontSize: SMALL, color: C.muted } }, t('tasksSub'))),
          h(
            'select',
            { className: 'dshb-input', value: bot, onChange: (e) => setBot(e.target.value), style: { width: 200, height: 30, fontSize: SMALL }, 'aria-label': t('filterBot'), 'data-dsh-bots-tasks-bot': true },
            h('option', { value: '' }, t('allBots')),
            bots.map((b) => h('option', { key: b.id, value: b.id }, `${b.name} (@${b.handle})`)),
          ),
        ),
        h('div', { className: 'dshb-scroll', style: { flex: 1, padding: '18px 24px 28px' } }, h('div', { style: { maxWidth: 900, margin: '0 auto' } }, body)),
      );
    }

    /** One task: who does it and for whom, where it came from, the reports, its usage, and what you can do with it. */
    function TicketDetail({ t, id, env, toast, onBack }) {
      const { data, failed, reload } = useJson(`tickets/${encodeURIComponent(id)}`, STATE_POLL_MS);
      const [confirm, setConfirm] = useState(null);
      const [busy, setBusy] = useState('');
      const [text, setText] = useState('');
      const [sending, setSending] = useState(false);
      const v = ticketViewOf(data);
      const back = h('button', { type: 'button', className: 'dshb-link', 'data-dsh-bots-tasks-back': true, onClick: onBack, style: { display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: SMALL } }, Icon.back(12), t('allTasks'));
      if (!v) {
        return h(
          'div',
          { 'data-dsh-bots-ticket': id, style: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, padding: '18px 24px' } },
          back,
          h('div', { style: { padding: 24, color: C.faint, fontSize: SMALL, textAlign: 'center' } }, failed ? t('taskMissing') : t('loading')),
        );
      }
      const name = botName(t, v.botId);
      const stage = v.stage;
      const open = !FINISHED.includes(stage) && !v.ended;
      const archived = Boolean(v.archivedAt || v.archived);
      const after = (r, okText) => {
        if (r && r.ok !== false) {
          const next = ticketViewOf(r);
          if (next) store.tickets.set(id, { view: next, at: Date.now() });
          if (okText) toast(okText);
          void reload();
          void refreshState();
          return true;
        }
        toast(r?.reason || t('actionFailed'), 'error');
        return false;
      };
      const act = (action) => {
        setBusy(action);
        return postJson(`tickets/${encodeURIComponent(id)}/${action}`, {})
          .then((r) => void after(r, t(`taskDid_${action}`)))
          .finally(() => setBusy(''));
      };
      const send = () => {
        const body = text.trim();
        if (!body || sending) return;
        setSending(true);
        postJson(`tickets/${encodeURIComponent(id)}/message`, { text: body })
          .then((r) => {
            if (after(r, t('taskMessageSent', { name }))) setText('');
          })
          .finally(() => setSending(false));
      };
      const openConversation = () => {
        const ok = Boolean(v.sessionId) && env?.openSession?.(v.sessionId) === true;
        if (!ok) toast(t('openFailed'), 'error');
      };
      const origin = v.origin && typeof v.origin === 'object' ? v.origin : {};
      const threads = Array.isArray(v.threads) ? v.threads : [];
      const originThread = threads.find((x) => (x?.key ?? x) === origin.threadKey) ?? threads[0];
      const originKind = str(originThread?.kind) || str(origin.threadKey).split(':')[0];
      const fromPanelThread = originKind === 'panel';
      const where = fromPanelThread ? '' : str(origin.label) || str(originThread?.label);
      const via = v.via ?? origin.via ?? (fromPanelThread ? '' : originThread?.kind);
      const parentId = typeof v.parentId === 'string' ? v.parentId : typeof v.parent === 'string' ? v.parent : v.parent?.id;
      const children = (Array.isArray(v.children) ? v.children : []).map((c) => (typeof c === 'string' ? c : c?.id)).filter((c) => typeof c === 'string');
      const reports = (Array.isArray(v.reports) ? v.reports : []).filter((r) => r && typeof r === 'object').slice().sort((a, b) => (toMs(a.at) || 0) - (toMs(b.at) || 0));
      const runs = (Array.isArray(v.runs) ? v.runs : []).filter((r) => r && typeof r === 'object');
      // The Host's totals also count calls outside a run (the task's memory summary); else the runs' sum.
      const total = v.usage && typeof v.usage === 'object' ? v.usage : null;
      const tokens = total ? Number(total.tokens) || 0 : runs.reduce((n, r) => n + (Number(r.tokens) || 0), 0);
      const cost = {};
      if (total) Object.assign(cost, total.cost ?? {});
      else for (const r of runs) for (const [c, x] of Object.entries(r.cost ?? {})) cost[c] = (cost[c] ?? 0) + (Number(x) || 0);
      const fact = (label, value, attr) => (value ? h('div', { key: label, 'data-dsh-bots-ticket-fact': attr, style: { display: 'flex', gap: 12, alignItems: 'baseline', minWidth: 0 } }, h('span', { style: { width: 96, flex: 'none', fontSize: TINY, color: C.muted } }, label), h('span', { style: { flex: 1, minWidth: 0, fontSize: SMALL } }, value)) : null);
      // The Host writes "the user" for you; the page says it in your language or not at all.
      const who = /^the user$/i.test(str(origin.who).trim()) ? '' : str(origin.who).trim();
      const fromValue = where
        ? h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } }, h('span', null, where), who && !where.includes(who) ? dotSep() : null, who && !where.includes(who) ? h('span', { style: { color: C.muted } }, who) : null)
        : via && via !== 'panel'
          ? viaBadge(t, via, via === 'schedule' ? '' : who)
          : t('fromPanel');
      return h(
        'div',
        { 'data-dsh-bots-ticket': id, 'data-stage': stage, style: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 } },
        h(
          'header',
          { style: { padding: '14px 24px 14px', borderBottom: `1px solid ${C.border1}`, display: 'flex', flexDirection: 'column', gap: 8 } },
          h('div', null, back),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' } },
            h(
              'div',
              { style: { flex: 1, minWidth: 240, display: 'flex', flexDirection: 'column', gap: 4 } },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 } }, h('span', { style: { fontWeight: 700, fontSize: 19, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: taskTitle(t, v) }, taskTitle(t, v)), h(StageChip, { t, stage })),
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: SMALL, color: C.muted, flexWrap: 'wrap' } },
                h(BotFace, { id: v.botId, size: 18 }),
                h('span', { style: { color: C.primary, fontWeight: 600 } }, name),
                dotSep(),
                h('span', null, requesterText(t, v)),
                dotSep(),
                h('span', { title: fmtDate(toMs(v.createdAt)) }, t('taskStarted', { when: fmtAgo(t, v.createdAt) })),
              ),
            ),
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
              env?.canOpen?.() ? h(Btn, { icon: Icon.chat(14), disabled: !v.sessionId, title: v.sessionId ? undefined : t('taskNoConversation'), onClick: openConversation, 'data-dsh-bots-ticket-open': id }, t('openConversation')) : null,
              ['failed', 'stalled', 'stopped'].includes(stage) ? h(Btn, { icon: Icon.refresh(13), disabled: Boolean(busy), onClick: () => void act('retry'), 'data-dsh-bots-ticket-retry': id }, t('taskRetry')) : null,
              open ? h(Btn, { icon: Icon.check(13), disabled: Boolean(busy), onClick: () => setConfirm('close'), 'data-dsh-bots-ticket-close': id }, t('taskClose')) : null,
              open ? h(Btn, { kind: 'danger', icon: Icon.stop(12), disabled: Boolean(busy), onClick: () => setConfirm('stop'), 'data-dsh-bots-ticket-stop': id }, t('taskStop')) : null,
            ),
          ),
        ),
        h(
          'div',
          { className: 'dshb-scroll', style: { flex: 1, padding: '18px 24px 24px' } },
          h(
            'div',
            { style: { maxWidth: 820, display: 'flex', flexDirection: 'column', gap: 22 } },
            stage === 'failed' && v.error ? h('div', { 'data-dsh-bots-ticket-error': true, style: { display: 'flex', gap: 8, padding: '10px 12px', borderRadius: 10, border: `1px solid ${tint(C.error, 40)}`, background: tint(C.error, 8), fontSize: SMALL, color: C.primary } }, h('span', { style: { color: C.error, display: 'inline-flex', paddingTop: 2 } }, Icon.alert(14)), h('span', { style: { minWidth: 0, wordBreak: 'break-word' } }, str(v.error))) : null,
            h(
              'div',
              { className: 'dshb-card', style: { display: 'flex', flexDirection: 'column', gap: 7 } },
              fact(t('taskFactBot'), h('button', { type: 'button', className: 'dshb-link', onClick: () => navigate(v.botId), style: { display: 'inline-flex', alignItems: 'center', gap: 6 } }, h(BotFace, { id: v.botId, size: 16 }), name), 'bot'),
              fact(t('taskFactAsked'), requesterBot(v) ? h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } }, h(BotFace, { id: requesterBot(v), size: 16 }), requesterName(t, v)) : requesterName(t, v), 'requester'),
              fact(t('taskFactFrom'), fromValue, 'from'),
              fact(t('taskFactUpdated'), h('span', { title: fmtDate(toMs(v.updatedAt)) }, fmtAgo(t, v.updatedAt)), 'updated'),
            ),
            str(v.text).trim() ? h(Section, { title: t('taskAsked') }, h('div', { className: 'dshb-card', 'data-dsh-bots-ticket-text': true }, h(Clamp, { t, text: v.text, lines: 8, style: { fontSize: SMALL } }))) : null,
            h(
              Section,
              { title: t('taskReports') },
              reports.length === 0
                ? h('div', { style: { fontSize: SMALL, color: C.faint } }, t('taskNoReports', { name }))
                : h(
                    'div',
                    { 'data-dsh-bots-reports': reports.length, style: { display: 'flex', flexDirection: 'column' } },
                    reports.map((r, i) =>
                      h(
                        'div',
                        { key: `${r.at}-${i}`, 'data-dsh-bots-report-item': r.status, style: { display: 'flex', gap: 10 } },
                        h(
                          'div',
                          { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', width: 12, flex: 'none', paddingTop: 6 } },
                          h('span', { style: { width: 9, height: 9, borderRadius: '50%', background: REPORT_COLOR[r.status] ?? C.faint, flex: 'none' } }),
                          i < reports.length - 1 ? h('span', { style: { flex: 1, width: 2, marginTop: 3, background: C.border1 } }) : null,
                        ),
                        h(
                          'div',
                          { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 5, paddingBottom: i < reports.length - 1 ? 14 : 0 } },
                          h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: TINY, color: C.faint } }, h(ReportChip, { t, status: r.status }), h('span', { title: fmtDate(toMs(r.at)) }, fmtClock(toMs(r.at)))),
                          h('div', { style: { padding: '8px 12px', borderRadius: '4px 14px 14px 14px', background: C.layer2, border: `1px solid ${C.border1}`, fontSize: FONT, minWidth: 0 } }, h(Clamp, { t, text: r.text, lines: 14 })),
                        ),
                      ),
                    ),
                  ),
            ),
            parentId || children.length
              ? h(
                  Section,
                  { title: t('taskRelated') },
                  parentId ? h('div', { 'data-dsh-bots-ticket-parent': parentId, style: { display: 'flex', flexDirection: 'column', gap: 6 } }, h('span', { style: { fontSize: TINY, color: C.muted } }, t('taskParent')), h(TaskCard, { t, id: parentId })) : null,
                  children.length ? h('div', { 'data-dsh-bots-ticket-children': children.length, style: { display: 'flex', flexDirection: 'column', gap: 6 } }, h('span', { style: { fontSize: TINY, color: C.muted } }, t('taskChildren', { n: children.length })), children.map((c) => h(TaskCard, { key: c, t, id: c }))) : null,
                )
              : null,
            h(
              Section,
              { title: t('taskUsage') },
              runs.length === 0 && tokens === 0
                ? h('div', { style: { fontSize: SMALL, color: C.faint } }, t('taskNoUsage'))
                : h(
                    'div',
                    { 'data-dsh-bots-ticket-usage': true, style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 } },
                    h(Tile, { attr: 'ticket-tokens', label: t('tileTokens'), value: fmtNum(tokens) }),
                    h(Tile, { attr: 'ticket-cost', label: t('tileCost'), value: fmtCost(cost) }),
                    h(Tile, { attr: 'ticket-runs', label: t('tileRuns'), value: String(runs.length) }),
                  ),
            ),
          ),
        ),
        archived
          ? h('div', { style: { padding: '10px 24px 14px', borderTop: `1px solid ${C.border1}`, background: C.base, fontSize: SMALL, color: C.faint } }, t('taskArchived'))
          : h(
              'div',
              { style: { padding: '10px 24px 16px', borderTop: `1px solid ${C.border1}`, background: C.base } },
              h(
                'div',
                { style: { maxWidth: 820 } },
                h(
                  'div',
                  { style: { display: 'flex', alignItems: 'flex-end', gap: 8, padding: 6, borderRadius: 14, border: `1px solid ${C.border}`, background: C.layer1 } },
                  h('textarea', {
                    'data-dsh-bots-ticket-composer': id,
                    value: text,
                    rows: Math.min(6, Math.max(1, text.split('\n').length)),
                    'aria-label': t('taskMessageLabel'),
                    placeholder: stage === 'question' ? t('taskAnswerPlaceholder', { name }) : t('taskMessagePlaceholder'),
                    onChange: (e) => setText(e.target.value),
                    onKeyDown: (e) => {
                      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !e.nativeEvent?.isComposing) {
                        e.preventDefault();
                        send();
                      }
                    },
                    style: { flex: 1, minHeight: 32, maxHeight: 160, resize: 'none', border: 'none', outline: 'none', background: 'transparent', color: C.primary, font: 'inherit', fontSize: FONT, lineHeight: 1.5, padding: '6px 8px' },
                  }),
                  h(Btn, { kind: 'primary', icon: Icon.send(15), title: t('send'), disabled: !text.trim() || sending, onClick: send, 'data-dsh-bots-ticket-send': id, style: { borderRadius: 10, width: 34, height: 34 } }),
                ),
                h('div', { style: { marginTop: 7, fontSize: TINY, color: C.faint } }, t('taskMessageHint', { name })),
              ),
            ),
        confirm
          ? h(Confirm, {
              t,
              title: t(confirm === 'stop' ? 'taskStopTitle' : 'taskCloseTitle', { title: taskTitle(t, v) }),
              body: t(confirm === 'stop' ? 'taskStopBody' : 'taskCloseBody', { name }),
              confirmLabel: t(confirm === 'stop' ? 'taskStop' : 'taskClose'),
              onClose: () => setConfirm(null),
              onConfirm: () => act(confirm),
            })
          : null,
      );
    }

    /** A bot's open tasks (and the last few it finished), on its page. */
    function BotTasksTab({ t, bot, onOpen = openTicket }) {
      const { data, failed } = useJson(`tickets?bot=${encodeURIComponent(bot.id)}&limit=50`, STATE_POLL_MS);
      const name = bot.name || `@${bot.handle}`;
      const items = (Array.isArray(data?.items) ? data.items : []).filter((r) => r && typeof r.id === 'string' && r.botId === bot.id);
      const open = items.filter((r) => groupOf(r) !== 'done').sort(newestFirst);
      const done = items.filter((r) => groupOf(r) === 'done').sort(newestFirst).slice(0, 5);
      return h(
        'div',
        { className: 'dshb-scroll', 'data-dsh-bots-bot-tasks': bot.id, style: { flex: 1, padding: '20px 24px 28px' } },
        h(
          'div',
          { style: { maxWidth: 820, display: 'flex', flexDirection: 'column', gap: 26 } },
          h(
            Section,
            { title: t('botOpenTasks'), hint: t('botOpenTasksHint', { name }), right: h('button', { type: 'button', className: 'dshb-link', 'data-dsh-bots-bot-tasks-all': bot.id, onClick: () => navigate(bot.id, 'tasks'), style: { fontSize: TINY, whiteSpace: 'nowrap' } }, t('allTasksOf', { name })) },
            !data
              ? h('div', { style: { fontSize: SMALL, color: C.faint } }, failed ? t('tasksUnavailable') : t('loading'))
              : open.length === 0
                ? h('div', { style: { fontSize: SMALL, color: C.faint } }, t('botNoOpenTasks', { name }))
                : h(TaskList, { rows: open.map((r) => h(TaskRow, { key: r.id, t, row: r, onOpen, showBot: false })) }),
          ),
          done.length ? h(Section, { title: t('tasksDone') }, h(TaskList, { rows: done.map((r) => h(TaskRow, { key: r.id, t, row: r, onOpen, showBot: false })) })) : null,
        ),
      );
    }

    /** Once, after an upgrade moved an existing team to router mode: what changed and where to switch back. */
    function RouterNoticeBanner({ t, onOpenDispatcher, onDismiss }) {
      return h(
        'div',
        { role: 'region', 'aria-label': t('routerNoticeTitle'), 'data-dsh-bots-router-notice': true, className: 'dshb-fade', style: { display: 'flex', alignItems: 'flex-start', gap: 12, margin: '12px 24px 0', padding: '12px 14px', borderRadius: 12, border: `1px solid ${tint(C.label, 35)}`, background: tint(C.label, 8) } },
        h('span', { style: { color: C.label, display: 'inline-flex', paddingTop: 2 } }, Icon.sparkle(16)),
        h(
          'div',
          { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 } },
          h('div', { style: { fontWeight: 700, fontSize: SMALL } }, t('routerNoticeTitle')),
          h('div', { style: { fontSize: SMALL, color: C.muted, lineHeight: 1.6 } }, t('routerNoticeBody')),
          h(
            'div',
            { style: { display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' } },
            onOpenDispatcher ? h(Btn, { size: 'sm', onClick: onOpenDispatcher, 'data-dsh-bots-router-notice-open': true }, t('routerNoticeOpen')) : null,
            h(Btn, { size: 'sm', kind: 'primary', onClick: onDismiss, 'data-dsh-bots-router-notice-dismiss': true }, t('routerNoticeOk')),
          ),
        ),
        h(Btn, { kind: 'ghost', size: 'sm', icon: Icon.close(13), title: t('close'), onClick: onDismiss }),
      );
    }

    // --- avatar editor -----------------------------------------------------------------

    function readDataUrl(file) {
      return new Promise((resolve, reject) => {
        try {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result ?? ''));
          reader.onerror = () => reject(reader.error ?? new Error('read failed'));
          reader.readAsDataURL(file);
        } catch (e) {
          reject(e);
        }
      });
    }

    /**
     * The big preview, colour swatches, optional letters and (when `onUpload`)
     * upload / AI generation / back-to-letters.
     */
    function AvatarEditor({ t, avatar, name, onChange, onUpload, onGenerate, onClear, imageGen, generating, compact }) {
      const a = avatar && typeof avatar === 'object' ? avatar : { kind: 'initials', color: COLORS[0] };
      const [busy, setBusy] = useState(false);
      const [asking, setAsking] = useState(false);
      const [style, setStyle] = useState('');
      const fileRef = useRef(null);
      const color = str(a.color) || COLORS[0];
      const isImage = a.kind === 'image' && Boolean(a.url);
      const derived = initialsOf(name);
      const setColor = (c) => onChange({ ...a, color: c });
      const setLetters = (text) => {
        const v = [...str(text).replace(/\s+/g, '')].slice(0, 2).join('').toUpperCase();
        const next = { kind: 'initials', color };
        if (v) next.text = v;
        onChange(next);
      };
      const locked = busy || Boolean(generating);
      const upload = (file) => {
        if (!file || !onUpload) return;
        if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) return void onUpload(null, t('avatarType'));
        if (file.size > 2 * 1024 * 1024) return void onUpload(null, t('avatarSize'));
        setBusy(true);
        readDataUrl(file)
          .then((dataUrl) => onUpload(dataUrl))
          .catch(() => onUpload(null, t('avatarReadFailed')))
          .finally(() => setBusy(false));
      };
      const generate = () => {
        if (!onGenerate || locked) return;
        setAsking(false);
        void onGenerate(style.trim());
      };
      const big = compact ? 72 : 96;
      const label = (text) => h('span', { style: { fontSize: TINY, fontWeight: 600, color: C.muted, width: compact ? 44 : 52, flex: 'none' } }, text);
      return h(
        'div',
        { 'data-dsh-bots-avatar-editor': true, style: { display: 'flex', gap: compact ? 16 : 22, alignItems: 'center', flexWrap: 'wrap' } },
        h(
          'div',
          { style: { position: 'relative', flex: 'none', display: 'inline-flex' } },
          h(Avatar, { avatar: a, name, size: big, ring: true }),
          generating
            ? h(
                'span',
                { style: { position: 'absolute', inset: 0, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: `radial-gradient(circle, color-mix(in srgb, ${color} 75%, #000), color-mix(in srgb, ${color} 55%, #000))` } },
                h('span', { className: 'dshb-spinner', style: { width: 26, height: 26, borderWidth: 3, borderColor: 'rgba(255,255,255,.35)', borderTopColor: '#fff' } }),
              )
            : null,
        ),
        h(
          'div',
          { style: { flex: 1, minWidth: 260, display: 'flex', flexDirection: 'column', gap: 10 } },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
            label(t('avatarColour')),
            COLORS.map((c) => h('button', { key: c, type: 'button', className: 'dshb-swatch', 'data-active': color.toLowerCase() === c, title: c, 'aria-label': c, onClick: () => setColor(c), style: { background: c } })),
            h(
              'label',
              { title: t('customColor'), style: { position: 'relative', width: 22, height: 22, borderRadius: '50%', overflow: 'hidden', cursor: 'pointer', background: 'conic-gradient(red, yellow, lime, cyan, blue, magenta, red)', boxShadow: COLORS.includes(color.toLowerCase()) ? 'none' : `0 0 0 2px ${C.base}, 0 0 0 4px ${C.primary}` } },
              h('input', { type: 'color', 'aria-label': t('customColor'), value: /^#[0-9a-f]{6}$/i.test(color) ? color : '#7c5cff', onChange: (e) => setColor(e.target.value), style: { position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer', width: '100%', height: '100%' } }),
            ),
          ),
          isImage
            ? null
            : h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: 8 } },
                label(t('avatarLetters')),
                h(Input, { value: str(a.text), placeholder: derived, maxLength: 2, 'data-dsh-bots-letters': true, onChange: (e) => setLetters(e.target.value), style: { width: 64, height: 28, fontSize: SMALL, textAlign: 'center', fontWeight: 650, letterSpacing: '.04em' } }),
                h('span', { style: { fontSize: TINY, color: C.faint } }, t('avatarLettersHint', { letters: derived })),
              ),
          onUpload
            ? h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                label(t('avatarPicture')),
                h('input', { ref: fileRef, type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', style: { display: 'none' }, onChange: (e) => upload(e.target.files?.[0]) }),
                h(Btn, { size: 'sm', icon: Icon.upload(12), disabled: locked, onClick: () => fileRef.current?.click?.(), 'data-dsh-bots-avatar-upload': true }, busy ? t('uploading') : t('uploadImage')),
                imageGen
                  ? h(Btn, { size: 'sm', icon: Icon.sparkle(12), disabled: locked, onClick: () => setAsking((v) => !v), 'data-dsh-bots-avatar-generate': true }, t('generateAi'))
                  : null,
                isImage && onClear ? h(Btn, { size: 'sm', kind: 'ghost', disabled: locked, onClick: () => void onClear(), 'data-dsh-bots-avatar-clear': true }, t('useLetters')) : null,
              )
            : null,
          onUpload && !imageGen ? h('div', { 'data-dsh-bots-imagegen-hint': true, style: { fontSize: TINY, color: C.faint, paddingLeft: compact ? 52 : 60 } }, t('imageGenMissing')) : null,
          generating
            ? h(
                'div',
                { 'data-dsh-bots-generating': true, style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: SMALL, color: C.muted, paddingLeft: compact ? 52 : 60 } },
                h('span', { className: 'dshb-spinner' }),
                t('generatingAvatar'),
              )
            : asking && imageGen
              ? h(
                  'div',
                  { className: 'dshb-fade', 'data-dsh-bots-generate-form': true, style: { display: 'flex', flexDirection: 'column', gap: 8, marginLeft: compact ? 52 : 60, padding: 10, borderRadius: 10, border: `1px solid ${C.border}`, background: C.layer2 } },
                  h('span', { style: { fontSize: TINY, color: C.muted } }, t('generateStyleHint')),
                  h(
                    'div',
                    { style: { display: 'flex', gap: 8 } },
                    h(Input, {
                      value: style,
                      autoFocus: true,
                      maxLength: 400,
                      placeholder: t('generateStylePlaceholder'),
                      onChange: (e) => setStyle(e.target.value),
                      onKeyDown: (e) => {
                        if (e.key === 'Enter' && !e.isComposing && !e.nativeEvent?.isComposing) {
                          e.preventDefault();
                          generate();
                        }
                      },
                      style: { height: 30, fontSize: SMALL },
                    }),
                    h(Btn, { size: 'sm', kind: 'ghost', onClick: () => setAsking(false) }, t('cancel')),
                    h(Btn, { size: 'sm', kind: 'primary', icon: Icon.sparkle(12), onClick: generate, 'data-dsh-bots-generate-go': true }, t('generate')),
                  ),
                )
              : null,
        ),
      );
    }

    // --- profile tab ------------------------------------------------------------------

    const profileOf = (bot) => ({
      name: str(bot.name),
      handle: str(bot.handle),
      bio: str(bot.bio),
      persona: str(bot.persona),
      avatar: avatarOf(bot.avatar),
      model: bot.model && bot.model.model ? { provider: str(bot.model.provider), model: str(bot.model.model), ...(bot.model.reasoningEffort ? { reasoningEffort: str(bot.model.reasoningEffort) } : {}) } : null,
      deny: Array.isArray(bot.tools?.deny) ? bot.tools.deny.slice().sort() : [],
      routerAllow: Array.isArray(bot.tools?.routerAllow) ? bot.tools.routerAllow.map(String).sort() : [],
    });
    /** A clean avatar value: an image keeps its url, anything else is initials (emoji rows from v0.1 too). */
    function avatarOf(a) {
      const color = str(a?.color) || COLORS[0];
      if (a?.kind === 'image' && a.url) return { kind: 'image', url: str(a.url), color, ...(a.source === 'ai' ? { source: 'ai' } : {}) };
      const text = typeof a?.text === 'string' ? [...a.text.trim()].slice(0, 2).join('').toUpperCase() : '';
      return { kind: 'initials', ...(text ? { text } : {}), color };
    }
    const modelKey = (m) => (m ? `${m.provider}::${m.model}` : '');
    function handleError(t, handle, botId) {
      if (!HANDLE_RE.test(handle)) return t('handleInvalid');
      if (botsOf().some((b) => b.id !== botId && b.handle === handle)) return t('handleTaken');
      return '';
    }

    /** An ability is on unless every tool it has here is denied. */
    const abilityOn = (ab, denied) => !(ab.available ?? []).every((x) => denied.has(x));
    /** The deny list after switching one ability: its tools leave the list, and come back (all of them) when it is turned off. */
    function toggleAbility(deny, ab, on) {
      const tools = new Set([...(ab.tools ?? []), ...(ab.available ?? [])]);
      const next = new Set((deny ?? []).filter((x) => !tools.has(x)));
      if (!on) for (const x of ab.available ?? []) next.add(x);
      return [...next].sort();
    }
    /**
     * Tools a router dispatcher goes without unless allowed back: the Host's list when the catalog has one,
     * else the rule of lib/prompt.mjs (commands, writing and editing files, sub-agents, images, Office).
     */
    function routerDenyOf(catalog) {
      if (Array.isArray(catalog?.routerDeny)) return catalog.routerDeny.map(String);
      const abilities = Array.isArray(catalog?.abilities) ? catalog.abilities : [];
      const of = (id) => abilities.find((a) => a.id === id)?.tools ?? [];
      return [...new Set([...of('code'), 'write', 'edit', ...of('delegate'), ...of('images'), ...of('office')])];
    }
    const sorted = (set) => [...set].sort();
    /**
     * The tool lists after switching one ability of a router dispatcher. An ability made only of tools a
     * router goes without (commands, sub-agents, images, Office) is switched through `routerAllow`, so it
     * keeps its own setting for hands-on mode. One with other tools too (files) switches as before and
     * comes back with the router's default; its writing tools are allowed back on their own.
     */
    function toggleRouterAbility(draft, ab, on, routerDeny) {
      const gated = (ab.available ?? []).filter((x) => routerDeny.has(x));
      const whole = gated.length > 0 && gated.length === (ab.available ?? []).length;
      const allow = new Set(draft.routerAllow);
      if (on) {
        if (whole) for (const x of gated) allow.add(x);
        return { deny: toggleAbility(draft.deny, ab, true), routerAllow: sorted(allow) };
      }
      for (const x of [...(ab.tools ?? []), ...gated]) allow.delete(x);
      return { deny: whole ? draft.deny : toggleAbility(draft.deny, ab, false), routerAllow: sorted(allow) };
    }
    /** How the dispatcher works: only hand out (router) or also do small things itself (hands-on). A team setting. */
    function DispatcherMode({ t, name, toast }) {
      const mode = dispatcherOf();
      const [busy, setBusy] = useState(false);
      const choose = (next) => {
        if (busy || next === mode) return;
        setBusy(true);
        postJson('settings', { patch: { dispatcher: next } })
          .then((r) => {
            if (r?.ok) {
              tookSettings(r.settings && typeof r.settings === 'object' ? r.settings : { ...(store.settings?.settings ?? {}), dispatcher: next });
              toast(t(next === 'hands-on' ? 'modeSavedHandsOn' : 'modeSavedRouter', { name }));
              void refreshState();
            } else toast(r?.reason || t('saveFailed'), 'error');
          })
          .finally(() => setBusy(false));
      };
      const option = (id, title, body) => {
        const on = mode === id;
        return h(
          'button',
          {
            key: id,
            type: 'button',
            role: 'radio',
            'aria-checked': on,
            className: 'dshb-row',
            'data-active': on,
            'data-dsh-bots-dispatcher-mode': id,
            disabled: busy,
            onClick: () => choose(id),
            style: { alignItems: 'flex-start', gap: 10, padding: '10px 12px', border: `1px solid ${on ? C.label : C.border1}`, background: on ? tint(C.label, 8) : C.layer1 },
          },
          h('span', { style: { width: 16, height: 16, marginTop: 1, borderRadius: '50%', border: `2px solid ${on ? C.label : C.border}`, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: 'none' } }, on ? h('span', { style: { width: 7, height: 7, borderRadius: '50%', background: C.label } }) : null),
          h('span', { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } }, h('span', { style: { fontWeight: 600 } }, title), h('span', { style: { fontSize: TINY, color: C.muted, lineHeight: 1.5 } }, body)),
        );
      };
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        h(
          'div',
          { role: 'radiogroup', 'aria-label': t('dispatcherMode'), 'data-dsh-bots-dispatcher-modes': mode, style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 } },
          option('router', t('modeRouter'), t('modeRouterBody')),
          option('hands-on', t('modeHandsOn'), t('modeHandsOnBody')),
        ),
        // Router mode asked for, but nobody to hand work to yet.
        mode === 'router' && !routerActiveOf()
          ? h('div', { 'data-dsh-bots-router-waiting': true, style: { display: 'flex', alignItems: 'flex-start', gap: 6, fontSize: TINY, color: C.muted, lineHeight: 1.5 } }, h('span', { style: { color: C.warn, display: 'inline-flex', paddingTop: 1 } }, Icon.alert(12)), t('routerWaiting', { name }))
          : null,
      );
    }
    const ABILITY_ICON = {
      web: () => Icon.search(15),
      files: () => Icon.edit(15),
      code: () => svg(15, ['M8 8l-4 4 4 4', 'M16 8l4 4-4 4', 'M13.5 5l-3 14']),
      office: () => svg(15, ['M6 3h9l4 4v14H6z', 'M14 3v5h5', 'M9 13h7', 'M9 17h5']),
      images: () => Icon.sparkle(15),
      delegate: () => Icon.team(15),
      schedule: () => Icon.clock(15),
      ask: () => svg(15, ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7', 'M12 17h.01']),
      deliver: () => Icon.download(15),
      plugins: () => Icon.puzzle(15),
    };
    function ProfileTab({ t, bot, toast, catalog }) {
      // The dispatcher's mode is a team setting; the panel re-renders this tab once it loads.
      useEffect(() => {
        void loadOnce('settings', 'settings');
      }, []);
      const [draft, setDraft] = useState(() => profileOf(bot));
      const [busy, setBusy] = useState(false);
      const [toolQ, setToolQ] = useState('');
      const base = useRef(JSON.stringify(profileOf(bot)));
      // A fresh bot, or a save elsewhere while clean, resets the form.
      const incoming = JSON.stringify(profileOf(bot));
      const dirty = JSON.stringify(draft) !== base.current;
      useEffect(() => {
        if (!dirty || base.current === incoming) {
          base.current = incoming;
          setDraft(JSON.parse(incoming));
        }
      }, [bot.id, incoming]);
      const set = (patch) => setDraft((d) => ({ ...d, ...patch }));
      const hErr = handleError(t, draft.handle, bot.id);
      const valid = draft.name.trim() !== '' && !hErr;
      const save = () => {
        if (!valid || busy) return;
        setBusy(true);
        const payload = { id: bot.id, name: draft.name.trim(), handle: draft.handle, bio: draft.bio.trim(), persona: draft.persona, model: draft.model, tools: { deny: draft.deny, routerAllow: draft.routerAllow } };
        if (draft.avatar) payload.avatar = avatarOf(draft.avatar);
        postJson('save', { bot: payload })
          .then((r) => {
            if (r?.ok) {
              base.current = JSON.stringify(profileOf(r.bot ?? { ...bot, ...payload }));
              setDraft(JSON.parse(base.current));
              toast(t('saved'));
              void refreshState();
            } else toast(r?.reason || t('saveFailed'), 'error');
          })
          .finally(() => setBusy(false));
      };
      /** The Host changed the avatar: the form and its saved copy both take it. */
      const tookAvatar = (r, okText) => {
        if (r?.ok) {
          const av = r.bot?.avatar;
          if (av) {
            set({ avatar: avatarOf(av) });
            const b = JSON.parse(base.current);
            b.avatar = avatarOf(av);
            base.current = JSON.stringify(b);
          }
          toast(okText);
          void refreshState();
        } else toast(r?.reason || t('saveFailed'), 'error');
      };
      const upload = (dataUrl, problem) => {
        if (!dataUrl) return void toast(problem || t('avatarReadFailed'), 'error');
        return postJson('avatar', { id: bot.id, dataUrl }).then((r) => tookAvatar(r, t('avatarSaved')));
      };
      const [generating, setGenerating] = useState(false);
      const generate = (style) => {
        setGenerating(true);
        return postJson('avatar/generate', { id: bot.id, ...(style ? { style } : {}) })
          .then((r) => tookAvatar(r?.ok ? r : { ...r, reason: t('avatarGenFailed', { reason: r?.reason || '' }) }, t('avatarGenerated')))
          .finally(() => setGenerating(false));
      };
      const clearAvatar = () => postJson('avatar/clear', { id: bot.id }).then((r) => tookAvatar(r, t('avatarSaved')));
      const tools = Array.isArray(catalog?.tools) ? catalog.tools : [];
      const models = Array.isArray(catalog?.models) ? catalog.models : [];
      const needle = toolQ.trim().toLowerCase();
      const shownTools = tools.filter((x) => !needle || str(x.name).toLowerCase().includes(needle) || str(x.description).toLowerCase().includes(needle));
      const denied = new Set(draft.deny);
      const setDeny = (names, allow) => {
        const next = new Set(draft.deny);
        for (const n of names) allow ? next.delete(n) : next.add(n);
        set({ deny: [...next].sort() });
      };
      const lang = langOf(t);
      const abilities = (Array.isArray(catalog?.abilities) ? catalog.abilities : []).filter((ab) => Array.isArray(ab.available) && ab.available.length > 0);
      const chosen = draft.model ? models.find((m) => modelKey(m) === modelKey(draft.model)) : null;
      const knownModel = !draft.model || Boolean(chosen);
      const efforts = Array.isArray(chosen?.efforts) ? chosen.efforts : [];
      const [sources, setSources] = useState(false);
      // A router dispatcher goes without some tools unless they are allowed back one ability at a time
      // (only while it routes: the only bot of a team keeps them all).
      const isPrimary = bot.role === 'primary' || bot.id === store.state?.primaryId;
      const routing = isPrimary && routerActiveOf();
      const routerDeny = new Set(routing ? routerDenyOf(catalog) : []);
      const routerAllow = new Set(draft.routerAllow);
      const routerBlocked = (names) => names.filter((x) => routerDeny.has(x) && !routerAllow.has(x));
      const inEffect = routing ? new Set([...draft.deny, ...routerBlocked([...routerDeny])]) : denied;
      const botLabel = draft.name || bot.name;
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 } },
        h(
          'div',
          { className: 'dshb-scroll', style: { flex: 1, padding: '20px 24px 28px' } },
          h(
            'div',
            { style: { maxWidth: 760, display: 'flex', flexDirection: 'column', gap: 26 } },
            h(
              Section,
              { title: t('secAvatar') },
              h(AvatarEditor, { t, avatar: draft.avatar, name: draft.name || bot.name, onChange: (avatar) => set({ avatar }), onUpload: upload, onGenerate: generate, onClear: clearAvatar, imageGen: catalog?.imageGen === true, generating }),
            ),
            h(
              Section,
              { title: t('secIdentity') },
              h(
                'div',
                { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 } },
                h(Field, { label: t('name') }, h(Input, { value: draft.name, maxLength: 60, onChange: (e) => set({ name: e.target.value }), 'data-dsh-bots-field': 'name' })),
                h(
                  Field,
                  { label: t('handle'), error: draft.handle && hErr ? hErr : '', hint: t('handleHint') },
                  h(
                    'div',
                    { style: { position: 'relative' } },
                    h('span', { style: { position: 'absolute', left: 10, top: 7, color: C.faint } }, '@'),
                    h(Input, { value: draft.handle, maxLength: 32, 'data-invalid': Boolean(hErr), onChange: (e) => set({ handle: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') }), style: { paddingLeft: 24 } }),
                  ),
                ),
                h(Field, { label: t('bio'), hint: t('bioHint'), style: { gridColumn: '1 / -1' } }, h(Input, { value: draft.bio, maxLength: 160, placeholder: t('bioPlaceholder'), onChange: (e) => set({ bio: e.target.value }) })),
              ),
            ),
            isPrimary ? h(Section, { title: t('dispatcherMode'), hint: t('dispatcherModeHint') }, h(DispatcherMode, { t, name: botLabel, toast })) : null,
            h(
              Section,
              { title: t('persona'), hint: t('personaHint') },
              h(PersonaChips, { t, onPick: (id) => set({ persona: t(`personaText_${id}`, { name: draft.name || bot.name }) }) }),
              h(TextArea, { value: draft.persona, rows: 10, placeholder: t('personaPlaceholder'), onChange: (e) => set({ persona: e.target.value }), 'data-dsh-bots-field': 'persona', style: { minHeight: 180 } }),
            ),
            h(
              Section,
              { title: t('model'), hint: t('modelHint'), right: h(Btn, { size: 'sm', kind: 'ghost', icon: Icon.layers(12), onClick: () => setSources(true), 'data-dsh-bots-model-sources': true }, t('modelSources')) },
              h(
                'div',
                { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
                h(
                  'select',
                  {
                    className: 'dshb-input',
                    'data-dsh-bots-model': true,
                    value: modelKey(draft.model),
                    style: { maxWidth: 420, flex: '1 1 260px' },
                    onChange: (e) => {
                      const v = e.target.value;
                      if (!v) return set({ model: null });
                      const [provider, ...rest] = v.split('::');
                      set({ model: { provider, model: rest.join('::') } });
                    },
                  },
                  h('option', { value: '' }, catalog?.defaultModel ? t('modelDefaultIs', { model: catalog.defaultModel.model }) : t('modelDefault')),
                  !knownModel ? h('option', { value: modelKey(draft.model) }, `${draft.model.provider} · ${draft.model.model}`) : null,
                  modelGroups(models).map((g) => h('optgroup', { key: g.name, label: g.source ? `${g.name} · ${t(`msrc_${g.source}`)}` : g.name }, g.models.map((m) => h('option', { key: modelKey(m), value: modelKey(m) }, m.name || m.model)))),
                ),
                efforts.length
                  ? h(
                      'select',
                      { className: 'dshb-input', 'data-dsh-bots-effort': true, title: t('reasoning'), value: draft.model?.reasoningEffort ?? '', style: { width: 150 }, onChange: (e) => set({ model: { provider: draft.model.provider, model: draft.model.model, ...(e.target.value ? { reasoningEffort: e.target.value } : {}) } }) },
                      h('option', { value: '' }, `${t('reasoning')} · ${t('effortDefault')}${chosen?.defaultEffort ? ` (${chosen.defaultEffort})` : ''}`),
                      efforts.map((e) => h('option', { key: e.id, value: e.id }, `${t('reasoning')} · ${e.name}`)),
                    )
                  : null,
              ),
              chosen ? h('div', { 'data-dsh-bots-model-info': true, style: { fontSize: TINY, color: C.faint } }, [chosen.group || chosen.provider, chosen.source ? t(`msrc_${chosen.source}`) : '', chosen.context ? t('modelContext', { k: fmtNum(chosen.context) }) : ''].filter(Boolean).join(' · ')) : null,
              routing ? h('div', { 'data-dsh-bots-router-model-hint': true, style: { display: 'flex', alignItems: 'flex-start', gap: 6, fontSize: TINY, color: C.muted, lineHeight: 1.5 } }, h('span', { style: { color: C.label, display: 'inline-flex', paddingTop: 1 } }, Icon.sparkle(12)), t('routerModelHint')) : null,
            ),
            h(
              Section,
              { title: t('abilities'), hint: routing ? t('abilitiesRouterHint', { name: botLabel }) : t('abilitiesHint', { name: botLabel }) },
              abilities.length === 0
                ? h('div', { style: { fontSize: SMALL, color: C.faint } }, catalog ? t('noTools') : t('loading'))
                : h(
                    'div',
                    { 'data-dsh-bots-abilities': true, style: { display: 'flex', flexDirection: 'column', border: `1px solid ${C.border1}`, borderRadius: 12, overflow: 'hidden', background: C.layer1 } },
                    abilities.map((ab, i) => {
                      const on = abilityOn(ab, inEffect);
                      const warn = ab.risky && on;
                      const gated = ab.available.filter((x) => routerDeny.has(x));
                      const blocked = routerBlocked(gated);
                      const whole = gated.length > 0 && gated.length === ab.available.length;
                      return h(
                        'div',
                        { key: ab.id, 'data-dsh-bots-ability': ab.id, 'data-on': on, style: { display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', borderTop: i ? `1px solid ${C.border1}` : 'none', background: warn ? tint(C.warn, 8) : 'transparent' } },
                        h('span', { style: { width: 30, height: 30, borderRadius: 9, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: 'none', background: on ? tint(ab.risky ? C.warn : C.label, 14) : C.layer2, color: on ? (ab.risky ? '#b45309' : C.label) : C.faint } }, ABILITY_ICON[ab.id]?.() ?? Icon.sparkle(14)),
                        h(
                          'div',
                          { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 } },
                          h(
                            'span',
                            { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
                            h('span', { style: { fontWeight: 600, color: on ? C.primary : C.muted } }, pick(ab.name, lang)),
                            ab.risky ? h(Badge, { color: '#d97706' }, Icon.alert(10), t('risky')) : null,
                            gated.length
                              ? blocked.length
                                ? h(Badge, { color: C.muted, title: blocked.join(', '), 'data-dsh-bots-router-off': ab.id }, t(whole ? 'routerOff' : 'routerPartOff'))
                                : h(Badge, { color: C.label, title: gated.join(', '), 'data-dsh-bots-router-allowed': ab.id }, t('routerAllowed'))
                              : null,
                            gated.length && blocked.length && !whole && on
                              ? h('button', { type: 'button', className: 'dshb-link', 'data-dsh-bots-router-allow': ab.id, title: blocked.join(', '), onClick: () => set({ routerAllow: sorted(new Set([...draft.routerAllow, ...blocked])) }), style: { fontSize: TINY } }, t('routerAllowBack'))
                              : null,
                          ),
                          h('span', { style: { fontSize: TINY, color: C.muted } }, pick(ab.description, lang)),
                        ),
                        h('span', { className: 'dshb-mono', title: ab.available.join(', '), style: { fontSize: 11, color: C.faint, flex: 'none' } }, t('nTools', { n: ab.available.length })),
                        h(Switch, { on, title: pick(ab.name, lang), onChange: (v) => set(gated.length ? toggleRouterAbility(draft, ab, v, routerDeny) : { deny: toggleAbility(draft.deny, ab, v) }), 'data-dsh-bots-ability-switch': ab.id }),
                      );
                    }),
                  ),
              h(
                'details',
                { 'data-dsh-bots-advanced-tools': true, style: { fontSize: SMALL, color: C.muted } },
                h('summary', { style: { cursor: 'pointer', userSelect: 'none', fontWeight: 600 } }, t('advancedTools', { allowed: tools.filter((x) => !denied.has(x.name)).length, total: tools.length })),
                tools.length === 0
                  ? null
                  : h(
                      'div',
                      { style: { display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 } },
                      h(
                        'div',
                        { style: { display: 'flex', gap: 6, alignItems: 'center' } },
                        tools.length > 8 ? h(Input, { value: toolQ, placeholder: t('filterTools'), onChange: (e) => setToolQ(e.target.value), style: { maxWidth: 300, height: 30, fontSize: SMALL } }) : null,
                        h('span', { style: { flex: 1 } }),
                        h(Btn, { size: 'sm', kind: 'ghost', onClick: () => setDeny(shownTools.map((x) => x.name), true) }, t('allowAll')),
                        h(Btn, { size: 'sm', kind: 'ghost', onClick: () => setDeny(shownTools.map((x) => x.name), false) }, t('denyAll')),
                      ),
                      h(
                        'div',
                        { 'data-dsh-bots-tools': true, style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 6 } },
                        shownTools.map((x) =>
                          h(
                            'label',
                            { key: x.name, title: x.description, style: { display: 'flex', gap: 8, alignItems: 'flex-start', padding: '7px 9px', borderRadius: 9, border: `1px solid ${C.border1}`, background: denied.has(x.name) ? 'transparent' : C.layer1, cursor: 'pointer', opacity: denied.has(x.name) ? 0.6 : 1 } },
                            h('input', { type: 'checkbox', checked: !denied.has(x.name), onChange: (e) => setDeny([x.name], e.target.checked), style: { marginTop: 2, accentColor: 'var(--dsw-alias-brand-primary)' } }),
                            h(
                              'span',
                              { style: { display: 'flex', flexDirection: 'column', minWidth: 0 } },
                              h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 } }, h('span', { className: 'dshb-mono', style: { fontSize: 12, fontWeight: 600, color: C.primary } }, x.name), routerBlocked([x.name]).length ? h('span', { 'data-dsh-bots-router-tool': x.name, style: { fontSize: 10.5, color: C.faint, whiteSpace: 'nowrap' } }, t('routerOffShort')) : null),
                              x.description ? h('span', { style: { fontSize: TINY, color: C.faint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, x.description) : null,
                            ),
                          ),
                        ),
                      ),
                    ),
              ),
            ),
          ),
        ),
        h(SaveBar, { t, dirty, busy, valid, onSave: save, onReset: () => setDraft(JSON.parse(base.current)) }),
        sources ? h(ModelSourcesModal, { t, toast, onClose: () => setSources(false) }) : null,
      );
    }
    function SaveBar({ t, dirty, busy, valid, onSave, onReset }) {
      return h(
        'div',
        { 'data-dsh-bots-savebar': dirty, style: { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 24px', borderTop: `1px solid ${C.border1}`, background: C.base } },
        h('span', { style: { fontSize: SMALL, color: dirty ? C.warn : C.faint, display: 'inline-flex', alignItems: 'center', gap: 6 } }, dirty ? h('span', { style: { width: 6, height: 6, borderRadius: '50%', background: C.warn } }) : Icon.check(12), dirty ? t('unsaved') : t('allSaved')),
        h('span', { style: { flex: 1 } }),
        h(Btn, { kind: 'ghost', disabled: !dirty || busy, onClick: onReset }, t('discard')),
        h(Btn, { kind: 'primary', disabled: !dirty || busy || !valid, onClick: onSave, 'data-dsh-bots-save': true }, busy ? t('saving') : t('save')),
      );
    }
    function PersonaChips({ t, onPick, active }) {
      return h(
        'div',
        { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
        PERSONAS.map((p) => h('button', { key: p.id, type: 'button', className: 'dshb-chip', 'data-active': active === p.id, onClick: () => onPick(p.id, p), 'data-dsh-bots-persona': p.id }, h('span', { style: { width: 8, height: 8, borderRadius: '50%', background: p.color, flex: 'none' } }), t(`persona_${p.id}`))),
      );
    }

    // --- skills tab ------------------------------------------------------------------

    /** Save one changed list field of a bot; resolves to the saved bot or null. */
    function saveField(t, toast, bot, patch, okText) {
      return postJson('save', { bot: { id: bot.id, ...patch } }).then((r) => {
        if (r?.ok) {
          if (okText) toast(okText);
          void refreshState();
          return r.bot ?? null;
        }
        toast(r?.reason || t('saveFailed'), 'error');
        return null;
      });
    }

    const skillSource = (s) => (s?.source === 'dsh' || s?.source === 'import' ? s.source : 'own');
    /** How many skills a bot keeps, and how many of them may be on at once (from the host; lib/store.mjs). */
    const skillLimits = () => ({ max: Number(store.state?.limits?.skills) || 200, on: Number(store.state?.limits?.skillsOn) || 50 });
    const onCount = (skills) => skills.filter((s) => s.enabled !== false).length;
    /** A skill linked to a folder on this machine (its origin is a path, not a URL): read live, never copied. */
    const isLocalSkill = (s) => s?.source === 'import' && typeof s.origin === 'string' && s.origin !== '' && !/^https?:\/\//i.test(s.origin);
    const SOURCE_COLOR = { dsh: '#2563eb', import: '#475569', own: '#16a34a' };
    function SourceBadge({ t, source, local }) {
      return h(
        Badge,
        { color: SOURCE_COLOR[source] ?? C.muted, 'data-dsh-bots-skill-source': source },
        source === 'dsh' ? Icon.layers(10) : source === 'import' ? (local ? Icon.folder(10) : Icon.github(10)) : Icon.edit(10),
        t(local ? 'src_local' : `src_${source}`),
      );
    }
    /** The bot's skills by lower-cased name: what an import could collide with. */
    const skillsByName = (bot) => new Map((bot.skills ?? []).map((s) => [str(s.name).toLowerCase(), s]));
    /**
     * What importing a skill named like `existing` from `origin` would do:
     * 'new' adds it, 'update' refreshes the copy made from the same place, 'taken' is refused.
     */
    const importStateOf = (existing, origin) => (!existing ? 'new' : existing.source === 'import' && existing.origin && existing.origin === origin ? 'update' : 'taken');
    /** One line for what an import did: added, updated, skipped. */
    function importSummary(t, r) {
      const n = (k) => (Array.isArray(r?.[k]) ? r[k].length : 0);
      const skipped = Array.isArray(r?.skipped) ? r.skipped : [];
      const full = skipped.filter((x) => x?.reason === 'full').length;
      const lim = skillLimits();
      return [
        n('added') ? t('importedN', { n: n('added') }) : '',
        n('off') ? t('offN', { n: n('off'), max: lim.on }) : '',
        n('updated') ? t('updatedN', { n: n('updated') }) : '',
        skipped.length - full ? t('skippedN', { n: skipped.length - full }) : '',
        full ? t('fullN', { n: full, max: lim.max }) : '',
      ]
        .filter(Boolean)
        .join(' ');
    }
    /** Run an import and report it; resolves to the rows that failed, or null when nothing came back. */
    function runImport(t, toast, botId, items) {
      return postJson('skills/import', { botId, items }).then((r) => {
        const bad = Array.isArray(r?.failed) ? r.failed : [];
        const text = importSummary(t, r);
        if (r?.ok && text) {
          toast(text);
          void refreshState();
        } else if (!bad.length) toast(r?.reason || t('importFailed'), 'error');
        return { failed: bad, done: Boolean(r?.ok && text) };
      });
    }
    /** The label and tick of a picker row, by what importing it would do. */
    const importRowProps = (t, state, files) => ({
      disabled: state === 'taken',
      meta: state === 'taken' ? t('nameTaken') : state === 'update' ? t('reimport') : t('nFiles', { n: files ?? 0 }),
    });
    /** A search box with a magnifier. */
    const SearchBox = ({ value, onChange, placeholder, style, ...rest }) =>
      h(
        'div',
        { style: { position: 'relative', ...style } },
        h('span', { style: { position: 'absolute', left: 10, top: 9, color: C.faint, pointerEvents: 'none' } }, Icon.search(13)),
        h(Input, { value, placeholder, onChange: (e) => onChange(e.target.value), style: { paddingLeft: 30, height: 32 }, ...rest }),
      );
    /** One selectable row of a picker list. */
    function PickRow({ checked, disabled, onToggle, title, badge, meta, description, note, ...rest }) {
      return h(
        'label',
        {
          ...rest,
          style: { display: 'flex', flex: 'none', gap: 10, alignItems: 'flex-start', padding: '9px 12px', borderTop: `1px solid ${C.border1}`, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.55 : 1, background: checked ? tint(C.label, 7) : 'transparent' },
        },
        h('input', { type: 'checkbox', checked: Boolean(checked) || Boolean(disabled), disabled, onChange: () => onToggle(), style: { marginTop: 3, accentColor: 'var(--dsw-alias-brand-primary)' } }),
        h(
          'span',
          { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 } },
          h(
            'span',
            { style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 } },
            h('span', { className: 'dshb-mono', style: { fontWeight: 650, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, title),
            badge ?? null,
            meta ? h('span', { style: { fontSize: TINY, color: C.faint, marginLeft: 'auto', flex: 'none' } }, meta) : null,
          ),
          description ? h('span', { className: 'dshb-clamp2', style: { fontSize: SMALL, color: C.muted, lineHeight: 1.5 }, title: description }, description) : null,
          note ? h('span', { style: { fontSize: TINY, color: C.faint } }, note) : null,
        ),
      );
    }

    /** Pick installed Harness skills: they are referenced by name, never copied. */
    function HarnessPicker({ t, bot, onClose, onAdd, busy }) {
      const lib = useLoaded('library', 'skills/library');
      const [q, setQ] = useState('');
      const [sel, setSel] = useState([]);
      const have = new Set((bot.skills ?? []).map((s) => s.name));
      const all = Array.isArray(lib?.skills) ? lib.skills : null;
      const needle = q.trim().toLowerCase();
      const shown = (all ?? []).filter((s) => !needle || str(s.name).toLowerCase().includes(needle) || str(s.description).toLowerCase().includes(needle));
      const toggle = (name) => setSel((x) => (x.includes(name) ? x.filter((n) => n !== name) : [...x, name]));
      return h(
        Modal,
        {
          title: t('harnessPickerTitle'),
          closeLabel: t('close'),
          width: 680,
          onClose,
          footer: [
            h('span', { key: 'n', style: { flex: 1, alignSelf: 'center', fontSize: TINY, color: C.faint } }, t('harnessPickerNote')),
            h(Btn, { key: 'c', onClick: onClose }, t('cancel')),
            h(Btn, { key: 'a', kind: 'primary', disabled: sel.length === 0 || busy, onClick: () => onAdd(sel.map((n) => all.find((s) => s.name === n)).filter(Boolean)), 'data-dsh-bots-harness-add': true }, t('addN', { n: sel.length })),
          ],
        },
        h(SearchBox, { value: q, onChange: setQ, placeholder: t('searchSkills', { n: (all ?? []).length }), autoFocus: true, 'data-dsh-bots-harness-search': true }),
        h(
          'div',
          // The list scrolls by itself, so the search box stays in view however many skills there are.
          { 'data-dsh-bots-harness-list': true, className: 'dshb-scroll', style: { display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 120, border: `1px solid ${C.border1}`, borderRadius: 12, marginTop: -4, borderTop: 'none' } },
          all === null
            ? h('div', { style: { padding: 18, fontSize: SMALL, color: C.faint, textAlign: 'center', borderTop: `1px solid ${C.border1}` } }, t('loading'))
            : shown.length === 0
              ? h('div', { style: { padding: 18, fontSize: SMALL, color: C.faint, textAlign: 'center', borderTop: `1px solid ${C.border1}` } }, t('noSkillMatch'))
              : shown.map((s) =>
                  h(PickRow, {
                    key: s.name,
                    'data-dsh-bots-harness-skill': s.name,
                    checked: sel.includes(s.name),
                    disabled: have.has(s.name),
                    onToggle: () => toggle(s.name),
                    title: s.name,
                    badge: s.source ? h(Badge, { color: s.source === 'bundled' ? C.muted : s.source === 'project' ? '#7c3aed' : '#2563eb' }, ['user', 'project', 'bundled', 'plugin'].includes(s.source) ? t(`libSource_${s.source}`) : s.source) : null,
                    meta: have.has(s.name) ? t('added') : '',
                    description: s.description,
                  }),
                ),
        ),
      );
    }

    /** Import skill folders from GitHub: a featured source, or any owner/repo[/path]. */
    function GithubPicker({ t, lang, bot, catalog, onClose, onImported, toast }) {
      const sources = Array.isArray(catalog?.skillSources) ? catalog.skillSources : [];
      const [repo, setRepo] = useState('');
      const [listing, setListing] = useState(null); // {owner, repo, ref, skills}
      const [loading, setLoading] = useState(false);
      const [error, setError] = useState('');
      const [sel, setSel] = useState([]);
      const [importing, setImporting] = useState(false);
      const [failed, setFailed] = useState([]);
      const mine = skillsByName(bot);
      const stateOf = (s) => importStateOf(mine.get(str(s.name).toLowerCase()), listing ? `https://github.com/${listing.owner}/${listing.repo}/tree/${listing.ref}/${s.path}` : '');
      const browse = (spec) => {
        const value = str(spec).trim();
        if (!value) return;
        setLoading(true);
        setError('');
        setSel([]);
        setFailed([]);
        postJson('skills/github', { repo: value })
          .then((r) => {
            if (r?.ok && Array.isArray(r.skills)) setListing(r);
            else {
              setListing(null);
              setError(r?.reason || t('githubFailed'));
            }
          })
          .finally(() => setLoading(false));
      };
      const doImport = () => {
        if (!listing || sel.length === 0) return;
        setImporting(true);
        runImport(t, toast, bot.id, sel.map((path) => ({ repo: `${listing.owner}/${listing.repo}`, ref: listing.ref, path })))
          .then((r) => {
            setFailed(r.failed);
            if (r.done && r.failed.length === 0) onImported();
          })
          .finally(() => setImporting(false));
      };
      const skills = listing?.skills ?? [];
      return h(
        Modal,
        {
          title: t('githubPickerTitle'),
          closeLabel: t('close'),
          width: 700,
          onClose,
          footer: [
            importing ? h('span', { key: 'p', style: { flex: 1, alignSelf: 'center', display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: SMALL, color: C.muted } }, h('span', { className: 'dshb-spinner' }), t('importing')) : h('span', { key: 'p', style: { flex: 1, alignSelf: 'center', fontSize: TINY, color: C.faint } }, t('githubNote')),
            h(Btn, { key: 'c', onClick: onClose }, t('cancel')),
            h(Btn, { key: 'i', kind: 'primary', icon: Icon.download(12), disabled: sel.length === 0 || importing, onClick: doImport, 'data-dsh-bots-github-import': true }, t('importN', { n: sel.length })),
          ],
        },
        sources.length
          ? h(
              'div',
              { style: { display: 'flex', gap: 10, flexWrap: 'wrap' } },
              sources.map((src) =>
                h(
                  'button',
                  {
                    key: src.id,
                    type: 'button',
                    className: 'dshb-appcard',
                    'data-dsh-bots-skill-source-card': src.id,
                    onClick: () => {
                      const spec = `${src.repo}${src.path ? `/${src.path}` : ''}`;
                      setRepo(spec);
                      browse(spec);
                    },
                    style: { flex: '1 1 260px', flexDirection: 'row', alignItems: 'center', gap: 12, cursor: 'pointer', textAlign: 'left', font: 'inherit', color: 'inherit', background: `linear-gradient(135deg, ${tint('#d97706', 10)}, ${C.layer1} 70%)` },
                  },
                  h(AppIcon, { entry: { icon: 'A', color: '#c2410c', logo: src.logo }, size: 38 }),
                  h(
                    'span',
                    { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 } },
                    h('span', { style: { display: 'flex', alignItems: 'center', gap: 6 } }, h('span', { style: { fontWeight: 700 } }, pick(src.name, lang)), h(Badge, { color: C.label }, Icon.star(10), t('featured'))),
                    h('span', { style: { fontSize: SMALL, color: C.muted } }, pick(src.description, lang)),
                    h('span', { className: 'dshb-mono', style: { fontSize: 11, color: C.faint } }, src.repo),
                  ),
                  h('span', { style: { color: C.label, display: 'inline-flex' } }, Icon.arrow(14)),
                ),
              ),
            )
          : null,
        h(
          'div',
          { style: { display: 'flex', gap: 8 } },
          h(Input, {
            value: repo,
            mono: true,
            placeholder: 'owner/repo/path · https://github.com/…',
            'data-dsh-bots-github-repo': true,
            onChange: (e) => setRepo(e.target.value),
            onKeyDown: (e) => {
              if (e.key === 'Enter' && !e.isComposing && !e.nativeEvent?.isComposing) {
                e.preventDefault();
                browse(repo);
              }
            },
          }),
          h(Btn, { disabled: !repo.trim() || loading, onClick: () => browse(repo), 'data-dsh-bots-github-browse': true }, loading ? t('loading') : t('browse')),
        ),
        error ? h('div', { style: { fontSize: SMALL, color: C.error } }, error) : null,
        listing
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: SMALL } },
                Icon.github(13),
                h('span', { className: 'dshb-mono', style: { fontWeight: 600 } }, `${listing.owner}/${listing.repo}`),
                h('span', { style: { color: C.faint } }, t('foundSkills', { n: skills.length })),
                h('span', { style: { flex: 1 } }),
                skills.length
                  ? h('button', { type: 'button', className: 'dshb-link', style: { fontSize: TINY }, onClick: () => setSel(sel.length ? [] : skills.filter((s) => stateOf(s) === 'new').map((s) => s.path)) }, sel.length ? t('selectNone') : t('selectAll'))
                  : null,
              ),
              h(
                'div',
                { 'data-dsh-bots-github-list': true, style: { display: 'flex', flexDirection: 'column', border: `1px solid ${C.border1}`, borderRadius: 12, overflow: 'hidden', borderTop: 'none' } },
                skills.map((s) => {
                  const bad = failed.find((f) => f.spec?.path === s.path);
                  return h(PickRow, {
                    key: s.path,
                    'data-dsh-bots-github-skill': s.path,
                    checked: sel.includes(s.path),
                    onToggle: () => setSel((x) => (x.includes(s.path) ? x.filter((p) => p !== s.path) : [...x, s.path])),
                    title: s.name,
                    ...importRowProps(t, stateOf(s), s.files),
                    description: s.description,
                    note: bad ? h('span', { style: { color: C.error } }, bad.reason) : null,
                  });
                }),
              ),
            )
          : loading
            ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: SMALL, color: C.muted, padding: 8 } }, h('span', { className: 'dshb-spinner' }), t('readingRepo'))
            : null,
      );
    }

    /** Import skill folders from this machine: one skill folder, or a folder that holds several. */
    function LocalPicker({ t, bot, catalog, env, onClose, onImported, toast }) {
      const places = useLoaded('localPlaces', 'skills/local')?.places;
      const [path, setPath] = useState('');
      const [listing, setListing] = useState(null); // {root, skills, truncated}
      const [loading, setLoading] = useState(false);
      const [error, setError] = useState('');
      const [sel, setSel] = useState([]);
      const [importing, setImporting] = useState(false);
      const [failed, setFailed] = useState([]);
      const mine = skillsByName(bot);
      const inHarness = new Set((Array.isArray(catalog?.skills) ? catalog.skills : []).map((s) => s.name));
      // A folder already linked has nothing to import again: the bot reads it live.
      const stateOf = (s) => (importStateOf(mine.get(str(s.name).toLowerCase()), s.path) === 'new' ? 'new' : mine.get(str(s.name).toLowerCase()).origin === s.path ? 'linked' : 'taken');
      const scan = (spec) => {
        const value = str(spec).trim();
        if (!value) return;
        setLoading(true);
        setError('');
        setSel([]);
        setFailed([]);
        postJson('skills/local', { path: value })
          .then((r) => {
            if (r?.ok && Array.isArray(r.skills)) {
              setListing(r);
              // One skill and nothing in its way: ready to import.
              if (r.skills.length === 1 && !mine.has(str(r.skills[0].name).toLowerCase())) setSel([r.skills[0].path]);
            } else {
              setListing(null);
              setError(r?.reason || t('localFailed'));
            }
          })
          .finally(() => setLoading(false));
      };
      const canPick = typeof env?.pickDirectory === 'function' && env.canPickDirectory?.() !== false;
      const choose = () => {
        setError('');
        Promise.resolve()
          .then(() => env.pickDirectory())
          .then(
            (p) => {
              if (typeof p !== 'string' || p === '') return;
              setPath(p);
              scan(p);
            },
            () => setError(t('pickFailed')),
          );
      };
      const doImport = () => {
        if (!listing || sel.length === 0) return;
        setImporting(true);
        runImport(t, toast, bot.id, sel.map((p) => ({ local: p })))
          .then((r) => {
            setFailed(r.failed);
            if (r.done && r.failed.length === 0) onImported();
          })
          .finally(() => setImporting(false));
      };
      const skills = listing?.skills ?? [];
      return h(
        Modal,
        {
          title: t('localPickerTitle'),
          closeLabel: t('close'),
          width: 700,
          onClose,
          footer: [
            importing ? h('span', { key: 'p', style: { flex: 1, alignSelf: 'center', display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: SMALL, color: C.muted } }, h('span', { className: 'dshb-spinner' }), t('importing')) : h('span', { key: 'p', style: { flex: 1, alignSelf: 'center', fontSize: TINY, color: C.faint } }, t('localNote')),
            h(Btn, { key: 'c', onClick: onClose }, t('cancel')),
            h(Btn, { key: 'i', kind: 'primary', icon: Icon.folder(12), disabled: sel.length === 0 || importing, onClick: doImport, 'data-dsh-bots-local-import': true }, t('addN', { n: sel.length })),
          ],
        },
        h('div', { style: { fontSize: SMALL, color: C.muted, lineHeight: 1.6 } }, t('localHint')),
        h(
          'div',
          { style: { display: 'flex', gap: 8 } },
          h(Input, {
            value: path,
            mono: true,
            autoFocus: true,
            placeholder: '~/skills/my-skill',
            'data-dsh-bots-local-path': true,
            onChange: (e) => setPath(e.target.value),
            onKeyDown: (e) => {
              if (e.key === 'Enter' && !e.isComposing && !e.nativeEvent?.isComposing) {
                e.preventDefault();
                scan(path);
              }
            },
          }),
          canPick ? h(Btn, { icon: Icon.folder(13), disabled: loading, onClick: choose, 'data-dsh-bots-local-pick': true }, t('chooseFolder')) : null,
          h(Btn, { disabled: !path.trim() || loading, onClick: () => scan(path), 'data-dsh-bots-local-scan': true }, loading ? t('loading') : t('scan')),
        ),
        Array.isArray(places) && places.length
          ? h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: TINY, color: C.faint, marginTop: -6 } },
              t('localPlaces'),
              places.map((pl) =>
                h(
                  'button',
                  {
                    key: pl.path,
                    type: 'button',
                    className: 'dshb-chip dshb-mono',
                    'data-dsh-bots-local-place': pl.path,
                    title: pl.path,
                    onClick: () => {
                      setPath(pl.label || pl.path);
                      scan(pl.path);
                    },
                  },
                  pl.label || pl.path,
                ),
              ),
            )
          : null,
        error ? h('div', { 'data-dsh-bots-local-error': true, style: { fontSize: SMALL, color: C.error } }, error) : null,
        listing
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: SMALL, minWidth: 0 } },
                Icon.folder(13),
                h('span', { className: 'dshb-mono', style: { fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', direction: 'rtl' }, title: listing.root }, h('bdi', null, listing.root)),
                h('span', { style: { color: C.faint, flex: 'none' } }, t('foundSkills', { n: skills.length })),
                h('span', { style: { flex: 1 } }),
                skills.length > 1
                  ? h('button', { type: 'button', className: 'dshb-link', style: { fontSize: TINY, flex: 'none' }, onClick: () => setSel(sel.length ? [] : skills.filter((s) => stateOf(s) === 'new').map((s) => s.path)) }, sel.length ? t('selectNone') : t('selectAll'))
                  : null,
              ),
              skills.length === 0
                ? h('div', { style: { padding: 18, fontSize: SMALL, color: C.faint, textAlign: 'center', border: `1px dashed ${C.border1}`, borderRadius: 12 } }, t('localNone'))
                : h(
                    'div',
                    { 'data-dsh-bots-local-list': true, style: { display: 'flex', flexDirection: 'column', border: `1px solid ${C.border1}`, borderRadius: 12, overflow: 'hidden', borderTop: 'none' } },
                    skills.map((s) => {
                      const bad = failed.find((f) => f.spec?.local === s.path);
                      const state = stateOf(s);
                      const rel = s.path === listing.root ? '' : str(s.path).slice(listing.root.length + 1);
                      return h(PickRow, {
                        key: s.path,
                        'data-dsh-bots-local-skill': s.path,
                        'data-state': state,
                        checked: sel.includes(s.path),
                        onToggle: () => setSel((x) => (x.includes(s.path) ? x.filter((p) => p !== s.path) : [...x, s.path])),
                        title: s.name,
                        disabled: state !== 'new',
                        meta: state === 'linked' ? t('linked') : state === 'taken' ? t('nameTaken') : t('nFiles', { n: s.files ?? 0 }),
                        description: s.description,
                        note: bad ? h('span', { style: { color: C.error } }, bad.reason) : state === 'new' && inHarness.has(s.name) ? t('alsoInHarness') : rel && rel !== s.name ? h('span', { className: 'dshb-mono' }, rel) : null,
                      });
                    }),
                  ),
              listing.truncated ? h('div', { style: { fontSize: TINY, color: C.faint } }, t('localTruncated')) : null,
            )
          : loading
            ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: SMALL, color: C.muted, padding: 8 } }, h('span', { className: 'dshb-spinner' }), t('readingFolder'))
            : null,
      );
    }

    /** Describe a skill; the bot writes it (with skill-creator) in its own conversation. */
    function WriteSkillModal({ t, bot, onClose, onSent, toast }) {
      const [text, setText] = useState('');
      const [busy, setBusy] = useState(false);
      const send = () => {
        if (!text.trim() || busy) return;
        setBusy(true);
        postJson('skills/write', { botId: bot.id, text: text.trim() })
          .then((r) => {
            if (r?.ok) {
              toast(t('writeSent', { name: bot.name }));
              onSent();
            } else toast(r?.reason || t('sendFailed'), 'error');
          })
          .finally(() => setBusy(false));
      };
      return h(
        Modal,
        {
          title: t('writeSkillTitle', { name: bot.name }),
          closeLabel: t('close'),
          width: 540,
          onClose,
          footer: [h(Btn, { key: 'c', onClick: onClose }, t('cancel')), h(Btn, { key: 's', kind: 'primary', icon: Icon.wand(13), disabled: !text.trim() || busy, onClick: send, 'data-dsh-bots-write-send': true }, busy ? t('sending') : t('writeSkillGo'))],
        },
        h('div', { style: { fontSize: SMALL, color: C.muted, lineHeight: 1.6 } }, t('writeSkillHint')),
        h(TextArea, { value: text, rows: 4, autoFocus: true, placeholder: t('writeSkillPlaceholder'), onChange: (e) => setText(e.target.value), 'data-dsh-bots-write-text': true }),
      );
    }

    function SkillsTab({ t, bot, toast, catalog, setTab, env }) {
      const lang = langOf(t);
      const skills = Array.isArray(bot.skills) ? bot.skills : [];
      const [editing, setEditing] = useState(null); // {id?, name, description, content, enabled}
      const [confirm, setConfirm] = useState(null);
      const [busy, setBusy] = useState(false);
      const [picker, setPicker] = useState(null); // 'harness' | 'github' | 'local' | 'write'
      const commit = (next, okText) => {
        setBusy(true);
        return saveField(t, toast, bot, { skills: next }, okText).finally(() => setBusy(false));
      };
      const saveSkill = () => {
        const s = editing;
        if (!s || !s.name.trim()) return;
        const prev = skills.find((x) => x.id === s.id);
        // Two skills of one name would be told apart by nothing: refuse instead of doubling.
        if (skills.some((x) => x !== prev && str(x.name).toLowerCase() === s.name.trim().toLowerCase())) {
          toast(t('skillNameTaken', { name: s.name.trim() }), 'error');
          return;
        }
        const lim = skillLimits();
        if (!prev && skills.length >= lim.max) {
          toast(t('skillsFull', { max: lim.max }), 'error');
          return;
        }
        // A new skill past the limit of skills on is kept, switched off.
        const off = !prev && s.enabled !== false && onCount(skills) >= lim.on;
        const item = { ...(prev ?? {}), id: s.id || rid('skill'), name: s.name.trim(), source: prev ? skillSource(prev) : 'own', description: s.description.trim(), content: s.content, enabled: s.enabled !== false && !off };
        const next = s.id ? skills.map((x) => (x.id === s.id ? item : x)) : [...skills, item];
        void commit(next, off ? `${t('skillSaved')} ${t('offN', { n: 1, max: lim.on })}` : t('skillSaved')).then((ok) => ok && setEditing(null));
      };
      const addHarness = (list) => {
        const have = new Set(skills.map((x) => str(x.name).toLowerCase()));
        const lim = skillLimits();
        const fresh = list.filter((x) => !have.has(str(x.name).toLowerCase()));
        if (skills.length + fresh.length > lim.max) {
          toast(t('skillsRoom', { max: lim.max, n: Math.max(0, lim.max - skills.length) }), 'error');
          return;
        }
        // Past the limit of skills on, the rest come in switched off.
        const room = Math.max(0, lim.on - onCount(skills));
        const add = fresh.map((x, i) => ({ name: x.name, source: 'dsh', enabled: i < room, description: str(x.description) }));
        const off = add.length - Math.min(room, add.length);
        void commit([...skills, ...add], off ? `${t('addedN', { n: add.length })} ${t('offN', { n: off, max: lim.on })}` : t('addedN', { n: add.length })).then((ok) => ok && setPicker(null));
      };
      const counts = { dsh: 0, import: 0, local: 0, own: 0 };
      for (const s of skills) counts[isLocalSkill(s) ? 'local' : skillSource(s)] += 1;
      return h(
        'div',
        { className: 'dshb-scroll', style: { flex: 1, padding: '20px 24px 28px' } },
        h(
          'div',
          { style: { maxWidth: 860, display: 'flex', flexDirection: 'column', gap: 18 } },
          h(
            'div',
            { 'data-dsh-bots-skill-actions': true, style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
            h(Btn, { kind: 'primary', icon: Icon.layers(13), onClick: () => setPicker('harness'), 'data-dsh-bots-add-harness': true }, t('addFromHarness')),
            h(Btn, { icon: Icon.github(13), onClick: () => setPicker('github'), 'data-dsh-bots-add-github': true }, t('importGithub')),
            h(Btn, { icon: Icon.folder(13), onClick: () => setPicker('local'), 'data-dsh-bots-add-local': true }, t('importLocal')),
            h(Btn, { icon: Icon.wand(13), onClick: () => setPicker('write'), 'data-dsh-bots-add-write': true }, t('letBotWrite')),
            h('span', { style: { flex: 1 } }),
            editing ? null : h('button', { type: 'button', className: 'dshb-link', style: { fontSize: SMALL, color: C.muted }, onClick: () => setEditing({ name: '', description: '', content: '', enabled: true }), 'data-dsh-bots-add-skill': true }, t('writeByHand')),
          ),
          h(
            Section,
            {
              title: t('botSkills', { n: skills.length }),
              hint: t('skillsHint2', { name: bot.name }),
              right: skills.length
                ? h(
                    'span',
                    { style: { fontSize: TINY, color: C.faint } },
                    `${t('skillMix', counts)} · `,
                    h('span', { 'data-dsh-bots-skills-on': onCount(skills), style: onCount(skills) >= skillLimits().on ? { color: C.warn, fontWeight: 600 } : null }, t('skillsOnOf', { n: onCount(skills), max: skillLimits().on })),
                  )
                : null,
            },
            editing ? h(SkillEditor, { t, skill: editing, onChange: setEditing, onCancel: () => setEditing(null), onSave: saveSkill, busy }) : null,
            skills.length === 0 && !editing
              ? h('div', { className: 'dshb-card', style: { borderStyle: 'dashed', background: 'transparent' } }, h(Empty, { icon: Icon.puzzle(28), title: t('noSkillsTitle'), body: t('noSkillsBody2') }))
              : h(
                  'div',
                  { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 10 } },
                  skills.map((s) => {
                    const src = skillSource(s);
                    return h(
                      'div',
                      { key: s.id ?? s.name, className: 'dshb-card', 'data-dsh-bots-skill': s.id ?? s.name, 'data-source': src, style: { display: 'flex', flexDirection: 'column', gap: 8, opacity: s.enabled === false ? 0.65 : 1 } },
                      h(
                        'div',
                        { style: { display: 'flex', alignItems: 'center', gap: 8 } },
                        h('span', { className: 'dshb-mono', style: { fontWeight: 650, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: s.name }, s.name),
                        h(SourceBadge, { t, source: src, local: isLocalSkill(s) }),
                        h(Switch, {
                          on: s.enabled !== false,
                          disabled: busy,
                          title: s.enabled !== false ? t('disable') : t('enable'),
                          onChange: (on) => {
                            if (on && onCount(skills) >= skillLimits().on) return void toast(t('tooManyOn', { max: skillLimits().on }), 'error');
                            void commit(skills.map((x) => (x === s ? { ...x, enabled: on } : x)));
                          },
                        }),
                      ),
                      h('div', { className: 'dshb-clamp2', style: { fontSize: SMALL, color: C.muted, minHeight: 37, lineHeight: 1.5 }, title: s.description }, s.description || h('i', { style: { color: C.faint } }, t('noDescription'))),
                      h(
                        'div',
                        { style: { display: 'flex', alignItems: 'center', gap: 4, marginTop: 'auto', minWidth: 0 } },
                        src === 'dsh'
                          ? h('span', { style: { fontSize: TINY, color: C.faint, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, t('harnessManaged'))
                          : src === 'import'
                            ? isLocalSkill(s)
                              ? h('span', { className: 'dshb-mono', 'data-dsh-bots-skill-origin': s.origin, 'data-missing': s.missing ? true : undefined, style: { fontSize: TINY, color: s.missing ? C.error : C.faint, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: s.missing ? `${t('folderMissing')} ${s.origin}` : `${t('linkedHint')} ${s.origin}` }, s.missing ? t('folderMissing') : str(s.origin).split(/[\\/]/).filter(Boolean).slice(-2).join('/'))
                              : h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden' } }, s.origin ? h(ExtLink, { href: s.origin, title: s.origin }, str(s.origin).replace(/^https:\/\/github\.com\//, '').split('/').slice(0, 2).join('/')) : null)
                            : h('span', { style: { fontSize: TINY, color: C.faint, flex: 1 } }, t('chars', { n: str(s.content).length })),
                        src === 'dsh' || isLocalSkill(s) ? null : h(Btn, { size: 'sm', kind: 'ghost', icon: Icon.edit(12), title: t('edit'), onClick: () => setEditing({ ...s, description: str(s.description), content: str(s.content) }) }),
                        h(Btn, { size: 'sm', kind: 'ghost', icon: Icon.trash(12), title: t('remove'), className: 'dshb-btn dshb-btn-sm dshb-btn-icon dshb-btn-ghost dshb-btn-danger', onClick: () => setConfirm(s) }),
                      ),
                    );
                  }),
                ),
          ),
        ),
        picker === 'harness' ? h(HarnessPicker, { t, bot, busy, onClose: () => setPicker(null), onAdd: addHarness }) : null,
        picker === 'github' ? h(GithubPicker, { t, lang, bot, catalog, toast, onClose: () => setPicker(null), onImported: () => setPicker(null) }) : null,
        picker === 'local' ? h(LocalPicker, { t, bot, catalog, env, toast, onClose: () => setPicker(null), onImported: () => setPicker(null) }) : null,
        picker === 'write'
          ? h(WriteSkillModal, {
              t,
              bot,
              toast,
              onClose: () => setPicker(null),
              onSent: () => {
                setPicker(null);
                setTab?.('chat');
              },
            })
          : null,
        confirm
          ? h(Confirm, {
              t,
              title: t('deleteSkillTitle', { name: confirm.name }),
              body: t('deleteSkillBody'),
              confirmLabel: t('remove'),
              onClose: () => setConfirm(null),
              onConfirm: () => commit(skills.filter((x) => x !== confirm), t('skillDeleted')),
            })
          : null,
      );
    }
    function SkillEditor({ t, skill, onChange, onCancel, onSave, busy }) {
      const set = (p) => onChange({ ...skill, ...p });
      return h(
        'div',
        { className: 'dshb-card dshb-fade', 'data-dsh-bots-skill-editor': true, style: { display: 'flex', flexDirection: 'column', gap: 12, borderColor: C.label, boxShadow: `0 0 0 3px ${tint(C.label, 12)}` } },
        h('div', { style: { fontWeight: 700 } }, skill.id ? t('editSkill') : t('newSkill')),
        h(
          'div',
          { style: { display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 12 } },
          h(Field, { label: t('skillName') }, h(Input, { value: skill.name, placeholder: 'weekly-report', onChange: (e) => set({ name: e.target.value }) })),
          h(Field, { label: t('skillDescription'), hint: t('skillDescriptionHint') }, h(Input, { value: skill.description, onChange: (e) => set({ description: e.target.value }) })),
        ),
        h(Field, { label: t('skillContent'), hint: t('skillContentHint') }, h(TextArea, { mono: true, value: skill.content, rows: 12, placeholder: t('skillContentPlaceholder'), onChange: (e) => set({ content: e.target.value }), style: { minHeight: 200 } })),
        h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8 } }, h(Btn, { onClick: onCancel }, t('cancel')), h(Btn, { kind: 'primary', disabled: busy || !skill.name.trim(), onClick: onSave }, busy ? t('saving') : t('saveSkill'))),
      );
    }

    // --- schedules tab ---------------------------------------------------------------

    const MODES = ['at', 'every', 'daily', 'weekly', 'cron'];
    function SchedulesTab({ t, bot, toast, catalog }) {
      const [items, setItems] = useState(null);
      const [failed, setFailed] = useState(false);
      const [editing, setEditing] = useState(null); // {id?, title, prompt, form}
      const [confirm, setConfirm] = useState(null);
      const [busyId, setBusyId] = useState('');
      const alive = useRef(true);
      useEffect(() => {
        alive.current = true;
        setItems(null);
        setEditing(null);
        return () => {
          alive.current = false;
        };
      }, [bot.id]);
      const load = () =>
        Promise.resolve()
          .then(() => getJson(`schedules?bot=${encodeURIComponent(bot.id)}`))
          .then((r) => {
            if (!alive.current) return;
            if (r && Array.isArray(r.items)) {
              setItems(r.items);
              setFailed(false);
            } else setFailed(true);
          })
          .catch(() => alive.current && setFailed(true));
      usePoll(load, SCHEDULE_POLL_MS, [bot.id]);
      const zone = str(catalog?.zone) || localZone();
      const act = (task, path, body, okText) => {
        setBusyId(task.id);
        return postJson(path, body)
          .then((r) => {
            if (r?.ok) {
              if (okText) toast(okText);
              return load();
            }
            toast(r?.reason || t('actionFailed'), 'error');
            return undefined;
          })
          .finally(() => setBusyId(''));
      };
      const startNew = () => setEditing({ title: '', prompt: '', form: formFromTiming(null, zone) });
      const save = () => {
        const e = editing;
        const timing = buildTiming(e.form);
        if (timing.error) return void toast(t(timing.error), 'error');
        if (!e.title.trim() || !e.prompt.trim()) return void toast(t('errTitlePrompt'), 'error');
        setBusyId('form');
        postJson('schedules/save', { botId: bot.id, ...(e.id ? { id: e.id } : {}), title: e.title.trim(), prompt: e.prompt.trim(), timing })
          .then((r) => {
            if (r?.ok) {
              toast(e.id ? t('scheduleUpdated') : t('scheduleCreated'));
              setEditing(null);
              return load();
            }
            toast(r?.reason || t('saveFailed'), 'error');
            return undefined;
          })
          .finally(() => setBusyId(''));
      };
      const list = items ?? [];
      return h(
        'div',
        { className: 'dshb-scroll', style: { flex: 1, padding: '20px 24px 28px' } },
        h(
          'div',
          { style: { maxWidth: 820, display: 'flex', flexDirection: 'column', gap: 16 } },
          h(
            Section,
            {
              title: t('schedulesTitle', { n: list.length }),
              hint: t('schedulesHint', { name: bot.name }),
              right: editing ? null : h(Btn, { size: 'sm', kind: 'primary', icon: Icon.plus(12), onClick: startNew, 'data-dsh-bots-add-schedule': true }, t('newSchedule')),
            },
            editing ? h(ScheduleEditor, { t, value: editing, onChange: setEditing, onCancel: () => setEditing(null), onSave: save, busy: busyId === 'form' }) : null,
            items === null
              ? h('div', { style: { fontSize: SMALL, color: C.faint, padding: 12 } }, failed ? t('unavailable') : t('loading'))
              : list.length === 0 && !editing
                ? h('div', { className: 'dshb-card', style: { borderStyle: 'dashed', background: 'transparent' } }, h(Empty, { icon: Icon.clock(28), title: t('noSchedulesTitle'), body: t('noSchedulesBody') }))
                : h(
                    'div',
                    { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                    list.map((task) => {
                      const active = task.status === 'active';
                      const ended = task.status === 'ended';
                      const busy = busyId === task.id;
                      const next = toMs(task.scheduledAt);
                      const last = task.lastDelivery?.deliveredAt;
                      return h(
                        'div',
                        { key: task.id, className: 'dshb-card', 'data-dsh-bots-task': task.id, style: { display: 'flex', gap: 12, alignItems: 'flex-start', opacity: active ? 1 : 0.72 } },
                        h('span', { style: { width: 32, height: 32, borderRadius: 9, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: active ? tint(C.label, 14) : C.layer2, color: active ? C.label : C.faint, flex: 'none' } }, Icon.clock(16)),
                        h(
                          'div',
                          { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 } },
                          h(
                            'div',
                            { style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 } },
                            h('span', { style: { fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, task.title || t('untitled')),
                            h(Badge, { color: active ? C.ok : ended ? C.faint : C.warn }, t(`taskStatus_${task.status}`) || task.status),
                            task.executionActive ? h(Badge, { color: C.label }, t('runningNow')) : null,
                          ),
                          h('div', { style: { fontSize: SMALL, color: C.muted }, 'data-dsh-bots-timing': true }, describeTiming(t, task.timing, task.describe)),
                          h(
                            'div',
                            { style: { display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: TINY, color: C.faint } },
                            active && Number.isFinite(next) ? h('span', { title: fmtDate(next) }, t('nextRun', { when: fmtAgo(t, next) })) : null,
                            last ? h('span', { title: fmtDate(toMs(last)) }, t('lastRun', { when: fmtAgo(t, last) })) : h('span', null, t('neverRun')),
                          ),
                          task.prompt ? h('div', { style: { fontSize: SMALL, color: C.muted, marginTop: 2, padding: '6px 9px', borderRadius: 8, background: C.layer2 } }, h(Clamp, { t, text: task.prompt, lines: 2 })) : null,
                        ),
                        h(
                          'div',
                          { style: { display: 'flex', alignItems: 'center', gap: 2, flex: 'none' } },
                          ended ? null : h(Switch, { on: active, disabled: busy, title: active ? t('pause') : t('resume'), onChange: (on) => void act(task, 'schedules/toggle', { id: task.id, active: on }, on ? t('resumed') : t('paused')) }),
                          h(Btn, { size: 'sm', kind: 'ghost', icon: Icon.play(12), title: t('runNow'), disabled: busy, onClick: () => void act(task, 'schedules/run', { id: task.id }, t('ranNow')) }),
                          h(Btn, { size: 'sm', kind: 'ghost', icon: Icon.edit(12), title: t('edit'), disabled: busy, onClick: () => setEditing({ id: task.id, title: str(task.title), prompt: str(task.prompt), form: formFromTiming(task.timing, zone) }) }),
                          h(Btn, { size: 'sm', kind: 'ghost', icon: Icon.trash(12), title: t('delete'), disabled: busy, className: 'dshb-btn dshb-btn-sm dshb-btn-icon dshb-btn-ghost dshb-btn-danger', onClick: () => setConfirm(task) }),
                        ),
                      );
                    }),
                  ),
          ),
        ),
        confirm
          ? h(Confirm, {
              t,
              title: t('deleteScheduleTitle', { title: confirm.title || t('untitled') }),
              body: t('deleteScheduleBody'),
              confirmLabel: t('delete'),
              onClose: () => setConfirm(null),
              onConfirm: () => act(confirm, 'schedules/delete', { id: confirm.id }, t('scheduleDeleted')),
            })
          : null,
      );
    }

    function ScheduleEditor({ t, value, onChange, onCancel, onSave, busy }) {
      const f = value.form;
      const setF = (p) => onChange({ ...value, form: { ...f, ...p } });
      const built = buildTiming(f);
      const tzField = h(Field, { label: t('timeZone'), style: { minWidth: 180, flex: 1, maxWidth: 320 } }, h(Input, { value: f.tz, onChange: (e) => setF({ tz: e.target.value }), list: 'dshb-zones' }));
      const timeField = h(Field, { label: t('atTime'), style: { width: 130 } }, h(Input, { type: 'time', value: f.time, onChange: (e) => setF({ time: e.target.value }) }));
      let body;
      if (f.mode === 'at') body = h(Field, { label: t('onceAt'), style: { maxWidth: 260 } }, h(Input, { type: 'datetime-local', value: f.at, onChange: (e) => setF({ at: e.target.value }) }));
      else if (f.mode === 'every')
        body = h(
          'div',
          { style: { display: 'flex', alignItems: 'flex-end', gap: 8 } },
          h(Field, { label: t('every'), style: { width: 110 } }, h(Input, { type: 'number', min: 1, value: f.everyN, onChange: (e) => setF({ everyN: e.target.value }) })),
          h('select', { className: 'dshb-input', value: f.everyUnit, onChange: (e) => setF({ everyUnit: e.target.value }), style: { width: 130 } }, h('option', { value: 'minutes' }, t('minutes')), h('option', { value: 'hours' }, t('hours'))),
        );
      else if (f.mode === 'daily') body = h('div', { style: { display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' } }, timeField, tzField);
      else if (f.mode === 'weekly')
        body = h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
          h(
            'div',
            { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
            [1, 2, 3, 4, 5, 6, 7].map((d) =>
              h(
                'button',
                {
                  key: d,
                  type: 'button',
                  className: 'dshb-chip',
                  'data-active': f.weekdays.includes(d),
                  style: { minWidth: 46, justifyContent: 'center' },
                  onClick: () => setF({ weekdays: f.weekdays.includes(d) ? f.weekdays.filter((x) => x !== d) : [...f.weekdays, d].sort((a, b) => a - b) }),
                },
                t(`wd${d}`),
              ),
            ),
          ),
          h('div', { style: { display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' } }, timeField, tzField),
        );
      else
        body = h(
          'div',
          { style: { display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' } },
          h(Field, { label: t('cronExpr'), hint: t('cronHint'), style: { flex: 1, minWidth: 200 } }, h(Input, { mono: true, value: f.cron, onChange: (e) => setF({ cron: e.target.value }) })),
          tzField,
        );
      return h(
        'div',
        { className: 'dshb-card dshb-fade', 'data-dsh-bots-schedule-editor': true, style: { display: 'flex', flexDirection: 'column', gap: 14, borderColor: C.label, boxShadow: `0 0 0 3px ${tint(C.label, 12)}` } },
        h('div', { style: { fontWeight: 700 } }, value.id ? t('editSchedule') : t('newSchedule')),
        h(Field, { label: t('taskTitle') }, h(Input, { value: value.title, placeholder: t('taskTitlePlaceholder'), onChange: (e) => onChange({ ...value, title: e.target.value }) })),
        h(Field, { label: t('taskPrompt'), hint: t('taskPromptHint') }, h(TextArea, { value: value.prompt, rows: 4, placeholder: t('taskPromptPlaceholder'), onChange: (e) => onChange({ ...value, prompt: e.target.value }) })),
        h(
          Field,
          { label: t('when') },
          h(
            'div',
            { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
            MODES.map((m) => h('button', { key: m, type: 'button', className: 'dshb-chip', 'data-active': f.mode === m, 'data-dsh-bots-mode': m, onClick: () => setF({ mode: m }) }, t(`mode_${m}`))),
          ),
        ),
        body,
        h('datalist', { id: 'dshb-zones' }, [localZone(), 'UTC', 'Asia/Shanghai', 'Asia/Singapore', 'Asia/Tokyo', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles'].map((z, i) => h('option', { key: `${z}${i}`, value: z }))),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: SMALL, color: built.error ? C.error : C.muted } },
          Icon.clock(13),
          built.error ? t(built.error) : describeTiming(t, built),
        ),
        h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8 } }, h(Btn, { onClick: onCancel }, t('cancel')), h(Btn, { kind: 'primary', disabled: busy || Boolean(built.error), onClick: onSave, 'data-dsh-bots-save-schedule': true }, busy ? t('saving') : value.id ? t('save') : t('createSchedule'))),
      );
    }

    // --- apps tab -----------------------------------------------------------------------

    const linesOf = (s) =>
      str(s)
        .split('\n')
        .map((x) => x.trim())
        .filter(Boolean);
    const kvToText = (o) =>
      Object.entries(o ?? {})
        .map(([k, v]) => `${k}=${v}`)
        .join('\n');
    const headersToText = (o) =>
      Object.entries(o ?? {})
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n');
    function textToKv(s, sep) {
      const out = {};
      for (const line of linesOf(s)) {
        const i = line.indexOf(sep);
        if (i <= 0) continue;
        out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      }
      return out;
    }
    const isHttp = (app, tpl) => app.template === 'mcp-http' || tpl?.transport === 'streamable-http' || (!app.config?.command && Boolean(app.config?.url));
    function appDraft(app) {
      return {
        id: app.id,
        template: app.template,
        name: str(app.name),
        serverName: str(app.serverName),
        enabled: app.enabled !== false,
        command: str(app.config?.command),
        args: (app.config?.args ?? []).join('\n'),
        env: kvToText(app.config?.env),
        url: str(app.config?.url),
        headers: headersToText(app.config?.headers),
      };
    }
    function appFromDraft(d, http) {
      const config = http ? { url: d.url.trim(), headers: textToKv(d.headers, ':') } : { command: d.command.trim(), args: linesOf(d.args), env: textToKv(d.env, '=') };
      return { id: d.id, template: d.template, name: d.name.trim() || d.serverName.trim(), serverName: d.serverName.trim(), enabled: d.enabled, values: {}, config };
    }
    function uniqueServer(name, apps, selfId) {
      const base = str(name).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 28) || 'app';
      let n = base;
      for (let i = 2; apps.some((a) => a.id !== selfId && a.serverName === n); i += 1) n = `${base}${i}`;
      return n;
    }

    /** The app's logo, or a coloured rounded square with its letters (or one CJK character) in white. */
    function AppIcon({ entry, size = 36 }) {
      const logo = str(entry?.logo);
      const [broken, setBroken] = useState('');
      if (logo && broken !== logo) {
        return h(
          'span',
          {
            'data-dsh-bots-app-icon': entry?.id ?? true,
            'data-dsh-bots-app-logo': logo,
            style: {
              width: size,
              height: size,
              borderRadius: Math.round(size * 0.26),
              display: 'inline-flex',
              flex: 'none',
              overflow: 'hidden',
              background: '#fff',
              boxShadow: '0 0 0 1px rgba(0,0,0,.08), 0 1px 2px rgba(0,0,0,.12)',
              userSelect: 'none',
            },
          },
          h('img', { src: `${R}logo/${encodeURIComponent(logo)}.png`, alt: '', draggable: false, onError: () => setBroken(logo), style: { width: '100%', height: '100%', display: 'block', objectFit: 'cover' } }),
        );
      }
      const icon = str(entry?.icon) || '?';
      const color = str(entry?.color) || '#475569';
      const n = [...icon].length;
      const cjk = /[\u3000-\u9fff]/.test(icon);
      const scale = cjk ? 0.5 : n >= 3 ? 0.3 : n === 2 ? 0.38 : 0.48;
      return h(
        'span',
        {
          'data-dsh-bots-app-icon': entry?.id ?? true,
          style: {
            width: size,
            height: size,
            borderRadius: Math.round(size * 0.26),
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            flex: 'none',
            color: '#fff',
            fontWeight: 700,
            fontSize: Math.round(size * scale),
            letterSpacing: n >= 2 && !cjk ? '0.01em' : 0,
            lineHeight: 1,
            background: `linear-gradient(150deg, color-mix(in srgb, ${color} 80%, #fff) 0%, ${color} 50%, color-mix(in srgb, ${color} 82%, #000) 100%)`,
            boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.12), 0 1px 2px rgba(0,0,0,.12)',
            fontFamily: n >= 3 && !cjk ? 'var(--dsh-code-font, ui-monospace, SFMono-Regular, Menlo, monospace)' : '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif',
            userSelect: 'none',
            whiteSpace: 'nowrap',
          },
        },
        icon,
      );
    }
    const RUNTIME_WORD = { node: 'npx', uv: 'uvx' };
    function runtimeLabel(t, entry) {
      if (!entry) return '';
      if (isChannelEntry(entry)) return t('chatChannel');
      if (entry.transport === 'streamable-http') return t('runtimeRemote');
      return RUNTIME_WORD[entry.runtime] ?? (entry.runtime === 'binary' ? t('runtimeBinary') : str(entry.command));
    }
    const ExtLink = ({ href, children, ...rest }) => (href ? h('a', { className: 'dshb-extlink', href, target: '_blank', rel: 'noreferrer noopener', ...rest }, children, ' ↗') : null);
    /** Field values a form starts with: the app's own, else the field default. */
    function valuesFor(entry, app) {
      const out = {};
      for (const f of entry?.fields ?? []) {
        const own = app?.values?.[f.key];
        out[f.key] = own !== undefined && own !== null && String(own) !== '' ? String(own) : str(f.default);
      }
      return out;
    }
    // --- chat channels (Telegram, Discord, Feishu, Slack): apps people message the team from --

    const CHANNEL_NAMES = { telegram: 'Telegram', discord: 'Discord', slack: 'Slack', feishu: 'Feishu' };
    const CHANNEL_COLORS = { telegram: '#229ED9', discord: '#5865F2', slack: '#4a154b', feishu: '#3370ff' };
    const channelName = (kind, t) => (kind === 'feishu' && langOf(t) === 'zh' ? '飞书' : CHANNEL_NAMES[kind] ?? str(kind));
    const isChannelEntry = (entry) => entry?.kind === 'channel';
    /** Hint codes that read differently per chat app. */
    const KIND_HINTS = new Set(['slack_scopes', 'feishu_scopes']);

    /** Under a chat channel's row: whether it is connected, the pairing code, and who is paired. */
    function ChannelPanel({ t, bot, app, entry, view, toast }) {
      const [working, setWorking] = useState('');
      const v = view && typeof view === 'object' ? view : { state: 'connecting', paired: [] };
      const kind = str(v.kind || entry?.channel);
      const appName = channelName(kind, t);
      const handle = v.account?.username ? `@${v.account.username}` : appName;
      const paired = Array.isArray(v.paired) ? v.paired : [];
      const call = (path, body, okText) => {
        setWorking(path);
        return postJson(path, { botId: bot.id, appId: app.id, ...body })
          .then((r) => {
            if (r?.ok) {
              if (okText) toast(okText);
              void refreshState();
            } else toast(r?.reason || t('actionFailed'), 'error');
            return r;
          })
          .finally(() => setWorking(''));
      };
      const state = str(v.state) || 'connecting';
      const hintText = v.hint ? t(KIND_HINTS.has(`${kind}_${v.hint}`) ? `channelHint_${kind}_${v.hint}` : `channelHint_${v.hint}`, { app: appName }) : '';
      const dot = (color) => h('span', { style: { width: 8, height: 8, borderRadius: '50%', background: color, flex: 'none' } });
      const statusLine =
        state === 'connected'
          ? [dot(C.ok), h('span', { key: 's', style: { fontWeight: 600 } }, t('channelConnected', { handle }))]
          : state === 'connecting'
            ? [h('span', { key: 'sp', className: 'dshb-spinner', style: { width: 12, height: 12 } }), h('span', { key: 's' }, t('channelConnecting', { app: appName }))]
            : state === 'error'
              ? [h('span', { key: 'i', style: { color: C.error, display: 'inline-flex' } }, Icon.alert(13)), h('span', { key: 's', style: { color: C.error, fontWeight: 600 } }, hintText || str(v.detail) || t('channelError'))]
              : state === 'off'
                ? [dot(C.faint), h('span', { key: 's', style: { color: C.muted } }, t('channelOff'))]
                : [dot('#d97706'), h('span', { key: 's', style: { color: C.muted } }, t('channelMissing', { app: appName }))];
      const live = state !== 'off' && state !== 'missing';
      const step = kind === 'telegram' ? t('pairStepTelegram', { handle }) : kind === 'discord' ? t('pairStepDiscord', { handle }) : kind === 'slack' ? t('pairStepSlack', { handle }) : kind === 'feishu' ? t('pairStepFeishu', { handle }) : t('pairStep', { handle, app: appName });
      return h(
        'div',
        { 'data-dsh-bots-channel': app.id, 'data-state': state, style: { display: 'flex', flexDirection: 'column', gap: 10, margin: '0 14px 12px 62px', padding: '10px 12px', borderRadius: 10, background: C.base, border: `1px solid ${C.border1}`, fontSize: SMALL } },
        h(
          'div',
          { 'data-dsh-bots-channel-status': state, style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }, title: str(v.detail) || undefined },
          statusLine,
          h('span', { style: { flex: 1 } }),
          state === 'error' || state === 'connecting'
            ? h(Btn, { size: 'sm', kind: 'ghost', icon: Icon.refresh(12), disabled: Boolean(working), onClick: () => void call('channels/reconnect', {}), 'data-dsh-bots-channel-reconnect': app.id }, t('reconnect'))
            : null,
        ),
        state === 'error' && hintText && v.detail ? h('div', { style: { fontSize: TINY, color: C.faint, marginTop: -6 } }, str(v.detail)) : null,
        live
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
              h('div', { style: { fontSize: TINY, fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '.02em' } }, t('pairedPeople', { n: paired.length })),
              paired.length === 0
                ? h('div', { style: { color: C.faint } }, t('nobodyPaired', { app: appName }))
                : paired.map((p, i) =>
                    h(
                      'div',
                      { key: p.id, 'data-dsh-bots-paired': p.id, style: { display: 'flex', alignItems: 'center', gap: 8 } },
                      h('span', { style: { color: C.muted, display: 'inline-flex' } }, Icon.user(13)),
                      h('span', { style: { fontWeight: 600 } }, str(p.name) || str(p.id)),
                      i === 0 ? h(Badge, { color: C.muted }, t('pairedFirst')) : null,
                      h('span', { style: { color: C.faint, fontSize: TINY } }, t('pairedSince', { when: fmtDate(toMs(p.at)) })),
                      h('span', { style: { flex: 1 } }),
                      h(Btn, { size: 'sm', kind: 'ghost', className: 'dshb-btn dshb-btn-sm dshb-btn-ghost dshb-btn-danger', disabled: Boolean(working), onClick: () => void call('channels/unpair', { userId: p.id }, t('unpaired', { name: str(p.name) })), 'data-dsh-bots-unpair': p.id }, t('remove')),
                    ),
                  ),
            )
          : null,
        live && v.code
          ? h(
              'div',
              { 'data-dsh-bots-pairing': app.id, style: { display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 10px', borderRadius: 9, background: tint(CHANNEL_COLORS[kind] ?? C.label, 8), border: `1px solid ${tint(CHANNEL_COLORS[kind] ?? C.label, 25)}` } },
              h('div', { style: { color: C.muted, lineHeight: 1.5 } }, step),
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
                h('span', { className: 'dshb-mono', 'data-dsh-bots-pair-code': str(v.code.code), style: { fontSize: 20, fontWeight: 700, letterSpacing: '.18em', color: C.primary } }, str(v.code.code)),
                h(Btn, { size: 'sm', kind: 'ghost', onClick: () => (copyText(kind === 'telegram' ? `/start ${v.code.code}` : str(v.code.code)), toast(t('copied'))) }, t('copy')),
                v.link ? h(ExtLink, { href: v.link, 'data-dsh-bots-pair-link': true }, t('openIn', { app: appName })) : null,
                h('span', { style: { flex: 1 } }),
                h('span', { style: { fontSize: TINY, color: C.faint } }, t('codeExpires', { when: fmtAgo(t, v.code.expiresAt) })),
                h(Btn, { size: 'sm', disabled: Boolean(working), onClick: () => void call('channels/code', {}), 'data-dsh-bots-new-code': app.id }, t('newCode')),
              ),
            )
          : live
            ? h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                h(Btn, { size: 'sm', kind: paired.length ? 'default' : 'primary', icon: Icon.plus(12), disabled: Boolean(working) || state !== 'connected', onClick: () => void call('channels/code', {}), 'data-dsh-bots-new-code': app.id }, paired.length ? t('pairAnother') : t('pairSomeone')),
                state !== 'connected' ? h('span', { style: { fontSize: TINY, color: C.faint } }, t('pairWhenConnected')) : null,
              )
            : null,
        live && v.invite ? h('div', null, h(ExtLink, { href: v.invite, 'data-dsh-bots-invite': true }, t('inviteDiscord'))) : null,
        live && paired.length
          ? h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              h(Switch, { on: v.scheduleReplies !== false, disabled: Boolean(working), title: t('channelSchedules', { name: str(paired[0].name), app: appName }), onChange: (on) => void call('channels/options', { scheduleReplies: on }), 'data-dsh-bots-channel-schedules': app.id }),
              h('span', { style: { color: C.muted } }, t('channelSchedules', { name: str(paired[0].name), app: appName })),
            )
          : null,
        live && v.ignored?.count ? h('div', { 'data-dsh-bots-ignored': v.ignored.count, style: { fontSize: TINY, color: C.faint } }, t('channelIgnored', { n: v.ignored.count, name: str(v.ignored.lastName) })) : null,
        h('div', { style: { fontSize: TINY, color: C.faint, lineHeight: 1.5 } }, t('channelPrivate', { app: appName })),
      );
    }

    const missingFields = (entry, values) => (entry?.fields ?? []).filter((f) => f.required && str(values?.[f.key]).trim() === '').map((f) => f.key);
    const needsForm = (entry) => (entry?.fields ?? []).some((f) => f.required);

    function AppsTab({ t, bot, toast, catalog }) {
      const lang = langOf(t);
      const apps = Array.isArray(bot.apps) ? bot.apps : [];
      const issues = bot.appIssues && typeof bot.appIssues === 'object' ? bot.appIssues : {};
      const entries = Array.isArray(catalog?.templates) ? catalog.templates : [];
      const categories = Array.isArray(catalog?.categories) ? catalog.categories : [];
      const [form, setForm] = useState(null); // {entry, app?, values, serverName}
      const [editing, setEditing] = useState(null); // custom: {draft, isNew, http}
      const [confirm, setConfirm] = useState(null);
      const [busy, setBusy] = useState(false);
      const [installing, setInstalling] = useState(false);
      const [q, setQ] = useState('');
      const [cat, setCat] = useState('all');
      const [importing, setImporting] = useState(false);
      const external = useLoaded('external', 'apps/external');
      const extItems = Array.isArray(external?.items) ? external.items : [];
      const commit = (next, okText) => {
        setBusy(true);
        return saveField(t, toast, bot, { apps: next }, okText).finally(() => setBusy(false));
      };
      // The install state is the Host's: re-read it whenever this tab shows.
      useEffect(() => {
        void loadCatalog(true);
      }, [bot.id]);
      const installOcu = () => {
        setInstalling(true);
        void postJson('ocu/install', {})
          .then((r) => {
            if (r?.ok) toast(t('ocuInstallDone', { version: r.version ?? '' }));
            else toast(r?.reason || t('ocuInstallFailed'), 'error');
            return loadCatalog(true);
          })
          .finally(() => setInstalling(false));
      };
      const entryOf = (app) => entries.find((e) => e.id === app.template) ?? null;
      const nameOf = (app, entry) => (entry && !entry.custom ? pick(entry.name, lang) : '') || str(app.name) || str(app.serverName);
      const addedIds = new Set(apps.map((a) => a.template));
      const add = (entry) => {
        if (entry.custom) {
          const app = { id: rid('app'), template: entry.id, name: '', serverName: uniqueServer(entry.serverName || entry.id, apps), enabled: true, config: entry.transport === 'streamable-http' ? { url: str(entry.url), headers: {} } : { command: str(entry.command), args: entry.args ?? [], env: {} } };
          setEditing({ draft: appDraft(app), isNew: true, http: entry.transport === 'streamable-http' });
          return;
        }
        if (!needsForm(entry)) {
          const app = { id: rid('app'), template: entry.id, name: pick(entry.name, 'en'), serverName: uniqueServer(entry.serverName || entry.id, apps), enabled: true, values: {}, config: {} };
          void commit([...apps, app], t('appAdded', { name: pick(entry.name, lang) }));
          return;
        }
        setForm({ entry, app: null, values: valuesFor(entry, null), serverName: uniqueServer(entry.serverName || entry.id, apps) });
      };
      const configure = (app) => {
        const entry = entryOf(app);
        if (!entry || entry.custom) {
          setEditing({ draft: appDraft(app), isNew: false, http: isHttp(app, entry) });
          return;
        }
        setForm({ entry, app, values: valuesFor(entry, app), serverName: str(app.serverName) });
      };
      const saveForm = () => {
        const { entry, app, values, serverName } = form;
        const server = str(serverName).trim();
        if (!SERVER_RE.test(server)) return void toast(t('serverNameInvalid'), 'error');
        if (apps.some((a) => a.id !== app?.id && a.serverName === server)) return void toast(t('serverNameTaken'), 'error');
        if (missingFields(entry, values).length) return void toast(t('fieldsRequired'), 'error');
        const clean = {};
        for (const f of entry.fields ?? []) {
          const v = f.multi ? linesOf(values[f.key]).join('\n') : str(values[f.key]).trim();
          if (v !== '') clean[f.key] = v;
        }
        const next = app
          ? apps.map((a) => (a.id === app.id ? { ...a, serverName: server, values: clean } : a))
          : [...apps, { id: rid('app'), template: entry.id, name: pick(entry.name, 'en'), serverName: server, enabled: true, values: clean, config: {} }];
        void commit(next, app ? t('appSaved') : t('appAdded', { name: pick(entry.name, lang) })).then((ok) => ok && setForm(null));
      };
      const saveEdit = () => {
        const { draft, isNew, http } = editing;
        if (!SERVER_RE.test(draft.serverName.trim())) return void toast(t('serverNameInvalid'), 'error');
        if (apps.some((a) => a.id !== draft.id && a.serverName === draft.serverName.trim())) return void toast(t('serverNameTaken'), 'error');
        if (http ? !/^https?:\/\//.test(draft.url.trim()) : !draft.command.trim()) return void toast(http ? t('urlRequired') : t('commandRequired'), 'error');
        const app = appFromDraft(draft, http);
        const next = isNew ? [...apps, app] : apps.map((a) => (a.id === app.id ? { ...a, ...app } : a));
        void commit(next, isNew ? t('appAdded', { name: app.name }) : t('appSaved')).then((ok) => ok && setEditing(null));
      };

      // The gallery: search, then a category, else Featured on top and every category below.
      const needle = q.trim().toLowerCase();
      const catLabel = (id) => pick(categories.find((c) => c.id === id), lang) || id;
      const matches = (e) =>
        !needle ||
        [e.id, e.serverName, pick(e.name, 'en'), pick(e.name, 'zh'), pick(e.description, 'en'), pick(e.description, 'zh'), catLabel(e.category)].some((s) => str(s).toLowerCase().includes(needle));
      const ocuEntry = entries.find((e) => e.id === 'open-computer-use');
      const card = (e) => h(AppCard, { key: e.id, t, lang, entry: e, added: addedIds.has(e.id) && !e.custom, busy, onAdd: () => add(e), region: e.region === 'cn' ? t('regionCn') : '' });
      const grid = (list) => h('div', { 'data-dsh-bots-gallery-grid': true, style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(232px, 1fr))', gap: 10 } }, list.map(card));
      const subhead = (text, n) =>
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 6, fontSize: SMALL, fontWeight: 700, color: C.primary, margin: '6px 0 0' } }, text, n !== undefined ? h('span', { style: { fontSize: TINY, fontWeight: 500, color: C.faint } }, n) : null);
      const ocuCard = ocuEntry ? h(OcuCard, { t, lang, entry: ocuEntry, ocu: catalog?.ocu, added: addedIds.has('open-computer-use'), busy, installing, onAdd: () => add(ocuEntry), onInstall: installOcu, onRecheck: () => void loadCatalog(true) }) : null;
      let gallery;
      if (entries.length === 0) gallery = h('div', { style: { fontSize: SMALL, color: C.faint } }, catalog ? t('noTemplates') : t('loading'));
      else if (needle) {
        const found = entries.filter(matches);
        gallery = found.length ? grid(found) : h('div', { style: { fontSize: SMALL, color: C.faint, padding: '16px 0' } }, t('noAppMatch', { q: q.trim() }));
      } else if (cat === 'featured') gallery = h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } }, ocuCard, grid(entries.filter((e) => e.featured && e.id !== 'open-computer-use')));
      else if (cat !== 'all') gallery = h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } }, cat === 'computer' ? ocuCard : null, grid(entries.filter((e) => e.category === cat && e.id !== 'open-computer-use')));
      else
        gallery = h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
          subhead(t('featured')),
          ocuCard,
          grid(entries.filter((e) => e.featured && e.id !== 'open-computer-use')),
          categories
            .filter((c) => entries.some((e) => e.category === c.id))
            .map((c) => {
              const list = entries.filter((e) => e.category === c.id && e.id !== 'open-computer-use');
              return list.length ? h('div', { key: c.id, style: { display: 'flex', flexDirection: 'column', gap: 10, marginTop: 8 } }, subhead(pick(c, lang), list.length), grid(list)) : null;
            }),
        );
      const chips = [{ id: 'all', label: t('allApps') }, { id: 'featured', label: t('featured') }, ...categories.filter((c) => entries.some((e) => e.category === c.id)).map((c) => ({ id: c.id, label: pick(c, lang) }))];

      return h(
        'div',
        { className: 'dshb-scroll', style: { flex: 1, padding: '20px 24px 28px' } },
        h(
          'div',
          { style: { maxWidth: 940, display: 'flex', flexDirection: 'column', gap: 24 } },
          h(
            'div',
            { 'data-dsh-bots-apps-note': true, style: { display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', borderRadius: 10, background: tint(C.label, 9), color: C.muted, fontSize: SMALL } },
            Icon.sparkle(14),
            h('span', null, t('appsNote')),
          ),
          catalog && catalog.mcp === false ? h('div', { style: { fontSize: SMALL, color: C.warn } }, t('mcpMissing')) : null,
          h(
            Section,
            { title: t('installedApps', { n: apps.length }) },
            apps.length === 0
              ? h('div', { className: 'dshb-card', style: { borderStyle: 'dashed', background: 'transparent', fontSize: SMALL, color: C.faint, textAlign: 'center', padding: '16px 14px' } }, t('noApps'))
              : h(
                  'div',
                  { style: { display: 'flex', flexDirection: 'column', border: `1px solid ${C.border1}`, borderRadius: 12, overflow: 'hidden', background: C.layer1 } },
                  apps.map((app, i) => {
                    const entry = entryOf(app);
                    const issue = str(issues[app.id]);
                    const custom = !entry || entry.custom;
                    const channel = isChannelEntry(entry);
                    const detail = custom ? (isHttp(app, entry) ? str(app.config?.url) : [app.config?.command, ...(app.config?.args ?? [])].filter(Boolean).join(' ')) : pick(entry.description, lang);
                    const row = h(
                      'div',
                      { key: app.id, 'data-dsh-bots-app': app.id, style: { display: 'flex', alignItems: 'center', gap: 12, padding: '11px 14px', borderTop: i && !channel ? `1px solid ${C.border1}` : 'none', opacity: app.enabled === false ? 0.6 : 1 } },
                      h(AppIcon, { entry: entry ?? { icon: '{ }', color: '#475569' }, size: 36 }),
                      h(
                        'div',
                        { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 } },
                        h(
                          'div',
                          { style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flexWrap: 'wrap' } },
                          h('span', { style: { fontWeight: 600 } }, nameOf(app, entry)),
                          channel ? h(Badge, { color: entry.color || C.label }, Icon.chat(10), t('chatChannel')) : h('span', { className: 'dshb-mono', style: { fontSize: 11.5, color: C.faint } }, `mcp__${app.serverName}__*`),
                          issue ? h(Badge, { color: '#d97706', title: issue, 'data-dsh-bots-app-issue': app.id }, Icon.alert(11), t('needsSetup')) : null,
                        ),
                        issue
                          ? h('div', { style: { fontSize: TINY, color: '#b45309', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: issue }, issue)
                          : h('div', { className: custom ? 'dshb-mono' : undefined, style: { fontSize: TINY, color: C.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: detail }, detail),
                      ),
                      h(Switch, { on: app.enabled !== false, disabled: busy, title: app.enabled !== false ? t('disable') : t('enable'), onChange: (on) => void commit(apps.map((a) => (a.id === app.id ? { ...a, enabled: on } : a))) }),
                      h(Btn, { size: 'sm', kind: issue ? 'primary' : 'default', icon: Icon.edit(12), onClick: () => configure(app), 'data-dsh-bots-configure': app.id }, t('configure')),
                      h(Btn, { size: 'sm', kind: 'ghost', icon: Icon.trash(12), title: t('remove'), className: 'dshb-btn dshb-btn-sm dshb-btn-icon dshb-btn-ghost dshb-btn-danger', onClick: () => setConfirm(app) }),
                    );
                    if (!channel) return row;
                    return h(
                      'div',
                      { key: app.id, style: { borderTop: i ? `1px solid ${C.border1}` : 'none' } },
                      row,
                      h(ChannelPanel, { t, bot, app, entry, view: bot.channels?.[app.id], toast }),
                    );
                  }),
                ),
          ),
          h(
            Section,
            { title: t('appGallery'), hint: t('appGalleryHint', { n: entries.length }) },
            extItems.length ? h(ExternalCard, { t, items: extItems, onOpen: () => setImporting(true) }) : null,
            h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
              h(
                'div',
                { style: { position: 'relative', maxWidth: 360 } },
                h('span', { style: { position: 'absolute', left: 10, top: 9, color: C.faint, pointerEvents: 'none' } }, Icon.search(13)),
                h(Input, { value: q, placeholder: t('searchApps'), onChange: (e) => setQ(e.target.value), 'data-dsh-bots-app-search': true, style: { paddingLeft: 30, height: 32 } }),
              ),
              h(
                'div',
                { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
                chips.map((c) => h('button', { key: c.id, type: 'button', className: 'dshb-chip', 'data-active': !needle && cat === c.id, 'data-dsh-bots-cat': c.id, onClick: () => (setCat(c.id), setQ('')) }, c.label)),
              ),
            ),
            gallery,
          ),
        ),
        importing ? h(ExternalModal, { t, bot, items: extItems, toast, onClose: () => setImporting(false) }) : null,
        form ? h(AppConfigModal, { t, lang, value: form, onChange: setForm, onClose: () => setForm(null), onSave: saveForm, busy }) : null,
        editing
          ? h(
              Modal,
              { title: editing.isNew ? t('addAppTitle') : t('editAppTitle'), closeLabel: t('close'), width: 600, onClose: () => setEditing(null) },
              h(AppEditor, { t, value: editing, onChange: setEditing, onCancel: () => setEditing(null), onSave: saveEdit, busy }),
            )
          : null,
        confirm
          ? h(Confirm, {
              t,
              title: t('removeAppTitle', { name: nameOf(confirm, entryOf(confirm)) }),
              body: t('removeAppBody'),
              confirmLabel: t('remove'),
              onClose: () => setConfirm(null),
              onConfirm: () => commit(apps.filter((a) => a.id !== confirm.id), t('appRemoved')),
            })
          : null,
      );
    }

    /** Where an external server runs: its command line or URL. */
    const extTarget = (x) => (x.template === 'mcp-http' ? str(x.config?.url) : [x.config?.command, ...(x.config?.args ?? [])].filter(Boolean).join(' '));
    const extKey = (x) => `${x.from}/${x.name}`;
    const extTaken = (x, apps) => apps.some((a) => a.serverName === x.serverName || a.name === x.name);

    function ExternalCard({ t, items, onOpen }) {
      const froms = [...new Set(items.map((x) => str(x.from).split(' · ')[0]))];
      return h(
        'div',
        { className: 'dshb-card', 'data-dsh-bots-external': items.length, style: { display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', background: `linear-gradient(135deg, ${tint('#0f766e', 10)}, ${C.layer1} 65%)`, borderColor: tint('#0f766e', 30) } },
        h('span', { style: { width: 38, height: 38, borderRadius: 10, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: tint('#0f766e', 15), color: '#0f766e', flex: 'none' } }, Icon.download(18)),
        h(
          'div',
          { style: { flex: 1, minWidth: 0 } },
          h('div', { style: { fontWeight: 700 } }, t('importOtherAgents')),
          h('div', { style: { fontSize: SMALL, color: C.muted, marginTop: 2 } }, t('foundExternal', { n: items.length, from: froms.slice(0, 3).join(t('listSep')) + (froms.length > 3 ? '…' : '') })),
        ),
        h(Btn, { kind: 'primary', size: 'sm', onClick: onOpen, 'data-dsh-bots-external-open': true }, t('chooseImport')),
      );
    }

    function ExternalModal({ t, bot, items, onClose, toast }) {
      const apps = Array.isArray(bot.apps) ? bot.apps : [];
      const [sel, setSel] = useState([]);
      const [busy, setBusy] = useState(false);
      const groups = [];
      for (const x of items) {
        let g = groups.find((y) => y.from === x.from);
        if (!g) groups.push((g = { from: x.from, items: [] }));
        g.items.push(x);
      }
      const go = () => {
        setBusy(true);
        postJson('apps/import', { botId: bot.id, names: sel })
          .then((r) => {
            if (r?.ok) {
              toast(t('importedApps', { n: (r.added ?? sel).length }));
              void refreshState();
              onClose();
            } else toast(r?.reason || t('importFailed'), 'error');
          })
          .finally(() => setBusy(false));
      };
      return h(
        Modal,
        {
          title: t('importOtherAgents'),
          closeLabel: t('close'),
          width: 680,
          onClose,
          footer: [
            h('span', { key: 'n', style: { flex: 1, alignSelf: 'center', fontSize: TINY, color: C.faint } }, t('externalNote')),
            h(Btn, { key: 'c', onClick: onClose }, t('cancel')),
            h(Btn, { key: 'i', kind: 'primary', disabled: sel.length === 0 || busy, onClick: go, 'data-dsh-bots-external-import': true }, t('importN', { n: sel.length })),
          ],
        },
        groups.map((g) =>
          h(
            'div',
            { key: g.from, 'data-dsh-bots-external-group': g.from, style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            h('div', { style: { fontSize: SMALL, fontWeight: 700, color: C.muted } }, g.from),
            h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', border: `1px solid ${C.border1}`, borderRadius: 12, overflow: 'hidden', borderTop: 'none' } },
              g.items.map((x) => {
                const key = extKey(x);
                const taken = extTaken(x, apps);
                const env = Object.entries(x.config?.env ?? x.config?.headers ?? {});
                return h(PickRow, {
                  key,
                  'data-dsh-bots-external-item': key,
                  checked: sel.includes(key),
                  disabled: taken,
                  onToggle: () => setSel((s) => (s.includes(key) ? s.filter((k) => k !== key) : [...s, key])),
                  title: x.name,
                  badge: h(Badge, { color: x.template === 'mcp-http' ? '#7c3aed' : '#0f766e' }, x.template === 'mcp-http' ? 'http' : 'stdio'),
                  meta: taken ? t('alreadyImported') : '',
                  description: extTarget(x),
                  note: env.length ? h('span', { className: 'dshb-mono' }, env.map(([k, v]) => `${k}=${v}`).join('  ')) : null,
                });
              }),
            ),
          ),
        ),
      );
    }

    function AppCard({ t, lang, entry, added, busy, onAdd, region }) {
      return h(
        'div',
        { className: 'dshb-appcard', 'data-dsh-bots-template': entry.id },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 } },
          h(AppIcon, { entry, size: 36 }),
          h(
            'div',
            { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 } },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } },
              h('span', { style: { fontWeight: 650, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: pick(entry.name, lang) }, pick(entry.name, lang)),
              region ? h(Badge, { color: '#e11d48' }, region) : null,
            ),
            h('span', { className: 'dshb-mono', style: { fontSize: 11, color: C.faint } }, runtimeLabel(t, entry)),
          ),
        ),
        h('div', { className: 'dshb-clamp2', style: { fontSize: SMALL, color: C.muted, lineHeight: 1.5, minHeight: 37 }, title: pick(entry.description, lang) }, pick(entry.description, lang)),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 'auto' } },
          entry.keyUrl ? h(ExtLink, { href: entry.keyUrl }, isChannelEntry(entry) ? t('createChatBot') : t('getKey')) : entry.homepage ? h(ExtLink, { href: entry.homepage, style: { color: C.faint } }, t('docs')) : null,
          h('span', { style: { flex: 1 } }),
          h(
            Btn,
            { size: 'sm', kind: added ? 'ghost' : 'default', icon: added ? Icon.check(12) : Icon.plus(12), disabled: added || busy, onClick: onAdd, 'data-dsh-bots-add-app': entry.id, style: added ? { color: C.ok, opacity: 1 } : undefined },
            added ? t('added') : t('add'),
          ),
        ),
      );
    }

    /** Open Computer Use, featured: whether the program is on this Mac, and a one-click install. */
    function OcuCard({ t, lang, entry, ocu, added, busy, installing, onAdd, onInstall, onRecheck }) {
      return h(
        'div',
        { className: 'dshb-card', 'data-dsh-bots-template': entry.id, 'data-dsh-bots-ocu': true, style: { display: 'flex', flexDirection: 'column', gap: 10, background: `linear-gradient(135deg, ${tint(C.label, 12)}, ${C.layer1} 60%)`, borderColor: tint(C.label, 35), padding: '14px 16px' } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 12 } },
          h(AppIcon, { entry, size: 46 }),
          h(
            'div',
            { style: { flex: 1, minWidth: 0 } },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
              h('span', { style: { fontWeight: 700, fontSize: 14.5 } }, pick(entry.name, lang)),
              h(Badge, { color: C.label }, Icon.star(10), t('featured')),
              ocu ? h(Badge, { color: ocu.installed ? C.ok : C.warn, title: ocu.path }, ocu.installed ? t('ocuInstalled') : t('ocuMissing')) : null,
              h('span', { className: 'dshb-mono', style: { fontSize: 11, color: C.faint } }, runtimeLabel(t, entry)),
            ),
            h('div', { style: { fontSize: SMALL, color: C.muted, marginTop: 3, lineHeight: 1.5 } }, `${pick(entry.description, lang)} ${t('ocuBlurb')}`),
          ),
          h(ExtLink, { href: entry.homepage }, t('docs')),
          h(
            Btn,
            { size: 'sm', kind: added ? 'ghost' : 'primary', icon: added ? Icon.check(12) : Icon.plus(12), disabled: added || busy, onClick: onAdd, 'data-dsh-bots-add-app': entry.id, style: added ? { color: C.ok, opacity: 1 } : undefined },
            added ? t('added') : t('add'),
          ),
        ),
        ocu && !ocu.installed
          ? h(
              'div',
              { style: { fontSize: SMALL, color: C.muted, padding: '9px 11px', borderRadius: 9, background: C.base, border: `1px solid ${C.border1}`, display: 'flex', flexDirection: 'column', gap: 4 } },
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: 10 } },
                h('div', { style: { fontWeight: 600, color: C.primary, flex: 1 } }, added ? t('ocuAddedNotInstalled') : t('ocuInstallTitle')),
                h(Btn, { size: 'sm', kind: 'ghost', disabled: installing, onClick: onRecheck, 'data-dsh-bots-ocu-recheck': true }, t('ocuRecheck')),
                h(Btn, { size: 'sm', kind: 'primary', icon: installing ? h('span', { className: 'dshb-spinner', style: { borderColor: 'rgba(255,255,255,.35)', borderTopColor: '#fff' } }) : Icon.download(12), disabled: installing, onClick: onInstall, 'data-dsh-bots-ocu-install': true }, installing ? t('ocuInstalling') : t('ocuInstallNow')),
              ),
              h('div', null, t('ocuInstallWhat'), ' ', h('code', { className: 'dshb-mono' }, ocu.path || '~/.local/share/ocu/ocu')),
              h('div', null, t('ocuStep3')),
            )
          : ocu && ocu.installed && added
            ? h('div', { style: { fontSize: SMALL, color: C.muted } }, t('ocuReady', { path: ocu.path }))
            : null,
      );
    }

    /** The settings form of a catalog app, built from its `fields`. */
    function AppConfigModal({ t, lang, value, onChange, onClose, onSave, busy }) {
      const { entry, app } = value;
      const [shown, setShown] = useState({});
      const fields = Array.isArray(entry.fields) ? entry.fields : [];
      const setV = (key, v) => onChange({ ...value, values: { ...value.values, [key]: v } });
      const missing = missingFields(entry, value.values);
      const channel = isChannelEntry(entry);
      const sErr = value.serverName && !SERVER_RE.test(value.serverName) ? t('serverNameInvalid') : '';
      return h(
        Modal,
        {
          title: app ? t('configureTitle', { name: pick(entry.name, lang) }) : t('addNamedApp', { name: pick(entry.name, lang) }),
          closeLabel: t('close'),
          width: 560,
          onClose,
          footer: [
            h('span', { key: 'n', style: { flex: 1, fontSize: TINY, color: C.faint, alignSelf: 'center' } }, channel ? t('channelSaveNote') : t('appsNote')),
            h(Btn, { key: 'c', onClick: onClose }, t('cancel')),
            h(Btn, { key: 's', kind: 'primary', disabled: busy || missing.length > 0 || Boolean(sErr), onClick: onSave, 'data-dsh-bots-app-save': true }, busy ? t('saving') : app ? t('save') : t('add')),
          ],
        },
        h(
          'div',
          { 'data-dsh-bots-app-form': entry.id, style: { display: 'flex', gap: 12, alignItems: 'flex-start' } },
          h(AppIcon, { entry, size: 44 }),
          h(
            'div',
            { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 } },
            h('div', { style: { fontSize: SMALL, color: C.muted, lineHeight: 1.55 } }, pick(entry.description, lang)),
            h('div', { style: { display: 'flex', gap: 14, flexWrap: 'wrap' } }, h(ExtLink, { href: entry.homepage }, t('docs')), h(ExtLink, { href: entry.keyUrl }, channel ? t('createChatBot') : t('getKey'))),
          ),
        ),
        channel ? h('div', { 'data-dsh-bots-channel-how': entry.id, style: { fontSize: SMALL, color: C.muted, lineHeight: 1.6, padding: '9px 11px', borderRadius: 9, background: tint(entry.color || C.label, 8) } }, t('channelHow', { app: pick(entry.name, lang) })) : null,
        fields.length === 0 ? h('div', { style: { fontSize: SMALL, color: C.faint } }, t('noSettings')) : null,
        fields.map((f) => {
          const v = str(value.values[f.key]);
          const label = h('span', null, pick(f.label, lang), f.required ? h('span', { style: { color: C.error, marginLeft: 3 } }, '*') : null);
          const common = { value: v, placeholder: str(f.placeholder), 'data-dsh-bots-app-field': f.key, 'data-kind': f.kind, onChange: (e) => setV(f.key, e.target.value), spellCheck: false, autoComplete: 'off' };
          let control;
          if (f.multi) control = h(TextArea, { ...common, mono: f.kind !== 'text', rows: Math.max(3, Math.min(8, v.split('\n').length + 1)) });
          else if (f.kind === 'secret')
            control = h(
              'div',
              { style: { position: 'relative' } },
              h(Input, { ...common, mono: true, type: shown[f.key] ? 'text' : 'password', style: { paddingRight: 36 } }),
              h(
                'button',
                {
                  type: 'button',
                  title: shown[f.key] ? t('hideSecret') : t('showSecret'),
                  'aria-label': shown[f.key] ? t('hideSecret') : t('showSecret'),
                  'data-dsh-bots-eye': f.key,
                  onClick: () => setShown((s) => ({ ...s, [f.key]: !s[f.key] })),
                  style: { position: 'absolute', right: 4, top: 4, width: 26, height: 24, border: 'none', borderRadius: 6, background: 'transparent', color: C.muted, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' },
                },
                shown[f.key] ? Icon.eyeOff(14) : Icon.eye(14),
              ),
            );
          else control = h(Input, { ...common, mono: f.kind === 'path' });
          return h(Field, { key: f.key, label, hint: pick(f.help, lang) || (f.kind === 'path' && !f.multi ? t('pathHint') : '') }, control);
        }),
        channel
          ? null
          : h(
          'details',
          { style: { fontSize: SMALL, color: C.muted } },
          h('summary', { style: { cursor: 'pointer', userSelect: 'none' } }, t('advanced')),
          h(
            'div',
            { style: { marginTop: 10 } },
            h(Field, { label: t('serverName'), error: sErr, hint: t('serverNameHint', { name: value.serverName || 'name' }) }, h(Input, { mono: true, value: value.serverName, 'data-invalid': Boolean(sErr), onChange: (e) => onChange({ ...value, serverName: e.target.value }) })),
          ),
        ),
      );
    }

    /** The raw editor of a custom server: command/args/env or url/headers. */
    function AppEditor({ t, value, onChange, onCancel, onSave, busy }) {
      const d = value.draft;
      const set = (p) => onChange({ ...value, draft: { ...d, ...p } });
      const sErr = d.serverName && !SERVER_RE.test(d.serverName) ? t('serverNameInvalid') : '';
      return h(
        'div',
        { 'data-dsh-bots-app-editor': true, style: { display: 'flex', flexDirection: 'column', gap: 12 } },
        h(
          'div',
          { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 } },
          h(Field, { label: t('appName') }, h(Input, { value: d.name, onChange: (e) => set({ name: e.target.value }) })),
          h(Field, { label: t('serverName'), error: sErr, hint: t('serverNameHint', { name: d.serverName || 'name' }) }, h(Input, { mono: true, value: d.serverName, 'data-invalid': Boolean(sErr), onChange: (e) => set({ serverName: e.target.value }) })),
        ),
        value.http
          ? [
              h(Field, { key: 'u', label: t('url') }, h(Input, { mono: true, value: d.url, placeholder: 'https://example.com/mcp', onChange: (e) => set({ url: e.target.value }) })),
              h(Field, { key: 'h', label: t('headers'), hint: t('headersHint') }, h(TextArea, { mono: true, rows: 3, value: d.headers, placeholder: 'Authorization: Bearer …', onChange: (e) => set({ headers: e.target.value }) })),
            ]
          : [
              h(Field, { key: 'c', label: t('command') }, h(Input, { mono: true, value: d.command, placeholder: 'npx', onChange: (e) => set({ command: e.target.value }) })),
              h(
                'div',
                { key: 'ae', style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 } },
                h(Field, { label: t('args'), hint: t('argsHint') }, h(TextArea, { mono: true, rows: 4, value: d.args, onChange: (e) => set({ args: e.target.value }) })),
                h(Field, { label: t('env'), hint: t('envHint') }, h(TextArea, { mono: true, rows: 4, value: d.env, placeholder: 'API_KEY=…', onChange: (e) => set({ env: e.target.value }) })),
              ),
            ],
        h('div', { style: { fontSize: TINY, color: C.faint } }, t('appsNote')),
        h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8 } }, h(Btn, { onClick: onCancel }, t('cancel')), h(Btn, { kind: 'primary', disabled: busy, onClick: onSave }, busy ? t('saving') : value.isNew ? t('add') : t('save'))),
      );
    }

    // --- detail: header + tabs ------------------------------------------------------------

    const TABS = ['chat', 'tasks', 'profile', 'memory', 'skills', 'schedules', 'apps'];
    function BotDetail({ t, bot, primaryId, env, toast, catalog, tab, setTab, onDeleted, onSettings }) {
      const [menu, setMenu] = useState(false);
      const [confirm, setConfirm] = useState(false);
      const [opening, setOpening] = useState(false);
      const isPrimary = bot.id === primaryId || bot.role === 'primary';
      const status = bot.status ?? 'offline';
      const open = () => {
        setOpening(true);
        Promise.resolve(env.openBot(bot)).finally(() => setOpening(false));
      };
      const makePrimary = () =>
        postJson('primary', { id: bot.id }).then((r) => {
          if (r?.ok) {
            toast(t('nowDispatcher', { name: bot.name }));
            void refreshState();
          } else toast(r?.reason || t('actionFailed'), 'error');
        });
      const remove = () =>
        postJson('delete', { id: bot.id }).then((r) => {
          if (r?.ok) {
            toast(t('deleted', { name: bot.name }));
            onDeleted();
            void refreshState();
          } else toast(r?.reason || t('actionFailed'), 'error');
        });
      const counts = { tasks: openTaskCount(bot), skills: (bot.skills ?? []).length, apps: (bot.apps ?? []).length, memory: Number(bot.memoryNotes) || 0 };
      let body;
      if (tab === 'tasks') body = h(BotTasksTab, { key: bot.id, t, bot });
      else if (tab === 'profile') body = h(ProfileTab, { key: bot.id, t, bot, toast, catalog });
      else if (tab === 'skills') body = h(SkillsTab, { key: bot.id, t, bot, toast, catalog, setTab, env });
      else if (tab === 'schedules') body = h(SchedulesTab, { key: bot.id, t, bot, toast, catalog });
      else if (tab === 'apps') body = h(AppsTab, { key: bot.id, t, bot, toast, catalog });
      else if (tab === 'memory') body = h(MemoryTab, { key: bot.id, t, bot, toast, onSettings });
      else body = h(ChatTab, { key: bot.id, t, bot, env, toast });
      return h(
        'div',
        { 'data-dsh-bots-detail': bot.id, style: { display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0 } },
        h(
          'header',
          { style: { padding: '18px 24px 0', borderBottom: `1px solid ${C.border1}` } },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 14 } },
            h(Avatar, { avatar: bot.avatar, name: bot.name || bot.handle, size: 56, status, ring: isPrimary, title: t(`status_${status}`) }),
            h(
              'div',
              { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 } },
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 } },
                h('span', { style: { fontWeight: 700, fontSize: 19, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, bot.name || bot.handle),
                isPrimary ? h(Badge, { color: '#d99a00', title: t('dispatcherHint') }, Icon.crown(11), t('dispatcher')) : null,
              ),
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: SMALL, color: C.muted, minWidth: 0 } },
                h('span', { className: 'dshb-mono', style: { fontSize: 12 } }, `@${bot.handle}`),
                h('span', { style: { color: C.faint } }, '·'),
                h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap', flex: 'none' } }, h(StatusDot, { status, size: 7 }), t(`status_${status}`)),
                Number(bot.usageToday) > 0 ? h('span', { style: { color: C.faint } }, '·') : null,
                Number(bot.usageToday) > 0 ? h('span', { 'data-dsh-bots-today': bot.id, style: { whiteSpace: 'nowrap', flex: 'none' } }, t('usageHint', { tokens: fmtNum(bot.usageToday) })) : null,
                bot.bio ? h('span', { style: { color: C.faint } }, '·') : null,
                bot.bio ? h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, bot.bio) : null,
              ),
            ),
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 6, flex: 'none', position: 'relative' } },
              env.canOpen() ? h(Btn, { icon: Icon.chat(14), disabled: opening, onClick: open, 'data-dsh-bots-open': bot.id }, t('openConversation')) : null,
              isPrimary ? null : h(Btn, { icon: Icon.crown(12), onClick: () => void makePrimary(), 'data-dsh-bots-primary': bot.id }, t('setDispatcher')),
              h(Btn, { kind: 'ghost', icon: Icon.dots(16), title: t('more'), onClick: () => setMenu((v) => !v) }),
              menu
                ? h(Menu, {
                    onClose: () => setMenu(false),
                    items: [
                      { id: 'copy', label: t('copyHandle'), icon: Icon.edit(13), run: () => copyText(`@${bot.handle}`) },
                      { id: 'refresh', label: t('refresh'), icon: Icon.refresh(13), run: () => void refreshState() },
                      { id: 'delete', label: t('deleteBot'), icon: Icon.trash(13), danger: true, disabled: isPrimary && botsOf().length > 1, run: () => setConfirm(true) },
                    ],
                  })
                : null,
            ),
          ),
          h(
            'nav',
            { role: 'tablist', style: { display: 'flex', marginTop: 12 } },
            TABS.map((id) =>
              h(
                'button',
                { key: id, type: 'button', role: 'tab', className: 'dshb-tab', 'data-active': tab === id, 'aria-selected': tab === id, 'data-dsh-bots-tab': id, onClick: () => setTab(id) },
                t(`tab_${id}`),
                counts[id] ? h('span', { style: { marginLeft: 5, fontSize: TINY, color: C.faint, fontWeight: 500 } }, counts[id]) : null,
              ),
            ),
          ),
        ),
        body,
        confirm
          ? h(Confirm, {
              t,
              title: t('deleteBotTitle', { name: bot.name }),
              body: t('deleteBotBody', { name: bot.name }),
              confirmLabel: t('deleteBot'),
              onClose: () => setConfirm(false),
              onConfirm: remove,
            })
          : null,
      );
    }

    // --- usage, memory, topics, settings, model sources ---------------------------------------

    const fmtNum = (n) => {
      const x = Number(n) || 0;
      if (x >= 1e9) return `${(x / 1e9).toFixed(x >= 1e10 ? 0 : 1)}B`;
      if (x >= 1e6) return `${(x / 1e6).toFixed(x >= 1e7 ? 0 : 1)}M`;
      if (x >= 1e3) return `${(x / 1e3).toFixed(x >= 1e4 ? 0 : 1)}K`;
      return String(Math.round(x));
    };
    const CURRENCY = { USD: '$', CNY: '¥' };
    const fmtMoney = (amount, cur) => {
      const v = Number(amount) || 0;
      return `${CURRENCY[cur] ?? `${cur} `}${v >= 100 ? v.toFixed(0) : v >= 1 ? v.toFixed(2) : v >= 0.01 ? v.toFixed(3) : v > 0 ? v.toFixed(4) : '0'}`;
    };
    const fmtCost = (cost) => {
      const parts = Object.entries(cost ?? {})
        .filter(([, v]) => Number(v) > 0)
        .map(([c, v]) => fmtMoney(v, c));
      return parts.length ? parts.join(' + ') : '—';
    };
    const tzNow = () => {
      try {
        return -new Date().getTimezoneOffset();
      } catch {
        return 0;
      }
    };
    const API_LABELS = {
      'openai-completions': 'OpenAI-compatible · Chat Completions',
      'openai-responses': 'OpenAI · Responses',
      'anthropic-messages': 'Anthropic-compatible · Messages',
      'google-generative-ai': 'Google Gemini',
    };
    /** A GET loaded now and every `ms` while shown (`ms` 0 = once). */
    function useJson(path, ms = 0) {
      const [data, setData] = useState(null);
      const [failed, setFailed] = useState(false);
      const alive = useRef(true);
      useEffect(() => {
        alive.current = true;
        return () => {
          alive.current = false;
        };
      }, []);
      const load = () =>
        Promise.resolve()
          .then(() => getJson(path))
          .then((r) => {
            if (!alive.current) return;
            if (r && r.ok !== false) {
              setData(r);
              setFailed(false);
            } else setFailed(true);
          })
          .catch(() => {
            if (alive.current) setFailed(true);
          });
      usePoll(load, ms || 3_600_000, [path]);
      return { data, failed, reload: load };
    }
    /** A bot's colour for charts: its avatar colour. */
    const botColor = (id) => botById(id)?.avatar?.color || C.faint;
    const botName = (t, id) => {
      const b = botById(id);
      return b ? b.name || `@${b.handle}` : id === 'team' ? t('teamMemoryTitle') : t('removedBot');
    };
    const Seg = ({ items, value, onChange, attr }) =>
      h(
        'div',
        { role: 'tablist', style: { display: 'inline-flex', padding: 2, borderRadius: 9, background: C.layer2, gap: 2 } },
        items.map((it) =>
          h(
            'button',
            {
              key: it.id,
              type: 'button',
              role: 'tab',
              'aria-selected': value === it.id,
              [attr]: it.id,
              onClick: () => onChange(it.id),
              style: { height: 26, padding: '0 10px', border: 'none', borderRadius: 7, font: 'inherit', fontSize: SMALL, fontWeight: 600, cursor: 'pointer', color: value === it.id ? C.primary : C.muted, background: value === it.id ? C.layer1 : 'transparent', boxShadow: value === it.id ? '0 1px 2px rgba(0,0,0,.12)' : 'none' },
            },
            it.label,
          ),
        ),
      );
    function Tile({ label, value, sub, delta, attr }) {
      return h(
        'div',
        { className: 'dshb-card', 'data-dsh-bots-tile': attr, style: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 } },
        h('span', { style: { fontSize: TINY, fontWeight: 600, color: C.muted, textTransform: 'uppercase', letterSpacing: '.03em' } }, label),
        h('span', { style: { fontSize: 22, fontWeight: 700, color: C.primary, fontVariantNumeric: 'tabular-nums', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, value),
        sub ? h('span', { style: { fontSize: TINY, color: C.faint } }, sub) : null,
        delta ? h('span', { style: { fontSize: TINY, color: C.muted } }, delta) : null,
      );
    }
    /** "+12%" / "−8%" of `now` against `before`, or ''. */
    const pctDelta = (now, before) => {
      if (!(before > 0)) return '';
      const p = Math.round(((now - before) / before) * 100);
      return `${p > 0 ? '+' : p < 0 ? '−' : '±'}${Math.abs(p)}%`;
    };
    const bucketLabel = (ms, bucket) => {
      try {
        const d = new Date(ms);
        return bucket < 86_400_000 ? `${pad(d.getHours())}:00` : `${d.getMonth() + 1}/${d.getDate()}`;
      } catch {
        return '';
      }
    };
    /** A top-rounded bar: flat on the baseline, 3px round at the data end. */
    const barPath = (x, y, w, hgt, r) => {
      const rr = Math.max(0, Math.min(r, w / 2, hgt));
      return `M${x},${y + hgt}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + hgt}Z`;
    };

    /** Tokens per bucket, stacked by bot (the top seven by tokens, the rest as "other"). */
    function UsageChart({ t, data }) {
      const [hover, setHover] = useState(-1);
      const series = Array.isArray(data?.series) ? data.series : [];
      const ranked = (data?.bots ?? []).map((b) => b.bot);
      const shown = ranked.slice(0, 7);
      const keys = ranked.length > 7 ? [...shown, '__other'] : shown;
      const stackOf = (p) => keys.map((k) => (k === '__other' ? Object.entries(p.byBot ?? {}).filter(([id]) => !shown.includes(id)).reduce((s, [, v]) => s + v, 0) : (p.byBot?.[k] ?? 0)));
      const max = Math.max(1, ...series.map((p) => p.tokens));
      const W = 720;
      const H = 190;
      const L = 44;
      const B = 22;
      const T = 8;
      const innerW = W - L - 6;
      const innerH = H - B - T;
      const n = Math.max(1, series.length);
      const slot = innerW / n;
      const bw = Math.max(2, Math.min(28, slot * 0.66));
      const y = (v) => T + innerH - (v / max) * innerH;
      const ticks = [0, 0.5, 1].map((f) => max * f);
      const every = Math.max(1, Math.ceil(n / 8));
      const colorOf = (k) => (k === '__other' ? C.faint : botColor(k));
      const nameOf = (k) => (k === '__other' ? t('other') : botName(t, k));
      const hp = hover >= 0 ? series[hover] : null;
      return h(
        'div',
        { 'data-dsh-bots-usage-chart': true, style: { position: 'relative' } },
        keys.length > 1
          ? h(
              'div',
              { style: { display: 'flex', flexWrap: 'wrap', gap: '4px 14px', marginBottom: 8, fontSize: TINY, color: C.muted } },
              keys.map((k) => h('span', { key: k, style: { display: 'inline-flex', alignItems: 'center', gap: 5 } }, h('span', { style: { width: 9, height: 9, borderRadius: 3, background: colorOf(k) } }), nameOf(k))),
            )
          : null,
        h(
          'svg',
          { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img', 'aria-label': t('usageChart'), style: { display: 'block', overflow: 'visible' }, onMouseLeave: () => setHover(-1) },
          ticks.map((v, i) =>
            h(
              'g',
              { key: `t${i}` },
              h('line', { x1: L, x2: W, y1: y(v), y2: y(v), stroke: 'currentColor', strokeOpacity: i === 0 ? 0.25 : 0.1, strokeWidth: 1, style: { color: C.muted } }),
              h('text', { x: L - 6, y: y(v) + 3.5, textAnchor: 'end', fontSize: 10.5, fill: 'currentColor', style: { color: C.faint } }, fmtNum(v)),
            ),
          ),
          series.map((p, i) => {
            const cx = L + slot * i + slot / 2;
            const stack = stackOf(p);
            let acc = 0;
            const top = stack.reduce((last, v, j) => (v > 0 ? j : last), -1);
            const segs = stack.map((v, j) => {
              if (!(v > 0)) return null;
              const y0 = y(acc);
              acc += v;
              const y1 = y(acc);
              // A 2px surface gap between stacked segments.
              const hgt = Math.max(1, y0 - y1 - (j === 0 ? 0 : 2));
              return h('path', { key: j, d: j === top ? barPath(cx - bw / 2, y1, bw, hgt, 3) : `M${cx - bw / 2},${y1}h${bw}v${hgt}h${-bw}Z`, fill: colorOf(keys[j]), opacity: hover === -1 || hover === i ? 1 : 0.45 });
            });
            return h(
              'g',
              { key: p.t },
              segs,
              i % every === 0 || i === n - 1 ? h('text', { x: cx, y: H - 6, textAnchor: 'middle', fontSize: 10.5, fill: 'currentColor', style: { color: C.faint } }, bucketLabel(p.t, data.range?.bucket ?? 86_400_000)) : null,
              // The hit target is the whole column, not just the bar.
              h('rect', { x: L + slot * i, y: T, width: slot, height: innerH, fill: 'transparent', onMouseEnter: () => setHover(i), 'data-dsh-bots-usage-col': i }),
            );
          }),
        ),
        hp
          ? h(
              'div',
              {
                'data-dsh-bots-usage-tip': true,
                style: { position: 'absolute', top: 0, left: `${Math.min(78, Math.max(2, ((L + slot * hover + slot / 2) / W) * 100))}%`, transform: 'translateX(-50%)', pointerEvents: 'none', padding: '8px 10px', borderRadius: 10, background: C.layer1, border: `1px solid ${C.border}`, boxShadow: '0 6px 20px rgba(0,0,0,.18)', fontSize: TINY, minWidth: 140, zIndex: 2 },
              },
              h('div', { style: { fontWeight: 700, color: C.primary, marginBottom: 4 } }, `${bucketLabel(hp.t, data.range?.bucket ?? 86_400_000)} · ${fmtNum(hp.tokens)}`),
              keys
                .map((k, j) => [k, stackOf(hp)[j]])
                .filter(([, v]) => v > 0)
                .map(([k, v]) => h('div', { key: k, style: { display: 'flex', alignItems: 'center', gap: 6, color: C.muted } }, h('span', { style: { width: 8, height: 8, borderRadius: 2, background: colorOf(k) } }), h('span', { style: { flex: 1 } }, nameOf(k)), h('span', { style: { color: C.primary, fontVariantNumeric: 'tabular-nums' } }, fmtNum(v)))),
              fmtCost(hp.cost) !== '—' ? h('div', { style: { marginTop: 4, color: C.faint } }, fmtCost(hp.cost)) : null,
            )
          : null,
      );
    }
    const th = (label, right) => h('th', { style: { textAlign: right ? 'right' : 'left', fontWeight: 600, fontSize: TINY, color: C.muted, padding: '6px 8px', borderBottom: `1px solid ${C.border1}` } }, label);
    const td = (content, right, extra = {}) => h('td', { style: { textAlign: right ? 'right' : 'left', padding: '7px 8px', borderBottom: `1px solid ${C.border1}`, fontVariantNumeric: 'tabular-nums', verticalAlign: 'middle', ...extra } }, content);
    const Table = ({ head, rows, attr }) => h('table', { [attr]: true, style: { width: '100%', borderCollapse: 'collapse', fontSize: SMALL } }, h('thead', null, h('tr', null, head)), h('tbody', null, rows));
    function BotCell({ t, id }) {
      const b = botById(id);
      return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 7, minWidth: 0 } }, b ? h(Avatar, { avatar: b.avatar, name: b.name || b.handle, size: 20 }) : h('span', { style: { width: 20, height: 20, borderRadius: '50%', background: C.layer2 } }), h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, botName(t, id)));
    }
    function triggerText(t, task) {
      if (task.trigger === 'schedule') return t('trigger_schedule');
      if (task.trigger === 'chat') return t('trigger_chat', { app: channelName(task.via, t) });
      if (task.trigger === 'dm') return task.from === 'user' ? t('trigger_user') : t('trigger_dm', { handle: botById(task.from)?.handle ?? '?' });
      return t('trigger_user');
    }

    /** The usage report's rows by task (ticket), read loosely: `{id, title, bot, stage?, runs, tokens, cost}`. */
    function usageTickets(data) {
      const rows = Array.isArray(data?.tickets) ? data.tickets : Array.isArray(data?.byTicket) ? data.byTicket : [];
      return rows
        .map((r) => (r && typeof r === 'object' ? { ...r, id: str(r.id ?? r.ticket), bot: r.bot ?? r.botId } : null))
        .filter((r) => r && r.id);
    }
    /** The task a run belongs to, when the report says. */
    const runTicket = (r) => {
      const v = r?.ticket ?? r?.t;
      return typeof v === 'string' && v ? v : '';
    };
    function UsageView({ t, bots }) {
      const [range, setRange] = useState('7d');
      const [bot, setBot] = useState('');
      const [prices, setPrices] = useState(false);
      const { data, failed, reload } = useJson(`usage?range=${range}&tz=${tzNow()}${bot ? `&bot=${encodeURIComponent(bot)}` : ''}`, 30_000);
      const tot = data?.totals;
      const prev = data?.prev;
      const empty = tot && tot.calls === 0;
      const tickets = usageTickets(data);
      const section = (title, body, right) => h('section', { className: 'dshb-card', style: { display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 } }, h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } }, h('span', { style: { fontWeight: 700, fontSize: SMALL } }, title), h('span', { style: { flex: 1 } }), right ?? null), body);
      return h(
        'div',
        { 'data-dsh-bots-usage': true, style: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 } },
        h(
          'header',
          { style: { padding: '18px 24px 14px', borderBottom: `1px solid ${C.border1}`, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' } },
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 200 } }, h('span', { style: { fontWeight: 700, fontSize: 19 } }, t('usage')), h('span', { style: { fontSize: SMALL, color: C.muted } }, t('usageSub'))),
          h(Seg, { attr: 'data-dsh-bots-range', value: range, onChange: setRange, items: ['today', '7d', '30d', '90d', 'all'].map((id) => ({ id, label: t(`range_${id}`) })) }),
          h('select', { className: 'dshb-input', 'data-dsh-bots-usage-bot': true, value: bot, onChange: (e) => setBot(e.target.value), style: { width: 160, height: 30, fontSize: SMALL } }, h('option', { value: '' }, t('allBots')), bots.map((b) => h('option', { key: b.id, value: b.id }, b.name || `@${b.handle}`))),
          h(Btn, { size: 'sm', icon: Icon.edit(12), onClick: () => setPrices(true), 'data-dsh-bots-prices': true }, t('prices')),
        ),
        h(
          'div',
          { className: 'dshb-scroll', style: { flex: 1, padding: '18px 24px 28px' } },
          !data
            ? h('div', { style: { padding: 24, color: C.faint, fontSize: SMALL, textAlign: 'center' } }, failed ? t('unavailable') : t('loading'))
            : h(
                'div',
                { style: { maxWidth: 1080, display: 'flex', flexDirection: 'column', gap: 16 } },
                h(
                  'div',
                  { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 } },
                  h(Tile, { attr: 'tokens', label: t('tileTokens'), value: fmtNum(tot.tokens), sub: t('tileCacheRate', { pct: Math.round((tot.cacheRate ?? 0) * 100) }), delta: pctDelta(tot.tokens, prev?.tokens) ? t('vsPrev', { delta: pctDelta(tot.tokens, prev.tokens) }) : '' }),
                  h(Tile, { attr: 'cost', label: t('tileCost'), value: fmtCost(tot.cost), sub: tot.unpriced > 0 ? t('tileUnpriced', { tokens: fmtNum(tot.unpriced) }) : '' }),
                  h(Tile, { attr: 'runs', label: t('tileRuns'), value: String(tot.tasks ?? 0), delta: pctDelta(tot.tasks, prev?.tasks) ? t('vsPrev', { delta: pctDelta(tot.tasks, prev.tasks) }) : '' }),
                  h(Tile, { attr: 'calls', label: t('tileCalls'), value: String(tot.calls ?? 0), sub: t('tileInOut', { input: fmtNum(tot.input + tot.cacheRead + tot.cacheWrite), output: fmtNum(tot.output) }) }),
                ),
                empty ? h('div', { className: 'dshb-card', style: { color: C.faint, fontSize: SMALL, textAlign: 'center', padding: 24 } }, t('noUsage')) : section(t('usageChart'), h(UsageChart, { t, data })),
                empty
                  ? null
                  : h(
                      'div',
                      { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 16 } },
                      section(
                        t('byBot'),
                        h(Table, {
                          attr: 'data-dsh-bots-usage-bots',
                          head: [th(t('colBot')), th(t('colRunCount'), true), th(t('colTokens'), true), th(t('colCost'), true)],
                          rows: data.bots.map((r) => h('tr', { key: r.bot, onClick: () => setBot(bot === r.bot ? '' : r.bot), style: { cursor: 'pointer' } }, td(h(BotCell, { t, id: r.bot })), td(String(r.tasks), true), td(fmtNum(r.tokens), true), td(fmtCost(r.cost), true))),
                        }),
                      ),
                      section(
                        t('byModel'),
                        h(Table, {
                          attr: 'data-dsh-bots-usage-models',
                          head: [th(t('colModel')), th(t('colCalls'), true), th(t('colTokens'), true), th(t('colCost'), true)],
                          rows: data.models.map((r) =>
                            h(
                              'tr',
                              { key: `${r.provider}/${r.model}` },
                              td(h('span', { style: { display: 'flex', flexDirection: 'column', minWidth: 0 } }, h('span', { className: 'dshb-mono', style: { fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 220 } }, r.model), h('span', { style: { fontSize: TINY, color: C.faint } }, r.provider))),
                              td(String(r.calls), true),
                              td(fmtNum(r.tokens), true),
                              td(r.priced ? fmtCost(r.cost) : h('button', { type: 'button', className: 'dshb-link', style: { fontSize: TINY }, onClick: () => setPrices(r.model) }, t('setPrice')), true),
                            ),
                          ),
                        }),
                      ),
                      section(
                        t('byKind'),
                        h(Table, {
                          attr: 'data-dsh-bots-usage-kinds',
                          head: [th(''), th(t('colCalls'), true), th(t('colTokens'), true), th(t('colCost'), true)],
                          rows: data.kinds.map((r) => h('tr', { key: r.kind }, td(t(`work_${r.kind}`)), td(String(r.calls), true), td(fmtNum(r.tokens), true), td(fmtCost(r.cost), true))),
                        }),
                      ),
                      tickets.length
                        ? section(
                            t('byTask'),
                            h(Table, {
                              attr: 'data-dsh-bots-usage-tickets',
                              head: [th(t('colTask')), th(t('colRunCount'), true), th(t('colTokens'), true), th(t('colCost'), true)],
                              rows: tickets.map((r) =>
                                h(
                                  'tr',
                                  { key: r.id, 'data-dsh-bots-usage-ticket': r.id, onClick: () => openTicket(r.id), style: { cursor: 'pointer' } },
                                  td(
                                    h(
                                      'span',
                                      { style: { display: 'flex', flexDirection: 'column', minWidth: 0, maxWidth: 260 } },
                                      h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 } }, h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: taskTitle(t, r) }, taskTitle(t, r)), h(StageChip, { t, stage: r.stage })),
                                      h('span', { style: { fontSize: TINY, color: C.faint } }, botName(t, r.bot)),
                                    ),
                                  ),
                                  td(String(r.runs ?? 0), true),
                                  td(fmtNum(r.tokens), true),
                                  td(fmtCost(r.cost), true),
                                ),
                              ),
                            }),
                          )
                        : null,
                      data.schedules.length
                        ? section(
                            t('bySchedule'),
                            h(Table, {
                              attr: 'data-dsh-bots-usage-schedules',
                              head: [th(t('colTask')), th(t('colRuns'), true), th(t('colTokens'), true), th(t('colCost'), true)],
                              rows: data.schedules.map((r) => h('tr', { key: r.id }, td(h('span', { style: { display: 'flex', flexDirection: 'column' } }, h('span', null, r.title), h('span', { style: { fontSize: TINY, color: C.faint } }, botName(t, r.bot)))), td(String(r.runs), true), td(fmtNum(r.tokens), true), td(fmtCost(r.cost), true))),
                            }),
                          )
                        : null,
                    ),
                empty || data.tasks.length === 0
                  ? null
                  : section(
                      t('recentRuns'),
                      h(Table, {
                        attr: 'data-dsh-bots-usage-tasks',
                        head: [th(t('colRun')), th(t('colBot')), th(t('colWhen')), th(t('colTokens'), true), th(t('colCost'), true)],
                        rows: data.tasks.map((r) =>
                          h(
                            'tr',
                            { key: r.id, 'data-dsh-bots-usage-task': r.id },
                            td(
                              h(
                                'span',
                                { style: { display: 'flex', flexDirection: 'column', minWidth: 0, maxWidth: 380 } },
                                h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: r.title }, r.title),
                                h(
                                  'span',
                                  { style: { fontSize: TINY, color: C.faint, display: 'inline-flex', gap: 6, alignItems: 'center' } },
                                  triggerText(t, r),
                                  r.status === 'running' ? h(Badge, { color: C.ok }, t('taskRunning')) : r.status === 'error' || r.status === 'stopped' ? h(Badge, { color: C.error }, t(`taskState_${r.status}`)) : null,
                                  runTicket(r) ? h('button', { type: 'button', className: 'dshb-link', 'data-dsh-bots-usage-run-task': runTicket(r), onClick: () => openTicket(runTicket(r)), style: { fontSize: TINY } }, t('openTask')) : null,
                                ),
                              ),
                            ),
                            td(h(BotCell, { t, id: r.bot })),
                            td(h('span', { style: { color: C.muted, fontSize: TINY, whiteSpace: 'nowrap' } }, fmtDate(r.end ?? r.start))),
                            td(fmtNum(r.tokens), true),
                            td(fmtCost(r.cost), true),
                          ),
                        ),
                      }),
                    ),
              ),
        ),
        prices ? h(PricesModal, { t, focus: typeof prices === 'string' ? prices : '', onClose: () => (setPrices(false), void reload()) }) : null,
      );
    }

    function PricesModal({ t, focus, onClose }) {
      const { data, reload } = useJson('prices');
      const [edit, setEdit] = useState(focus ? { model: focus, input: '', cacheRead: '', output: '', currency: 'USD' } : null);
      const [busy, setBusy] = useState(false);
      const [note, setNote] = useState('');
      const save = (price) => {
        setBusy(true);
        postJson('prices', { model: edit?.model ?? price?.model, price: price === null ? null : { input: Number(edit.input), output: Number(edit.output), ...(edit.cacheRead !== '' ? { cacheRead: Number(edit.cacheRead) } : {}), currency: edit.currency } })
          .then((r) => {
            if (r?.ok) {
              setEdit(null);
              setNote(t('priceSaved'));
              void reload();
            } else setNote(r?.reason || t('saveFailed'));
          })
          .finally(() => setBusy(false));
      };
      const valid = edit && edit.input !== '' && edit.output !== '' && Number(edit.input) >= 0 && Number(edit.output) >= 0;
      const list = data?.list;
      return h(
        Modal,
        { title: t('pricesTitle'), onClose, width: 640, closeLabel: t('close') },
        h('div', { style: { fontSize: SMALL, color: C.muted, lineHeight: 1.6 } }, t('pricesHint', { count: list?.count ?? 0, when: list?.fetchedAt ? fmtDate(list.fetchedAt) : '—' })),
        note ? h('div', { style: { fontSize: SMALL, color: C.ok } }, note) : null,
        !data
          ? h('div', { style: { color: C.faint, fontSize: SMALL } }, t('loading'))
          : data.models.length === 0
            ? h('div', { style: { color: C.faint, fontSize: SMALL } }, t('noUsage'))
            : h(Table, {
                attr: 'data-dsh-bots-price-table',
                head: [th(t('colModel')), th(t('priceInput'), true), th(t('priceOutput'), true), th('')],
                rows: data.models.map((m) =>
                  h(
                    'tr',
                    { key: m.model },
                    td(h('span', { style: { display: 'flex', flexDirection: 'column' } }, h('span', { className: 'dshb-mono', style: { fontSize: 12 } }, m.model), h('span', { style: { fontSize: TINY, color: C.faint } }, m.price ? `${m.price.source === 'user' ? t('priceSource_user') : 'LiteLLM'}${m.price.approximate ? ' ≈' : ''}` : t('priceNone')))),
                    td(m.price ? fmtMoney(m.price.input, m.price.currency) : '—', true),
                    td(m.price ? fmtMoney(m.price.output, m.price.currency) : '—', true),
                    td(
                      h(
                        'span',
                        { style: { display: 'inline-flex', gap: 8 } },
                        h('button', { type: 'button', className: 'dshb-link', style: { fontSize: TINY }, onClick: () => setEdit({ model: m.model, input: String(m.price?.input ?? ''), cacheRead: m.price?.cacheRead !== undefined ? String(m.price.cacheRead) : '', output: String(m.price?.output ?? ''), currency: m.price?.currency ?? 'USD' }) }, t('setPrice')),
                        m.price?.source === 'user' ? h('button', { type: 'button', className: 'dshb-link', style: { fontSize: TINY, color: C.muted }, onClick: () => (setEdit({ model: m.model }), save(null)) }, t('usePriceList')) : null,
                      ),
                      true,
                    ),
                  ),
                ),
              }),
        edit && edit.input !== undefined
          ? h(
              'div',
              { className: 'dshb-card', 'data-dsh-bots-price-form': edit.model, style: { display: 'flex', flexDirection: 'column', gap: 10 } },
              h('span', { className: 'dshb-mono', style: { fontWeight: 600 } }, edit.model),
              h(
                'div',
                { style: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 } },
                h(Field, { label: t('priceInput') }, h(Input, { type: 'number', min: 0, step: 'any', value: edit.input, onChange: (e) => setEdit({ ...edit, input: e.target.value }) })),
                h(Field, { label: t('priceCached') }, h(Input, { type: 'number', min: 0, step: 'any', value: edit.cacheRead, placeholder: edit.input, onChange: (e) => setEdit({ ...edit, cacheRead: e.target.value }) })),
                h(Field, { label: t('priceOutput') }, h(Input, { type: 'number', min: 0, step: 'any', value: edit.output, onChange: (e) => setEdit({ ...edit, output: e.target.value }) })),
                h(Field, { label: t('priceCurrency') }, h('select', { className: 'dshb-input', value: edit.currency, onChange: (e) => setEdit({ ...edit, currency: e.target.value }) }, h('option', { value: 'USD' }, 'USD $'), h('option', { value: 'CNY' }, 'CNY ¥'))),
              ),
              h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8 } }, h(Btn, { kind: 'ghost', onClick: () => setEdit(null) }, t('cancel')), h(Btn, { kind: 'primary', disabled: !valid || busy, onClick: () => save() }, t('save'))),
            )
          : null,
        h('div', null, h(Btn, { size: 'sm', kind: 'ghost', icon: Icon.refresh(12), onClick: () => postJson('prices/refresh', {}).then(() => reload()) }, t('refreshPriceList'))),
      );
    }

    const NOTE_KINDS = ['fact', 'preference', 'person', 'project', 'procedure', 'lesson'];
    /** A list of memory notes the user can add to, edit, pin and delete. */
    function NotesEditor({ t, scope, notes, reload, toast }) {
      const [text, setText] = useState('');
      const [kind, setKind] = useState('fact');
      const [q, setQ] = useState('');
      const [editing, setEditing] = useState(null);
      const put = (note, ok) =>
        postJson('memory/put', { scope, note }).then((r) => {
          if (r?.ok) {
            if (ok) toast(ok);
            setEditing(null);
            void reload();
            void refreshState();
          } else toast(r?.reason || t('saveFailed'), 'error');
          return r;
        });
      const add = () => {
        if (!text.trim()) return;
        void put({ text: text.trim(), kind }, t('noteSaved')).then((r) => r?.ok && setText(''));
      };
      const remove = (id) =>
        postJson('memory/delete', { scope, id }).then((r) => {
          if (r?.ok) {
            void reload();
            void refreshState();
          } else toast(r?.reason || t('actionFailed'), 'error');
        });
      const needle = q.trim().toLowerCase();
      const list = (notes ?? [])
        .filter((n) => !needle || n.text.toLowerCase().includes(needle))
        .slice()
        .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updated - a.updated);
      return h(
        'div',
        { 'data-dsh-bots-notes': scope, style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        h(
          'div',
          { style: { display: 'flex', gap: 8 } },
          h(Input, { value: text, placeholder: t('addNote'), maxLength: 400, 'data-dsh-bots-note-input': true, onChange: (e) => setText(e.target.value), onKeyDown: (e) => e.key === 'Enter' && !e.isComposing && add(), style: { flex: 1 } }),
          h('select', { className: 'dshb-input', value: kind, onChange: (e) => setKind(e.target.value), style: { width: 110 } }, NOTE_KINDS.map((k) => h('option', { key: k, value: k }, t(`note_${k}`)))),
          h(Btn, { kind: 'primary', icon: Icon.plus(13), disabled: !text.trim(), onClick: add, 'data-dsh-bots-note-add': true }, t('add')),
        ),
        (notes ?? []).length > 8 ? h(Input, { value: q, placeholder: t('filterNotes'), onChange: (e) => setQ(e.target.value), style: { height: 30, fontSize: SMALL, maxWidth: 280 } }) : null,
        list.length === 0
          ? h('div', { style: { fontSize: SMALL, color: C.faint, padding: '6px 2px' } }, t('noNotes'))
          : h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', border: `1px solid ${C.border1}`, borderRadius: 12, overflow: 'hidden', background: C.layer1 } },
              list.map((n, i) =>
                h(
                  'div',
                  { key: n.id, 'data-dsh-bots-note': n.id, style: { display: 'flex', alignItems: 'flex-start', gap: 10, padding: '9px 12px', borderTop: i ? `1px solid ${C.border1}` : 'none', background: n.pinned ? tint(C.label, 5) : 'transparent' } },
                  h(Badge, { color: C.muted }, t(`note_${n.kind}`)),
                  editing?.id === n.id
                    ? h(
                        'div',
                        { style: { flex: 1, display: 'flex', gap: 6 } },
                        h(Input, { value: editing.text, maxLength: 400, onChange: (e) => setEditing({ ...editing, text: e.target.value }), onKeyDown: (e) => e.key === 'Enter' && !e.isComposing && put({ id: n.id, text: editing.text }), style: { flex: 1, height: 28 } }),
                        h(Btn, { size: 'sm', kind: 'primary', onClick: () => put({ id: n.id, text: editing.text }) }, t('save')),
                        h(Btn, { size: 'sm', kind: 'ghost', onClick: () => setEditing(null) }, t('cancel')),
                      )
                    : h(
                        'div',
                        { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 } },
                        h('span', { style: { fontSize: SMALL, color: C.primary, lineHeight: 1.5, wordBreak: 'break-word', cursor: 'text' }, onClick: () => setEditing({ id: n.id, text: n.text }) }, n.text),
                        h('span', { style: { fontSize: TINY, color: C.faint } }, `${t(`src_${n.source}`)} · ${fmtAgo(t, n.updated)}`),
                      ),
                  h('button', { type: 'button', className: 'dshb-link', title: n.pinned ? t('unpin') : t('pin'), 'data-dsh-bots-note-pin': n.id, onClick: () => put({ id: n.id, pinned: !n.pinned }), style: { color: n.pinned ? '#d99a00' : C.faint, display: 'inline-flex', paddingTop: 2 } }, Icon.star(13)),
                  h('button', { type: 'button', className: 'dshb-link', title: t('delete'), 'data-dsh-bots-note-delete': n.id, onClick: () => remove(n.id), style: { color: C.faint, display: 'inline-flex', paddingTop: 2 } }, Icon.trash(13)),
                ),
              ),
            ),
      );
    }
    function JournalList({ t, items, showBot }) {
      if (!items?.length) return h('div', { style: { fontSize: SMALL, color: C.faint } }, t('noJournal'));
      return h(
        'div',
        { 'data-dsh-bots-journal': true, style: { display: 'flex', flexDirection: 'column', gap: 2 } },
        items.slice(0, 60).map((j) =>
          h(
            'div',
            { key: j.id, style: { display: 'flex', gap: 10, alignItems: 'flex-start', padding: '6px 2px', fontSize: SMALL } },
            h('span', { style: { color: C.faint, fontSize: TINY, width: 132, flex: 'none', paddingTop: 2, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' } }, fmtDate(j.at)),
            showBot ? h('span', { style: { flex: 'none', width: 130 } }, h(BotCell, { t, id: j.bot })) : null,
            h('span', { style: { flex: 1, color: C.primary, lineHeight: 1.5, wordBreak: 'break-word' } }, j.summary || j.title),
          ),
        ),
      );
    }
    const memModelText = (t, m) => (m ? `${m.provider} · ${m.model}` : t('botsOwnModel'));

    function MemoryTab({ t, bot, toast, onSettings }) {
      const { data, reload } = useJson(`memory?bot=${encodeURIComponent(bot.id)}`, 15_000);
      const [busy, setBusy] = useState(false);
      const name = bot.name || `@${bot.handle}`;
      const topic = data?.topic;
      const startTopic = () => {
        setBusy(true);
        postJson('topic/new', { id: bot.id })
          .then((r) => {
            if (r?.ok) {
              toast(t('newTopicDone', { name }));
              void reload();
              void refreshState();
            } else toast(r?.reason || t('actionFailed'), 'error');
          })
          .finally(() => setBusy(false));
      };
      return h(
        'div',
        { className: 'dshb-scroll', 'data-dsh-bots-memory': bot.id, style: { flex: 1, padding: '20px 24px 28px' } },
        h(
          'div',
          { style: { maxWidth: 820, display: 'flex', flexDirection: 'column', gap: 26 } },
          h(
            Section,
            { title: t('memoryOf', { name }), hint: t('memoryHint', { name }), right: h('button', { type: 'button', className: 'dshb-link', style: { fontSize: TINY, whiteSpace: 'nowrap' }, onClick: onSettings }, t('memoryModelIs', { model: memModelText(t, data?.settings?.model) })) },
            data ? h(NotesEditor, { t, scope: bot.id, notes: data.notes, reload, toast }) : h('div', { style: { fontSize: SMALL, color: C.faint } }, t('loading')),
          ),
          h(Section, { title: t('recentWork'), hint: t('recentWorkHint') }, data ? h(JournalList, { t, items: data.journal }) : null),
          h(
            Section,
            { title: t('topicsTitle'), hint: t('topicsHint'), right: h(Btn, { size: 'sm', icon: Icon.plus(12), disabled: busy || bot.status === 'running', onClick: startTopic, 'data-dsh-bots-new-topic': 'memory' }, t('newTopic')) },
            topic ? h('div', { className: 'dshb-card', style: { fontSize: SMALL } }, t('topicNow', { when: fmtAgo(t, topic.startedAt), n: topic.tasks, ctx: fmtNum(topic.lastPrompt) })) : null,
            ...(data?.topics ?? []).map((p) =>
              h(
                'div',
                { key: p.sessionId, 'data-dsh-bots-past-topic': p.sessionId, style: { display: 'flex', alignItems: 'center', gap: 10, padding: '4px 2px', fontSize: SMALL } },
                h('span', { style: { color: C.muted, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' } }, t('pastTopic', { from: fmtDate(p.startedAt), to: fmtDate(p.endedAt), n: p.tasks })),
                h(Badge, { color: C.muted }, t(`topicReason_${p.reason}`)),
                h('span', { style: { flex: 1, minWidth: 0, color: C.faint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, (p.titles ?? []).join(' · ')),
              ),
            ),
          ),
        ),
      );
    }

    function TeamMemoryView({ t, toast, onSettings }) {
      const { data, reload } = useJson('memory?bot=team', 20_000);
      const [busy, setBusy] = useState(false);
      const dream = () => {
        setBusy(true);
        postJson('memory/dream', {})
          .then((r) => {
            if (r?.ok) {
              const errs = r.result?.errors ?? [];
              toast(errs.length ? t('dreamPartly', { reason: errs[0].reason }) : t('dreamDone', { bots: (r.result?.bots ?? []).length, digest: r.result?.digest ? t('dreamDigest') : '' }), errs.length ? 'error' : 'ok');
              void reload();
              void refreshState();
            } else toast(r?.reason || t('actionFailed'), 'error');
          })
          .finally(() => setBusy(false));
      };
      const st = data?.settings;
      const last = data?.dream?.lastAt;
      return h(
        'div',
        { 'data-dsh-bots-team-memory': true, style: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 } },
        h(
          'header',
          { style: { padding: '18px 24px 14px', borderBottom: `1px solid ${C.border1}`, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' } },
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 220 } },
            h('span', { style: { fontWeight: 700, fontSize: 19 } }, t('teamMemoryTitle')),
            h('span', { style: { fontSize: SMALL, color: C.muted } }, !st ? '' : !st.dream ? t('dreamOff') : last ? `${t('lastDream', { when: fmtAgo(t, last) })} · ${t('dreamDaily', { time: st.dreamTime })}` : t('neverDreamed', { time: st.dreamTime })),
          ),
          h(Btn, { kind: 'ghost', size: 'sm', icon: Icon.edit(12), onClick: onSettings }, t('settings')),
          h(Btn, { kind: 'primary', size: 'sm', icon: busy ? h('span', { className: 'dshb-spinner' }) : Icon.sparkle(13), disabled: busy, onClick: dream, 'data-dsh-bots-dream': true }, busy ? t('dreaming') : t('dreamNow')),
        ),
        h(
          'div',
          { className: 'dshb-scroll', style: { flex: 1, padding: '20px 24px 28px' } },
          h(
            'div',
            { style: { maxWidth: 860, display: 'flex', flexDirection: 'column', gap: 26 } },
            h(Section, { title: t('teamNotes'), hint: t('teamNotesHint') }, data ? h(NotesEditor, { t, scope: 'team', notes: data.notes, reload, toast }) : h('div', { style: { fontSize: SMALL, color: C.faint } }, t('loading'))),
            h(
              Section,
              { title: t('digests'), hint: t('digestsHint') },
              !data?.digests?.length
                ? h('div', { style: { fontSize: SMALL, color: C.faint } }, t('noDigests'))
                : data.digests.slice(0, 14).map((d) => h('div', { key: d.date, className: 'dshb-card', 'data-dsh-bots-digest': d.date, style: { display: 'flex', flexDirection: 'column', gap: 6 } }, h('span', { style: { fontSize: TINY, fontWeight: 700, color: C.muted } }, d.date), h(Clamp, { t, text: d.text, lines: 10, style: { fontSize: SMALL } }))),
            ),
            h(Section, { title: t('teamJournal'), hint: t('recentWorkHint') }, data ? h(JournalList, { t, items: data.journal, showBot: true }) : null),
          ),
        ),
      );
    }

    /** Task limits the Host uses when its settings do not say (lib/tickets.mjs, lib/watchdog.mjs). */
    const TICKET_DEFAULTS = { maxWorking: 4, stallMinutes: 20, archiveHours: 24 };
    const numberOr = (v, d, min) => {
      const n = Number(v);
      return str(v).trim() !== '' && Number.isFinite(n) ? Math.max(min, n) : d;
    };
    function SettingsModal({ t, catalog, onClose, toast }) {
      const [form, setForm] = useState(null);
      const [busy, setBusy] = useState(false);
      useEffect(() => {
        void getJson('settings').then((r) => r?.settings && setForm({ ...r.settings, tickets: { ...TICKET_DEFAULTS, ...(r.settings.tickets ?? {}) } }));
      }, []);
      const set = (part, patch) => setForm((f) => ({ ...f, [part]: { ...f[part], ...patch } }));
      const models = Array.isArray(catalog?.models) ? catalog.models : [];
      const save = () => {
        setBusy(true);
        const tk = form.tickets;
        const tickets = { maxWorking: Math.round(numberOr(tk.maxWorking, TICKET_DEFAULTS.maxWorking, 1)), stallMinutes: numberOr(tk.stallMinutes, TICKET_DEFAULTS.stallMinutes, 1), archiveHours: numberOr(tk.archiveHours, TICKET_DEFAULTS.archiveHours, 0) };
        postJson('settings', { patch: { tickets, topics: { idleHours: Number(form.topics.idleHours) || 0, maxContextK: Number(form.topics.maxContextK) || 0 }, memory: form.memory } })
          .then((r) => {
            if (r?.ok) {
              tookSettings(r.settings);
              toast(t('settingsSaved'));
              onClose();
            } else toast(r?.reason || t('saveFailed'), 'error');
          })
          .finally(() => setBusy(false));
      };
      const row = (label, hint, control) => h('div', { style: { display: 'flex', alignItems: 'center', gap: 14 } }, h('div', { style: { flex: 1, minWidth: 0 } }, h('div', { style: { fontWeight: 600, fontSize: SMALL } }, label), hint ? h('div', { style: { fontSize: TINY, color: C.faint, lineHeight: 1.5, marginTop: 2 } }, hint) : null), control);
      return h(
        Modal,
        {
          title: t('settingsTitle'),
          onClose,
          width: 560,
          closeLabel: t('close'),
          footer: [h(Btn, { key: 'c', kind: 'ghost', onClick: onClose }, t('cancel')), h(Btn, { key: 's', kind: 'primary', disabled: !form || busy, onClick: save, 'data-dsh-bots-settings-save': true }, t('save'))],
        },
        !form
          ? h('div', { style: { color: C.faint, fontSize: SMALL } }, t('loading'))
          : [
              h(
                Section,
                { key: 'tasks', title: t('setTasks') },
                row(t('setMaxWorking'), t('setMaxWorkingHint'), h(Input, { type: 'number', min: 1, max: 32, value: form.tickets.maxWorking, onChange: (e) => set('tickets', { maxWorking: e.target.value }), 'data-dsh-bots-setting': 'maxWorking', style: { width: 90 } })),
                row(t('setStall'), t('setStallHint'), h(Input, { type: 'number', min: 1, max: 1440, value: form.tickets.stallMinutes, onChange: (e) => set('tickets', { stallMinutes: e.target.value }), 'data-dsh-bots-setting': 'stallMinutes', style: { width: 90 } })),
                row(t('setArchive'), t('setArchiveHint'), h(Input, { type: 'number', min: 0, max: 720, value: form.tickets.archiveHours, onChange: (e) => set('tickets', { archiveHours: e.target.value }), 'data-dsh-bots-setting': 'archiveHours', style: { width: 90 } })),
              ),
              h(
                Section,
                { key: 'topics', title: t('setTopics') },
                row(t('setIdle'), t('setIdleHint'), h(Input, { type: 'number', min: 0, max: 720, value: form.topics.idleHours, onChange: (e) => set('topics', { idleHours: e.target.value }), 'data-dsh-bots-setting': 'idleHours', style: { width: 90 } })),
                row(t('setContext'), t('setContextHint'), h(Input, { type: 'number', min: 0, max: 4096, value: form.topics.maxContextK, onChange: (e) => set('topics', { maxContextK: e.target.value }), 'data-dsh-bots-setting': 'maxContextK', style: { width: 90 } })),
              ),
              h(
                Section,
                { key: 'memory', title: t('setMemory') },
                row(t('setAuto'), t('setAutoHint'), h(Switch, { on: form.memory.auto, onChange: (v) => set('memory', { auto: v }), title: t('setAuto'), 'data-dsh-bots-setting': 'auto' })),
                row(
                  t('setMemoryModel'),
                  t('setMemoryModelHint'),
                  h(
                    'select',
                    {
                      className: 'dshb-input',
                      value: modelKey(form.memory.model),
                      style: { width: 230 },
                      'data-dsh-bots-setting': 'memoryModel',
                      onChange: (e) => {
                        const v = e.target.value;
                        if (!v) return set('memory', { model: null });
                        const [provider, ...rest] = v.split('::');
                        set('memory', { model: { provider, model: rest.join('::') } });
                      },
                    },
                    h('option', { value: '' }, t('botsOwnModel')),
                    form.memory.model && !models.some((m) => modelKey(m) === modelKey(form.memory.model)) ? h('option', { value: modelKey(form.memory.model) }, `${form.memory.model.provider} · ${form.memory.model.model}`) : null,
                    modelGroups(models).map((g) => h('optgroup', { key: g.name, label: g.name }, g.models.map((m) => h('option', { key: modelKey(m), value: modelKey(m) }, m.name || m.model)))),
                  ),
                ),
                row(t('setDream'), t('setDreamHint'), h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } }, h(Input, { type: 'time', value: form.memory.dreamTime, disabled: !form.memory.dream, onChange: (e) => set('memory', { dreamTime: e.target.value }), style: { width: 136 } }), h(Switch, { on: form.memory.dream, onChange: (v) => set('memory', { dream: v }), title: t('setDream'), 'data-dsh-bots-setting': 'dream' }))),
              ),
            ],
      );
    }

    /** Catalog models by provider, in catalog order. */
    function modelGroups(models) {
      const groups = [];
      for (const m of models) {
        const name = m.group || m.provider;
        let g = groups.find((x) => x.name === name);
        if (!g) groups.push((g = { name, source: m.source ?? '', models: [] }));
        g.models.push(m);
      }
      return groups;
    }

    function EndpointForm({ t, value, apis, onCancel, onSaved, toast }) {
      const editing = Boolean(value?.route);
      const [f, setF] = useState(() => ({ name: value?.name ?? '', api: value?.api ?? 'openai-completions', baseURL: value?.baseURL ?? '', key: '', models: (value?.models ?? []).map((m) => m.id).join('\n') }));
      const [found, setFound] = useState(null);
      const [busy, setBusy] = useState('');
      const set = (p) => setF((x) => ({ ...x, ...p }));
      const ids = [...new Set(f.models.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean))];
      const fetchModels = () => {
        setBusy('fetch');
        postJson('models/custom/test', { api: f.api, baseURL: f.baseURL, key: f.key, ...(editing ? { route: value.route } : {}) })
          .then((r) => {
            if (r?.ok) {
              setFound(r.models);
              toast(t('fetchedN', { n: r.models.length }));
            } else toast(r?.reason || t('actionFailed'), 'error');
          })
          .finally(() => setBusy(''));
      };
      const toggle = (id, on) => set({ models: (on ? [...ids, id] : ids.filter((x) => x !== id)).join('\n') });
      const save = () => {
        setBusy('save');
        postJson('models/custom/save', { ...(editing ? { route: value.route } : {}), name: f.name, api: f.api, baseURL: f.baseURL, key: f.key, models: ids })
          .then((r) => {
            if (r?.ok) {
              toast(t('epSaved'));
              onSaved();
            } else toast(r?.reason || t('saveFailed'), 'error');
          })
          .finally(() => setBusy(''));
      };
      const valid = f.name.trim() && /^https?:\/\/\S+/.test(f.baseURL.trim()) && ids.length > 0 && (editing || f.key.trim());
      return h(
        'div',
        { className: 'dshb-card', 'data-dsh-bots-endpoint-form': value?.route ?? 'new', style: { display: 'flex', flexDirection: 'column', gap: 12 } },
        h('div', { style: { fontWeight: 700, fontSize: SMALL } }, editing ? t('editEndpoint') : t('addEndpoint')),
        h(
          'div',
          { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 } },
          h(Field, { label: t('epName'), hint: editing ? value.route : '' }, h(Input, { value: f.name, disabled: editing, maxLength: 40, placeholder: 'My gateway', onChange: (e) => set({ name: e.target.value }), 'data-dsh-bots-ep': 'name' })),
          h(Field, { label: t('epApi') }, h('select', { className: 'dshb-input', value: f.api, onChange: (e) => set({ api: e.target.value }), 'data-dsh-bots-ep': 'api' }, (apis ?? Object.keys(API_LABELS)).map((a) => h('option', { key: a, value: a }, API_LABELS[a] ?? a)))),
          h(Field, { label: t('epBase'), style: { gridColumn: '1 / -1' } }, h(Input, { value: f.baseURL, mono: true, placeholder: f.api === 'anthropic-messages' ? 'https://api.anthropic.com' : 'https://api.example.com/v1', onChange: (e) => set({ baseURL: e.target.value }), 'data-dsh-bots-ep': 'baseURL' })),
          h(Field, { label: t('epKey'), hint: t('epKeyHint'), style: { gridColumn: '1 / -1' } }, h(Input, { type: 'password', autoComplete: 'off', value: f.key, placeholder: editing ? t('epKeyKeep') : '', onChange: (e) => set({ key: e.target.value }), 'data-dsh-bots-ep': 'key' })),
        ),
        h(
          Field,
          { label: t('epModels'), hint: t('epModelsHint'), right: h(Btn, { size: 'sm', kind: 'ghost', icon: busy === 'fetch' ? h('span', { className: 'dshb-spinner' }) : Icon.download(12), disabled: busy !== '' || !/^https?:\/\//.test(f.baseURL.trim()), onClick: fetchModels, 'data-dsh-bots-ep-fetch': true }, busy === 'fetch' ? t('fetching') : t('fetchModels')) },
          found && found.length
            ? h(
                'div',
                { className: 'dshb-scroll', style: { maxHeight: 180, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 4, padding: 6, border: `1px solid ${C.border1}`, borderRadius: 9 } },
                found.map((m) => h('label', { key: m.id, style: { display: 'flex', gap: 6, alignItems: 'center', fontSize: SMALL, cursor: 'pointer', minWidth: 0 } }, h('input', { type: 'checkbox', checked: ids.includes(m.id), onChange: (e) => toggle(m.id, e.target.checked), style: { accentColor: 'var(--dsw-alias-brand-primary)' } }), h('span', { className: 'dshb-mono', style: { fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: m.name ?? m.id }, m.id))),
              )
            : null,
          h(TextArea, { rows: 3, mono: true, value: f.models, placeholder: 'gpt-5.1\ndeepseek-chat', onChange: (e) => set({ models: e.target.value }), 'data-dsh-bots-ep': 'models' }),
        ),
        h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8 } }, h(Btn, { kind: 'ghost', onClick: onCancel }, t('cancel')), h(Btn, { kind: 'primary', disabled: !valid || busy !== '', onClick: save, 'data-dsh-bots-ep-save': true }, busy === 'save' ? t('saving') : t('save'))),
      );
    }

    function ModelSourcesModal({ t, onClose, toast }) {
      const { data, reload } = useJson('models/sources');
      const [form, setForm] = useState(null);
      const [busy, setBusy] = useState('');
      const [confirm, setConfirm] = useState(null);
      const act = (path, body, ok) => {
        setBusy(path);
        return postJson(path, body)
          .then((r) => {
            if (r?.ok) {
              if (ok) toast(ok);
              void reload();
              void loadCatalog(true);
              void refreshState();
            } else toast(r?.reason || t('actionFailed'), 'error');
          })
          .finally(() => setBusy(''));
      };
      return h(
        Modal,
        { title: t('sourcesTitle'), onClose, width: 680, closeLabel: t('close') },
        h('div', { style: { fontSize: SMALL, color: C.muted, lineHeight: 1.6 } }, t('sourcesIntro')),
        data && !data.writable ? h('div', { style: { fontSize: SMALL, color: C.warn } }, t('notWritable')) : null,
        h(
          Section,
          { title: t('endpoints'), right: form ? null : h(Btn, { size: 'sm', icon: Icon.plus(12), disabled: data && !data.writable, onClick: () => setForm({}), 'data-dsh-bots-add-endpoint': true }, t('addEndpoint')) },
          form ? h(EndpointForm, { t, value: form, apis: data?.apis, toast, onCancel: () => setForm(null), onSaved: () => (setForm(null), void reload(), void loadCatalog(true)) }) : null,
          !data
            ? h('div', { style: { fontSize: SMALL, color: C.faint } }, t('loading'))
            : data.custom.length === 0 && !form
              ? h('div', { style: { fontSize: SMALL, color: C.faint } }, t('noEndpoints'))
              : data.custom.map((e) =>
                  h(
                    'div',
                    { key: e.route, className: 'dshb-card', 'data-dsh-bots-endpoint': e.route, style: { display: 'flex', alignItems: 'center', gap: 12 } },
                    h(
                      'div',
                      { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 } },
                      h('span', { style: { fontWeight: 600 } }, e.name),
                      h('span', { className: 'dshb-mono', style: { fontSize: 11.5, color: C.faint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, `${API_LABELS[e.api] ?? e.api} · ${e.baseURL}`),
                      h('span', { style: { fontSize: TINY, color: C.muted } }, `${t('nModels', { n: e.models.length })} · ${e.keyConfigured ? t('keySet') : t('keyMissing')}`),
                    ),
                    confirm === e.route
                      ? h('span', { style: { display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: TINY, color: C.muted } }, t('epRemoveConfirm'), h(Btn, { size: 'sm', kind: 'danger', disabled: busy !== '', onClick: () => act('models/custom/delete', { route: e.route }, t('epRemoved')).then(() => setConfirm(null)) }, t('remove')), h(Btn, { size: 'sm', kind: 'ghost', onClick: () => setConfirm(null) }, t('cancel')))
                      : h('span', { style: { display: 'inline-flex', gap: 6 } }, h(Btn, { size: 'sm', kind: 'ghost', icon: Icon.edit(12), onClick: () => setForm(e) }, t('edit')), h(Btn, { size: 'sm', kind: 'ghost', icon: Icon.trash(12), onClick: () => setConfirm(e.route), 'data-dsh-bots-endpoint-remove': e.route })),
                  ),
                ),
        ),
        h(
          Section,
          { title: t('logins'), hint: t('loginsHint') },
          !data
            ? null
            : data.logins.map((l) =>
                h(
                  'div',
                  { key: l.id, className: 'dshb-card', 'data-dsh-bots-login': l.id, style: { display: 'flex', alignItems: 'center', gap: 12, opacity: l.found ? 1 : 0.7 } },
                  h(
                    'div',
                    { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 } },
                    h('span', { style: { fontWeight: 600 } }, `${l.name} · ${l.product}`),
                    h('span', { style: { fontSize: TINY, color: C.muted, lineHeight: 1.5 } }, !l.found ? t('loginNotFound') : !l.supported ? t(`loginReason_${l.reason}`) : l.connected ? t('loginConnected', { name: l.name }) : [l.account, l.plan].filter(Boolean).join(' · ')),
                    l.supported && l.found ? h('span', { style: { fontSize: TINY, color: C.faint, lineHeight: 1.5 } }, t(`loginHint_${l.id}`)) : null,
                  ),
                  l.supported && l.found
                    ? l.connected
                      ? h(Btn, { size: 'sm', kind: 'ghost', disabled: busy !== '', onClick: () => act('models/login/disconnect', { id: l.id }), 'data-dsh-bots-login-disconnect': l.id }, t('disconnect'))
                      : h(Btn, { size: 'sm', kind: 'primary', disabled: busy !== '' || (data && !data.writable), onClick: () => act('models/login/connect', { id: l.id }, t('loginReady', { name: l.product })), 'data-dsh-bots-login-connect': l.id }, t('useLogin'))
                    : null,
                ),
              ),
        ),
      );
    }

    // --- new bot ----------------------------------------------------------------------------

    function NewBotModal({ t, onClose, onCreated, toast }) {
      const [persona, setPersona] = useState('researcher');
      const preset = PERSONAS.find((p) => p.id === persona) ?? PERSONAS[0];
      const [avatar, setAvatar] = useState({ kind: 'initials', color: preset.color });
      const [name, setName] = useState('');
      const [handle, setHandle] = useState('');
      const [handleTouched, setHandleTouched] = useState(false);
      const [bio, setBio] = useState(t('personaBio_researcher'));
      const [text, setText] = useState('');
      const [touched, setTouched] = useState({ avatar: false, bio: false, text: false });
      const [busy, setBusy] = useState(false);
      const derived = handleTouched ? handle : autoHandle(name);
      const hErr = derived ? handleError(t, derived, null) : '';
      const pick = (id, p) => {
        setPersona(id);
        if (!touched.avatar) setAvatar((a) => ({ ...a, color: p.color }));
        if (!touched.bio) setBio(id === 'custom' ? '' : t(`personaBio_${id}`));
        if (!touched.text) setText('');
      };
      const personaText = touched.text ? text : persona === 'custom' ? text : t(`personaText_${persona}`, { name: name.trim() || t(`persona_${persona}`) });
      const valid = name.trim() !== '' && derived !== '' && !hErr;
      const create = () => {
        if (!valid || busy) return;
        setBusy(true);
        postJson('save', { bot: { name: name.trim(), handle: derived, bio: bio.trim(), persona: personaText, avatar } })
          .then((r) => {
            if (r?.ok && r.bot) {
              toast(t('created', { name: r.bot.name }));
              void refreshState().then(() => onCreated(r.bot));
              onClose();
            } else toast(r?.reason || t('saveFailed'), 'error');
          })
          .finally(() => setBusy(false));
      };
      return h(
        Modal,
        {
          title: t('newBotTitle'),
          closeLabel: t('close'),
          width: 620,
          onClose,
          footer: [
            h(Btn, { key: 'c', onClick: onClose }, t('cancel')),
            h(Btn, { key: 's', kind: 'primary', disabled: !valid || busy, onClick: create, 'data-dsh-bots-create': true }, busy ? t('creating') : t('createBot')),
          ],
        },
        h(Field, { label: t('startFrom') }, h(PersonaChips, { t, active: persona, onPick: pick })),
        h(AvatarEditor, {
          t,
          compact: true,
          avatar,
          name: name.trim() || t(`persona_${persona}`),
          onChange: (a) => {
            setAvatar(a);
            setTouched((x) => ({ ...x, avatar: true }));
          },
        }),
        h(
          'div',
          { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 } },
          h(Field, { label: t('name') }, h(Input, { value: name, autoFocus: true, placeholder: t('namePlaceholder'), maxLength: 60, onChange: (e) => setName(e.target.value), 'data-dsh-bots-field': 'new-name' })),
          h(
            Field,
            { label: t('handle'), error: hErr, hint: hErr ? '' : t('handleHint') },
            h(
              'div',
              { style: { position: 'relative' } },
              h('span', { style: { position: 'absolute', left: 10, top: 7, color: C.faint } }, '@'),
              h(Input, {
                value: derived,
                maxLength: 32,
                'data-invalid': Boolean(hErr),
                onChange: (e) => {
                  setHandleTouched(true);
                  setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''));
                },
                style: { paddingLeft: 24 },
              }),
            ),
          ),
        ),
        h(
          Field,
          { label: t('bio') },
          h(Input, {
            value: bio,
            maxLength: 160,
            placeholder: t('bioPlaceholder'),
            onChange: (e) => {
              setBio(e.target.value);
              setTouched((x) => ({ ...x, bio: true }));
            },
          }),
        ),
        h(
          Field,
          { label: t('persona'), hint: t('personaHint') },
          h(TextArea, {
            rows: 6,
            value: personaText,
            placeholder: t('personaPlaceholder'),
            onChange: (e) => {
              setText(e.target.value);
              setTouched((x) => ({ ...x, text: true }));
            },
          }),
        ),
      );
    }

    // --- teams: ready-made bot teams to hire ---------------------------------------------

    /** "weekly 1,2,3,4,5 09:00" / "daily 09:00" → "Weekdays 09:00", "Every Fri 17:30". */
    function teamWhen(t, when) {
      const m = /^(daily|weekly)\s+(?:([\d,]+)\s+)?(\d{1,2}):(\d{2})$/.exec(str(when).trim());
      if (!m) return str(when);
      const time = `${m[3].padStart(2, '0')}:${m[4]}`;
      if (m[1] === 'daily') return t('teamDaily', { time });
      const days = m[2].split(',').map(Number).sort((a, b) => a - b);
      if (days.length === 7) return t('teamDaily', { time });
      if (days.join() === '1,2,3,4,5') return t('teamWeekdays', { time });
      return t('teamWeekly', { days: days.map((d) => t(`wd${d}`)).join(t('listSep')), time });
    }
    /** A member's avatar: letters from its English name, so both languages look the same. */
    const memberAvatar = (m) => ({ kind: 'initials', text: initialsOf(pick(m.name, 'en')), color: str(m.color) || COLORS[0] });
    /** The short role of a member: its bio up to the first colon ("Chief of staff: …" → "Chief of staff"). */
    function roleOf(m, lang) {
      const en = pick(m.name, 'en');
      const own = pick(m.name, lang);
      if (en && own !== en && own.startsWith(en)) return own.slice(en.length).trim();
      const bio = pick(m.bio, lang);
      const head = bio.split(/[:：]/)[0].trim();
      return head && head.length <= 24 && head !== bio ? head : bio;
    }
    /** The member's given name without the role suffix ("Atlas 幕僚长" → "Atlas"). */
    const memberName = (m, lang) => pick(m.name, 'en') || pick(m.name, lang);
    const teamCounts = (team) => ({
      skills: (team.bots ?? []).reduce((n, b) => n + (b.skills ?? []).length, 0),
      tasks: (team.bots ?? []).reduce((n, b) => n + (b.tasks ?? []).length, 0),
    });

    function TeamCard({ t, lang, team, onHire, onDetail, busy }) {
      const members = Array.isArray(team.bots) ? team.bots : [];
      const n = teamCounts(team);
      const color = str(team.color) || C.label;
      return h(
        'div',
        { className: 'dshb-appcard dshb-teamcard', 'data-dsh-bots-team': team.id, style: { padding: 0, overflow: 'hidden', gap: 0 } },
        h('div', { style: { height: 4, background: `linear-gradient(90deg, ${color}, ${tint(color, 35)})` } }),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 10, padding: '14px 16px 14px', flex: 1 } },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 10 } },
            h('div', { style: { fontWeight: 700, fontSize: 15.5, flex: 1, minWidth: 0 } }, pick(team.name, lang)),
            h(
              'div',
              { style: { display: 'flex', flex: 'none' } },
              members.map((m, i) => h('span', { key: m.key, style: { marginLeft: i ? -8 : 0, display: 'inline-flex', borderRadius: '50%', boxShadow: `0 0 0 2px ${C.layer1}` } }, h(Avatar, { avatar: memberAvatar(m), name: memberName(m, lang), size: 28, title: pick(m.name, lang) }))),
            ),
          ),
          h('div', { style: { fontSize: SMALL, color: C.muted, lineHeight: 1.55, minHeight: 38 } }, pick(team.tagline, lang)),
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 5, padding: '8px 10px', borderRadius: 10, background: C.layer2 } },
            members.map((m) =>
              h(
                'div',
                { key: m.key, style: { display: 'flex', alignItems: 'center', gap: 7, fontSize: SMALL, minWidth: 0 } },
                h('span', { style: { width: 7, height: 7, borderRadius: '50%', background: m.color, flex: 'none' } }),
                h('span', { style: { fontWeight: 600, flex: 'none' } }, memberName(m, lang)),
                h('span', { style: { color: C.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, roleOf(m, lang)),
                m.role === 'primary' ? h('span', { title: t('dispatcher'), style: { color: '#f5b301', display: 'inline-flex', flex: 'none' } }, Icon.crown(11)) : null,
              ),
            ),
          ),
          h('div', { style: { fontSize: TINY, color: C.faint } }, t('teamCounts', { bots: members.length, skills: n.skills, tasks: n.tasks })),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 'auto' } },
            h(Btn, { kind: 'primary', icon: Icon.team(14), disabled: busy, onClick: () => onHire(team), 'data-dsh-bots-hire': team.id }, t('hireTeam')),
            h(Btn, { kind: 'ghost', onClick: () => onDetail(team), 'data-dsh-bots-team-detail': team.id }, t('teamDetails')),
          ),
        ),
      );
    }

    /** The four teams as cards; `hero` adds the big welcome above them. */
    function TeamsGallery({ t, lang, teams, onHire, onDetail, hero, onBlank, busy }) {
      return h(
        'div',
        { className: 'dshb-scroll', 'data-dsh-bots-teams': hero ? 'hero' : 'list', style: { flex: 1, padding: hero ? '40px 32px 32px' : '22px 28px 28px' } },
        h(
          'div',
          { style: { maxWidth: 980, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: hero ? 26 : 18 } },
          hero
            ? h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 10 } },
                h('span', { style: { width: 58, height: 58, borderRadius: 18, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: `linear-gradient(150deg, ${tint(C.label, 22)}, ${tint(C.label, 8)})`, color: C.label } }, h(BotsGlyph, { size: 32, active: true })),
                h('div', { style: { fontWeight: 750, fontSize: 24, letterSpacing: '-.01em' } }, t('teamsHeroTitle')),
                h('div', { style: { fontSize: FONT, color: C.muted, maxWidth: 620, lineHeight: 1.65 } }, t('teamsHeroBody')),
              )
            : h(
                'div',
                { style: { display: 'flex', alignItems: 'flex-end', gap: 12 } },
                h('div', { style: { flex: 1 } }, h('div', { style: { fontWeight: 700, fontSize: 18 } }, t('teamTemplates')), h('div', { style: { fontSize: SMALL, color: C.muted, marginTop: 3 } }, t('teamTemplatesSub'))),
              ),
          teams === null
            ? h('div', { style: { padding: 24, color: C.faint, fontSize: SMALL, textAlign: 'center' } }, t('loading'))
            : teams.length === 0
              ? h('div', { style: { padding: 24, color: C.faint, fontSize: SMALL, textAlign: 'center' } }, t('noTeams'))
              : h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(380px, 1fr))', gap: 14 } }, teams.map((team) => h(TeamCard, { key: team.id, t, lang, team, onHire, onDetail, busy }))),
          hero && onBlank
            ? h(
                'div',
                { style: { textAlign: 'center', fontSize: SMALL, color: C.faint } },
                t('orBlank'),
                ' ',
                h('button', { type: 'button', className: 'dshb-link', onClick: onBlank, 'data-dsh-bots-blank': true }, t('blankBot')),
              )
            : null,
        ),
      );
    }

    /** A skill chip: Harness skills tinted blue, GitHub imports outlined; missing ones struck through. */
    function SkillChip({ t, skill }) {
      const dsh = skill.source === 'dsh';
      const off = skill.available === false;
      return h(
        'span',
        {
          'data-dsh-bots-team-skill': skill.name,
          'data-source': skill.source,
          'data-available': !off,
          title: off ? t('skillNotInstalled') : dsh ? t('srcHarnessHint') : `GitHub · ${str(skill.repo)}`,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            height: 22,
            padding: '0 8px',
            borderRadius: 6,
            fontSize: TINY,
            fontFamily: 'var(--dsh-code-font, ui-monospace, SFMono-Regular, Menlo, monospace)',
            whiteSpace: 'nowrap',
            color: off ? C.faint : dsh ? '#2563eb' : C.primary,
            background: off ? 'transparent' : dsh ? 'rgba(37,99,235,.09)' : C.layer1,
            border: `1px ${off ? 'dashed' : 'solid'} ${off ? C.border : dsh ? 'rgba(37,99,235,.25)' : C.border}`,
            textDecoration: off ? 'line-through' : 'none',
          },
        },
        dsh ? Icon.layers(10) : Icon.github(10),
        skill.name,
      );
    }

    /** A label column and wrapping chips that stay aligned under each other. */
    const chipRow = (label, ...chips) =>
      h(
        'div',
        { style: { display: 'flex', alignItems: 'flex-start', gap: 6 } },
        h('span', { style: { fontSize: TINY, color: C.faint, width: 36, flex: 'none', lineHeight: '22px' } }, label),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap', flex: 1, minWidth: 0 } }, chips),
      );
    function TeamDetailModal({ t, lang, team, onClose, onHire, askPrimary, primary, setPrimary, entries }) {
      const members = Array.isArray(team.bots) ? team.bots : [];
      const appName = (id) => {
        const e = (entries ?? []).find((x) => x.id === id);
        return e ? pick(e.name, lang) : id;
      };
      return h(
        Modal,
        {
          title: pick(team.name, lang),
          closeLabel: t('close'),
          width: 760,
          onClose,
          footer: [
            askPrimary ? h(PrimaryTick, { key: 'p', t, primary, setPrimary }) : h('span', { key: 'p', style: { flex: 1 } }),
            h(Btn, { key: 'c', onClick: onClose }, t('cancel')),
            h(Btn, { key: 'h', kind: 'primary', icon: Icon.team(14), onClick: () => onHire(team), 'data-dsh-bots-hire-modal': team.id }, t('hireTeam')),
          ],
        },
        h('div', { 'data-dsh-bots-team-modal': team.id, style: { fontSize: FONT, color: C.muted, lineHeight: 1.65 } }, pick(team.description, lang)),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
          members.map((m) =>
            h(
              'div',
              { key: m.key, className: 'dshb-card', 'data-dsh-bots-member': m.key, style: { display: 'flex', gap: 12, alignItems: 'flex-start' } },
              h(Avatar, { avatar: memberAvatar(m), name: memberName(m, lang), size: 40, ring: m.role === 'primary' }),
              h(
                'div',
                { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 7 } },
                h(
                  'div',
                  { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                  h('span', { style: { fontWeight: 700 } }, pick(m.name, lang)),
                  h('span', { className: 'dshb-mono', style: { fontSize: TINY, color: C.faint } }, `@${m.handle}`),
                  m.role === 'primary' ? h(Badge, { color: '#d99a00' }, Icon.crown(10), t('dispatcher')) : null,
                ),
                h('div', { style: { fontSize: SMALL, color: C.muted, lineHeight: 1.55 } }, pick(m.bio, lang)),
                (m.skills ?? []).length ? chipRow(t('tab_skills'), m.skills.map((s) => h(SkillChip, { key: `${s.source}:${s.name}`, t, skill: s }))) : null,
                (m.apps ?? []).length
                  ? chipRow(
                      t('tab_apps'),
                      m.apps.map((a) =>
                        h(
                          'span',
                          { key: a.id, 'data-dsh-bots-team-app': a.id, title: a.available === false ? t('appNotInCatalog') : t('appKeyLater'), style: { display: 'inline-flex', alignItems: 'center', gap: 4, height: 22, padding: '0 8px', borderRadius: 6, fontSize: TINY, border: `1px solid ${C.border}`, color: a.available === false ? C.faint : C.primary, textDecoration: a.available === false ? 'line-through' : 'none' } },
                          Icon.puzzle(10),
                          appName(a.id),
                        ),
                      ),
                      h('span', { key: 'later', style: { fontSize: TINY, color: C.faint } }, t('appKeyLater')),
                    )
                  : null,
                (m.tasks ?? []).length
                  ? chipRow(
                      t('teamTasks'),
                      m.tasks.map((task, i) =>
                        h(
                          'span',
                          { key: i, 'data-dsh-bots-team-task': true, style: { display: 'inline-flex', alignItems: 'center', gap: 5, height: 22, padding: '0 8px', borderRadius: 6, fontSize: TINY, background: tint(C.label, 8), color: C.primary } },
                          Icon.clock(10),
                          h('span', { style: { fontWeight: 600 } }, pick(task.title, lang)),
                          h('span', { style: { color: C.muted } }, teamWhen(t, task.when)),
                        ),
                      ),
                    )
                  : null,
              ),
            ),
          ),
        ),
        h(
          'div',
          { style: { display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: TINY, color: C.faint } },
          h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 5 } }, h(SkillChip, { t, skill: { name: 'harness', source: 'dsh', available: true } }), t('legendHarness')),
          h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 5 } }, h(SkillChip, { t, skill: { name: 'github', source: 'import', available: true } }), t('legendGithub')),
          h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 5 } }, h(SkillChip, { t, skill: { name: 'missing', source: 'dsh', available: false } }), t('legendMissing')),
        ),
      );
    }
    function PrimaryTick({ t, primary, setPrimary }) {
      return h(
        'label',
        { style: { flex: 1, display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: SMALL, color: C.muted, cursor: 'pointer' } },
        h('input', { type: 'checkbox', checked: primary, onChange: (e) => setPrimary(e.target.checked), 'data-dsh-bots-hire-primary': true, style: { accentColor: 'var(--dsw-alias-brand-primary)' } }),
        t('leadAsDispatcher'),
      );
    }

    /**
     * Hiring a team: confirm (only when a roster exists), then a progress state,
     * then what was created, skipped and still needs keys, with the kickoff.
     */
    function HireModal({ t, lang, hire, setHire, onDone, onOpenBot, toast, catalog }) {
      const { team, phase, result, primary } = hire;
      const [sending, setSending] = useState(false);
      const close = () => setHire(null);
      const go = () => {
        setHire({ ...hire, phase: 'busy' });
        postJson('teams/hire', { id: team.id, lang, primary })
          .then((r) => {
            if (r?.ok) {
              setHire({ ...hire, phase: 'done', result: r });
              void refreshState();
            } else setHire({ ...hire, phase: 'error', error: r?.reason || t('hireFailed') });
          })
          .catch(() => setHire({ ...hire, phase: 'error', error: t('hireFailed') }));
      };
      useEffect(() => {
        if (phase === 'start') go();
      }, [phase]);
      if (phase === 'confirm')
        return h(
          Modal,
          {
            title: t('hireTitle', { name: pick(team.name, lang) }),
            closeLabel: t('close'),
            width: 460,
            onClose: close,
            footer: [h(Btn, { key: 'c', onClick: close }, t('cancel')), h(Btn, { key: 'h', kind: 'primary', icon: Icon.team(14), onClick: go, 'data-dsh-bots-hire-go': true }, t('hireTeam'))],
          },
          h('div', { style: { fontSize: FONT, color: C.muted, lineHeight: 1.6 } }, t('hireConfirmBody', { n: (team.bots ?? []).length })),
          h(PrimaryTick, { t, primary, setPrimary: (v) => setHire({ ...hire, primary: v }) }),
        );
      if (phase === 'busy' || phase === 'start')
        return h(
          Modal,
          { title: t('hireTitle', { name: pick(team.name, lang) }), closeLabel: t('close'), width: 460, onClose: () => {} },
          h(
            'div',
            { 'data-dsh-bots-hiring': true, style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, padding: '18px 0 8px', textAlign: 'center' } },
            h('div', { style: { display: 'flex' } }, (team.bots ?? []).map((m, i) => h('span', { key: m.key, style: { marginLeft: i ? -10 : 0, display: 'inline-flex', borderRadius: '50%', boxShadow: `0 0 0 3px ${C.layer1}`, animation: `dshb-blink 1.4s ${i * 0.18}s infinite` } }, h(Avatar, { avatar: memberAvatar(m), name: memberName(m, lang), size: 40 })))),
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600 } }, h('span', { className: 'dshb-spinner' }), t('hiring')),
            h('div', { style: { fontSize: SMALL, color: C.faint } }, t('hiringHint')),
          ),
        );
      if (phase === 'error')
        return h(
          Modal,
          { title: t('hireTitle', { name: pick(team.name, lang) }), closeLabel: t('close'), width: 460, onClose: close, footer: [h(Btn, { key: 'c', onClick: close }, t('close')), h(Btn, { key: 'r', kind: 'primary', onClick: go }, t('retry'))] },
          h('div', { style: { color: C.error, fontSize: SMALL } }, hire.error),
        );
      // done
      const r = result ?? {};
      const made = (Array.isArray(r.bots) ? r.bots : []).map((b) => botById(b.id) ?? b);
      const lead = made.find((b) => b.id === r.leadId) ?? null;
      const skipped = Array.isArray(r.skipped) ? r.skipped : [];
      const entries = Array.isArray(catalog?.templates) ? catalog.templates : [];
      const needKeys = [];
      for (const b of made) {
        for (const app of b.apps ?? []) {
          const entry = entries.find((e) => e.id === app.template);
          const issue = str(b.appIssues?.[app.id]);
          if (issue || (entry && missingFields(entry, valuesFor(entry, app)).length)) needKeys.push({ bot: b, app, name: entry ? pick(entry.name, lang) : app.name });
        }
      }
      const byKind = ['skill', 'app', 'schedule'].map((k) => [k, skipped.filter((x) => x.kind === k)]).filter(([, list]) => list.length);
      const kickoff = () => {
        if (!lead || sending) return;
        setSending(true);
        postJson('send', { to: lead.id, text: str(r.kickoff) })
          .then((x) => {
            if (x?.ok) {
              close();
              onDone(lead.id, 'chat');
              void refreshState();
            } else toast(x?.reason || t('sendFailed'), 'error');
          })
          .finally(() => setSending(false));
      };
      return h(
        Modal,
        {
          title: t('hiredTitle', { name: pick(team.name, lang) }),
          closeLabel: t('close'),
          width: 600,
          onClose: () => {
            close();
            if (lead) onDone(lead.id, 'chat');
          },
          footer: [
            h(Btn, { key: 'l', onClick: () => (close(), lead && onDone(lead.id, 'chat')), 'data-dsh-bots-later': true }, t('later')),
            lead ? h(Btn, { key: 'k', kind: 'primary', icon: Icon.send(13), disabled: sending, onClick: kickoff, 'data-dsh-bots-kickoff': lead.id }, t('sendKickoff', { name: str(lead.name).split(/\s+/)[0] || lead.name })) : null,
          ],
        },
        h(
          'div',
          { 'data-dsh-bots-hired': r.team ?? true, style: { display: 'flex', flexDirection: 'column', gap: 8 } },
          h('div', { style: { fontSize: SMALL, fontWeight: 700, color: C.muted } }, t('hiredBots', { n: made.length })),
          h(
            'div',
            { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
            made.map((b) =>
              h(
                'span',
                { key: b.id, className: 'dshb-chip', style: { height: 32, paddingLeft: 4, cursor: 'default', color: C.primary } },
                h(Avatar, { avatar: b.avatar, name: b.name, size: 24 }),
                h('span', { style: { fontWeight: 600 } }, b.name),
                b.id === r.leadId ? h('span', { style: { color: '#f5b301', display: 'inline-flex' } }, Icon.crown(10)) : null,
              ),
            ),
          ),
        ),
        r.kickoff
          ? h(
              'div',
              { style: { padding: '10px 12px', borderRadius: 10, background: tint(C.label, 8), fontSize: SMALL, lineHeight: 1.6 } },
              h('div', { style: { fontSize: TINY, fontWeight: 700, color: C.label, marginBottom: 3 } }, t('kickoffLabel')),
              str(r.kickoff),
            )
          : null,
        needKeys.length
          ? h(
              'div',
              { 'data-dsh-bots-need-keys': needKeys.length, style: { display: 'flex', flexDirection: 'column', gap: 6 } },
              h('div', { style: { fontSize: SMALL, fontWeight: 700, color: C.muted } }, t('needKeysTitle')),
              needKeys.map((x) =>
                h(
                  'div',
                  { key: `${x.bot.id}:${x.app.id ?? x.app.serverName}`, style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: SMALL } },
                  h('span', { style: { color: '#d97706', display: 'inline-flex' } }, Icon.alert(13)),
                  h('span', { style: { fontWeight: 600 } }, x.name),
                  h('span', { style: { color: C.faint } }, '·'),
                  h('span', { style: { color: C.muted } }, x.bot.name),
                  h('span', { style: { flex: 1 } }),
                  h('button', { type: 'button', className: 'dshb-link', style: { fontSize: SMALL }, onClick: () => (close(), onOpenBot(x.bot.id, 'apps')), 'data-dsh-bots-fill-key': x.bot.id }, t('fillKey')),
                ),
              ),
            )
          : null,
        byKind.length
          ? h(
              'details',
              { 'data-dsh-bots-skipped': skipped.length, style: { fontSize: SMALL, color: C.muted } },
              h('summary', { style: { cursor: 'pointer', userSelect: 'none', fontWeight: 600 } }, t('skippedTitle', { n: skipped.length })),
              byKind.map(([kind, list]) =>
                h(
                  'div',
                  { key: kind, style: { marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 } },
                  h('div', { style: { fontSize: TINY, fontWeight: 700, color: C.faint } }, t(`skippedKind_${kind}`)),
                  list.map((x, i) =>
                    h(
                      'div',
                      { key: i, style: { display: 'flex', gap: 8, fontSize: TINY, minWidth: 0 } },
                      h('span', { className: 'dshb-mono', style: { fontWeight: 600, color: C.primary, flex: 'none' } }, x.name),
                      h('span', { style: { color: C.faint, flex: 'none' } }, `@${x.bot}`),
                      h('span', { style: { color: C.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: x.reason }, x.reason || (kind === 'skill' ? t('skillNotInstalledShort') : kind === 'app' ? t('appNotInCatalog') : '')),
                    ),
                  ),
                ),
              ),
            )
          : null,
      );
    }

    // --- the panel ----------------------------------------------------------------------------

    function BotsPanel(props) {
      const t = typeof props.t === 'function' ? props.t : fallbackT;
      const env = props.env ?? nullEnv;
      const s = useStore();
      const catalog = useCatalog();
      const teams = useLoaded('teams', 'teams');
      const lang = langOf(t);
      const [selected, setSelected] = useState(null);
      const [view, setView] = useState(null); // null = teams hero when the roster is (nearly) empty, else the bot
      const [tab, setTab] = useState('chat');
      const [creating, setCreating] = useState(false);
      const [detail, setDetail] = useState(null); // a team shown in the detail modal
      const [hire, setHire] = useState(null); // {team, phase: confirm|start|busy|done|error, primary, result?}
      const [primaryTick, setPrimaryTick] = useState(true);
      const [settings, setSettings] = useState(false);
      const [ticketId, setTicketId] = useState(null); // the task shown in the Tasks view
      const [tasksBot, setTasksBot] = useState(''); // the Tasks view's bot filter when another view asked for it
      const [noticeGone, setNoticeGone] = useState(false);
      const [toast, showToast] = useToast();
      const seenNav = useRef(0);
      const bots = Array.isArray(s.state?.bots) ? s.state.bots : [];
      const primaryId = s.state?.primaryId ?? bots.find((b) => b.role === 'primary')?.id ?? null;
      // Another seat (a badge, a tool card, a task card) asked for a bot, a view or a task.
      useEffect(() => {
        if (s.nav.tick === seenNav.current) return;
        seenNav.current = s.nav.tick;
        if (s.nav.view === 'tasks') {
          setView('tasks');
          setTicketId(s.nav.ticket ?? null);
          setTasksBot(s.nav.ticket ? '' : (s.nav.botId ?? ''));
        } else if (s.nav.view === 'activity') setView('activity');
        else if (s.nav.botId) {
          setSelected(s.nav.botId);
          setView('bot');
        }
      }, [s.nav.tick]);
      const current = bots.find((b) => b.id === selected) ?? bots.find((b) => b.id === primaryId) ?? bots[0] ?? null;
      const shownView = view ?? (s.state && bots.length <= 1 && !bots.some((b) => b.team) ? 'hero' : 'bot');
      const hasPrimary = Boolean(primaryId);
      /** Start hiring: straight away on an empty roster, else confirm (and ask about the dispatcher). */
      const startHire = (team, fromDetail = false) => {
        setDetail(null);
        const real = bots.filter((b) => !(b.role === 'primary' && bots.length === 1 && !b.team && (b.skills ?? []).length === 0));
        const primary = fromDetail ? primaryTick : true;
        setHire({ team, primary, phase: real.length === 0 || fromDetail ? 'start' : 'confirm' });
      };
      const openBotTab = (id, tabId) => {
        setSelected(id);
        setView('bot');
        setTab(tabId);
      };
      const env2 = {
        ...env,
        openBot: (bot) =>
          Promise.resolve(env.openBot(bot)).then((ok) => {
            if (ok === false) showToast(t('openFailed'), 'error');
          }),
      };
      let main;
      if (!s.state) {
        main = h('div', { style: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.faint, fontSize: SMALL } }, s.failed ? t('unavailable') : t('loading'));
      } else if (shownView === 'tasks') {
        main = ticketId ? h(TicketDetail, { key: ticketId, t, id: ticketId, env: env2, toast: showToast, onBack: () => setTicketId(null) }) : h(TasksView, { t, bots, focusBot: tasksBot, onOpen: setTicketId });
      } else if (shownView === 'activity') {
        main = h(ActivityView, { t, bots });
      } else if (shownView === 'usage') {
        main = h(UsageView, { t, bots });
      } else if (shownView === 'memory') {
        main = h(TeamMemoryView, { t, toast: showToast, onSettings: () => setSettings(true) });
      } else if (shownView === 'hero' || shownView === 'teams' || !current) {
        main = h(TeamsGallery, { t, lang, teams, hero: shownView !== 'teams', onHire: (team) => startHire(team), onDetail: (team) => (setPrimaryTick(true), setDetail(team)), onBlank: () => setCreating(true), busy: Boolean(hire) });
      } else {
        main = h(BotDetail, { t, bot: current, primaryId, env: env2, toast: showToast, catalog, tab, setTab, onDeleted: () => setSelected(null), onSettings: () => setSettings(true) });
      }
      return h(
        'div',
        { className: 'dshb', 'data-dsh-bots-panel': true, style: { position: 'relative', display: 'flex', height: '100%', minHeight: 0, width: '100%', background: C.base, overflow: 'hidden' } },
        h(Style),
        h(Rail, {
          t,
          bots,
          primaryId,
          selected: current?.id ?? null,
          view: shownView,
          messageCount: s.state?.messageCount,
          onSelect: (id) => {
            setSelected(id);
            setView('bot');
          },
          onNew: () => setCreating(true),
          onTeams: () => setView('teams'),
          onActivity: () => setView('activity'),
          onUsage: () => setView('usage'),
          onMemory: () => setView('memory'),
          onSettings: () => setSettings(true),
          teamNotes: s.state?.teamNotes ?? 0,
          onTasks: () => {
            setView('tasks');
            setTicketId(null);
            setTasksBot('');
          },
          attention: Array.isArray(s.state?.attention) ? s.state.attention.length : 0,
          openTasks: bots.reduce((n, b) => n + openTaskCount(b), 0),
        }),
        h(
          'div',
          { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 } },
          !noticeGone && routerNotice.pending(s.state)
            ? h(RouterNoticeBanner, {
                t,
                onOpenDispatcher: primaryId ? () => openBotTab(primaryId, 'profile') : null,
                onDismiss: () => {
                  setNoticeGone(true);
                  void Promise.resolve(routerNotice.dismiss()).then(() => refreshState());
                },
              })
            : null,
          main,
        ),
        creating
          ? h(NewBotModal, {
              t,
              toast: showToast,
              onClose: () => setCreating(false),
              onCreated: (bot) => {
                setSelected(bot.id);
                setView('bot');
                setTab('profile');
              },
            })
          : null,
        detail
          ? h(TeamDetailModal, { t, lang, team: detail, entries: catalog?.templates, onClose: () => setDetail(null), onHire: (team) => startHire(team, true), askPrimary: hasPrimary && bots.length > 1, primary: primaryTick, setPrimary: setPrimaryTick })
          : null,
        hire ? h(HireModal, { t, lang, hire, setHire, toast: showToast, catalog, onDone: openBotTab, onOpenBot: openBotTab }) : null,
        settings ? h(SettingsModal, { t, catalog, toast: showToast, onClose: () => setSettings(false) }) : null,
        h(Toast, { toast }),
      );
    }
    const nullEnv = { canOpen: () => false, openBot: () => false, openSession: () => false, openPanel: () => false };

    // --- tool views in the conversation -----------------------------------------------------

    function parseArgs(block) {
      const raw = block?.argsRaw ?? block?.call?.argsRaw;
      if (typeof raw === 'string' && raw !== '') {
        try {
          return JSON.parse(raw);
        } catch {
          // Partial JSON while the call streams: pull out whole string fields.
          const out = {};
          const re = /"(\w+)"\s*:\s*"((?:[^"\\]|\\.)*)("?)/g;
          let m;
          while ((m = re.exec(raw))) {
            try {
              out[m[1]] = JSON.parse(`"${m[2]}${m[2].endsWith('\\') && !m[2].endsWith('\\\\') ? '\\' : ''}"`);
            } catch {
              out[m[1]] = m[2];
            }
          }
          return out;
        }
      }
      const args = block?.args ?? block?.call?.args;
      if (args && typeof args === 'object') {
        try {
          return typeof args.toJSON === 'function' ? args.toJSON() : { ...args };
        } catch {
          return {};
        }
      }
      return {};
    }
    function resultText(block) {
      const content = block?.content;
      if (typeof content === 'string') return content.trim();
      return (Array.isArray(content) ? content : [])
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n')
        .trim();
    }
    /** A face from meta, else the live store, else a placeholder from the reference. */
    function faceOf(metaFace, ref) {
      const live = (metaFace?.id && botById(metaFace.id)) || findBot(ref);
      if (live) return live;
      if (metaFace && typeof metaFace === 'object') return metaFace;
      if (!ref) return null;
      return { id: '', name: str(ref).replace(/^@/, ''), handle: str(ref).replace(/^@/, ''), avatar: null };
    }

    function ToolShell({ t, phase, block, title, children, env, face, right }) {
      const settled = phase === 'result';
      const err = settled && block?.isError;
      return h(
        'div',
        { className: 'dshb', 'data-dsh-bots-call': block?.callId ?? true, style: { display: 'flex', flexDirection: 'column', gap: 6, padding: '6px 0 4px', fontSize: FONT, color: C.primary, minWidth: 0 } },
        h(Style),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 7, fontSize: SMALL, color: C.muted, minWidth: 0 } },
          h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, color: err ? C.error : settled ? C.label : C.faint, fontWeight: 600, flex: 'none' } }, h(BotsGlyph, { size: 14, active: settled && !err }), title),
          right ?? null,
          !settled ? h('span', { style: { color: C.faint, fontStyle: 'italic' } }, t(phase === 'preparing' ? 'preparing' : 'running')) : null,
          face?.id && env?.canPanel?.() ? h('button', { type: 'button', className: 'dshb-link', style: { marginLeft: 'auto', fontSize: TINY }, onClick: () => env.showBot(face.id) }, t('viewInBots')) : null,
        ),
        children,
        err ? h('div', { style: { fontSize: SMALL, color: C.error, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, resultText(block) || t('failed')) : null,
      );
    }
    const FaceLine = ({ face, size = 20, sub }) =>
      face
        ? h(
            'span',
            { style: { display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 } },
            h(Avatar, { avatar: face.avatar, name: face.name || face.handle, size }),
            h('span', { style: { fontWeight: 600, color: C.primary, whiteSpace: 'nowrap' } }, face.name || face.handle),
            face.handle ? h('span', { style: { color: C.faint, fontSize: TINY } }, `@${face.handle}`) : null,
            sub ? h('span', { style: { color: C.faint, fontSize: TINY } }, sub) : null,
          )
        : null;

    function SendMessageView(props) {
      const t = typeof props.t === 'function' ? props.t : fallbackT;
      useStore();
      const { phase, block } = props;
      const args = parseArgs(block);
      const meta = block?.meta && typeof block.meta === 'object' ? block.meta : {};
      const to = faceOf(meta.to, args.to);
      const from = meta.from ? faceOf(meta.from) : null;
      const delivered = phase === 'result' && !block?.isError;
      // A delegation opens (or adds to) a task; a worker's message to whoever asked is a report with a status.
      const ref = meta.ticket && typeof meta.ticket === 'object' ? meta.ticket : null;
      const ticketId = typeof meta.ticket === 'string' ? meta.ticket : typeof ref?.id === 'string' ? ref.id : typeof args.ticket === 'string' ? args.ticket : '';
      const report = REPORT_STATUSES.includes(args.status) ? args.status : '';
      const showTicket = (id) => (typeof props.env?.showTicket === 'function' ? props.env.showTicket(id) : openTicket(id));
      return h(
        ToolShell,
        { t, phase, block, title: report ? t('toolReport') : t('toolSend'), env: props.env, face: to },
        h(
          'div',
          { 'data-dsh-bots-dm': true, style: { border: `1px solid ${C.border1}`, borderRadius: 12, background: C.layer1, padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 640 } },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: SMALL, minWidth: 0, flexWrap: 'wrap' } },
            from ? h(FaceLine, { face: from, size: 18 }) : null,
            h('span', { style: { color: C.faint, display: 'inline-flex' } }, Icon.arrow(12)),
            to ? h(FaceLine, { face: to, size: 18 }) : h('span', { style: { color: C.faint } }, report ? t('requesterShort') : '…'),
            report ? h(ReportChip, { t, status: report }) : null,
            delivered ? h('span', { style: { marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4, color: C.ok, fontSize: TINY } }, Icon.check(11), t('delivered')) : null,
          ),
          ticketId && !report ? h(TaskCard, { t, id: ticketId, botId: to?.id, face: to, title: str(ref?.title) || firstLine(args.text), stage: typeof meta.stage === 'string' ? meta.stage : ref?.stage, onOpen: showTicket }) : null,
          args.text ? h(Clamp, { t, text: args.text, lines: 5, style: { fontSize: SMALL, color: C.primary } }) : null,
          ticketId && report ? h('button', { type: 'button', className: 'dshb-link', 'data-dsh-bots-report-task': ticketId, onClick: () => showTicket(ticketId), style: { fontSize: TINY, alignSelf: 'flex-start' } }, t('openTask')) : null,
        ),
      );
    }

    function BotChangeView(props) {
      const t = typeof props.t === 'function' ? props.t : fallbackT;
      useStore();
      const { phase, block, tool } = props;
      const args = parseArgs(block);
      const meta = block?.meta && typeof block.meta === 'object' ? block.meta : {};
      let face = faceOf(meta.bot, tool === 'bot_create' ? null : args.bot);
      if (!face && tool === 'bot_create' && args.name) face = { id: '', name: args.name, handle: args.handle || slugify(args.name), avatar: { kind: 'initials', ...(args.initials ? { text: args.initials } : {}), color: args.color || COLORS[0] }, bio: args.bio };
      const changes = [];
      if (tool === 'bot_update') {
        for (const k of ['name', 'bio', 'persona', 'initials', 'color']) if (typeof args[k] === 'string') changes.push(t(`field_${k}`));
        if (Array.isArray(args.add_skills) && args.add_skills.length) changes.push(t('addedSkills', { names: args.add_skills.map((s) => s?.name).filter(Boolean).join(', ') }));
        if (Array.isArray(args.remove_skills) && args.remove_skills.length) changes.push(t('removedSkills', { names: args.remove_skills.join(', ') }));
        if (args.make_dispatcher === true) changes.push(t('madeDispatcher'));
      }
      const bio = face?.bio ?? args.bio;
      return h(
        ToolShell,
        { t, phase, block, title: t(`tool_${tool}`), env: tool === 'bot_delete' ? null : props.env, face },
        face
          ? h(
              'div',
              { 'data-dsh-bots-change': tool, style: { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', border: `1px solid ${C.border1}`, borderRadius: 12, background: C.layer1, maxWidth: 560, opacity: tool === 'bot_delete' && phase === 'result' && !block?.isError ? 0.6 : 1 } },
              h(Avatar, { avatar: face.avatar, name: face.name || face.handle, size: 34 }),
              h(
                'div',
                { style: { flex: 1, minWidth: 0 } },
                h(
                  'div',
                  { style: { display: 'flex', alignItems: 'center', gap: 6 } },
                  h('span', { style: { fontWeight: 600, textDecoration: tool === 'bot_delete' && phase === 'result' && !block?.isError ? 'line-through' : 'none' } }, face.name || face.handle),
                  face.handle ? h('span', { style: { color: C.faint, fontSize: TINY } }, `@${face.handle}`) : null,
                  face.role === 'primary' ? h('span', { style: { color: '#f5b301', display: 'inline-flex' } }, Icon.crown(11)) : null,
                ),
                changes.length ? h('div', { style: { fontSize: TINY, color: C.muted } }, changes.join(' · ')) : bio ? h('div', { style: { fontSize: TINY, color: C.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, bio) : null,
              ),
            )
          : null,
      );
    }

    function BotListView(props) {
      const t = typeof props.t === 'function' ? props.t : fallbackT;
      useStore();
      const { phase, block } = props;
      const meta = block?.meta && typeof block.meta === 'object' ? block.meta : {};
      const faces = (Array.isArray(meta.bots) ? meta.bots : []).map((f) => faceOf(f)).filter(Boolean);
      return h(
        ToolShell,
        { t, phase, block, title: t('tool_bot_list'), right: faces.length ? h('span', { style: { color: C.faint } }, t('nBots', { n: faces.length })) : null },
        faces.length
          ? h(
              'div',
              { 'data-dsh-bots-list': true, style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
              faces.map((f) =>
                h(
                  'button',
                  { key: f.id || f.handle, type: 'button', title: f.bio || '', className: 'dshb-chip', style: { height: 30, paddingLeft: 4 }, onClick: () => f.id && props.env?.showBot?.(f.id) },
                  h(Avatar, { avatar: f.avatar, name: f.name || f.handle, size: 22, status: f.status }),
                  h('span', { style: { color: C.primary, fontWeight: 600 } }, f.name || f.handle),
                  f.role === 'primary' ? h('span', { style: { color: '#f5b301', display: 'inline-flex' } }, Icon.crown(10)) : null,
                ),
              ),
            )
          : null,
      );
    }

    function ScheduleView(props) {
      const t = typeof props.t === 'function' ? props.t : fallbackT;
      useStore();
      const { phase, block } = props;
      const args = parseArgs(block);
      const meta = block?.meta && typeof block.meta === 'object' ? block.meta : {};
      const face = faceOf(meta.bot, args.bot);
      const task = meta.task && typeof meta.task === 'object' ? meta.task : null;
      const action = str(args.action) || 'list';
      let timing = task?.timing ?? null;
      if (!timing && args.kind) {
        const tz = args.time_zone || localZone();
        const time = args.time ? `${hhmm(args.time)}:00` : '';
        if (args.kind === 'daily') timing = { kind: 'daily', daily: { time, time_zone: tz } };
        else if (args.kind === 'weekly') timing = { kind: 'weekly', weekly: { time, time_zone: tz, weekdays: args.weekdays ?? [] } };
        else if (args.kind === 'every') timing = { kind: 'every', every_seconds: Number(args.every_minutes) * 60 };
        else if (args.kind === 'cron') timing = { kind: 'cron', cron: { expression: args.cron ?? '', time_zone: tz } };
        else if (args.kind === 'at') timing = { kind: 'at', at: args.at };
      }
      const title = task?.title || args.title;
      const text = phase === 'result' && action === 'list' && !block?.isError ? resultText(block) : '';
      return h(
        ToolShell,
        { t, phase, block, title: t('tool_bot_schedule'), env: props.env, face, right: h(Badge, { color: C.muted }, t(`schedAction_${action}`) || action) },
        h(
          'div',
          { 'data-dsh-bots-sched': action, style: { display: 'flex', gap: 10, alignItems: 'flex-start', padding: '8px 12px', border: `1px solid ${C.border1}`, borderRadius: 12, background: C.layer1, maxWidth: 560 } },
          h('span', { style: { width: 30, height: 30, borderRadius: 9, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: tint(C.label, 14), color: C.label, flex: 'none' } }, Icon.clock(15)),
          h(
            'div',
            { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 } },
            face ? h(FaceLine, { face, size: 16 }) : null,
            title ? h('div', { style: { fontWeight: 600 } }, title) : null,
            timing || task?.describe ? h('div', { style: { fontSize: SMALL, color: C.muted } }, describeTiming(t, timing, task?.describe)) : null,
            task?.scheduledAt && task.status === 'active' ? h('div', { style: { fontSize: TINY, color: C.faint } }, t('nextRun', { when: fmtAgo(t, task.scheduledAt) })) : null,
            text ? h(Clamp, { t, text, lines: 6, style: { fontSize: TINY, color: C.muted } }) : null,
            !title && !timing && !text && args.id ? h('div', { className: 'dshb-mono', style: { fontSize: TINY, color: C.faint } }, args.id) : null,
          ),
        ),
      );
    }

    // --- badges in the conversation header and the session list --------------------------

    function SessionBadge(props) {
      const t = typeof props.t === 'function' ? props.t : fallbackT;
      const s = useStore();
      const id = props.sessionId;
      // A task's own conversation (`ticket-<id>`): the badge names its bot and opens the task.
      const ticketId = /^ticket-(t[a-z0-9]{8})$/.exec(str(id))?.[1] ?? '';
      useEffect(() => {
        if (ticketId) void loadTicket(ticketId);
      }, [ticketId]);
      const view = ticketId ? (s.tickets.get(ticketId)?.view ?? null) : null;
      const botId = (id ? s.state?.sessionMap?.[id] : undefined) ?? view?.botId;
      const bot = botId ? botById(botId) : null;
      if (!bot) return null;
      return h(
        'button',
        {
          type: 'button',
          className: 'dshb',
          'data-dsh-bots-badge': bot.id,
          'data-dsh-bots-badge-task': ticketId || undefined,
          title: ticketId ? t('taskBadgeTitle', { name: bot.name, title: str(view?.title) || ticketId }) : t('badgeTitle', { name: bot.name }),
          onClick: () => (ticketId && props.env?.showTicket ? props.env.showTicket(ticketId) : props.env?.showBot?.(bot.id)),
          style: { display: 'inline-flex', alignItems: 'center', gap: 6, height: 26, padding: '0 9px 0 3px', borderRadius: 999, border: `1px solid ${C.border}`, background: C.layer1, color: C.primary, font: 'inherit', fontSize: SMALL, cursor: 'pointer', maxWidth: 220 },
        },
        h(Style),
        h(Avatar, { avatar: bot.avatar, name: bot.name || bot.handle, size: 20, status: bot.status === 'running' ? 'running' : undefined }),
        h('span', { style: { fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, bot.name || bot.handle),
        bot.role === 'primary' ? h('span', { style: { color: '#f5b301', display: 'inline-flex' } }, Icon.crown(10)) : null,
      );
    }
    function SessionRowAvatar(props) {
      const s = useStore();
      const id = props.sessionId;
      const botId = id ? s.state?.sessionMap?.[id] : undefined;
      const bot = botId ? botById(botId) : null;
      if (!bot) return null;
      return h('span', { 'data-dsh-bots-row-avatar': bot.id, title: `@${bot.handle}`, style: { display: 'inline-flex', alignItems: 'center', marginRight: 4, verticalAlign: 'middle' } }, h(Avatar, { avatar: bot.avatar, name: bot.name || bot.handle, size: 16 }));
    }

    // --- words ---------------------------------------------------------------------------------

    const DICTIONARY = {
      en: {
        lang: 'en',
        title: 'Bots',
        newBot: 'New bot',
        search: 'Search bots',
        noMatch: 'No bot matches.',
        noBotsShort: 'No bots yet.',
        noBio: 'No bio yet',
        dispatcher: 'Dispatcher',
        dispatcherHint: 'The dispatcher receives your requests and hands work to the other bots.',
        activity: 'Activity',
        activityHint: '{n} messages',
        activitySub: 'Every message between you, your bots and their schedules.',
        activityEmptyTitle: 'Nothing yet',
        activityEmptyBody: 'When bots message each other, or you message a bot, it shows up here.',
        filterBot: 'Filter by bot',
        allBots: 'All bots',
        status_running: 'Working',
        status_idle: 'Idle',
        status_offline: 'Offline',
        you: 'You',
        scheduler: 'Schedule',
        scheduled: 'Scheduled',
        toName: 'to {name}',
        today: 'Today',
        showMore: 'Show more',
        showLess: 'Show less',
        md_copy: 'Copy',
        md_copied: 'Copied',
        md_code: 'Code',
        md_wrap: 'Wrap lines',
        md_unwrap: 'No wrap',
        md_footnotes: 'Footnotes',
        link_play: 'Play video',
        link_open: 'Open the post',
        link_followers: 'followers',
        link_following: 'following',
        kind_dm: 'DM',
        kind_user: 'Request',
        kind_reply: 'Reply',
        kind_system: 'Schedule',
        loading: 'Loading…',
        unavailable: 'Bots are not reachable. Refresh the page, or check the plugin is enabled.',
        chatEmptyTitle: 'Say hi to {name}',
        chatEmptyBody: 'Messages you send land in this bot’s own conversation, where it works on them with its persona, skills and apps.',
        working: '{name} is working…',
        composer: 'Message @{handle}',
        composerHint: 'Enter to send · Shift+Enter for a new line',
        fullTranscript: 'Full transcript in its conversation',
        send: 'Send',
        sendFailed: 'Could not send the message.',
        openFailed: 'Could not open the conversation.',
        tab_chat: 'Chat',
        tab_profile: 'Profile',
        tab_skills: 'Skills',
        tab_schedules: 'Schedules',
        tab_apps: 'Apps',
        openConversation: 'Open conversation',
        setDispatcher: 'Set as dispatcher',
        nowDispatcher: '{name} is now the dispatcher.',
        more: 'More',
        copyHandle: 'Copy @handle',
        refresh: 'Refresh',
        deleteBot: 'Delete bot',
        deleteBotTitle: 'Delete {name}?',
        deleteBotBody: 'This removes {name}, its skills, apps and scheduled tasks, and archives its conversation. This cannot be undone.',
        deleted: '{name} deleted.',
        actionFailed: 'That did not work.',
        welcomeTitle: 'Build your team of bots',
        welcomeBody: 'Each bot has its own avatar, persona, skills, apps and schedules. Bots message each other, and one dispatcher hands out the work.',
        createFirst: 'Create your first bot',
        // profile
        secAvatar: 'Avatar',
        secIdentity: 'Identity',
        name: 'Name',
        namePlaceholder: 'e.g. Ada',
        handle: 'Handle',
        handleHint: 'Lowercase letters, digits and dashes. Other bots reach it as @handle.',
        handleInvalid: 'Use lowercase a–z, 0–9 and dashes, starting with a letter or digit.',
        handleTaken: 'Another bot already uses this handle.',
        bio: 'Bio',
        bioHint: 'One line shown on its card and to other bots.',
        bioPlaceholder: 'What this bot is good at',
        persona: 'Persona',
        personaHint: 'Who the bot is and how it works — its system prompt. Start from a template or write your own.',
        personaPlaceholder: 'You are …',
        model: 'Model',
        modelHint: 'The model this bot’s conversation uses.',
        modelDefault: 'Default (DSH setting)',
        toolAccess: 'Tool access',
        toolAccessHint: '{allowed} of {total} DSH tools allowed. Unchecked tools are hidden from this bot.',
        allowAll: 'Allow all',
        denyAll: 'Deny all',
        filterTools: 'Filter tools',
        noTools: 'No tools listed.',
        uploading: 'Uploading…',
        uploadImage: 'Upload image',
        useLetters: 'Use letters instead',
        customColor: 'Custom colour',
        avatarColour: 'Colour',
        avatarLetters: 'Letters',
        avatarLettersHint: 'Up to 2. Empty uses “{letters}” from the name.',
        avatarPicture: 'Picture',
        generateAi: 'Generate with AI',
        generate: 'Generate',
        generateStyleHint: 'Optional style notes — the picture is drawn from the bot’s name, bio and persona.',
        generateStylePlaceholder: 'e.g. watercolour fox, flat icon, pixel art',
        generatingAvatar: 'Generating… (up to a minute)',
        avatarGenerated: 'New avatar drawn.',
        avatarGenFailed: 'Could not generate the avatar: {reason}',
        imageGenMissing: 'Install the Images plugin to generate avatars with AI.',
        avatarType: 'Use a PNG, JPEG, WebP or GIF image.',
        avatarSize: 'The image is larger than 2 MB.',
        avatarReadFailed: 'Could not read that file.',
        avatarSaved: 'Avatar updated.',
        unsaved: 'Unsaved changes',
        allSaved: 'All changes saved',
        discard: 'Discard',
        save: 'Save',
        saving: 'Saving…',
        saved: 'Saved.',
        saveFailed: 'Could not save.',
        cancel: 'Cancel',
        close: 'Close',
        // personas
        startFrom: 'Start from',
        persona_researcher: 'Researcher',
        persona_coder: 'Coder',
        persona_writer: 'Writer',
        persona_analyst: 'Analyst',
        persona_ops: 'Ops',
        persona_custom: 'Custom',
        personaBio_researcher: 'Digs into questions and reports back with sources.',
        personaBio_coder: 'Writes, reviews and fixes code.',
        personaBio_writer: 'Drafts and polishes clear, engaging prose.',
        personaBio_analyst: 'Turns data into numbers, charts and decisions.',
        personaBio_ops: 'Keeps things running: checks, chores and follow-ups.',
        personaBio_custom: '',
        personaText_researcher:
          'You are {name}, a meticulous research assistant. Break questions into parts, search widely, compare sources, and say how sure you are. Report findings concisely with links, and separate facts from inferences.',
        personaText_coder:
          'You are {name}, a pragmatic senior engineer. Read the code before changing it, make the smallest correct change, run the tests, and explain what you did and why. Prefer clarity over cleverness.',
        personaText_writer:
          'You are {name}, a skilled writer and editor. Match the audience and tone you are given, keep sentences tight and concrete, and offer a short rationale with every draft.',
        personaText_analyst:
          'You are {name}, a careful data analyst. Clarify the question, check the data before trusting it, show your calculations, and end with a clear recommendation and its caveats.',
        personaText_ops:
          'You are {name}, a reliable operations assistant. Run routine checks, keep a short log of what you did, flag anything unusual right away, and follow up until each task is closed.',
        personaText_custom: 'You are {name}. ',
        newBotTitle: 'New bot',
        createBot: 'Create bot',
        creating: 'Creating…',
        created: '{name} is ready.',
        // skills
        botSkills: 'Skills ({n})',
        skillsHint: 'Instructions {name} loads when a task needs them.',
        addSkill: 'Add skill',
        newSkill: 'New skill',
        editSkill: 'Edit skill',
        skillName: 'Name',
        skillDescription: 'Description',
        skillDescriptionHint: 'When should the bot use it? One sentence.',
        skillContent: 'Instructions (Markdown)',
        skillContentHint: 'Steps, checklists, examples — whatever the bot should follow.',
        skillContentPlaceholder: '# Weekly report\n\n1. Collect …\n2. Summarise …',
        saveSkill: 'Save skill',
        skillSaved: 'Skill saved.',
        skillDeleted: 'Skill deleted.',
        deleteSkillTitle: 'Delete the skill “{name}”?',
        deleteSkillBody: 'The bot stops using these instructions.',
        noSkillsTitle: 'No skills yet',
        noSkillsBody: 'Teach this bot a repeatable procedure — a report format, a review checklist, a house style.',
        noDescription: 'No description',
        chars: '{n} characters',
        sharedSkills: 'Shared DSH skills available',
        sharedSkillsHint: 'Every bot can use these skills installed in DSH.',
        noSharedSkills: 'No shared skills installed.',
        enable: 'Enable',
        disable: 'Disable',
        edit: 'Edit',
        delete: 'Delete',
        remove: 'Remove',
        // schedules
        schedulesTitle: 'Scheduled tasks ({n})',
        schedulesHint: 'At each time the instruction is delivered to {name}’s conversation.',
        newSchedule: 'New schedule',
        editSchedule: 'Edit schedule',
        createSchedule: 'Create schedule',
        noSchedulesTitle: 'Nothing scheduled',
        noSchedulesBody: 'Have this bot do something on its own — a morning brief, an hourly check, a weekly report.',
        taskTitle: 'Title',
        taskTitlePlaceholder: 'Morning brief',
        taskPrompt: 'Instruction',
        taskPromptHint: 'Delivered to the bot each time; make it self-contained.',
        taskPromptPlaceholder: 'Summarise the news I care about and send it to me.',
        when: 'When',
        mode_at: 'Once',
        mode_every: 'Every…',
        mode_daily: 'Daily',
        mode_weekly: 'Weekly',
        mode_cron: 'Custom (cron)',
        onceAt: 'Date and time',
        every: 'Every',
        minutes: 'minutes',
        hours: 'hours',
        atTime: 'At',
        timeZone: 'Time zone',
        cronExpr: 'Cron expression',
        cronHint: 'Five fields: minute hour day month weekday.',
        errAt: 'Pick a date and time.',
        errEvery: 'Use an interval of at least one minute.',
        errTime: 'Pick a time.',
        errWeekdays: 'Pick at least one weekday.',
        errCron: 'A cron expression has five fields.',
        errTitlePrompt: 'Give it a title and an instruction.',
        scheduleCreated: 'Schedule created.',
        scheduleUpdated: 'Schedule updated.',
        scheduleDeleted: 'Schedule deleted.',
        deleteScheduleTitle: 'Delete “{title}”?',
        deleteScheduleBody: 'It will not run again.',
        untitled: 'Untitled',
        taskStatus_active: 'Active',
        taskStatus_paused: 'Paused',
        taskStatus_ended: 'Ended',
        runningNow: 'Running',
        nextRun: 'Next {when}',
        lastRun: 'Last ran {when}',
        neverRun: 'Not run yet',
        pause: 'Pause',
        resume: 'Resume',
        paused: 'Paused.',
        resumed: 'Resumed.',
        runNow: 'Run now',
        ranNow: 'Started.',
        timingDaily: 'Every day {time} ({zone})',
        timingWeekly: '{days} {time} ({zone})',
        timingEveryMinutes: 'Every {n} min',
        timingEveryHours: 'Every {n} h',
        timingEveryDays: 'Every {n} d',
        timingCron: 'Cron “{expr}” ({zone})',
        timingAt: 'Once at {when}',
        timingRrule: 'Repeats: {rule}',
        timingUnknown: 'Custom timing',
        everyDay: 'Every day',
        weekdays: 'Weekdays',
        listSep: ', ',
        wd1: 'Mon',
        wd2: 'Tue',
        wd3: 'Wed',
        wd4: 'Thu',
        wd5: 'Fri',
        wd6: 'Sat',
        wd7: 'Sun',
        justNow: 'just now',
        inMoment: 'in a moment',
        agoMin: '{n} min ago',
        agoHour: '{n} h ago',
        agoDay: '{n} d ago',
        inMin: 'in {n} min',
        inHour: 'in {n} h',
        inDay: 'in {n} d',
        // apps
        appsNote: 'Changes apply the next time the bot’s conversation starts.',
        mcpMissing: 'This DSH has no MCP support, so apps cannot run yet.',
        installedApps: 'Installed apps ({n})',
        noApps: 'No apps yet. Add one from the gallery below.',
        appGallery: 'App gallery',
        appGalleryHint: '{n} apps. Most are MCP servers whose tools appear to this bot only; chat apps (Feishu / Lark, Telegram, Slack, Discord) let you message the team from your phone.',
        noTemplates: 'No templates.',
        featured: 'Featured',
        allApps: 'All',
        searchApps: 'Search apps',
        noAppMatch: 'No app matches “{q}”.',
        regionCn: 'China',
        getKey: 'Get key',
        docs: 'Docs',
        runtimeRemote: 'remote',
        runtimeBinary: 'binary',
        needsSetup: 'Needs setup',
        configure: 'Configure',
        configureTitle: 'Configure {name}',
        addNamedApp: 'Add {name}',
        noSettings: 'This app needs no settings.',
        showSecret: 'Show',
        hideSecret: 'Hide',
        pathHint: 'A full path on this computer.',
        advanced: 'Advanced',
        fieldsRequired: 'Fill in the fields marked *.',
        ocuInstalled: 'Installed',
        ocuMissing: 'Not installed',
        ocuBlurb: 'Lets the bot see and control your Mac through the kadaliao/open-computer-use MCP server.',
        ocuInstallTitle: 'Install Open Computer Use',
        ocuStep3: 'Then grant DeepSeek Harness Accessibility (and Screen Recording, for screenshots) in System Settings → Privacy & Security.',
        ocuInstallNow: 'Install now',
        ocuInstalling: 'Installing…',
        ocuRecheck: 'Check again',
        ocuInstallDone: 'Open Computer Use {version} installed',
        ocuInstallFailed: 'Install failed',
        ocuInstallWhat: 'Adding the app only connects it to this bot; the program itself is not on this Mac yet. Install downloads the latest release from GitHub to',
        ocuAddedNotInstalled: 'Added, but the program is not installed yet',
        ocuReady: 'Installed at {path}. Running bots reconnect it now; make sure DeepSeek Harness has Accessibility permission.',
        add: 'Add',
        added: 'Added',
        appAdded: '{name} added.',
        appSaved: 'App saved.',
        appRemoved: 'App removed.',
        removeAppTitle: 'Remove {name}?',
        removeAppBody: 'The bot loses this app’s tools the next time its conversation starts.',
        addAppTitle: 'Add app',
        editAppTitle: 'Edit app',
        appName: 'Display name',
        serverName: 'Server name',
        serverNameHint: 'Tools appear as mcp__{name}__*.',
        serverNameInvalid: 'Use 1–32 letters, digits, _ or -.',
        serverNameTaken: 'Another app of this bot uses that server name.',
        command: 'Command',
        commandRequired: 'Give the command that starts the server.',
        args: 'Arguments',
        argsHint: 'One per line.',
        env: 'Environment',
        envHint: 'KEY=VALUE, one per line.',
        url: 'URL',
        urlRequired: 'Give an http(s) URL.',
        headers: 'Headers',
        headersHint: 'Name: value, one per line.',
        // tool views
        preparing: 'preparing…',
        running: 'running…',
        failed: 'That did not work.',
        delivered: 'Delivered',
        viewInBots: 'View in Bots',
        toolSend: 'Message',
        tool_bot_create: 'Created bot',
        tool_bot_update: 'Updated bot',
        tool_bot_delete: 'Deleted bot',
        tool_bot_list: 'Bots',
        tool_bot_schedule: 'Schedule',
        nBots: '{n} bots',
        field_name: 'name',
        field_bio: 'bio',
        field_persona: 'persona',
        field_initials: 'avatar letters',
        field_color: 'colour',
        addedSkills: '+ skills: {names}',
        removedSkills: '− skills: {names}',
        madeDispatcher: 'now the dispatcher',
        schedAction_create: 'create',
        schedAction_list: 'list',
        schedAction_update: 'update',
        schedAction_delete: 'delete',
        schedAction_pause: 'pause',
        schedAction_resume: 'resume',
        schedAction_run: 'run now',
        badgeTitle: 'This is {name}’s conversation — open it in Bots',
        otherBots: "Other",
        blankBot: "Blank bot",
        fromTeam: "From a team template",
        teamTemplates: "Team templates",
        teamTemplatesHint: "Hire a ready-made team",
        teamTemplatesSub: "Each team comes with personas, Harness skills, apps and scheduled tasks. Anything this Harness lacks is skipped.",
        teamsHeroTitle: "Build your bot team",
        teamsHeroBody: "Hire a ready-made team for a one-person company or a job that needs several roles. Each bot arrives with its persona, the skills already in your Harness, apps and a routine, and a lead that hands out the work.",
        noTeams: "No team templates.",
        orBlank: "Prefer to start from scratch?",
        teamDaily: "Daily {time}",
        teamWeekdays: "Weekdays {time}",
        teamWeekly: "Every {days} {time}",
        teamCounts: "{bots} bots · {skills} skills · {tasks} scheduled tasks",
        hireTeam: "Hire this team",
        teamDetails: "Details",
        teamTasks: "Routine",
        skillNotInstalled: "Not installed in this Harness — will be skipped",
        skillNotInstalledShort: "not installed in this Harness",
        srcHarnessHint: "Installed in this Harness; stays up to date",
        appNotInCatalog: "not in the app catalog",
        appKeyLater: "keys are filled in later",
        legendHarness: "Harness skill",
        legendGithub: "imported from GitHub",
        legendMissing: "not installed, skipped",
        leadAsDispatcher: "Make the team lead the dispatcher",
        hireFailed: "Could not hire the team.",
        hireTitle: "Hire {name}",
        hireConfirmBody: "This adds {n} bots next to the ones you have. Their skills, apps and scheduled tasks are set up for you.",
        hiring: "Building your team… (importing skills from GitHub)",
        hiringHint: "This usually takes 10–30 seconds.",
        retry: "Try again",
        hiredTitle: "{name} is ready",
        later: "Later",
        sendKickoff: "Send the kickoff to {name}",
        hiredBots: "Hired {n} bots",
        kickoffLabel: "Kickoff message",
        needKeysTitle: "Apps that still need a key",
        fillKey: "Fill in",
        skippedTitle: "Skipped {n} items",
        skippedKind_skill: "Skills",
        skippedKind_app: "Apps",
        skippedKind_schedule: "Scheduled tasks",
        abilities: "Abilities",
        abilitiesHint: "What {name} can do with the Harness’s built-in tools. Turning one off hides its tools from this bot only.",
        risky: "Use with care",
        nTools: "{n} tools",
        advancedTools: "Advanced: per tool ({allowed} of {total} allowed)",
        harnessPickerTitle: "Add skills from this Harness",
        harnessPickerNote: "Linked by name, never copied: they stay up to date.",
        addN: "Add {n}",
        searchSkills: "Search {n} installed skills",
        noSkillMatch: "No skill matches.",
        githubPickerTitle: "Import skills from GitHub",
        githubNote: "The whole skill folder is copied, scripts included.",
        githubFailed: "Could not read that repository.",
        importN: "Import {n}",
        importing: "Importing…",
        importedN: "Imported {n} skills.",
        updatedN: "Updated {n}.",
        skippedN: "Skipped {n}: a skill of that name is already here.",
        fullN: "Skipped {n}: a bot keeps at most {max} skills.",
        offN: "{n} came in switched off: at most {max} skills can be on at once.",
        tooManyOn: "At most {max} skills can be on at once. Switch one off first.",
        skillsFull: "A bot keeps at most {max} skills. Remove one first.",
        skillsRoom: "A bot keeps at most {max} skills; there is room for {n} more.",
        skillsOnOf: "{n}/{max} on",
        nameTaken: "Name already used",
        reimport: "Imported · import again to update",
        skillNameTaken: "This bot already has a skill named “{name}”.",
        importLocal: "Add from a folder",
        localPickerTitle: "Add skills from a local folder",
        localHint: "Pick a skill folder (one with a SKILL.md), or a folder that holds several.",
        localNote: "Linked, never copied: edit the folder and the bot uses the new version.",
        linked: "Linked",
        linkedHint: "Read from this folder each time; edit it there.",
        folderMissing: "Folder not found",
        localFailed: "Could not read that folder.",
        localNone: "No SKILL.md in this folder or the folders below it.",
        localTruncated: "The folder is large; only part of it was searched. Pick a folder closer to the skills.",
        localPlaces: "Found on this machine:",
        chooseFolder: "Choose folder…",
        pickFailed: "The folder dialog is unavailable here; type or paste the path instead.",
        scan: "Scan",
        readingFolder: "Reading the folder…",
        alsoInHarness: "A skill of this name is also installed in the Harness (see “Add from Harness”).",
        src_local: "Local",
        importFailed: "Import failed.",
        browse: "Browse",
        foundSkills: "{n} skills",
        selectAll: "Select all",
        selectNone: "Select none",
        nFiles: "{n} files",
        readingRepo: "Reading the repository…",
        writeSkillTitle: "Let {name} write a skill",
        writeSkillHint: "Describe what the skill should do. The bot writes it in its own conversation (with skill-creator when available) and saves it here.",
        writeSkillPlaceholder: "Describe the skill you want, e.g. every Monday, put last week’s Stripe revenue into a spreadsheet and send it to me",
        writeSkillGo: "Ask it to write",
        sending: "Sending…",
        writeSent: "Handed to {name}; the skill shows up here when it is written.",
        addedN: "Added {n} skills.",
        addFromHarness: "Add from Harness",
        importGithub: "Import from GitHub",
        letBotWrite: "Let the bot write it",
        writeByHand: "Write by hand",
        skillsHint2: "Instructions {name} loads when a task needs them.",
        skillMix: "{dsh} Harness · {import} GitHub · {local} local · {own} own",
        noSkillsBody2: "Add skills already installed in your Harness, import a folder from GitHub or from this machine, or describe one and let the bot write it.",
        harnessManaged: "Provided by the Harness, kept up to date",
        src_dsh: "Harness",
        src_import: "GitHub",
        src_own: "Own",
        libSource_user: "user",
        libSource_project: "project",
        libSource_bundled: "bundled",
        libSource_plugin: "plugin",
        importOtherAgents: "Import from your other agents",
        foundExternal: "Found {n} MCP servers ({from})",
        chooseImport: "Choose…",
        importedApps: "Imported {n} apps.",
        externalNote: "Copied with their keys; values are masked here.",
        alreadyImported: "Already added",
        suggest_p1: "Here is what I am working on this week. Help me plan it and hand out the work.",
        suggest_p2: "Ask everyone for a status update and give me a short summary.",
        suggest_p3: "What do you need to know about my business to be useful?",
        suggest_b1: "Introduce yourself: what can you do for me, and what do you need from me?",
        suggest_b2: "Look at what is on your plate and suggest the first thing to do today.",
        suggest_b3: "Show me which of your skills and apps are ready, and which still need setup.",
        // chat channels
        chatChannel: 'chat app',
        createChatBot: 'Create a bot',
        channelHow: 'Add it to your dispatcher. Once it connects, pair yourself with the one-time code shown here; then message the bot in {app} to hand out work, and the replies come back to the chat.',
        channelSaveNote: 'It connects as soon as you save.',
        channelConnected: 'Connected as {handle}',
        channelConnecting: 'Connecting to {app}…',
        channelError: 'Not connected',
        channelOff: 'Off. Turn it on to connect.',
        channelMissing: 'Paste the bot token to connect to {app}.',
        channelHint_token: '{app} rejected the bot token. Copy it again and save.',
        channelHint_intent: 'Turn on Message Content Intent: Developer Portal → your app → Bot → Privileged Gateway Intents. Then reconnect.',
        channelHint_conflict: 'Another program is using this bot token. Stop it, or create a separate bot for the team.',
        channelHint_duplicate: 'This token is already connected on another bot; one token can run in one place.',
        channelHint_app_token: 'Slack rejected the app-level token (xapp-…). In your Slack app open Basic Information → App-Level Tokens, generate one with the connections:write scope, paste it and save.',
        channelHint_app_scope: 'The app-level token lacks the connections:write scope. Generate a new one with it under Basic Information → App-Level Tokens, paste it and save.',
        channelHint_token_kind: 'The tokens are in the wrong fields: the Bot token starts with xoxb- (OAuth & Permissions), the App-level token with xapp- (Basic Information → App-Level Tokens).',
        channelHint_slack_scopes: 'The Slack app is missing permissions. Add them under OAuth & Permissions → Bot Token Scopes (or create the app from the manifest), reinstall it to the workspace, then reconnect.',
        channelHint_socket_mode: 'Socket Mode is off for this Slack app. Turn it on (your app → Socket Mode → Enable Socket Mode), then reconnect.',
        channelHint_secret: '{app} rejected the App Secret. Copy it again from the developer console (Credentials & Basic Info) and save.',
        channelHint_appId: 'Neither Feishu nor Lark knows this App ID. Copy it from the developer console (Credentials & Basic Info); it starts with cli_.',
        channelHint_disabled: '{app} says this app is disabled. Enable it in the developer console (or ask your admin), then reconnect.',
        channelHint_bot: 'Turn on the bot: developer console → Add Features → Bot, then publish a version. The long connection is already up, so you can set up Events & Callbacks now; this connects by itself once the bot is live.',
        channelHint_feishu_scopes: 'The app may not send messages. Add the permission im:message:send_as_bot (Permissions & Scopes) and publish a version.',
        channelHint_connlimit: 'This app already has the most long connections Feishu allows (50). Stop other programs that use this App ID.',
        reconnect: 'Reconnect',
        pairedPeople: 'Paired people ({n})',
        nobodyPaired: 'Nobody yet. Until someone is paired, the bot answers no one in {app}.',
        pairedFirst: 'gets scheduled reports',
        pairedSince: 'since {when}',
        unpaired: '{name} removed.',
        pairStepTelegram: 'From your own Telegram account, send this code to {handle}, or open the link and press Start. It works once.',
        pairStepDiscord: 'From your own Discord account, send this code to {handle} in a direct message. It works once.',
        pairStepFeishu: 'In Feishu, open a chat with {handle} (search for the app, or use Open in Feishu) and send this code. It works once.',
        pairStepSlack: 'From your own Slack account, open the app\'s Messages tab (or the link) and send this code. It works once.',
        pairStep: 'From your own {app} account, send this code to {handle}. It works once.',
        copy: 'Copy',
        copied: 'Copied.',
        openIn: 'Open in {app}',
        codeExpires: 'expires {when}',
        newCode: 'New code',
        pairSomeone: 'Pair yourself',
        pairAnother: 'Pair another person',
        pairWhenConnected: 'Pairing starts once it is connected.',
        inviteDiscord: 'Invite the bot to a server you are in (needed before you can DM it)',
        channelSchedules: 'Scheduled reports also go to {name} in {app}',
        channelIgnored: 'Ignored {n} messages from people who are not paired (last: {name}).',
        channelPrivate: 'Only paired people reach the team. Anyone else is ignored (at most a one-line "this bot is private" a day). In a group the bot only answers when @mentioned or replied to.',
        viaChannel: '{app} · {who}',
        sentToChannel: 'Also sent to {app}',
        threadPart: 'thread',
        threadTopic: 'topic',
        notSent: 'Not sent',
        notSentChats: 'Not sent to any chat: this turn involved several ({chats}).',
        // tasks
        tasks: 'Tasks',
        tasksHint: 'Work handed to your bots',
        tasksNeedYou: '{n} need you',
        tasksInProgress: '{n} in progress',
        tasksSub: 'Work your bots have taken on. Each task runs in its own conversation, so several move at once.',
        tasksNeeds: 'Needs you',
        tasksNeedsEmpty: 'Nothing needs you right now.',
        tasksProgress: 'In progress',
        tasksProgressEmpty: 'Nothing is in progress.',
        tasksDone: 'Recently done',
        tasksDoneEmpty: 'Nothing finished yet.',
        tasksUnavailable: 'Could not load the tasks.',
        tasksEmptyTitle: 'No tasks yet',
        tasksEmptyBotTitle: 'No tasks for {name} yet',
        tasksEmptyBody: 'When the dispatcher hands work to a teammate, it shows up here as a task you can follow, answer and stop.',
        untitledTask: 'Untitled task',
        openTask: 'Open task',
        followUpTask: 'Went to its task',
        followUpHint: 'A follow-up in the chat a task came from goes straight to that task.',
        taskOf: 'Task · {name}',
        stage_question: 'Needs your answer',
        stage_failed: 'Failed',
        stage_stalled: 'Stuck',
        stage_queued: 'Queued',
        stage_working: 'Working',
        stage_done: 'Done',
        stage_stopped: 'Stopped',
        report_progress: 'Progress',
        report_done: 'Done',
        report_blocked: 'Blocked',
        report_question: 'Question',
        askedByYou: 'asked by you',
        askedBy: 'asked by {name}',
        viaPanel: 'Panel',
        kind_report: 'Report',
        allTasks: 'All tasks',
        taskMissing: 'This task is not available. It may have been archived.',
        taskStarted: 'started {when}',
        taskNoConversation: 'It has not started yet.',
        taskRetry: 'Retry',
        taskClose: 'Mark done',
        taskStop: 'Stop',
        taskDid_stop: 'Task stopped.',
        taskDid_retry: 'Task started again.',
        taskDid_close: 'Task marked done.',
        taskStopTitle: 'Stop “{title}”?',
        taskStopBody: '{name} stops working on it now. You can retry it later.',
        taskCloseTitle: 'Mark “{title}” done?',
        taskCloseBody: '{name} stops working on it, and the task counts as done.',
        taskFactBot: 'Bot',
        taskFactAsked: 'Asked by',
        taskFactFrom: 'From',
        fromPanel: 'The Bots panel',
        taskFactUpdated: 'Last update',
        taskAsked: 'What was asked',
        taskReports: 'Reports',
        taskNoReports: 'No report yet. {name} reports when it is done, stuck, or has a question.',
        taskRelated: 'Related tasks',
        taskParent: 'Part of',
        taskChildren: 'Sub-tasks ({n})',
        taskUsage: 'Usage',
        taskNoUsage: 'No model calls yet.',
        taskArchived: 'This task is archived. A new message in its chat goes to the dispatcher.',
        taskMessageLabel: 'Message to this task',
        taskMessagePlaceholder: 'Add to this task…',
        taskAnswerPlaceholder: 'Answer {name}…',
        taskMessageHint: '{name} reads it in the task’s own conversation · Enter to send',
        taskMessageSent: 'Sent to {name}.',
        taskBadgeTitle: 'A task of {name}: {title} — open it in Bots',
        tab_tasks: 'Tasks',
        botOpenTasks: 'Open tasks',
        botOpenTasksHint: 'What {name} is working on, each in its own conversation.',
        allTasksOf: 'All tasks',
        botNoOpenTasks: '{name} has no open tasks.',
        toolReport: 'Report',
        requesterShort: 'whoever asked',
        // the dispatcher's mode
        dispatcherMode: 'How it works',
        dispatcherModeHint: 'For the whole team. Each piece of work the dispatcher hands out becomes a task with its own conversation.',
        modeRouter: 'Router',
        modeRouterBody: 'Understands, hands out, reports. Teammates do the work.',
        modeHandsOn: 'Hands-on',
        modeHandsOnBody: 'Also does small things itself, as before.',
        modeSavedRouter: '{name} now only hands out the work.',
        modeSavedHandsOn: '{name} does small things itself again.',
        routerModelHint: 'In Router mode it only understands, hands out and reports, so a light, fast model is enough, and every request stays quick and cheap.',
        routerWaiting: 'Router mode starts once the team has another bot; until then {name} does the work itself.',
        abilitiesRouterHint: 'What {name} can do with the Harness’s built-in tools. In Router mode it does not run commands, write files, use sub-agents, draw or make Office files; turn one back on below if it needs it.',
        routerOff: 'Off in Router mode',
        routerPartOff: 'Partly off in Router mode',
        routerAllowed: 'On in Router mode',
        routerAllowBack: 'Turn back on',
        routerOffShort: 'off in Router mode',
        routerNoticeTitle: 'Your dispatcher now hands out the work',
        routerNoticeBody: 'It listens, hands each request to a teammate as a task and reports back; every task runs in its own conversation, so several can move at once. To let it do small jobs itself again, open its profile and set How it works to Hands-on.',
        routerNoticeOpen: 'Open its profile',
        routerNoticeOk: 'Got it',
        setTasks: 'Tasks',
        setMaxWorking: 'Tasks worked on at once',
        setMaxWorkingHint: 'More wait in line. A follow-up from you can use one extra.',
        setStall: 'Minutes before a quiet task counts as stuck',
        setStallHint: 'A working task quiet this long is asked for a report; still quiet after that, it is marked stuck.',
        setArchive: 'Hours before a finished task’s conversation is archived',
        setArchiveHint: 'Until then, a new message in its chat thread picks the task up again.',
        // Usage, memory, topics, settings, model sources
        settings: 'Settings',
        usage: 'Usage',
        usageHint: '{tokens} tokens today',
        usageSub: 'Tokens and estimated cost of every bot, task and day: conversations, memory work and context compaction.',
        usageChart: 'Tokens by bot',
        other: 'Other',
        removedBot: 'Removed bot',
        range_today: 'Today',
        range_7d: '7 days',
        range_30d: '30 days',
        range_90d: '90 days',
        range_all: 'All',
        prices: 'Prices',
        tileTokens: 'Tokens',
        tileCacheRate: '{pct}% of input from cache',
        tileCost: 'Estimated cost',
        tileUnpriced: '{tokens} tokens have no price',
        tileRuns: 'Runs',
        tileCalls: 'Model calls',
        tileInOut: '{input} in · {output} out',
        vsPrev: '{delta} vs the period before',
        noUsage: 'No model calls in this period yet.',
        byBot: 'By bot',
        byModel: 'By model',
        byKind: 'By kind of work',
        bySchedule: 'Scheduled tasks',
        recentRuns: 'Recent runs',
        byTask: 'By task',
        colBot: 'Bot',
        colTask: 'Task',
        colRunCount: 'Runs',
        colRun: 'Run',
        colTokens: 'Tokens',
        colCost: 'Cost',
        colCalls: 'Calls',
        colModel: 'Model',
        colRuns: 'Runs',
        colWhen: 'When',
        work_chat: 'Conversations',
        work_memory: 'Memory summaries',
        work_compaction: 'Context compaction',
        work_dream: 'Daily consolidation',
        trigger_user: 'From you',
        trigger_chat: 'From {app}',
        trigger_schedule: 'Scheduled',
        trigger_dm: 'From @{handle}',
        taskRunning: 'Running',
        taskState_error: 'Failed',
        taskState_stopped: 'Stopped',
        setPrice: 'Set price',
        pricesTitle: 'Model prices',
        pricesHint: 'Costs are estimates: tokens × the price per million tokens. Your own prices come first, then LiteLLM’s public price list ({count} models, fetched {when}). Gateways and subscriptions may bill differently.',
        priceInput: 'Input / 1M',
        priceCached: 'Cached input / 1M',
        priceOutput: 'Output / 1M',
        priceCurrency: 'Currency',
        priceSource_user: 'Your price',
        priceNone: 'No price',
        usePriceList: 'Use the price list',
        refreshPriceList: 'Refresh the price list',
        priceSaved: 'Price saved',
        tab_memory: 'Memory',
        memoryOf: 'What {name} remembers',
        memoryHint: 'Notes kept across conversations and topics. {name} writes them itself, after every task and whenever you ask it to remember something; edit them here. Pinned notes are never changed by the automatic passes.',
        memoryModelIs: 'Memory work runs on {model}',
        botsOwnModel: 'each bot’s own model',
        addNote: 'Add a note…',
        noteSaved: 'Note saved',
        filterNotes: 'Filter notes',
        noNotes: 'Nothing remembered yet. Notes appear after tasks, or add one.',
        note_fact: 'Fact',
        note_preference: 'Preference',
        note_person: 'Person',
        note_project: 'Project',
        note_procedure: 'How-to',
        note_lesson: 'Lesson',
        src_auto: 'after a task',
        src_tool: 'saved by the bot',
        src_user: 'written by you',
        src_dream: 'consolidated',
        pin: 'Pin',
        unpin: 'Unpin',
        recentWork: 'Recent work',
        recentWorkHint: 'One line per finished task, written when it ends.',
        noJournal: 'No finished tasks yet.',
        topicsTitle: 'Topics',
        topicsHint: 'Each topic is a fresh conversation, so the context never grows without end. A new one starts when you send /new, after a long quiet, or once the conversation grows large (see Settings). Memory carries over.',
        topicNow: 'Current topic: started {when} · runs: {n} · last prompt {ctx} tokens',
        topicShort: 'This topic: {ctx} context · runs: {n}',
        newTopic: 'New topic',
        newTopicHint: 'Start a fresh conversation; memory carries over. You can also send /new.',
        newTopicDone: '{name} starts a new topic',
        topicDivider: 'New topic · {reason}',
        topicReason_manual: 'started by you',
        topicReason_idle: 'after a quiet spell',
        topicReason_context: 'the conversation grew large',
        pastTopic: '{from} – {to} · runs: {n}',
        kind_topic: 'New topic',
        teamMemoryTitle: 'Team memory',
        teamMemoryHint: '{n} shared notes · daily digest',
        teamNotes: 'Shared notes',
        teamNotesHint: 'Every bot reads these. They hold what all of them should know: about you, your business, shared conventions.',
        digests: 'Daily digests',
        digestsHint: 'Each day the team’s work is written up; every bot reads the latest one.',
        noDigests: 'No digest yet.',
        teamJournal: 'Team journal',
        dreamNow: 'Consolidate now',
        dreaming: 'Consolidating…',
        dreamDone: 'Consolidated {bots} bots{digest}',
        dreamDigest: ' and wrote the digest',
        dreamPartly: 'Consolidation finished with a problem: {reason}',
        lastDream: 'Last consolidated {when}',
        dreamDaily: 'every day at {time}',
        neverDreamed: 'Not consolidated yet; it runs every day at {time}.',
        dreamOff: 'Daily consolidation is off.',
        settingsTitle: 'Bots settings',
        settingsSaved: 'Settings saved',
        setTopics: 'Topics',
        setIdle: 'New topic after this many quiet hours',
        setIdleHint: 'Checked before the next task. 0 = never.',
        setContext: 'New topic at this context size (thousand tokens)',
        setContextHint: 'Harness also compacts a conversation near the model’s limit; a new topic keeps every call small and cheap. 0 = never.',
        setMemory: 'Memory',
        setAuto: 'Summarize every task into memory',
        setAutoHint: 'One short model call per finished task. Off: only a one-line journal entry.',
        setMemoryModel: 'Model for memory work',
        setMemoryModelHint: 'Summaries and consolidation; a small, cheap model is enough.',
        setDream: 'Consolidate every day',
        setDreamHint: 'Merges repeated notes, drops stale ones and writes the team’s daily digest.',
        modelSources: 'Model sources',
        modelDefaultIs: 'Harness default ({model})',
        modelContext: 'context window {k} tokens',
        reasoning: 'Thinking',
        effortDefault: 'default',
        msrc_custom: 'your endpoint',
        msrc_login: 'subscription',
        sourcesTitle: 'Model sources',
        sourcesIntro: 'A bot can run on any model Harness has. Add your own endpoint, or use a login another agent on this computer already has. Both become Harness providers, so they also appear in Settings → Models and in every conversation’s model picker.',
        notWritable: 'This Harness does not let plugins change its model settings.',
        endpoints: 'Your endpoints',
        noEndpoints: 'None yet.',
        addEndpoint: 'Add endpoint',
        editEndpoint: 'Edit endpoint',
        epName: 'Name',
        epApi: 'API',
        epBase: 'Base URL',
        epKey: 'API key',
        epKeyHint: 'Kept in the Harness credential store and never shown again. Any text for a local server that needs none.',
        epKeyKeep: 'Leave empty to keep the saved key',
        epModels: 'Models',
        epModelsHint: 'One model id per line, or fetch the list from the endpoint and tick the ones you want.',
        fetchModels: 'Fetch models',
        fetching: 'Fetching…',
        fetchedN: '{n} models found',
        epSaved: 'Endpoint saved',
        epRemoved: 'Endpoint removed',
        epRemoveConfirm: 'Remove it? Bots on it go back to the default.',
        nModels: '{n} models',
        keySet: 'key saved',
        keyMissing: 'no key',
        logins: 'Logins on this computer',
        loginsHint: 'Subscriptions other agents on this Mac are signed in to.',
        loginNotFound: 'Not signed in on this computer.',
        loginConnected: 'In use · kept in sync with {name}',
        loginHint_codex: 'Your ChatGPT plan, through the Codex CLI’s login. Whichever side refreshes the login, the other gets the new tokens (~/.codex/auth.json is updated in place), so neither signs the other out.',
        loginReason_terms: 'Not offered: Anthropic allows a Claude subscription only in Claude Code and claude.ai. Add Claude as an endpoint with an API key instead.',
        loginReason_harness: 'This Harness cannot use it yet.',
        loginReason_signin: 'Sign in from Harness Settings → Models instead.',
        useLogin: 'Use it',
        loginReady: '{name} is ready: pick its models in a bot’s profile',
        disconnect: 'Stop using',
      },
      zh: {
        lang: 'zh',
        title: 'Bots',
        newBot: '新建 Bot',
        search: '搜索 Bot',
        noMatch: '没有匹配的 Bot。',
        noBotsShort: '还没有 Bot。',
        noBio: '还没有简介',
        dispatcher: '调度者',
        dispatcherHint: '调度者接收你的请求，并把工作分派给其他 Bot。',
        activity: '动态',
        activityHint: '{n} 条消息',
        activitySub: '你、你的 Bot 以及定时任务之间的所有消息。',
        activityEmptyTitle: '暂无动态',
        activityEmptyBody: 'Bot 之间互发消息，或你给 Bot 发消息时，会显示在这里。',
        filterBot: '按 Bot 筛选',
        allBots: '全部 Bot',
        status_running: '工作中',
        status_idle: '空闲',
        status_offline: '离线',
        you: '你',
        scheduler: '定时任务',
        scheduled: '定时',
        toName: '发给 {name}',
        today: '今天',
        showMore: '展开',
        showLess: '收起',
        md_copy: '复制',
        md_copied: '已复制',
        md_code: '代码',
        md_wrap: '自动换行',
        md_unwrap: '不换行',
        md_footnotes: '脚注',
        link_play: '播放视频',
        link_open: '打开原帖',
        link_followers: '关注者',
        link_following: '正在关注',
        kind_dm: '私信',
        kind_user: '请求',
        kind_reply: '回复',
        kind_system: '定时',
        loading: '加载中…',
        unavailable: '连不上 Bots。刷新页面，或确认插件已启用。',
        chatEmptyTitle: '和 {name} 打个招呼',
        chatEmptyBody: '你发的消息会进入这个 Bot 自己的会话，它会用自己的人设、技能和应用来处理。',
        working: '{name} 正在工作…',
        composer: '给 @{handle} 发消息',
        composerHint: 'Enter 发送 · Shift+Enter 换行',
        fullTranscript: '完整记录在它的会话里',
        send: '发送',
        sendFailed: '消息没有发出去。',
        openFailed: '没能打开会话。',
        tab_chat: '聊天',
        tab_profile: '资料',
        tab_skills: '技能',
        tab_schedules: '定时任务',
        tab_apps: '应用',
        openConversation: '打开会话',
        setDispatcher: '设为调度者',
        nowDispatcher: '{name} 现在是调度者。',
        more: '更多',
        copyHandle: '复制 @handle',
        refresh: '刷新',
        deleteBot: '删除 Bot',
        deleteBotTitle: '删除 {name}？',
        deleteBotBody: '将删除 {name} 及其技能、应用和定时任务，并归档它的会话。此操作无法撤销。',
        deleted: '已删除 {name}。',
        actionFailed: '操作没有成功。',
        welcomeTitle: '组建你的 Bot 团队',
        welcomeBody: '每个 Bot 都有自己的头像、人设、技能、应用和定时任务。Bot 之间可以互发消息，由一个调度者分派工作。',
        createFirst: '创建第一个 Bot',
        secAvatar: '头像',
        secIdentity: '身份',
        name: '名字',
        namePlaceholder: '例如：小研',
        handle: 'Handle',
        handleHint: '小写字母、数字和连字符。其他 Bot 用 @handle 联系它。',
        handleInvalid: '只能用小写 a–z、0–9 和连字符，并以字母或数字开头。',
        handleTaken: '这个 handle 已被其他 Bot 使用。',
        bio: '简介',
        bioHint: '一句话，显示在卡片上，也会告诉其他 Bot。',
        bioPlaceholder: '这个 Bot 擅长什么',
        persona: '人设',
        personaHint: '这个 Bot 是谁、怎么工作——也就是它的系统提示词。可以从模板开始，也可以自己写。',
        personaPlaceholder: '你是……',
        model: '模型',
        modelHint: '这个 Bot 的会话使用的模型。',
        modelDefault: '默认（DSH 设置）',
        toolAccess: '工具权限',
        toolAccessHint: '允许 {total} 个 DSH 工具中的 {allowed} 个。未勾选的工具对这个 Bot 不可见。',
        allowAll: '全部允许',
        denyAll: '全部禁止',
        filterTools: '筛选工具',
        noTools: '没有列出工具。',
        uploading: '上传中…',
        uploadImage: '上传图片',
        useLetters: '改用字母头像',
        customColor: '自定义颜色',
        avatarColour: '颜色',
        avatarLetters: '字母',
        avatarLettersHint: '最多 2 个。留空则用名字生成的「{letters}」。',
        avatarPicture: '图片',
        generateAi: 'AI 生成',
        generate: '生成',
        generateStyleHint: '可选的风格说明——画面会根据 Bot 的名字、简介和人设来画。',
        generateStylePlaceholder: '例如：水彩小狐狸、扁平图标、像素风',
        generatingAvatar: '生成中…（最多约一分钟）',
        avatarGenerated: '新头像已生成。',
        avatarGenFailed: 'AI 头像生成失败：{reason}',
        imageGenMissing: '安装「图片」插件后可用 AI 生成头像',
        avatarType: '请使用 PNG、JPEG、WebP 或 GIF 图片。',
        avatarSize: '图片超过 2 MB。',
        avatarReadFailed: '读不了这个文件。',
        avatarSaved: '头像已更新。',
        unsaved: '有未保存的修改',
        allSaved: '所有修改已保存',
        discard: '放弃',
        save: '保存',
        saving: '保存中…',
        saved: '已保存。',
        saveFailed: '保存失败。',
        cancel: '取消',
        close: '关闭',
        startFrom: '从模板开始',
        persona_researcher: '研究员',
        persona_coder: '程序员',
        persona_writer: '写作者',
        persona_analyst: '分析师',
        persona_ops: '运维',
        persona_custom: '自定义',
        personaBio_researcher: '深入研究问题，附带来源汇报结果。',
        personaBio_coder: '编写、审查和修复代码。',
        personaBio_writer: '起草并打磨清晰生动的文字。',
        personaBio_analyst: '把数据变成数字、图表和决策。',
        personaBio_ops: '让事情持续运转：巡检、杂务和跟进。',
        personaBio_custom: '',
        personaText_researcher: '你是{name}，一位严谨的研究助理。把问题拆开，广泛检索，对比来源，并说明你的把握程度。简洁地汇报发现并附上链接，区分事实与推断。',
        personaText_coder: '你是{name}，一位务实的资深工程师。改代码前先读懂它，做最小且正确的改动，跑测试，并说明做了什么、为什么。清晰优先于炫技。',
        personaText_writer: '你是{name}，一位出色的写作者和编辑。贴合给定的读者和语气，句子紧凑具体，每份草稿都附上简短的思路说明。',
        personaText_analyst: '你是{name}，一位细心的数据分析师。先澄清问题，信任数据前先检查它，展示计算过程，最后给出明确的建议及其前提。',
        personaText_ops: '你是{name}，一位可靠的运维助手。执行例行检查，简要记录做过的事，一有异常立刻提出，并持续跟进直到每项任务关闭。',
        personaText_custom: '你是{name}。',
        newBotTitle: '新建 Bot',
        createBot: '创建 Bot',
        creating: '创建中…',
        created: '{name} 已就绪。',
        botSkills: '技能（{n}）',
        skillsHint: '{name} 在任务需要时加载的说明。',
        addSkill: '添加技能',
        newSkill: '新技能',
        editSkill: '编辑技能',
        skillName: '名称',
        skillDescription: '描述',
        skillDescriptionHint: '什么时候该用它？一句话。',
        skillContent: '说明（Markdown）',
        skillContentHint: '步骤、清单、示例——任何 Bot 应该遵循的内容。',
        skillContentPlaceholder: '# 周报\n\n1. 收集……\n2. 汇总……',
        saveSkill: '保存技能',
        skillSaved: '技能已保存。',
        skillDeleted: '技能已删除。',
        deleteSkillTitle: '删除技能“{name}”？',
        deleteSkillBody: 'Bot 将不再使用这些说明。',
        noSkillsTitle: '还没有技能',
        noSkillsBody: '教这个 Bot 一套可重复的流程——报告格式、审查清单、写作风格。',
        noDescription: '没有描述',
        chars: '{n} 个字符',
        sharedSkills: '可用的 DSH 共享技能',
        sharedSkillsHint: '安装在 DSH 中的这些技能，每个 Bot 都能使用。',
        noSharedSkills: '没有安装共享技能。',
        enable: '启用',
        disable: '停用',
        edit: '编辑',
        delete: '删除',
        remove: '移除',
        schedulesTitle: '定时任务（{n}）',
        schedulesHint: '每到设定时间，指令会发送到 {name} 的会话。',
        newSchedule: '新建定时任务',
        editSchedule: '编辑定时任务',
        createSchedule: '创建定时任务',
        noSchedulesTitle: '没有定时任务',
        noSchedulesBody: '让这个 Bot 自己定时做事——早间简报、每小时巡检、每周报告。',
        taskTitle: '标题',
        taskTitlePlaceholder: '早间简报',
        taskPrompt: '指令',
        taskPromptHint: '每次都会发给 Bot，请写得完整自足。',
        taskPromptPlaceholder: '汇总我关心的新闻并发给我。',
        when: '时间',
        mode_at: '一次',
        mode_every: '每隔…',
        mode_daily: '每天',
        mode_weekly: '每周',
        mode_cron: '自定义（cron）',
        onceAt: '日期和时间',
        every: '每隔',
        minutes: '分钟',
        hours: '小时',
        atTime: '时间',
        timeZone: '时区',
        cronExpr: 'Cron 表达式',
        cronHint: '五个字段：分 时 日 月 星期。',
        errAt: '请选择日期和时间。',
        errEvery: '间隔至少一分钟。',
        errTime: '请选择时间。',
        errWeekdays: '至少选择一天。',
        errCron: 'Cron 表达式需要五个字段。',
        errTitlePrompt: '请填写标题和指令。',
        scheduleCreated: '定时任务已创建。',
        scheduleUpdated: '定时任务已更新。',
        scheduleDeleted: '定时任务已删除。',
        deleteScheduleTitle: '删除“{title}”？',
        deleteScheduleBody: '它将不再运行。',
        untitled: '未命名',
        taskStatus_active: '进行中',
        taskStatus_paused: '已暂停',
        taskStatus_ended: '已结束',
        runningNow: '运行中',
        nextRun: '下次 {when}',
        lastRun: '上次 {when}',
        neverRun: '尚未运行',
        pause: '暂停',
        resume: '恢复',
        paused: '已暂停。',
        resumed: '已恢复。',
        runNow: '立即运行',
        ranNow: '已开始。',
        timingDaily: '每天 {time}（{zone}）',
        timingWeekly: '{days} {time}（{zone}）',
        timingEveryMinutes: '每 {n} 分钟',
        timingEveryHours: '每 {n} 小时',
        timingEveryDays: '每 {n} 天',
        timingCron: 'Cron“{expr}”（{zone}）',
        timingAt: '一次：{when}',
        timingRrule: '重复：{rule}',
        timingUnknown: '自定义时间',
        everyDay: '每天',
        weekdays: '工作日',
        listSep: '、',
        wd1: '周一',
        wd2: '周二',
        wd3: '周三',
        wd4: '周四',
        wd5: '周五',
        wd6: '周六',
        wd7: '周日',
        justNow: '刚刚',
        inMoment: '马上',
        agoMin: '{n} 分钟前',
        agoHour: '{n} 小时前',
        agoDay: '{n} 天前',
        inMin: '{n} 分钟后',
        inHour: '{n} 小时后',
        inDay: '{n} 天后',
        appsNote: '修改会在这个 Bot 的会话下次启动时生效。',
        mcpMissing: '当前 DSH 不支持 MCP，应用暂时无法运行。',
        installedApps: '已安装的应用（{n}）',
        noApps: '还没有应用。从下方的应用库添加一个。',
        appGallery: '应用库',
        appGalleryHint: '共 {n} 个应用。大多是 MCP 服务器，工具只对这个 Bot 可见；聊天应用（飞书、Telegram、Slack、Discord）让你用手机给团队发消息。',
        noTemplates: '没有模板。',
        featured: '推荐',
        allApps: '全部',
        searchApps: '搜索应用',
        noAppMatch: '没有匹配“{q}”的应用。',
        regionCn: '中国',
        getKey: '获取 Key',
        docs: '文档',
        runtimeRemote: '远程',
        runtimeBinary: '本地程序',
        needsSetup: '需要配置',
        configure: '配置',
        configureTitle: '配置 {name}',
        addNamedApp: '添加 {name}',
        noSettings: '这个应用无需设置。',
        showSecret: '显示',
        hideSecret: '隐藏',
        pathHint: '这台电脑上的完整路径。',
        advanced: '高级',
        fieldsRequired: '请填写带 * 的字段。',
        ocuInstalled: '已安装',
        ocuMissing: '未安装',
        ocuBlurb: '通过 kadaliao/open-computer-use MCP 服务器，让 Bot 能看到并操作你的 Mac。',
        ocuInstallTitle: '安装 Open Computer Use',
        ocuStep3: '然后在 系统设置 → 隐私与安全性 中给 DeepSeek Harness 授予“辅助功能”（截图还需“屏幕录制”）权限。',
        ocuInstallNow: '一键安装',
        ocuInstalling: '安装中…',
        ocuRecheck: '重新检测',
        ocuInstallDone: 'Open Computer Use {version} 已安装',
        ocuInstallFailed: '安装失败',
        ocuInstallWhat: '「添加」只是把应用接到这个 Bot 上，程序本身还没装到这台 Mac。一键安装会从 GitHub 下载最新版到',
        ocuAddedNotInstalled: '已添加，但程序还没安装',
        ocuReady: '已安装在 {path}。运行中的 Bot 会立即重新连接；请确认 DeepSeek Harness 已有“辅助功能”权限。',
        add: '添加',
        added: '已添加',
        appAdded: '已添加 {name}。',
        appSaved: '应用已保存。',
        appRemoved: '应用已移除。',
        removeAppTitle: '移除 {name}？',
        removeAppBody: 'Bot 的会话下次启动时将不再有这个应用的工具。',
        addAppTitle: '添加应用',
        editAppTitle: '编辑应用',
        appName: '显示名称',
        serverName: '服务器名',
        serverNameHint: '工具名为 mcp__{name}__*。',
        serverNameInvalid: '使用 1–32 个字母、数字、_ 或 -。',
        serverNameTaken: '这个 Bot 的另一个应用已使用该服务器名。',
        command: '命令',
        commandRequired: '请填写启动服务器的命令。',
        args: '参数',
        argsHint: '每行一个。',
        env: '环境变量',
        envHint: 'KEY=VALUE，每行一个。',
        url: 'URL',
        urlRequired: '请填写 http(s) 地址。',
        headers: '请求头',
        headersHint: 'Name: value，每行一个。',
        preparing: '准备中…',
        running: '执行中…',
        failed: '操作没有成功。',
        delivered: '已送达',
        viewInBots: '在 Bots 中查看',
        toolSend: '消息',
        tool_bot_create: '创建了 Bot',
        tool_bot_update: '更新了 Bot',
        tool_bot_delete: '删除了 Bot',
        tool_bot_list: 'Bots',
        tool_bot_schedule: '定时任务',
        nBots: '{n} 个 Bot',
        field_name: '名字',
        field_bio: '简介',
        field_persona: '人设',
        field_initials: '头像字母',
        field_color: '颜色',
        addedSkills: '+ 技能：{names}',
        removedSkills: '− 技能：{names}',
        madeDispatcher: '成为调度者',
        schedAction_create: '创建',
        schedAction_list: '列出',
        schedAction_update: '更新',
        schedAction_delete: '删除',
        schedAction_pause: '暂停',
        schedAction_resume: '恢复',
        schedAction_run: '立即运行',
        badgeTitle: '这是 {name} 的会话——在 Bots 中打开',
        otherBots: "其他",
        blankBot: "空白 Bot",
        fromTeam: "从团队模板",
        teamTemplates: "团队模板",
        teamTemplatesHint: "雇用一支现成的团队",
        teamTemplatesSub: "每个团队都配好了人设、Harness 技能、应用和定时任务。当前 Harness 没有的会自动跳过。",
        teamsHeroTitle: "组建你的 Bot 团队",
        teamsHeroBody: "为一人公司或需要多人协作的工作，直接雇用一支现成的团队。每个 Bot 都带着人设、你 Harness 里已有的技能、应用和日常任务上岗，由负责人统一分派工作。",
        noTeams: "没有团队模板。",
        orBlank: "想从零开始？",
        teamDaily: "每天 {time}",
        teamWeekdays: "工作日 {time}",
        teamWeekly: "每{days} {time}",
        teamCounts: "{bots} 个 Bot · {skills} 个技能 · {tasks} 个定时任务",
        hireTeam: "雇用这个团队",
        teamDetails: "查看详情",
        teamTasks: "日常",
        skillNotInstalled: "当前 Harness 没有安装——将被跳过",
        skillNotInstalledShort: "当前 Harness 没有安装",
        srcHarnessHint: "已安装在当前 Harness，自动保持最新",
        appNotInCatalog: "应用库里没有",
        appKeyLater: "Key 稍后填写",
        legendHarness: "Harness 技能",
        legendGithub: "从 GitHub 导入",
        legendMissing: "未安装，将跳过",
        leadAsDispatcher: "让负责人成为调度员",
        hireFailed: "没能雇用这个团队。",
        hireTitle: "雇用{name}",
        hireConfirmBody: "将在现有 Bot 之外新增 {n} 个 Bot，并自动配好它们的技能、应用和定时任务。",
        hiring: "正在组建团队…（会从 GitHub 导入技能）",
        hiringHint: "通常需要 10–30 秒。",
        retry: "重试",
        hiredTitle: "{name}已就位",
        later: "稍后",
        sendKickoff: "发送开场任务给 {name}",
        hiredBots: "已雇用 {n} 个 Bot",
        kickoffLabel: "开场任务",
        needKeysTitle: "还需要填写 Key 的应用",
        fillKey: "去填写",
        skippedTitle: "跳过了 {n} 项",
        skippedKind_skill: "技能",
        skippedKind_app: "应用",
        skippedKind_schedule: "定时任务",
        abilities: "能力",
        abilitiesHint: "{name} 能用 Harness 内置工具做哪些事。关掉某项能力，只对这个 Bot 隐藏相关工具。",
        risky: "谨慎开启",
        nTools: "{n} 个工具",
        advancedTools: "高级：按工具设置（允许 {total} 个中的 {allowed} 个）",
        harnessPickerTitle: "从 Harness 添加技能",
        harnessPickerNote: "按名称引用，不复制内容，始终保持最新。",
        addN: "添加 {n} 个",
        searchSkills: "搜索 {n} 个已安装的技能",
        noSkillMatch: "没有匹配的技能。",
        githubPickerTitle: "从 GitHub 导入技能",
        githubNote: "会复制整个技能文件夹，包括脚本。",
        githubFailed: "读取这个仓库失败。",
        importN: "导入 {n} 个",
        importing: "导入中…",
        importedN: "已导入 {n} 个技能。",
        updatedN: "已更新 {n} 个。",
        skippedN: "跳过 {n} 个：已有同名技能。",
        fullN: "跳过 {n} 个：一个 Bot 最多放 {max} 个技能。",
        offN: "其中 {n} 个先关着：最多同时开 {max} 个技能。",
        tooManyOn: "最多同时开 {max} 个技能，先关掉一个。",
        skillsFull: "一个 Bot 最多放 {max} 个技能，先删掉一个。",
        skillsRoom: "一个 Bot 最多放 {max} 个技能，还能加 {n} 个。",
        skillsOnOf: "开着 {n}/{max}",
        nameTaken: "已有同名技能",
        reimport: "已导入 · 再次导入可更新",
        skillNameTaken: "这个 Bot 已经有名为“{name}”的技能。",
        importLocal: "从本地文件夹添加",
        localPickerTitle: "从本地文件夹添加技能",
        localHint: "选一个技能文件夹（里面有 SKILL.md），或者一个装着多个技能的文件夹。",
        localNote: "只引用、不复制：改了原文件夹，Bot 就用新的。",
        linked: "已引用",
        linkedHint: "每次都从这个文件夹读取，要改就改那里。",
        folderMissing: "文件夹找不到了",
        localFailed: "读取这个文件夹失败。",
        localNone: "这个文件夹和它的子文件夹里都没有 SKILL.md。",
        localTruncated: "文件夹太大，只搜索了一部分。请选离技能更近的文件夹。",
        localPlaces: "本机已有：",
        chooseFolder: "选择文件夹…",
        pickFailed: "这里打不开文件夹选择框，请直接输入或粘贴路径。",
        scan: "扫描",
        readingFolder: "正在读取文件夹…",
        alsoInHarness: "Harness 里也安装了同名技能（见“从 Harness 添加”）。",
        src_local: "本地",
        importFailed: "导入失败。",
        browse: "浏览",
        foundSkills: "{n} 个技能",
        selectAll: "全选",
        selectNone: "全不选",
        nFiles: "{n} 个文件",
        readingRepo: "正在读取仓库…",
        writeSkillTitle: "让 {name} 自己写技能",
        writeSkillHint: "描述这个技能要做什么。Bot 会在自己的会话里写好（有 skill-creator 时会用它），并保存到这里。",
        writeSkillPlaceholder: "描述你想要的技能，比如：每周一把 Stripe 收入整理成表格发给我",
        writeSkillGo: "交给它写",
        sending: "发送中…",
        writeSent: "已交给 {name}，写好后会出现在这里",
        addedN: "已添加 {n} 个技能。",
        addFromHarness: "从 Harness 添加",
        importGithub: "从 GitHub 导入",
        letBotWrite: "让 Bot 自己写",
        writeByHand: "手写",
        skillsHint2: "{name} 在任务需要时加载的说明。",
        skillMix: "Harness {dsh} · GitHub {import} · 本地 {local} · 自写 {own}",
        noSkillsBody2: "添加 Harness 里已安装的技能、从 GitHub 或本地文件夹导入，或者描述一下让 Bot 自己写。",
        harnessManaged: "由 Harness 提供，自动保持最新",
        src_dsh: "Harness",
        src_import: "GitHub",
        src_own: "自写",
        libSource_user: "用户",
        libSource_project: "项目",
        libSource_bundled: "内置",
        libSource_plugin: "插件",
        importOtherAgents: "从其他 Agent 导入",
        foundExternal: "发现 {n} 个 MCP 服务（{from}）",
        chooseImport: "选择导入",
        importedApps: "已导入 {n} 个应用。",
        externalNote: "连同 Key 一起复制；这里的值已打码。",
        alreadyImported: "已添加",
        suggest_p1: "这是我这周要推进的事，帮我排个计划，并分派给大家。",
        suggest_p2: "问一下每个人的进展，给我一份简短汇总。",
        suggest_p3: "要帮上忙，你需要了解我业务的哪些情况？",
        suggest_b1: "介绍一下你自己：你能帮我做什么？需要我提供什么？",
        suggest_b2: "看看你手上有什么事，建议今天先做哪一件。",
        suggest_b3: "告诉我你的技能和应用哪些已经可用，哪些还需要配置。",
        // chat channels
        chatChannel: '聊天应用',
        createChatBot: '创建 Bot',
        channelHow: '把它加到调度者身上。连上以后，用这里显示的一次性配对码把你自己配对上；之后在 {app} 里给 Bot 发消息就能派活，回复会回到聊天里。',
        channelSaveNote: '保存后立即连接。',
        channelConnected: '已连接：{handle}',
        channelConnecting: '正在连接 {app}…',
        channelError: '未连接',
        channelOff: '已关闭。打开后才会连接。',
        channelMissing: '粘贴 Bot Token 后即可连接 {app}。',
        channelHint_token: '{app} 拒绝了这个 Bot Token。请重新复制并保存。',
        channelHint_intent: '请打开 Message Content Intent：开发者后台 → 你的应用 → Bot → Privileged Gateway Intents，然后重新连接。',
        channelHint_conflict: '另一个程序正在使用这个 Bot Token。请停掉它，或给团队单独建一个 Bot。',
        channelHint_duplicate: '这个 Token 已经在另一个 Bot 上连接了；一个 Token 只能在一处运行。',
        channelHint_app_token: 'Slack 拒绝了 App 级 Token（xapp-…）。请在 Slack 应用的 Basic Information → App-Level Tokens 里生成一个带 connections:write 权限的 Token，粘贴后保存。',
        channelHint_app_scope: 'App 级 Token 缺少 connections:write 权限。请在 Basic Information → App-Level Tokens 重新生成一个带该权限的 Token，粘贴后保存。',
        channelHint_token_kind: 'Token 填错位置了：Bot Token 以 xoxb- 开头（OAuth & Permissions 页），App 级 Token 以 xapp- 开头（Basic Information → App-Level Tokens）。',
        channelHint_slack_scopes: 'Slack 应用缺少权限。请在 OAuth & Permissions → Bot Token Scopes 里补上（或用清单重新创建应用），重新安装到工作区，然后点重新连接。',
        channelHint_socket_mode: '这个 Slack 应用没有开启 Socket Mode。请在应用的 Socket Mode 页打开 Enable Socket Mode，然后点重新连接。',
        channelHint_secret: '{app} 拒绝了这个 App Secret。请到开发者后台「凭证与基础信息」重新复制并保存。',
        channelHint_appId: '飞书和 Lark 都找不到这个 App ID。请到开发者后台「凭证与基础信息」复制，它以 cli_ 开头。',
        channelHint_disabled: '{app} 提示这个应用已停用。请在开发者后台启用（或联系管理员），然后重新连接。',
        channelHint_bot: '请开启机器人：开发者后台 →「添加应用能力」→「机器人」，然后发布版本。长连接已经在线，现在就可以去配置「事件与回调」；机器人生效后会自动连上。',
        channelHint_feishu_scopes: '应用没有发消息的权限。请在「权限管理」开通 im:message:send_as_bot 并发布版本。',
        channelHint_connlimit: '这个应用的长连接数已达飞书上限（50 个）。请停掉其他使用这个 App ID 的程序。',
        reconnect: '重新连接',
        pairedPeople: '已配对的人（{n}）',
        nobodyPaired: '还没有人。配对之前，Bot 在 {app} 里不回复任何人。',
        pairedFirst: '接收定时汇报',
        pairedSince: '配对于 {when}',
        unpaired: '已移除 {name}。',
        pairStepTelegram: '用你自己的 Telegram 账号把这个配对码发给 {handle}，或打开链接后点 Start。只能用一次。',
        pairStepDiscord: '用你自己的 Discord 账号私信 {handle}，发送这个配对码。只能用一次。',
        pairStepFeishu: '在飞书里打开和 {handle} 的单聊（搜索应用名，或点「在飞书中打开」），发送这个配对码。只能用一次。',
        pairStepSlack: '用你自己的 Slack 账号打开这个应用的 Messages 标签页（或点链接），发送这个配对码。只能用一次。',
        pairStep: '用你自己的 {app} 账号把这个配对码发给 {handle}。只能用一次。',
        copy: '复制',
        copied: '已复制。',
        openIn: '在 {app} 中打开',
        codeExpires: '{when}过期',
        newCode: '换一个',
        pairSomeone: '配对我自己',
        pairAnother: '再配对一个人',
        pairWhenConnected: '连接成功后才能配对。',
        inviteDiscord: '把 Bot 邀请进你所在的服务器（私信它之前必须先这样做）',
        channelSchedules: '定时汇报也发给 {app} 里的 {name}',
        channelIgnored: '忽略了 {n} 条未配对的人发来的消息（最近：{name}）。',
        channelPrivate: '只有配对过的人能找到团队，其他人一律忽略（每天最多回一句“这是私人 Bot”）。在群里，只有 @ 它或回复它时才会回答。',
        viaChannel: '{app} · {who}',
        sentToChannel: '也已发到 {app}',
        threadPart: '话题',
        threadTopic: '话题',
        notSent: '未发出',
        notSentChats: '没有发到任何聊天：这一轮涉及多个聊天（{chats}）。',
        // tasks
        tasks: '任务',
        tasksHint: '交给 Bot 们的工作',
        tasksNeedYou: '{n} 个等你处理',
        tasksInProgress: '{n} 个进行中',
        tasksSub: 'Bot 们接手的工作。每个任务在自己的会话里进行，几件事可以同时推进。',
        tasksNeeds: '需要你处理',
        tasksNeedsEmpty: '现在没有需要你处理的。',
        tasksProgress: '进行中',
        tasksProgressEmpty: '没有进行中的任务。',
        tasksDone: '最近完成',
        tasksDoneEmpty: '还没有完成的任务。',
        tasksUnavailable: '没能加载任务。',
        tasksEmptyTitle: '还没有任务',
        tasksEmptyBotTitle: '{name} 还没有任务',
        tasksEmptyBody: '调度者把工作交给队友时，这里会出现一个任务，你可以跟进、回答或叫停。',
        untitledTask: '未命名任务',
        openTask: '打开任务',
        followUpTask: '已交给所属任务',
        followUpHint: '在任务来源的聊天里跟进，消息会直接交给那个任务。',
        taskOf: '任务 · {name}',
        stage_question: '等你回答',
        stage_failed: '失败',
        stage_stalled: '卡住了',
        stage_queued: '排队中',
        stage_working: '进行中',
        stage_done: '已完成',
        stage_stopped: '已停止',
        report_progress: '进展',
        report_done: '完成',
        report_blocked: '受阻',
        report_question: '提问',
        askedByYou: '你发起',
        askedBy: '{name} 发起',
        viaPanel: '面板',
        kind_report: '汇报',
        allTasks: '全部任务',
        taskMissing: '这个任务不可用，可能已经归档。',
        taskStarted: '开始于{when}',
        taskNoConversation: '还没开始。',
        taskRetry: '重试',
        taskClose: '标为完成',
        taskStop: '停止',
        taskDid_stop: '任务已停止。',
        taskDid_retry: '任务已重新开始。',
        taskDid_close: '任务已标为完成。',
        taskStopTitle: '停止“{title}”？',
        taskStopBody: '{name} 会马上停下这件事，之后可以重试。',
        taskCloseTitle: '把“{title}”标为完成？',
        taskCloseBody: '{name} 会停下这件事，任务算作完成。',
        taskFactBot: '执行的 Bot',
        taskFactAsked: '发起方',
        taskFactFrom: '来源',
        fromPanel: 'Bots 面板',
        taskFactUpdated: '最近更新',
        taskAsked: '交代的内容',
        taskReports: '汇报',
        taskNoReports: '还没有汇报。{name} 完成、卡住或有问题时会汇报。',
        taskRelated: '相关任务',
        taskParent: '所属任务',
        taskChildren: '子任务（{n}）',
        taskUsage: '用量',
        taskNoUsage: '还没有模型调用。',
        taskArchived: '这个任务已归档。它所在聊天里的新消息会交给调度者。',
        taskMessageLabel: '给这个任务发消息',
        taskMessagePlaceholder: '补充点什么…',
        taskAnswerPlaceholder: '回答 {name}…',
        taskMessageHint: '{name} 会在这个任务自己的会话里看到 · Enter 发送',
        taskMessageSent: '已发给 {name}。',
        taskBadgeTitle: '{name} 的任务：{title}——在 Bots 中打开',
        tab_tasks: '任务',
        botOpenTasks: '进行中的任务',
        botOpenTasksHint: '{name} 手上的工作，每件在自己的会话里进行。',
        allTasksOf: '全部任务',
        botNoOpenTasks: '{name} 手上没有进行中的任务。',
        toolReport: '汇报',
        requesterShort: '发起方',
        // the dispatcher's mode
        dispatcherMode: '调度方式',
        dispatcherModeHint: '对整个团队生效。调度者分出去的每件工作都是一个任务，有自己的会话。',
        modeRouter: '只调度',
        modeRouterBody: '听懂、分派、汇报，具体工作交给队友。',
        modeHandsOn: '亲自动手',
        modeHandsOnBody: '小事自己顺手做掉，和以前一样。',
        modeSavedRouter: '{name} 现在只负责分派。',
        modeSavedHandsOn: '{name} 又会自己做小事了。',
        routerModelHint: '只调度时它只负责听懂、分派、汇报，用轻量、快速的模型就够了，每次请求都更快、更省。',
        routerWaiting: '团队里再有一个 Bot 后才开始只调度，在此之前 {name} 自己动手。',
        abilitiesRouterHint: '{name} 能用 Harness 内置工具做哪些事。只调度时它不执行命令、不写文件、不用子代理、不作图也不做 Office 文档；确实需要时可以在下面逐项打开。',
        routerOff: '只调度时关闭',
        routerPartOff: '只调度时部分关闭',
        routerAllowed: '只调度时也可用',
        routerAllowBack: '重新打开',
        routerOffShort: '只调度时关闭',
        routerNoticeTitle: '调度者现在只负责分派',
        routerNoticeBody: '它会听懂请求、把每件事作为任务交给队友并汇报结果；每个任务在自己的会话里进行，几件事可以同时推进。想让它像以前一样顺手做小事，打开它的资料页，把「调度方式」改成「亲自动手」。',
        routerNoticeOpen: '打开它的资料页',
        routerNoticeOk: '知道了',
        setTasks: '任务',
        setMaxWorking: '同时进行的任务数',
        setMaxWorkingHint: '多出来的排队等候。你的跟进消息可以多占一个名额。',
        setStall: '多少分钟没动静算卡住',
        setStallHint: '进行中的任务这么久没动静，先请它汇报；之后仍没动静就标为卡住。',
        setArchive: '任务完成多少小时后归档会话',
        setArchiveHint: '在此之前，它所在话题或回复串里的新消息会让这个任务继续。',
        // 用量、记忆、话题、设置、模型来源
        settings: '设置',
        usage: '用量',
        usageHint: '今天 {tokens} tokens',
        usageSub: '每个 Bot、每个任务、每一天的 tokens 和估算费用：对话、记忆整理和上下文压缩都算在内。',
        usageChart: '各 Bot 的 tokens',
        other: '其他',
        removedBot: '已删除的 Bot',
        range_today: '今天',
        range_7d: '7 天',
        range_30d: '30 天',
        range_90d: '90 天',
        range_all: '全部',
        prices: '价格',
        tileTokens: 'Tokens',
        tileCacheRate: '{pct}% 的输入命中缓存',
        tileCost: '估算费用',
        tileUnpriced: '{tokens} tokens 没有价格',
        tileRuns: '回合',
        tileCalls: '模型调用',
        tileInOut: '输入 {input} · 输出 {output}',
        vsPrev: '比上一期 {delta}',
        noUsage: '这段时间还没有模型调用。',
        byBot: '按 Bot',
        byModel: '按模型',
        byKind: '按用途',
        bySchedule: '定时任务',
        recentRuns: '最近的回合',
        byTask: '按任务',
        colBot: 'Bot',
        colTask: '任务',
        colRunCount: '回合',
        colRun: '回合',
        colTokens: 'Tokens',
        colCost: '费用',
        colCalls: '调用',
        colModel: '模型',
        colRuns: '次数',
        colWhen: '时间',
        work_chat: '对话',
        work_memory: '记忆总结',
        work_compaction: '上下文压缩',
        work_dream: '每日整理',
        trigger_user: '你发起',
        trigger_chat: '来自 {app}',
        trigger_schedule: '定时',
        trigger_dm: '来自 @{handle}',
        taskRunning: '进行中',
        taskState_error: '出错',
        taskState_stopped: '已停止',
        setPrice: '设价格',
        pricesTitle: '模型价格',
        pricesHint: '费用是估算：tokens × 每百万 tokens 的价格。优先用你填的价格，其次是 LiteLLM 公开价格表（{count} 个模型，{when} 获取）。网关和订阅的实际计费可能不同。',
        priceInput: '输入 / 百万',
        priceCached: '缓存输入 / 百万',
        priceOutput: '输出 / 百万',
        priceCurrency: '币种',
        priceSource_user: '你填的价格',
        priceNone: '没有价格',
        usePriceList: '改用价格表',
        refreshPriceList: '刷新价格表',
        priceSaved: '价格已保存',
        tab_memory: '记忆',
        memoryOf: '{name} 记得的事',
        memoryHint: '跨对话、跨话题保留的笔记。{name} 会自己记：每个任务结束后自动总结，你让它记住的也会存进来；可以在这里直接修改。置顶的笔记不会被自动整理改动。',
        memoryModelIs: '记忆工作使用 {model}',
        botsOwnModel: '各 Bot 自己的模型',
        addNote: '添加一条笔记…',
        noteSaved: '笔记已保存',
        filterNotes: '筛选笔记',
        noNotes: '还没有记忆。任务完成后会自动出现，也可以手动添加。',
        note_fact: '事实',
        note_preference: '偏好',
        note_person: '人物',
        note_project: '项目',
        note_procedure: '做法',
        note_lesson: '教训',
        src_auto: '任务后总结',
        src_tool: 'Bot 自己记的',
        src_user: '你写的',
        src_dream: '整理后',
        pin: '置顶',
        unpin: '取消置顶',
        recentWork: '最近做过的事',
        recentWorkHint: '每完成一个任务记一行，任务结束时写入。',
        noJournal: '还没有完成的任务。',
        topicsTitle: '话题',
        topicsHint: '每个话题是一段新对话，上下文不会无限变长。发送 /new、闲置较久，或对话变得很长时（见设置）会开始新话题；记忆会延续下去。',
        topicNow: '当前话题：开始于{when} · {n} 个回合 · 最近一次提示 {ctx} tokens',
        topicShort: '本话题：上下文 {ctx} · 已进行 {n} 个回合',
        newTopic: '新话题',
        newTopicHint: '开始一段新对话，记忆会保留。也可以直接发送 /new。',
        newTopicDone: '{name} 开始了新话题',
        topicDivider: '新话题 · {reason}',
        topicReason_manual: '你开启的',
        topicReason_idle: '闲置后自动开启',
        topicReason_context: '对话太长自动开启',
        pastTopic: '{from} – {to} · {n} 个回合',
        kind_topic: '新话题',
        teamMemoryTitle: '团队记忆',
        teamMemoryHint: '{n} 条共享笔记 · 每日摘要',
        teamNotes: '共享笔记',
        teamNotesHint: '每个 Bot 都会读。放所有 Bot 都该知道的事：关于你、你的业务、团队约定。',
        digests: '每日摘要',
        digestsHint: '每天把团队做过的事写成摘要，每个 Bot 都会读最新的一份。',
        noDigests: '还没有摘要。',
        teamJournal: '团队工作日志',
        dreamNow: '立即整理',
        dreaming: '整理中…',
        dreamDone: '已整理 {bots} 个 Bot{digest}',
        dreamDigest: '，并写好了每日摘要',
        dreamPartly: '整理完成，但有问题：{reason}',
        lastDream: '上次整理：{when}',
        dreamDaily: '每天 {time}',
        neverDreamed: '还没整理过，每天 {time} 自动进行。',
        dreamOff: '每日整理已关闭。',
        settingsTitle: 'Bots 设置',
        settingsSaved: '设置已保存',
        setTopics: '话题',
        setIdle: '闲置多少小时后开新话题',
        setIdleHint: '在下一个任务开始前检查。0 表示不自动开。',
        setContext: '上下文达到多少千 tokens 时开新话题',
        setContextHint: 'Harness 自己会在接近模型上限时压缩对话；开新话题让每次调用都保持小而便宜。0 表示不自动开。',
        setMemory: '记忆',
        setAuto: '每个任务结束后总结进记忆',
        setAutoHint: '每完成一个任务调用一次模型。关闭后只记一行工作日志。',
        setMemoryModel: '记忆工作用的模型',
        setMemoryModelHint: '用于总结和整理，小而便宜的模型就够了。',
        setDream: '每天整理一次',
        setDreamHint: '合并重复的笔记、删掉过时的，并写团队每日摘要。',
        modelSources: '模型来源',
        modelDefaultIs: 'Harness 默认（{model}）',
        modelContext: '上下文窗口 {k} tokens',
        reasoning: '思考强度',
        effortDefault: '默认',
        msrc_custom: '自定义端点',
        msrc_login: '订阅',
        sourcesTitle: '模型来源',
        sourcesIntro: 'Bot 可以用 Harness 里的任何模型。你可以添加自己的端点，或者用这台电脑上其他 Agent 已经登录的订阅。两者都会成为 Harness 的模型提供方，也会出现在 设置 → 模型 和每个会话的模型选择里。',
        notWritable: '当前 Harness 不允许插件修改模型设置。',
        endpoints: '自定义端点',
        noEndpoints: '还没有。',
        addEndpoint: '添加端点',
        editEndpoint: '编辑端点',
        epName: '名称',
        epApi: '接口类型',
        epBase: 'Base URL',
        epKey: 'API Key',
        epKeyHint: '保存在 Harness 凭据库里，之后不再显示。不需要 key 的本地服务随便填点文字即可。',
        epKeyKeep: '留空则保留已保存的 key',
        epModels: '模型',
        epModelsHint: '每行一个模型 id；也可以从端点获取列表后勾选。',
        fetchModels: '获取模型列表',
        fetching: '获取中…',
        fetchedN: '找到 {n} 个模型',
        epSaved: '端点已保存',
        epRemoved: '端点已删除',
        epRemoveConfirm: '确定删除？用它的 Bot 会改回默认模型。',
        nModels: '{n} 个模型',
        keySet: '已存 key',
        keyMissing: '没有 key',
        logins: '本机其他 Agent 的登录',
        loginsHint: '这台 Mac 上其他 Agent 已经登录的订阅。',
        loginNotFound: '本机没有登录。',
        loginConnected: '使用中 · 与 {name} 保持同步',
        loginHint_codex: '通过 Codex CLI 的登录使用你的 ChatGPT 订阅。无论哪一边刷新了登录，另一边都会拿到新令牌（会原地更新 ~/.codex/auth.json），两边不会互相踢下线。',
        loginReason_terms: '不提供：Anthropic 只允许在 Claude Code 和 claude.ai 里使用 Claude 订阅。可以用 API Key 把 Claude 添加为自定义端点。',
        loginReason_harness: '当前 Harness 还不能使用它。',
        loginReason_signin: '请改在 Harness 设置 → 模型里登录。',
        useLogin: '使用',
        loginReady: '{name} 已就绪：在 Bot 资料页里选它的模型',
        disconnect: '停用',
      },
    };

    /** The English dictionary, for a seat that brought no `t`. */
    function fallbackT(key, params) {
      const template = DICTIONARY.en[key] ?? key;
      if (!params) return template;
      return template.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? ''));
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, DICTIONARY), 'bots: dictionaries');
        let bound = null;
        const tr = (key, params) => {
          try {
            if (bound === null && typeof ctx.locale.bind === 'function') bound = ctx.locale.bind(NS);
            if (typeof bound === 'function') {
              const out = bound(key, params);
              if (typeof out === 'string' && out !== '') return out;
            }
          } catch {
            // The English below.
          }
          return fallbackT(key, params);
        };
        const service = (name) => {
          try {
            return ctx.get?.(name);
          } catch {
            return undefined;
          }
        };
        const openPanel = () => {
          try {
            const layout = service('layout');
            if (!layout || typeof layout.selectPanel !== 'function') return false;
            layout.selectPanel(PANEL_ID);
            return true;
          } catch {
            return false;
          }
        };
        const openSession = (id) => {
          try {
            const ws = service('uiWorkspace');
            if (!id || typeof ws?.openSession !== 'function') return false;
            ws.openSession(id);
            return true;
          } catch {
            return false;
          }
        };
        // The Host's own folder dialog: the desktop shell's when there is one, else the workspace service's.
        const directoryPicker = () => {
          const desktop = globalThis.__DSH_DIRECTORY_PICKER__;
          if (typeof desktop?.pick === 'function') return () => desktop.pick();
          const ws = service('uiWorkspace');
          return typeof ws?.pickDirectory === 'function' ? () => ws.pickDirectory() : null;
        };
        const env = {
          // Asked at use: the workspace service may come up after this client does.
          canPickDirectory: () => directoryPicker() !== null,
          pickDirectory: () => (directoryPicker() ?? (() => null))(),
          canOpen: () => typeof service('uiWorkspace')?.openSession === 'function',
          canPanel: () => typeof service('layout')?.selectPanel === 'function',
          /** Ensure the bot's home conversation, then show it; false on failure. */
          openBot: (bot) =>
            postJson('open', { id: bot.id }).then((r) => {
              const id = r?.ok ? r.sessionId : bot.sessionId;
              const ok = openSession(id);
              void refreshState();
              return ok;
            }),
          showBot: (botId) => {
            navigate(botId);
            return openPanel();
          },
          /** Show a Harness conversation (a task's own one); false when it cannot. */
          openSession: (id) => openSession(id),
          /** One task's detail in the panel. */
          showTicket: (id) => {
            openTicket(id);
            return openPanel();
          },
          openPanel,
          sessionTitle: (id) => {
            try {
              const title = service('sessions')?.list?.getSnapshot?.()?.byId?.[id]?.displayTitle;
              return typeof title === 'string' ? title : undefined;
            } catch {
              return undefined;
            }
          },
        };
        const withT = (Component, extra) => (props) => h(Component, { ...props, ...extra, env, t: typeof props.t === 'function' ? props.t : tr });

        // The model tools' cards in the conversation.
        ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: 'bot_send_message', locale: NS }, withT(SendMessageView)));
        for (const tool of ['bot_create', 'bot_update', 'bot_delete']) {
          ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: tool, locale: NS }, withT(BotChangeView, { tool })));
        }
        ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: 'bot_list', locale: NS }, withT(BotListView)));
        ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: 'bot_schedule', locale: NS }, withT(ScheduleView)));
        // The panel: an icon in the sidebar's panel row, and the main panel it opens.
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 31, label: () => tr('title') }, BotsGlyph));
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, withT(BotsPanel)));
        // Which bot a conversation belongs to.
        ctx.slots.inject('conversation.session.header.utilities', () =>
          ctx.slots.register({ name: 'conversation.session.header.utilities', id: 'bots', key: 'bots', order: 40, locale: NS }, withT(SessionBadge)),
        );
        ctx.slots.inject('sidebar.session.row.leading', () => ctx.slots.register({ name: 'sidebar.session.row.leading', id: 'bots', key: 'bots', locale: NS }, withT(SessionRowAvatar)));
        // A bare `/bots` opens the panel.
        if (typeof ctx.inject === 'function') {
          ctx.inject(['commandUi'], (scope) => {
            scope.effect(
              () =>
                scope.commandUi.decorate({
                  name: 'bots',
                  available: () => typeof service('layout')?.selectPanel === 'function',
                  ui: { kind: 'action', run: () => void openPanel() },
                }),
              'bots: /bots opens the panel',
            );
          });
        }
      },
    };
  },
});

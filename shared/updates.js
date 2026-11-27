    // >>> kadaliao-dsh-updates
    // Update reminders shared by every @kadaliao/dsh-* plugin. The canonical copy is shared/updates.js in
    // kadaliao/dsh-plugins, and `node scripts/sync-updates.mjs` there writes it into each plugin's client.js:
    // edit it there, not here.
    //
    // Each plugin checks only itself, and only when it is opened. `opens(View)` wraps the plugin's own view (its
    // panel, Prompt EN's vocabulary tab); mounting that view asks Harness's plugin manager whether a newer version
    // is out (`listVersions`, the same check as its Plugins page), and a newer one shows as a bar across the top of
    // the view. Update runs Harness's `updateBundle`: the new version is checked first, and a failed install puts
    // the old one back. Nothing runs on a timer.
    //
    // A plugin that updates itself is removed mid-update, and Harness closes its view with it; its new client half
    // then loads in place. What the update is doing lives on `window.__kadaliaoDshSelfUpdate`, where the copy that
    // comes next finds it, opens the view again (`options.reopen`) and says how it went. Copies of other versions
    // share it, so its shape only grows:
    //   handoff = { phases: { [name]: { step, from, to, requestId, title, icon, reopen, ... } }, listeners: Set<() => void> }
    //
    // `About` is the plugin's version and a link to its repository, for the plugin to put beside its title.
    // `options.version` is the client half's own version (test/updates.test.mjs keeps it equal to package.json);
    // the repository is https://github.com/kadaliao/<package name> unless `options.repo` says otherwise.
    function kadaliaoUpdates(ctx, options) {
      const HANDOFF_KEY = '__kadaliaoDshSelfUpdate';
      const SNOOZE_MS = 24 * 3600e3;
      // A version is offered once it has been public this long: npm can list a version minutes before it serves the tarball.
      const SETTLE_MS = 10 * 60e3;
      // Opening the view again this soon reuses the last answer instead of asking the registry again.
      const REUSE_MS = 60e3;
      const DONE_HIDE_MS = 15e3;
      const ACTIVE = new Set(['checking', 'removing', 'installing', 'restoring']);
      const React = options.React;
      const h = React.createElement;
      const { useEffect, useState } = React;
      const self = String(options.name);
      const STORE_KEY = `kadaliao-dsh-update:${self}`;
      const VERSION = typeof options.version === 'string' ? options.version : '';
      const REPO = typeof options.repo === 'string' && options.repo !== ''
        ? options.repo
        : `https://github.com/kadaliao/${self.replace(/^@[^/]+\//, '')}`;
      const now = typeof options.now === 'function' ? options.now : () => Date.now();
      const g = typeof window === 'object' && window !== null ? window : globalThis;

      const DICTIONARY = {
        en: {
          title: '{name} {version} is available',
          versions: '{from} → {to}',
          released: 'released {date}',
          update: 'Update',
          retry: 'Try again',
          later: 'Later',
          skip: 'Skip this version',
          close: 'Close',
          details: 'Open in Plugins',
          checking: 'Checking {version}…',
          removing: 'Removing {version}…',
          installing: 'Installing {version}…',
          restoring: 'Putting {version} back…',
          reloads: '{name} closes while it updates and opens again once the new version is in.',
          done: '{name} is updated to {version}.',
          doneRestart: '{name} is updated to {version}. Restart DeepSeek Harness to use it.',
          failed: 'Not updated: {reason}',
          failedRestored: 'Not updated, {version} is back: {reason}',
          failedRemoved: 'Not updated, and {version} could not be put back. Install it again from Plugins.',
          unknown: 'No answer from Harness; check Plugins to see which version is installed.',
          aboutVersion: 'Version {version}',
          aboutSource: 'Source code on GitHub',
        },
        zh: {
          title: '{name} 有新版本 {version}',
          versions: '{from} → {to}',
          released: '{date} 发布',
          update: '更新',
          retry: '再试一次',
          later: '稍后',
          skip: '跳过此版本',
          close: '关闭',
          details: '在插件页查看',
          checking: '正在检查 {version}…',
          removing: '正在移除 {version}…',
          installing: '正在安装 {version}…',
          restoring: '正在装回 {version}…',
          reloads: '更新时{name}会先关闭，装好后自动重新打开。',
          done: '{name} 已更新到 {version}。',
          doneRestart: '{name} 已更新到 {version}，重启 DeepSeek Harness 后生效。',
          failed: '没有更新：{reason}',
          failedRestored: '没有更新，已装回 {version}：{reason}',
          failedRemoved: '没有更新，{version} 也没能装回。请到「插件」里重新安装。',
          unknown: 'Harness 没有回音，请到「插件」里看看装的是哪个版本。',
          aboutVersion: '版本 {version}',
          aboutSource: '在 GitHub 上查看源码',
        },
      };

      // The words stay out of the plugin's own dictionary: Harness's locale picks between two strings, which says the language.
      function language() {
        try {
          if (typeof ctx.locale?.resolveText === 'function') {
            const lang = ctx.locale.resolveText({ en: 'en', zh: 'zh' });
            if (lang === 'zh' || lang === 'en') return lang;
          }
        } catch {
          // The page's language below.
        }
        const lang = String(g.document?.documentElement?.lang || g.navigator?.language || 'en').toLowerCase();
        return lang.startsWith('zh') ? 'zh' : 'en';
      }

      function say(key, params) {
        const template = DICTIONARY[language()][key] ?? DICTIONARY.en[key] ?? key;
        return params ? template.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? '')) : template;
      }

      // --- what this copy knows, and what outlives it ---------------------------------------------

      /** This copy's own view of the plugin: the Remote it may use, the last offer, and whether the view is open. */
      const local = { remote: null, offer: null, checking: false, checkedAt: 0, viewing: 0 };
      const renders = new Set();

      const handoff = (() => {
        let current = g[HANDOFF_KEY];
        if (current === null || typeof current !== 'object' || current.phases === null || typeof current.phases !== 'object') {
          current = { phases: {}, listeners: new Set() };
          try {
            g[HANDOFF_KEY] = current;
          } catch {
            // A frozen global keeps the update to this copy.
          }
        }
        if (!(current.listeners instanceof Set)) current.listeners = new Set();
        return current;
      })();

      function notify() {
        for (const render of [...renders]) {
          try {
            render();
          } catch {
            // One view failing leaves the others.
          }
        }
      }

      /** Every copy alive redraws: an update a removed copy started ends in the copy that replaced it. */
      function emit() {
        for (const listener of [...handoff.listeners]) {
          try {
            listener();
          } catch {
            // As above.
          }
        }
        if (!handoff.listeners.has(notify)) notify();
      }

      function phaseOf() {
        const phase = handoff.phases[self];
        return phase !== null && typeof phase === 'object' ? phase : undefined;
      }

      function setPhase(phase) {
        if (phase === undefined) delete handoff.phases[self];
        else handoff.phases[self] = phase;
        emit();
      }

      // --- what this browser remembers -------------------------------------------------------------

      function emptyStore() {
        return { v: 1, snoozed: null, snoozedUntil: 0, skipped: null };
      }

      function readStore() {
        try {
          const raw = g.localStorage?.getItem(STORE_KEY);
          const value = raw ? JSON.parse(raw) : null;
          if (value !== null && typeof value === 'object' && value.v === 1) return { ...emptyStore(), ...value };
        } catch {
          // A private window or a blocked store remembers nothing.
        }
        return emptyStore();
      }

      function writeStore(change) {
        const next = { ...readStore(), ...change, v: 1 };
        try {
          g.localStorage?.setItem(STORE_KEY, JSON.stringify(next));
        } catch {
          // As above.
        }
        return next;
      }

      // --- reading Harness's answers ---------------------------------------------------------------

      function messageOf(error) {
        if (error instanceof Error) return error.message;
        return typeof error === 'string' ? error : 'unknown error';
      }

      /** A Remote answer `{ ok, value }` or `{ ok: false, error }`; a bare value passes through. */
      function unwrap(answer) {
        if (answer !== null && typeof answer === 'object' && typeof answer.ok === 'boolean') {
          return answer.ok ? { ok: true, value: answer.value } : { ok: false, message: answer.error?.message ?? 'refused' };
        }
        return { ok: true, value: answer };
      }

      async function call(remote, method, ...args) {
        try {
          const fn = remote?.pluginManager?.[method];
          if (typeof fn !== 'function') return { ok: false, message: `pluginManager.${method} is missing` };
          return unwrap(await fn.apply(remote.pluginManager, args));
        } catch (error) {
          return { ok: false, message: messageOf(error) };
        }
      }

      function installable(version) {
        return version !== null && typeof version === 'object' && typeof version.version === 'string'
          && version.bundle === true && version.incompatible === undefined && version.deprecated === undefined && version.prerelease !== true;
      }

      function settled(version, at) {
        const published = typeof version.publishedAt === 'string' ? Date.parse(version.publishedAt) : NaN;
        return !Number.isFinite(published) || published + SETTLE_MS <= at;
      }

      /** The newest version worth offering from a listing (newest first, all newer than the installed one). */
      function choose(list, at) {
        if (list === null || typeof list !== 'object' || list.status !== 'listed' || !Array.isArray(list.versions)) return undefined;
        return list.versions.find((version) => installable(version) && settled(version, at));
      }

      /** This plugin as Harness lists it: null when the list could not be read, undefined when it is not there. */
      async function mine(remote) {
        const answer = await call(remote, 'listBundles');
        if (!answer.ok || !Array.isArray(answer.value)) return null;
        return answer.value.find((bundle) => bundle !== null && typeof bundle === 'object' && bundle.name === self && bundle.installed !== false);
      }

      /** What is installed settles an update whose answer was lost, and retires an offer another surface applied. */
      function settleWith(bundle) {
        const version = typeof bundle?.version === 'string' ? bundle.version : undefined;
        const phase = phaseOf();
        if (phase !== undefined && (ACTIVE.has(phase.step) || phase.step === 'unknown') && version === phase.to) setPhase({ ...phase, step: 'done' });
        if (local.offer !== null && local.offer.installed !== version) {
          local.offer = null;
          local.checkedAt = 0;
        }
      }

      async function check(remote) {
        if (local.checking) return;
        local.checking = true;
        try {
          const bundle = await mine(remote);
          // An unreadable list is asked again the next time the view opens.
          if (bundle === null) return;
          settleWith(bundle);
          // Only a copy installed from a registry and switched on is offered updates; a folder or Git install is not.
          if (bundle === undefined || bundle.update !== 'registry' || bundle.enabled === false || typeof bundle.version !== 'string') {
            local.offer = null;
            local.checkedAt = now();
            return;
          }
          const answer = await call(remote, 'listVersions', self, {});
          if (!answer.ok || answer.value?.status !== 'listed') return;
          const chosen = choose(answer.value, now());
          local.offer = chosen === undefined
            ? null
            : {
              name: self,
              title: bundle.meta?.title ?? null,
              icon: typeof bundle.meta?.icon === 'string' ? bundle.meta.icon : null,
              installed: typeof answer.value.installed === 'string' ? answer.value.installed : bundle.version,
              version: chosen.version,
              publishedAt: typeof chosen.publishedAt === 'string' ? chosen.publishedAt : null,
              registry: answer.value.registry === undefined ? null : answer.value.registry,
            };
          local.checkedAt = now();
        } finally {
          local.checking = false;
          emit();
        }
      }

      /** Ask again when the view is open and the last answer is older than a minute. */
      function maybeCheck() {
        if (local.remote === null || local.viewing === 0 || local.checking || now() - local.checkedAt < REUSE_MS) return;
        void check(local.remote).catch(() => {});
      }

      async function revalidate(remote) {
        const bundle = await mine(remote);
        if (bundle === null) return;
        settleWith(bundle);
        emit();
        maybeCheck();
      }

      /** The view opened: check, and return what closing it does. */
      function opened() {
        local.viewing += 1;
        maybeCheck();
        let open = true;
        return () => {
          if (!open) return;
          open = false;
          local.viewing = Math.max(0, local.viewing - 1);
        };
      }

      function uuid() {
        try {
          if (typeof g.crypto?.randomUUID === 'function') return g.crypto.randomUUID();
        } catch {
          // An insecure context has no randomUUID.
        }
        const bytes = new Uint8Array(16);
        try {
          g.crypto.getRandomValues(bytes);
        } catch {
          for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
        }
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      }

      function isApplied(result) {
        const application = result?.application;
        return application === 'applied' || application === 'overridden' || application === 'restart-required';
      }

      /** How an update ended, as the bar says it. */
      function outcomeOf(answer, from) {
        if (!answer.ok) return { step: 'unknown', reason: answer.message };
        const value = answer.value ?? {};
        const result = value.result ?? {};
        if (isApplied(result)) return { step: 'done', restart: result.application === 'restart-required' };
        const reason = String(result.error?.diagnostic || result.error?.code || result.application || 'failed').trim();
        if (value.restore === undefined) return { step: 'failed', reason, kept: true };
        if (isApplied(value.restore)) return { step: 'failed', reason, restored: true, from };
        return { step: 'failed', reason, removed: true, from };
      }

      async function update() {
        const remote = local.remote;
        const offer = local.offer;
        const phase = phaseOf();
        if (remote === null || offer === null || (phase !== undefined && (ACTIVE.has(phase.step) || phase.step === 'done'))) return;
        const requestId = uuid();
        // Harness closes the view when it removes this version; the copy that comes next opens it again.
        setPhase({ step: 'checking', from: offer.installed, to: offer.version, requestId, title: offer.title, icon: offer.icon, reopen: local.viewing > 0 });
        const answer = await call(remote, 'updateBundle', self, offer.version, { registry: offer.registry, requestId });
        const outcome = outcomeOf(answer, offer.installed);
        const current = phaseOf();
        // Closed meanwhile, or a lost answer arriving after what is installed already said it worked.
        if (current?.requestId !== requestId || (outcome.step === 'unknown' && current.step === 'done')) return;
        setPhase({ ...current, ...outcome });
        if (outcome.step === 'done' && local.offer?.version === offer.version) local.offer = null;
        // A lost answer is settled by what is installed now.
        if (outcome.step === 'unknown' && local.remote !== null) await revalidate(local.remote);
      }

      function progress(event) {
        const phase = phaseOf();
        if (event === null || typeof event !== 'object' || typeof event.step !== 'string' || phase === undefined) return;
        if (phase.requestId === event.requestId && ACTIVE.has(phase.step)) setPhase({ ...phase, step: event.step });
      }

      /** What the bar shows, if anything. */
      function shown() {
        const phase = phaseOf();
        if (phase !== undefined) return { phase, offer: local.offer };
        const offer = local.offer;
        if (offer === null) return null;
        const store = readStore();
        if (store.skipped === offer.version) return null;
        if (store.snoozed === offer.version && now() < store.snoozedUntil) return null;
        return { phase: undefined, offer };
      }

      /** Forget how the last update ended; one still running stays. */
      function close() {
        const phase = phaseOf();
        if (phase === undefined || ACTIVE.has(phase.step)) return;
        if (phase.step === 'done' && local.offer?.version === phase.to) local.offer = null;
        setPhase(undefined);
      }

      function later() {
        const view = shown();
        if (view === null || (view.phase !== undefined && ACTIVE.has(view.phase.step))) return;
        close();
        if (view.offer !== null) writeStore({ snoozed: view.offer.version, snoozedUntil: now() + SNOOZE_MS });
        emit();
      }

      function skip() {
        const view = shown();
        if (view === null || view.offer === null || (view.phase !== undefined && ACTIVE.has(view.phase.step))) return;
        close();
        writeStore({ skipped: view.offer.version });
        emit();
      }

      // --- the bar ---------------------------------------------------------------------------------

      const C = {
        tint: 'color-mix(in srgb, var(--dsw-alias-brand-primary, #4d6bfe) 8%, var(--dsw-alias-bg-layer-1, #fff))',
        border: 'var(--dsw-alias-border-l1, rgba(0,0,0,.08))',
        primary: 'var(--dsw-alias-label-primary, #1f2329)',
        muted: 'var(--dsw-alias-label-secondary, #646a73)',
        faint: 'var(--dsw-alias-label-tertiary, #8f959e)',
        brand: 'var(--dsw-alias-brand-primary, #4d6bfe)',
        onBrand: 'var(--dsw-alias-label-primary-foreground, #fff)',
        ok: 'var(--dsw-alias-state-success-primary, #2ea121)',
        error: 'var(--dsw-alias-state-error-primary, #d83931)',
      };

      function titleOf(title) {
        if (title !== null && title !== undefined) {
          try {
            if (typeof ctx.locale?.resolveText === 'function') {
              const text = ctx.locale.resolveText(title);
              if (typeof text === 'string' && text !== '') return text;
            }
          } catch {
            // The fallback below.
          }
          if (typeof title === 'string') return title;
          if (typeof title === 'object') return title[language()] ?? title.en ?? self;
        }
        return self.replace(/^@kadaliao\/dsh-/, '');
      }

      function day(iso) {
        const at = typeof iso === 'string' ? new Date(iso) : null;
        if (at === null || Number.isNaN(at.getTime())) return null;
        const pad = (n) => String(n).padStart(2, '0');
        return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
      }

      /** The line of a pnpm log that says what went wrong, else its last line, kept short; the whole log goes in the tooltip. */
      function headline(text) {
        const lines = String(text ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        const line = lines.find((l) => /\bERR_[A-Z0-9_]+|\bERR!|\berror\b/i.test(l)) ?? lines.at(-1) ?? '';
        return line.length > 160 ? `${line.slice(0, 157)}…` : line;
      }

      function Btn({ kind, onClick, children, label }) {
        const primary = kind === 'update';
        return h(
          'button',
          {
            type: 'button',
            onClick,
            'aria-label': label,
            title: label,
            'data-kadaliao-update-action': kind,
            style: {
              font: 'inherit',
              fontSize: 12,
              lineHeight: '18px',
              padding: primary ? '3px 10px' : '3px 6px',
              borderRadius: 6,
              border: 0,
              background: primary ? C.brand : 'transparent',
              color: primary ? C.onBrand : C.muted,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              flexShrink: 0,
            },
          },
          children,
        );
      }

      /** The bar's two lines: what it is about, and the detail under it. */
      function lines(view, name) {
        const { phase, offer } = view;
        const to = phase?.to ?? offer?.version;
        const date = offer === null ? null : day(offer.publishedAt);
        const meta = offer === null ? null : [say('versions', { from: offer.installed, to: offer.version }), date === null ? null : say('released', { date })].filter(Boolean).join(' · ');
        if (phase === undefined) return { head: say('title', { name, version: to }), detail: meta, tone: 'muted' };
        if (ACTIVE.has(phase.step)) {
          const version = phase.step === 'restoring' || phase.step === 'removing' ? phase.from : phase.to;
          return { head: say(phase.step, { version }), detail: say('reloads', { name }), tone: 'muted' };
        }
        if (phase.step === 'done') return { head: say(phase.restart ? 'doneRestart' : 'done', { name, version: phase.to }), detail: null, tone: 'ok' };
        const head = say('title', { name, version: to });
        if (phase.step === 'unknown') return { head, detail: say('unknown'), tone: 'error', full: phase.reason };
        if (phase.removed) return { head, detail: say('failedRemoved', { version: phase.from }), tone: 'error', full: phase.reason };
        if (phase.restored) return { head, detail: say('failedRestored', { version: phase.from, reason: headline(phase.reason) }), tone: 'error', full: phase.reason };
        return { head, detail: say('failed', { reason: headline(phase.reason) }), tone: 'error', full: phase.reason };
      }

      function Bar() {
        const [, setTick] = useState(0);
        useEffect(() => {
          const render = () => setTick((n) => n + 1);
          renders.add(render);
          return () => {
            renders.delete(render);
          };
        }, []);
        const view = shown();
        const done = view?.phase?.step === 'done';
        useEffect(() => {
          if (!done) return undefined;
          const timer = setTimeout(close, DONE_HIDE_MS);
          return () => clearTimeout(timer);
        }, [done]);
        if (view === null) return null;
        const { phase, offer } = view;
        const name = titleOf(phase?.title ?? offer?.title);
        const icon = phase?.icon ?? offer?.icon ?? null;
        const busy = phase !== undefined && ACTIVE.has(phase.step);
        const text = lines(view, name);
        const navigation = (() => {
          try {
            const face = ctx.get?.('pluginNavigation');
            return typeof face?.openBundle === 'function' ? face : null;
          } catch {
            return null;
          }
        })();
        const canUpdate = offer !== null && (phase === undefined || phase.step === 'failed' || phase.step === 'unknown');
        const buttons = busy
          ? []
          : done
            ? [h(Btn, { key: 'close', kind: 'close', onClick: close, label: say('close') }, '×')]
            : [
              canUpdate ? h(Btn, { key: 'update', kind: 'update', onClick: () => void update(), label: say(phase === undefined ? 'update' : 'retry') }, say(phase === undefined ? 'update' : 'retry')) : null,
              h(Btn, { key: 'later', kind: 'later', onClick: later, label: say('later') }, say('later')),
              offer !== null ? h(Btn, { key: 'skip', kind: 'skip', onClick: skip, label: say('skip') }, say('skip')) : null,
            ].filter(Boolean);
        return h(
          'div',
          {
            role: 'status',
            'aria-live': 'polite',
            'data-kadaliao-update': phase?.step ?? 'offer',
            style: {
              display: 'flex',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: '6px 10px',
              padding: '8px 12px',
              background: C.tint,
              borderBottom: `1px solid ${C.border}`,
              color: C.primary,
              fontSize: 13,
              lineHeight: '18px',
              flexShrink: 0,
              boxSizing: 'border-box',
            },
          },
          icon ? h('img', { src: icon, alt: '', width: 20, height: 20, style: { width: 20, height: 20, borderRadius: 5, flexShrink: 0, objectFit: 'cover' } }) : null,
          h(
            'div',
            { style: { flex: '1 1 180px', minWidth: 0 } },
            h(
              navigation ? 'button' : 'div',
              navigation
                ? {
                  type: 'button',
                  title: say('details'),
                  onClick: () => navigation.openBundle(self),
                  style: { font: 'inherit', fontWeight: 600, color: text.tone === 'ok' ? C.ok : C.primary, background: 'none', border: 0, padding: 0, cursor: 'pointer', textAlign: 'left' },
                }
                : { style: { fontWeight: 600, color: text.tone === 'ok' ? C.ok : C.primary } },
              text.head,
            ),
            text.detail === null
              ? null
              : h(
                'div',
                {
                  'data-kadaliao-update-detail': '',
                  title: text.full ?? undefined,
                  style: { fontSize: 12, marginTop: 1, color: text.tone === 'error' ? C.error : C.muted, overflowWrap: 'anywhere' },
                },
                text.detail,
              ),
          ),
          buttons.length === 0 ? null : h('div', { style: { display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0, marginLeft: 'auto' } }, buttons),
        );
      }

      const FRAME = { display: 'flex', flexDirection: 'column', height: '100%', width: '100%', minHeight: 0, minWidth: 0 };
      const BODY = { flex: '1 1 0%', minHeight: 0, minWidth: 0, position: 'relative' };

      /** The plugin's own view, with the bar above it; opening it is what checks. The frame never changes shape, so the view is not remounted when the bar comes and goes. */
      function opens(View) {
        if (View === null || View === undefined) return View;
        return function KadaliaoUpdateFrame(props) {
          useEffect(() => opened(), []);
          return h('div', { 'data-kadaliao-update-frame': self, style: FRAME }, h(Bar, null), h('div', { style: BODY }, h(View, props)));
        };
      }

      // --- version and repository -------------------------------------------------------------------

      // GitHub's mark (Octicons mark-github), drawn in the text colour.
      const GITHUB_MARK = 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z';

      /** The plugin's version and a GitHub mark linking to its repository, small and muted; `style` overrides the colour or spacing. */
      function About(props) {
        const style = props?.style ?? null;
        const size = typeof props?.size === 'number' ? props.size : 14;
        return h(
          'span',
          {
            'data-kadaliao-about': self,
            style: { display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0, fontSize: 12, lineHeight: '16px', fontWeight: 400, color: C.faint, whiteSpace: 'nowrap', ...style },
          },
          VERSION === ''
            ? null
            : h('span', { 'data-kadaliao-version': VERSION, title: say('aboutVersion', { version: VERSION }), style: { fontVariantNumeric: 'tabular-nums', userSelect: 'text' } }, `v${VERSION}`),
          h(
            'a',
            {
              href: REPO,
              target: '_blank',
              rel: 'noopener noreferrer',
              title: say('aboutSource'),
              'aria-label': say('aboutSource'),
              'data-kadaliao-repo': REPO,
              onClick: (event) => event?.stopPropagation?.(),
              style: { display: 'inline-flex', alignItems: 'center', color: 'inherit', padding: 2, margin: -2, borderRadius: 4, textDecoration: 'none' },
            },
            h('svg', { viewBox: '0 0 16 16', width: size, height: size, fill: 'currentColor', 'aria-hidden': 'true', style: { display: 'block' } }, h('path', { d: GITHUB_MARK })),
          ),
        );
      }

      // --- joining ---------------------------------------------------------------------------------

      const api = { opens, opened, check, update, later, skip, close, shown, readStore, choose, outcomeOf, headline, local, handoff, About, version: VERSION, repo: REPO };
      if (typeof ctx.effect === 'function') {
        ctx.effect(() => {
          handoff.listeners.add(notify);
          return () => {
            handoff.listeners.delete(notify);
          };
        }, `${self}: update handoff`);
      } else {
        handoff.listeners.add(notify);
      }
      if (typeof ctx.inject !== 'function') return api;
      const join = (scope) => {
        const remote = scope.remote;
        if (remote === null || typeof remote !== 'object' || typeof remote.pluginManager?.listBundles !== 'function') return undefined;
        const offs = [];
        const listen = (event, fn) => {
          try {
            const off = remote.$on?.(event, fn);
            if (typeof off === 'function') offs.push(off);
          } catch {
            // A Remote without events still checks when the view opens.
          }
        };
        local.remote = remote;
        listen('plugin-manager/changed', () => void revalidate(remote).catch(() => {}));
        listen('plugin-manager/update-state', progress);
        // A copy that replaced one mid-update opens the view Harness closed and reads how it went; a view already open checks now.
        const phase = phaseOf();
        if (phase !== undefined) {
          if (phase.reopen === true) {
            setPhase({ ...phase, reopen: false });
            // After apply(ctx) has registered the view, which may still be running when this joins.
            void Promise.resolve()
              .then(() => {
                if (typeof options.reopen === 'function') options.reopen();
              })
              .catch(() => {
                // The view stays closed; the bar shows the next time it opens.
              });
          }
          void revalidate(remote).catch(() => {});
        } else {
          maybeCheck();
        }
        emit();
        return () => {
          for (const off of offs.splice(0)) {
            try {
              off();
            } catch {
              // Already gone.
            }
          }
          if (local.remote === remote) local.remote = null;
          emit();
        };
      };
      ctx.inject(['remote', 'remote.pluginManager', 'remoteAccess'], (scope) => {
        const access = scope.remoteAccess;
        if (access !== null && typeof access === 'object' && typeof access.whenAccess === 'function') {
          // Only a Peer that may update plugins is told about updates; the owner always may.
          return access.whenAccess('pluginManager/updateBundle', () => join(scope) ?? (() => {}));
        }
        return join(scope);
      });
      return api;
    }
    // <<< kadaliao-dsh-updates

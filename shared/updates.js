    // >>> kadaliao-dsh-updates
    // Update reminders shared by every @kadaliao/dsh-* plugin. The canonical copy is shared/updates.js in
    // kadaliao/dsh-plugins, and `node scripts/sync-updates.mjs` there writes it into each plugin's client.js:
    // edit it there, not here.
    //
    // Every installed @kadaliao/dsh-* plugin — including older versions without this code — is checked with
    // Harness's own plugin manager (`listVersions`, the same check as its Plugins page) and offered on one card,
    // however many of the plugins carry this code: each copy joins `window.__kadaliaoDshUpdates`, and only the
    // copy with the newest UPDATES_IMPL (the first loaded among equals) checks and draws. The others stand by
    // and take over when it is switched off or replaced, which is what happens while a plugin updates itself.
    // Update runs Harness's `updateBundle`: the new version is checked first, and a failed install puts the
    // old one back.
    //
    // The hub is shared with copies of other versions, so its shape only grows:
    //   hub = { members: Member[], state: object | null }
    //   Member = { impl: number, name: string, notify(), activate(), deactivate() }
    function kadaliaoUpdates(ctx, options) {
      const UPDATES_IMPL = 1;
      const FAMILY = /^@kadaliao\/dsh-[a-z0-9][a-z0-9-]*$/;
      const HUB_KEY = '__kadaliaoDshUpdates';
      const STORE_KEY = 'kadaliao-dsh-updates';
      const HOUR = 3600e3;
      const CHECK_EVERY_MS = 6 * HOUR;
      const SNOOZE_MS = 24 * HOUR;
      // A version is offered once it has been public this long: npm can list a version minutes before it serves the tarball.
      const SETTLE_MS = 30 * 60e3;
      const FIRST_CHECK_MS = options.firstCheckMs ?? 20e3;
      const DONE_HIDE_MS = 15e3;
      const RETRY_MS = 30 * 60e3;
      const ACTIVE = new Set(['checking', 'removing', 'installing', 'restoring']);
      const React = options.React;
      const h = React.createElement;
      const { useEffect, useState } = React;
      const self = String(options.name);
      const now = typeof options.now === 'function' ? options.now : () => Date.now();
      const g = typeof window === 'object' && window !== null ? window : globalThis;
      const SLOT_ID = `kadaliao-updates.${self.replace(/^@kadaliao\//, '')}`;

      const DICTIONARY = {
        en: {
          titleOne: '{name} {version} is available',
          titleMany: 'Updates for {n} plugins',
          titleDone: 'Plugins updated',
          versions: '{from} → {to}',
          released: 'released {date}',
          update: 'Update',
          updateAll: 'Update all',
          later: 'Later',
          skipOne: 'Skip this version',
          skipMany: 'Skip these versions',
          close: 'Close',
          details: 'Open in Plugins',
          checking: 'Checking {version}…',
          removing: 'Removing {version}…',
          installing: 'Installing {version}…',
          restoring: 'Putting {version} back…',
          done: 'Updated to {version}.',
          doneRestart: 'Updated to {version}. Restart DeepSeek Harness to use it.',
          failed: 'Not updated: {reason}',
          failedRestored: 'Not updated, {version} is back: {reason}',
          failedRemoved: 'Not updated, and {version} could not be put back. Install it again from Plugins.',
          unknown: 'No answer from Harness; check Plugins to see which version is installed.',
        },
        zh: {
          titleOne: '{name} 有新版本 {version}',
          titleMany: '{n} 个插件有新版本',
          titleDone: '插件已更新',
          versions: '{from} → {to}',
          released: '{date} 发布',
          update: '更新',
          updateAll: '全部更新',
          later: '稍后',
          skipOne: '跳过此版本',
          skipMany: '跳过这些版本',
          close: '关闭',
          details: '在插件页查看',
          checking: '正在检查 {version}…',
          removing: '正在移除 {version}…',
          installing: '正在安装 {version}…',
          restoring: '正在装回 {version}…',
          done: '已更新到 {version}。',
          doneRestart: '已更新到 {version}，重启 DeepSeek Harness 后生效。',
          failed: '没有更新：{reason}',
          failedRestored: '没有更新，已装回 {version}：{reason}',
          failedRemoved: '没有更新，{version} 也没能装回。请到「插件」里重新安装。',
          unknown: 'Harness 没有回音，请到「插件」里看看装的是哪个版本。',
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

      // --- the hub every copy shares ---------------------------------------------------------------

      const hub = (() => {
        let current = g[HUB_KEY];
        if (current === null || typeof current !== 'object' || !Array.isArray(current.members)) {
          current = { members: [], state: null };
          try {
            g[HUB_KEY] = current;
          } catch {
            // A frozen global keeps this copy to itself.
          }
        }
        return current;
      })();

      function leader() {
        let best;
        for (const member of hub.members) if (best === undefined || member.impl > best.impl) best = member;
        return best;
      }

      function emit() {
        for (const member of hub.members.slice()) {
          try {
            member.notify();
          } catch {
            // One copy's render failing leaves the others.
          }
        }
      }

      function elect() {
        const lead = leader();
        for (const member of hub.members.slice()) {
          try {
            if (member === lead) member.activate();
            else member.deactivate();
          } catch {
            // As above.
          }
        }
        emit();
      }

      /** What the card shows; a copy of another implementation starts it afresh but keeps updates in progress. */
      function state() {
        const current = hub.state;
        if (current === null || typeof current !== 'object' || current.impl !== UPDATES_IMPL) {
          // Rows and updates are plain data every implementation reads alike.
          const old = current !== null && typeof current === 'object' ? current : {};
          const phases = old.phases !== null && typeof old.phases === 'object' ? old.phases : {};
          hub.state = { impl: UPDATES_IMPL, offers: Array.isArray(old.offers) ? old.offers : null, phases, checking: false };
        }
        return hub.state;
      }

      function patch(change) {
        change(state());
        emit();
      }

      // --- what this browser remembers -------------------------------------------------------------

      function emptyStore() {
        return { v: 1, checkedAt: 0, failedAt: 0, recheckAt: 0, offers: [], snoozed: {}, snoozedUntil: 0, skipped: {} };
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

      function settlesAt(version) {
        const published = typeof version.publishedAt === 'string' ? Date.parse(version.publishedAt) : NaN;
        return Number.isFinite(published) ? published + SETTLE_MS : 0;
      }

      /** The newest version worth offering from a listing, and when a newer one still settling is due. */
      function choose(list, at) {
        if (list === null || typeof list !== 'object' || list.status !== 'listed' || !Array.isArray(list.versions)) return { offer: undefined, recheckAt: 0 };
        let recheckAt = 0;
        for (const version of list.versions) {
          if (!installable(version)) continue;
          const due = settlesAt(version);
          if (due <= at) return { offer: version, recheckAt };
          if (recheckAt === 0 || due < recheckAt) recheckAt = due;
        }
        return { offer: undefined, recheckAt };
      }

      async function family(remote) {
        const answer = await call(remote, 'listBundles');
        if (!answer.ok || !Array.isArray(answer.value)) return null;
        return answer.value.filter((bundle) => bundle !== null && typeof bundle === 'object' && typeof bundle.name === 'string'
          && FAMILY.test(bundle.name) && bundle.installed !== false);
      }

      /** Check every installed kadaliao plugin Harness can update from a registry, one after another. */
      async function check(remote) {
        if (state().checking) return;
        patch((s) => {
          s.checking = true;
        });
        try {
          const bundles = await family(remote);
          const at = now();
          if (bundles === null) {
            writeStore({ failedAt: at });
            return;
          }
          const previous = readStore().offers;
          const offers = [];
          let recheckAt = 0;
          for (const bundle of bundles) {
            if (bundle.update !== 'registry' || bundle.enabled === false || typeof bundle.version !== 'string') continue;
            const answer = await call(remote, 'listVersions', bundle.name, {});
            if (!answer.ok || answer.value?.status !== 'listed') {
              // A registry that did not answer this time leaves what the last check found.
              const kept = previous.find((offer) => offer.name === bundle.name && offer.installed === bundle.version);
              if (kept !== undefined) offers.push(kept);
              continue;
            }
            const chosen = choose(answer.value, at);
            if (chosen.recheckAt > 0 && (recheckAt === 0 || chosen.recheckAt < recheckAt)) recheckAt = chosen.recheckAt;
            if (chosen.offer === undefined) continue;
            offers.push({
              name: bundle.name,
              title: bundle.meta?.title ?? null,
              icon: typeof bundle.meta?.icon === 'string' ? bundle.meta.icon : null,
              installed: typeof answer.value.installed === 'string' ? answer.value.installed : bundle.version,
              version: chosen.offer.version,
              publishedAt: typeof chosen.offer.publishedAt === 'string' ? chosen.offer.publishedAt : null,
              registry: answer.value.registry === undefined ? null : answer.value.registry,
            });
          }
          writeStore({ checkedAt: at, failedAt: 0, recheckAt, offers });
          patch((s) => {
            // An update in progress keeps its row even when the listing no longer names it.
            const kept = (s.offers ?? []).filter((offer) => s.phases[offer.name] !== undefined && !offers.some((o) => o.name === offer.name));
            s.offers = [...kept, ...offers];
          });
        } finally {
          patch((s) => {
            s.checking = false;
          });
        }
      }

      /** Drop offers another surface already applied, and finish updates whose answer never came back. */
      async function revalidate(remote) {
        const bundles = await family(remote);
        if (bundles === null) return;
        const installed = new Map(bundles.map((bundle) => [bundle.name, bundle.version]));
        patch((s) => {
          // The installed version settles an update whose answer was lost; an answer that comes later still has the last word.
          for (const [name, phase] of Object.entries(s.phases)) {
            if ((ACTIVE.has(phase.step) || phase.step === 'unknown') && installed.get(name) === phase.to) s.phases[name] = { ...phase, step: 'done' };
          }
          // Until a first answer, the card shows nothing; then the last check's offers that still describe what is installed.
          s.offers = (s.offers ?? readStore().offers).filter((offer) => s.phases[offer.name] !== undefined || installed.get(offer.name) === offer.installed);
        });
        const offers = readStore().offers.filter((offer) => installed.get(offer.name) === offer.installed);
        writeStore({ offers });
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

      /** How an update ended, as the row says it. */
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

      function currentRemote(fallback) {
        return leader()?.remote ?? fallback;
      }

      async function update(remote, name) {
        const s = state();
        const offer = (s.offers ?? []).find((item) => item.name === name);
        const phase = s.phases[name];
        if (offer === undefined || (phase !== undefined && (ACTIVE.has(phase.step) || phase.step === 'done'))) return;
        const requestId = uuid();
        patch((next) => {
          next.phases[name] = { step: 'checking', to: offer.version, from: offer.installed, requestId };
        });
        const answer = await call(remote, 'updateBundle', name, offer.version, { registry: offer.registry, requestId });
        const outcome = outcomeOf(answer, offer.installed);
        patch((next) => {
          next.phases[name] = { ...next.phases[name], ...outcome };
        });
        if (outcome.step === 'done') writeStore({ offers: readStore().offers.filter((item) => item.name !== name) });
        // A lost answer is settled by what is installed now, read by whichever copy leads after the update.
        if (outcome.step === 'unknown') await revalidate(currentRemote(remote));
      }

      async function updateAll(remote) {
        for (const offer of shownOffers()) await update(currentRemote(remote), offer.name);
      }

      function progress(event) {
        if (event === null || typeof event !== 'object' || typeof event.step !== 'string') return;
        patch((s) => {
          for (const [name, phase] of Object.entries(s.phases)) {
            if (phase.requestId === event.requestId && ACTIVE.has(phase.step)) s.phases[name] = { ...phase, step: event.step };
          }
        });
      }

      function shownOffers() {
        const s = state();
        const store = readStore();
        const at = now();
        return (s.offers ?? []).filter((offer) => {
          if (s.phases[offer.name] !== undefined) return true;
          if (store.skipped[offer.name] === offer.version) return false;
          return !(store.snoozed[offer.name] === offer.version && at < store.snoozedUntil);
        });
      }

      function later(offers) {
        const store = readStore();
        writeStore({
          snoozed: { ...store.snoozed, ...Object.fromEntries(offers.map((offer) => [offer.name, offer.version])) },
          snoozedUntil: now() + SNOOZE_MS,
        });
        close();
      }

      function skip(offers) {
        const store = readStore();
        writeStore({ skipped: { ...store.skipped, ...Object.fromEntries(offers.map((offer) => [offer.name, offer.version])) } });
        close();
      }

      /** Forget finished rows; rows still updating stay. */
      function close() {
        patch((s) => {
          for (const [name, phase] of Object.entries(s.phases)) {
            if (!ACTIVE.has(phase.step)) {
              delete s.phases[name];
              if (phase.step === 'done') s.offers = (s.offers ?? []).filter((offer) => offer.name !== name);
            }
          }
        });
      }

      // --- the leader's timers ---------------------------------------------------------------------

      function lead(member) {
        const remote = member.remote;
        const startedAt = now();
        let stopped = false;
        let timer = null;
        const offs = [];
        const wait = (fn, ms) => {
          if (timer !== null) clearTimeout(timer);
          timer = setTimeout(fn, Math.max(1000, Math.min(ms, 2 ** 31 - 1)));
        };
        const due = () => {
          const store = readStore();
          let at = Math.max(store.checkedAt + CHECK_EVERY_MS, startedAt + FIRST_CHECK_MS);
          if (store.recheckAt > 0) at = Math.min(at, Math.max(store.recheckAt, startedAt + FIRST_CHECK_MS));
          return Math.max(at, store.failedAt + RETRY_MS);
        };
        const tick = () => {
          timer = null;
          if (stopped) return;
          if (g.document?.hidden === true) return wait(tick, 60e3);
          // Another window may have checked meanwhile.
          if (now() < due()) return wait(tick, due() - now());
          check(remote)
            .catch(() => {})
            .finally(() => {
              if (!stopped) wait(tick, due() - now());
            });
        };
        wait(tick, due() - now());
        const listen = (event, fn) => {
          try {
            const off = remote.$on?.(event, fn);
            if (typeof off === 'function') offs.push(off);
          } catch {
            // A Remote without events still checks on its timer.
          }
        };
        listen('plugin-manager/changed', () => void revalidate(remote).catch(() => {}));
        listen('plugin-manager/update-state', progress);
        void revalidate(remote).catch(() => {});
        return () => {
          stopped = true;
          if (timer !== null) clearTimeout(timer);
          for (const off of offs.splice(0)) {
            try {
              off();
            } catch {
              // Already gone.
            }
          }
        };
      }

      // --- the card --------------------------------------------------------------------------------

      const C = {
        surface: 'var(--dsw-alias-bg-elevated, var(--dsw-alias-bg-layer-1, #fff))',
        border: 'var(--dsw-alias-border-l1, rgba(0,0,0,.08))',
        primary: 'var(--dsw-alias-label-primary, #1f2329)',
        muted: 'var(--dsw-alias-label-secondary, #646a73)',
        faint: 'var(--dsw-alias-label-tertiary, #8f959e)',
        brand: 'var(--dsw-alias-brand-primary, #4d6bfe)',
        onBrand: 'var(--dsw-alias-label-on-brand, #fff)',
        hover: 'var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05))',
        ok: 'var(--dsw-alias-state-success-primary, #2ea121)',
        error: 'var(--dsw-alias-state-error-primary, #d83931)',
      };

      function titleOf(offer) {
        const title = offer.title;
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
          if (typeof title === 'object') return title[language()] ?? title.en ?? offer.name;
        }
        return offer.name.replace(/^@kadaliao\/dsh-/, '');
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

      function Btn({ kind, onClick, disabled, children, label }) {
        const primary = kind === 'primary';
        return h(
          'button',
          {
            type: 'button',
            onClick,
            disabled,
            'aria-label': label,
            'data-kadaliao-updates-action': kind,
            style: {
              font: 'inherit',
              fontSize: 12,
              lineHeight: '18px',
              padding: primary ? '3px 10px' : '3px 6px',
              borderRadius: 6,
              border: primary ? 'none' : '0',
              background: primary ? C.brand : 'transparent',
              color: primary ? C.onBrand : C.muted,
              cursor: disabled ? 'default' : 'pointer',
              opacity: disabled ? 0.5 : 1,
              whiteSpace: 'nowrap',
              flexShrink: 0,
            },
          },
          children,
        );
      }

      function statusLine(phase, title) {
        if (phase === undefined) return null;
        if (ACTIVE.has(phase.step)) {
          const version = phase.step === 'restoring' || phase.step === 'removing' ? phase.from : phase.to;
          return { tone: 'busy', text: say(phase.step, { version, name: title }) };
        }
        if (phase.step === 'done') return { tone: 'ok', text: say(phase.restart ? 'doneRestart' : 'done', { version: phase.to }) };
        if (phase.step === 'unknown') return { tone: 'error', text: say('unknown'), full: phase.reason };
        if (phase.removed) return { tone: 'error', text: say('failedRemoved', { version: phase.from, name: title }), full: phase.reason };
        if (phase.restored) return { tone: 'error', text: say('failedRestored', { version: phase.from, reason: headline(phase.reason) }), full: phase.reason };
        return { tone: 'error', text: say('failed', { reason: headline(phase.reason) }), full: phase.reason };
      }

      function Row({ offer, phase, onUpdate, busy }) {
        const title = titleOf(offer);
        const status = statusLine(phase, title);
        const navigation = (() => {
          try {
            const face = ctx.get?.('pluginNavigation');
            return typeof face?.openBundle === 'function' ? face : null;
          } catch {
            return null;
          }
        })();
        const date = day(offer.publishedAt);
        const meta = [say('versions', { from: offer.installed, to: offer.version }), date === null ? null : say('released', { date })].filter(Boolean).join(' · ');
        const canUpdate = phase === undefined || phase.step === 'failed' || phase.step === 'unknown';
        return h(
          'div',
          { 'data-kadaliao-updates-row': offer.name, style: { display: 'flex', gap: 10, alignItems: 'flex-start', padding: '8px 0' } },
          offer.icon
            ? h('img', { src: offer.icon, alt: '', width: 28, height: 28, style: { width: 28, height: 28, borderRadius: 7, flexShrink: 0, objectFit: 'cover' } })
            : h('div', { style: { width: 28, height: 28, borderRadius: 7, flexShrink: 0, background: C.hover } }),
          h(
            'div',
            { style: { flex: 1, minWidth: 0 } },
            h(
              navigation ? 'button' : 'div',
              navigation
                ? {
                  type: 'button',
                  title: say('details'),
                  onClick: () => navigation.openBundle(offer.name),
                  style: { font: 'inherit', fontSize: 13, fontWeight: 600, color: C.primary, background: 'none', border: 0, padding: 0, cursor: 'pointer', textAlign: 'left' },
                }
                : { style: { fontSize: 13, fontWeight: 600, color: C.primary } },
              title,
            ),
            h('div', { style: { fontSize: 12, color: C.muted, marginTop: 1 } }, meta),
            status === null
              ? null
              : h(
                'div',
                {
                  'data-kadaliao-updates-status': phase.step,
                  title: status.full ?? undefined,
                  style: { fontSize: 12, marginTop: 3, color: status.tone === 'ok' ? C.ok : status.tone === 'error' ? C.error : C.muted, overflowWrap: 'anywhere' },
                },
                status.text,
              ),
          ),
          canUpdate ? h(Btn, { kind: 'primary', onClick: onUpdate, disabled: busy, label: `${say('update')} ${title}` }, say('update')) : null,
        );
      }

      function Card({ member }) {
        const s = state();
        const offers = shownOffers();
        const phases = s.phases;
        if (offers.length === 0) return null;
        const busy = offers.some((offer) => phases[offer.name] !== undefined && ACTIVE.has(phases[offer.name].step));
        // Rows not updated yet, including failed ones: Later and Skip put them all away.
        const rest = offers.filter((offer) => phases[offer.name]?.step !== 'done');
        const allDone = rest.length === 0;
        const head = allDone
          ? say('titleDone')
          : rest.length === 1
            ? say('titleOne', { name: titleOf(rest[0]), version: rest[0].version })
            : say('titleMany', { n: rest.length });
        const remote = member.remote;
        return h(
          'div',
          {
            role: 'status',
            'aria-live': 'polite',
            'data-kadaliao-updates': '',
            style: {
              position: 'fixed',
              right: 16,
              bottom: 16,
              zIndex: 1000,
              width: 'min(360px, calc(100vw - 32px))',
              boxSizing: 'border-box',
              padding: '12px 14px 10px',
              borderRadius: 12,
              background: C.surface,
              border: `1px solid ${C.border}`,
              boxShadow: '0 8px 28px rgba(0,0,0,.16)',
              color: C.primary,
              fontSize: 13,
            },
          },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h('div', { style: { flex: 1, minWidth: 0, fontWeight: 600, fontSize: 13 } }, head),
            busy
              ? null
              : h(
                'button',
                {
                  type: 'button',
                  'aria-label': say('close'),
                  title: say('close'),
                  'data-kadaliao-updates-action': 'close',
                  onClick: () => (allDone ? close() : later(rest)),
                  style: { font: 'inherit', fontSize: 16, lineHeight: '16px', width: 22, height: 22, borderRadius: 6, border: 0, background: 'transparent', color: C.faint, cursor: 'pointer' },
                },
                '×',
              ),
          ),
          h(
            'div',
            { style: { marginTop: 2 } },
            offers.map((offer) =>
              h(Row, {
                key: offer.name,
                offer,
                phase: phases[offer.name],
                busy,
                onUpdate: () => void update(remote, offer.name),
              }),
            ),
          ),
          rest.length === 0 || busy
            ? null
            : h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 4, marginTop: 4, flexWrap: 'wrap' } },
              rest.length > 1 ? h(Btn, { kind: 'primary', onClick: () => void updateAll(remote) }, say('updateAll')) : null,
              h(Btn, { kind: 'later', onClick: () => later(rest) }, say('later')),
              h(Btn, { kind: 'skip', onClick: () => skip(rest) }, say(rest.length === 1 ? 'skipOne' : 'skipMany')),
            ),
        );
      }

      function Overlay({ member }) {
        const [, setTick] = useState(0);
        useEffect(() => {
          member.render = () => setTick((n) => n + 1);
          return () => {
            member.render = null;
          };
        }, []);
        const s = state();
        const offers = s.offers ?? [];
        const allDone = offers.length > 0 && offers.every((offer) => s.phases[offer.name]?.step === 'done');
        useEffect(() => {
          if (!allDone) return undefined;
          const timer = setTimeout(close, DONE_HIDE_MS);
          return () => clearTimeout(timer);
        }, [allDone]);
        if (leader() !== member) return null;
        return h(Card, { member });
      }

      // --- joining ---------------------------------------------------------------------------------

      if (typeof ctx.inject !== 'function') return null;
      const join = (scope) => {
        const remote = scope.remote;
        if (remote === null || typeof remote !== 'object' || typeof remote.pluginManager?.listBundles !== 'function') return undefined;
        if (typeof scope.slots?.register !== 'function') return undefined;
        const member = {
          impl: UPDATES_IMPL,
          name: self,
          remote,
          render: null,
          stop: null,
          notify() {
            if (typeof member.render === 'function') member.render();
          },
          activate() {
            if (member.stop === null) member.stop = lead(member);
          },
          deactivate() {
            if (member.stop !== null) {
              const stop = member.stop;
              member.stop = null;
              stop();
            }
          },
        };
        const Bound = (props) => h(Overlay, { ...props, member });
        let disposeSlot = null;
        try {
          const register = () => scope.slots.register({ name: 'shell.overlay', id: SLOT_ID }, Bound);
          disposeSlot = typeof scope.slots.inject === 'function' ? scope.slots.inject('shell.overlay', register) : register();
        } catch {
          return undefined;
        }
        hub.members.push(member);
        elect();
        return () => {
          const index = hub.members.indexOf(member);
          if (index >= 0) hub.members.splice(index, 1);
          member.deactivate();
          if (typeof disposeSlot === 'function') disposeSlot();
          elect();
        };
      };
      ctx.inject(['remote', 'remote.pluginManager', 'remoteAccess', 'slots'], (scope) => {
        const access = scope.remoteAccess;
        if (access !== null && typeof access === 'object' && typeof access.whenAccess === 'function') {
          // Only a Peer that may update plugins is told about updates; the owner always may.
          return access.whenAccess('pluginManager/updateBundle', () => join(scope) ?? (() => {}));
        }
        return join(scope);
      });
      return { hub, state, check, update, updateAll, later, skip, close, readStore, choose, leader, outcomeOf, headline };
    }
    // <<< kadaliao-dsh-updates

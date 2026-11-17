window.__ModuleLoader__.load({
  id: '@kadaliao/dsh-archify',
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
    let primitives = null;
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    } catch {
      primitives = null;
    }

    const NS = 'archify';
    const RENDER_TOOL = 'archify_render';
    const CLI_TOOL = 'archify_cli';
    const PANEL_ID = 'archify';
    const LIST_ROUTE = '/__dsh_archify/list';
    const FILE_ROUTE = '/__dsh_archify/file/';
    const DELETE_ROUTE = '/__dsh_archify/delete';
    const OPEN_ROUTE = '/__dsh_archify/open';
    const PAGE = 60;
    const POLL_MS = 5000;
    const SANDBOX = 'allow-scripts allow-downloads allow-popups allow-popups-to-escape-sandbox allow-modals';

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
      ok: 'var(--dsw-alias-state-success-primary, #22a06b)',
    };
    const FONT = 'var(--dsh-content-font-size, 13.5px)';
    const SMALL = 'var(--dsh-content-font-size-secondary, 12.5px)';

    const getJson = (url) => fetch(url, { cache: 'no-store', credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null));
    const postJson = (url, body) =>
      fetch(url, {
        method: 'POST',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      }).then((r) => (r.ok ? r.json() : null));

    /** Light or dark, from the Harness page's own background, so the diagram matches it. */
    function pageTheme() {
      try {
        const bg = getComputedStyle(document.body).backgroundColor;
        const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(bg);
        if (m) {
          const [r, g, b] = [m[1], m[2], m[3]].map(Number);
          return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128 ? 'dark' : 'light';
        }
        return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      } catch {
        return 'light';
      }
    }

    /** The page's address: `embed` shows only the drawing, without the viewer's controls. */
    function pageUrl(item, { embed = false, theme } = {}) {
      const q = new URLSearchParams();
      if (item.version) q.set('v', item.version);
      if (embed) q.set('embed', '1');
      q.set('theme', theme ?? pageTheme());
      return `${FILE_ROUTE}${encodeURIComponent(item.id)}?${q.toString()}`;
    }

    function download(item) {
      try {
        const a = document.createElement('a');
        a.href = `${FILE_ROUTE}${encodeURIComponent(item.id)}?download=1`;
        a.download = (item.path ?? item.output ?? 'archify.html').split(/[\\/]/).pop();
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        a.remove();
      } catch {
        // Nothing to do without a document.
      }
    }

    function copyText(text) {
      try {
        if (typeof primitives?.writeClipboard === 'function') return void primitives.writeClipboard(text);
        if (navigator?.clipboard?.writeText) void navigator.clipboard.writeText(text).catch(() => {});
      } catch {
        // The clipboard is a convenience.
      }
    }

    const openWithSystem = (item, action) => postJson(OPEN_ROUTE, { id: item.id, action }).catch(() => null);
    const openTab = (item) => {
      try {
        window.open(pageUrl(item), '_blank', 'noopener');
      } catch {
        // A blocked popup leaves the full-screen view.
      }
    };

    function fmtWhen(t, at, now = Date.now()) {
      const ms = Math.max(0, now - at);
      if (ms < 60_000) return t('justNow');
      if (ms < 3_600_000) return t('minutesAgo', { n: Math.round(ms / 60_000) });
      if (ms < 86_400_000) return t('hoursAgo', { n: Math.round(ms / 3_600_000) });
      if (ms < 7 * 86_400_000) return t('daysAgo', { n: Math.round(ms / 86_400_000) });
      try {
        return new Date(at).toLocaleDateString();
      } catch {
        return '';
      }
    }
    const fmtMs = (ms) => (ms >= 10_000 ? `${Math.round(ms / 1000)}s` : `${(ms / 1000).toFixed(1)}s`);

    // --- icons -------------------------------------------------------------------------

    const svg = (size, paths, extra = {}) =>
      h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', ...extra },
        ...paths.map((d, i) => h('path', { key: i, d })),
      );
    const ExpandIcon = ({ size = 15 }) => svg(size, ['M4 9V4h5', 'M20 9V4h-5', 'M4 15v5h5', 'M20 15v5h-5']);
    const BrowserIcon = ({ size = 15 }) => svg(size, ['M14 4h6v6', 'M20 4l-8.5 8.5', 'M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4']);
    const DownloadIcon = ({ size = 15 }) => svg(size, ['M12 4v11', 'M7 10l5 5 5-5', 'M4 19h16']);
    const FolderIcon = ({ size = 15 }) => svg(size, ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z']);
    const CopyIcon = ({ size = 15 }) => svg(size, ['M9 9h10v10H9z', 'M5 15V5h10']);
    const CloseIcon = ({ size = 16 }) => svg(size, ['M6 6l12 12', 'M18 6L6 18']);
    const ChatIcon = ({ size = 15 }) => svg(size, ['M20 11.5a7.5 7.5 0 0 1-10.9 6.7L4 19.5l1.3-4.6A7.5 7.5 0 1 1 20 11.5z']);
    const TrashIcon = ({ size = 15 }) => svg(size, ['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 13h10l1-13']);

    /** The panel's glyph: a node branching to two. */
    function ArchifyGlyph(props) {
      const size = Number(props?.size) > 0 ? Number(props.size) : 18;
      const ink = props?.active ? C.label : 'currentColor';
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: ink, strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
        h('rect', { key: 'a', x: 2.5, y: 9.5, width: 7, height: 5, rx: 1.4 }),
        h('rect', { key: 'b', x: 14.5, y: 3.5, width: 7, height: 5, rx: 1.4 }),
        h('rect', { key: 'c', x: 14.5, y: 15.5, width: 7, height: 5, rx: 1.4, fill: props?.active ? C.label : 'none' }),
        h('path', { key: 'p', d: 'M9.5 12h2.5M12 8v8M12 8c0-1 .5-2 2.5-2M12 16c0 1 .5 2 2.5 2' }),
      );
    }

    function ToolButton({ onClick, title, icon, label, ...rest }) {
      return h(
        'button',
        {
          type: 'button',
          title,
          'aria-label': title,
          onClick: (e) => {
            e.stopPropagation();
            onClick?.(e);
          },
          ...rest,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            height: 26,
            padding: label ? '0 9px' : 0,
            width: label ? undefined : 26,
            justifyContent: 'center',
            font: 'inherit',
            fontSize: 12,
            color: C.muted,
            background: 'transparent',
            border: 'none',
            borderRadius: 7,
            cursor: 'pointer',
          },
          onMouseEnter: (e) => {
            e.currentTarget.style.background = C.hover;
            e.currentTarget.style.color = C.primary;
          },
          onMouseLeave: (e) => {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.color = C.muted;
          },
        },
        icon,
        label ?? null,
      );
    }

    /** The actions every page offers: full screen, browser, download, folder, path. */
    function PageActions({ t, item, onExpand, compact = false }) {
      const [copied, setCopied] = useState(false);
      const path = item.path ?? item.output ?? '';
      return h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' } },
        onExpand ? h(ToolButton, { onClick: onExpand, title: t('fullScreen'), icon: h(ExpandIcon), label: compact ? null : t('fullScreenShort'), 'data-dsh-archify-expand': true }) : null,
        h(ToolButton, { onClick: () => openWithSystem(item, 'open'), title: t('openBrowser'), icon: h(BrowserIcon), label: compact ? null : t('openBrowserShort') }),
        h(ToolButton, { onClick: () => download(item), title: t('download'), icon: h(DownloadIcon) }),
        h(ToolButton, { onClick: () => openWithSystem(item, 'reveal'), title: t('reveal'), icon: h(FolderIcon) }),
        path
          ? h(ToolButton, {
              onClick: () => {
                copyText(path);
                setCopied(true);
                setTimeout(() => setCopied(false), 1400);
              },
              title: copied ? t('copied') : t('copyPath'),
              icon: copied ? svg(15, ['M5 12.5l4.5 4.5L19 7']) : h(CopyIcon),
            })
          : null,
      );
    }

    const typeLabel = (t, type) => {
      const key = `type.${type}`;
      const label = t(key);
      return label === key ? type : label;
    };

    function TypeChip({ t, type }) {
      return h(
        'span',
        { style: { flex: 'none', fontSize: 11, lineHeight: '17px', padding: '0 7px', borderRadius: 6, color: C.label, background: 'color-mix(in srgb, currentColor 10%, transparent)', fontWeight: 600 } },
        typeLabel(t, type),
      );
    }

    // --- the page itself ---------------------------------------------------------------

    /** Tallest inline preview; a taller drawing is shown narrower, whole. */
    const PREVIEW_MAX = 720;
    /** The embed's padding on each side of the drawing (Archify's 0.5rem), and slack below it. */
    const EMBED_PAD = 8;
    const EMBED_SLACK = 4;

    /**
     * Size of the inline preview in a box `width` wide. The embed fits the
     * drawing to its width, so a drawing too tall for the box gets a narrower
     * frame instead of losing its bottom.
     */
    function previewBox(item, width) {
      const w = Math.max(280, width || 680);
      if (item.type === 'explainer' || !(item.aspect > 0)) return { width: w, height: Math.round(Math.min(620, Math.max(420, w * 0.72))) };
      // The drawing is the frame's width less the side padding, scaled by its aspect.
      const extra = 2 * EMBED_PAD + EMBED_SLACK;
      const fit = Math.min(w, Math.floor((PREVIEW_MAX - extra) / item.aspect + 2 * EMBED_PAD));
      return { width: fit, height: Math.round(Math.max(220, (fit - 2 * EMBED_PAD) * item.aspect + extra)) };
    }

    /** The preview frame, centered in its box when narrower. */
    function FittedFrame({ item, width, title }) {
      const box = previewBox(item, width);
      return h(
        'div',
        { style: { display: 'flex', justifyContent: 'center' } },
        h('div', { style: { width: box.width, maxWidth: '100%' } }, h(PageFrame, { item, height: box.height, title })),
      );
    }

    function PageFrame({ item, embed = true, height, title }) {
      const theme = pageTheme();
      return h('iframe', {
        key: `${item.id}:${item.version}:${theme}:${embed}`,
        src: pageUrl(item, { embed, theme }),
        title,
        sandbox: SANDBOX,
        referrerPolicy: 'no-referrer',
        loading: 'lazy',
        'data-dsh-archify-frame': item.id,
        style: { display: 'block', width: '100%', height: height ?? '100%', border: 'none', background: 'transparent' },
      });
    }

    /** One delivered page in the conversation: the drawing, with its actions. */
    function PageCard({ t, item }) {
      const box = useRef(null);
      const [width, setWidth] = useState(0);
      const [full, setFull] = useState(false);
      useEffect(() => {
        const el = box.current;
        if (!el) return undefined;
        setWidth(el.clientWidth);
        if (typeof ResizeObserver !== 'function') return undefined;
        const ro = new ResizeObserver(() => setWidth(el.clientWidth));
        ro.observe(el);
        return () => ro.disconnect();
      }, []);
      return h(
        'div',
        { 'data-dsh-archify-card': item.id, style: { border: `1px solid ${C.border1}`, borderRadius: 12, overflow: 'hidden', background: C.layer1, maxWidth: 980 } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 6px 6px 12px', borderBottom: `1px solid ${C.border1}`, minWidth: 0 } },
          h(ArchifyGlyph, { size: 15, active: true }),
          h(TypeChip, { t, type: item.type }),
          h('span', { title: item.title, style: { fontSize: SMALL, fontWeight: 600, color: C.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1 } }, item.title),
          h(PageActions, { t, item, onExpand: () => setFull(true), compact: width > 0 && width < 560 }),
        ),
        h(
          'div',
          { ref: box, style: { position: 'relative', cursor: 'zoom-in' }, onDoubleClick: () => setFull(true) },
          width > 0 ? h(FittedFrame, { item, width, title: item.title }) : h('div', { style: { height: previewBox(item, 680).height } }),
        ),
        full ? h(FullScreen, { t, item, onClose: () => setFull(false) }) : null,
      );
    }

    /** The whole viewer over the window: its toolbar, themes, export and motion. */
    function FullScreen({ t, item, onClose, onOpenSession }) {
      useEffect(() => {
        const onKey = (e) => {
          if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, []);
      const node = h(
        'div',
        {
          'data-dsh-archify-fullscreen': item.id,
          role: 'dialog',
          'aria-label': item.title,
          style: { position: 'fixed', inset: 0, zIndex: 2147483000, display: 'flex', flexDirection: 'column', background: C.base, color: C.primary, fontSize: FONT },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px 8px 16px', borderBottom: `1px solid ${C.border1}`, minWidth: 0 } },
          h(ArchifyGlyph, { size: 16, active: true }),
          h(TypeChip, { t, type: item.type }),
          h('span', { style: { fontWeight: 620, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1 } }, item.title),
          onOpenSession ? h(ToolButton, { onClick: onOpenSession, title: t('openSession'), icon: h(ChatIcon), label: t('openSessionShort') }) : null,
          h(ToolButton, { onClick: () => openTab(item), title: t('newTab'), icon: svg(15, ['M4 6h16v12H4z', 'M4 10h16']) }),
          h(PageActions, { t, item }),
          h('span', { style: { width: 1, height: 18, background: C.border1, margin: '0 4px' } }),
          h(ToolButton, { onClick: onClose, title: t('close'), icon: h(CloseIcon, { size: 17 }), 'data-dsh-archify-close': true }),
        ),
        h('div', { style: { flex: 1, minHeight: 0 } }, h(PageFrame, { item, embed: false, title: item.title })),
      );
      return ReactDOM && typeof ReactDOM.createPortal === 'function' && typeof document !== 'undefined' ? ReactDOM.createPortal(node, document.body) : node;
    }

    // --- the tool calls ----------------------------------------------------------------

    function parseArgs(block) {
      const raw = block?.argsRaw ?? block?.call?.argsRaw;
      if (typeof raw === 'string' && raw !== '') {
        try {
          return JSON.parse(raw);
        } catch {
          // Partial JSON while the call streams: pick what is readable.
          const out = {};
          for (const key of ['type', 'name', 'candidate']) {
            const m = new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`).exec(raw);
            if (m) out[key] = m[1];
          }
          const title = /"title"\s*:\s*"([^"]*)"/.exec(raw);
          if (title) out.title = title[1];
          return out;
        }
      }
      const args = block?.args;
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
      return (Array.isArray(block?.content) ? block.content : [])
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n')
        .trim();
    }

    /** A delivered page as the card wants it, from a result's meta; null when none. */
    function pageOf(meta) {
      if (!meta || meta.ok !== true || typeof meta.id !== 'string' || meta.id === '') return null;
      return { id: meta.id, version: meta.version, type: meta.type, title: meta.title || meta.type, path: meta.output, aspect: Number(meta.aspect) || 0 };
    }

    function Gates({ t, meta }) {
      const gates = meta?.gates && typeof meta.gates === 'object' ? meta.gates : {};
      const names = Object.keys(gates);
      if (names.length === 0) return null;
      return h(
        'span',
        { style: { display: 'inline-flex', gap: 8, flexWrap: 'wrap' } },
        names.map((name) => {
          const s = gates[name];
          const skipped = name === 'browser-check' && meta.browserSkipped;
          const mark = s === 'pass' ? '✓' : s === 'fail' ? '✕' : skipped || s === 'skipped' ? '–' : '·';
          const color = s === 'pass' ? C.ok : s === 'fail' ? C.error : C.faint;
          return h('span', { key: name, title: skipped ? t('browserSkipped') : `${name}: ${s}`, style: { color } }, `${mark} ${t(`gate.${name}`)}`);
        }),
      );
    }

    function RenderToolView(props) {
      const t = typeof props.t === 'function' ? props.t : fallbackT;
      const { phase, block } = props;
      const args = parseArgs(block);
      const settled = phase === 'result';
      const meta = settled && block?.meta && typeof block.meta === 'object' ? block.meta : null;
      const [open, setOpen] = useState(false);
      const type = (meta?.type || args.type || '').toString();
      const title = meta?.title || args?.spec?.meta?.title || args.name || (args.candidate ? String(args.candidate).split(/[\\/]/).slice(-2, -1)[0] : '');
      const repair = !args.spec && !args.markdown && args.candidate;

      let state;
      if (!settled) state = h('span', { style: { color: C.faint, fontStyle: 'italic' } }, t(phase === 'preparing' ? 'writing' : 'rendering'));
      else if (block?.isError) state = h('span', { style: { color: C.error } }, t('failed'));
      else if (meta?.ok) state = h('span', { style: { color: C.faint } }, [t('delivered'), meta.ms ? fmtMs(meta.ms) : null].filter(Boolean).join(' · '));
      else if (meta) state = h('span', { style: { color: C.error } }, t('stoppedAt', { stage: t(`gate.${meta.failedStage}`) === `gate.${meta.failedStage}` ? meta.failedStage || meta.status : t(`gate.${meta.failedStage}`) }));

      const head = h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: SMALL, color: C.muted, minWidth: 0 } },
        h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, color: settled && meta?.ok ? C.label : C.faint, fontWeight: 600, flex: 'none' } }, h(ArchifyGlyph, { size: 14, active: settled && meta?.ok }), t('toolTitle')),
        type ? h(TypeChip, { t, type }) : null,
        title ? h('span', { style: { color: C.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 } }, title) : null,
        repair && !settled ? h('span', { style: { color: C.faint, flex: 'none' } }, t('rerun')) : null,
        h('span', { style: { flex: 1 } }),
        state ?? null,
      );

      let body = null;
      if (settled && block?.isError) {
        body = h('div', { style: { fontSize: SMALL, color: C.error, whiteSpace: 'pre-wrap', wordBreak: 'break-word', userSelect: 'text' } }, resultText(block) || t('failed'));
      } else if (meta && !meta.ok) {
        const diags = Array.isArray(meta.diagnostics) ? meta.diagnostics : [];
        body = h(
          'div',
          { style: { fontSize: 12, color: C.muted, display: 'flex', flexDirection: 'column', gap: 4 } },
          h(Gates, { t, meta }),
          diags.length > 0
            ? h(
                'div',
                null,
                h(
                  'button',
                  { type: 'button', onClick: () => setOpen((v) => !v), style: { font: 'inherit', fontSize: 12, color: C.muted, background: 'none', border: 'none', padding: 0, cursor: 'pointer' } },
                  `${open ? '▾' : '▸'} ${t('diagnostics', { n: meta.diagnosticTotal || diags.length })}`,
                ),
                open
                  ? h(
                      'ul',
                      { style: { margin: '4px 0 0', paddingLeft: 18, lineHeight: 1.5, userSelect: 'text' } },
                      diags.map((d, i) => h('li', { key: i }, h('code', { style: { fontSize: 11.5, color: d.severity === 'error' ? C.error : C.faint } }, d.code), ' ', d.message)),
                    )
                  : null,
              )
            : null,
          h('div', { style: { color: C.faint } }, t('modelRepairs')),
        );
      } else if (meta?.ok) {
        body = h('div', { style: { fontSize: 12, color: C.muted } }, h(Gates, { t, meta }));
      }
      return h('div', { 'data-dsh-archify-call': block?.callId ?? '', style: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 } }, head, body);
    }

    function CliToolView(props) {
      const t = typeof props.t === 'function' ? props.t : fallbackT;
      const { phase, block } = props;
      const args = parseArgs(block);
      const list = Array.isArray(args.args) ? args.args.map(String) : [];
      const settled = phase === 'result';
      const [open, setOpen] = useState(false);
      const text = settled ? resultText(block) : '';
      const exit = /^exit (-?\d+)/.exec(text);
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0, fontSize: SMALL } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, color: C.muted, minWidth: 0 } },
          h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, color: C.faint, fontWeight: 600, flex: 'none' } }, h(ArchifyGlyph, { size: 14 }), t('toolTitle')),
          h('code', { style: { fontSize: 12, color: C.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 } }, `archify ${list.join(' ')}`),
          h('span', { style: { flex: 1 } }),
          !settled
            ? h('span', { style: { color: C.faint, fontStyle: 'italic' } }, t('running'))
            : h(
                'button',
                { type: 'button', onClick: () => setOpen((v) => !v), style: { font: 'inherit', fontSize: 12, color: exit && exit[1] !== '0' ? C.error : C.faint, background: 'none', border: 'none', padding: 0, cursor: 'pointer' } },
                `${exit ? `exit ${exit[1]}` : ''} ${open ? '▾' : '▸'}`,
              ),
        ),
        settled && open
          ? h('pre', { style: { margin: 0, maxHeight: 320, overflow: 'auto', fontSize: 11.5, lineHeight: 1.5, padding: '8px 10px', borderRadius: 8, background: C.layer2, color: C.muted, whiteSpace: 'pre-wrap', wordBreak: 'break-word', userSelect: 'text' } }, text)
          : null,
      );
    }

    // --- the page as a row of the conversation -----------------------------------------
    //
    // The tool card lives in the turn's process fold, which closes when the turn
    // completes. The page is the answer, so a second node shows it at the `turn`
    // level, beside the model's text, where the fold cannot hide it.

    const RESULT_KIND = 'archify-page';
    const ownCalls = new Set();

    function isOwnResult(event) {
      if (event?.type !== 'tool/result' || event.surfaceOp !== 'append') return false;
      const data = event.data ?? {};
      const callId = String(data.message?.source?.callId ?? data.message?.toolCallId ?? '');
      if (callId !== '' && ownCalls.has(callId)) return true;
      // A replayed feed may start after the call: the meta marks the tool's own results.
      return data.meta?.archify === true;
    }

    const pageResultDefinition = {
      kind: RESULT_KIND,
      target: 'chat',
      match: (event) => {
        if (event?.type === 'tool/call') {
          if (event.data?.name === RENDER_TOOL) ownCalls.add(String(event.data.callId));
          return null;
        }
        if (!isOwnResult(event)) return null;
        const data = event.data;
        return { id: String(data.message?.source?.callId ?? data.message?.toolCallId ?? event.seq), role: 'start' };
      },
      start: (_context, match) => {
        const data = match.event.data ?? {};
        return {
          callId: String(data.message?.source?.callId ?? data.message?.toolCallId ?? ''),
          seq: match.event.seq,
          time: match.event.time,
          isError: data.message?.isError === true,
          meta: data.meta && typeof data.meta === 'object' ? data.meta : {},
        };
      },
      update: (context) => context.state,
      buildViewNode: (context) => {
        const state = context.state;
        if (state === undefined || state.isError || pageOf(state.meta) === null) return null;
        return {
          key: context.key,
          kind: RESULT_KIND,
          id: context.id,
          target: 'chat',
          anchorSeq: state.seq + 0.2,
          location: context.start.location,
          visibility: 'visible',
          groupTree: 'turn',
          data: state,
        };
      },
    };

    function PageRow(props) {
      const t = typeof props.t === 'function' ? props.t : fallbackT;
      const state = props.node?.data ?? {};
      const item = pageOf(state.meta);
      if (!item) return null;
      return h('div', { 'data-dsh-archify-row': state.callId, style: { padding: '6px 0 10px' } }, h(PageCard, { t, item }));
    }

    // --- the panel ---------------------------------------------------------------------

    function ArchifyPanel(props) {
      const t = typeof props.t === 'function' ? props.t : fallbackT;
      const [items, setItems] = useState(null);
      const [total, setTotal] = useState(0);
      const [hasMore, setHasMore] = useState(false);
      const [failed, setFailed] = useState(false);
      const [selected, setSelected] = useState('');
      const [full, setFull] = useState(false);
      const [query, setQuery] = useState('');
      const alive = useRef(true);
      const itemsRef = useRef(items);
      itemsRef.current = items;
      const pane = useRef(null);
      const [paneW, setPaneW] = useState(0);

      const refresh = () =>
        getJson(`${LIST_ROUTE}?limit=${PAGE}`)
          .then((body) => {
            if (!alive.current) return;
            if (body === null || !Array.isArray(body.items)) {
              if (itemsRef.current === null) setFailed(true);
              return;
            }
            setFailed(false);
            setTotal(body.total ?? body.items.length);
            const known = itemsRef.current;
            if (known === null) {
              setItems(body.items);
              setHasMore(body.hasMore === true);
              return;
            }
            const fresh = new Map(body.items.map((i) => [i.id, i]));
            const rest = known.slice(PAGE).filter((i) => !fresh.has(i.id));
            const next = [...body.items, ...rest];
            const same = next.length === known.length && next.every((i, at) => i.id === known[at].id && i.version === known[at].version && i.missing === known[at].missing);
            if (!same) setItems(next);
          })
          .catch(() => alive.current && itemsRef.current === null && setFailed(true));

      const loadMore = () => {
        const known = itemsRef.current;
        if (!hasMore || !known || known.length === 0) return;
        getJson(`${LIST_ROUTE}?limit=${PAGE}&before=${encodeURIComponent(known[known.length - 1].id)}`)
          .then((body) => {
            if (!alive.current || body === null || !Array.isArray(body.items)) return;
            const have = new Set((itemsRef.current ?? []).map((i) => i.id));
            setItems([...(itemsRef.current ?? []), ...body.items.filter((i) => !have.has(i.id))]);
            setHasMore(body.hasMore === true);
          })
          .catch(() => {});
      };

      useEffect(() => {
        alive.current = true;
        refresh();
        const timer = setInterval(() => {
          if (typeof document === 'undefined' || !document.hidden) refresh();
        }, POLL_MS);
        return () => {
          alive.current = false;
          clearInterval(timer);
        };
      }, []);

      useEffect(() => {
        const el = pane.current;
        if (!el) return undefined;
        setPaneW(el.clientWidth);
        if (typeof ResizeObserver !== 'function') return undefined;
        const ro = new ResizeObserver(() => setPaneW(el.clientWidth));
        ro.observe(el);
        return () => ro.disconnect();
      }, [items === null]);

      const q = query.trim().toLowerCase();
      const shown = (items ?? []).filter((i) => !q || `${i.title} ${i.type} ${typeLabel(t, i.type)} ${i.path}`.toLowerCase().includes(q));
      const current = shown.find((i) => i.id === selected) ?? shown[0];

      const sessions = props.sessions;
      const openSession =
        current && current.sessionId && sessions?.available?.() && sessions.state(current.sessionId).state !== 'gone'
          ? () => {
              setFull(false);
              sessions.open(current.sessionId);
            }
          : undefined;

      const remove = (item) => {
        setItems((list) => (list ?? []).filter((i) => i.id !== item.id));
        setTotal((n) => Math.max(0, n - 1));
        void postJson(DELETE_ROUTE, { id: item.id }).catch(() => {});
      };

      const header = h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 10, padding: '14px 20px 12px', borderBottom: `1px solid ${C.border1}`, flex: 'none' } },
        h(ArchifyGlyph, { size: 18, active: true }),
        h('span', { style: { fontSize: 15.5, fontWeight: 640, color: C.primary } }, t('title')),
        total > 0 ? h('span', { style: { fontSize: SMALL, color: C.faint } }, t('count', { n: total })) : null,
        h('span', { style: { flex: 1 } }),
        items && items.length > 0
          ? h('input', {
              type: 'search',
              value: query,
              placeholder: t('search'),
              onChange: (e) => setQuery(e.target.value),
              style: { font: 'inherit', fontSize: SMALL, color: C.primary, background: C.layer2, border: `1px solid ${C.border1}`, borderRadius: 8, padding: '5px 10px', width: 200, outline: 'none' },
            })
          : null,
      );

      let body;
      if (failed) body = h('div', { style: { padding: 24, color: C.faint } }, t('unavailable'));
      else if (items === null) body = h('div', { style: { padding: 24, color: C.faint } }, '…');
      else if (items.length === 0) body = h('div', { style: { padding: '48px 24px', color: C.muted, maxWidth: 560, lineHeight: 1.7, whiteSpace: 'pre-line' } }, t('empty'));
      else {
        const list = h(
          'div',
          {
            'data-dsh-archify-list': true,
            onScroll: (e) => {
              const el = e.currentTarget;
              if (el.scrollHeight - el.scrollTop - el.clientHeight < 300) loadMore();
            },
            style: { width: 300, flex: 'none', overflowY: 'auto', borderRight: `1px solid ${C.border1}`, padding: '8px 8px 40px' },
          },
          shown.map((item) => {
            const on = current && item.id === current.id;
            return h(
              'div',
              {
                key: item.id,
                role: 'button',
                tabIndex: 0,
                'data-dsh-archify-item': item.id,
                onClick: () => setSelected(item.id),
                onDoubleClick: () => {
                  setSelected(item.id);
                  setFull(true);
                },
                onKeyDown: (e) => {
                  if (e.key === 'Enter') setSelected(item.id);
                },
                style: { padding: '9px 10px', borderRadius: 9, cursor: 'pointer', background: on ? C.hover : 'transparent', display: 'flex', flexDirection: 'column', gap: 4, opacity: item.missing ? 0.55 : 1 },
              },
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 } },
                h(TypeChip, { t, type: item.type }),
                h('span', { style: { fontSize: SMALL, fontWeight: 600, color: C.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 } }, item.title),
              ),
              h(
                'div',
                { style: { fontSize: 11.5, color: C.faint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: item.path },
                [fmtWhen(t, item.updatedAt ?? item.createdAt), item.missing ? t('missing') : item.folder?.split(/[\\/]/).slice(-3, -2)[0]].filter(Boolean).join(' · '),
              ),
            );
          }),
        );
        const preview = current
          ? h(
              'div',
              { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' } },
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px 8px 16px', borderBottom: `1px solid ${C.border1}`, minWidth: 0 } },
                h('span', { title: current.path, style: { fontSize: SMALL, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1 } }, current.title),
                openSession ? h(ToolButton, { onClick: openSession, title: t('openSession'), icon: h(ChatIcon) }) : null,
                current.missing ? null : h(PageActions, { t, item: current, onExpand: () => setFull(true), compact: paneW < 620 }),
                h(ToolButton, { onClick: () => remove(current), title: t('remove'), icon: h(TrashIcon) }),
              ),
              h(
                'div',
                { ref: pane, style: { flex: 1, minHeight: 0, overflow: 'auto', padding: 16 } },
                current.missing
                  ? h('div', { style: { color: C.faint, padding: 12 } }, t('missingLong', { path: current.path }))
                  : h('div', { style: { border: `1px solid ${C.border1}`, borderRadius: 12, overflow: 'hidden', background: C.layer1 } }, h(FittedFrame, { item: current, width: paneW - 34, title: current.title })),
                h('div', { style: { marginTop: 8, fontSize: 11.5, color: C.faint, wordBreak: 'break-all', userSelect: 'text' } }, current.path),
              ),
            )
          : h('div', { style: { flex: 1, padding: 24, color: C.faint } }, t('noMatch'));
        body = h('div', { style: { flex: 1, minHeight: 0, display: 'flex' } }, list, preview);
      }

      return h(
        'div',
        { 'data-dsh-archify-panel': true, style: { position: 'relative', height: '100%', width: '100%', display: 'flex', flexDirection: 'column', background: C.base, color: C.primary, fontSize: FONT, boxSizing: 'border-box' } },
        header,
        body,
        full && current ? h(FullScreen, { t, item: current, onClose: () => setFull(false), onOpenSession: openSession }) : null,
      );
    }

    // --- words -------------------------------------------------------------------------

    const DICTIONARY = {
      en: {
        title: 'Archify',
        count: '{n} pages',
        search: 'Search',
        toolTitle: 'Archify',
        writing: 'writing the diagram…',
        rendering: 'rendering and checking…',
        rerun: 'after a repair',
        running: 'running…',
        delivered: 'delivered',
        failed: 'The render failed.',
        stoppedAt: 'stopped at {stage}',
        diagnostics: '{n} diagnostics',
        modelRepairs: 'The model repairs the candidate and renders it again.',
        browserSkipped: 'No Chrome, Chromium or Edge installed: the real-browser check was skipped.',
        'gate.validate': 'validate',
        'gate.deliver': 'deliver',
        'gate.check': 'check',
        'gate.browser-check': 'browser',
        'gate.prepare': 'prepare',
        fullScreen: 'Full screen (double-click the drawing)',
        fullScreenShort: 'Full screen',
        openBrowser: 'Open in your default browser',
        openBrowserShort: 'Browser',
        newTab: 'Open in a new tab',
        download: 'Download the HTML',
        reveal: 'Show in folder',
        copyPath: 'Copy the path',
        copied: 'Copied',
        close: 'Close (Esc)',
        openSession: 'Open the conversation it was drawn in',
        openSessionShort: 'Conversation',
        remove: 'Remove from this list (the file stays)',
        missing: 'file gone',
        missingLong: 'This page is no longer at {path}.',
        noMatch: 'Nothing matches.',
        empty:
          'No diagrams yet.\n\nAsk in any conversation — "draw the architecture of this repo", "画一下下单的时序图", "make this answer a one-page explainer" — and the page appears in the conversation and here, newest first.',
        unavailable: 'Cannot reach the Archify list. Refresh the page, or check the plugin is enabled.',
        justNow: 'just now',
        minutesAgo: '{n} min ago',
        hoursAgo: '{n} h ago',
        daysAgo: '{n} d ago',
        'type.architecture': 'Architecture',
        'type.workflow': 'Workflow',
        'type.sequence': 'Sequence',
        'type.dataflow': 'Data flow',
        'type.lifecycle': 'Lifecycle',
        'type.erd': 'ERD',
        'type.tree': 'Tree',
        'type.class': 'Class',
        'type.timeline': 'Timeline',
        'type.waterfall': 'Waterfall',
        'type.explainer': 'Explainer',
      },
      zh: {
        title: 'Archify',
        count: '{n} 个页面',
        search: '搜索',
        toolTitle: 'Archify',
        writing: '正在写图…',
        rendering: '正在渲染和检查…',
        rerun: '修复后重画',
        running: '运行中…',
        delivered: '已生成',
        failed: '渲染失败。',
        stoppedAt: '停在「{stage}」',
        diagnostics: '{n} 条诊断',
        modelRepairs: '模型会按诊断修改后重新渲染。',
        browserSkipped: '没装 Chrome、Chromium 或 Edge，跳过了真实浏览器检查。',
        'gate.validate': '校验',
        'gate.deliver': '生成',
        'gate.check': '检查',
        'gate.browser-check': '浏览器',
        'gate.prepare': '准备',
        fullScreen: '全屏查看（双击图也可以）',
        fullScreenShort: '全屏',
        openBrowser: '用默认浏览器打开',
        openBrowserShort: '浏览器',
        newTab: '在新标签页打开',
        download: '下载 HTML',
        reveal: '在文件夹中显示',
        copyPath: '复制路径',
        copied: '已复制',
        close: '关闭（Esc）',
        openSession: '打开画这张图的会话',
        openSessionShort: '所属会话',
        remove: '从列表移除（文件保留）',
        missing: '文件已不在',
        missingLong: '这个页面已经不在 {path} 了。',
        noMatch: '没有匹配的。',
        empty: '还没有图。\n\n在任何会话里说一句——「画一下这个仓库的架构图」「画一下下单的时序图」「把这个回答做成一页」——画好的页面会出现在对话里，也会收在这里，最新的在前。',
        unavailable: '连不上 Archify 列表。刷新页面，或确认插件已启用。',
        justNow: '刚刚',
        minutesAgo: '{n} 分钟前',
        hoursAgo: '{n} 小时前',
        daysAgo: '{n} 天前',
        'type.architecture': '架构图',
        'type.workflow': '流程图',
        'type.sequence': '时序图',
        'type.dataflow': '数据流图',
        'type.lifecycle': '状态图',
        'type.erd': 'ER 图',
        'type.tree': '树图',
        'type.class': '类图',
        'type.timeline': '时间线',
        'type.waterfall': '瀑布图',
        'type.explainer': '讲解页',
      },
    };

    function fallbackT(key, params) {
      const template = DICTIONARY.en[key] ?? key;
      if (!params) return template;
      return template.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? ''));
    }

    function sessionState(id, sessions, workspaces) {
      if (!id || !sessions || !workspaces || workspaces.state === 'error') return { state: 'unknown' };
      if (sessions.phase === 'pending' || workspaces.phase === 'pending') return { state: 'unknown' };
      const archived = new Set(Array.isArray(workspaces.archivedSessionIds) ? workspaces.archivedSessionIds : []);
      const byId = sessions.byId && typeof sessions.byId === 'object' ? sessions.byId : {};
      for (let at = id, hops = 0; at && hops < 16; hops += 1) {
        if (archived.has(at)) return { state: 'archived', archived: at };
        const row = byId[at];
        at = row?.origin === 'subagent' ? row.parentId : undefined;
      }
      const listed = (Array.isArray(sessions.ids) && sessions.ids.includes(id)) || byId[id] !== undefined;
      return { state: listed ? 'available' : 'gone' };
    }

    function openPanel(ctx) {
      try {
        const layout = ctx.get?.('layout');
        if (!layout || typeof layout.selectPanel !== 'function') return false;
        layout.selectPanel(PANEL_ID);
        return true;
      } catch {
        return false;
      }
    }

    return {
      inject: ['slots', 'locale', 'uiConversation'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, DICTIONARY), 'archify: dictionaries');
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
        const withT = (Component, extra) => (props) => h(Component, { ...props, ...extra, t: typeof props.t === 'function' ? props.t : tr });

        const service = (name) => {
          try {
            return ctx.get?.(name);
          } catch {
            return undefined;
          }
        };
        const snapshot = (name) => {
          try {
            return service(name)?.list?.getSnapshot?.();
          } catch {
            return undefined;
          }
        };
        const sessions = {
          available: () => typeof service('uiWorkspace')?.openSession === 'function',
          state: (id) => sessionState(id, snapshot('sessions'), snapshot('workspaces')),
          open: (id) => {
            try {
              service('uiWorkspace').openSession(id);
              return true;
            } catch {
              return false;
            }
          },
        };

        ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: RENDER_TOOL, locale: NS }, withT(RenderToolView)));
        ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: CLI_TOOL, locale: NS }, withT(CliToolView)));
        ctx.uiConversation.events.register(pageResultDefinition);
        ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({ name: 'conversation.chat.node', key: RESULT_KIND, locale: NS }, withT(PageRow)));
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 31, label: () => tr('title') }, ArchifyGlyph));
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, withT(ArchifyPanel, { sessions })));
        if (typeof ctx.inject === 'function') {
          ctx.inject(['commandUi'], (scope) => {
            scope.effect(
              () =>
                scope.commandUi.decorate({
                  name: 'archify',
                  available: () => typeof ctx.get?.('layout')?.selectPanel === 'function',
                  ui: { kind: 'action', run: () => void openPanel(ctx) },
                }),
              'archify: /archify opens the panel',
            );
          });
        }
      },
    };
  },
});

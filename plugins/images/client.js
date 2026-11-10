window.__ModuleLoader__.load({
  id: '@kadaliao/dsh-images',
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
    // The product's own controls when this harness serves them; plain ones otherwise.
    let primitives = null;
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    } catch {
      primitives = null;
    }

    const NS = 'images';
    const TOOL_NAME = 'generate_image';
    const PANEL_ID = 'images';
    const LIST_ROUTE = '/__dsh_images/list';
    const FILE_ROUTE = '/__dsh_images/file/';
    const DELETE_ROUTE = '/__dsh_images/delete';
    const STATE_ROUTE = '/__dsh_images/state';
    const SETTINGS_ROUTE = '/__dsh_images/settings';
    const MODELS_ROUTE = '/__dsh_images/models';
    const CATALOG_ROUTE = '/__dsh_images/catalog';
    const SIZES = ['1024x1024', '1536x1024', '1024x1536'];
    const QUALITIES = ['low', 'medium', 'high'];
    const PAGE = 40;
    const POLL_MS = 4000;

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
    };
    const FONT = 'var(--dsh-content-font-size, 13.5px)';
    const SMALL = 'var(--dsh-content-font-size-secondary, 12.5px)';

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

    const fileUrl = (id) => `${FILE_ROUTE}${encodeURIComponent(id)}`;
    const ext = (mediaType) => ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[mediaType] ?? 'png');

    /** Save one image through the browser's download flow. */
    function download(item) {
      try {
        const a = document.createElement('a');
        a.href = item.url ? `${item.url}${item.url.includes('?') ? '&' : '?'}download=1` : item.src;
        a.download = `${item.id ?? 'image'}.${ext(item.mediaType)}`;
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

    /** `$0.13` / `¥0.20`, rounded to what matters. */
    function fmtMoney(amount, currency) {
      const n = Number(amount);
      if (!Number.isFinite(n)) return '';
      const sign = currency === 'USD' ? '$' : currency === 'CNY' ? '¥' : currency === 'EUR' ? '€' : `${currency ?? ''} `;
      const digits = n >= 1 ? 2 : n >= 0.01 ? 3 : 4;
      return `${sign}${n.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '')}`;
    }
    const fmtCost = (cost) => (cost && Number.isFinite(cost.amount) ? `≈ ${fmtMoney(cost.amount, cost.currency)}` : '');
    /** `≈ $1.23 · ¥4.5` over a `{USD: n, CNY: n}` map, '' when empty. */
    const fmtTotals = (totals) =>
      Object.entries(totals ?? {})
        .filter(([, v]) => Number.isFinite(v) && v > 0)
        .map(([c, v]) => fmtMoney(v, c))
        .join(' · ');
    /** The line under a picture: model · size · cost. */
    const metaLine = (t, item) =>
      [item.model, item.width && item.height ? `${item.width}×${item.height}` : null, item.animation?.frames ? `GIF · ${t('frames', { n: item.animation.frames })}` : null, fmtCost(item.cost), item.createdAt ? fmtWhen(t, item.createdAt) : null].filter(Boolean).join(' · ');

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

    // --- icons -----------------------------------------------------------------

    const svg = (size, paths, extra = {}) =>
      h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          ...extra,
        },
        ...paths.map((d, i) => h('path', { key: i, d })),
      );
    const DotsIcon = ({ size = 16 }) => svg(size, ['M5 12h.01M12 12h.01M19 12h.01'], { strokeWidth: 3 });
    const DownloadIcon = ({ size = 16 }) => svg(size, ['M12 4v11', 'M7 10l5 5 5-5', 'M4 19h16']);
    const CloseIcon = ({ size = 16 }) => svg(size, ['M6 6l12 12', 'M18 6L6 18']);
    const GearIcon = ({ size = 15 }) =>
      svg(size, ['M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z', 'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z']);
    const ZoomInIcon = ({ size = 16 }) => svg(size, ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'M20 20l-4-4', 'M11 8v6', 'M8 11h6']);
    const ZoomOutIcon = ({ size = 16 }) => svg(size, ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'M20 20l-4-4', 'M8 11h6']);
    const ChevronIcon = ({ size = 20, dir = 1 }) => svg(size, [dir > 0 ? 'M9 5l7 7-7 7' : 'M15 5l-7 7 7 7']);
    const ChatIcon = ({ size = 16 }) => svg(size, ['M20 11.5a7.5 7.5 0 0 1-10.9 6.7L4 19.5l1.3-4.6A7.5 7.5 0 1 1 20 11.5z']);
    function ImagesGlyph(props) {
      const size = Number(props?.size) > 0 ? Number(props.size) : 18;
      const ink = props?.active ? C.label : 'currentColor';
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: ink, strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
        h('rect', { key: 'f', x: 3, y: 5, width: 18, height: 14, rx: 2.5 }),
        h('path', { key: 'm', d: 'M4.5 17.5l5-5.5 3.5 4 2.5-2.5 4 4' }),
        h('circle', { key: 's', cx: 16, cy: 9.5, r: 1.6, fill: props?.active ? C.label : 'none' }),
      );
    }

    // --- the hover menu on a tile ---------------------------------------------------

    function IconButton({ onClick, title, children, dark = false }) {
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
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 28,
            height: 28,
            padding: 0,
            border: 'none',
            borderRadius: 8,
            cursor: 'pointer',
            color: '#fff',
            background: dark ? 'rgba(0,0,0,.55)' : 'rgba(0,0,0,.45)',
            backdropFilter: 'blur(6px)',
          },
        },
        children,
      );
    }

    /**
     * The small menu a tile's corner button opens: download, copy the prompt, and
     * (in the gallery) delete. Closes on a click outside or Escape.
     */
    function TileMenu({ t, actions, onClose }) {
      const ref = useRef(null);
      useEffect(() => {
        if (typeof document === 'undefined') return undefined;
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
          'data-dsh-images-menu': true,
          onClick: (e) => e.stopPropagation(),
          style: {
            position: 'absolute',
            top: 40,
            right: 8,
            zIndex: 5,
            minWidth: 150,
            padding: 4,
            borderRadius: 10,
            background: C.layer3,
            border: `1px solid ${C.border}`,
            boxShadow: '0 8px 28px rgba(0,0,0,.28)',
            fontSize: SMALL,
          },
        },
        actions.map((a) =>
          h(
            'button',
            {
              key: a.id,
              type: 'button',
              role: 'menuitem',
              onClick: () => {
                onClose();
                a.run();
              },
              style: {
                display: 'block',
                width: '100%',
                textAlign: 'left',
                font: 'inherit',
                fontSize: SMALL,
                padding: '6px 10px',
                border: 'none',
                borderRadius: 7,
                background: 'transparent',
                color: a.danger ? C.error : C.primary,
                cursor: 'pointer',
                lineHeight: 1.7,
                whiteSpace: 'nowrap',
              },
              onMouseEnter: (e) => {
                e.currentTarget.style.background = C.hover;
              },
              onMouseLeave: (e) => {
                e.currentTarget.style.background = 'transparent';
              },
            },
            t(a.id),
          ),
        ),
      );
    }

    /**
     * One image with its hover controls: a download button and a menu in the top-right
     * corner, the whole tile opening the lightbox. `item` carries `src`, `id`,
     * `mediaType`, `width`, `height`, `prompt`.
     */
    function Tile({ t, item, onOpen, onDelete, caption = null, radius = 12, maxHeight }) {
      const [hover, setHover] = useState(false);
      const [menu, setMenu] = useState(false);
      const ratio = item.width > 0 && item.height > 0 ? `${item.width} / ${item.height}` : undefined;
      const actions = [
        { id: 'download', run: () => download(item) },
        ...(item.prompt ? [{ id: 'copyPrompt', run: () => copyText(item.prompt) }] : []),
        ...(onDelete ? [{ id: 'delete', run: () => onDelete(item), danger: true }] : []),
      ];
      const showControls = hover || menu;
      // With a height cap, the tile is as wide as the picture at that height, so a
      // portrait image gets a narrow tile and a landscape one a wide tile.
      const fitWidth = maxHeight && item.width > 0 && item.height > 0 ? Math.round((maxHeight * item.width) / item.height) : undefined;
      return h(
        'figure',
        {
          'data-dsh-images-tile': item.id,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: {
            position: 'relative',
            margin: 0,
            breakInside: 'avoid',
            borderRadius: radius,
            overflow: 'hidden',
            background: C.layer2,
            border: `1px solid ${C.border1}`,
            ...(fitWidth !== undefined ? { width: `min(${fitWidth}px, 100%)` } : {}),
          },
        },
        h(
          'div',
          {
            role: 'button',
            tabIndex: 0,
            title: t('enlarge'),
            onClick: () => onOpen?.(item),
            onKeyDown: (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onOpen?.(item);
              }
            },
            style: { position: 'relative', display: 'block', cursor: 'zoom-in', aspectRatio: ratio, ...(fitWidth === undefined ? { maxHeight } : {}), lineHeight: 0 },
          },
          h('img', {
            src: item.src,
            alt: item.prompt ?? '',
            loading: 'lazy',
            decoding: 'async',
            draggable: false,
            style: { display: 'block', width: '100%', height: ratio ? '100%' : 'auto', ...(fitWidth === undefined ? { maxHeight } : {}), objectFit: 'cover' },
          }),
          h(
            'div',
            {
              style: {
                position: 'absolute',
                top: 8,
                right: 8,
                display: 'flex',
                gap: 6,
                opacity: showControls ? 1 : 0,
                transition: 'opacity .15s',
                pointerEvents: showControls ? 'auto' : 'none',
              },
            },
            h(IconButton, { key: 'dl', title: t('download'), onClick: () => download(item) }, h(DownloadIcon)),
            h(IconButton, { key: 'more', title: t('more'), onClick: () => setMenu((v) => !v) }, h(DotsIcon)),
          ),
          menu ? h(TileMenu, { t, actions, onClose: () => setMenu(false) }) : null,
        ),
        caption,
      );
    }

    // --- the lightbox ----------------------------------------------------------------

    /** Zoom range of the viewer, as a multiple of the fitted size. */
    const ZOOM_MIN = 0.5;
    const ZOOM_MAX = 10;
    const ZOOM_STEP = 1.25;
    const FIT = { s: 1, x: 0, y: 0 };
    const clampZoom = (s) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, s));

    /**
     * The view after zooming to `next` around a point `dx, dy` away from the
     * image's current centre on screen: that point stays under the cursor. At or
     * below the fitted size the image re-centres.
     */
    function zoomView(view, next, dx = 0, dy = 0) {
      const s = clampZoom(next);
      if (s <= 1) return { s, x: 0, y: 0 };
      const k = 1 - s / view.s;
      return { s, x: view.x + dx * k, y: view.y + dy * k };
    }

    /**
     * The viewer. `onOpenSession(item)`, given only by the gallery, adds a button
     * that opens the conversation the picture was drawn in. When that conversation
     * cannot be opened it returns a notice `{key, action?}` to show; an action
     * `{key, run}` is a button on the notice whose `run()` resolves to the next
     * notice, or null once it has done its work.
     */
    function Lightbox({ t, items, index, onClose, onStep, onOpenSession, sessionTitle }) {
      const item = items[index];
      const [view, setView] = useState(FIT);
      // A notice belongs to the picture it was about; stepping on leaves it behind.
      const [notice, setNotice] = useState(null);
      const drag = useRef(null);
      // A new picture opens fitted.
      useEffect(() => {
        setView(FIT);
      }, [index]);

      /** Zoom around a client point, or the image's centre without one. */
      const zoomAt = (factor, img, clientX, clientY) => {
        let dx = 0;
        let dy = 0;
        if (img && typeof img.getBoundingClientRect === 'function' && clientX !== undefined) {
          const r = img.getBoundingClientRect();
          dx = clientX - (r.left + r.width / 2);
          dy = clientY - (r.top + r.height / 2);
        }
        setView((v) => zoomView(v, v.s * factor, dx, dy));
      };

      // The wheel zooms. React's own wheel listener is passive and cannot stop the
      // page (or a trackpad pinch) from scrolling and zooming the app, so a native
      // one is attached to the stage.
      const stage = useRef(null);
      if (stage.current === null) {
        const box = { el: null, listener: null };
        box.ref = (el) => {
          if (box.el && box.listener) box.el.removeEventListener('wheel', box.listener);
          box.el = el;
          if (!el) return;
          box.listener = (e) => {
            e.preventDefault();
            // A pinch arrives as ctrl+wheel with small deltas; a mouse wheel as large ones.
            const speed = e.ctrlKey ? 0.01 : 0.0015;
            const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
            const img = typeof el.querySelector === 'function' ? el.querySelector('img') : null;
            zoomAt(Math.exp(-delta * speed), img, e.clientX, e.clientY);
          };
          el.addEventListener('wheel', box.listener, { passive: false });
        };
        stage.current = box;
      }

      useEffect(() => {
        if (typeof document === 'undefined') return undefined;
        const key = (e) => {
          if (e.key === 'Escape') onClose();
          else if (e.key === 'ArrowRight' && index < items.length - 1) onStep(index + 1);
          else if (e.key === 'ArrowLeft' && index > 0) onStep(index - 1);
          else if (e.key === '+' || e.key === '=') setView((v) => zoomView(v, v.s * ZOOM_STEP));
          else if (e.key === '-' || e.key === '_') setView((v) => zoomView(v, v.s / ZOOM_STEP));
          else if (e.key === '0') setView(FIT);
          else return;
          e.preventDefault();
          e.stopPropagation();
        };
        document.addEventListener('keydown', key, true);
        const previous = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => {
          document.removeEventListener('keydown', key, true);
          document.body.style.overflow = previous;
        };
      }, [index, items.length]);
      if (!item) return null;
      const meta = metaLine(t, item);
      const zoomed = view.s > 1;
      const nav = (dir) =>
        h(
          'button',
          {
            type: 'button',
            'aria-label': dir > 0 ? t('next') : t('previous'),
            onClick: (e) => {
              e.stopPropagation();
              onStep(index + dir);
            },
            style: {
              position: 'absolute',
              top: '50%',
              [dir > 0 ? 'right' : 'left']: 18,
              transform: 'translateY(-50%)',
              zIndex: 1,
              width: 40,
              height: 40,
              borderRadius: 20,
              border: 'none',
              cursor: 'pointer',
              color: '#fff',
              background: 'rgba(0,0,0,.45)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            },
          },
          h(ChevronIcon, { dir }),
        );
      const zoomBar = h(
        'div',
        {
          'data-dsh-images-zoom': true,
          onClick: (e) => e.stopPropagation(),
          style: { display: 'flex', alignItems: 'center', gap: 2, padding: 2, borderRadius: 10, background: 'rgba(0,0,0,.55)', backdropFilter: 'blur(6px)' },
        },
        h(IconButton, { key: 'out', title: t('zoomOut'), dark: true, onClick: () => setView((v) => zoomView(v, v.s / ZOOM_STEP)) }, h(ZoomOutIcon, { size: 18 })),
        h(
          'button',
          {
            type: 'button',
            title: t('zoomReset'),
            'aria-label': t('zoomReset'),
            onClick: (e) => {
              e.stopPropagation();
              setView(FIT);
            },
            style: { minWidth: 48, height: 28, padding: '0 4px', border: 'none', borderRadius: 8, background: 'transparent', color: '#fff', font: 'inherit', fontSize: 12, fontVariantNumeric: 'tabular-nums', cursor: 'pointer' },
          },
          `${Math.round(view.s * 100)}%`,
        ),
        h(IconButton, { key: 'in', title: t('zoomIn'), dark: true, onClick: () => setView((v) => zoomView(v, v.s * ZOOM_STEP)) }, h(ZoomInIcon, { size: 18 })),
      );
      const title = onOpenSession && item.sessionId ? sessionTitle?.(item.sessionId) : undefined;
      const openSession =
        onOpenSession && item.sessionId
          ? h(
              'button',
              {
                type: 'button',
                title: title ? t('openSessionTitled', { title }) : t('openSession'),
                'data-dsh-images-open-session': item.sessionId,
                onClick: (e) => {
                  e.stopPropagation();
                  const next = onOpenSession(item);
                  setNotice(next ? { at: index, ...next } : null);
                },
                style: { display: 'inline-flex', alignItems: 'center', gap: 6, height: 32, padding: '0 12px 0 10px', border: 'none', borderRadius: 10, cursor: 'pointer', color: '#fff', background: 'rgba(0,0,0,.55)', backdropFilter: 'blur(6px)', font: 'inherit', fontSize: 12.5, whiteSpace: 'nowrap' },
              },
              h(ChatIcon),
              t('openSession'),
            )
          : null;
      const node = h(
        'div',
        {
          role: 'dialog',
          'aria-modal': true,
          'aria-label': t('viewer'),
          'data-dsh-images-lightbox': true,
          onClick: onClose,
          style: { position: 'fixed', inset: 0, zIndex: 2000, background: 'rgba(0,0,0,.86)', display: 'flex', flexDirection: 'column', color: '#fff' },
        },
        h(
          'div',
          { style: { position: 'absolute', top: 14, right: 14, display: 'flex', alignItems: 'center', gap: 8, zIndex: 2 } },
          zoomBar,
          openSession,
          h(IconButton, { key: 'dl', title: t('download'), dark: true, onClick: () => download(item) }, h(DownloadIcon, { size: 18 })),
          h(IconButton, { key: 'x', title: t('close'), dark: true, onClick: onClose }, h(CloseIcon, { size: 18 })),
        ),
        index > 0 ? nav(-1) : null,
        index < items.length - 1 ? nav(1) : null,
        h(
          'div',
          {
            ref: stage.current.ref,
            'data-dsh-images-stage': true,
            style: { flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '56px 72px 12px', overflow: 'hidden' },
          },
          h('img', {
            src: item.src,
            alt: item.prompt ?? '',
            draggable: false,
            onClick: (e) => e.stopPropagation(),
            // Double-click toggles between fitted and 2× at the point clicked.
            onDoubleClick: (e) => {
              e.stopPropagation();
              if (view.s !== 1) setView(FIT);
              else zoomAt(2, e.currentTarget, e.clientX, e.clientY);
            },
            // Dragging pans a zoomed picture.
            onPointerDown: (e) => {
              if (!zoomed || e.button !== 0) return;
              e.preventDefault();
              drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, ox: view.x, oy: view.y };
              e.currentTarget.setPointerCapture?.(e.pointerId);
            },
            onPointerMove: (e) => {
              const d = drag.current;
              if (!d || d.id !== e.pointerId) return;
              setView((v) => ({ ...v, x: d.ox + e.clientX - d.x, y: d.oy + e.clientY - d.y }));
            },
            onPointerUp: (e) => {
              if (drag.current?.id === e.pointerId) drag.current = null;
            },
            onPointerCancel: () => {
              drag.current = null;
            },
            style: {
              maxWidth: '100%',
              maxHeight: '100%',
              objectFit: 'contain',
              borderRadius: 6,
              boxShadow: '0 12px 48px rgba(0,0,0,.5)',
              cursor: zoomed ? (drag.current ? 'grabbing' : 'grab') : 'zoom-in',
              transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})`,
              transformOrigin: 'center center',
              transition: drag.current ? 'none' : 'transform .12s ease-out',
              touchAction: 'none',
              userSelect: 'none',
              willChange: 'transform',
            },
          }),
        ),
        h(
          'div',
          { onClick: (e) => e.stopPropagation(), style: { position: 'relative', zIndex: 1, padding: '0 72px 22px', textAlign: 'center', fontSize: SMALL, lineHeight: 1.5 } },
          item.prompt ? h('div', { style: { maxWidth: 820, margin: '0 auto', color: 'rgba(255,255,255,.92)', userSelect: 'text' } }, item.prompt) : null,
          meta ? h('div', { style: { marginTop: 4, color: 'rgba(255,255,255,.55)' } }, `${meta}${items.length > 1 ? ` · ${index + 1} / ${items.length}` : ''}`) : null,
        ),
        notice && notice.at === index
          ? h(PanelToast, {
              text: t(notice.key),
              onDone: () => setNotice(null),
              style: { top: 60, bottom: 'auto', zIndex: 3 },
              action: notice.action
                ? {
                    label: notice.busy ? t('unarchiving') : t(notice.action.key),
                    busy: notice.busy === true,
                    run: () => {
                      const { at, action } = notice;
                      setNotice((n) => (n ? { ...n, busy: true } : n));
                      Promise.resolve()
                        .then(action.run)
                        .then(
                          (next) => setNotice(next ? { at, ...next } : null),
                          () => setNotice({ at, key: 'unarchiveFailed' }),
                        );
                    },
                  }
                : undefined,
            })
          : null,
      );
      return ReactDOM && typeof ReactDOM.createPortal === 'function' && typeof document !== 'undefined' ? ReactDOM.createPortal(node, document.body) : node;
    }

    /** Lightbox state shared by a set of tiles: which one is open. */
    function useLightbox() {
      const [at, setAt] = useState(-1);
      return { at, open: (items, item) => setAt(items.indexOf(item)), close: () => setAt(-1), step: setAt };
    }

    const WARN = 'var(--dsw-alias-state-warn-primary, #f59e0b)';
    /** The line under a GIF drawn by a model not known to keep to the frame grid. */
    const gifWarning = (t, meta, model) =>
      meta && meta.gifUnverified ? h('div', { 'data-dsh-images-gif-warning': true, style: { fontSize: 11.5, color: WARN, lineHeight: 1.5 } }, t('gifUnverified', { model: model || meta.model || '' })) : null;

    // --- the tool call in the conversation -----------------------------------------

    function parseArgs(block) {
      const raw = block?.argsRaw ?? block?.call?.argsRaw;
      if (typeof raw === 'string' && raw !== '') {
        try {
          return JSON.parse(raw);
        } catch {
          // Partial JSON while the call streams.
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

    /** The images of one settled result: gallery ids from the meta, else attachment refs. */
    function resultImages(block) {
      const meta = block?.meta && typeof block.meta === 'object' ? block.meta : {};
      const refs = (Array.isArray(block?.content) ? block.content : []).filter((b) => b && b.type === 'image' && b.attachment);
      const ids = Array.isArray(meta.ids) ? meta.ids.map(String) : [];
      const out = [];
      const count = Math.max(ids.length, refs.length);
      for (let i = 0; i < count; i += 1) {
        const ref = refs[i]?.attachment;
        // The gallery file's own facts: for a GIF the attachment is its sprite sheet.
        const media = Array.isArray(meta.media) && meta.media[i] && typeof meta.media[i] === 'object' ? meta.media[i] : undefined;
        out.push({
          id: ids[i] ?? ref?.attachmentId ?? `${block.callId}:${i}`,
          url: ids[i] ? fileUrl(ids[i]) : undefined,
          attachment: ref,
          mediaType: media?.mediaType ?? ref?.mediaType ?? 'image/png',
          width: media?.width ?? ref?.width ?? 0,
          height: media?.height ?? ref?.height ?? 0,
          ...(media?.frames ? { animation: { frames: media.frames } } : {}),
          prompt: typeof meta.prompt === 'string' ? meta.prompt : undefined,
          model: typeof meta.model === 'string' ? meta.model : undefined,
          cost: meta.cost && typeof meta.cost === 'object' && count > 0 ? { ...meta.cost, amount: Number(meta.cost.amount) / count } : undefined,
        });
      }
      return out;
    }

    function resultText(block) {
      return (Array.isArray(block?.content) ? block.content : [])
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n')
        .trim();
    }

    /** An image whose bytes come through the session's attachment loader when no gallery URL names it. */
    function useSources(images, loadImage) {
      const [srcs, setSrcs] = useState({});
      useEffect(() => {
        let live = true;
        for (const img of images) {
          if (img.url || !img.attachment || typeof loadImage !== 'function') continue;
          const peeked = typeof loadImage.peek === 'function' ? loadImage.peek(img.attachment) : undefined;
          if (peeked) {
            setSrcs((s) => (s[img.id] === peeked ? s : { ...s, [img.id]: peeked }));
            continue;
          }
          Promise.resolve()
            .then(() => loadImage(img.attachment))
            .then((src) => {
              if (live && typeof src === 'string') setSrcs((s) => ({ ...s, [img.id]: src }));
            })
            .catch(() => {});
        }
        return () => {
          live = false;
        };
      }, [images.map((i) => i.id).join('|')]);
      return images.map((img) => ({ ...img, src: img.url ?? srcs[img.id] })).filter((img) => img.src);
    }

    function GenerateImageView(props) {
      const t = typeof props.t === 'function' ? props.t : fallbackT;
      const { phase, block } = props;
      const args = parseArgs(block);
      const prompt = typeof args.prompt === 'string' ? args.prompt : '';
      const settled = phase === 'result';
      const images = settled ? resultImages(block) : [];
      const shown = useSources(images, props.loadImage);
      const box = useLightbox();
      const [expanded, setExpanded] = useState(false);

      const head = h(
        'div',
        { style: { display: 'flex', alignItems: 'baseline', gap: 8, fontSize: SMALL, color: C.muted, minWidth: 0 } },
        h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, color: settled && !block.isError ? C.label : C.faint, fontWeight: 600, flex: 'none' } }, h(ImagesGlyph, { size: 14, active: settled && !block.isError }), t('toolTitle')),
        settled && !block.isError && shown[0]?.model
          ? h('span', { style: { color: C.faint, flex: 'none' } }, [shown[0].model, block.meta?.cost ? fmtCost(block.meta.cost) : null].filter(Boolean).join(' · '))
          : null,
        Array.isArray(args.images) && args.images.length > 0 ? h('span', { style: { color: C.faint, flex: 'none' } }, t('fromInputs', { n: args.images.length })) : null,
        !settled ? h('span', { style: { color: C.faint, fontStyle: 'italic' } }, t(phase === 'preparing' ? 'preparing' : 'generating')) : null,
      );

      const long = prompt.length > 160;
      const promptRow = prompt
        ? h(
            'div',
            {
              onClick: long ? () => setExpanded((v) => !v) : undefined,
              title: long && !expanded ? prompt : undefined,
              style: {
                fontSize: SMALL,
                color: C.muted,
                lineHeight: 1.5,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                userSelect: 'text',
                cursor: long ? 'pointer' : undefined,
                ...(long && !expanded ? { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' } : {}),
              },
            },
            prompt,
          )
        : null;

      let body;
      if (!settled) {
        body = h('div', {
          'data-dsh-images-pending': true,
          style: { width: 220, maxWidth: '100%', aspectRatio: '1 / 1', borderRadius: 12, background: `linear-gradient(110deg, ${C.layer2} 30%, ${C.layer3} 50%, ${C.layer2} 70%)`, backgroundSize: '200% 100%', animation: 'dsh-images-shimmer 1.6s linear infinite' },
        });
      } else if (block.isError) {
        body = h('div', { style: { fontSize: SMALL, color: C.error, whiteSpace: 'pre-wrap', wordBreak: 'break-word', userSelect: 'text' } }, resultText(block) || t('failed'));
      } else if (shown.length === 0) {
        body = h('div', { style: { fontSize: SMALL, color: C.faint } }, images.length > 0 ? t('loading') : resultText(block) || t('noImage'));
      } else {
        body = h(
          'div',
          { style: { display: 'flex', flexWrap: 'wrap', gap: 10 } },
          shown.map((img) =>
            h(
              'div',
              { key: img.id, style: { maxWidth: '100%', minWidth: 0 } },
              h(Tile, { t, item: img, onOpen: (item) => box.open(shown, item), maxHeight: shown.length > 1 ? 260 : 420 }),
            ),
          ),
        );
      }

      return h(
        'div',
        { 'data-dsh-images-call': block?.callId, style: { display: 'flex', flexDirection: 'column', gap: 8, padding: '6px 0 4px', fontSize: FONT, color: C.primary } },
        h('style', null, '@keyframes dsh-images-shimmer{from{background-position:200% 0}to{background-position:-200% 0}}'),
        head,
        promptRow,
        body,
        settled && !block.isError ? gifWarning(t, block.meta) : null,
        box.at >= 0 ? h(Lightbox, { t, items: shown, index: box.at, onClose: box.close, onStep: box.step }) : null,
      );
    }

    // --- the result row outside the fold ----------------------------------------------
    //
    // The tool card above lives inside the turn's process fold, which closes once the
    // turn completes. The picture itself is the answer, so a second node carries it
    // at the `turn` level, beside the model's text, where the fold cannot hide it.

    const RESULT_KIND = 'images-result';
    // Call ids of generate_image calls seen in each Session's feed, so a result can be told apart.
    const ownCalls = new Set();

    function isOwnResult(event) {
      if (event?.type !== 'tool/result' || event.surfaceOp !== 'append') return false;
      const data = event.data ?? {};
      const callId = String(data.message?.source?.callId ?? data.message?.toolCallId ?? '');
      if (callId !== '' && ownCalls.has(callId)) return true;
      const meta = data.meta;
      return Boolean(meta && Array.isArray(meta.ids) && typeof meta.prompt === 'string');
    }

    const imagesResultDefinition = {
      kind: RESULT_KIND,
      target: 'chat',
      match: (event) => {
        if (event?.type === 'tool/call') {
          if (event.data?.name === TOOL_NAME) ownCalls.add(String(event.data.callId));
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
          content: Array.isArray(data.message?.content) ? data.message.content : [],
          isError: data.message?.isError === true,
          meta: data.meta && typeof data.meta === 'object' ? data.meta : {},
        };
      },
      update: (context) => context.state,
      buildViewNode: (context) => {
        const state = context.state;
        if (state === undefined || state.isError || resultImages(state).length === 0) return null;
        return {
          key: context.key,
          kind: RESULT_KIND,
          id: context.id,
          target: 'chat',
          // A fraction after the result keeps the row where the picture was made.
          anchorSeq: state.seq + 0.2,
          location: context.start.location,
          visibility: 'visible',
          // Turn level: outside the process fold, like the model's own answer.
          groupTree: 'turn',
          data: state,
        };
      },
    };

    function ImagesResultRow(props) {
      const t = typeof props.t === 'function' ? props.t : fallbackT;
      const state = props.node?.data ?? {};
      const images = resultImages(state);
      const shown = useSources(images, props.loadImage);
      const box = useLightbox();
      if (shown.length === 0) return null;
      return h(
        'div',
        { 'data-dsh-images-row': state.callId, style: { display: 'flex', flexWrap: 'wrap', gap: 10, padding: '6px 0 10px' } },
        shown.map((img) =>
          h(
            'div',
            { key: img.id, style: { maxWidth: '100%', minWidth: 0 } },
            h(Tile, { t, item: img, onOpen: (item) => box.open(shown, item), maxHeight: shown.length > 1 ? 260 : 480 }),
            h('div', { style: { marginTop: 5, fontSize: 11.5, color: C.faint, letterSpacing: 0.1 } }, metaLine(t, img)),
          ),
        ),
        gifWarning(t, state.meta) ? h('div', { style: { flexBasis: '100%' } }, gifWarning(t, state.meta)) : null,
        box.at >= 0 ? h(Lightbox, { t, items: shown, index: box.at, onClose: box.close, onStep: box.step }) : null,
      );
    }

    // --- the gallery panel -----------------------------------------------------------

    function ImagesPanel(props) {
      const t = typeof props.t === 'function' ? props.t : fallbackT;
      const [items, setItems] = useState(null);
      const [hasMore, setHasMore] = useState(false);
      const [total, setTotal] = useState(0);
      const [failed, setFailed] = useState(false);
      const [loadingMore, setLoadingMore] = useState(false);
      const [totals, setTotals] = useState({});
      const [settingsOpen, setSettingsOpen] = useState(false);
      const [toast, setToast] = useState('');
      const box = useLightbox();
      const alive = useRef(true);
      const itemsRef = useRef(items);
      itemsRef.current = items;
      const scroller = useRef(null);

      const decorate = (it) => ({ ...it, src: it.url });

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
            getJson(STATE_ROUTE).then((st) => alive.current && st?.totals && setTotals(st.totals)).catch(() => {});
            const fresh = body.items.map(decorate);
            const known = itemsRef.current;
            if (known === null) {
              setItems(fresh);
              setHasMore(body.hasMore === true);
              return;
            }
            // Keep what is loaded; add what is new in front, drop what is gone from the first page.
            const seen = new Set(fresh.map((i) => i.id));
            const firstPageIds = new Set(known.slice(0, PAGE).map((i) => i.id));
            const added = fresh.filter((i) => !firstPageIds.has(i.id));
            const kept = known.filter((i, at) => at >= PAGE || seen.has(i.id));
            if (added.length === 0 && kept.length === known.length) return;
            setItems([...added, ...kept]);
          })
          .catch(() => alive.current && itemsRef.current === null && setFailed(true));

      const loadMore = () => {
        const known = itemsRef.current;
        if (!hasMore || loadingMore || !known || known.length === 0) return;
        setLoadingMore(true);
        getJson(`${LIST_ROUTE}?limit=${PAGE}&before=${encodeURIComponent(known[known.length - 1].id)}`)
          .then((body) => {
            if (!alive.current || body === null || !Array.isArray(body.items)) return;
            const have = new Set((itemsRef.current ?? []).map((i) => i.id));
            setItems([...(itemsRef.current ?? []), ...body.items.filter((i) => !have.has(i.id)).map(decorate)]);
            setHasMore(body.hasMore === true);
          })
          .catch(() => {})
          .finally(() => alive.current && setLoadingMore(false));
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

      const onScroll = (e) => {
        const el = e.currentTarget;
        if (el.scrollHeight - el.scrollTop - el.clientHeight < 700) loadMore();
      };

      // The conversation a picture was drawn in. An archived one stays shut and offers
      // to unarchive it (for a subagent, the session it ran under); a deleted one says so.
      const sessions = props.sessions;
      const go = (id) => {
        if (!sessions.open(id)) return { key: 'sessionGone' };
        box.close();
        return null;
      };
      const openSession =
        sessions && sessions.available()
          ? (item) => {
              const id = item.sessionId;
              const { state, archived } = sessions.state(id);
              if (state === 'gone') return { key: 'sessionGone' };
              if (state !== 'archived') return go(id);
              if (!sessions.canUnarchive()) return { key: 'sessionArchived' };
              return {
                key: 'sessionArchived',
                action: { key: 'unarchiveAndOpen', run: () => sessions.unarchive(archived).then((ok) => (ok ? go(id) : { key: 'unarchiveFailed' })) },
              };
            }
          : undefined;

      const remove = (item) => {
        setItems((list) => (list ?? []).filter((i) => i.id !== item.id));
        setTotal((n) => Math.max(0, n - 1));
        if (box.at >= 0) box.close();
        void postJson(DELETE_ROUTE, { id: item.id }).catch(() => {});
      };

      const header = h(
        'div',
        {
          style: {
            position: 'sticky',
            top: 0,
            zIndex: 2,
            display: 'flex',
            alignItems: 'baseline',
            gap: 10,
            padding: '16px 24px 12px',
            background: C.base,
            borderBottom: `1px solid ${C.border1}`,
          },
        },
        h('span', { style: { fontSize: 15.5, fontWeight: 640, color: C.primary } }, t('title')),
        h('span', { style: { fontSize: SMALL, color: C.faint } }, [total > 0 ? t('count', { n: total }) : null, fmtTotals(totals) ? t('spent', { amount: fmtTotals(totals) }) : null].filter(Boolean).join(' · ')),
        h('span', { style: { flex: 1 } }),
        h(HeaderButton, { onClick: refresh }, t('refresh')),
        h(HeaderButton, { onClick: () => setSettingsOpen(true), icon: h(GearIcon), 'data-dsh-images-settings-button': true }, t('settings')),
      );

      let body;
      if (failed) body = h('div', { style: { padding: 24, color: C.faint } }, t('unavailable'));
      else if (items === null) body = h('div', { style: { padding: 24, color: C.faint } }, '…');
      else if (items.length === 0) body = h('div', { style: { padding: '48px 24px', color: C.muted, maxWidth: 520, lineHeight: 1.6 } }, t('empty'));
      else {
        body = h(
          'div',
          { 'data-dsh-images-grid': true, style: { padding: '18px 24px 60px', columnWidth: 240, columnGap: 14 } },
          items.map((item) =>
            h(
              'div',
              { key: item.id, style: { breakInside: 'avoid', marginBottom: 14 } },
              h(Tile, {
                t,
                item,
                onOpen: (it) => box.open(items, it),
                onDelete: remove,
                caption: h(
                  'figcaption',
                  { style: { padding: '8px 10px 9px', fontSize: SMALL, lineHeight: 1.45 } },
                  item.prompt
                    ? h('div', { title: item.prompt, style: { color: C.primary, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', wordBreak: 'break-word' } }, item.prompt)
                    : null,
                  h('div', { style: { marginTop: 3, color: C.faint, fontSize: 11.5 } }, metaLine(t, item)),
                ),
              }),
            ),
          ),
          hasMore
            ? h(
                'div',
                { style: { breakInside: 'avoid', textAlign: 'center', padding: 12 } },
                h('button', { type: 'button', onClick: loadMore, disabled: loadingMore, style: { font: 'inherit', fontSize: SMALL, color: C.muted, background: 'transparent', border: `1px solid ${C.border1}`, borderRadius: 9, padding: '6px 14px', cursor: 'pointer' } }, loadingMore ? '…' : t('loadMore')),
              )
            : null,
        );
      }

      return h(
        'div',
        {
          ref: scroller,
          onScroll,
          'data-dsh-images-panel': true,
          style: { position: 'relative', height: '100%', width: '100%', overflowY: 'auto', background: C.base, color: C.primary, fontSize: FONT, boxSizing: 'border-box' },
        },
        header,
        body,
        box.at >= 0 && items ? h(Lightbox, { t, items, index: box.at, onClose: box.close, onStep: box.step, onOpenSession: openSession, sessionTitle: sessions?.title }) : null,
        settingsOpen
          ? h(SettingsDrawer, {
              t,
              onClose: () => setSettingsOpen(false),
              onSaved: (body) => {
                setSettingsOpen(false);
                setToast(t('saved'));
                if (body?.stats?.totals) setTotals(body.stats.totals);
              },
            })
          : null,
        toast ? h(PanelToast, { text: toast, onDone: () => setToast('') }) : null,
      );
    }

    function HeaderButton({ onClick, icon, children, ...rest }) {
      return h(
        'button',
        {
          type: 'button',
          onClick,
          ...rest,
          style: { display: 'inline-flex', alignItems: 'center', gap: 6, font: 'inherit', fontSize: SMALL, color: C.muted, background: C.layer2, border: `1px solid ${C.border1}`, borderRadius: 9, padding: '5px 12px', cursor: 'pointer' },
        },
        icon ?? null,
        children,
      );
    }

    /**
     * A notice that leaves by itself. With `action` ({label, run, busy}) it carries
     * a button, stays longer, and stays while the action runs. White on dark in
     * every theme: the Harness has no elevated-surface token, and the viewer sits
     * on document.body over its own dark backdrop, where a theme's dark label
     * would vanish.
     */
    function PanelToast({ text, onDone, style, action }) {
      const busy = action?.busy === true;
      useEffect(() => {
        if (busy) return undefined;
        const timer = setTimeout(onDone, action ? 8000 : 3200);
        return () => clearTimeout(timer);
      }, [text, busy]);
      return h(
        'div',
        {
          role: 'status',
          'data-dsh-images-toast': true,
          // In the viewer a click on the notice must not close it.
          onClick: (e) => e.stopPropagation(),
          style: {
            position: 'absolute',
            left: '50%',
            bottom: 28,
            transform: 'translateX(-50%)',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            width: 'max-content',
            maxWidth: 'calc(100% - 48px)',
            boxSizing: 'border-box',
            padding: action ? '6px 8px 6px 14px' : '8px 14px',
            borderRadius: 10,
            fontSize: SMALL,
            lineHeight: 1.5,
            background: 'rgba(44,44,48,.96)',
            border: '1px solid rgba(255,255,255,.12)',
            color: '#fff',
            boxShadow: '0 4px 16px rgba(0,0,0,.24)',
            zIndex: 20,
            ...style,
          },
        },
        h('span', null, text),
        action
          ? h(
              'button',
              {
                type: 'button',
                disabled: busy,
                'data-dsh-images-toast-action': true,
                onClick: (e) => {
                  e.stopPropagation();
                  if (!busy) action.run();
                },
                style: { flex: 'none', font: 'inherit', fontSize: SMALL, fontWeight: 600, padding: '3px 10px', border: 'none', borderRadius: 7, background: 'rgba(255,255,255,.16)', color: '#fff', cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.7 : 1, whiteSpace: 'nowrap' },
              },
              action.label,
            )
          : null,
      );
    }

    // --- the settings drawer ---------------------------------------------------------

    const field = { display: 'flex', flexDirection: 'column', gap: 6 };
    const labelStyle = { fontSize: 12, color: C.muted, fontWeight: 500 };
    const inputStyle = {
      font: 'inherit',
      fontSize: 13,
      color: C.primary,
      background: C.layer1,
      border: `1px solid ${C.border}`,
      borderRadius: 9,
      padding: '8px 11px',
      outline: 'none',
      width: '100%',
      boxSizing: 'border-box',
    };
    const hintStyle = { fontSize: 11.5, color: C.faint, lineHeight: 1.5 };
    const sectionTitle = (text) => h('div', { style: { fontSize: 11, letterSpacing: 1.2, textTransform: 'uppercase', color: C.faint, fontWeight: 600, marginTop: 6 } }, text);

    /**
     * How well `query` matches `text`, loosely: each space-separated term must
     * appear in order, letters may be skipped (`img26` finds `gpt-image-2.6`).
     * A term found whole, or starting a word, scores higher. Returns
     * `{score, hits}` (matched character indexes), or null for no match.
     */
    function fuzzyMatch(query, text) {
      const terms = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
      const hay = String(text ?? '').toLowerCase();
      if (terms.length === 0) return { score: 0, hits: [] };
      const startsWord = (i) => i === 0 || /[\s/\-_.:]/.test(hay[i - 1]);
      const hits = new Set();
      let score = 0;
      for (const term of terms) {
        const at = hay.indexOf(term);
        if (at >= 0) {
          score += term.length * 3 + (startsWord(at) ? 6 : 0);
          for (let i = 0; i < term.length; i += 1) hits.add(at + i);
          continue;
        }
        // Letters in order; of every place the first letter could anchor, keep the best.
        let best = null;
        for (let start = hay.indexOf(term[0]); start >= 0; start = hay.indexOf(term[0], start + 1)) {
          const at = [start];
          for (const ch of term.slice(1)) {
            const i = hay.indexOf(ch, at[at.length - 1] + 1);
            if (i < 0) break;
            at.push(i);
          }
          if (at.length < term.length) break;
          const s = at.reduce((sum, i, k) => sum + 1 + (k > 0 && i === at[k - 1] + 1 ? 2 : 0) + (startsWord(i) ? 2 : 0), 0) - (at[at.length - 1] - at[0]) / 50;
          if (!best || s > best.s) best = { s, at };
        }
        if (!best) return null;
        score += best.s;
        for (const i of best.at) hits.add(i);
      }
      // Among equals, the shorter id is the likelier one.
      return { score: score - hay.length / 100, hits: [...hits].sort((a, b) => a - b) };
    }

    /** `text` with the characters at `hits` emphasized. */
    function highlighted(text, hits) {
      if (!hits || hits.length === 0) return text;
      const on = new Set(hits);
      const parts = [];
      let run = '';
      let runOn = on.has(0);
      const flush = (i) => {
        if (run === '') return;
        parts.push(runOn ? h('span', { key: i, style: { color: C.primary, fontWeight: 650 } }, run) : run);
        run = '';
      };
      for (let i = 0; i < text.length; i += 1) {
        if (on.has(i) !== runOn) {
          flush(i);
          runOn = on.has(i);
        }
        run += text[i];
      }
      flush(text.length);
      return parts;
    }

    /** The routing prefix of a model id (`sub2api/` of `sub2api/gpt-image-1.5`), or ''. */
    const prefixOf = (id) => (String(id ?? '').includes('/') ? String(id).slice(0, String(id).lastIndexOf('/') + 1) : '');

    const COMBO_LIMIT = 200;

    /**
     * A text field with a searchable list under it. Typing filters every group
     * loosely; any id can still be typed. Groups marked `prefixable` (the price
     * catalog's bare names) take the routing prefix being typed, or the one the
     * field had when the list opened.
     */
    function ModelCombo({ t, value, placeholder, groups, onChange, labelId }) {
      const [open, setOpen] = useState(false);
      const [query, setQuery] = useState(null); // null: just opened, show everything
      const [active, setActive] = useState(-1);
      const [base, setBase] = useState('');
      const inputRef = useRef(null);
      const listRef = useRef(null);

      const q = query ?? '';
      const seen = new Set();
      const sections = [];
      let total = 0;
      for (const group of groups) {
        const prefix = group.prefixable ? (q.includes('/') ? prefixOf(q) : prefixOf(base)) : '';
        const term = group.prefixable && q.includes('/') ? q.slice(prefix.length) : q;
        const rows = [];
        for (const item of group.items) {
          const id = `${prefix}${item.id}`;
          if (seen.has(id)) continue;
          const m = fuzzyMatch(term, item.id);
          if (!m) continue;
          seen.add(id);
          rows.push({ ...item, id, hits: m.hits.map((i) => i + prefix.length), score: m.score });
        }
        if (term !== '') rows.sort((a, b) => b.score - a.score);
        if (rows.length === 0) continue;
        total += rows.length;
        sections.push({ ...group, prefix, rows });
      }
      // One flat list for the arrow keys, capped so a huge listing stays quick.
      const flat = [];
      for (const section of sections) {
        section.rows = section.rows.slice(0, Math.max(0, COMBO_LIMIT - flat.length));
        flat.push(...section.rows);
      }
      const hidden = total - flat.length;

      useEffect(() => {
        if (!open || active < 0) return;
        const node = listRef.current?.querySelector?.(`[data-index="${active}"]`);
        node?.scrollIntoView?.({ block: 'nearest' });
      }, [open, active]);

      const show = () => {
        setOpen(true);
        setQuery(null);
        setBase(value ?? '');
        setActive(-1);
      };
      const pick = (id) => {
        onChange(id);
        setOpen(false);
        setQuery(null);
      };
      const onKeyDown = (e) => {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          if (!open) show();
          else setActive((a) => Math.min(flat.length - 1, a + 1));
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          setActive((a) => Math.max(0, a - 1));
        } else if (e.key === 'Enter') {
          if (open && flat[active]) {
            e.preventDefault();
            pick(flat[active].id);
          }
        } else if (e.key === 'Escape') {
          if (open) {
            e.preventDefault();
            e.stopPropagation?.();
            setOpen(false);
          }
        } else if (e.key === 'Tab') setOpen(false);
      };
      const listId = 'dsh-images-model-list';
      const hasAny = groups.some((g) => g.items.length > 0);
      const showList = open && (hasAny || q !== '');

      let index = -1;
      return h(
        'div',
        { style: { position: 'relative' } },
        h('input', {
          ref: inputRef,
          role: 'combobox',
          'aria-expanded': showList,
          'aria-controls': listId,
          'aria-autocomplete': 'list',
          'aria-labelledby': labelId,
          'aria-activedescendant': showList && active >= 0 ? `${listId}-${active}` : undefined,
          value: value ?? '',
          placeholder,
          onFocus: show,
          onClick: () => !open && show(),
          onBlur: () => setOpen(false),
          onChange: (e) => {
            onChange(e.target.value);
            setQuery(e.target.value);
            setOpen(true);
            setActive(e.target.value === '' ? -1 : 0);
          },
          onKeyDown,
          style: { ...inputStyle, paddingRight: 34 },
          spellCheck: false,
          autoComplete: 'off',
          'data-dsh-images-field': 'model',
        }),
        h(
          'button',
          {
            type: 'button',
            tabIndex: -1,
            'aria-label': t('comboToggle'),
            onMouseDown: (e) => {
              e.preventDefault();
              if (showList) setOpen(false);
              else {
                show();
                inputRef.current?.focus?.();
              }
            },
            style: { position: 'absolute', right: 4, top: 4, bottom: 4, width: 28, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', border: 'none', borderRadius: 7, background: 'transparent', color: C.faint, cursor: 'pointer' },
          },
          h('svg', { width: 12, height: 12, viewBox: '0 0 12 12', 'aria-hidden': true, style: { transform: showList ? 'rotate(180deg)' : 'none', transition: 'transform .15s' } }, h('path', { d: 'M2.5 4.5 6 8l3.5-3.5', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' })),
        ),
        showList
          ? h(
              'div',
              {
                ref: listRef,
                id: listId,
                role: 'listbox',
                'data-dsh-images-model-list': true,
                onMouseDown: (e) => e.preventDefault(),
                style: { position: 'absolute', left: 0, right: 0, top: 'calc(100% + 4px)', zIndex: 5, maxHeight: 300, overflowY: 'auto', padding: 4, background: C.base, border: `1px solid ${C.border}`, borderRadius: 10, boxShadow: '0 8px 28px rgba(0,0,0,.18)' },
              },
              flat.length === 0 ? h('div', { style: { padding: '8px 10px', fontSize: 12, color: C.faint } }, t('comboNoMatch')) : null,
              sections.map((section) =>
                h(
                  'div',
                  { key: section.key, role: 'group', 'aria-label': section.label },
                  h('div', { style: { padding: '6px 10px 3px', fontSize: 10.5, letterSpacing: 0.6, textTransform: 'uppercase', color: C.faint, fontWeight: 600 } }, section.prefix ? `${section.label} · ${section.prefix}` : section.label),
                  section.rows.map((row) => {
                    index += 1;
                    const i = index;
                    return h(
                      'div',
                      {
                        key: row.id,
                        id: `${listId}-${i}`,
                        role: 'option',
                        'aria-selected': i === active,
                        'data-index': i,
                        'data-dsh-images-model-option': row.id,
                        onMouseDown: (e) => {
                          e.preventDefault();
                          pick(row.id);
                        },
                        onMouseEnter: () => setActive(i),
                        style: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderRadius: 7, fontSize: 12.5, cursor: 'pointer', color: C.muted, background: i === active ? C.hover : 'transparent', fontWeight: row.id === value ? 600 : 400 },
                      },
                      h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, highlighted(row.id, row.hits)),
                      row.tag ? h('span', { style: { flex: 'none', fontSize: 10.5, padding: '1px 6px', borderRadius: 999, border: `1px solid ${C.border1}`, color: C.faint } }, row.tag) : null,
                    );
                  }),
                ),
              ),
              hidden > 0 ? h('div', { style: { padding: '6px 10px', fontSize: 11.5, color: C.faint } }, t('comboMore', { n: hidden })) : null,
            )
          : null,
      );
    }

    function Segmented({ value, options, onChange }) {
      return h(
        'div',
        { role: 'radiogroup', style: { display: 'inline-flex', padding: 3, gap: 2, background: C.layer2, borderRadius: 9, border: `1px solid ${C.border1}` } },
        options.map((o) =>
          h(
            'button',
            {
              key: o.value,
              type: 'button',
              role: 'radio',
              'aria-checked': o.value === value,
              onClick: () => onChange(o.value),
              style: {
                font: 'inherit',
                fontSize: 12,
                padding: '4px 10px',
                border: 'none',
                borderRadius: 7,
                cursor: 'pointer',
                background: o.value === value ? C.layer1 : 'transparent',
                color: o.value === value ? C.primary : C.muted,
                boxShadow: o.value === value ? '0 1px 3px rgba(0,0,0,.12)' : 'none',
                fontWeight: o.value === value ? 600 : 400,
              },
            },
            o.label,
          ),
        ),
      );
    }

    function SettingsDrawer({ t, onClose, onSaved }) {
      const [info, setInfo] = useState(null);
      const [draft, setDraft] = useState(null);
      const [apiKey, setApiKey] = useState('');
      const [clearKey, setClearKey] = useState(false);
      const [models, setModels] = useState(null);
      const [probe, setProbe] = useState(null); // {state:'busy'|'ok'|'bad', text}
      const [preview, setPreview] = useState(null);
      const [catalog, setCatalog] = useState(null); // {status, names}
      const [catalogTick, setCatalogTick] = useState(0);
      const [saving, setSaving] = useState(false);
      const alive = useRef(true);
      const previewTimer = useRef(null);

      useEffect(() => {
        alive.current = true;
        getJson(SETTINGS_ROUTE)
          .then((body) => {
            if (!alive.current || !body) return;
            setInfo(body);
            setDraft({ ...body.values });
          })
          .catch(() => {});
        // The price catalog's image models, for the picker; downloaded on first use.
        getJson(CATALOG_ROUTE)
          .then((body) => alive.current && body?.status && setCatalog(body))
          .catch(() => {});
        return () => {
          alive.current = false;
        };
      }, []);

      useEffect(() => {
        if (typeof document === 'undefined') return undefined;
        const key = (e) => {
          // An open model list takes the Escape for itself.
          if (e.key === 'Escape' && e.target?.getAttribute?.('aria-expanded') !== 'true') onClose();
        };
        document.addEventListener('keydown', key, true);
        return () => document.removeEventListener('keydown', key, true);
      }, []);

      // How the typed model would be billed; asked a moment after typing stops.
      useEffect(() => {
        if (!draft) return undefined;
        if (previewTimer.current) clearTimeout(previewTimer.current);
        const model = draft.model || info?.defaults?.model || '';
        if (!model) {
          setPreview(null);
          return undefined;
        }
        previewTimer.current = setTimeout(() => {
          getJson(`${SETTINGS_ROUTE}?model=${encodeURIComponent(model)}&size=${encodeURIComponent(draft.size || '')}&quality=${encodeURIComponent(draft.quality || '')}`)
            .then((body) => alive.current && setPreview(body))
            .catch(() => {});
        }, 250);
        return () => clearTimeout(previewTimer.current);
      }, [draft?.model, draft?.size, draft?.quality, catalogTick]);

      if (!info || !draft) {
        return h(DrawerFrame, { t, onClose }, h('div', { style: { color: C.faint } }, '…'));
      }

      const set = (patch) => setDraft((d) => ({ ...d, ...patch }));
      const providerOptions = [
        { value: '', label: info.sessionProvider ? t('providerSession', { name: info.sessionProvider }) : t('providerSessionNone') },
        ...info.providers.filter((p) => p.id !== '').map((p) => ({ value: p.id, label: p.name === p.id ? p.id : `${p.name} (${p.id})` })),
        { value: 'custom', label: t('providerCustom') },
      ];
      const pickedProvider = info.providers.find((p) => p.id === (draft.provider || info.sessionProvider));
      const baseURLPlaceholder = draft.provider === 'custom' ? 'https://api.openai.com/v1' : pickedProvider?.baseURL || info.effective.baseURL || 'https://…/v1';
      const keyPlaceholder = info.storedKey
        ? t('keyStored', { hint: info.storedKey })
        : info.effective.keySource === 'provider' || info.effective.keySource === 'env'
          ? t('keyFromProvider', { hint: info.effective.keyHint })
          : t('keyNone');

      const runProbe = () => {
        setProbe({ state: 'busy', text: t('probing') });
        postJson(MODELS_ROUTE, { provider: draft.provider, baseURL: draft.baseURL, ...(apiKey ? { apiKey } : {}) })
          .then((body) => {
            if (!alive.current) return;
            if (!body || body.ok !== true) {
              setProbe({ state: 'bad', text: body?.reason ? t('probeFailed', { reason: body.reason }) : t('probeFailed', { reason: '?' }) });
              return;
            }
            setModels(body.models);
            const imageCount = body.models.filter((m) => m.isImage).length;
            setProbe({ state: 'ok', text: imageCount > 0 ? t('probeOk', { n: body.models.length, images: imageCount }) : t('probeOkNoImages', { n: body.models.length }) });
          })
          .catch(() => alive.current && setProbe({ state: 'bad', text: t('probeFailed', { reason: 'network' }) }));
      };

      const refreshCatalog = () => {
        setCatalog((c) => (c ? { ...c, status: { ...c.status, loading: true, error: '' } } : { status: { ...(info.catalog ?? {}), loading: true, error: '' }, names: [] }));
        postJson(CATALOG_ROUTE, { refresh: true })
          .then((body) => {
            if (!alive.current || !body?.status) return;
            setCatalog(body);
            setCatalogTick((n) => n + 1);
          })
          .catch(() => {});
      };

      const save = () => {
        setSaving(true);
        const body = { ...draft };
        if (clearKey) body.apiKey = null;
        else if (apiKey.trim() !== '') body.apiKey = apiKey.trim();
        postJson(SETTINGS_ROUTE, body)
          .then((res) => {
            if (!alive.current) return;
            setSaving(false);
            if (res?.ok) onSaved(res);
          })
          .catch(() => alive.current && setSaving(false));
      };

      const catalogName = catalog?.status?.name || info.catalog?.name || 'LiteLLM';
      const previewText = (() => {
        if (!preview) return '';
        if (preview.source === 'provider') return t('priceProvider', { price: fmtMoney(preview.perImage.amount, preview.perImage.currency) });
        if (preview.source === 'list') {
          const samples = (preview.samples ?? []).map((r) => `${r.size.replace('x', '×')} ${fmtMoney(r.price.amount, r.price.currency)}`).join(' · ');
          return t('priceList', { family: preview.family, samples, date: preview.priceListDate });
        }
        if (preview.source === 'catalog' && preview.catalog) {
          const c = preview.catalog;
          const name = c.approximate ? t('catalogNear', { name: c.name }) : c.name;
          const flat = c.perImage ? fmtMoney(c.perImage.amount, c.perImage.currency) : '';
          if (!c.tokens) return t('priceCatalogFlat', { catalog: catalogName, name, price: flat });
          const head = t('priceCatalogTokens', { catalog: catalogName, name, textIn: fmtMoney(c.tokens.textIn, 'USD'), imageOut: fmtMoney(c.tokens.imageOut, 'USD') });
          const tail = flat
            ? t('priceNoUsageFlat', { price: flat })
            : preview.manual
              ? t('priceNoUsageManual', { price: fmtMoney(preview.manual.amount, preview.manual.currency) })
              : t('priceNoUsageBlank');
          return `${head} ${tail}`;
        }
        if (preview.source === 'manual') return t('priceManual', { price: fmtMoney(preview.perImage.amount, preview.perImage.currency) });
        return preview.catalogError ? t('priceUnknownOffline', { catalog: catalogName }) : t('priceUnknown', { catalog: catalogName });
      })();

      // What the model picker offers: ids used before, the provider's listing, the catalog.
      const usedIds = [...new Set([info.values.model, info.defaults.model, ...Object.entries(info.stats?.byModel ?? {}).sort((a, b) => b[1].count - a[1].count).map(([id]) => id)])].filter((id) => typeof id === 'string' && id !== '');
      const pickerGroups = [
        { key: 'used', label: t('groupUsed'), items: usedIds.map((id) => ({ id })) },
        { key: 'provider', label: t('groupProvider'), items: (models ?? []).map((m) => ({ id: m.id, tag: m.isImage ? t('tagImage') : '' })) },
        { key: 'catalog', label: t('groupCatalog', { catalog: catalogName }), prefixable: true, items: (catalog?.names ?? []).map((id) => ({ id, tag: t('tagImage') })) },
      ];
      const catalogStatus = catalog?.status ?? info.catalog;
      const catalogLine = (() => {
        if (!catalogStatus || catalogStatus.enabled === false) return '';
        if (catalogStatus.loading) return t('catalogLoading', { catalog: catalogName });
        if (catalogStatus.count > 0) return t('catalogStatus', { catalog: catalogName, n: catalogStatus.count, date: new Date(catalogStatus.fetchedAt).toISOString().slice(0, 10) });
        if (catalogStatus.error) return t('catalogFailed', { catalog: catalogName, reason: catalogStatus.error });
        return t('catalogNotYet', { catalog: catalogName });
      })();

      const stats = info.stats ?? { total: 0, totals: {}, byModel: {} };
      const modelRows = Object.entries(stats.byModel ?? {}).sort((a, b) => b[1].count - a[1].count);

      return h(
        DrawerFrame,
        {
          t,
          onClose,
          footer: h(
            'div',
            { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
            h(DrawerButton, { onClick: onClose }, t('cancel')),
            h(DrawerButton, { onClick: save, primary: true, disabled: saving, 'data-dsh-images-save': true }, saving ? '…' : t('save')),
          ),
        },
        info.problem ? h('div', { style: { fontSize: 12.5, color: C.error, background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary, #f25a5a) 10%, transparent)', border: `1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary, #f25a5a) 30%, transparent)`, borderRadius: 9, padding: '8px 11px', lineHeight: 1.5 } }, info.problem) : null,

        sectionTitle(t('secProvider')),
        h(
          'label',
          { style: field },
          h('span', { style: labelStyle }, t('provider')),
          h(
            'select',
            { value: draft.provider ?? '', onChange: (e) => set({ provider: e.target.value, baseURL: e.target.value === 'custom' ? draft.baseURL : '' }), style: { ...inputStyle, appearance: 'auto' }, 'data-dsh-images-field': 'provider' },
            providerOptions.map((o) => h('option', { key: o.value, value: o.value }, o.label)),
          ),
        ),
        h(
          'label',
          { style: field },
          h('span', { style: labelStyle }, t('baseURL')),
          h('input', { type: 'url', value: draft.baseURL ?? '', placeholder: baseURLPlaceholder, onChange: (e) => set({ baseURL: e.target.value }), style: inputStyle, spellCheck: false, 'data-dsh-images-field': 'baseURL' }),
          draft.provider !== 'custom' ? h('span', { style: hintStyle }, t('baseURLHint')) : null,
        ),
        h(
          'label',
          { style: field },
          h('span', { style: { ...labelStyle, display: 'flex', justifyContent: 'space-between' } }, t('apiKey'), info.storedKey && !clearKey ? h('button', { type: 'button', onClick: () => setClearKey(true), style: { font: 'inherit', fontSize: 11.5, color: C.error, background: 'none', border: 'none', padding: 0, cursor: 'pointer' } }, t('clearKey')) : null),
          h('input', { type: 'password', value: apiKey, placeholder: clearKey ? t('keyWillClear') : keyPlaceholder, onChange: (e) => { setApiKey(e.target.value); if (e.target.value) setClearKey(false); }, style: inputStyle, autoComplete: 'off', spellCheck: false, 'data-dsh-images-field': 'apiKey' }),
          h('span', { style: hintStyle }, t('apiKeyHint')),
        ),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
          h(DrawerButton, { onClick: runProbe, disabled: probe?.state === 'busy', 'data-dsh-images-probe': true }, t('probe')),
          probe ? h('span', { style: { fontSize: 12, color: probe.state === 'bad' ? C.error : probe.state === 'ok' ? 'var(--dsw-alias-state-success-primary, #22c55e)' : C.faint } }, probe.text) : null,
        ),

        sectionTitle(t('secModel')),
        h(
          'div',
          { style: field },
          h('span', { id: 'dsh-images-model-label', style: labelStyle }, t('model')),
          h(ModelCombo, { t, value: draft.model ?? '', placeholder: info.defaults.model || 'gpt-image-1.5', groups: pickerGroups, onChange: (v) => set({ model: v }), labelId: 'dsh-images-model-label' }),
          h('span', { style: { ...hintStyle, color: preview?.source === 'unknown' ? 'var(--dsw-alias-state-warn-primary, #f59e0b)' : C.faint } }, previewText || (models ? t('modelHintListed') : t('modelHint'))),
          preview && preview.gif === false ? h('span', { 'data-dsh-images-gif-hint': true, style: { ...hintStyle, color: WARN } }, t('gifModelHint')) : null,
        ),
        models && models.some((m) => m.isImage)
          ? h(
              'div',
              { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
              models.filter((m) => m.isImage).slice(0, 12).map((m) =>
                h('button', { key: m.id, type: 'button', onClick: () => set({ model: m.id }), style: { font: 'inherit', fontSize: 11.5, padding: '3px 9px', borderRadius: 999, border: `1px solid ${draft.model === m.id ? C.label : C.border}`, color: draft.model === m.id ? C.label : C.muted, background: 'transparent', cursor: 'pointer' } }, m.id),
              ),
            )
          : null,
        h(
          'div',
          { style: { display: 'flex', gap: 18, flexWrap: 'wrap' } },
          h('div', { style: field }, h('span', { style: labelStyle }, t('size')), h(Segmented, { value: draft.size || 'auto', options: [...SIZES.map((v) => ({ value: v, label: v.replace('x', '×') })), { value: 'auto', label: t('auto') }], onChange: (v) => set({ size: v }) })),
          h('div', { style: field }, h('span', { style: labelStyle }, t('quality')), h(Segmented, { value: draft.quality || '', options: [{ value: '', label: t('default') }, ...QUALITIES.map((v) => ({ value: v, label: v }))], onChange: (v) => set({ quality: v }) })),
        ),

        sectionTitle(t('secBilling')),
        h(
          'div',
          { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 96px', gap: 10, alignItems: 'end' } },
          h('label', { style: field }, h('span', { style: labelStyle }, t('pricePerImage')), h('input', { type: 'number', min: 0, step: 0.001, value: draft.pricePerImage || '', placeholder: '0', onChange: (e) => set({ pricePerImage: e.target.value === '' ? '' : Number(e.target.value) }), style: inputStyle, 'data-dsh-images-field': 'pricePerImage' })),
          h('label', { style: field }, h('span', { style: labelStyle }, t('currency')), h('select', { value: draft.currency || 'USD', onChange: (e) => set({ currency: e.target.value }), style: { ...inputStyle, appearance: 'auto' } }, ['USD', 'CNY', 'EUR'].map((c) => h('option', { key: c, value: c }, c)))),
        ),
        h('span', { style: hintStyle }, t('pricePerImageHint', { date: info.priceListDate })),
        catalogLine
          ? h(
              'div',
              { style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' } },
              h('span', { style: { ...hintStyle, color: catalogStatus?.error && !catalogStatus?.count ? C.error : C.faint }, 'data-dsh-images-catalog': true }, catalogLine),
              catalogStatus?.loading
                ? null
                : h('button', { type: 'button', onClick: refreshCatalog, 'data-dsh-images-catalog-refresh': true, style: { font: 'inherit', fontSize: 11.5, color: C.label, background: 'none', border: 'none', padding: 0, cursor: 'pointer' } }, catalogStatus?.count > 0 ? t('catalogRefresh') : t('catalogRetry')),
            )
          : null,

        stats.total > 0
          ? h(
              'div',
              { style: { marginTop: 4, padding: '10px 12px', borderRadius: 10, background: C.layer2, border: `1px solid ${C.border1}`, display: 'flex', flexDirection: 'column', gap: 6 } },
              h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: 12.5, color: C.primary, fontWeight: 600 } }, h('span', null, t('statsTotal', { n: stats.total })), h('span', null, fmtTotals(stats.totals) ? `≈ ${fmtTotals(stats.totals)}` : t('statsNoCost'))),
              modelRows.map(([model, row]) =>
                h('div', { key: model, style: { display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12, color: C.muted } }, h('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, model), h('span', { style: { flex: 'none' } }, `${row.count} · ${fmtTotals(row.totals) ? `≈ ${fmtTotals(row.totals)}` : '—'}`)),
              ),
            )
          : null,
      );
    }

    function DrawerButton({ onClick, children, primary = false, disabled = false, ...rest }) {
      return h(
        'button',
        {
          type: 'button',
          onClick,
          disabled,
          ...rest,
          style: {
            font: 'inherit',
            fontSize: 13,
            fontWeight: primary ? 600 : 500,
            padding: '7px 14px',
            borderRadius: 9,
            cursor: disabled ? 'default' : 'pointer',
            opacity: disabled ? 0.6 : 1,
            border: primary ? 'none' : `1px solid ${C.border}`,
            background: primary ? C.label : 'transparent',
            color: primary ? 'var(--dsw-alias-label-on-brand, #fff)' : C.primary,
          },
        },
        children,
      );
    }

    /** The drawer's chrome: a dimmed panel behind, a sheet sliding in from the right. */
    function DrawerFrame({ t, onClose, footer, children }) {
      const node = h(
        'div',
        { 'data-dsh-images-drawer': true, style: { position: 'fixed', inset: 0, zIndex: 1500, display: 'flex', justifyContent: 'flex-end' } },
        h('style', null, '@keyframes dsh-images-slide{from{transform:translateX(24px);opacity:0}to{transform:none;opacity:1}}@keyframes dsh-images-fade{from{opacity:0}to{opacity:1}}'),
        h('div', { onClick: onClose, style: { position: 'absolute', inset: 0, background: 'rgba(0,0,0,.28)', animation: 'dsh-images-fade .18s ease-out' } }),
        h(
          'div',
          {
            role: 'dialog',
            'aria-modal': true,
            'aria-label': t('settingsTitle'),
            style: {
              position: 'relative',
              width: 'min(420px, 100vw)',
              height: '100%',
              display: 'flex',
              flexDirection: 'column',
              background: C.base,
              borderLeft: `1px solid ${C.border1}`,
              boxShadow: '-12px 0 40px rgba(0,0,0,.18)',
              animation: 'dsh-images-slide .22s cubic-bezier(.2,.8,.2,1)',
              color: C.primary,
              fontSize: FONT,
            },
          },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 10, padding: '16px 20px 12px', borderBottom: `1px solid ${C.border1}` } },
            h(ImagesGlyph, { size: 16, active: true }),
            h('span', { style: { fontSize: 15, fontWeight: 640 } }, t('settingsTitle')),
            h('span', { style: { flex: 1 } }),
            h('button', { type: 'button', 'aria-label': t('close'), onClick: onClose, style: { display: 'inline-flex', width: 28, height: 28, alignItems: 'center', justifyContent: 'center', border: 'none', borderRadius: 8, background: 'transparent', color: C.muted, cursor: 'pointer' } }, h(CloseIcon, { size: 16 })),
          ),
          h('div', { style: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '14px 20px 20px', display: 'flex', flexDirection: 'column', gap: 14 } }, children),
          footer ? h('div', { style: { padding: '12px 20px 16px', borderTop: `1px solid ${C.border1}`, background: C.base } }, footer) : null,
        ),
      );
      return ReactDOM && typeof ReactDOM.createPortal === 'function' && typeof document !== 'undefined' ? ReactDOM.createPortal(node, document.body) : node;
    }

    // --- dictionaries -------------------------------------------------------------------

    const DICTIONARY = {
      en: {
        title: 'Images',
        count: '{n} images',
        spent: 'spent {amount}',
        settings: 'Settings',
        settingsTitle: 'Image generation',
        saved: 'Settings saved. The next picture uses them.',
        secProvider: 'Connection',
        secModel: 'Model',
        secBilling: 'Billing',
        provider: 'Provider',
        providerSession: 'The session\'s provider ({name})',
        providerSessionNone: 'The session\'s provider',
        providerCustom: 'Custom base URL',
        baseURL: 'Base URL',
        baseURLHint: 'Leave empty to use the provider\'s own URL; the request goes to <base URL>/images/generations.',
        apiKey: 'API key',
        apiKeyHint: 'Stored in the Harness credential store on this machine, never shown again. Leave empty to keep using the provider\'s key.',
        keyStored: 'Saved {hint} — leave empty to keep it',
        keyFromProvider: 'Using the provider\'s key {hint} — enter one to override',
        keyNone: 'No key yet',
        keyWillClear: 'The saved key will be removed on save',
        clearKey: 'Remove saved key',
        probe: 'Test connection & list models',
        probing: 'Connecting…',
        probeOk: 'Connected: {n} models, {images} of them image models.',
        probeOkNoImages: 'Connected: {n} models, none of them listed as an image model — type the image model\'s id below; gateways often serve it without listing it.',
        probeFailed: 'Could not connect: {reason}',
        model: 'Image model',
        modelHint: 'As the provider names it, e.g. gpt-image-1.5. Type to search the list; test the connection to add the provider\'s models.',
        modelHintListed: 'Type to search the list, or enter any id the provider serves.',
        comboToggle: 'Show models',
        comboNoMatch: 'Nothing matches; the id as typed is used.',
        comboMore: '{n} more; keep typing to narrow it down.',
        groupUsed: 'Used before',
        groupProvider: 'From the provider',
        groupCatalog: 'In the {catalog} price list',
        tagImage: 'image',
        size: 'Default size',
        quality: 'Quality',
        auto: 'auto',
        default: 'default',
        pricePerImage: 'Price per image',
        currency: 'Currency',
        pricePerImageHint: 'Only used when the provider reports no usage and no price list knows the model (the built-in one was checked {date}).',
        priceProvider: 'The provider states {price} per image.',
        priceList: 'Built-in list for {family}: {samples} per image at this quality (as of {date}). Exact when the provider reports token usage.',
        priceManual: 'Unknown to the price lists; your price of {price} per image applies.',
        priceUnknown: 'Neither the provider, the built-in list nor the {catalog} price list knows it; set a price per image below, or costs stay blank.',
        priceUnknownOffline: 'Not in the built-in list, and the {catalog} price list could not be downloaded; set a price per image below, or costs stay blank.',
        priceCatalogTokens: 'The {catalog} price list has {name}: text in {textIn}, image out {imageOut} per million tokens, applied to the usage the provider reports.',
        priceCatalogFlat: 'The {catalog} price list has {name} at {price} per image.',
        priceNoUsageFlat: 'A reply without usage counts {price} per image.',
        priceNoUsageManual: 'A reply without usage counts your {price} per image.',
        priceNoUsageBlank: 'A reply without usage gets no cost.',
        catalogNear: '{name} (closest entry)',
        catalogStatus: '{catalog} price list: {n} image models, as of {date}.',
        catalogLoading: 'Downloading the {catalog} price list…',
        catalogFailed: 'Could not download the {catalog} price list: {reason}',
        catalogNotYet: 'The {catalog} price list is downloaded the first time a model needs it.',
        catalogRefresh: 'Update',
        catalogRetry: 'Download',
        statsTotal: '{n} images so far',
        statsNoCost: 'no cost recorded',
        cancel: 'Cancel',
        save: 'Save',
        toolTitle: 'Image',
        preparing: 'preparing…',
        generating: 'generating…',
        loading: 'loading…',
        failed: 'The image could not be generated.',
        noImage: 'No image came back.',
        frames: '{n} frames',
        fromInputs: 'from {n} input image(s)',
        gifUnverified: '{model} is not known to support GIF frames; the animation may not line up. gpt-image models are known to work.',
        gifModelHint: 'This model may not support GIF generation; gpt-image models are known to work.',
        zoomIn: 'Zoom in (+, wheel)',
        zoomOut: 'Zoom out (−, wheel)',
        zoomReset: 'Fit to screen (0)',
        enlarge: 'Enlarge',
        download: 'Download',
        more: 'More',
        copyPrompt: 'Copy prompt',
        delete: 'Remove from gallery',
        close: 'Close',
        next: 'Next',
        previous: 'Previous',
        viewer: 'Image viewer',
        openSession: 'Open conversation',
        openSessionTitled: 'Open the conversation it was drawn in: {title}',
        sessionArchived: 'The conversation this picture came from is archived. Unarchive it to open it.',
        sessionGone: 'The conversation this picture came from no longer exists.',
        unarchiveAndOpen: 'Unarchive and open',
        unarchiving: 'Unarchiving…',
        unarchiveFailed: 'Could not unarchive it; unarchive it from the sidebar instead.',
        refresh: 'Refresh',
        loadMore: 'Load more',
        empty: 'No images yet. Ask the model for a picture in any conversation — "draw me a poster for…" — and it appears here, newest first.',
        unavailable: 'The gallery is not reachable. Refresh the page, or check the plugin is enabled.',
        justNow: 'just now',
        minutesAgo: '{n} min ago',
        hoursAgo: '{n} h ago',
        daysAgo: '{n} d ago',
      },
      zh: {
        title: '图片',
        count: '{n} 张',
        spent: '累计 {amount}',
        settings: '设置',
        settingsTitle: '生图设置',
        saved: '已保存，下一张图开始生效。',
        secProvider: '连接',
        secModel: '模型',
        secBilling: '计费',
        provider: '供应商',
        providerSession: '跟随会话（{name}）',
        providerSessionNone: '跟随会话所用的供应商',
        providerCustom: '自定义地址',
        baseURL: '接口地址',
        baseURLHint: '留空则用供应商自己的地址；请求发往 <地址>/images/generations。',
        apiKey: 'API 密钥',
        apiKeyHint: '保存在本机的 Harness 凭据库里，不会再显示。留空则继续用供应商配置的密钥。',
        keyStored: '已保存 {hint}，留空保持不变',
        keyFromProvider: '使用供应商的密钥 {hint}，填写则覆盖',
        keyNone: '尚未设置',
        keyWillClear: '保存时将删除已保存的密钥',
        clearKey: '删除已保存的密钥',
        probe: '测试连接并拉取模型',
        probing: '连接中…',
        probeOk: '连接成功：{n} 个模型，其中 {images} 个是生图模型。',
        probeOkNoImages: '连接成功：{n} 个模型，列表里没有标为生图的；直接在下面填生图模型的 id 即可，网关常常不把它列出来。',
        probeFailed: '连不上：{reason}',
        model: '生图模型',
        modelHint: '按供应商的叫法填写，如 gpt-image-1.5。输入即可在列表里模糊搜索；测试连接后还会列出供应商的模型。',
        modelHintListed: '输入即可模糊搜索，也可以直接填供应商提供的任意模型 id。',
        comboToggle: '展开模型列表',
        comboNoMatch: '没有匹配项，按输入的 id 使用。',
        comboMore: '还有 {n} 个，继续输入以缩小范围。',
        groupUsed: '用过的',
        groupProvider: '供应商列出的',
        groupCatalog: '{catalog} 价目表收录的',
        tagImage: '生图',
        size: '默认尺寸',
        quality: '质量',
        auto: '自动',
        default: '默认',
        pricePerImage: '每张单价',
        currency: '币种',
        pricePerImageHint: '只在供应商不返回用量、且所有价目表都查不到这个模型时使用（内置价目表 {date} 核对）。',
        priceProvider: '供应商报价 {price} / 张。',
        priceList: '内置价目表 {family}：该质量下 {samples} / 张（{date}）。供应商返回用量时按用量精确计算。',
        priceManual: '价目表里都没有这个模型，按你填的 {price} / 张计。',
        priceUnknown: '供应商、内置价目表和 {catalog} 价目表都没有它的价格；在下面填一个单价，否则费用留空。',
        priceUnknownOffline: '内置价目表里没有它，{catalog} 价目表也没能下载；在下面填一个单价，否则费用留空。',
        priceCatalogTokens: '{catalog} 价目表收录了 {name}：文本输入 {textIn}、图片输出 {imageOut}（每百万 token），按供应商返回的用量计算。',
        priceCatalogFlat: '{catalog} 价目表收录了 {name}：每张 {price}。',
        priceNoUsageFlat: '回复里没有用量时按每张 {price} 计。',
        priceNoUsageManual: '回复里没有用量时按你填的 {price} / 张计。',
        priceNoUsageBlank: '回复里没有用量时费用留空。',
        catalogNear: '{name}（最接近的条目）',
        catalogStatus: '{catalog} 价目表：{n} 个生图模型，{date} 更新。',
        catalogLoading: '正在下载 {catalog} 价目表…',
        catalogFailed: '{catalog} 价目表下载失败：{reason}',
        catalogNotYet: '{catalog} 价目表在第一次需要时下载。',
        catalogRefresh: '更新',
        catalogRetry: '下载',
        statsTotal: '已生成 {n} 张',
        statsNoCost: '没有费用记录',
        cancel: '取消',
        save: '保存',
        toolTitle: '生图',
        preparing: '准备中…',
        generating: '生成中…',
        loading: '加载中…',
        failed: '这张图没有生成出来。',
        noImage: '没有返回图片。',
        frames: '{n} 帧',
        fromInputs: '基于 {n} 张参考图',
        gifUnverified: '{model} 不一定支持 GIF 素材生成，动图的帧可能对不齐。已知 GPT 系列生图模型（gpt-image-*）可以。',
        gifModelHint: '该模型不一定支持 GIF 素材生成；已知 GPT 系列生图模型（gpt-image-*）可以。',
        zoomIn: '放大（+ 或滚轮）',
        zoomOut: '缩小（− 或滚轮）',
        zoomReset: '适应屏幕（0）',
        enlarge: '放大',
        download: '下载',
        more: '更多',
        copyPrompt: '复制提示词',
        delete: '从图库移除',
        close: '关闭',
        next: '下一张',
        previous: '上一张',
        viewer: '图片查看',
        openSession: '打开所属会话',
        openSessionTitled: '打开画这张图的会话：{title}',
        sessionArchived: '这张图所属的会话已归档，取消归档后才能打开。',
        sessionGone: '这张图所属的会话已不存在。',
        unarchiveAndOpen: '取消归档并打开',
        unarchiving: '正在取消归档…',
        unarchiveFailed: '没能取消归档，请到侧边栏里手动取消。',
        refresh: '刷新',
        loadMore: '加载更多',
        empty: '还没有图片。在任何会话里让模型画一张——"给我画一张……的海报"——它就会出现在这里，最新的在前。',
        unavailable: '连不上图库。刷新页面，或确认插件已启用。',
        justNow: '刚刚',
        minutesAgo: '{n} 分钟前',
        hoursAgo: '{n} 小时前',
        daysAgo: '{n} 天前',
      },
    };

    /** The English dictionary, for a seat that brought no `t`. */
    function fallbackT(key, params) {
      const template = DICTIONARY.en[key] ?? key;
      if (!params) return template;
      return template.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? ''));
    }

    /**
     * Whether the conversation `id` can be opened, from the Harness's Session list
     * and Workspace snapshots, as `{state, archived}`: 'archived' when it, or the
     * session a subagent of it ran under, is archived (`archived` names which);
     * 'gone' when the list no longer has it; 'unknown' while either list is still
     * loading or missing; else 'available'.
     */
    function sessionState(id, sessions, workspaces) {
      if (!id || !sessions || !workspaces || workspaces.state === 'error') return { state: 'unknown' };
      if (sessions.phase === 'pending' || workspaces.phase === 'pending') return { state: 'unknown' };
      const archived = new Set(Array.isArray(workspaces.archivedSessionIds) ? workspaces.archivedSessionIds : []);
      const byId = sessions.byId && typeof sessions.byId === 'object' ? sessions.byId : {};
      // A subagent's own id is never archived; its parent's is.
      for (let at = id, hops = 0; at && hops < 16; hops += 1) {
        if (archived.has(at)) return { state: 'archived', archived: at };
        const row = byId[at];
        at = row?.origin === 'subagent' ? row.parentId : undefined;
      }
      const listed = (Array.isArray(sessions.ids) && sessions.ids.includes(id)) || byId[id] !== undefined;
      return { state: listed ? 'available' : 'gone' };
    }

    /** Show the Images panel in the main column; false where there is none. */
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
        ctx.effect(() => ctx.locale.register(NS, DICTIONARY), 'images: dictionaries');
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

        // The gallery's way back to a picture's conversation, through the sidebar's own
        // navigation. Read on use: a Harness without it shows no button.
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
          title: (id) => {
            const title = snapshot('sessions')?.byId?.[id]?.displayTitle;
            return typeof title === 'string' && title !== id ? title : undefined;
          },
          /** False when the Harness refused it (a session it does not know). */
          open: (id) => {
            try {
              service('uiWorkspace').openSession(id);
              return true;
            } catch {
              return false;
            }
          },
          canUnarchive: () => typeof service('uiWorkspace')?.unarchiveSession === 'function',
          /** Resolves once the archive set no longer has `id`, false when the Host refused. */
          unarchive: (id) =>
            Promise.resolve()
              .then(() => service('uiWorkspace').unarchiveSession(id))
              .then(
                () => true,
                () => false,
              ),
        };

        // The tool's own card in the conversation.
        ctx.slots.inject('tool.call.toolview', () =>
          ctx.slots.register({ name: 'tool.call.toolview', key: TOOL_NAME, locale: NS }, withT(GenerateImageView)),
        );
        // The picture as a row of the conversation, outside the turn's process fold.
        ctx.uiConversation.events.register(imagesResultDefinition);
        ctx.slots.inject('conversation.chat.node', () =>
          ctx.slots.register({ name: 'conversation.chat.node', key: RESULT_KIND, locale: NS }, withT(ImagesResultRow)),
        );
        // The gallery: an icon in the left sidebar's panel row, and the main panel it opens.
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 30, label: () => tr('title') }, ImagesGlyph),
        );
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, withT(ImagesPanel, { sessions })));
        // A bare `/images` opens the panel.
        if (typeof ctx.inject === 'function') {
          ctx.inject(['commandUi'], (scope) => {
            scope.effect(
              () =>
                scope.commandUi.decorate({
                  name: 'images',
                  available: () => typeof ctx.get?.('layout')?.selectPanel === 'function',
                  ui: { kind: 'action', run: () => void openPanel(ctx) },
                }),
              'images: /images opens the panel',
            );
          });
        }
      },
    };
  },
});

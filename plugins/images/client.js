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
    const ChevronIcon = ({ size = 20, dir = 1 }) => svg(size, [dir > 0 ? 'M9 5l7 7-7 7' : 'M15 5l-7 7 7 7']);
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
      return h(
        'figure',
        {
          'data-dsh-images-tile': item.id,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: { position: 'relative', margin: 0, breakInside: 'avoid', borderRadius: radius, overflow: 'hidden', background: C.layer2, border: `1px solid ${C.border1}` },
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
            style: { position: 'relative', display: 'block', cursor: 'zoom-in', aspectRatio: ratio, maxHeight, lineHeight: 0 },
          },
          h('img', {
            src: item.src,
            alt: item.prompt ?? '',
            loading: 'lazy',
            decoding: 'async',
            draggable: false,
            style: { display: 'block', width: '100%', height: maxHeight ? '100%' : 'auto', maxHeight, objectFit: 'cover' },
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

    function Lightbox({ t, items, index, onClose, onStep }) {
      const item = items[index];
      useEffect(() => {
        if (typeof document === 'undefined') return undefined;
        const key = (e) => {
          if (e.key === 'Escape') onClose();
          else if (e.key === 'ArrowRight' && index < items.length - 1) onStep(index + 1);
          else if (e.key === 'ArrowLeft' && index > 0) onStep(index - 1);
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
      const meta = [item.model, item.width && item.height ? `${item.width}×${item.height}` : null, item.createdAt ? fmtWhen(t, item.createdAt) : null]
        .filter(Boolean)
        .join(' · ');
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
          { style: { position: 'absolute', top: 14, right: 14, display: 'flex', gap: 8, zIndex: 1 } },
          h(IconButton, { key: 'dl', title: t('download'), dark: true, onClick: () => download(item) }, h(DownloadIcon, { size: 18 })),
          h(IconButton, { key: 'x', title: t('close'), dark: true, onClick: onClose }, h(CloseIcon, { size: 18 })),
        ),
        index > 0 ? nav(-1) : null,
        index < items.length - 1 ? nav(1) : null,
        h(
          'div',
          { style: { flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '56px 72px 12px' } },
          h('img', {
            src: item.src,
            alt: item.prompt ?? '',
            onClick: (e) => e.stopPropagation(),
            style: { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: 6, boxShadow: '0 12px 48px rgba(0,0,0,.5)', cursor: 'default' },
          }),
        ),
        h(
          'div',
          { onClick: (e) => e.stopPropagation(), style: { padding: '0 72px 22px', textAlign: 'center', fontSize: SMALL, lineHeight: 1.5 } },
          item.prompt ? h('div', { style: { maxWidth: 820, margin: '0 auto', color: 'rgba(255,255,255,.92)', userSelect: 'text' } }, item.prompt) : null,
          meta ? h('div', { style: { marginTop: 4, color: 'rgba(255,255,255,.55)' } }, `${meta}${items.length > 1 ? ` · ${index + 1} / ${items.length}` : ''}`) : null,
        ),
      );
      return ReactDOM && typeof ReactDOM.createPortal === 'function' && typeof document !== 'undefined' ? ReactDOM.createPortal(node, document.body) : node;
    }

    /** Lightbox state shared by a set of tiles: which one is open. */
    function useLightbox() {
      const [at, setAt] = useState(-1);
      return { at, open: (items, item) => setAt(items.indexOf(item)), close: () => setAt(-1), step: setAt };
    }

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
        out.push({
          id: ids[i] ?? ref?.attachmentId ?? `${block.callId}:${i}`,
          url: ids[i] ? fileUrl(ids[i]) : undefined,
          attachment: ref,
          mediaType: ref?.mediaType ?? 'image/png',
          width: ref?.width ?? 0,
          height: ref?.height ?? 0,
          prompt: typeof meta.prompt === 'string' ? meta.prompt : undefined,
          model: typeof meta.model === 'string' ? meta.model : undefined,
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
        settled && !block.isError && shown[0]?.model ? h('span', { style: { color: C.faint, flex: 'none' } }, shown[0].model) : null,
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
              { key: img.id, style: { width: shown.length > 1 ? 'min(260px, 100%)' : 'min(420px, 100%)' } },
              h(Tile, { t, item: img, onOpen: (item) => box.open(shown, item), maxHeight: 420 }),
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
            { key: img.id, style: { width: shown.length > 1 ? 'min(260px, 100%)' : 'min(480px, 100%)' } },
            h(Tile, { t, item: img, onOpen: (item) => box.open(shown, item), maxHeight: 480 }),
          ),
        ),
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
        h('span', { style: { fontSize: SMALL, color: C.faint } }, total > 0 ? t('count', { n: total }) : ''),
        h('span', { style: { flex: 1 } }),
        h(
          'button',
          {
            type: 'button',
            onClick: refresh,
            style: { font: 'inherit', fontSize: SMALL, color: C.muted, background: C.layer2, border: `1px solid ${C.border1}`, borderRadius: 9, padding: '5px 12px', cursor: 'pointer' },
          },
          t('refresh'),
        ),
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
                  h('div', { style: { marginTop: 3, color: C.faint, fontSize: 11.5, display: 'flex', gap: 6, flexWrap: 'wrap' } }, [item.model, item.width && item.height ? `${item.width}×${item.height}` : null, item.createdAt ? fmtWhen(t, item.createdAt) : null].filter(Boolean).join(' · ')),
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
          style: { height: '100%', width: '100%', overflowY: 'auto', background: C.base, color: C.primary, fontSize: FONT, boxSizing: 'border-box' },
        },
        header,
        body,
        box.at >= 0 && items ? h(Lightbox, { t, items, index: box.at, onClose: box.close, onStep: box.step }) : null,
      );
    }

    // --- dictionaries -------------------------------------------------------------------

    const DICTIONARY = {
      en: {
        title: 'Images',
        count: '{n} images',
        toolTitle: 'Image',
        preparing: 'preparing…',
        generating: 'generating…',
        loading: 'loading…',
        failed: 'The image could not be generated.',
        noImage: 'No image came back.',
        enlarge: 'Enlarge',
        download: 'Download',
        more: 'More',
        copyPrompt: 'Copy prompt',
        delete: 'Remove from gallery',
        close: 'Close',
        next: 'Next',
        previous: 'Previous',
        viewer: 'Image viewer',
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
        toolTitle: '生图',
        preparing: '准备中…',
        generating: '生成中…',
        loading: '加载中…',
        failed: '这张图没有生成出来。',
        noImage: '没有返回图片。',
        enlarge: '放大',
        download: '下载',
        more: '更多',
        copyPrompt: '复制提示词',
        delete: '从图库移除',
        close: '关闭',
        next: '下一张',
        previous: '上一张',
        viewer: '图片查看',
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
        const withT = (Component) => (props) => h(Component, { ...props, t: typeof props.t === 'function' ? props.t : tr });

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
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, withT(ImagesPanel)));
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

/**
 * Host half of the prompt-en bundle.
 *
 * Watches the human's prompts in every live Session, asks the model once for the
 * English of a prompt written in another language (or for a review of one written
 * in English), and answers the loopback JSON routes the Client half reads. What the
 * English teaches goes into a vocabulary book (`/vocab`). Nothing it computes is
 * ever sent to the conversation's model, and nothing is appended to the Session log.
 *
 * @module @local/dsh-prompt-en
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { createBook } from './lib/book.mjs';
import {
  REVIEW_SYSTEM,
  SYSTEM,
  buildReview,
  buildTranslate,
  classify,
  clean,
  markChanges,
  parseReview,
  withLabels,
} from './lib/prompt.mjs';
import { EMPTY, collect, dueText, importPast, importedText, listText, pick } from './lib/vocab.mjs';

/** The web server is the whole point of this half; without it the fiber stays pending. */
export const inject = ['webServer'];

/** The routes the Client half reads; exact-path match. */
const STATE_ROUTE = '/__dsh_prompt_en/state';
const ANSWER_ROUTE = '/__dsh_prompt_en/answer';
const DEBUG_ROUTE = '/__dsh_prompt_en/debug';
const VOCAB_ROUTE = '/__dsh_prompt_en/vocab';
const VOCAB_LIST_ROUTE = '/__dsh_prompt_en/vocab/list';
const VOCAB_GRADE_ROUTE = '/__dsh_prompt_en/vocab/grade';
const VOCAB_DROP_ROUTE = '/__dsh_prompt_en/vocab/drop';
const VOCAB_IMPORT_ROUTE = '/__dsh_prompt_en/vocab/import';
const VOCAB_NOTICE_ROUTE = '/__dsh_prompt_en/vocab/notice';

/** A hung model call must not hold a row in `translating…` forever. */
const REQUEST_TIMEOUT_MS = 60_000;
/** Requests in flight at once; a burst of prompts queues. */
const MAX_IN_FLIGHT = 2;
/** Answers kept in the cache file, newest last. */
const KEEP = 800;
/** A notice older than this is not shown to a page that loads later. */
const NOTICE_TTL_MS = 2 * 60_000;
/** Cards `/vocab/list` returns at most. */
const LIST_MAX = 50;

/**
 * Normalize the Loader row's config.
 * @param {unknown} config - the row's `config` mapping.
 * @returns {{enabled: boolean, reviewEnglish: boolean, collectVocab: boolean, provider: string, model: string, reasoningEffort: string}}
 */
export function settingsOf(config) {
  const c = config && typeof config === 'object' ? config : {};
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  return {
    enabled: c.enabled !== false,
    reviewEnglish: c.reviewEnglish !== false,
    collectVocab: c.collectVocab !== false,
    provider: str(c.provider),
    model: str(c.model),
    reasoningEffort: str(c.reasoningEffort),
  };
}

/** The DSH home the cache file lives under. */
function homeDir() {
  return process.env.DSH_HOME && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh');
}

/** Plain text of one user message; pasted files and images stay out. */
export function textOf(message) {
  if (!message || message.role !== 'user' || !Array.isArray(message.content)) return '';
  return message.content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

/**
 * Read the cache file; a missing or unreadable file is an empty cache.
 * @param {string} file
 * @returns {{order: string[], items: Record<string, object>}}
 */
function loadCache(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed && Array.isArray(parsed.order) && parsed.items && typeof parsed.items === 'object') return parsed;
  } catch {
    // A cold cache is the normal first run.
  }
  return { order: [], items: {} };
}

/**
 * The provider and model a request goes to: the configured pair, else the
 * session's own, else the profile's default.
 * @param ctx - plugin context.
 * @param {object} settings
 * @param {string} [sessionId]
 * @returns {{provider: string, model: string}}
 */
function modelFor(ctx, settings, sessionId) {
  let header;
  try {
    header = sessionId ? ctx.get('sessions')?.get(sessionId)?.requestHeader?.() : undefined;
  } catch {
    header = undefined;
  }
  const fallback = ctx.get('agentDefaultModel')?.currentSelection?.();
  return {
    provider: settings.provider || header?.config?.provider || fallback?.provider || '',
    model: settings.model || header?.config?.model || fallback?.model || '',
  };
}

/**
 * One model request, read to its end. A provider can end a stream with no text
 * at all (an intermittent empty completion); one silent retry costs a request
 * and saves the answer.
 * @param ctx - plugin context.
 * @param {object} store - holds the live controllers, so unload and `/prompt-en off` abort them.
 * @param {object} settings
 * @param {{provider: string, model: string, system: string, prompt: string, maxTokens: number}} request
 * @returns {Promise<{raw: string, failure: string, detail: object}>}
 */
async function complete(ctx, store, settings, request) {
  const llm = ctx.get('llm');
  if (request.provider === '' || request.model === '' || llm === undefined) {
    return { raw: '', failure: 'no-model', detail: {} };
  }
  let raw = '';
  let failure = '';
  let detail = {};
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    store.live.add(controller);
    let delta = '';
    let blockText = '';
    let reasoning = 0;
    let blockCount = 0;
    let finishKind = '';
    failure = '';
    try {
      const stream = llm.stream({
        provider: request.provider,
        model: request.model,
        system: request.system,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text:
                  attempt === 0
                    ? request.prompt
                    : `${request.prompt}\n\n(Your previous reply was empty. Reply with the requested text only, and do not think out loud.)`,
              },
            ],
          },
        ],
        maxTokens: request.maxTokens,
        ...(settings.reasoningEffort ? { reasoningEffort: settings.reasoningEffort } : {}),
        signal: controller.signal,
      });
      for await (const chunk of stream) {
        if (chunk.type === 'text-delta') delta += chunk.text;
        else if (chunk.type === 'reasoning-delta') reasoning += chunk.text.length;
        else if (chunk.type === 'block-end') {
          blockCount += 1;
          if (chunk.block?.type === 'text') blockText += chunk.block.text;
        } else if (chunk.type === 'finish') {
          const reason = chunk.reason;
          finishKind = reason?.kind ?? '';
          if (reason?.kind === 'error') failure = reason.failure?.code || reason.failure?.message || 'error';
          else if (reason?.kind === 'aborted') failure = 'aborted';
        }
      }
    } catch (error) {
      failure = controller.signal.aborted ? 'timeout' : error?.code || error?.message || 'request-failed';
    } finally {
      clearTimeout(timer);
      store.live.delete(controller);
    }
    // Some adapters deliver the whole block once instead of as deltas.
    raw = delta !== '' ? delta : blockText;
    detail = { finish: finishKind, deltas: delta.length, blocks: blockText.length, blockCount, reasoning };
    if (failure !== '' || raw !== '') break;
  }
  return { raw, failure, detail };
}

/**
 * Load one prompt's answer: cache, dedupe by text, one model call, store.
 * @param ctx - plugin context.
 * @param {object} store - the cache plus write queue.
 * @param {object} settings
 * @param {{sessionId: string, seq: number, key: string, text: string, mode: 'translate'|'review'}} job
 * @returns {Promise<object>} the item the Client draws.
 */
async function answer(ctx, store, settings, job) {
  const id = `${job.sessionId}:${job.seq}`;
  const shared = store.byText.get(job.key);
  if (shared && (shared.status === 'done' || shared.status === 'pending')) {
    const copy = { ...shared, seq: job.seq, messageId: job.messageId };
    remember(store, id, copy);
    return copy;
  }
  const existing = store.items[id];
  if (existing && (existing.status === 'done' || existing.status === 'pending')) return existing;

  const { provider, model } = modelFor(ctx, settings, job.sessionId);
  if (provider === '' || model === '' || ctx.get('llm') === undefined) {
    const item = failed(job, 'no-model');
    remember(store, id, item);
    return item;
  }

  const asked = job.mode === 'translate' ? buildTranslate(job.prepared) : buildReview(job.prepared);
  const pending = {
    seq: job.seq,
    messageId: job.messageId,
    key: job.key,
    status: 'pending',
    kind: job.mode,
    text: '',
    isCondensed: asked.isCondensed,
    sourceChars: job.text.length,
    startedAt: Date.now(),
  };
  remember(store, id, pending);
  store.byText.set(job.key, pending);

  const meta = { kind: job.mode, isCondensed: asked.isCondensed, sourceChars: job.text.length };
  const { raw, failure, detail } = await complete(ctx, store, settings, {
    provider,
    model,
    system: job.mode === 'translate' ? SYSTEM : REVIEW_SYSTEM,
    prompt: asked.prompt,
    maxTokens: asked.maxTokens,
  });

  if (failure !== '') {
    const item = failed(job, failure, detail);
    remember(store, id, item);
    if (store.byText.get(job.key) === pending) store.byText.delete(job.key);
    return item;
  }

  if (job.mode === 'translate') {
    const english = clean(raw, job.prepared.materials);
    if (english === '') {
      const item = failed(job, 'empty-reply', detail);
      remember(store, id, item);
      if (store.byText.get(job.key) === pending) store.byText.delete(job.key);
      return item;
    }
    const item = { seq: job.seq, messageId: job.messageId, key: job.key, status: 'done', text: english, ...meta };
    remember(store, id, item);
    store.byText.set(job.key, item);
    store.onAnswered?.(job, item, { provider, model });
    return item;
  }

  const review = parseReview(raw, job.prepared);
  if (review === null) {
    const item = failed(job, 'unreadable-reply', detail);
    remember(store, id, item);
    if (store.byText.get(job.key) === pending) store.byText.delete(job.key);
    return item;
  }
  const item = {
    seq: job.seq,
    messageId: job.messageId,
    key: job.key,
    status: 'done',
    ...meta,
    ...review,
    // The Client draws the changed words without shipping the diff algorithm.
    ...(review.text ? { runs: markChanges(review.base ?? '', review.text) } : {}),
  };
  remember(store, id, item);
  store.byText.set(job.key, item);
  store.onAnswered?.(job, item, { provider, model });
  return item;
}

/**
 * @param {{seq: number, messageId?: string, key: string, text: string, mode: string}} job
 * @param {string} reason
 * @returns {object}
 */
function failed(job, reason, detail) {
  return {
    seq: job.seq,
    messageId: job.messageId,
    key: job.key,
    status: 'failed',
    kind: job.mode,
    text: '',
    reason,
    ...(detail === undefined ? {} : { detail }),
    sourceChars: job.text.length,
  };
}

/**
 * Put one item in the live map and in the durable order, trimming the oldest.
 * @param {object} store
 * @param {string} id - `${sessionId}:${seq}`.
 * @param {object} item
 */
function remember(store, id, item) {
  store.items[id] = item;
  const at = store.order.indexOf(id);
  if (at !== -1) store.order.splice(at, 1);
  store.order.push(id);
  while (store.order.length > KEEP) {
    const old = store.order.shift();
    if (old !== undefined) delete store.items[old];
  }
  store.save();
}

/**
 * Coalesce cache writes: at most one write per macrotask, never overlapping.
 * @param {string} file
 * @param {object} store
 */
function scheduleSave(file, store) {
  if (store.saveTimer !== null) return;
  store.saveTimer = setTimeout(() => {
    store.saveTimer = null;
    const body = JSON.stringify({ order: store.order, items: store.items });
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, body, 'utf8');
    } catch {
      // A failed cache write must not break a translation.
    }
  }, 250);
}

/**
 * Answer one state read: cached items for a live or restored session.
 * @param ctx - plugin context.
 * @param {object} store
 * @param {object} settings
 * @param {string} sessionId
 * @returns {{enabled: boolean, items: object[]}}
 */
function stateOf(ctx, store, settings, sessionId) {
  const items = [];
  const prefix = `${sessionId}:`;
  for (const id of store.order) {
    if (!id.startsWith(prefix)) continue;
    const item = store.items[id];
    if (item) items.push(item);
  }
  // A resumed Session may have prompts whose answer predates this process.
  if (items.length === 0) {
    const session = ctx.get('sessions')?.get(sessionId);
    for (const event of session?.snapshotEvents?.() ?? []) {
      if (event.type !== 'user/message') continue;
      const text = textOf(event.data);
      if (text === '') continue;
      const cached = store.byText.get(keyOfText(text));
      if (cached?.status === 'done') {
        items.push({ ...cached, seq: event.seq, messageId: event.data?.id, restored: true });
      }
    }
  }
  return { enabled: settings.enabled, items };
}

/** The text key used to dedupe one prompt across sessions. */
function keyOfText(text) {
  return classify(text)?.key ?? '';
}

/**
 * Register the routes and the Session feed on this plugin's fiber.
 * @param ctx - plugin context.
 * @param {unknown} config - the Loader row's config.
 */
export function apply(ctx, config) {
  const settings = settingsOf(config);
  const dir = join(homeDir(), 'cache', 'prompt-en');
  const file = join(dir, 'cache.json');
  const enabledFile = join(dir, 'enabled.json');
  const runtime = { enabled: settings.enabled };
  try {
    const saved = JSON.parse(readFileSync(enabledFile, 'utf8'));
    if (typeof saved?.enabled === 'boolean') runtime.enabled = saved.enabled;
  } catch {
    // No saved toggle yet.
  }
  const cache = loadCache(file);
  // A `pending` row left by a crash is no longer in flight.
  for (const item of Object.values(cache.items)) {
    if (item && item.status === 'pending') {
      item.status = 'failed';
      item.reason = 'interrupted';
    }
  }
  const store = {
    items: cache.items,
    order: cache.order,
    byText: new Map(),
    live: new Set(),
    saveTimer: null,
    save: () => scheduleSave(file, store),
  };
  for (const id of [...store.order].reverse()) {
    const item = store.items[id];
    if (item?.status === 'done' && item.key) store.byText.set(item.key, item);
  }

  // --- the vocabulary book ---------------------------------------------------

  const book = createBook(join(dir, 'vocab.json'));
  const vocab = { importing: null, notices: [], noticeSeq: 0 };

  /** A transient line the Client half shows as a toast (import done, cards due). */
  function notice(text) {
    vocab.noticeSeq += 1;
    vocab.notices.push({ id: vocab.noticeSeq, text, at: Date.now() });
    if (vocab.notices.length > 5) vocab.notices.shift();
  }

  /** One model request for the book; null when it got no answer. */
  const askWith = (target) => async (request) => {
    const r = await complete(ctx, store, settings, { ...target, ...request });
    return r.failure === '' && r.raw !== '' ? r.raw : null;
  };

  // A new answer files what it teaches; it runs beside the queue, not in it, so
  // the next prompt's English is not held up by the pick.
  store.onAnswered = (job, item, target) => {
    if (!settings.collectVocab) return;
    void collect({
      book,
      key: job.key,
      item,
      source: withLabels(job.prepared.prose, job.prepared.materials),
      weight: job.prepared.proseWeight,
      ask: askWith(target),
      now: Date.now(),
    }).catch(() => {});
  };

  /** The text of the prompt cached under `id` (`<session>:<seq>`), '' when gone. */
  async function readPrompt(id) {
    const at = id.lastIndexOf(':');
    const sessionId = id.slice(0, at);
    const seq = Number(id.slice(at + 1));
    if (at <= 0 || !Number.isInteger(seq)) return '';
    let event;
    try {
      event = ctx.get('sessions')?.get(sessionId)?.eventAt?.(seq);
    } catch {
      event = undefined;
    }
    if (event === undefined) event = (await ctx.get('sessionQuery')?.readEvent?.({ sessionId, seq }))?.target;
    return event?.type === 'user/message' ? textOf(event.data) : '';
  }

  /** Start filing the prompts answered before the book; false when one is running. */
  function startImport() {
    if (vocab.importing !== null) return false;
    vocab.importing = { done: 0, total: 0 };
    // Grouped by session, so each session's log is read once.
    const answers = store.order
      .map((id) => ({ id, item: store.items[id] }))
      .sort((a, b) => a.id.slice(0, a.id.lastIndexOf(':')).localeCompare(b.id.slice(0, b.id.lastIndexOf(':'))));
    importPast({
      book,
      answers,
      readPrompt,
      ask: askWith(modelFor(ctx, settings)),
      now: Date.now,
      onProgress: (done, total) => {
        vocab.importing = { done, total };
      },
    })
      .then((r) => notice(importedText(r)))
      .catch(() => notice('生词本导入失败，可以再试一次 /vocab import'))
      .finally(() => {
        vocab.importing = null;
      });
    return true;
  }

  const queue = [];
  let inFlight = 0;
  const debug = [];
  // Read-only diagnostics: a climbing count proves the Client row mounts and polls.
  const hits = { count: 0, at: 0 };

  /**
   * Run the queued prompts, at most MAX_IN_FLIGHT at a time.
   * @param {object} job
   */
  function enqueue(job) {
    queue.push(job);
    pump();
  }

  function pump() {
    while (inFlight < MAX_IN_FLIGHT && queue.length > 0) {
      const job = queue.shift();
      if (!job) return;
      inFlight += 1;
      answer(ctx, store, settings, job)
        .catch(() => {})
        .finally(() => {
          inFlight -= 1;
          pump();
        });
    }
  }

  ctx.effect(() =>
    ctx.on('session/event', (session, event) => {
      if (!runtime.enabled || event.type !== 'user/message') return;
      // A replacement copy is model-only history, not a new prompt.
      if (event.surfaceOp !== 'append') return;
      // A delegated child did not type anything; the person wrote in the root.
      if (session.header?.origin === 'subagent' || (session.header?.delegationDepth ?? 0) > 0) return;
      const message = event.data;
      if (!message || message.role !== 'user' || message.source?.kind !== 'user') return;
      const text = textOf(message);
      if (text === '' || text.startsWith('/')) return;
      const said = classify(text);
      if (said === null) return;
      if (said.mode === 'review' && !settings.reviewEnglish) return;
      enqueue({
        sessionId: String(session.id),
        seq: event.seq,
        messageId: message.id,
        key: said.key,
        text,
        mode: said.mode,
        prepared: said.prepared,
      });
    }),
  );

  const commands = ctx.get('commands');
  if (commands !== undefined) {
    ctx.effect(() =>
      commands.register({
        name: 'prompt-en',
        description: 'Turn the English under your prompts on or off',
        input: { hint: '[on|off]' },
        handler: (invocation) => {
          const arg = String(invocation.rawInput ?? '').trim().toLowerCase();
          const wanted = arg === 'on' ? true : arg === 'off' ? false : !runtime.enabled;
          runtime.enabled = wanted;
          try {
            mkdirSync(dir, { recursive: true });
            writeFileSync(enabledFile, JSON.stringify({ enabled: wanted }), 'utf8');
          } catch {
            // The toggle still applies to this process.
          }
          if (!wanted) {
            for (const controller of store.live) controller.abort();
          }
          return {
            kind: 'success',
            text: wanted
              ? 'prompt-en is on: prompts in another language get their English underneath, and prompts in English a review.'
              : 'prompt-en is off.',
          };
        },
      }),
    );
    // A bare `/vocab` opens the review tab in the browser (the Client half's
    // decoration); the host answers `/vocab list` and `/vocab import`.
    ctx.effect(() =>
      commands.register({
        name: 'vocab',
        description: 'Review the English prompt-en taught you, flashcard style (list: the latest cards; import: the prompts from before)',
        input: { hint: '[list|import]' },
        handler: (invocation) => {
          const arg = String(invocation.rawInput ?? '').trim().toLowerCase();
          const now = Date.now();
          if (arg === 'list' || arg === 'ls') return { kind: 'success', text: listText(book.cards(), now) };
          if (arg === 'import') {
            const started = startImport();
            return {
              kind: 'success',
              text: started
                ? '生词本：开始导入以前的纠错和翻译，在后台进行，完成后会提示。'
                : '生词本：正在导入，完成后会提示。',
            };
          }
          if (book.size() === 0) return { kind: 'success', text: EMPTY };
          const due = pick(book.cards(), now).length;
          return {
            kind: 'success',
            text: `${due ? `生词本：${due} 张待复习。` : '生词本：今天没有到期的。'}在右侧栏打开「生词本」开始复习。`,
          };
        },
      }),
    );
  }

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: STATE_ROUTE,
      handler: (req, res) => {
        serveJson(res, () => {
          const url = new URL(req.url ?? '/', 'http://localhost');
          const sessionId = url.searchParams.get('session') ?? '';
          hits.count += 1;
          hits.at = Date.now();
          if (sessionId === '') return { enabled: runtime.enabled, items: [], hits };
          return { ...stateOf(ctx, store, { ...settings, enabled: runtime.enabled }, sessionId), hits };
        });
      },
    }),
  );

  // Client-side placement diagnostics: the row reports what it actually rendered.
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: DEBUG_ROUTE,
      handler: (req, res) => {
        if (req.method === 'GET') {
          serveJson(res, () => debug);
          return;
        }
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
            debug.push({ at: Date.now(), ...body });
            if (debug.length > 60) debug.shift();
          } catch {
            // Ignore a malformed beacon.
          }
          serveJson(res, () => ({ ok: true }));
        });
      },
    }),
  );

  // One explicit ask for an older prompt (a resumed Session, or a retry).
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: ANSWER_ROUTE,
      handler: (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end();
          return;
        }
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
          serveJson(res, async () => {
            let body;
            try {
              body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
            } catch {
              return { ok: false, reason: 'bad-request' };
            }
            const sessionId = String(body.session ?? '');
            const seq = Number(body.seq);
            const session = ctx.get('sessions')?.get(sessionId);
            const event = session?.eventAt?.(seq);
            if (!event || event.type !== 'user/message') return { ok: false, reason: 'no-message' };
            const text = textOf(event.data);
            const said = classify(text);
            if (said === null) return { ok: false, reason: 'not-eligible' };
            const item = await answer(ctx, store, settings, {
              sessionId,
              seq,
              messageId: event.data?.id,
              key: said.key,
              text,
              mode: said.mode,
              prepared: said.prepared,
            });
            return { ok: true, item };
          });
        });
      },
    }),
  );

  // --- the vocabulary book's routes -------------------------------------------

  /** The cards a sitting starts with; `ahead` takes the soonest due when none is. */
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: VOCAB_ROUTE,
      handler: (req, res) => {
        serveJson(res, () => {
          const url = new URL(req.url ?? '/', 'http://localhost');
          const now = Date.now();
          const cards = book.cards();
          const later = cards.filter((c) => c.due > now).map((c) => c.due);
          return {
            deckSize: cards.length,
            cards: pick(cards, now, url.searchParams.get('ahead') === '1'),
            ...(later.length ? { nextDue: Math.min(...later) } : {}),
            importing: vocab.importing,
            collect: settings.collectVocab,
            now,
          };
        });
      },
    }),
  );

  /** The latest cards and how well each is known. */
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: VOCAB_LIST_ROUTE,
      handler: (_req, res) => {
        serveJson(res, () => {
          const now = Date.now();
          const cards = book.cards();
          return {
            deckSize: cards.length,
            due: cards.filter((c) => c.due <= now).length,
            cards: [...cards].sort((a, b) => b.addedAt - a.addedAt).slice(0, LIST_MAX),
            importing: vocab.importing,
            now,
          };
        });
      },
    }),
  );

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: VOCAB_GRADE_ROUTE,
      handler: (req, res) => {
        postJson(req, res, (body) => {
          const grade = body.grade;
          if (grade !== 'again' && grade !== 'hard' && grade !== 'good') return { ok: false, reason: 'bad-grade' };
          const card = book.grade(String(body.id ?? ''), grade, Date.now());
          return card === null ? { ok: false, reason: 'no-card' } : { ok: true, card };
        });
      },
    }),
  );

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: VOCAB_DROP_ROUTE,
      handler: (req, res) => {
        postJson(req, res, (body) => ({ ok: book.drop(String(body.id ?? '')) }));
      },
    }),
  );

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: VOCAB_IMPORT_ROUTE,
      handler: (req, res) => {
        postJson(req, res, () => ({ ok: true, started: startImport(), importing: vocab.importing }));
      },
    }),
  );

  /** Notices newer than `after`, and the reminder that cards are due when it is time. */
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: VOCAB_NOTICE_ROUTE,
      handler: (req, res) => {
        serveJson(res, () => {
          const url = new URL(req.url ?? '/', 'http://localhost');
          const after = Number(url.searchParams.get('after') ?? 0) || 0;
          const now = Date.now();
          if (settings.collectVocab || book.size() > 0) {
            const due = book.takeNudge(now);
            if (due > 0) notice(dueText(due));
          }
          return {
            notices: vocab.notices.filter((n) => n.id > after && now - n.at < NOTICE_TTL_MS).map(({ id, text }) => ({ id, text })),
            latest: vocab.noticeSeq,
            importing: vocab.importing,
          };
        });
      },
    }),
  );

  // Unload aborts in-flight calls and flushes the cache once.
  ctx.effect(() => () => {
    for (const controller of store.live) controller.abort();
    store.live.clear();
    if (store.saveTimer !== null) {
      clearTimeout(store.saveTimer);
      store.saveTimer = null;
    }
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({ order: store.order, items: store.items }), 'utf8');
    } catch {
      // Unload must not throw on a cache write.
    }
    book.flush();
  });
}

/**
 * Answer one state-changing request. Only a JSON POST is taken: a cross-site page
 * cannot send one without a CORS preflight, which these routes never grant.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {(body: Record<string, unknown>) => unknown | Promise<unknown>} produce
 */
function postJson(req, res, produce) {
  const type = String(req.headers?.['content-type'] ?? '');
  if (req.method !== 'POST' || !/^application\/json\b/i.test(type)) {
    res.statusCode = req.method === 'POST' ? 415 : 405;
    res.end();
    return;
  }
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    serveJson(res, () => {
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        return { ok: false, reason: 'bad-request' };
      }
      return produce(body && typeof body === 'object' ? body : {});
    });
  });
}

/**
 * Answer one request as JSON; a thrown handler becomes a stable error body.
 * @param {import('node:http').ServerResponse} res
 * @param {() => unknown | Promise<unknown>} produce
 */
function serveJson(res, produce) {
  Promise.resolve()
    .then(produce)
    .then((body) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      res.end(JSON.stringify(body));
    })
    .catch((error) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ ok: false, reason: error?.message ?? 'error' }));
    });
}

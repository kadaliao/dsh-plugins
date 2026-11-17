/**
 * Telegram transport for chat channels, over the Bot API with `fetch` only:
 * `getMe`, long-polling `getUpdates`, `sendMessage` and `sendChatAction`.
 *
 * Transport only: it knows nothing about bots, pairing or the store
 * (lib/channels.mjs decides what a message means). It never puts the token in
 * a log line, an error or a status; the token is part of every request URL,
 * so every text that could carry it is redacted.
 *
 * `apiBase` defaults to `BOTS_TELEGRAM_API` or https://api.telegram.org, so a
 * local stand-in of the Bot API can be used for testing.
 *
 * Threads: `threadId` on a message is its forum topic (`message_thread_id`),
 * reported only for topic messages (`is_topic_message`: a topic of a forum
 * supergroup, or of a private chat with topics turned on). The General topic,
 * plain groups and private chats have none, and a reply chain is not a thread
 * in Telegram. `send(…, {threadId})` and `typing(…, {threadId})` post into
 * that topic (`message_thread_id`); with `replyTo` as well, the first part
 * quotes that message inside the topic. A topic that is gone gets the reply
 * in the chat instead.
 *
 * @module @kadaliao/dsh-bots/lib/channels/telegram
 */

import { redact, splitText } from '../channels.mjs';

export const kind = 'telegram';
export const TEXT_LIMIT = 4096;

const DEFAULT_API = 'https://api.telegram.org';
/** Seconds one getUpdates call waits for news. */
const POLL_TIMEOUT_S = 40;
const CONFLICT_RETRY_MS = 30_000;
const MAX_BACKOFF_MS = 60_000;

const TOKEN_REJECTED = 'Telegram rejected the bot token (401 Unauthorized). Copy it again from @BotFather.';
const CONFLICT = 'Another program is using this bot token (Telegram answered 409 Conflict). Stop it, or create a separate bot with @BotFather for the team.';

/** What Telegram says when a message goes to a topic that no longer exists. */
const THREAD_GONE = /thread not found/i;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A topic id for `message_thread_id`, or null. */
const topicOf = (id) => (id != null && /^\d{1,15}$/.test(String(id)) && Number(id) > 0 ? Number(id) : null);

/**
 * @param {{
 *   token: string,
 *   onMessage: (msg: object) => void,
 *   onStatus?: (s: {state: 'connecting'|'connected'|'error'|'stopped', detail?: string, fatal?: boolean}) => void,
 *   fetchImpl?: typeof fetch,
 *   apiBase?: string,
 *   log?: (line: string) => void,
 *   pollTimeout?: number,                                  // seconds, for tests
 *   sleep?: (ms: number, signal: AbortSignal) => Promise<void>,  // for tests
 * }} opts
 */
export function createConnector(opts) {
  const secret = String(opts?.token ?? '').trim();
  const fetchImpl = opts?.fetchImpl ?? globalThis.fetch;
  const base = String(opts?.apiBase || process.env.BOTS_TELEGRAM_API || DEFAULT_API).replace(/\/+$/, '');
  const pollTimeout = Number.isFinite(opts?.pollTimeout) ? opts.pollTimeout : POLL_TIMEOUT_S;
  const onMessage = typeof opts?.onMessage === 'function' ? opts.onMessage : () => {};
  const clean = (s) => redact(String(s ?? ''), [secret]);
  const log = (line) => {
    try {
      opts?.log?.(clean(line));
    } catch {
      // Logging is a convenience.
    }
  };
  const halt = new AbortController();
  const sleep =
    opts?.sleep ??
    ((ms, signal) =>
      new Promise((resolve) => {
        if (signal.aborted) return resolve();
        const timer = setTimeout(done, ms);
        function done() {
          clearTimeout(timer);
          signal.removeEventListener('abort', done);
          resolve();
        }
        signal.addEventListener('abort', done, { once: true });
      }));
  const wait = (ms) => sleep(ms, halt.signal);

  let stopped = false;
  let stopping = null;
  let me = null;
  let offset = 0;
  let loop = null;
  let state = 'stopped';
  const status = (s) => {
    state = s.state;
    try {
      opts?.onStatus?.({ state: s.state, ...(s.detail ? { detail: clean(s.detail) } : {}), ...(s.fatal ? { fatal: true } : {}) });
    } catch {
      // The listener's problem.
    }
  };

  /** One Bot API call. Errors carry `code` (error_code or HTTP status) and `retryAfter`. */
  async function call(method, body, timeoutMs = 30_000, { afterStop = false } = {}) {
    const signal = afterStop ? AbortSignal.timeout(timeoutMs) : AbortSignal.any([halt.signal, AbortSignal.timeout(timeoutMs)]);
    let res;
    let json = null;
    try {
      res = await fetchImpl(`${base}/bot${secret}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
        signal,
      });
      try {
        json = await res.json();
      } catch {
        json = null;
      }
    } catch (error) {
      const why = error?.name === 'TimeoutError' || signal.reason?.name === 'TimeoutError' ? 'timed out' : error?.cause?.code ?? error?.cause?.message ?? error?.message ?? 'network error';
      const e = new Error(clean(`could not reach Telegram (${method}: ${why})`));
      e.network = true;
      throw e;
    }
    if (json && json.ok === true) return json.result;
    const description = clean(json?.description ?? `HTTP ${res.status}`);
    const e = new Error(`Telegram ${method}: ${description}`);
    e.code = Number(json?.error_code ?? res.status) || 0;
    e.description = description;
    if (json?.parameters?.retry_after !== undefined) e.retryAfter = Number(json.parameters.retry_after) || 1;
    throw e;
  }

  /** A call that waits out 429 Too Many Requests a few times. */
  async function polite(method, body) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await call(method, body);
      } catch (error) {
        if (error.code !== 429 || attempt >= 4 || stopped) throw error;
        await wait(Math.min(60, error.retryAfter ?? 1) * 1000);
      }
    }
  }

  const chatIdOf = (id) => (/^-?\d+$/.test(String(id)) ? Number(id) : String(id));

  /** A Bot API message as a channel message, or null when it is not for us. */
  function toMessage(m) {
    if (!m || typeof m !== 'object' || typeof m.text !== 'string' || m.text.trim() === '') return null;
    const from = m.from;
    if (!from || from.is_bot || String(from.id) === String(me?.id)) return null;
    const chat = m.chat ?? {};
    const isDirect = chat.type === 'private';
    const username = String(me?.username ?? '');
    const at = `@${username.toLowerCase()}`;
    const text = m.text;
    let mentioned = isDirect;
    for (const e of Array.isArray(m.entities) ? m.entities : []) {
      const part = text.slice(e.offset, e.offset + e.length).toLowerCase();
      if (username && e.type === 'mention' && part === at) mentioned = true;
      if (username && e.type === 'bot_command' && part.endsWith(at)) mentioned = true;
      if (e.type === 'text_mention' && String(e.user?.id) === String(me?.id)) mentioned = true;
    }
    if (me && String(m.reply_to_message?.from?.id ?? '') === String(me.id)) mentioned = true;
    const stripped = username ? text.replace(new RegExp(`@${escapeRe(username)}\\b`, 'gi'), '') : text;
    const body = stripped
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/ +([,，.。!?！？:：])/g, '$1')
      .replace(/^[ \t,，:：]+/, '')
      .trim();
    const name = [from.first_name, from.last_name].filter(Boolean).join(' ').trim() || (from.username ? `@${from.username}` : String(from.id));
    // Outside a topic, message_thread_id names a reply chain: not a thread here.
    const topic = m.is_topic_message === true && Number.isInteger(m.message_thread_id) ? String(m.message_thread_id) : '';
    return {
      chatId: String(chat.id),
      messageId: String(m.message_id),
      userId: String(from.id),
      userName: name,
      text: body,
      isDirect,
      mentioned,
      ...(isDirect ? {} : { chatTitle: String(chat.title ?? '') }),
      ...(topic ? { threadId: topic } : {}),
    };
  }

  async function poll() {
    let failures = 0;
    let webhookCleared = false;
    while (!stopped) {
      let updates;
      try {
        updates = await call('getUpdates', { offset, timeout: pollTimeout, allowed_updates: ['message'] }, (pollTimeout + 15) * 1000);
      } catch (error) {
        if (stopped) break;
        if (error.code === 401 || error.code === 404) {
          status({ state: 'error', detail: TOKEN_REJECTED, fatal: true });
          log(`telegram: ${error.message}; stopped polling`);
          break;
        }
        if (error.code === 409) {
          // A webhook set elsewhere blocks polling; this token now belongs to the team.
          if (/webhook/i.test(error.description ?? '') && !webhookCleared) {
            webhookCleared = true;
            try {
              await call('deleteWebhook', { drop_pending_updates: false });
              log('telegram: removed the webhook set for this bot so it can poll');
              continue;
            } catch (e) {
              log(`telegram: deleteWebhook: ${e.message}`);
            }
          }
          status({ state: 'error', detail: CONFLICT });
          await wait(CONFLICT_RETRY_MS);
          continue;
        }
        if (error.code === 429) {
          await wait(Math.min(60, error.retryAfter ?? 5) * 1000);
          continue;
        }
        failures += 1;
        const ms = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(failures - 1, 6));
        // One dropped poll is a blip (reconnecting); more in a row is an outage worth showing.
        status({ state: failures === 1 ? 'connecting' : 'error', detail: `${error.message}; retrying in ${Math.round(ms / 1000)} s` });
        log(`telegram: ${error.message}`);
        await wait(ms);
        continue;
      }
      if (stopped) break;
      if (failures > 0 || state !== 'connected') status({ state: 'connected' });
      failures = 0;
      for (const update of Array.isArray(updates) ? updates : []) {
        if (Number.isInteger(update?.update_id)) offset = Math.max(offset, update.update_id + 1);
        const msg = toMessage(update?.message);
        if (!msg) continue;
        try {
          onMessage(msg);
        } catch (error) {
          log(`telegram: a message handler failed: ${error?.message ?? error}`);
        }
      }
    }
  }

  return {
    /** Check the token with getMe, then poll in the background. */
    async start() {
      if (stopped) throw new Error('the connector was stopped');
      if (!secret) {
        status({ state: 'error', detail: 'no bot token', fatal: true });
        throw Object.assign(new Error('no bot token'), { fatal: true });
      }
      status({ state: 'connecting' });
      for (let attempt = 0; ; attempt += 1) {
        try {
          me = await call('getMe', {}, 20_000);
          break;
        } catch (error) {
          if (stopped) throw new Error('the connector was stopped');
          if (error.code === 401 || error.code === 404) {
            status({ state: 'error', detail: TOKEN_REJECTED, fatal: true });
            throw Object.assign(new Error(TOKEN_REJECTED), { fatal: true });
          }
          const ms = error.code === 429 ? Math.min(60, error.retryAfter ?? 5) * 1000 : Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(attempt, 6));
          status({ state: 'error', detail: `${error.message}; retrying in ${Math.round(ms / 1000)} s` });
          await wait(ms);
          if (stopped) throw new Error('the connector was stopped');
        }
      }
      status({ state: 'connected' });
      loop = poll().catch((error) => {
        if (!stopped) {
          status({ state: 'error', detail: error?.message ?? String(error) });
          log(`telegram: polling ended: ${error?.message ?? error}`);
        }
      });
      return { id: String(me?.id ?? ''), username: String(me?.username ?? ''), name: String(me?.first_name ?? me?.username ?? '') };
    },

    /**
     * Stop polling; idempotent, nothing reconnects afterwards. Telegram forgets
     * updates only when a later getUpdates confirms them, so the last batch is
     * confirmed on the way out (best effort): a restart does not get it again.
     */
    stop() {
      if (stopping) return stopping;
      stopped = true;
      halt.abort();
      stopping = Promise.resolve(loop)
        .catch(() => {})
        .then(() => (offset > 0 ? call('getUpdates', { offset, timeout: 0, limit: 1 }, 3000, { afterStop: true }).catch(() => {}) : undefined))
        .then(() => status({ state: 'stopped' }));
      return stopping;
    },

    /**
     * Send plain text, in parts of at most TEXT_LIMIT; the first part answers
     * `replyTo`. With `threadId` (a forum topic) every part goes to that topic.
     */
    async send(chatId, text, sendOpts = {}) {
      let first = true;
      let topic = topicOf(sendOpts?.threadId);
      for (const part of splitText(text, TEXT_LIMIT)) {
        const replyTo = first && sendOpts?.replyTo && /^\d+$/.test(String(sendOpts.replyTo)) ? Number(sendOpts.replyTo) : null;
        const body = {
          chat_id: chatIdOf(chatId),
          text: part,
          ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
        };
        try {
          await polite('sendMessage', topic ? { ...body, message_thread_id: topic } : body);
        } catch (error) {
          // The topic was deleted: the reply still reaches the chat.
          if (!topic || error.code !== 400 || !THREAD_GONE.test(error.description ?? '')) throw error;
          log(`telegram: topic ${topic} is gone; sending to the chat`);
          topic = null;
          await polite('sendMessage', body);
        }
        first = false;
      }
    },

    /** "typing…" in the chat (or its topic `threadId`) for about five seconds. */
    async typing(chatId, typingOpts = {}) {
      const topic = topicOf(typingOpts?.threadId);
      await call('sendChatAction', { chat_id: chatIdOf(chatId), ...(topic ? { message_thread_id: topic } : {}), action: 'typing' }, 10_000);
    },
  };
}

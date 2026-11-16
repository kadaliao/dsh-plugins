/**
 * Topics: a bot's conversation is one Harness Session at a time. Starting a
 * new topic gives the bot a fresh Session (its schedules move along, the old
 * one is archived) so the context does not grow without end; memory carries
 * what matters across. `topics.json` keeps, per bot, the current topic's
 * activity and a short history of the past ones.
 *
 * @module @kadaliao/dsh-bots/lib/topics
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const KEEP_HISTORY = 50;
/** A big conversation is only cut once it has been quiet this long (a teammate's answer may still be on its way). */
export const PRESSURE_QUIET_MS = 30 * 60_000;

/**
 * Why the current topic of a bot should end now, or ''.
 * @param {{tasks: number, lastActiveAt: number, lastPrompt: number}|undefined} topic
 * @param {{idleHours: number, maxContextK: number}} rules
 * @param {{now?: number, trigger?: 'user'|'dm'|'sweep'}} [at] - `dm`: a teammate's message (never cut for size: it may answer this bot's own question).
 */
export function rotationReason(topic, rules, { now = Date.now(), trigger = 'sweep' } = {}) {
  if (!topic || !(topic.tasks > 0)) return '';
  const quiet = now - (topic.lastActiveAt || now);
  if (rules.idleHours > 0 && quiet >= rules.idleHours * 3_600_000) return 'idle';
  if (rules.maxContextK > 0 && topic.lastPrompt >= rules.maxContextK * 1000) {
    if (trigger === 'user') return 'context';
    if (trigger === 'sweep' && quiet >= PRESSURE_QUIET_MS) return 'context';
  }
  return '';
}

/** The topics file under `dir`. */
export function createTopics(dir) {
  const file = join(dir, 'topics.json');
  let data = null;
  const load = () => {
    if (data) return data;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      data = raw && typeof raw === 'object' && raw.bots ? raw : { bots: {} };
    } catch {
      data = { bots: {} };
    }
    return data;
  };
  const save = () => {
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(`${file}.tmp`, JSON.stringify(data), 'utf8');
      renameSync(`${file}.tmp`, file);
    } catch {
      // Kept in memory.
    }
  };
  const rec = (botId) => (load().bots[botId] ??= { current: null, history: [] });
  return {
    /** The current topic of a bot, made when its Session is new to us. */
    current(botId, sessionId) {
      const r = rec(botId);
      if (sessionId && r.current?.sessionId !== sessionId) {
        r.current = { sessionId, startedAt: Date.now(), lastActiveAt: Date.now(), lastPrompt: 0, tasks: 0, titles: [] };
        save();
      }
      return r.current;
    },
    peek(botId) {
      return load().bots[botId]?.current ?? null;
    },
    /** A model call read `prompt` tokens. */
    noteCall(botId, sessionId, prompt) {
      const t = this.current(botId, sessionId);
      t.lastPrompt = prompt;
      t.lastActiveAt = Date.now();
    },
    /** A task finished in the topic. */
    noteTask(botId, sessionId, title) {
      const t = this.current(botId, sessionId);
      t.tasks += 1;
      t.lastActiveAt = Date.now();
      if (title) t.titles = [...(t.titles ?? []), String(title).slice(0, 80)].slice(-5);
      save();
    },
    /** The topic of `botId` ended for `reason`; the next one is `sessionId`. */
    rotate(botId, sessionId, reason) {
      const r = rec(botId);
      if (r.current) r.history = [...r.history, { ...r.current, endedAt: Date.now(), reason }].slice(-KEEP_HISTORY);
      r.current = sessionId ? { sessionId, startedAt: Date.now(), lastActiveAt: Date.now(), lastPrompt: 0, tasks: 0, titles: [] } : null;
      save();
      return r.current;
    },
    history(botId) {
      return (load().bots[botId]?.history ?? []).slice().reverse();
    },
    drop(botId) {
      delete load().bots[botId];
      save();
    },
    flush: save,
  };
}

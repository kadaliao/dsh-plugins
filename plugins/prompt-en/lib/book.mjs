// The vocabulary book's storage: one JSON file beside the answer cache.
//
//   { "cards": { "<id>": VocabCard }, "done": ["<prompt key>", …], "nudgedAt": 0 }
//
// Reads and writes are synchronous on an in-memory copy; the file is written at
// most once per macrotask, never concurrently, and only after a change, so an
// unload never writes an unchanged copy over a newer file.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { MAX_CARDS, MAX_DONE, NUDGE_EVERY_MS, cardId, schedule } from './vocab.mjs';

/**
 * @typedef {object} VocabCard
 * @property {string} id - a hash of what it teaches, so the same thing is kept once.
 * @property {'fix'|'phrase'|'pattern'} kind
 * @property {string} cue - what the card shows first.
 * @property {string} answer - what the person recalls.
 * @property {string} [why] - fix: the kind of change.
 * @property {string} [pattern] - pattern: the frame, its changing parts as ___.
 * @property {string} [context] - the sentence of the prompt that holds the cue.
 * @property {string} [example] - the sentence that holds the answer.
 * @property {number} addedAt
 * @property {number} seen - how many times it was collected.
 * @property {number} box - Leitner box, 0 (new or forgotten) up.
 * @property {number} due
 * @property {number} lapses
 */

const isCard = (c) => c && typeof c === 'object' && typeof c.id === 'string' && typeof c.cue === 'string' && typeof c.answer === 'string';

/**
 * Open the book kept in `file`; a missing or unreadable file is an empty book.
 * @param {string | null} file - where it is kept; null keeps it in memory (tests).
 * @returns the book.
 */
export function createBook(file) {
  const cards = new Map();
  let done = [];
  let doneSet = new Set();
  let nudgedAt = 0;
  let timer = null;

  if (file !== null) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      for (const card of Object.values(parsed?.cards ?? {})) if (isCard(card)) cards.set(card.id, card);
      if (Array.isArray(parsed?.done)) done = parsed.done.filter((k) => typeof k === 'string');
      if (typeof parsed?.nudgedAt === 'number') nudgedAt = parsed.nudgedAt;
    } catch {
      // No book yet.
    }
  }
  doneSet = new Set(done);

  const body = () => JSON.stringify({ cards: Object.fromEntries(cards), done, nudgedAt });
  const write = () => {
    if (file === null) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, body(), 'utf8');
    } catch {
      // A failed write must not break a translation or a review.
    }
  };
  const save = () => {
    if (file === null || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      write();
    }, 250);
  };

  function trim() {
    if (cards.size <= MAX_CARDS) return;
    const leaving = [...cards.values()]
      .sort((a, b) => b.box - a.box || a.addedAt - b.addedAt)
      .slice(0, cards.size - MAX_CARDS);
    for (const card of leaving) cards.delete(card.id);
  }

  return {
    /** Every card, in no order. */
    cards: () => [...cards.values()],
    get: (id) => cards.get(id),
    size: () => cards.size,

    /**
     * File what was found: a new card is due at once; one already kept is seen
     * again, and a fix made again goes back to the first box, since it was not
     * learnt yet.
     * @param {ReadonlyArray<object>} found
     * @param {number} now
     * @returns {VocabCard[]} the cards as filed.
     */
    file(found, now) {
      if (found.length === 0) return [];
      const filed = [];
      for (const f of found) {
        const id = cardId(f.kind, f.cue, f.answer, f.pattern);
        const old = cards.get(id);
        let card;
        if (old) {
          // What the newest sighting came with, not an older one's context.
          const { context: _c, example: _e, ...rest } = old;
          card = {
            ...rest,
            ...f,
            id,
            seen: old.seen + 1,
            ...(f.kind === 'fix' && old.box > 0 ? { box: 0, due: now } : {}),
          };
        } else {
          card = { id, ...f, addedAt: now, seen: 1, box: 0, due: now, lapses: 0 };
        }
        cards.set(id, card);
        filed.push(card);
      }
      trim();
      save();
      return filed;
    },

    /**
     * @param {string} id
     * @param {'again'|'hard'|'good'} grade
     * @param {number} now
     * @returns {VocabCard | null} the card as graded.
     */
    grade(id, grade, now) {
      const card = cards.get(id);
      if (!card) return null;
      const next = schedule(card, grade, now);
      cards.set(id, next);
      save();
      return next;
    },

    /** @returns {boolean} whether there was such a card. */
    drop(id) {
      const had = cards.delete(id);
      if (had) save();
      return had;
    },

    /** Whether the prompt under `key` was filed, live or imported. */
    isDone: (key) => doneSet.has(key),

    /** @param {ReadonlyArray<string>} keys */
    markDone(keys) {
      if (keys.length === 0) return;
      const adding = new Set(keys);
      done = [...done.filter((k) => !adding.has(k)), ...adding].slice(-MAX_DONE);
      doneSet = new Set(done);
      save();
    },

    /**
     * The number of cards due, when it is time to say so (at most every
     * NUDGE_EVERY_MS and only with something due); 0 otherwise.
     * @param {number} now
     * @returns {number}
     */
    takeNudge(now) {
      if (now - nudgedAt < NUDGE_EVERY_MS) return 0;
      let due = 0;
      for (const card of cards.values()) if (card.due <= now) due += 1;
      if (due === 0) return 0;
      nudgedAt = now;
      save();
      return due;
    },

    /** Write a change not yet saved now (unload). */
    flush() {
      if (timer === null) return;
      clearTimeout(timer);
      timer = null;
      write();
    },
  };
}

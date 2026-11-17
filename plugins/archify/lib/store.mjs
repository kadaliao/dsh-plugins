/**
 * The gallery: every page `archify_render` delivered, newest first, kept as one
 * JSON file under the DSH home. Pages stay where they were written (the
 * session's working directory); the gallery only remembers them, and the web
 * routes serve nothing it does not list.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

/** Pages remembered; the oldest are forgotten past this. */
export const MAX_ITEMS = 2000;

export function newId() {
  return `${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;
}

/**
 * @param {string} dir - the plugin's cache directory.
 */
export function createStore(dir) {
  const file = join(dir, 'gallery.json');
  let items = [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (Array.isArray(parsed?.items)) items = parsed.items.filter((it) => it && typeof it.id === 'string' && typeof it.html === 'string');
  } catch {
    items = [];
  }
  let timer = null;
  const write = () => {
    timer = null;
    try {
      mkdirSync(dir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, items }), 'utf8');
      renameSync(tmp, file);
    } catch {
      // The gallery is a convenience; the pages themselves are on disk.
    }
  };
  const save = () => {
    if (timer === null) timer = setTimeout(write, 200);
  };
  return {
    /**
     * Record a delivered page. A page already listed (a repair rewrote the same
     * file) moves to the top under its id, so the conversation's earlier card
     * shows the new version and the gallery has one row for it.
     */
    put(entry) {
      const at = items.findIndex((it) => it.html === entry.html);
      const prev = at >= 0 ? items[at] : undefined;
      if (at >= 0) items.splice(at, 1);
      const item = { ...entry, id: prev?.id ?? entry.id ?? newId(), createdAt: prev?.createdAt ?? entry.updatedAt };
      items.unshift(item);
      if (items.length > MAX_ITEMS) items.length = MAX_ITEMS;
      save();
      return item;
    },
    get(id) {
      return items.find((it) => it.id === id);
    },
    remove(id) {
      const at = items.findIndex((it) => it.id === id);
      if (at < 0) return false;
      items.splice(at, 1);
      save();
      return true;
    },
    /** A page of the list; `before` is the id the previous page ended on. */
    list({ limit = 60, before = '' } = {}) {
      let start = 0;
      if (before) {
        const at = items.findIndex((it) => it.id === before);
        start = at >= 0 ? at + 1 : items.length;
      }
      const page = items.slice(start, start + limit).map((it) => ({ ...it, missing: !existsSync(it.html) }));
      return { items: page, hasMore: start + limit < items.length, total: items.length };
    },
    size: () => items.length,
    flush() {
      if (timer !== null) {
        clearTimeout(timer);
        write();
      }
    },
  };
}

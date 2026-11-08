/**
 * The gallery: every image the tool generated, newest last, in one JSON index
 * beside the image files. Writes are coalesced and never block a generation.
 *
 * @module @kadaliao/dsh-images/lib/store
 */

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Images kept; past this the oldest leave, files included. */
export const KEEP = 2000;

/** A short, sortable, unique id for one image. */
export function newId(now = Date.now()) {
  const rand = Math.random().toString(36).slice(2, 8).padEnd(6, '0');
  return `${now.toString(36)}-${rand}`;
}

/**
 * The gallery under `dir`: `index.json` and `files/<id>.<ext>`.
 * @param {string} dir
 * @param {{keep?: number}} [options]
 */
export function createStore(dir, options = {}) {
  const keep = options.keep ?? KEEP;
  const file = join(dir, 'index.json');
  const filesDir = join(dir, 'files');
  let items = [];
  let seenMtime = -1;
  let timer = null;

  /** The index as the file holds it, or null when there is none to read. */
  function readFile() {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (parsed && Array.isArray(parsed.items)) return parsed.items.filter((it) => it && typeof it.id === 'string');
    } catch {
      // A cold gallery is the normal first run.
    }
    return null;
  }
  function mtime() {
    try {
      return statSync(file).mtimeMs;
    } catch {
      return -1;
    }
  }
  /**
   * Another process with the same home (a second profile, the headless CLI) may
   * have written the index since; take its rows in, keeping ours, by time.
   */
  function reload() {
    const now = mtime();
    if (now === seenMtime) return;
    seenMtime = now;
    const onDisk = readFile();
    if (onDisk === null) return;
    const byId = new Map(onDisk.map((it) => [it.id, it]));
    for (const it of items) if (!byId.has(it.id)) byId.set(it.id, it);
    items = [...byId.values()].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || (a.id < b.id ? -1 : 1));
  }
  reload();

  function write() {
    timer = null;
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, JSON.stringify({ items }), 'utf8');
      seenMtime = mtime();
    } catch {
      // A failed index write must not break a generation.
    }
  }
  function save() {
    if (timer !== null) return;
    timer = setTimeout(write, 250);
  }

  return {
    dir,
    filesDir,
    /** The path a new image file takes. */
    pathFor(id, ext) {
      mkdirSync(filesDir, { recursive: true });
      return join(filesDir, `${id}.${ext}`);
    },
    add(item) {
      reload();
      items.push(item);
      while (items.length > keep) {
        const old = items.shift();
        if (old?.file) {
          try {
            rmSync(old.file, { force: true });
          } catch {
            // Already gone.
          }
        }
      }
      save();
      return item;
    },
    get(id) {
      reload();
      return items.find((it) => it.id === id);
    },
    /** Newest first; `before` is an id to page past. */
    list({ limit = 60, before = '' } = {}) {
      reload();
      let end = items.length;
      if (before !== '') {
        const at = items.findIndex((it) => it.id === before);
        if (at !== -1) end = at;
      }
      const start = Math.max(0, end - limit);
      return { items: items.slice(start, end).reverse(), hasMore: start > 0, total: items.length };
    },
    remove(id) {
      reload();
      const at = items.findIndex((it) => it.id === id);
      if (at === -1) return false;
      const [gone] = items.splice(at, 1);
      if (gone.file) {
        try {
          rmSync(gone.file, { force: true });
        } catch {
          // Already gone.
        }
      }
      save();
      return true;
    },
    size() {
      reload();
      return items.length;
    },
    flush() {
      if (timer !== null) {
        clearTimeout(timer);
        write();
      }
    },
  };
}

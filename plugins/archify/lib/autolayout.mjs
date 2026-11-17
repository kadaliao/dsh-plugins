/**
 * Automatic placement for Architecture candidates.
 *
 * The model writes the topology (components, connections, boundaries) and the
 * plugin places it: ELK's layered algorithm (vendored elkjs, EPL-2.0) puts the
 * components in rows by their connections, with each boundary as a compound
 * node so its members stay together and non-members stay out. Archify then
 * routes the connections and places their labels itself.
 *
 * This module holds the pure parts the Host and the layout worker share; ELK
 * itself only loads in the worker (`layout-worker.mjs`), a separate process, so
 * neither its 1.6 MB nor a crash in it reaches the Harness.
 */

import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const WORKER = join(dirname(fileURLToPath(import.meta.url)), 'layout-worker.mjs');
export const ELK_BUNDLE = join(dirname(fileURLToPath(import.meta.url)), '..', 'vendor', 'elkjs', 'elk.bundled.js');

/**
 * Layouts the worker tries. Each is checked by Archify, and the passing one
 * with the fewest crossings and detours in Archify's own routing wins (the
 * earlier on a tie; a clean one ends the search). Top to bottom reads best for
 * the deep chains real systems make; the second placement straightens long
 * edges, and the last two narrow a graph that came out too wide by capping
 * nodes per row and node width.
 */
export const CASCADE = [
  { between: 56, nodeNode: 36 },
  { between: 56, nodeNode: 36, placement: 'NETWORK_SIMPLEX' },
  { between: 48, nodeNode: 24, layerBound: 2, maxW: 180 },
  { between: 48, nodeNode: 24, layerBound: 3, maxW: 200 },
];

const COMPONENT_GEOMETRY = ['pos', 'size', 'row', 'col'];
const CONNECTION_GEOMETRY = ['fromSide', 'toSide', 'route', 'via', 'labelAt', 'labelDx', 'labelDy', 'labelSegment'];

const omit = (o, keys) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
const list = (x) => (Array.isArray(x) ? x : []);
const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

/** Whether a component has a place Archify can draw it at. */
function placed(c, spec) {
  if (Array.isArray(c?.pos) && c.pos.length === 2) return true;
  return spec?.layout?.mode === 'grid' && Number.isInteger(c?.row) && Number.isInteger(c?.col);
}

/** The candidate without any geometry: what the layout is computed from. */
export function topologyOf(spec) {
  const s = JSON.parse(JSON.stringify(spec));
  delete s.layout;
  if (isObject(s.meta)) delete s.meta.viewBox;
  s.components = list(s.components).map((c) => (isObject(c) ? omit(c, COMPONENT_GEOMETRY) : c));
  if (Array.isArray(s.connections)) s.connections = s.connections.map((e) => (isObject(e) ? omit(e, CONNECTION_GEOMETRY) : e));
  if (Array.isArray(s.boundaries)) s.boundaries = s.boundaries.map((b) => (isObject(b) ? omit(b, ['pad']) : b));
  return s;
}

const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

/** Fingerprint of what the layout depends on. */
export function topologyKey(spec) {
  const t = topologyOf(spec);
  return sha([t.components, t.connections ?? [], t.boundaries ?? []]);
}

/** Fingerprint of the geometry, to tell the plugin's own placement from a hand-edited one. */
export function placementKey(spec) {
  return sha([
    list(spec?.components).map((c) => [c?.id, c?.pos, c?.size, c?.row, c?.col]),
    list(spec?.connections).map((e) => CONNECTION_GEOMETRY.map((k) => e?.[k])),
    list(spec?.boundaries).map((b) => b?.pad),
    spec?.layout ?? null,
    spec?.meta?.viewBox ?? null,
  ]);
}

/** Where the plugin records the placement it wrote into a candidate. */
export function sidecarOf(candidate) {
  return candidate.replace(/(\.json)?$/i, '.layout.json');
}

/**
 * Whether to lay a candidate out, and why:
 * - `missing`: some component has no `pos` (or grid cell), which Archify cannot draw;
 * - `requested`: the caller asked for a fresh layout;
 * - `changed`: the plugin placed this candidate before, nobody moved anything
 *   since, and its components, connections or boundaries changed.
 * A hand-placed candidate is left alone.
 * @param {unknown} spec
 * @param {{relayout?: boolean, sidecar?: {topology?: string, placement?: string} | null}} [o]
 */
export function layoutReason(spec, { relayout = false, sidecar = null } = {}) {
  if (!isObject(spec) || spec.diagram_type !== 'architecture') return '';
  const components = list(spec.components);
  if (components.length === 0 || !components.every(isObject)) return '';
  if (relayout) return 'requested';
  if (components.some((c) => !placed(c, spec))) return 'missing';
  if (sidecar && sidecar.placement === placementKey(spec) && sidecar.topology !== topologyKey(spec)) return 'changed';
  return '';
}

/**
 * Size of a component box: room for its widest line of text (label 11px,
 * sublabel 9px, tag 8px at 0.6em per unit) plus the type sigil and padding.
 * @param {(text: string) => number} units Archify's own text measure (CJK counts twice)
 */
export function nodeSize(c, units, { minW = 120, maxW = 240 } = {}) {
  const label = units(c.label ?? '') * 11 * 0.6;
  const sub = c.sublabel ? units(c.sublabel) * 9 * 0.6 : 0;
  const tag = c.tag ? units(c.tag) * 8 * 0.6 : 0;
  const need = Math.max(label, sub, tag) + 8 + 30;
  return [Math.min(maxW, Math.max(minW, Math.ceil(need / 10) * 10)), c.sublabel ? 64 : 60];
}

/**
 * Each boundary's parent boundary (the smallest one holding all its members)
 * and each component's innermost boundary, so boundaries become nested groups.
 */
export function hierarchy(spec) {
  const bs = list(spec.boundaries)
    .map((b, i) => ({ i, id: `__boundary_${i}`, members: new Set(list(b?.wraps).map(String)) }))
    .filter((x) => x.members.size > 0)
    // Smallest first; of two with the same members, the later one is the inner one.
    .sort((x, y) => x.members.size - y.members.size || y.i - x.i);
  const parentOf = new Map();
  for (const x of bs) {
    const p = bs.find((y) => y !== x && [...x.members].every((m) => y.members.has(m)) && (y.members.size > x.members.size || y.i < x.i));
    parentOf.set(x.id, p ? p.id : null);
  }
  const home = new Map();
  for (const c of list(spec.components)) {
    const owner = bs.find((x) => x.members.has(String(c.id)));
    home.set(String(c.id), owner ? owner.id : null);
  }
  return { bs, parentOf, home };
}

/** The ELK graph for a topology and one layout variant. */
export function elkGraph(spec, variant, units) {
  const { bs, parentOf, home } = hierarchy(spec);
  const spacing = {
    'elk.layered.spacing.nodeNodeBetweenLayers': String(variant.between),
    'elk.spacing.nodeNode': String(variant.nodeNode),
    'elk.spacing.edgeNode': '24',
    'elk.spacing.edgeEdge': '16',
    'elk.layered.spacing.edgeNodeBetweenLayers': '24',
    'elk.layered.spacing.edgeEdgeBetweenLayers': '16',
    'elk.layered.nodePlacement.strategy': variant.placement ?? 'BRANDES_KOEPF',
    'elk.direction': 'DOWN',
    // ELK reads spacing and layering per group, so every group gets them too.
    ...(variant.layerBound ? { 'elk.layered.layering.strategy': 'COFFMAN_GRAHAM', 'elk.layered.layering.coffmanGraham.layerBound': String(variant.layerBound) } : {}),
  };
  const root = {
    id: '__root',
    layoutOptions: {
      ...spacing,
      'elk.algorithm': 'layered',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      // Only on the root: on a group it crashes ELK 0.12.
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.padding': '[top=12,left=12,bottom=12,right=12]',
    },
    children: [],
    edges: [],
  };
  // Room for Archify's boundary frame and its label below the members.
  const groups = new Map(bs.map((x) => [x.id, { id: x.id, layoutOptions: { ...spacing, 'elk.padding': '[top=46,left=40,bottom=62,right=40]' }, children: [] }]));
  for (const x of bs) {
    const p = parentOf.get(x.id);
    (p ? groups.get(p).children : root.children).push(groups.get(x.id));
  }
  const ids = new Set();
  for (const c of list(spec.components)) {
    const id = String(c.id);
    if (ids.has(id)) continue;
    ids.add(id);
    const [width, height] = nodeSize(c, units, { maxW: variant.maxW });
    const g = home.get(id);
    (g ? groups.get(g).children : root.children).push({ id, width, height });
  }
  list(spec.connections).forEach((e, i) => {
    const from = String(e?.from);
    const to = String(e?.to);
    if (from === to || !ids.has(from) || !ids.has(to)) return;
    root.edges.push({ id: `__edge_${i}`, sources: [from], targets: [to] });
  });
  return root;
}

/** Absolute boxes of every node in a laid-out ELK graph. */
export function boxesOf(out) {
  const boxes = new Map();
  const walk = (n, ox, oy) => {
    for (const ch of n.children ?? []) {
      const x = ox + (ch.x ?? 0);
      const y = oy + (ch.y ?? 0);
      boxes.set(ch.id, { x, y, w: ch.width, h: ch.height });
      walk(ch, x, y);
    }
  };
  walk(out, 0, 0);
  return boxes;
}

/** Margin around the drawing, as Archify's own examples leave. */
const MARGIN = 28;

/** The topology with each component's `pos` and `size` from a laid-out graph. */
export function applyBoxes(topology, out) {
  const boxes = boxesOf(out);
  const placedSpec = JSON.parse(JSON.stringify(topology));
  placedSpec.components = list(placedSpec.components).map((c) => {
    const b = boxes.get(String(c.id));
    if (!b) return c;
    return { ...c, pos: [Math.round(b.x + MARGIN), Math.round(b.y + MARGIN)], size: [Math.round(b.w), Math.round(b.h)] };
  });
  return { spec: placedSpec, width: Math.round(out.width + 2 * MARGIN), height: Math.round(out.height + 2 * MARGIN) };
}

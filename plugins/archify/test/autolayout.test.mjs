import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CASCADE, ELK_BUNDLE, WORKER, elkGraph, hierarchy, layoutReason, nodeSize, placementKey, sidecarOf, topologyKey, topologyOf } from '../lib/autolayout.mjs';
import { SKILL_ROOT } from '../lib/run.mjs';
import { placeCandidate } from '../index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const example = (name) => JSON.parse(readFileSync(join(SKILL_ROOT, 'examples', name), 'utf8'));
const fixture = (name) => JSON.parse(readFileSync(join(HERE, 'fixtures', name), 'utf8'));
const units = (text) => [...String(text)].reduce((n, ch) => n + (/[　-鿿＀-￯]/.test(ch) ? 2 : 1), 0);

test('the worker and the vendored ELK are in place', () => {
  assert.ok(existsSync(WORKER));
  assert.ok(existsSync(ELK_BUNDLE));
  assert.ok(existsSync(join(dirname(ELK_BUNDLE), 'LICENSE.md')));
  assert.equal(JSON.parse(readFileSync(join(dirname(ELK_BUNDLE), 'package.json'), 'utf8')).type, 'commonjs');
});

test('the topology keeps the meaning and drops every placement and route hint', () => {
  const spec = example('web-app.architecture.json');
  spec.layout = { mode: 'grid' };
  spec.meta.viewBox = '0 0 900 600';
  spec.boundaries[0].pad = 50;
  spec.connections[0].fromSide = 'right';
  spec.connections[0].via = [[1, 2]];
  const t = topologyOf(spec);
  assert.equal(t.layout, undefined);
  assert.equal(t.meta.viewBox, undefined);
  assert.equal(t.meta.title, spec.meta.title);
  assert.ok(t.components.every((c) => c.pos === undefined && c.size === undefined && c.row === undefined && c.col === undefined));
  assert.deepEqual(t.components.map((c) => c.label), spec.components.map((c) => c.label));
  assert.equal(t.boundaries[0].pad, undefined);
  assert.deepEqual(t.boundaries[0].wraps, spec.boundaries[0].wraps);
  assert.equal(t.connections[0].fromSide, undefined);
  assert.equal(t.connections[0].via, undefined);
  assert.equal(t.connections[0].from, spec.connections[0].from);
  // The input is left alone.
  assert.equal(spec.connections[0].fromSide, 'right');
});

test('a candidate is laid out when positions are missing, asked for, or stale after a topology edit', () => {
  const placed = example('web-app.architecture.json');
  const bare = topologyOf(placed);
  assert.equal(layoutReason(bare), 'missing');
  assert.equal(layoutReason(placed), '');
  assert.equal(layoutReason(placed, { relayout: true }), 'requested');
  // One new component without a place is enough.
  assert.equal(layoutReason({ ...placed, components: [...placed.components, { id: 'new', type: 'backend', label: 'New' }] }), 'missing');
  // Grid cells count as places only in grid mode.
  const grid = { ...bare, components: bare.components.map((c, i) => ({ ...c, row: i, col: 0 })) };
  assert.equal(layoutReason(grid), 'missing');
  assert.equal(layoutReason({ ...grid, layout: { mode: 'grid', cols: 1 } }), '');
  // Other diagram types and broken candidates are not this module's business.
  assert.equal(layoutReason({ ...bare, diagram_type: 'workflow' }), '');
  assert.equal(layoutReason(null), '');
  assert.equal(layoutReason({ ...bare, components: [] }), '');

  // The plugin placed it: a label edit lays it out again, a hand move keeps it.
  const sidecar = { topology: topologyKey(placed), placement: placementKey(placed) };
  assert.equal(layoutReason(placed, { sidecar }), '');
  const relabeled = JSON.parse(JSON.stringify(placed));
  relabeled.components[0].label = 'A much longer label than before';
  assert.equal(layoutReason(relabeled, { sidecar }), 'changed');
  const moved = JSON.parse(JSON.stringify(relabeled));
  moved.components[0].pos = [moved.components[0].pos[0] + 40, moved.components[0].pos[1]];
  assert.equal(layoutReason(moved, { sidecar }), '');
  assert.equal(sidecarOf('/w/.archify/a/candidate.json'), '/w/.archify/a/candidate.layout.json');
});

test('boxes fit their text, CJK counting double, within the width limits', () => {
  assert.deepEqual(nodeSize({ label: 'API' }, units), [120, 60]);
  assert.deepEqual(nodeSize({ label: 'Checkout service', sublabel: 'Node.js · REST' }, units), [150, 64]);
  const [latin] = nodeSize({ label: 'abcdefghijklmnopqrst' }, units);
  const [cjk] = nodeSize({ label: '一二三四五六七八九十' }, units);
  assert.equal(latin, cjk);
  assert.equal(nodeSize({ label: 'x'.repeat(80) }, units)[0], 240);
  assert.equal(nodeSize({ label: 'x'.repeat(80) }, units, { maxW: 180 })[0], 180);
});

test('boundaries become nested groups, and members land in the innermost one', () => {
  const spec = {
    components: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
    boundaries: [
      { kind: 'region', label: 'Cloud', wraps: ['a', 'b', 'c'] },
      { kind: 'security-group', label: 'VPC', wraps: ['a', 'b'] },
      { kind: 'security-group', label: 'Same members, inner', wraps: ['a', 'b'] },
      { kind: 'region', label: 'Empty', wraps: [] },
    ],
  };
  const { parentOf, home } = hierarchy(spec);
  assert.equal(parentOf.get('__boundary_0'), null);
  assert.equal(parentOf.get('__boundary_1'), '__boundary_0');
  assert.equal(parentOf.get('__boundary_2'), '__boundary_1');
  assert.equal(home.get('a'), '__boundary_2');
  assert.equal(home.get('c'), '__boundary_0');
  assert.equal(home.get('d'), null);

  const graph = elkGraph({ ...spec, connections: [{ from: 'a', to: 'd' }, { from: 'a', to: 'a' }, { from: 'a', to: 'zzz' }] }, CASCADE.at(-1), units);
  assert.equal(graph.layoutOptions['elk.direction'], 'DOWN');
  assert.equal(graph.layoutOptions['elk.layered.considerModelOrder.strategy'], 'NODES_AND_EDGES');
  const cloud = graph.children.find((n) => n.id === '__boundary_0');
  // Spacing and layering reach the groups; model order stays on the root.
  assert.equal(cloud.layoutOptions['elk.layered.layering.coffmanGraham.layerBound'], '3');
  assert.equal(cloud.layoutOptions['elk.layered.considerModelOrder.strategy'], undefined);
  assert.deepEqual(graph.edges.map((e) => [e.sources[0], e.targets[0]]), [['a', 'd']]);
});

test('the worker places a model-written topology, passing showcase validation, and records it', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'archify-layout-'));
  const candidate = join(cwd, 'candidate.json');
  const topo = fixture('prompt-en.topology.json');
  writeFileSync(candidate, JSON.stringify(topo));
  const summary = await placeCandidate(candidate, { cwd, quality: 'showcase' });
  assert.equal(summary.ok, true, JSON.stringify(summary));
  assert.equal(summary.passed, true, JSON.stringify(summary));
  assert.ok(summary.variant >= 1 && summary.variant <= CASCADE.length);
  assert.ok(summary.width > 300 && summary.height > 300);
  assert.ok(Number.isFinite(summary.tangles));
  const placed = JSON.parse(readFileSync(candidate, 'utf8'));
  assert.ok(placed.components.every((c) => Array.isArray(c.pos) && Array.isArray(c.size)));
  assert.deepEqual(topologyOf(placed), topologyOf(topo));
  const sidecar = JSON.parse(readFileSync(sidecarOf(candidate), 'utf8'));
  assert.equal(sidecar.placement, placementKey(placed));
  assert.equal(sidecar.topology, topologyKey(placed));
  assert.equal(layoutReason(placed, { sidecar }), '');
});

test('the worker reports a candidate it cannot read instead of crashing', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'archify-layout-'));
  const candidate = join(cwd, 'candidate.json');
  writeFileSync(candidate, '{not json');
  const summary = await placeCandidate(candidate, { cwd, quality: 'showcase' });
  assert.equal(summary.ok, false);
  assert.match(summary.error, /JSON/);
  assert.equal(readFileSync(candidate, 'utf8'), '{not json');
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { ABILITIES } from '../lib/abilities.mjs';
import { ROUTER_DENY, noWaitReason, personaText, runsSleep } from '../lib/prompt.mjs';

const atlas = { id: 'b-atlas', name: 'Atlas', handle: 'atlas', role: 'primary', persona: 'Chief of staff.', bio: 'Runs the team', skills: [] };
const coder = { id: 'b-coder', name: 'Coder', handle: 'coder', role: 'bot', persona: '', bio: 'Writes code', skills: [] };
const roster = [atlas, coder];

const ticket = {
  id: 't1a2b3c4d',
  title: 'Fix the login bug',
  text: 'Users cannot log in with SSO.',
  botId: 'b-coder',
  requester: { kind: 'session', sessionId: 'home-atlas', botId: 'b-atlas' },
  origin: { threadKey: 'slack:acme:C1:1.2', via: 'Slack', who: 'Kada' },
  threads: ['slack:acme:C1:1.2'],
  reports: [],
};

test('hands-on stays the default and keeps the 0.7 dispatcher text', () => {
  const plain = personaText(atlas, roster);
  assert.equal(personaText(atlas, roster, { dispatcher: 'hands-on' }), plain);
  assert.match(plain, /## You are the dispatcher/);
  assert.match(plain, /Do small or general tasks yourself\./);
  assert.match(plain, /its answer comes back to you as a "Bot message from @…" message/);
  assert.doesNotMatch(plain, /bot_reply|bot_recall|three things/);
});

test('a router dispatcher understands, hands out and reports', () => {
  const text = personaText(atlas, roster, { dispatcher: 'router', channels: ['Slack'] });
  assert.doesNotMatch(text, /Do small or general tasks yourself/);
  assert.match(text, /You do three things: understand what the person wants, hand the work out, and report back\./);
  assert.match(text, /Every delegation with `bot_send_message` opens a task \(ticket\) for that bot and returns at once/);
  assert.match(text, /arrive by themselves\. Never wait, sleep or poll for them: end your turn/);
  assert.match(text, /more than one chat, answer each with `bot_reply`/);
  assert.match(text, /`bot_recall`/);
  assert.match(text, /100 words at most/);
  assert.match(text, /pass `ticket` \(its id\) instead of `to`/);
  assert.match(text, /\[follow_up\]/);
  assert.match(text, /`bot_schedule`/);
  assert.doesNotMatch(text, /its answer comes back to you as a "Bot message from @…" message/);
  assert.match(text, /## Chat apps/);
  assert.equal(text.match(/## You are the dispatcher/g).length, 1);
});

test('router mode only applies to the dispatcher', () => {
  assert.equal(personaText(coder, roster, { dispatcher: 'router' }), personaText(coder, roster));
  assert.match(personaText(coder, roster), /@atlas is the dispatcher/);
});

test('a ticket session frames the conversation as one task', () => {
  const text = personaText(coder, roster, { ticket, dispatcher: 'router', channels: ['Slack'] });
  assert.match(text, /## This conversation is one task/);
  assert.match(text, /It is task t1a2b3c4d: "Fix the login bug", asked by @atlas, for Kada on Slack\./);
  assert.match(text, /Report to whoever asked with `bot_send_message`: leave out `to` and give a `status`, which is required/);
  for (const s of ['progress', 'done', 'blocked', 'question']) assert.match(text, new RegExp(`\`${s}\``));
  assert.match(text, /Your plain text reaches no one: only reports do\./);
  assert.match(text, /Asking another bot opens a sub-task/);
  assert.match(text, /`bot_recall` reads this task \(`ticket\/t1a2b3c4d`\)/);
  assert.match(text, /Your plain text does not reach that chat: answer in a report/);
  assert.doesNotMatch(text, /your reply is sent back to that chat/);
  assert.doesNotMatch(text, /its answer comes back to you as a "Bot message from @…" message/);
  assert.match(text, /@atlas is the dispatcher/);

  // The dispatcher working on a ticket reads the task text, not the dispatcher text.
  const asDispatcher = personaText(atlas, roster, { ticket: { ...ticket, botId: 'b-atlas', requester: { kind: 'user' }, origin: {} }, dispatcher: 'router' });
  assert.doesNotMatch(asDispatcher, /## You are the dispatcher/);
  assert.match(asDispatcher, /asked by the user\. Its first message/);

  // A sub-task names its parent.
  const sub = personaText(coder, roster, { ticket: { ...ticket, parentId: 't9z9z9z9z', requester: { kind: 'session', botId: 'b-atlas', ticketId: 't9z9z9z9z' } } });
  assert.match(sub, /asked by task t9z9z9z9z \(@atlas\)/);
});

test('the router is denied commands, writes, sub-agents, images and Office, and keeps reading tools', () => {
  for (const name of ['bash', 'write', 'edit', 'subagent', 'workflow', 'wait_agent', 'generate_image', 'office_render', 'office_convert', 'office_recalculate', 'job_output']) {
    assert.ok(ROUTER_DENY.includes(name), name);
  }
  for (const name of ['read', 'read_image', 'skill', 'web_search', 'web_fetch', 'glob', 'grep', 'bot_send_message', 'bot_reply', 'bot_recall']) {
    assert.ok(!ROUTER_DENY.includes(name), name);
  }
  const known = new Set(ABILITIES.flatMap((a) => a.tools));
  for (const name of ROUTER_DENY) assert.ok(known.has(name), `${name} is an ability tool`);
  assert.equal(new Set(ROUTER_DENY).size, ROUTER_DENY.length);
  assert.ok(Object.isFrozen(ROUTER_DENY));
});

test('sleep at a command position is found; sleep as an argument is not', () => {
  for (const cmd of [
    'sleep 5',
    'sleep 0.1',
    '  sleep 60 ',
    'npm test && sleep 2',
    'make || sleep 1',
    'echo hi; sleep 3',
    'run & sleep 3',
    'while true; do curl -s localhost; sleep 1; done',
    'until test -f done.txt; do sleep 5; done',
    'if true; then sleep 2; fi',
    'FOO=1 sleep 3',
    '/bin/sleep 1',
    '\\sleep 1',
    'command sleep 1',
    'echo $(sleep 1)',
    'echo `sleep 1`',
    '(sleep 1)',
    '{ sleep 1; }',
    'timeout 60 sleep 30',
    'env -i A=1 sleep 2',
    'ls\nsleep 4',
    'echo "waiting $(sleep 10)"',
  ]) assert.equal(runsSleep(cmd), true, cmd);
  for (const cmd of [
    'ls -la',
    'echo sleep',
    'grep -r "sleep" src',
    "echo 'a; sleep 5'",
    'echo "a; sleep 5"',
    'git log --grep=sleep',
    'cat sleep.txt',
    'sleepy 3',
    'npm run sleep-check',
    '# sleep 5',
    'ls # then sleep 5',
    '',
    undefined,
  ]) assert.equal(runsSleep(cmd), false, String(cmd));
});

test('noWaitReason refuses sleeps, long command timeouts and long job waits', () => {
  assert.match(noWaitReason({ name: 'bash', arguments: { command: 'sleep 30', description: 'Wait' } }), /^Refused: no sleep\. The dispatcher does not wait/);
  assert.match(noWaitReason({ name: 'bash', arguments: { command: 'npm test', timeoutMs: 60_000 } }), /timeouts above 30 s/);
  assert.equal(noWaitReason({ name: 'bash', arguments: { command: 'npm test', timeoutMs: 30_000 } }), undefined);
  assert.equal(noWaitReason({ name: 'bash', arguments: { command: 'ls' } }), undefined);
  assert.equal(noWaitReason({ name: 'bash', arguments: { command: 'npm run build', run_in_background: true } }), undefined);
  assert.match(noWaitReason({ name: 'job_output', arguments: { job_id: 'j1', wait: true } }), /job waits above 5 s/, 'Harness waits 30 s by default');
  assert.match(noWaitReason({ name: 'job_output', arguments: { job_id: 'j1', wait: true, timeout_ms: 6000 } }), /job waits above 5 s/);
  assert.equal(noWaitReason({ name: 'job_output', arguments: { job_id: 'j1', wait: true, timeout_ms: 5000 } }), undefined);
  assert.equal(noWaitReason({ name: 'job_output', arguments: { job_id: 'j1' } }), undefined);
  assert.equal(noWaitReason({ name: 'read', arguments: { path: 'sleep.txt' } }), undefined);
  assert.equal(noWaitReason({ name: 'bash' }), undefined);
  assert.equal(noWaitReason(undefined), undefined);
  // The Harness ToolExecution passes straight through as a guard.
  const guard = noWaitReason;
  assert.equal(typeof guard({ callId: 'c1', name: 'bash', arguments: { command: 'sleep 1' }, signal: new AbortController().signal }), 'string');
});

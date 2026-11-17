import assert from 'node:assert/strict';
import test from 'node:test';

import { ABILITIES } from '../lib/abilities.mjs';
import { DEFAULT_COMMAND_MS, ROUTER_DENY, noWaitReason, personaText, reportsGoDirect, runsSleep } from '../lib/prompt.mjs';

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
  assert.match(text, /You do three things: understand what the person wants, hand the work out, and keep track of it\./);
  // Bots 0.10: the work is the teammates', never the dispatcher's own task; its helpers are teammates, not sub-agents.
  assert.match(text, /you never do it, not even a quick lookup/);
  assert.match(text, /never your own, @atlas: you do no work yourself, not even in a task\)\. When no role fits exactly, pick the closest teammate/);
  assert.doesNotMatch(text, /a quick fact/);
  assert.match(text, /research splits by angle/);
  assert.match(text, /as the dispatcher you have no Harness sub-agents \(`subagent`, `wait_agent`, workflows\)\. When a skill says to start sub-agents or parallel researchers, hand those parts to teammates with `bot_send_message` instead\./);
  assert.match(text, /Tasks, ticket ids, topics and threads are how Bots works inside/);
  assert.match(text, /never drop a request because another came after it/);
  assert.match(text, /The bot doing a task answers the person itself/);
  assert.match(text, /`report_to: "me"`/);
  assert.match(text, /"\[Shown\]" note/);
  assert.match(text, /Every delegation with `bot_send_message` opens a task \(ticket\) for that bot and returns at once/);
  assert.match(text, /arrive by themselves\. Never wait, sleep or poll for them: end your turn/);
  assert.match(text, /more than one chat \(the panel and a chat app, or two chat threads\), answer each with `bot_reply`/);
  // Bots 0.10: a thread sees the conversation up to the message it answers.
  assert.match(text, /starts with "\[Thread\]" is a thread/);
  assert.doesNotMatch(text, /\(thread p…\)/);
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

test('0.9/0.10: a task from the panel or a chat answers the person there itself, unless its requester asked for the reports', () => {
  const fromTopic = { ...ticket, origin: { threadKey: 'panel:s1:p1234abcd', who: 'the user' } };
  const text = personaText(coder, roster, { ticket: fromTopic, dispatcher: 'router' });
  assert.match(text, /Your `done`, `question` and `blocked` reports are shown to the person as they are, in the panel, where the request came from/);
  assert.match(text, /Put everything the person needs in the report/);
  assert.doesNotMatch(text, /Put everything the requester needs/);
  const fromChat = personaText(coder, roster, { ticket: { ...ticket, origin: { threadKey: 'slack:b/a:C1:1.2', via: 'slack', who: 'Kada' } }, channels: ['Slack'] });
  assert.match(fromChat, /in the chat \(slack\) the request came from/);
  assert.match(fromChat, /answer in a report, which is posted there\./);
  // Asked back by its requester, or a sub-task, or no thread: 0.8's relay.
  for (const t of [{ ...fromTopic, relay: true }, { ...fromTopic, parentId: 't9z9z9z9z', requester: { kind: 'session', botId: 'b-atlas', ticketId: 't9z9z9z9z' } }, { ...ticket, origin: { who: 'Kada' } }]) {
    assert.equal(reportsGoDirect(t), false);
    assert.match(personaText(coder, roster, { ticket: t }), /Put everything the requester needs in the report/);
  }
  assert.equal(reportsGoDirect(fromTopic), true);
});

test('0.9: a non-dispatcher home that opens tasks learns that the worker answers the person', () => {
  const text = personaText(coder, roster, { tickets: true });
  assert.match(text, /that bot answers them there itself and you get a "\[Shown\]" note/);
  assert.match(text, /Pass `report_to: "me"` when you need the result back yourself/);
});

test('the router is denied commands, writes, sub-agents, images and Office, and keeps reading tools', () => {
  // 0.9: the web too — a search keeps the person waiting, so it is a task.
  for (const name of ['bash', 'write', 'edit', 'subagent', 'workflow', 'wait_agent', 'generate_image', 'office_render', 'office_convert', 'office_recalculate', 'job_output', 'web_search', 'web_fetch']) {
    assert.ok(ROUTER_DENY.includes(name), name);
  }
  for (const name of ['read', 'read_image', 'skill', 'glob', 'grep', 'bot_send_message', 'bot_reply', 'bot_recall']) {
    assert.ok(!ROUTER_DENY.includes(name), name);
  }
  // Harness's other ways to run commands or change files, which no ability lists, are denied too.
  const others = ['pwsh', 'terminal_open', 'terminal_send', 'terminal_read', 'terminal_signal', 'terminal_close', 'terminal_list', 'apply_patch', 'str_replace_editor'];
  const known = new Set(ABILITIES.flatMap((a) => a.tools));
  for (const name of ROUTER_DENY) assert.ok(known.has(name) || others.includes(name), `${name} is an ability tool or a listed work tool`);
  for (const name of others) assert.ok(ROUTER_DENY.includes(name), name);
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
  assert.match(noWaitReason({ name: 'bash', arguments: { command: 'npm test', timeoutMs: 60_000 } }), /must finish within 30 s\. Pass timeoutMs \(at most 30000/);
  assert.equal(noWaitReason({ name: 'bash', arguments: { command: 'npm test', timeoutMs: 30_000 } }), undefined);
  assert.equal(noWaitReason({ name: 'bash', arguments: { command: 'ls', timeoutMs: 5000 } }), undefined);
  assert.equal(noWaitReason({ name: 'bash', arguments: { command: 'npm run build', run_in_background: true } }), undefined);
  assert.match(noWaitReason({ name: 'job_output', arguments: { job_id: 'j1', wait: true } }), /job waits above 5 s/, 'Harness waits 30 s by default');
  assert.match(noWaitReason({ name: 'job_output', arguments: { job_id: 'j1', wait: true, timeout_ms: 6000 } }), /job waits above 5 s/);
  assert.equal(noWaitReason({ name: 'job_output', arguments: { job_id: 'j1', wait: true, timeout_ms: 5000 } }), undefined);
  assert.equal(noWaitReason({ name: 'job_output', arguments: { job_id: 'j1' } }), undefined);
  assert.equal(noWaitReason({ name: 'read', arguments: { path: 'sleep.txt' } }), undefined);
  assert.equal(noWaitReason(undefined), undefined);
  // The Harness ToolExecution passes straight through as a guard.
  const guard = noWaitReason;
  assert.equal(typeof guard({ callId: 'c1', name: 'bash', arguments: { command: 'sleep 1' }, signal: new AbortController().signal }), 'string');
});

test('a router command without a timeout counts as 120 s: waits the shell text hides are capped, pwsh too', () => {
  assert.equal(DEFAULT_COMMAND_MS, 120_000);
  // None of these runs `sleep` at a command position; the missing timeout is what refuses them.
  for (const command of ["sh -c 'sleep 100'", 'python3 -c "import time; time.sleep(100)"', 'read -t 100 x', 'tail -f app.log', 'ls']) {
    assert.match(noWaitReason({ name: 'bash', arguments: { command } }), /must finish within 30 s\. Pass timeoutMs .*left out it is 120 s/, command);
    assert.equal(noWaitReason({ name: 'bash', arguments: { command, timeoutMs: 30_000 } }), undefined, `${command} with a 30 s cap`);
  }
  assert.match(noWaitReason({ name: 'bash' }), /must finish within 30 s/);
  for (const bad of [0, -1, 'soon', 30_001]) assert.match(noWaitReason({ name: 'bash', arguments: { command: 'ls', timeoutMs: bad } }), /must finish within 30 s/, String(bad));
  // PowerShell is held to the same rules.
  assert.match(noWaitReason({ name: 'pwsh', arguments: { command: 'Start-Process x' } }), /must finish within 30 s/);
  assert.match(noWaitReason({ name: 'pwsh', arguments: { command: 'sleep 5', timeoutMs: 1000 } }), /no sleep/);
  assert.equal(noWaitReason({ name: 'pwsh', arguments: { command: 'Get-ChildItem', timeoutMs: 10_000 } }), undefined);
  assert.equal(noWaitReason({ name: 'pwsh', arguments: { command: 'npm run build', run_in_background: true } }), undefined);
});

test('0.10: only a team\'s dispatcher is told its helpers are teammates (no sub-agents); the other bots and a bot alone are not', () => {
  const forge = roster.find((b) => b.handle !== 'atlas');
  const worker = personaText(forge, roster, { dispatcher: 'router', tickets: true, ticket: { id: 't1', title: 'Look it up', requester: { kind: 'user' }, origin: { threadKey: 'panel:s1' } } });
  assert.doesNotMatch(worker, /Your helpers are your teammates/);
  assert.match(worker, /start with the answer itself, not with its status/);
  const atlas = roster.find((b) => b.handle === 'atlas');
  assert.match(personaText(atlas, roster, { dispatcher: 'hands-on' }), /Your helpers are your teammates: .* or do them yourself one after another\./);
  assert.doesNotMatch(personaText(atlas, [atlas], {}), /Your helpers are your teammates/);
});


import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CODE_TTL_MS,
  PRIVATE_TEXT,
  SECRET_MASK,
  channelEntry,
  channelIssue,
  createChannels,
  hintOf,
  maskBot,
  newPairingCode,
  pairingCandidate,
  redact,
  routeMessage,
  sourceHeader,
  splitText,
  toPlainText,
  unmaskApps,
} from '../lib/channels.mjs';
import { catalog } from '../lib/apps.mjs';

const TOKEN = '123456789:AAHsecret-telegram-token-value_xyz';
const flush = async (n = 6) => {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r));
};

// --- pure helpers -----------------------------------------------------------------------

test('the gallery has Telegram and Discord as chat channels, not MCP servers', () => {
  const entries = catalog();
  for (const [id, color, keyUrl] of [['telegram', '#229ED9', 'https://t.me/BotFather'], ['discord', '#5865F2', 'https://discord.com/developers/applications']]) {
    const e = entries.find((x) => x.id === id);
    assert.equal(e.kind, 'channel');
    assert.equal(e.channel, id);
    assert.equal(e.category, 'work');
    assert.equal(e.color, color);
    assert.equal(e.keyUrl, keyUrl);
    assert.ok(e.icon && e.name.en && e.name.zh && e.description.en && e.description.zh);
    const secrets = e.fields.filter((f) => f.kind === 'secret' && f.required);
    assert.equal(secrets.length, 1);
    assert.ok(channelEntry({ template: id }, entries));
  }
  const discord = entries.find((x) => x.id === 'discord');
  assert.match(discord.fields[0].help.en, /Message Content Intent/);
  assert.match(discord.fields[0].help.en, /invite/i);
  assert.match(discord.fields[0].help.zh, /Message Content Intent/);
  assert.equal(channelEntry({ template: 'slack' }, entries), null);
  assert.equal(channelIssue({ template: 'telegram', values: {} }, entries.find((x) => x.id === 'telegram')), 'Telegram needs: Bot token');
  assert.equal(channelIssue({ template: 'telegram', values: { token: 'x' } }, entries.find((x) => x.id === 'telegram')), '');
});

test('tokens are masked for the page, and a mask sent back keeps the stored token', () => {
  const entries = catalog();
  const bot = { id: 'b', apps: [{ id: 'a1', template: 'telegram', values: { token: TOKEN } }, { id: 'a2', template: 'tavily', values: { TAVILY_API_KEY: 'k' } }] };
  const masked = maskBot(bot, entries);
  assert.equal(masked.apps[0].values.token, SECRET_MASK);
  assert.equal(masked.apps[1].values.TAVILY_API_KEY, 'k', 'other apps are left alone');
  assert.equal(bot.apps[0].values.token, TOKEN, 'the stored bot is not changed');
  assert.equal(JSON.stringify(masked).includes(TOKEN), false);
  const back = unmaskApps(masked.apps, bot.apps, entries);
  assert.equal(back[0].values.token, TOKEN);
  const changed = unmaskApps([{ ...masked.apps[0], values: { token: 'new:token' } }], bot.apps, entries);
  assert.equal(changed[0].values.token, 'new:token');
  const fresh = unmaskApps([{ id: 'other', template: 'telegram', values: { token: SECRET_MASK } }], bot.apps, entries);
  assert.equal(fresh[0].values.token, undefined, 'a mask without a stored token is no token');
});

test('redact removes the token, Telegram URL tokens and Discord-shaped tokens', () => {
  assert.equal(redact(`GET https://api.telegram.org/bot${TOKEN}/getMe failed`, [TOKEN]), 'GET https://api.telegram.org/bot<token>/getMe failed');
  assert.equal(redact(`https://api.telegram.org/bot${TOKEN}/getMe`), 'https://api.telegram.org/bot<token>/getMe');
  assert.doesNotMatch(redact(`auth ${['MTA5ODc2NTQzMjEwOTg3NjU0', 'Gx1AbC', 'sEcReT-token_value-do-not-leak'].join('.')}`), /sEcReT/);
  assert.equal(redact('nothing secret here'), 'nothing secret here');
});

test('splitText keeps parts under the limit, at line breaks, never splitting a surrogate pair', () => {
  const para = 'word '.repeat(30).trim();
  const text = Array.from({ length: 10 }, () => para).join('\n\n');
  const parts = splitText(text, 400);
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(p.length <= 400, `part of ${p.length}`);
  assert.equal(parts.join(' ').replace(/\s+/g, ' '), text.replace(/\s+/g, ' '));
  const emoji = '\u{1F600}'.repeat(300);
  for (const p of splitText(emoji, 101)) {
    assert.ok(p.length <= 101);
    assert.equal([...p].every((c) => c === '\u{1F600}'), true);
  }
  assert.deepEqual(splitText('short', 4096), ['short']);
  assert.deepEqual(splitText('  ', 4096), []);
});

test('toPlainText drops Markdown markers but keeps code and links readable', () => {
  const md = '## Plan\n\n**Forge** fixes the bugs, __Echo__ writes.\n- one\n* two\n\n```js\nconst a = 2 ** 3;\n```\n---\nSee [the doc](https://x.dev/d) and [https://y.dev](https://y.dev).';
  assert.equal(toPlainText(md), 'Plan\n\nForge fixes the bugs, Echo writes.\n• one\n• two\n\nconst a = 2 ** 3;\n\nSee the doc (https://x.dev/d) and https://y.dev.');
});

test('pairing codes, the code a message offers, routing and the source header', () => {
  const code = newPairingCode();
  assert.match(code, /^[A-HJKMNP-Z2-9]{6}$/);
  assert.equal(pairingCandidate(`/start ${code}`), code);
  assert.equal(pairingCandidate(`/start@team_bot ${code.toLowerCase()}`), code);
  assert.equal(pairingCandidate(` ${code} `), code);
  assert.equal(pairingCandidate('hello there'), '');
  assert.equal(pairingCandidate('/start'), '');
  const atlas = { id: 'a', handle: 'atlas', name: 'Atlas' };
  const forge = { id: 'f', handle: 'forge', name: 'Forge' };
  const roster = [atlas, forge];
  assert.deepEqual(routeMessage('@forge fix the login bug', atlas, roster), { bot: forge, text: 'fix the login bug' });
  assert.deepEqual(routeMessage('@Forge, ship it', atlas, roster), { bot: forge, text: 'ship it' });
  assert.deepEqual(routeMessage('@nobody hi', atlas, roster), { bot: atlas, text: '@nobody hi' });
  assert.deepEqual(routeMessage('email @forge later', atlas, roster), { bot: atlas, text: 'email @forge later' });
  assert.equal(sourceHeader('telegram', { userName: 'Kada', isDirect: true }), '[Telegram · Kada]');
  assert.equal(sourceHeader('discord', { userName: 'Kada [x]', isDirect: false, chatTitle: 'Acme #ops' }), '[Discord · Kada x · Acme #ops]');
  assert.equal(hintOf('Discord refused the Message Content intent (close 4014). …'), 'intent');
  assert.equal(hintOf('Telegram rejected the bot token (401 Unauthorized).'), 'token');
  assert.equal(hintOf('Another program is using this bot token (Telegram answered 409 Conflict).'), 'conflict');
});

// --- the hub ------------------------------------------------------------------------------

/** A stand-in connector module that records what the hub asks of it. */
function fakeConnectors() {
  const made = [];
  const plan = { fail: null };
  const module = (kind) => ({
    kind,
    TEXT_LIMIT: kind === 'telegram' ? 50 : 2000,
    createConnector(opts) {
      const c = {
        kind,
        opts,
        stopped: false,
        sent: [],
        typed: [],
        async start() {
          if (plan.fail) {
            const error = plan.fail;
            plan.fail = null;
            throw error;
          }
          opts.onStatus?.({ state: 'connected' });
          return { id: '999', username: `${kind}_team_bot`, name: 'Team' };
        },
        async stop() {
          c.stopped = true;
        },
        async send(chatId, text, o) {
          c.sent.push({ chatId, text, ...(o ?? {}) });
        },
        async typing(chatId) {
          c.typed.push(chatId);
        },
        emit: (msg) => opts.onMessage(msg),
      };
      made.push(c);
      return c;
    },
  });
  return { made, plan, load: async (kind) => module(kind), live: () => made.filter((c) => !c.stopped) };
}

function setup({ clock = { t: 1_000_000 } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bots-channels-'));
  const entries = catalog();
  const roster = [
    { id: 'atlas', handle: 'atlas', name: 'Atlas', role: 'primary', persona: '', apps: [{ id: 'tg', template: 'telegram', serverName: 'telegram', enabled: true, values: { token: TOKEN } }] },
    { id: 'forge', handle: 'forge', name: 'Forge', role: 'bot', persona: '', apps: [] },
  ];
  const delivered = [];
  const logs = [];
  const fakes = fakeConnectors();
  const deps = {
    file: join(dir, 'channels.json'),
    bots: () => roster,
    entries: () => entries,
    deliver: async (bot, msg) => {
      delivered.push({ bot: bot.id, ...msg });
      return `session-${bot.id}`;
    },
    running: () => true,
    loadConnector: fakes.load,
    log: (line) => logs.push(line),
    now: () => clock.t,
    typingEveryMs: 10_000,
    retryMs: 5,
  };
  const hub = createChannels(deps);
  return { hub, roster, delivered, logs, fakes, clock, deps, dir };
}

let nextId = 100;
const dm = (text, extra = {}) => ({ chatId: '42', messageId: String(nextId++), userId: '42', userName: 'Kada', text, isDirect: true, mentioned: true, ...extra });

test('a channel app with a token starts a connector and offers a pairing code', async () => {
  const s = setup();
  s.hub.sync();
  await flush();
  assert.equal(s.fakes.made.length, 1);
  assert.equal(s.fakes.made[0].opts.token, TOKEN);
  const view = s.hub.view(s.roster[0]).tg;
  assert.equal(view.state, 'connected');
  assert.equal(view.account.username, 'telegram_team_bot');
  assert.match(view.code.code, /^[A-Z2-9]{6}$/);
  assert.equal(view.link, `https://t.me/telegram_team_bot?start=${view.code.code}`);
  assert.deepEqual(view.paired, []);
  assert.equal(view.scheduleReplies, true);
  assert.equal(JSON.stringify(view).includes(TOKEN), false);
  // Syncing again changes nothing.
  s.hub.sync();
  await flush();
  assert.equal(s.fakes.made.length, 1);
  await s.hub.stopAll();
});

test('strangers are ignored with one "private" note per chat per day; groups need a mention', async () => {
  const s = setup();
  s.hub.sync();
  await flush();
  const c = s.fakes.made[0];
  c.emit(dm('hello?', { userId: '7', chatId: '7', userName: 'Mallory' }));
  c.emit(dm('run rm -rf ~', { userId: '7', chatId: '7', userName: 'Mallory' }));
  await flush();
  assert.deepEqual(c.sent, [{ chatId: '7', text: PRIVATE_TEXT }]);
  assert.equal(s.delivered.length, 0);
  s.clock.t += 25 * 3600_000;
  c.emit(dm('again', { userId: '7', chatId: '7', userName: 'Mallory' }));
  await flush();
  assert.equal(c.sent.length, 2, 'a new note after a day');
  c.emit({ ...dm('in a group', { userId: '8', chatId: '-100', userName: 'Eve' }), isDirect: false, mentioned: true, chatTitle: 'G' });
  await flush();
  assert.equal(c.sent.length, 2, 'no note in groups');
  assert.equal(s.hub.view(s.roster[0]).tg.ignored.count, 4);
  assert.equal(s.hub.view(s.roster[0]).tg.ignored.lastName, 'Eve');
  await s.hub.stopAll();
});

test('the code pairs the first person who sends it, once; wrong codes are limited', async () => {
  const s = setup();
  s.hub.sync();
  await flush();
  const c = s.fakes.made[0];
  const { code } = s.hub.view(s.roster[0]).tg.code;
  const wrong = code === 'ABCDEF' ? 'ABCDEG' : 'ABCDEF';
  for (let i = 0; i < 6; i += 1) c.emit(dm(wrong, { userId: '9', chatId: '9', userName: 'Guesser' }));
  await flush();
  c.emit(dm(code, { userId: '9', chatId: '9', userName: 'Guesser' }));
  await flush();
  assert.equal(s.hub.view(s.roster[0]).tg.paired.length, 0, 'a person out of tries cannot pair even with the right code');
  // Pairing happens in a direct chat only.
  c.emit({ ...dm(`/start ${code}`), isDirect: false, chatId: '-100', chatTitle: 'G' });
  await flush();
  assert.equal(s.hub.view(s.roster[0]).tg.paired.length, 0);
  const before = c.sent.length;
  c.emit(dm(`/start ${code}`));
  await flush();
  const view = s.hub.view(s.roster[0]).tg;
  assert.deepEqual(view.paired.map((p) => [p.id, p.name, p.direct]), [['42', 'Kada', true]]);
  assert.equal(view.code, null, 'the code is used up');
  assert.match(c.sent.slice(before).map((m) => m.text).join(' '), /^Paired\. What you send here goes to Atlas \(@atlas\)\. .*@forge/);
  c.emit(dm(code, { userId: '10', chatId: '10', userName: 'Late' }));
  await flush();
  assert.equal(s.hub.view(s.roster[0]).tg.paired.length, 1, 'a used code pairs no one else');
  // Saved: a new hub reads the pairing back.
  const saved = JSON.parse(readFileSync(s.deps.file, 'utf8'));
  assert.equal(saved.channels['atlas/tg'].paired[0].id, '42');
  assert.equal(JSON.stringify(saved).includes(TOKEN), false);
  const again = createChannels({ ...s.deps });
  assert.equal(again.view(s.roster[0]).tg.paired[0].name, 'Kada');
  await s.hub.stopAll();
});

test('codes expire after ten minutes and can be renewed', async () => {
  const s = setup();
  s.hub.sync();
  await flush();
  const c = s.fakes.made[0];
  const { code } = s.hub.view(s.roster[0]).tg.code;
  s.clock.t += CODE_TTL_MS + 1;
  assert.equal(s.hub.view(s.roster[0]).tg.code, null);
  c.emit(dm(code));
  await flush();
  assert.equal(s.hub.view(s.roster[0]).tg.paired.length, 0);
  const fresh = s.hub.newCode('atlas', 'tg');
  assert.equal(fresh.expiresAt, s.clock.t + CODE_TTL_MS);
  c.emit(dm(fresh.code));
  await flush();
  assert.equal(s.hub.view(s.roster[0]).tg.paired.length, 1);
  assert.throws(() => s.hub.newCode('forge', 'tg'), /no such chat channel/);
  await s.hub.stopAll();
});

/** A hub with Kada paired on Atlas's Telegram channel. */
async function paired() {
  const s = setup();
  s.hub.sync();
  await flush();
  const c = s.fakes.made[0];
  c.emit(dm(s.hub.view(s.roster[0]).tg.code.code));
  await flush();
  c.sent.length = 0;
  return { ...s, c };
}

test('a paired person reaches the owning bot, or the one named by @handle; typing shows', async () => {
  const s = await paired();
  s.c.emit(dm('Plan the launch'));
  await flush();
  assert.deepEqual(s.delivered.at(-1), { bot: 'atlas', header: '[Telegram · Kada]', body: 'Plan the launch' });
  assert.deepEqual(s.c.typed, ['42']);
  s.c.emit(dm('@forge fix the login bug'));
  await flush();
  assert.deepEqual(s.delivered.at(-1), { bot: 'forge', header: '[Telegram · Kada]', body: 'fix the login bug' });
  // In a group: only when mentioned, and replies thread under the message.
  s.c.emit({ ...dm('chatter'), isDirect: false, mentioned: false, chatId: '-100', chatTitle: 'Team' });
  await flush();
  assert.equal(s.delivered.length, 2);
  const status = dm('status?');
  s.c.emit({ ...status, isDirect: false, mentioned: true, chatId: '-100', chatTitle: 'Team' });
  await flush();
  assert.deepEqual(s.delivered.at(-1), { bot: 'atlas', header: '[Telegram · Kada · Team]', body: 'status?' });
  s.hub.noteUserMessage('session-atlas', s.roster[0], 'user', '[Telegram · Kada · Team]\nstatus?');
  assert.deepEqual(s.hub.targetOf('session-atlas'), { key: 'atlas/tg', kind: 'telegram', chatId: '-100', replyTo: status.messageId, who: 'Kada', origin: 'chat' });
  // /start from a paired person is a greeting, not a task.
  s.c.emit(dm('/start'));
  await flush();
  assert.equal(s.delivered.length, 3);
  assert.match(s.c.sent.map((m) => m.text).join(' '), /goes to Atlas/);
  await s.hub.stopAll();
});

test('replies follow the latest human input: chat, the dispatcher report later, back to the panel', async () => {
  const s = await paired();
  const atlas = s.roster[0];
  s.c.emit(dm('Organise the release'));
  await flush();
  // The conversation shows the message: its chat becomes the reply target.
  const origin = s.hub.noteUserMessage('session-atlas', atlas, 'user', '[Telegram · Kada]\nOrganise the release');
  assert.equal(origin.body, 'Organise the release');
  assert.equal(origin.kind, 'telegram');
  assert.equal(s.hub.noteReply('session-atlas', "On it: **Forge** takes the bugs.").kind, 'telegram');
  await flush();
  assert.deepEqual(s.c.sent, [{ chatId: '42', text: 'On it: Forge takes the bugs.' }]);
  // Teammates answer by DM; the target stays, so the dispatcher's report reaches the chat.
  s.hub.noteUserMessage('session-atlas', atlas, 'agent-message', 'Bot message from @forge: done');
  s.hub.noteReply('session-atlas', 'All three bugs are fixed and merged. Next: the launch post, due Thursday, and Ledger watches refunds.');
  await flush();
  assert.equal(s.c.sent.length, 4, 'split at the connector limit (50)');
  assert.ok(s.c.sent.every((m) => m.text.length <= 50 && m.chatId === '42'));
  assert.equal(s.c.sent.slice(1).map((m) => m.text).join(' '), 'All three bugs are fixed and merged. Next: the launch post, due Thursday, and Ledger watches refunds.');
  // A message typed in the panel takes the conversation back there.
  assert.equal(s.hub.noteUserMessage('session-atlas', atlas, 'user', 'hi from the panel'), null);
  assert.equal(s.hub.noteReply('session-atlas', 'Hello panel'), null);
  await flush();
  assert.equal(s.c.sent.length, 4);
  await s.hub.stopAll();
});

test('scheduled runs report to the first paired person, unless the channel says not to', async () => {
  const s = await paired();
  const atlas = s.roster[0];
  s.hub.noteUserMessage('session-atlas', atlas, 'schedule', 'Morning brief');
  assert.equal(s.hub.noteReply('session-atlas', 'Good morning: two things today.').origin, 'schedule');
  await flush();
  assert.deepEqual(s.c.sent, [{ chatId: '42', text: 'Good morning: two things today.' }]);
  s.hub.setOptions('atlas', 'tg', { scheduleReplies: false });
  assert.equal(s.hub.view(atlas).tg.scheduleReplies, false);
  s.hub.noteUserMessage('session-atlas', atlas, 'schedule', 'Morning brief');
  assert.equal(s.hub.noteReply('session-atlas', 'Good morning again'), null);
  // A bot without a channel keeps its scheduled replies in the panel.
  s.hub.noteUserMessage('session-forge', s.roster[1], 'schedule', 'Nightly check');
  assert.equal(s.hub.targetOf('session-forge'), null);
  await s.hub.stopAll();
});

test('removing a paired person ignores them again and drops their chats as reply targets', async () => {
  const s = await paired();
  s.c.emit(dm('task'));
  await flush();
  s.hub.noteUserMessage('session-atlas', s.roster[0], 'user', '[Telegram · Kada]\ntask');
  assert.ok(s.hub.targetOf('session-atlas'));
  assert.equal(s.hub.unpair('atlas', 'tg', '42'), true);
  assert.equal(s.hub.unpair('atlas', 'tg', '42'), false);
  assert.equal(s.hub.targetOf('session-atlas'), null);
  s.c.emit(dm('another task'));
  await flush();
  assert.equal(s.delivered.length, 1);
  assert.equal(s.c.sent.at(-1).text, PRIVATE_TEXT);
  await s.hub.stopAll();
});

test('connectors restart on a new token and stop when the app is disabled or removed, or the bot goes', async () => {
  const s = await paired();
  const atlas = s.roster[0];
  atlas.apps[0] = { ...atlas.apps[0], values: { token: '987654321:BBnew-token-value-for-the-team' } };
  s.hub.sync();
  await flush();
  assert.equal(s.c.stopped, true);
  assert.equal(s.fakes.live().length, 1);
  assert.equal(s.fakes.live()[0].opts.token, '987654321:BBnew-token-value-for-the-team');
  atlas.apps[0] = { ...atlas.apps[0], enabled: false };
  s.hub.sync();
  await flush();
  assert.equal(s.fakes.live().length, 0);
  assert.equal(s.hub.view(atlas).tg.state, 'off');
  assert.equal(s.hub.view(atlas).tg.paired.length, 1, 'pairings stay while the app is only off');
  atlas.apps[0] = { ...atlas.apps[0], enabled: true };
  s.hub.sync();
  await flush();
  assert.equal(s.fakes.live().length, 1);
  atlas.apps.splice(0, 1);
  s.hub.sync();
  await flush();
  assert.equal(s.fakes.live().length, 0);
  assert.equal(JSON.parse(readFileSync(s.deps.file, 'utf8')).channels['atlas/tg'], undefined, 'pairings go with the app');
  // A second bot with its own channel; deleting the bot stops it.
  s.roster.push({ id: 'echo', handle: 'echo', name: 'Echo', apps: [{ id: 'dc', template: 'discord', serverName: 'discord', enabled: true, values: { token: 'discord-token-value-123' } }] });
  s.hub.sync();
  await flush();
  assert.equal(s.fakes.live()[0].kind, 'discord');
  s.roster.pop();
  s.hub.sync();
  await flush();
  assert.equal(s.fakes.live().length, 0);
  await s.hub.stopAll();
});

test('one token runs in one place; bad tokens stay down, other failures retry', async () => {
  const s = setup();
  s.roster[1].apps = [{ id: 'tg2', template: 'telegram', serverName: 'telegram', enabled: true, values: { token: TOKEN } }];
  s.hub.sync();
  await flush();
  assert.equal(s.fakes.made.length, 1);
  const dup = s.hub.view(s.roster[1]).tg2;
  assert.equal(dup.state, 'error');
  assert.match(dup.detail, /already connected on @atlas/);
  s.roster[1].apps = [];
  await s.hub.stopAll();

  const t = setup();
  t.fakes.plan.fail = Object.assign(new Error(`Telegram rejected the bot token (401 Unauthorized) for bot${TOKEN}`), { fatal: true });
  t.hub.sync();
  await flush();
  let view = t.hub.view(t.roster[0]).tg;
  assert.equal(view.state, 'error');
  assert.equal(view.hint, 'token');
  assert.equal(view.detail.includes(TOKEN), false);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(t.fakes.made.length, 1, 'no retry after a fatal error');
  // Reconnect on request (after the user fixed the token in the chat app's console).
  t.hub.reconnect('atlas', 'tg');
  await flush();
  assert.equal(t.hub.view(t.roster[0]).tg.state, 'connected');
  await t.hub.stopAll();

  const u = setup();
  u.fakes.plan.fail = new Error('socket hang up');
  u.hub.sync();
  await flush();
  view = u.hub.view(u.roster[0]).tg;
  assert.equal(view.state, 'error');
  await new Promise((r) => setTimeout(r, 40));
  await flush();
  assert.equal(u.fakes.made.length, 2, 'retried with a fresh connector');
  assert.equal(u.hub.view(u.roster[0]).tg.state, 'connected');
  await u.hub.stopAll();
  assert.equal(u.fakes.live().length, 0);
  u.hub.sync();
  await flush();
  assert.equal(u.fakes.made.length, 2, 'nothing starts after stopAll');
});

test('a connector that fails to load says so; the token never reaches logs or views', async () => {
  const s = setup();
  const hub = createChannels({ ...s.deps, loadConnector: async () => { throw new Error('Cannot find module discord.mjs'); } });
  hub.sync();
  await flush();
  const view = hub.view(s.roster[0]).tg;
  assert.equal(view.state, 'error');
  assert.match(view.detail, /Telegram support could not load/);
  await hub.stopAll();
  assert.equal(JSON.stringify(s.logs).includes(TOKEN), false);
});

test('a message handed out again (restart, new connector, resumed session) is not run twice', async () => {
  const s = await paired();
  const task = dm('Deploy the site');
  s.c.emit(task);
  s.c.emit({ ...task });
  await flush();
  assert.equal(s.delivered.length, 1);
  // An older message of the same chat is a replay too; another chat keeps its own count.
  s.c.emit({ ...dm('older'), messageId: '1' });
  s.c.emit({ ...dm('elsewhere'), chatId: '-100', isDirect: false, chatTitle: 'G', messageId: '1' });
  await flush();
  assert.deepEqual(s.delivered.map((d) => d.body), ['Deploy the site', 'elsewhere']);
  // After a restart (a new hub on the same file), the replayed task is still recognised.
  await s.hub.stopAll();
  const again = createChannels({ ...s.deps });
  again.sync();
  await flush();
  s.fakes.live()[0].emit({ ...task });
  await flush();
  assert.equal(s.delivered.length, 2);
  s.fakes.live()[0].emit(dm('A new task'));
  await flush();
  assert.equal(s.delivered.at(-1).body, 'A new task');
  await again.stopAll();
});

test('/new from a chat app starts the bot’s next topic; text after it is delivered there', async () => {
  const s = await paired();
  const started = [];
  s.deps.newTopic = async (bot) => started.push(bot.id);
  s.c.emit(dm('/new'));
  await flush();
  assert.deepEqual(started, ['atlas']);
  assert.equal(s.delivered.length, 0, 'a bare /new is no task');
  assert.match(s.c.sent.map((x) => x.text).join(' '), /New topic: Atlas/);
  s.c.emit(dm('@forge /新话题 重新开始写登录模块'));
  await flush();
  assert.deepEqual(started, ['atlas', 'forge']);
  assert.deepEqual(s.delivered.at(-1), { bot: 'forge', header: '[Telegram · Kada]', body: '重新开始写登录模块' });
  s.deps.newTopic = async () => {
    throw new Error('Atlas is still working; start a new topic when it is done');
  };
  s.c.sent.length = 0;
  s.c.emit(dm('/new'));
  await flush();
  assert.match(s.c.sent.map((x) => x.text).join(' '), /still working/);
  // "/newsletter" is no command.
  s.c.emit(dm('/newsletter draft'));
  await flush();
  assert.equal(s.delivered.at(-1).body, '/newsletter draft');
  await s.hub.stopAll();
});

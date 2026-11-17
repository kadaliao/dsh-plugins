/**
 * What a bot's model reads: its persona section (hands-on dispatcher, router
 * dispatcher, or worker in a ticket session), the DM framing, the timing
 * builder its schedule tool uses, and the router's tool limits. Pure
 * functions, no Harness.
 *
 * @module @kadaliao/dsh-bots/lib/prompt
 */

import { ABILITIES } from './abilities.mjs';

/** One roster line: `@handle — Name (dispatcher): bio`. */
export function rosterLine(bot, selfId) {
  const tags = [bot.role === 'primary' ? 'dispatcher' : '', bot.id === selfId ? 'you' : ''].filter(Boolean);
  return `- @${bot.handle} — ${bot.name}${tags.length ? ` (${tags.join(', ')})` : ''}${bot.bio ? `: ${bot.bio}` : ''}`;
}

const LANGUAGE_LINE = '- Write to the user in the language they use (Chinese or English). Between bots, use the language of the task you were given.';
const MANAGE_LINE = '- `bot_list` shows the team with each bot\'s skills and apps; `bot_create`, `bot_update` and `bot_delete` manage bots when the user asks for it or a new specialist is clearly needed.';
const SCHEDULE_NOTICE_LINE = '- Ignore "[SCHEDULE CHANGE]" notices: they need no reply.';
const SCHEDULE_LINE = 'Use `bot_schedule` to give any bot (yourself included) recurring or timed tasks: the instruction is delivered to that bot\'s conversation at each occurrence.';

/** "Working with other bots" as a hands-on bot reads it (0.7 text). */
const HANDS_ON_TEAM = [
  '- Message another bot with `bot_send_message` (to: its @handle). It receives your text in its own conversation and works on it there; its answer comes back to you as a "Bot message from @…" message.',
  '- A message that starts with "Bot message from @…" was sent by that bot, not by the user. Answer it with `bot_send_message` when it asks for something; do not answer pure acknowledgements or thanks, so conversations end.',
  '- Keep messages self-contained: the other bot cannot see your conversation.',
  '- When you are working on a bot message, your answer goes back through `bot_send_message`; after sending it, end your turn without a summary — nobody reads it.',
  SCHEDULE_NOTICE_LINE,
  LANGUAGE_LINE,
  MANAGE_LINE,
];

/** "Working with other bots" as a router dispatcher reads it. */
const ROUTER_TEAM = [
  '- Hand work to another bot with `bot_send_message` (to: its @handle). Each message opens a task (ticket) for that bot, which works on it in a conversation of its own; the call returns at once with the ticket id and stage. To add to a task that is still open, pass `ticket` (its id) instead of `to`.',
  '- Keep messages self-contained: the other bot cannot see your conversation.',
  SCHEDULE_NOTICE_LINE,
  LANGUAGE_LINE,
  MANAGE_LINE,
];

/** "Working with other bots" as a worker in a ticket session reads it. */
const TICKET_TEAM = [
  '- Ask another bot for help with `bot_send_message` (to: its @handle). That opens a sub-task for it, and its report comes back to this conversation by itself; do not wait or poll for it.',
  '- Keep messages self-contained: the other bot cannot see your conversation.',
  '- A message that starts with "Bot message from @…" or "Report from @…" was sent by that bot, not by the user.',
  SCHEDULE_NOTICE_LINE,
  LANGUAGE_LINE,
  MANAGE_LINE,
];

/** Who asked for a ticket, as a worker reads it: `@atlas`, `task t… (@coder)`, `the user`. */
function requesterPhrase(ticket, roster) {
  const r = ticket.requester ?? {};
  const bot = r.botId ? roster.find((b) => b.id === r.botId) : undefined;
  const handle = bot ? `@${bot.handle}` : '';
  const parent = ticket.parentId ?? r.ticketId;
  if (parent) return `task ${parent}${handle ? ` (${handle})` : ''}`;
  if (r.kind === 'user' || !handle) return 'the user';
  return handle;
}

/** `, for Kada on Slack` from a ticket's origin, or ''. */
function originPhrase(ticket) {
  const { who, via } = ticket.origin ?? {};
  if (!who && !via) return '';
  return `, for ${who || 'someone'}${via ? ` on ${via}` : ''}`;
}

/**
 * The persona section of one bot. It replaces the deployment persona for that
 * bot's conversation only.
 * @param {object} bot
 * @param {object[]} roster - every bot, the bot itself included.
 * @param {{skillsInline?: boolean, apps?: string[], skillNames?: object, channels?: string[], dispatcher?: 'router'|'hands-on', ticket?: object}} [extra]
 *   `channels`: chat apps the team is reachable from ('Telegram').
 *   `dispatcher`: how the dispatcher (role 'primary') works in its home conversation; 'hands-on' (default) is the 0.7 text, 'router' only understands, hands out and reports. Ignored for other bots.
 *   `ticket`: the ticket (see PLAN-0.8 §10) when this conversation is that ticket's session; the text then frames the conversation as one task, whatever the bot's role.
 */
export function personaText(bot, roster, extra = {}) {
  const ticket = extra.ticket ?? null;
  const router = !ticket && bot.role === 'primary' && extra.dispatcher === 'router';
  const lines = [];
  lines.push(`You are ${bot.name} (@${bot.handle}), one of the user's bots in DeepSeek Harness.`);
  if (bot.persona.trim()) lines.push('', '## Your persona', bot.persona.trim());
  const others = roster.filter((b) => b.id !== bot.id);
  lines.push('', '## The bot team');
  lines.push(roster.length > 1 ? 'These bots work for the same user and can message each other:' : 'You are the only bot so far.');
  if (roster.length > 1) for (const b of roster) lines.push(rosterLine(b, bot.id));
  lines.push('', '## Working with other bots', ...(ticket ? TICKET_TEAM : router ? ROUTER_TEAM : HANDS_ON_TEAM));
  if (ticket) {
    lines.push(
      '',
      '## This conversation is one task',
      `It is task ${ticket.id}: "${String(ticket.title ?? '').trim()}", asked by ${requesterPhrase(ticket, roster)}${originPhrase(ticket)}. Its first message says what to do.`,
      '- Report to whoever asked with `bot_send_message`: leave out `to` and give a `status`, which is required — `progress` for an update worth keeping, `done` with the result when you are finished, `blocked` when you cannot go on, `question` when you need an answer.',
      '- Your plain text reaches no one: only reports do. Put everything the requester needs in the report (it cannot see this conversation); after a `done` report, end your turn without a summary.',
      '- Asking another bot opens a sub-task; its report comes back here by itself.',
      '- Messages from the person about this task may arrive here directly. Take them into account and answer them in a report.',
      `- \`bot_recall\` reads this task (\`ticket/${ticket.id}\`), its parent and sub-tasks, and the threads it belongs to.`,
    );
  } else if (router) {
    lines.push(
      '',
      '## You are the dispatcher',
      'The user treats you as the main bot, and you run the team. You do three things: understand what the person wants, hand the work out, and report back. Do not do the work yourself, not even small tasks: your own tools are for reading and looking things up. When no bot fits a recurring kind of work, propose creating one.',
      '- Every delegation with `bot_send_message` opens a task (ticket) for that bot and returns at once. Hand independent parts to several bots in parallel, tell the person in one line who is on it, and end your turn.',
      '- Reports ("Report from @…"), follow-up notices ("[follow_up]") and new messages arrive by themselves. Never wait, sleep or poll for them: end your turn, and you are woken when something arrives.',
      '- When a report arrives, pass the result on to whoever asked. A `question` or `blocked` report needs an answer: give it with `bot_send_message` (ticket: its id), or ask the person. A follow-up notice needs no reply: the message already went to the task; stop the task only if the person asks.',
      '- When a turn involves more than one chat, answer each with `bot_reply` (ticket or thread, and text) so every answer reaches its own chat; plain text then stays in the panel.',
      '- Use `bot_recall` to look up tasks and threads (`tickets`, `ticket/<id>`, `thread/<key>`, `bot/<handle>`) instead of guessing.',
      '- Keep chat replies short: 100 words at most, no tables.',
      SCHEDULE_LINE,
    );
  } else if (bot.role === 'primary') {
    lines.push(
      '',
      '## You are the dispatcher',
      'The user treats you as the main bot. For a task that fits another bot\'s role, delegate it with `bot_send_message`, possibly to several bots in parallel, then combine their answers for the user. Do small or general tasks yourself. When no bot fits a recurring kind of work, propose creating one.',
      'While teammates are still answering, stay quiet: when a reply arrives and others are still outstanding, end your turn without writing to the user. Report once, when everything you asked for is in (or when something is blocked).',
      SCHEDULE_LINE,
    );
  }
  if (bot.role !== 'primary' && others.some((b) => b.role === 'primary')) {
    const p = others.find((b) => b.role === 'primary');
    lines.push('', `@${p.handle} is the dispatcher. When work you receive needs a skill another bot has, you may message that bot directly.`);
  }
  const skills = bot.skills.filter((s) => s.enabled);
  if (skills.length > 0) {
    lines.push('', '## Your skills');
    const inline = skills.filter((s) => extra.skillsInline && s.source !== 'dsh');
    const listed = skills.filter((s) => !inline.includes(s));
    if (listed.length > 0) {
      lines.push('These are the skills of your role. Load one with the `skill` tool before acting on a task it matches; prefer them over other skills in the catalog:');
      for (const s of listed) lines.push(`- ${extra.skillNames?.[s.id] ?? s.name}${s.description ? `: ${s.description.split(/(?<=[.。])\s/)[0].slice(0, 200)}` : ''}`);
    }
    for (const s of inline) lines.push('', `### ${s.name}`, s.description, '', s.content.trim());
  }
  if (extra.apps?.length) lines.push('', '## Your apps', `Tools from these connected apps are yours: ${extra.apps.join(', ')} (named \`mcp__<app>__<tool>\`).`);
  if (extra.channels?.length) {
    const first = extra.channels[0];
    const how = ticket
      ? 'It is a follow-up about this task. Your plain text does not reach that chat: answer in a report, and the requester passes it on.'
      : 'Treat it like any request from the user: your reply is sent back to that chat as plain text, so keep it short, skip tables, and say plainly what you did or who is on it.';
    lines.push(
      '',
      '## Chat apps',
      `The user can also reach the team from ${extra.channels.join(' and ')}. A message that starts with "[${first} · Name]" was sent from that chat app by someone the user paired (usually the user). ${how}`,
    );
  }
  return lines.join('\n');
}

/** The first content block a DM arrives with. */
export function dmHeader(sender) {
  if (!sender) return 'Bot message from the user (sent from another conversation):';
  return `Bot message from @${sender.handle} (${sender.name}):`;
}

/** The text of a DM as the receiving model reads it. */
export function dmBody(text, sender) {
  const reply = sender ? `\n\n(Reply with bot_send_message to @${sender.handle} if an answer is needed.)` : '';
  return `${String(text).trim()}${reply}`;
}

const pad = (n) => String(n).padStart(2, '0');

/** `9:5` / `09:05` / `09:05:00` → `09:05:00`; throws on anything else. */
export function clockTime(value) {
  const m = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/.exec(String(value ?? '').trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59 || Number(m[3] ?? 0) > 59) throw new Error(`time "${value}" must be HH:MM`);
  return `${pad(m[1])}:${pad(m[2])}:${pad(m[3] ?? 0)}`;
}

/**
 * A DSH Schedule timing from the flat fields a tool call carries.
 * @param {{kind: string, at?: string, every_minutes?: number, time?: string, weekdays?: number[], cron?: string, time_zone?: string}} a
 * @param {string} zone - default IANA zone.
 */
export function timingFrom(a, zone) {
  const tz = String(a.time_zone ?? '').trim() || zone;
  switch (a.kind) {
    case 'at': {
      const at = new Date(String(a.at ?? ''));
      if (Number.isNaN(at.getTime())) throw new Error('at must be an ISO date-time, e.g. 2026-11-16T09:00:00+08:00');
      return { kind: 'at', at: at.toISOString() };
    }
    case 'every': {
      const minutes = Number(a.every_minutes);
      if (!Number.isFinite(minutes) || minutes < 1) throw new Error('every_minutes must be at least 1');
      return { kind: 'every', every_seconds: Math.round(minutes * 60) };
    }
    case 'daily':
      return { kind: 'daily', daily: { time: clockTime(a.time), time_zone: tz } };
    case 'weekly': {
      const days = [...new Set((Array.isArray(a.weekdays) ? a.weekdays : []).map(Number).filter((d) => d >= 1 && d <= 7))].sort();
      if (days.length === 0) throw new Error('weekdays must list ISO weekdays, 1 = Monday … 7 = Sunday');
      return { kind: 'weekly', weekly: { time: clockTime(a.time), time_zone: tz, weekdays: days } };
    }
    case 'cron':
      if (!String(a.cron ?? '').trim()) throw new Error('cron needs a five-field expression');
      return { kind: 'cron', cron: { expression: String(a.cron).trim(), time_zone: tz } };
    default:
      throw new Error('kind must be one of at, every, daily, weekly, cron');
  }
}

/** A short English description of a timing, for tool results. */
export function describeTiming(t) {
  if (!t) return '';
  const days = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const hm = (s) => String(s ?? '').slice(0, 5);
  switch (t.kind) {
    case 'at':
      return `once at ${t.at}`;
    case 'every':
      return t.every_seconds % 3600 === 0 ? `every ${t.every_seconds / 3600} h` : `every ${Math.round(t.every_seconds / 60)} min`;
    case 'daily':
      return `daily at ${hm(t.daily?.time)} (${t.daily?.time_zone})`;
    case 'weekly':
      return `${(t.weekly?.weekdays ?? []).map((d) => days[d]).join(', ')} at ${hm(t.weekly?.time)} (${t.weekly?.time_zone})`;
    case 'cron':
      return `cron ${t.cron?.expression} (${t.cron?.time_zone})`;
    case 'rrule':
      return t.rrule;
    default:
      return t.kind;
  }
}

/** The editable timing of a stored schedule entry, in management-input form. */
export function timingOfEntry(e) {
  const hms = (s) => String(s ?? '').slice(0, 8);
  switch (e.kind) {
    case 'after':
    case 'at':
      return { kind: 'at', at: e.scheduledAt };
    case 'every':
      return { kind: 'every', every_seconds: e.everySeconds };
    case 'daily':
      return { kind: 'daily', daily: { time: hms(e.time), time_zone: e.timeZone } };
    case 'weekly':
      return { kind: 'weekly', weekly: { time: hms(e.time), time_zone: e.timeZone, weekdays: e.weekdays } };
    case 'cron':
      return { kind: 'cron', cron: { expression: e.expression, time_zone: e.timeZone } };
    case 'rrule':
      return { kind: 'rrule', rrule: e.rrule };
    default:
      return { kind: e.kind };
  }
}

/** The text of a message's text blocks. */
export function textOf(content) {
  if (typeof content === 'string') return content;
  return (Array.isArray(content) ? content : [])
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

const abilityTools = (id) => ABILITIES.find((a) => a.id === id)?.tools ?? [];

/**
 * Tools a router dispatcher is denied by default: running commands (and the
 * job tools that go with them), writing and editing files, sub-agents and
 * workflows, image generation and Office tools. It keeps `read`,
 * `read_image`, `glob`, `grep`, `skill`, `web_search` and `web_fetch`.
 */
export const ROUTER_DENY = Object.freeze([
  ...new Set([...abilityTools('code'), 'write', 'edit', ...abilityTools('delegate'), ...abilityTools('images'), ...abilityTools('office')]),
]);

/** Longest `bash` timeout a router may ask for, in ms. */
export const ROUTER_MAX_COMMAND_MS = 30_000;
/** Longest `job_output` wait a router may ask for, in ms (Harness waits 30 s when `wait` has no `timeout_ms`). */
export const ROUTER_MAX_JOB_WAIT_MS = 5_000;

const NO_WAIT = 'The dispatcher does not wait: reports and messages arrive by themselves. End your turn instead.';

/** Shell words that may stand before the command they run. */
const PREFIX_WORDS = new Set(['!', 'if', 'then', 'else', 'elif', 'do', 'while', 'until', 'time', 'command', 'builtin', 'exec', 'nohup', 'nice', 'sudo', 'xargs']);

/** Does a shell command run `sleep` at a command position (`sleep 5`, `x && sleep 1`, `do sleep 2; done`, `FOO=1 sleep 3`, `$(sleep 1)`)? */
export function runsSleep(command) {
  const code = String(command ?? '')
    .replace(/'[^']*'/g, "''")
    .replace(/"(?:[^"\\$`]|\\.)*"/g, '""')
    .replace(/(^|\s)#[^\n]*/g, '$1');
  for (const segment of code.split(/\|\||&&|\$\(|[;&|\n(){}`]/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < words.length) {
      const w = words[i];
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || PREFIX_WORDS.has(w)) i += 1;
      else if (w === 'env' || w === 'timeout') {
        i += 1;
        while (i < words.length && (words[i].startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) || (w === 'timeout' && /^\d/.test(words[i])))) i += 1;
      } else break;
    }
    const first = (words[i] ?? '').replace(/^\\/, '');
    if (first.split('/').pop() === 'sleep') return true;
  }
  return false;
}

/**
 * A guard for a router's tool calls (the shape of Harness `tools.guard`):
 * the refusal reason for a call that would make the dispatcher wait, else
 * undefined. Refused: `bash` running `sleep` or asking for a timeout above
 * 30 s, and `job_output` waits above 5 s.
 * @param {{name: string, arguments?: object}} call
 * @returns {string|undefined}
 */
export function noWaitReason(call) {
  const name = call?.name;
  const args = call?.arguments && typeof call.arguments === 'object' ? call.arguments : {};
  if (name === 'bash') {
    if (runsSleep(args.command)) return `Refused: no sleep. ${NO_WAIT}`;
    const timeout = Number(args.timeoutMs ?? args.timeout_ms ?? 0);
    if (timeout > ROUTER_MAX_COMMAND_MS) return `Refused: timeouts above ${ROUTER_MAX_COMMAND_MS / 1000} s are not allowed here. Hand long work to a bot with bot_send_message, or run it with run_in_background. ${NO_WAIT}`;
  }
  if (name === 'job_output' && args.wait === true) {
    const timeout = args.timeout_ms === undefined ? Infinity : Number(args.timeout_ms);
    if (!(timeout <= ROUTER_MAX_JOB_WAIT_MS)) return `Refused: job waits above ${ROUTER_MAX_JOB_WAIT_MS / 1000} s are not allowed here (pass timeout_ms up to ${ROUTER_MAX_JOB_WAIT_MS}, or read without wait). ${NO_WAIT}`;
  }
  return undefined;
}

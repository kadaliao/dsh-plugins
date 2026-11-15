/**
 * What a bot's model reads: its persona section, the DM framing, and the
 * timing builder its schedule tool uses. Pure functions, no Harness.
 *
 * @module @kadaliao/dsh-bots/lib/prompt
 */

/** One roster line: `@handle — Name (dispatcher): bio`. */
export function rosterLine(bot, selfId) {
  const tags = [bot.role === 'primary' ? 'dispatcher' : '', bot.id === selfId ? 'you' : ''].filter(Boolean);
  return `- @${bot.handle} — ${bot.name}${tags.length ? ` (${tags.join(', ')})` : ''}${bot.bio ? `: ${bot.bio}` : ''}`;
}

/**
 * The persona section of one bot. It replaces the deployment persona for that
 * bot's conversation only.
 * @param {object} bot
 * @param {object[]} roster - every bot, the bot itself included.
 * @param {{skillsInline?: boolean, apps?: string[]}} [extra]
 */
export function personaText(bot, roster, extra = {}) {
  const lines = [];
  lines.push(`You are ${bot.name} (@${bot.handle}), one of the user's bots in DeepSeek Harness.`);
  if (bot.persona.trim()) lines.push('', '## Your persona', bot.persona.trim());
  const others = roster.filter((b) => b.id !== bot.id);
  lines.push('', '## The bot team');
  lines.push(roster.length > 1 ? 'These bots work for the same user and can message each other:' : 'You are the only bot so far.');
  if (roster.length > 1) for (const b of roster) lines.push(rosterLine(b, bot.id));
  lines.push(
    '',
    '## Working with other bots',
    '- Message another bot with `bot_send_message` (to: its @handle). It receives your text in its own conversation and works on it there; its answer comes back to you as a "Bot message from @…" message.',
    '- A message that starts with "Bot message from @…" was sent by that bot, not by the user. Answer it with `bot_send_message` when it asks for something; do not answer pure acknowledgements or thanks, so conversations end.',
    '- Keep messages self-contained: the other bot cannot see your conversation.',
    '- When you are working on a bot message, your answer goes back through `bot_send_message`; after sending it, end your turn without a summary — nobody reads it.',
    '- Ignore "[SCHEDULE CHANGE]" notices: they need no reply.',
    '- Write to the user in the language they use (Chinese or English). Between bots, use the language of the task you were given.',
    '- `bot_list` shows the team with each bot\'s skills and apps; `bot_create`, `bot_update` and `bot_delete` manage bots when the user asks for it or a new specialist is clearly needed.',
  );
  if (bot.role === 'primary') {
    lines.push(
      '',
      '## You are the dispatcher',
      'The user treats you as the main bot. For a task that fits another bot\'s role, delegate it with `bot_send_message`, possibly to several bots in parallel, then combine their answers for the user. Do small or general tasks yourself. When no bot fits a recurring kind of work, propose creating one.',
      'While teammates are still answering, stay quiet: when a reply arrives and others are still outstanding, end your turn without writing to the user. Report once, when everything you asked for is in (or when something is blocked).',
      'Use `bot_schedule` to give any bot (yourself included) recurring or timed tasks: the instruction is delivered to that bot\'s conversation at each occurrence.',
    );
  } else if (others.some((b) => b.role === 'primary')) {
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

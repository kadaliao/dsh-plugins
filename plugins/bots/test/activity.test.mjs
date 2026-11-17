import assert from 'node:assert/strict';
import test from 'node:test';

const { clipLine, createActivity, scrub, summarizeCall } = await import('../lib/activity.mjs');

test('a tool call reads as what it works on: a command, a file, a search, a page, the bot work goes to', () => {
  assert.deepEqual(summarizeCall('bash', JSON.stringify({ command: 'cd app\nnpm test -- --watch=false' })), { tool: 'bash', detail: 'cd app' });
  assert.deepEqual(summarizeCall('bash', { command: '\n  npm test  ' }), { tool: 'bash', detail: 'npm test' });
  assert.deepEqual(summarizeCall('read', { path: '/Users/me/src/app.ts' }), { tool: 'read', detail: 'app.ts' });
  assert.deepEqual(summarizeCall('edit', { file_path: 'C:\\work\\notes.md' }), { tool: 'edit', detail: 'notes.md' });
  assert.deepEqual(summarizeCall('web_search', { query: 'parks for kids in Beijing' }), { tool: 'web_search', detail: 'parks for kids in Beijing' });
  assert.deepEqual(summarizeCall('web_fetch', { url: 'https://example.com/a/b?token=1#x' }), { tool: 'web_fetch', detail: 'example.com/a/b' });
  assert.deepEqual(summarizeCall('mcp__tavily__tavily_search', { query: 'q' }), { tool: 'mcp__tavily__tavily_search', detail: 'q' });
  assert.deepEqual(summarizeCall('bot_send_message', { to: 'Forge', text: 'Build it' }, { handleOf: (ref) => (ref === 'Forge' ? '@forge' : '') }), { tool: 'bot_send_message', detail: '@forge' });
  assert.deepEqual(summarizeCall('bot_send_message', { to: 'scout', text: 'x' }), { tool: 'bot_send_message', detail: '@scout' });
  assert.deepEqual(summarizeCall('bot_send_message', { status: 'done', text: 'All done' }), { tool: 'bot_send_message' });
  // Tools the panel does not know show by name only: their arguments may hold anything.
  assert.deepEqual(summarizeCall('ask_user_question', { questions: [{ question: 'Blue or green?' }] }), { tool: 'ask_user_question' });
  assert.deepEqual(summarizeCall('some_mcp_tool', { password: 'hunter2', text: 'x' }), { tool: 'some_mcp_tool' });
  assert.deepEqual(summarizeCall('generate_image', { prompt: 'a fox' }), { tool: 'generate_image' });
  // Long ones are clipped.
  const long = summarizeCall('bash', { command: `echo ${'x'.repeat(200)}` });
  assert.equal([...long.detail].length, 80);
  assert.ok(long.detail.endsWith('…'));
  assert.equal(clipLine('a\n  b\tc'), 'a b c');
});

test('secrets never reach a summary: tokens the plugin knows, key shapes, and anything named like a key', () => {
  const s = (cmd, secrets) => summarizeCall('bash', { command: cmd }, { secrets }).detail;
  assert.equal(s('OPENAI_API_KEY=sk-12345678901234567890 npm test'), 'OPENAI_API_KEY=<redacted> npm test');
  assert.equal(s('curl -H "Authorization: Bearer abc.def.ghi" https://x.y'), 'curl -H "Authorization: <redacted> <redacted>" https://x.y');
  assert.equal(s('gh auth login --token abc123def'), 'gh auth login --token <redacted>');
  assert.equal(s('git push https://kada:p4ssw0rd@github.com/x/y'), 'git push https://kada:<redacted>@github.com/x/y');
  assert.equal(s('echo ghp_abcdefghijklmnop1234'), 'echo <redacted>');
  assert.equal(s('notify --chat 42 MYTELEGRAMSECRET', ['MYTELEGRAMSECRET']), 'notify --chat 42 <token>');
  // Ordinary words stay.
  assert.equal(s('git log --author kada'), 'git log --author kada');
  assert.equal(scrub('npm test'), 'npm test');
});

test('activity follows a turn: thinking, a tool with its summary, thinking again, the step count, and nothing once it ends', () => {
  let now = 1000;
  const a = createActivity({ now: () => now });
  const ev = (type, data = {}) => a.note('s1', { type, data });
  assert.equal(a.get('s1'), undefined);
  ev('turn/start', { turn: 1 });
  ev('step/start', { turn: 1, step: 1 });
  assert.deepEqual(a.get('s1'), { kind: 'thinking', startedAt: 1000, stepAt: 1000, steps: 1 });
  now = 3000;
  ev('tool/call', { callId: 'c1', name: 'bash', arguments: JSON.stringify({ command: 'npm test' }) });
  // The assistant message names the same call: it is not counted twice.
  ev('assistant/message', { message: { content: [{ type: 'tool-call', id: 'c1', name: 'bash', argsRaw: '{"command":"npm test"}' }] } });
  assert.deepEqual(a.get('s1'), { kind: 'tool', tool: 'bash', detail: 'npm test', startedAt: 1000, stepAt: 3000, steps: 1 });
  now = 9000;
  ev('tool/result', { message: { toolCallId: 'c1', content: [{ type: 'text', text: 'SECRET OUTPUT' }] } });
  assert.deepEqual(a.get('s1'), { kind: 'thinking', startedAt: 1000, stepAt: 9000, steps: 1 });
  assert.doesNotMatch(JSON.stringify(a.get('s1')), /SECRET OUTPUT/);
  ev('step/start', { turn: 1, step: 2 });
  ev('tool/call', { callId: 'c2', name: 'read', arguments: '{"path":"/a/b/c.md"}' });
  ev('tool/call', { callId: 'c3', name: 'web_search', arguments: '{"query":"cats"}' });
  assert.equal(a.get('s1').detail, 'cats', 'the latest call shows');
  ev('tool/result', { message: { toolCallId: 'c3' } });
  assert.equal(a.get('s1').detail, 'c.md', 'then the one still running');
  ev('tool/result', { message: { toolCallId: 'c2' } });
  ev('step/start', { turn: 1, step: 3 });
  now = 12000;
  ev('assistant/message', { message: { content: [{ type: 'text', text: 'Here you go.' }] } });
  assert.deepEqual(a.get('s1'), { kind: 'writing', startedAt: 1000, stepAt: 12000, steps: 3 });
  assert.deepEqual(a.sessions(), ['s1']);
  ev('turn/end', { turn: 1, reason: { kind: 'completed' } });
  assert.equal(a.get('s1'), undefined);
  // A turn this process joined midway (no turn/start), counted by its assistant messages; an idle Agent clears it.
  a.note('s2', { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', name: 'bot_send_message', argsRaw: '{"to":"@forge","text":"x"}' }] } } });
  assert.deepEqual(a.get('s2'), { kind: 'tool', tool: 'bot_send_message', detail: '@forge', startedAt: 12000, stepAt: 12000, steps: 1 });
  a.clear('s2');
  assert.equal(a.get('s2'), undefined);
});

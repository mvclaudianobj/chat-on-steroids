// A fake `claude -p --input-format stream-json --output-format stream-json` for the Claude engine
// tests: no model, no network. It logs its argv and every stdin line to FAKE_CLAUDE_LOG, answers
// `initialize` and `interrupt`, and plays a scenario chosen by the user message's text.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const log = (entry) => { if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify({ pid: process.pid, ...entry })}\n`); };
const out = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const argv = process.argv.slice(2);
log({ argv, cwd: process.cwd() });

const flag = (name) => argv.find(item => item.startsWith(`${name}=`))?.slice(name.length + 1) ?? null;
const sessionId = flag('--resume') ?? flag('--session-id');
const missing = (process.env.FAKE_CLAUDE_MISSING ?? '').split(',').filter(Boolean);
if (flag('--resume') && missing.includes(sessionId)) {
  process.stderr.write(`No conversation found with session ID: ${sessionId}\n`);
  process.exit(1);
}

const waiting = new Map();
const ask = (requestId, request) => new Promise(resolve => {
  waiting.set(requestId, resolve);
  out({ type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', ...request } });
});
const assistant = (content) => out({ type: 'assistant', message: { id: `msg_${Math.random().toString(16).slice(2)}`, role: 'assistant', content }, parent_tool_use_id: null, session_id: sessionId });
const toolResult = (id, content, isError = false) => out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] }, parent_tool_use_id: null, session_id: sessionId });
const delta = (text) => out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }, parent_tool_use_id: null, session_id: sessionId });
const result = (extra = {}) => out({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId, total_cost_usd: 0.01,
  usage: { input_tokens: 100, cache_read_input_tokens: 50, cache_creation_input_tokens: 10, output_tokens: 20 }, result: 'Done.', ...extra });
const allowed = (response) => response?.behavior === 'allow';

async function play(text) {
  out({ type: 'system', subtype: 'init', session_id: sessionId, model: 'claude-fable-5', permissionMode: process.env.FAKE_CLAUDE_MODE ?? 'default', tools: ['Bash', 'Edit', 'Read'], cwd: process.cwd() });
  if (text === 'crash') {
    process.stderr.write('fatal: boom while reading ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789\n');
    process.exit(3);
  }
  if (text === 'fail') { result({ subtype: 'error_during_execution', is_error: true, result: '', errors: ['API Error: 529 overloaded'] }); return; }
  if (text === 'plain') { delta('Hi'); delta(' there.'); assistant([{ type: 'text', text: 'Hi there.' }]); result(); return; }
  if (text === 'full') {
    delta('Let me run'); delta(' the tests.');
    assistant([{ type: 'text', text: 'Let me run the tests.' }]);
    const bash = { command: 'npm test', description: 'Run the tests' };
    assistant([{ type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: bash }]);
    const first = await ask('req-bash', { tool_name: 'Bash', input: bash, tool_use_id: 'toolu_bash',
      permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }], behavior: 'allow', destination: 'localSettings' },
        { type: 'setMode', mode: 'acceptEdits', destination: 'session' }] });
    toolResult('toolu_bash', allowed(first) ? '3 passed' : 'The user doesn\'t want to proceed with this tool use.', !allowed(first));
    const edit = { file_path: `${process.cwd()}/src/sum.ts`, old_string: 'a - b', new_string: 'a + b' };
    assistant([{ type: 'tool_use', id: 'toolu_edit', name: 'Edit', input: edit }]);
    const second = await ask('req-edit', { tool_name: 'Edit', input: edit, tool_use_id: 'toolu_edit', permission_suggestions: [] });
    toolResult('toolu_edit', allowed(second) ? 'The file was updated.' : 'denied', !allowed(second));
    assistant([{ type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: `${process.cwd()}/README.md` } }]);
    toolResult('toolu_read', '# App');
    delta('Fixed.');
    assistant([{ type: 'text', text: 'Fixed the sign.' }]);
    result();
    return;
  }
  if (text === 'cancel') {
    assistant([{ type: 'tool_use', id: 'toolu_c', name: 'Bash', input: { command: 'ls' } }]);
    out({ type: 'control_request', request_id: 'req-c', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 'toolu_c' } });
    await new Promise(resolve => setTimeout(resolve, Number(process.env.FAKE_CLAUDE_CANCEL_MS ?? 300)));
    out({ type: 'control_cancel_request', request_id: 'req-c' });
    toolResult('toolu_c', 'Cancelled', true);
    result();
    return;
  }
  if (text === 'hang') {
    assistant([{ type: 'tool_use', id: 'toolu_h', name: 'Bash', input: { command: 'sleep 100' } }]);
    // Waits until the host answers or interrupts (the interrupt answers it with null).
    await ask('req-h', { tool_name: 'Bash', input: { command: 'sleep 100' }, tool_use_id: 'toolu_h' });
    return;
  }
  delta(`echo: ${text}`);
  result();
}

createInterface({ input: process.stdin }).on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  log({ in: message });
  if (message.type === 'control_request' && message.request?.subtype === 'initialize') {
    out({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: { commands: [], models: [] } } });
  } else if (message.type === 'control_request' && message.request?.subtype === 'interrupt') {
    out({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {} } });
    for (const resolve of waiting.values()) resolve(null);
    waiting.clear();
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sessionId, result: '' });
  } else if (message.type === 'control_response') {
    const id = message.response?.request_id;
    waiting.get(id)?.(message.response?.response ?? null);
    waiting.delete(id);
  } else if (message.type === 'user') {
    const text = message.message?.content?.find?.(block => block.type === 'text')?.text ?? '';
    void play(text);
  }
}).on('close', () => process.exit(0));

import { describe, expect, it } from 'vitest';
import { cliEvent, headlessArgs } from '../src/main/cli-chat-protocol.js';

describe('CLI headless protocol projection', () => {
  it('sends the prompt via stdin, resumes only explicit backend sessions and never bypasses approvals', () => {
    expect(headlessArgs('codex', null)).toEqual(['exec', '--json', '--skip-git-repo-check', '-']);
    expect(headlessArgs('codex', 'previous')).toEqual(['exec', 'resume', '--json', 'previous', '-']);
    expect(headlessArgs('markscode', 'previous')).toContain('--session');
    expect(headlessArgs('claude', 'previous')).toContain('--resume');
    for (const backend of ['codex', 'markscode', 'claude'] as const) {
      const args = headlessArgs(backend, null).join(' ');
      expect(args).not.toContain('dangerously');
      expect(args).not.toContain('--auto');
    }
  });
  it('parses Codex thread and agent messages without showing tools/reasoning/errors', () => {
    expect(cliEvent('codex', JSON.stringify({ type: 'thread.started', thread_id: '0199a213-81c0-7800-8aa1-bbab2a035a53' }))).toEqual({ sessionId: '0199a213-81c0-7800-8aa1-bbab2a035a53' });
    expect(cliEvent('codex', JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Done.' } }))).toEqual({ text: 'Done.' });
    for (const type of ['command_execution', 'reasoning', 'mcp_tool_call', 'file_change']) {
      expect(cliEvent('codex', JSON.stringify({ type: 'item.completed', item: { type, text: 'SECRET' } }))).toEqual({});
    }
    expect(cliEvent('codex', JSON.stringify({ type: 'error', message: 'SECRET key' }))).toEqual({ failure: 'Codex reported a failed turn.' });
  });
  it('projects MarksCode finished text and session ID only', () => {
    expect(cliEvent('markscode', JSON.stringify({ type: 'text', sessionID: 'session_abcdefgh', part: { type: 'text', text: 'Olá', state: { output: 'SECRET' } } }))).toEqual({ sessionId: 'session_abcdefgh', text: 'Olá' });
    expect(cliEvent('markscode', JSON.stringify({ type: 'tool_use', sessionID: 'session_abcdefgh', part: { text: 'SECRET' } }))).toEqual({ sessionId: 'session_abcdefgh' });
  });
  it('projects Claude content, result and verified session metadata only', () => {
    expect(cliEvent('claude', JSON.stringify({ type: 'system', subtype: 'init', session_id: '0199a213-81c0-7800-8aa1-bbab2a035a53' }))).toEqual({ sessionId: '0199a213-81c0-7800-8aa1-bbab2a035a53' });
    expect(cliEvent('claude', JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Answer' }, { type: 'tool_use', name: 'Bash', input: { secret: 'SECRET' } }] } }))).toEqual({ text: 'Answer' });
    expect(cliEvent('claude', JSON.stringify({ type: 'result', is_error: true, result: 'SECRET' }))).toEqual({ failure: 'Claude reported a failed turn.' });
    expect(cliEvent('claude', '{bad json')).toEqual({});
  });
});

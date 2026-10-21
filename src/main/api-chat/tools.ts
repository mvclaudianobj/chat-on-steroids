/**
 * Chat Marks D4: the app's own Core tools for API chats, as OpenAI-style function tools.
 *
 * Nothing here is a second tool implementation. The list is built per request from the live
 * settings through the same registrar the Core connector uses, and every call runs in-process
 * through the kernel's `dispatch` (flagged `local`), so blocked chats, strict Trust, superseded
 * chats, capabilities, Read-only, approved roots, the command allowlist and exec custody apply
 * exactly as for ChatGPT, and the kernel records the tool row with the exact delivered content.
 *
 * Identity never comes from the model: the executor mints `cosapi:<uuid>` per turn (a colon,
 * which HTTP ingress `requestIdFromHeader` never accepts, so no connector request can carry
 * it) and correlates it to the chat's exact conversation and session before the first call.
 */
import type { z } from 'zod';
import { effectiveCapabilities, getConfig } from '../config.js';
import { createRegistrar, dispatch, type SurfaceRegistrar, type ToolContext, type ToolResult } from '../mcp/kernel.js';
import { registerCoreTools } from '../mcp/tools-core.js';
import { toolSchemaJson } from '../mcp/tool-declarations.js';
import { commitRequestCorrelations, observeRequestCorrelation, requestCorrelation } from '../session/correlation.js';
import { withManagedSkills } from '../skill-access.js';
import { argsHash, canonicalJson } from '../agent-engine/approval.js';
import type { ApiToolCall, ApiToolDefinition } from './client.js';

/** v1 allowlist, by the exact registered names. Agents, finish, images, usage and code mode stay out. */
export const API_CHAT_TOOL_NAMES = ['read', 'find', 'apply_patch', 'exec_command', 'write_stdin', 'update_plan'] as const;
/** Tools that change files or run programs: these follow the chat's approval mode. */
export const API_CHAT_MUTATING_TOOLS: ReadonlySet<string> = new Set(['apply_patch', 'exec_command', 'write_stdin']);
/** What one tool result may put back into the model's context. */
export const MAX_TOOL_RESULT_CHARS = 100_000;
const MAX_SUMMARY_CHARS = 600;
const MAX_SUMMARY_FILES = 20;

export interface ApiChatTool {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  handler: (args: never) => Promise<ToolResult>;
}

/** The same live context the Core endpoint gives its handlers; workers are never offered. */
export function liveToolContext(): ToolContext {
  const config = getConfig();
  return withManagedSkills({
    roots: config.roots,
    caps: effectiveCapabilities(config),
    readOnly: config.readOnly,
    privacyScreenshots: config.ui.privacyScreenshots,
    agentTools: false
  });
}

/**
 * The offered tools under the current settings. With no `exposedCaps` the registrar exposes
 * exactly the live capabilities, so a disabled permission means the tool is not offered.
 */
export function apiChatTools(ctx: ToolContext = liveToolContext()): Map<string, ApiChatTool> {
  const registrar = createRegistrar(null, ctx, 'core');
  const tools = new Map<string, ApiChatTool>();
  const allowed = new Set<string>(API_CHAT_TOOL_NAMES);
  const capture: SurfaceRegistrar = {
    ...registrar,
    register(name, config, handler) {
      registrar.register(name, config, handler);
      if (allowed.has(name)) tools.set(name, { name, description: config.description, inputSchema: config.inputSchema, handler: handler as ApiChatTool['handler'] });
    }
  };
  registerCoreTools(capture);
  return tools;
}

export function toolDefinitions(tools: Map<string, ApiChatTool>): ApiToolDefinition[] {
  return [...tools.values()].map(tool => {
    const { $schema: _schema, ...schema } = toolSchemaJson(tool.inputSchema) as Record<string, unknown>;
    void _schema;
    return { type: 'function', function: { name: tool.name, description: tool.description, parameters: { type: 'object', ...schema } } };
  });
}

// The approval binding is shared by every engine (agent-engine/approval.ts).
export { argsHash, canonicalJson };

const clip = (text: string, max = MAX_SUMMARY_CHARS): string => text.length > max ? `${text.slice(0, max)}…` : text;

/** Readable, bounded description of a mutating call for the approval card. */
export function approvalSummary(name: string, args: Record<string, unknown>): { summary: string; files: string[] } {
  if (name === 'apply_patch') {
    const patch = typeof args.patch === 'string' ? args.patch : '';
    const files: string[] = [];
    for (const line of patch.split(/\r?\n/)) {
      const match = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line) ?? /^\*\*\* (Move) to: (.+)$/.exec(line);
      if (match && files.length < MAX_SUMMARY_FILES) files.push(`${match[1]!.toLowerCase()} ${clip(match[2]!.trim(), 200)}`);
    }
    return { summary: clip(`${patch.split(/\r?\n/).length} patch lines`), files };
  }
  if (name === 'exec_command') {
    const commands = Array.isArray(args.cmds) ? args.cmds.filter((item): item is string => typeof item === 'string') : [];
    const text = typeof args.cmd === 'string' ? args.cmd : commands.join('\n');
    const where = typeof args.workdir === 'string' && args.workdir ? `\n(in ${clip(args.workdir, 200)})` : '';
    return { summary: clip(text) + where, files: [] };
  }
  if (name === 'write_stdin') {
    const chars = typeof args.chars === 'string' ? args.chars : '';
    return { summary: clip(`Terminal ${String(args.session_id ?? '?')}: ${JSON.stringify(chars)}`), files: [] };
  }
  return { summary: clip(canonicalJson(args)), files: [] };
}

/** A poll (no input) changes nothing, so only real input to a terminal needs approval. */
export function needsApproval(name: string, args: Record<string, unknown>): boolean {
  if (!API_CHAT_MUTATING_TOOLS.has(name)) return false;
  if (name === 'write_stdin') return typeof args.chars === 'string' && args.chars.length > 0;
  return true;
}

export type ParsedToolCall =
  | { ok: true; tool: ApiChatTool; args: Record<string, unknown>; data: unknown }
  | { ok: false; error: string };

/** Unknown names, malformed JSON and schema violations become error results, never crashes. */
export async function parseToolCall(call: ApiToolCall, tools: Map<string, ApiChatTool>): Promise<ParsedToolCall> {
  const tool = tools.get(call.function.name);
  if (!tool) {
    return { ok: false, error: `UNKNOWN_TOOL: ${clip(call.function.name, 100)} is not available in this chat. Available tools: ${[...tools.keys()].join(', ') || 'none'}.` };
  }
  let args: unknown;
  try {
    args = JSON.parse(call.function.arguments || '{}');
  } catch {
    return { ok: false, error: 'INVALID_ARGUMENTS: the arguments are not valid JSON. Send one JSON object that matches the tool schema.' };
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { ok: false, error: 'INVALID_ARGUMENTS: the arguments must be a JSON object.' };
  const parsed = await tool.inputSchema.safeParseAsync(args);
  if (!parsed.success) {
    const details = parsed.error.issues.slice(0, 3).map(issue =>
      `${issue.path.map(String).join('.').slice(0, 80) || 'arguments'}: ${issue.message.slice(0, 300)}`).join('; ');
    return { ok: false, error: `INVALID_ARGUMENTS: ${details}` };
  }
  return { ok: true, tool, args: args as Record<string, unknown>, data: parsed.data };
}

/** The exact delivered text for the model: text parts as delivered, images as a short note. */
export function resultText(result: ToolResult): string {
  const parts = result.content.map(part => part.type === 'text' ? part.text : `[${part.mimeType} image omitted: this chat's model receives text only]`);
  const text = parts.join('\n') || (result.isError ? 'The tool failed without a message.' : 'Done.');
  return text.length > MAX_TOOL_RESULT_CHARS
    ? `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n…[${text.length - MAX_TOOL_RESULT_CHARS} more characters not shown; ask for a narrower range]`
    : text;
}

export interface ApiChatCaller { requestId: string; conversationId: string; sessionId: string; messageId: string }

/**
 * Files the turn's request id under the chat's exact conversation and session (first proof
 * wins, durable before use). A refusal means another owner holds it: never run under it.
 */
export async function correlateCaller(caller: ApiChatCaller): Promise<void> {
  const owner = requestCorrelation(caller.requestId);
  if (owner) {
    if (owner.conversationId !== caller.conversationId || owner.sessionId !== caller.sessionId) throw new Error('API chat request identity is owned elsewhere');
    return;
  }
  const result = observeRequestCorrelation({
    requestId: caller.requestId, conversationId: caller.conversationId, sessionId: caller.sessionId,
    messageId: caller.messageId, tool: 'api-chat', observedAt: Date.now()
  });
  if (result === 'refused') throw new Error('API chat request identity is owned elsewhere');
  await commitRequestCorrelations();
}

/** Runs one validated call through the kernel, as the chat's exact caller. */
export async function runApiChatTool(caller: ApiChatCaller, parsed: Extract<ParsedToolCall, { ok: true }>): Promise<{ text: string; isError: boolean }> {
  await correlateCaller(caller);
  try {
    const result = await dispatch(parsed.tool.name, parsed.args, null, caller.requestId, 'core',
      () => parsed.tool.handler(parsed.data as never), undefined, null, { local: true });
    return { text: resultText(result), isError: result.isError === true };
  } catch (error) {
    return { text: `TOOL_FAILED: ${clip(error instanceof Error ? error.message : String(error), 1000)}`, isError: true };
  }
}

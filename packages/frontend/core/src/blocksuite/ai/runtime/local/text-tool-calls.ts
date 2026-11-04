import type { LocalAiToolCall } from '@affine/electron-api';

/**
 * Small local models sometimes write a tool call into the answer text instead
 * of returning it as a structured call — typically Hermes style
 * `<tool_call>{"name": …, "arguments": {…}}</tool_call>`, often with a
 * closing brace missing, which makes the server-side parser give up. These
 * helpers recognise such answers so they can still be run as tool calls.
 */

const OPENERS = ['<tool_call>', '```json', '```', '{'];

/**
 * Whether the answer so far may still turn out to be a text tool call; used to
 * hold back streaming it to the user until that is clear.
 */
export function mayBeTextToolCall(text: string) {
  const head = text.trimStart();
  if (!head) return true;
  return OPENERS.some(
    opener => head.startsWith(opener) || opener.startsWith(head)
  );
}

/** Close strings, objects and arrays that the model left open. */
export function repairJson(source: string) {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const char of source) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') stack.push('}');
    else if (char === '[') stack.push(']');
    else if ((char === '}' || char === ']') && stack.at(-1) === char) {
      stack.pop();
    }
  }
  return source + (inString ? '"' : '') + stack.reverse().join('');
}

function parseLenient(source: string): unknown {
  const text = source.trim();
  try {
    return JSON.parse(text);
  } catch {
    // fall through
  }
  try {
    return JSON.parse(repairJson(text));
  } catch {
    return null;
  }
}

/**
 * Parse an answer that consists only of tool calls written as text. Returns an
 * empty list when the answer is anything else, or names an unknown tool.
 */
export function parseTextToolCalls(
  text: string,
  toolNames: ReadonlySet<string>
): LocalAiToolCall[] {
  let body = text.trim();
  if (!body) return [];
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*(?:```)?$/.exec(body);
  if (fenced) body = fenced[1];

  const chunks = body.includes('<tool_call>')
    ? body
        .split('<tool_call>')
        .map(chunk => chunk.replace(/<\/tool_call>[\s\S]*$/, ''))
    : [body.replace(/<\/tool_call>\s*$/, '')];

  const calls: LocalAiToolCall[] = [];
  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    const parsed = parseLenient(chunk) as {
      name?: unknown;
      arguments?: unknown;
      parameters?: unknown;
    } | null;
    const name = typeof parsed?.name === 'string' ? parsed.name : '';
    if (!name || !toolNames.has(name)) return [];
    const args = parsed?.arguments ?? parsed?.parameters ?? {};
    calls.push({
      id: `text-call-${Date.now().toString(36)}-${calls.length}`,
      type: 'function',
      function: {
        name,
        arguments: typeof args === 'string' ? args : JSON.stringify(args),
      },
    });
  }
  return calls;
}

import { describe, expect, test } from 'vitest';

import {
  mayBeTextToolCall,
  parseTextToolCalls,
  repairJson,
} from './text-tool-calls';

const tools = new Set(['database_create', 'doc_read']);

describe('tool calls written as text', () => {
  test('parses a Hermes-style call with a missing closing brace', () => {
    // the exact shape qwen2.5:3b produced in a live run
    const text =
      '{"name": "database_create", "arguments": {"doc_id": "d1", "title": "Budget", "columns": [{"name": "Price", "type": "number"}], "rows": [{"title": "Milk", "values": {"Price": "2"}}]}\n</tool_call>';
    const calls = parseTextToolCalls(text, tools);
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe('database_create');
    expect(JSON.parse(calls[0].function.arguments)).toEqual({
      doc_id: 'd1',
      title: 'Budget',
      columns: [{ name: 'Price', type: 'number' }],
      rows: [{ title: 'Milk', values: { Price: '2' } }],
    });
  });

  test('parses several tagged calls and fenced json', () => {
    const tagged =
      '<tool_call>\n{"name": "doc_read", "arguments": {"doc_id": "a"}}\n</tool_call>\n<tool_call>\n{"name": "doc_read", "arguments": {"doc_id": "b"}}\n</tool_call>';
    expect(
      parseTextToolCalls(tagged, tools).map(c => c.function.arguments)
    ).toEqual(['{"doc_id":"a"}', '{"doc_id":"b"}']);
    const fenced =
      '```json\n{"name": "doc_read", "parameters": {"doc_id": "c"}}\n```';
    expect(parseTextToolCalls(fenced, tools)[0].function.arguments).toBe(
      '{"doc_id":"c"}'
    );
  });

  test('ignores ordinary answers and unknown tools', () => {
    expect(parseTextToolCalls('Here is your list.', tools)).toEqual([]);
    expect(
      parseTextToolCalls('{"name": "rm_rf", "arguments": {}}', tools)
    ).toEqual([]);
    expect(
      parseTextToolCalls(
        'Sure! <tool_call>{"name": "doc_read", "arguments": {}}</tool_call>',
        tools
      )
    ).toEqual([]);
  });

  test('holds back only text that may still become a call', () => {
    expect(mayBeTextToolCall('')).toBe(true);
    expect(mayBeTextToolCall('  <tool_')).toBe(true);
    expect(mayBeTextToolCall('{"name"')).toBe(true);
    expect(mayBeTextToolCall('Hello')).toBe(false);
  });

  test('repairJson closes strings and brackets', () => {
    expect(JSON.parse(repairJson('{"a": [1, {"b": "x'))).toEqual({
      a: [1, { b: 'x' }],
    });
  });
});

import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'sociomem-scripted-test-model';
export const inject = ['llm', 'tools'];

function textOf(message) {
  return (message.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
}

function* textResponse(text) {
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'text-delta', index: 0, text };
  yield { type: 'block-end', index: 0, block: { type: 'text', text } };
  yield { type: 'finish', reason: { kind: 'stop' } };
}

// A test fixture, not an intelligent model or a replacement Agent Loop.
class ScriptedModel extends LlmAdapter {
  async resolveModel(provider, model) {
    return { provider, id: model, name: 'Offline scripted fixture', contextWindow: 32768 };
  }

  async *stream(request) {
    request.signal?.throwIfAborted();
    const prompt = request.messages.filter(message => message.role === 'user')
      .map(textOf).findLast(text => text.startsWith('[test]')) ?? '';
    appendFileSync(join(process.env.SOCIOMEM_RUN_ROOT, 'model-calls.jsonl'), `${JSON.stringify({
      prompt, tools: request.tools?.map(tool => tool.name) ?? [],
    })}\n`);
    if (request.messages.at(-1)?.role === 'tool') {
      const tool = request.messages.at(-1);
      yield* textResponse(tool.isError ? `TOOL_ERROR: ${textOf(tool)}` : `CONTEXT_OK: ${textOf(tool)}`);
      return;
    }
    if (prompt.includes('recall-marker')) {
      const history = request.messages.filter(message => message.role === 'user').map(textOf).join('\n');
      yield* textResponse(history.includes('marker=phase1-persisted') ? 'RESTORED_MARKER_FOUND' : 'RESTORED_MARKER_MISSING');
      return;
    }
    const toolName = prompt.includes('diary-search') ? 'sociomem_diary_search' :
      prompt.includes('recent-messages') ? 'sociomem_recent_messages' :
      prompt.includes('memory-search') ? 'sociomem_memory_search' :
      prompt.includes('bad-output') ? 'fixture_bad_output' :
      prompt.includes('forbidden-tool') ? 'bash' : 'sociomem_context';
    const args = prompt.includes('diary-search') ? { groupId: prompt.includes('diary-cross-group') ? 'other@chatroom' : process.env.SOCIOMEM_GROUP_ID,
      query: '周末聚会' } :
      prompt.includes('recent-messages') ? { groupId: prompt.includes('recent-cross-group') ? 'other@chatroom' : process.env.SOCIOMEM_GROUP_ID } :
      prompt.includes('memory-search') ? { groupId: prompt.includes('memory-cross-group') ? 'other@chatroom' : process.env.SOCIOMEM_GROUP_ID,
      query: '成员甲周末游泳' } :
      prompt.includes('bad-input') ? { groupId: 42 } :
      prompt.includes('cross-group') ? { groupId: 'other-group' } : { groupId: process.env.SOCIOMEM_GROUP_ID ?? 'demo-group' };
    const id = ToolCallId(randomUUID());
    const argumentsJson = JSON.stringify(args);
    yield { type: 'block-start', index: 0, blockType: 'tool-call' };
    yield { type: 'tool-call-delta', index: 0, id, name: toolName, argumentsDelta: argumentsJson };
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: toolName, arguments: argumentsJson } };
    yield { type: 'finish', reason: { kind: 'tool-calls' } };
  }
}

export function apply(ctx) {
  ctx.llm.registerAdapter(['sociomem-test'], new ScriptedModel());
  ctx.on('agent/created', ({ agent }) => {
    agent.ctx.tools.register(defineTool({
      name: 'fixture_bad_output', description: 'Test-only malformed output fixture.',
      parameters: { groupId: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute() { return 123; },
    }));
  });
}

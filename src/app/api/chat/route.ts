import { NextRequest } from 'next/server';
import { route } from '@/lib/orchestrator';
import { ChatMessage } from '@/providers/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ChatRequestBody {
  messages: ChatMessage[];
  expected_tokens?: number;
  is_code?: boolean;
}

function isValidMessages(value: unknown): value is ChatMessage[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every(
    (m) =>
      typeof m === 'object' &&
      m !== null &&
      typeof m.role === 'string' &&
      ['system', 'user', 'assistant'].includes(m.role) &&
      (typeof m.content === 'string' || Array.isArray(m.content)),
  );
}

export async function POST(req: NextRequest): Promise<Response> {
  let body: ChatRequestBody;

  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!isValidMessages(body?.messages)) {
    return new Response(
      JSON.stringify({ error: 'messages must be a non-empty array of {role, content} objects' }),
      { status: 422, headers: { 'Content-Type': 'application/json' } },
    );
  }

  try {
    const { stream } = await route(body.messages, body.expected_tokens, body.is_code);

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal gateway error';
    return new Response(JSON.stringify({ error: message }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

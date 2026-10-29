import Anthropic from '@anthropic-ai/sdk';
import { platformFetch } from '../common/http';

export interface AiSource {
  id: string; // mã ngắn S1, S2... đưa cho mô hình
  chunkId: string;
  documentId: string;
  title: string;
  version: number;
  content: string;
}

export interface AiRequest {
  model: string;
  maxOutputTokens: number;
  system: string;
  /** Nội dung người dùng đã được bọc thẻ dữ liệu */
  user: string;
  apiKey?: string;
  baseUrl?: string | null;
  sources: AiSource[];
  customerText: string;
}

export interface AiDecision {
  action: 'reply' | 'clarify' | 'handoff';
  reply: string;
  used_source_ids: string[];
  reason: string;
}

export interface AiResult {
  decision: AiDecision;
  inputTokens: number;
  outputTokens: number;
}

export interface AiProvider {
  generate(req: AiRequest): Promise<AiResult>;
}

const DECISION_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['reply', 'clarify', 'handoff'] },
    reply: { type: 'string' },
    used_source_ids: { type: 'array', items: { type: 'string' } },
    reason: { type: 'string' },
  },
  required: ['action', 'reply', 'used_source_ids', 'reason'],
  additionalProperties: false,
};

export function parseDecision(text: string): AiDecision {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Phản hồi AI không đúng định dạng JSON');
  const d = JSON.parse(m[0]);
  if (!['reply', 'clarify', 'handoff'].includes(d.action)) throw new Error('Hành động AI không hợp lệ');
  return { action: d.action, reply: String(d.reply ?? ''), used_source_ids: Array.isArray(d.used_source_ids) ? d.used_source_ids.map(String) : [], reason: String(d.reason ?? '') };
}

/** Claude (Anthropic) qua SDK chính thức, có structured output và fallback phía máy chủ khi bị từ chối. */
export class AnthropicProvider implements AiProvider {
  async generate(req: AiRequest): Promise<AiResult> {
    const client = new Anthropic({ apiKey: req.apiKey, baseURL: req.baseUrl || undefined, timeout: 60_000, maxRetries: 1 });
    const response = await client.beta.messages.create({
      model: req.model,
      max_tokens: req.maxOutputTokens,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: req.system,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: DECISION_SCHEMA } },
      messages: [{ role: 'user', content: req.user }],
    } as any);
    if (response.stop_reason === 'refusal') {
      return { decision: { action: 'handoff', reply: '', used_source_ids: [], reason: 'Mô hình từ chối trả lời' }, inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
    }
    const text = response.content.map((b: any) => (b.type === 'text' ? b.text : '')).join('');
    return { decision: parseDecision(text), inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
  }
}

/** Nhà cung cấp tương thích OpenAI Chat Completions (OpenAI, Groq, ...). */
export class OpenAICompatibleProvider implements AiProvider {
  async generate(req: AiRequest): Promise<AiResult> {
    const base = (req.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
    const r = await platformFetch(`${base}/chat/completions`, {
      method: 'POST',
      timeoutMs: 60_000,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${req.apiKey ?? ''}` },
      body: JSON.stringify({
        model: req.model,
        max_tokens: req.maxOutputTokens,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
      }),
    });
    if (r.kind !== 'response') throw new Error(`Không gọi được nhà cung cấp AI (${r.kind})`);
    if (r.status >= 400) throw new Error(`Nhà cung cấp AI trả lỗi ${r.status}`);
    const text = r.body?.choices?.[0]?.message?.content ?? '';
    return { decision: parseDecision(text), inputTokens: r.body?.usage?.prompt_tokens ?? 0, outputTokens: r.body?.usage?.completion_tokens ?? 0 };
  }
}

/**
 * Nhà cung cấp mô phỏng cho demo/kiểm thử: không gọi mạng, trả lời bằng nguyên văn đoạn tài liệu
 * khớp nhất. Đủ để kiểm chứng luồng nguồn trích dẫn, duyệt nháp và tự gửi.
 */
export class MockProvider implements AiProvider {
  /** Cho phép kiểm thử chèn độ trễ / kết quả. */
  static hook: ((req: AiRequest) => Promise<AiResult | void>) | null = null;

  async generate(req: AiRequest): Promise<AiResult> {
    if (MockProvider.hook) {
      const r = await MockProvider.hook(req);
      if (r) return r;
    }
    const best = req.sources[0];
    if (!best) return { decision: { action: 'handoff', reply: '', used_source_ids: [], reason: 'Không có tài liệu phù hợp' }, inputTokens: 0, outputTokens: 0 };
    const excerpt = best.content.replace(/^(Q|Hỏi)\s*:.*\n/i, '').replace(/^(A|Đáp|Trả lời)\s*:\s*/im, '').trim().slice(0, 500);
    return { decision: { action: 'reply', reply: `Dạ, ${excerpt}`, used_source_ids: [best.id], reason: 'Mô phỏng: dùng đoạn tài liệu khớp nhất' }, inputTokens: 0, outputTokens: 0 };
  }
}

import { ChatMessage, ContentPart } from '@/providers/types';

export type GuardrailAction = 'block' | 'redact';

export interface GuardrailRule {
  id: string;
  pattern: RegExp;
  replacement: string;
  action: GuardrailAction;
}

export interface GuardrailViolation {
  ruleId: string;
  action: GuardrailAction;
  count: number;
}

export interface GuardrailResult {
  messages: ChatMessage[];
  blocked: boolean;
  blockReason?: string;
  violations: GuardrailViolation[];
  redacted: boolean;
}

const RULES: GuardrailRule[] = [
  {
    id: 'openai-key',
    pattern: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
    replacement: '[REDACTED:API_KEY]',
    action: 'redact',
  },
  {
    id: 'anthropic-key',
    pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g,
    replacement: '[REDACTED:API_KEY]',
    action: 'redact',
  },
  {
    id: 'gemini-key',
    pattern: /AIza[0-9A-Za-z_-]{35}/g,
    replacement: '[REDACTED:API_KEY]',
    action: 'redact',
  },
  {
    id: 'groq-key',
    pattern: /gsk_[A-Za-z0-9]{20,}/g,
    replacement: '[REDACTED:API_KEY]',
    action: 'redact',
  },
  {
    id: 'generic-bearer',
    pattern: /Bearer\s+[A-Za-z0-9\-._~+/]{20,}={0,2}/g,
    replacement: 'Bearer [REDACTED:TOKEN]',
    action: 'redact',
  },
  {
    id: 'jwt',
    pattern: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    replacement: '[REDACTED:JWT]',
    action: 'redact',
  },
  {
    id: 'aws-access-key',
    pattern: /\b(?:AKIA|ASIA|AROA|AIPA|ANPA|ANVA|APKA)[A-Z0-9]{16}\b/g,
    replacement: '[REDACTED:AWS_KEY]',
    action: 'redact',
  },
  {
    id: 'aws-secret',
    pattern: /(?<=[^A-Za-z0-9/+]|^)[A-Za-z0-9/+]{40}(?=[^A-Za-z0-9/+]|$)/g,
    replacement: '[REDACTED:AWS_SECRET]',
    action: 'redact',
  },
  {
    id: 'private-key-block',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
    replacement: '[REDACTED:PRIVATE_KEY]',
    action: 'redact',
  },
  {
    id: 'email',
    pattern: /\b[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    replacement: '[REDACTED:EMAIL]',
    action: 'redact',
  },
  {
    id: 'ssn',
    pattern: /\b(?!000|666|9\d{2})\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g,
    replacement: '[REDACTED:SSN]',
    action: 'redact',
  },
  {
    id: 'credit-card',
    pattern: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|3(?:0[0-5]|[68][0-9])[0-9]{11}|6(?:011|5[0-9]{2})[0-9]{12}|(?:2131|1800|35\d{3})\d{11})\b/g,
    replacement: '[REDACTED:CARD]',
    action: 'redact',
  },
  {
    id: 'phone-e164',
    pattern: /\+[1-9]\d{1,3}[-.\s]?\(?\d{1,4}\)?[-.\s]?\d{1,4}[-.\s]?\d{1,9}/g,
    replacement: '[REDACTED:PHONE]',
    action: 'redact',
  },
  {
    id: 'ipv4-private',
    pattern: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/g,
    replacement: '[REDACTED:INTERNAL_IP]',
    action: 'redact',
  },
  {
    id: 'prompt-injection-ignore',
    pattern: /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions?/gi,
    replacement: '[BLOCKED:INJECTION]',
    action: 'block',
  },
  {
    id: 'prompt-injection-system',
    pattern: /\[(?:SYSTEM|INST|HUMAN|ASSISTANT)\].*?\[\/(?:SYSTEM|INST|HUMAN|ASSISTANT)\]/gs,
    replacement: '[BLOCKED:INJECTION]',
    action: 'block',
  },
  {
    id: 'prompt-injection-jailbreak',
    pattern: /(?:do\s+anything\s+now|DAN\s+mode|jailbreak(?:ed)?|pretend\s+(?:you\s+(?:are|have\s+no)\s+rules|there\s+are\s+no\s+restrictions))/gi,
    replacement: '[BLOCKED:INJECTION]',
    action: 'block',
  },
];

const ENABLED_RULES: GuardrailRule[] = (() => {
  const disabledIds = new Set(
    (process.env.GUARDRAIL_DISABLED_RULES ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return RULES.filter((r) => !disabledIds.has(r.id));
})();

const BLOCK_RULES = ENABLED_RULES.filter((r) => r.action === 'block');
const REDACT_RULES = ENABLED_RULES.filter((r) => r.action === 'redact');

function extractTextContent(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

function applyRedactRules(text: string): { result: string; violations: GuardrailViolation[] } {
  const violations: GuardrailViolation[] = [];
  let result = text;

  for (const rule of REDACT_RULES) {
    const rulePattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    const matches = result.match(rulePattern);
    if (!matches) continue;

    result = result.replace(rulePattern, rule.replacement);
    violations.push({ ruleId: rule.id, action: 'redact', count: matches.length });
  }

  return { result, violations };
}

function checkBlockRules(text: string): { blocked: boolean; ruleId?: string } {
  for (const rule of BLOCK_RULES) {
    const rulePattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    if (rulePattern.test(text)) {
      return { blocked: true, ruleId: rule.id };
    }
  }
  return { blocked: false };
}

function processTextContent(
  text: string,
): { text: string; violations: GuardrailViolation[]; blocked: boolean; blockRuleId?: string } {
  const blockCheck = checkBlockRules(text);
  if (blockCheck.blocked) {
    return { text, violations: [], blocked: true, blockRuleId: blockCheck.ruleId };
  }

  const { result, violations } = applyRedactRules(text);
  return { text: result, violations, blocked: false };
}

function processMessage(message: ChatMessage): {
  message: ChatMessage;
  violations: GuardrailViolation[];
  blocked: boolean;
  blockRuleId?: string;
} {
  if (typeof message.content === 'string') {
    const { text, violations, blocked, blockRuleId } = processTextContent(message.content);
    return {
      message: blocked ? message : { ...message, content: text },
      violations,
      blocked,
      blockRuleId,
    };
  }

  const allViolations: GuardrailViolation[] = [];
  const processedParts: ContentPart[] = [];

  for (const part of message.content) {
    if (part.type !== 'text') {
      processedParts.push(part);
      continue;
    }

    const { text, violations, blocked, blockRuleId } = processTextContent(part.text);
    if (blocked) {
      return {
        message,
        violations: [],
        blocked: true,
        blockRuleId,
      };
    }

    allViolations.push(...violations);
    processedParts.push({ type: 'text', text });
  }

  return {
    message: { ...message, content: processedParts },
    violations: allViolations,
    blocked: false,
  };
}

export function applyGuardrails(messages: ChatMessage[]): GuardrailResult {
  if (process.env.GUARDRAILS_ENABLED === 'false') {
    return { messages, blocked: false, violations: [], redacted: false };
  }

  const processed: ChatMessage[] = [];
  const allViolations: GuardrailViolation[] = [];

  for (const message of messages) {
    const { message: m, violations, blocked, blockRuleId } = processMessage(message);

    if (blocked) {
      return {
        messages,
        blocked: true,
        blockReason: blockRuleId ?? 'prompt-injection',
        violations: [],
        redacted: false,
      };
    }

    processed.push(m);
    allViolations.push(...violations);
  }

  const mergedViolations = mergeViolations(allViolations);

  return {
    messages: processed,
    blocked: false,
    violations: mergedViolations,
    redacted: mergedViolations.length > 0,
  };
}

function mergeViolations(violations: GuardrailViolation[]): GuardrailViolation[] {
  const map = new Map<string, GuardrailViolation>();
  for (const v of violations) {
    const existing = map.get(v.ruleId);
    if (existing) {
      existing.count += v.count;
    } else {
      map.set(v.ruleId, { ...v });
    }
  }
  return Array.from(map.values());
}

export function isGuardrailEnabled(): boolean {
  return process.env.GUARDRAILS_ENABLED !== 'false';
}

export function summarizeViolations(violations: GuardrailViolation[]): string {
  return violations.map((v) => `${v.ruleId}×${v.count}`).join(', ');
}


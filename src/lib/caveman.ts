import { ChatMessage, ContentPart } from '@/providers/types';

const FENCE_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`[^`\n]{1,800}`/g;
const BLOCK_START = '\u0002CB_';
const BLOCK_END = '\u0003';
const BLOCK_RE = /\u0002CB_(\d+)\u0003/g;

const MIN_LENGTH = 60;
const RTK_LINE_THRESHOLD = 8;

interface Rule {
  re: RegExp;
  sub: string;
}

const RULES: Rule[] = [
  {
    re: /^(?:sure|certainly|of course|happy to help|no problem|absolutely|you(?:'re| are) welcome|glad to(?: help)?|great question|good question|sounds good)[!,.]* */gim,
    sub: '',
  },
  { re: /\bi think that /gi, sub: '' },
  { re: /\bi believe that /gi, sub: '' },
  { re: /\bit seems (?:like |that )/gi, sub: '' },
  { re: /\bit appears (?:that |to be )/gi, sub: '' },
  { re: /\bi feel like /gi, sub: '' },
  { re: /\bdue to the fact that\b/gi, sub: 'because' },
  { re: /\bthe reason (?:why )?(?:is|was) because\b/gi, sub: 'because' },
  { re: /\bin order to\b/gi, sub: 'to' },
  { re: /\bso as to\b/gi, sub: 'to' },
  { re: /\bwith the (?:goal|purpose|aim|intention) of\b/gi, sub: 'to' },
  {
    re: /\bas (?:i )?(?:mentioned|stated|noted|said) (?:earlier|above|previously|before)[,.]? */gi,
    sub: '',
  },
  { re: /\bas (?:we )?discussed(?: (?:earlier|above|previously|before))?[,.]? */gi, sub: '' },
  { re: /\bwith that (?:said|being said)[,.]? */gi, sub: '' },
  { re: /\bthat (?:said|being said)[,.]? */gi, sub: '' },
  { re: /\bgoing forward[,.]? */gi, sub: '' },
  { re: /\bat the end of the day[,.]? */gi, sub: '' },
  { re: /\ball things considered[,.]? */gi, sub: '' },
  { re: /\b(?:could|would|can) you please /gi, sub: '' },
  { re: /\bi(?:'d| would) like (?:you )?to /gi, sub: '' },
  { re: /\bi (?:want|need) you to /gi, sub: '' },
  { re: /\bbasically,? /gi, sub: '' },
  { re: /\bliterally,? /gi, sub: '' },
  { re: /\bjust (?=want |need |try|look|wonder)/gi, sub: '' },
];

function extractBlocks(text: string): { stripped: string; blocks: string[] } {
  const blocks: string[] = [];

  const stripped = text
    .replace(FENCE_RE, (m) => {
      const i = blocks.push(m) - 1;
      return `${BLOCK_START}${i}${BLOCK_END}`;
    })
    .replace(INLINE_CODE_RE, (m) => {
      const i = blocks.push(m) - 1;
      return `${BLOCK_START}${i}${BLOCK_END}`;
    });

  return { stripped, blocks };
}

function restoreBlocks(text: string, blocks: string[]): string {
  return text.replace(BLOCK_RE, (_, i) => blocks[parseInt(i, 10)]);
}

function deduplicateLines(text: string): string {
  const lines = text.split('\n');
  if (lines.length < RTK_LINE_THRESHOLD) return text;

  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (i > 0 && lines[i] === lines[i - 1]) continue;
    out.push(lines[i]);
  }

  return out.join('\n');
}

function applyRules(text: string): string {
  let out = text;
  for (const { re, sub } of RULES) {
    out = out.replace(re, sub);
  }
  return out;
}

function tighten(text: string): string {
  return text
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface CavemanResult {
  text: string;
  changed: boolean;
}

export function cavemanCompress(text: string): CavemanResult {
  if (text.length < MIN_LENGTH) return { text, changed: false };

  const { stripped, blocks } = extractBlocks(text);
  const deduped = deduplicateLines(stripped);
  const ruled = applyRules(deduped);
  const tightened = tighten(ruled);
  const restored = restoreBlocks(tightened, blocks);

  return { text: restored, changed: restored !== text };
}

export function cavemanCompressMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((msg): ChatMessage => {
    if (msg.role === 'system') return msg;

    if (typeof msg.content === 'string') {
      const { text, changed } = cavemanCompress(msg.content);
      return changed ? { ...msg, content: text } : msg;
    }

    let anyChanged = false;
    const parts: ContentPart[] = msg.content.map((part): ContentPart => {
      if (part.type !== 'text') return part;
      const { text, changed } = cavemanCompress(part.text);
      if (changed) anyChanged = true;
      return changed ? { type: 'text', text } : part;
    });

    return anyChanged ? { ...msg, content: parts } : msg;
  });
}


import sharp from 'sharp';
import { AIProvider, ChatMessage, ContentPart, ImageAction, ImageUrlPart } from '@/providers/types';

const MAX_IMAGE_BYTES = 1_048_576; // 1 MB — resize above this threshold
const RESIZE_TARGET_PX = 768;     // Longest dimension after resize

interface ProcessResult {
  messages: ChatMessage[];
  hadImages: boolean;
  imageAction: ImageAction;
}

export async function processMessagesForProvider(
  messages: ChatMessage[],
  provider: AIProvider,
): Promise<ProcessResult> {
  const hasImages = messagesHaveImages(messages);
  if (!hasImages) return { messages, hadImages: false, imageAction: 'none' };

  if (!provider.supportsVision) {
    return {
      messages: stripAllImages(messages),
      hadImages: true,
      imageAction: 'stripped',
    };
  }

  const { messages: processed, wasResized } = await resizeOversizedImages(messages);
  return {
    messages: processed,
    hadImages: true,
    imageAction: wasResized ? 'resized' : 'passed',
  };
}

function messagesHaveImages(messages: ChatMessage[]): boolean {
  return messages.some(
    (m) =>
      Array.isArray(m.content) && m.content.some((p: ContentPart) => p.type === 'image_url'),
  );
}

function stripAllImages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((msg) => {
    if (typeof msg.content === 'string') return msg;
    const parts = msg.content.filter((p: ContentPart) => p.type !== 'image_url');
    if (parts.length === msg.content.length) return msg;

    const textParts = parts.length > 0 ? parts : [{ type: 'text' as const, text: '[image removed — provider does not support vision]' }];
    return { ...msg, content: textParts };
  });
}

async function resizeOversizedImages(messages: ChatMessage[]): Promise<{
  messages: ChatMessage[];
  wasResized: boolean;
}> {
  let wasResized = false;

  const processed = await Promise.all(
    messages.map(async (msg) => {
      if (typeof msg.content === 'string') return msg;

      const parts = await Promise.all(
        msg.content.map(async (part: ContentPart) => {
          if (part.type !== 'image_url') return part;
          const result = await maybeResizeImagePart(part);
          if (result.resized) wasResized = true;
          return result.part;
        }),
      );

      return { ...msg, content: parts };
    }),
  );

  return { messages: processed, wasResized };
}

async function maybeResizeImagePart(
  part: ImageUrlPart,
): Promise<{ part: ContentPart; resized: boolean }> {
  const { url } = part.image_url;
  const match = url.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return { part, resized: false };

  const [, mimeType, base64Data] = match;
  const buffer = Buffer.from(base64Data, 'base64');

  if (buffer.byteLength <= MAX_IMAGE_BYTES) return { part, resized: false };

  try {
    const resized = await sharp(buffer)
      .resize(RESIZE_TARGET_PX, RESIZE_TARGET_PX, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();

    const resizedUrl = `data:image/jpeg;base64,${resized.toString('base64')}`;
    return {
      part: { type: 'image_url', image_url: { url: resizedUrl, detail: 'auto' } },
      resized: true,
    };
  } catch {
    // If resize fails, pass the original image through
    return { part, resized: false };
  }
}

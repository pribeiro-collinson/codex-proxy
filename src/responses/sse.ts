export function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function sseComment(text: string): string {
  return `: ${text}\n\n`;
}

export async function* parseSse(body: ReadableStream<Uint8Array> | null): AsyncGenerator<{
  event?: string;
  data: string;
}> {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replaceAll("\r\n", "\n");
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const chunk = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const parsed = parseSseBlock(chunk);
        if (parsed) yield parsed;
      }
    }
    buffer += decoder.decode();
    const parsed = parseSseBlock(buffer.replaceAll("\r\n", "\n"));
    if (parsed) yield parsed;
  } finally {
    reader.releaseLock();
  }
}

function parseSseBlock(block: string): { event?: string; data: string } | undefined {
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return undefined;
  return { event, data: dataLines.join("\n") };
}

/**
 * Parses an SSE byte stream into discrete events with a `data` payload.
 *
 * Yields the raw `data:` string for each event (everything after `data: `,
 * with trailing newlines stripped). Events whose data is `[DONE]` are also
 * yielded so callers can react to stream end.
 */
export async function* iterateSse(stream: AsyncIterable<Buffer | Uint8Array | string>): AsyncGenerator<string> {
  let buffer = "";
  for await (const chunk of stream) {
    buffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    let idx: number;
    while ((idx = indexOfDoubleNewline(buffer)) !== -1) {
      const rawEvent = buffer.slice(0, idx);
      buffer = buffer.slice(idx + (buffer.startsWith("\r\n", idx) ? 2 : 2));
      const data = extractData(rawEvent);
      if (data != null) yield data;
    }
  }
  if (buffer.trim().length > 0) {
    const data = extractData(buffer);
    if (data != null) yield data;
  }
}

function indexOfDoubleNewline(s: string): number {
  const a = s.indexOf("\n\n");
  const b = s.indexOf("\r\n\r\n");
  if (a === -1) return b;
  if (b === -1) return a;
  return Math.min(a, b);
}

function extractData(rawEvent: string): string | null {
  const lines = rawEvent.split(/\r?\n/);
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^ /, ""));
    }
  }
  if (dataLines.length === 0) return null;
  return dataLines.join("\n");
}

export function formatSseEvent(event: string, data: unknown): string {
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  return `event: ${event}\ndata: ${payload}\n\n`;
}

export function formatSseData(data: unknown): string {
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  return `data: ${payload}\n\n`;
}

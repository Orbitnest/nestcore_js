/** `data:` payloads of a server-sent-events body. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (line.startsWith('data:')) yield line.slice(5).trimStart();
      }
    }
    if (buf.startsWith('data:')) yield buf.slice(5).trimStart();
  } finally {
    // A consumer that leaves the loop early must close the connection, or the server keeps generating (and billing).
    await reader.cancel().catch(() => {});
  }
}

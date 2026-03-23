export async function readEventStream(
  response: Response,
  onData: (data: string) => void,
  signal?: AbortSignal
) {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("No response body to read.");
  }
  console.log("Dify Chunk:", reader);
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  while (true) {
    if (signal?.aborted) {
      break;
    }
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      if (trimmed.startsWith("data:")) {
        onData(trimmed.replace(/^data:\s*/, ""));
      }
    }
  }
}

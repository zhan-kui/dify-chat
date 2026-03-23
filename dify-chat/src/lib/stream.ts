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

  // 处理末尾未换行的残留数据，避免最后一段被丢失
  if (buffer.trim()) {
    const tailLines = buffer.split(/\r?\n/);
    for (const line of tailLines) {
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

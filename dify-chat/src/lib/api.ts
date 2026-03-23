import { readEventStream } from "./stream";

export type OpenAIMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type DifyFileMeta = {
  id: string;
  name?: string;
  size?: number;
  mime_type?: string;
};

export type DifyChatResult = {
  answer: string;
  conversationId?: string;
};

function normalizeBaseUrl(value: string) {
  return value.trim().replace(/\/+$/, "");
}

function withVersion(baseUrl: string, path: string, version = "/v1") {
  const cleaned = normalizeBaseUrl(baseUrl);
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  if (!cleaned) {
    return normalizedPath;
  }
  if (cleaned.endsWith(version)) {
    return `${cleaned}${normalizedPath}`;
  }
  return `${cleaned}${version}${normalizedPath}`;
}

async function assertOk(response: Response) {
  if (response.ok) {
    return;
  }
  const text = await response.text();
  let message = text;
  try {
    // 优先解析服务端返回的 JSON 错误信息，便于在界面提示
    const data = JSON.parse(text);
    message = data?.message || data?.error || data?.detail || text;
  } catch {
    // 非 JSON 响应时沿用文本内容即可
  }
  throw new Error(message || `Request failed with ${response.status}`);
}

export function parseJsonSafe(input: string) {
  if (!input.trim()) {
    return {};
  }
  return JSON.parse(input);
}

export async function uploadDifyFile(options: {
  baseUrl: string;
  apiKey: string;
  user: string;
  file: File;
  signal?: AbortSignal;
}): Promise<DifyFileMeta> {
  const url = withVersion(options.baseUrl, "/files/upload");
  // Dify 文件上传要求 multipart/form-data，这里必须使用 FormData（不要手动设置 Content-Type）
  const form = new FormData();
  form.append("file", options.file);
  form.append("user", options.user);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
    },
    body: form,
    signal: options.signal,
  });
  await assertOk(response);
  const data = await response.json();

  const id =
    data?.id ??
    data?.upload_file_id ??
    data?.data?.id ??
    data?.data?.upload_file_id;
  if (!id) {
    throw new Error("Upload succeeded but no file id returned.");
  }

  return {
    id,
    name: data?.name ?? data?.data?.name,
    size: data?.size ?? data?.data?.size,
    mime_type: data?.mime_type ?? data?.data?.mime_type,
  };
}

export async function sendDifyChat(options: {
  baseUrl: string;
  apiKey: string;
  user: string;
  query: string;
  inputs: Record<string, unknown>;
  responseMode: "streaming" | "blocking";
  conversationId?: string;
  files?: Array<{
    type: string;
    transfer_method: string;
    upload_file_id: string;
  }>;
  signal?: AbortSignal;
  onToken?: (token: string) => void;
}): Promise<DifyChatResult> {
  const url = withVersion(options.baseUrl, "/chat-messages");
  const payload = {
    inputs: options.inputs,
    query: options.query,
    response_mode: options.responseMode,
    conversation_id: options.conversationId || undefined,
    user: options.user,
    files: options.files?.length ? options.files : undefined,
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: options.signal,
  });

  await assertOk(response);

  // 【修复 1】不再依赖 Content-Type 判断，只看 responseMode
  if (options.responseMode === "blocking") {
    const data = await response.json();
    return {
      answer: data?.answer || "",
      conversationId: data?.conversation_id,
    };
  }

  // 流式处理
  let fullAnswer = "";
  let conversationId: string | undefined;

  await readEventStream(
    response,
    (data) => {
      if (data === "[DONE]") return;
      try {
        const parsed = JSON.parse(data);

        // 更新会话ID
        if (parsed.conversation_id) conversationId = parsed.conversation_id;

        // 【修复 2】根据 Dify 事件类型精确提取
        // 只处理 message 事件（正式回答）和 agent_thought 事件（思考过程）
        let chunk = "";

        if (parsed.event === "message") {
          chunk = parsed.answer || "";
        } else if (parsed.event === "agent_thought") {
          // 如果是思考过程，我们手动包裹标签
          const thought = parsed.thought || "";
          if (thought) chunk = `<think>${thought}</think>`;
        } else if (parsed.event === "error") {
          throw new Error(parsed.message || "流式输出错误");
        }

        if (chunk) {
          fullAnswer += chunk;
          options.onToken?.(chunk); // 触发打字机回调
        }
      } catch (e) {
        // 忽略非 JSON 数据
      }
    },
    options.signal
  );

  return { answer: fullAnswer, conversationId };
}

export async function sendOpenAIChat(options: {
  baseUrl: string;
  apiKey?: string;
  model: string;
  messages: OpenAIMessage[];
  stream: boolean;
  signal?: AbortSignal;
  onToken?: (token: string) => void;
}): Promise<{ answer: string }> {
  const url = withVersion(options.baseUrl, "/chat/completions");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (options.apiKey) {
    headers.Authorization = `Bearer ${options.apiKey}`;
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: options.model,
      messages: options.messages,
      stream: options.stream,
    }),
    signal: options.signal,
  });
  await assertOk(response);

  const contentType = response.headers.get("content-type") ?? "";
  if (!options.stream || contentType.includes("application/json")) {
    const data = await response.json();
    return {
      answer: data?.choices?.[0]?.message?.content ?? "",
    };
  }

  let answer = "";
  let hasStartedReasoning = false; // 标记是否已经开始思考
  let hasFinishedReasoning = false; // 标记是否结束思考

  await readEventStream(
    response,
    (data) => {
      if (data === "[DONE]") return;
      try {
        const parsed = JSON.parse(data);
        console.log("SSE Event:", parsed.event, parsed);
        const delta = parsed?.choices?.[0]?.delta;

        // 1. 处理思考内容 (阿里千问、DeepSeek 常用字段)
        const reasoning = delta?.reasoning_content;
        if (typeof reasoning === "string" && reasoning !== "") {
          let token = reasoning;
          if (!hasStartedReasoning) {
            token = "<think>" + token;
            hasStartedReasoning = true;
          }
          answer += token;
          options.onToken?.(token);
          return; // 如果是思考内容，处理完直接返回
        }

        // 2. 如果思考内容结束，转入正文内容，需要闭合标签
        let content = delta?.content || "";
        if (typeof content === "string" && content !== "") {
          if (hasStartedReasoning && !hasFinishedReasoning) {
            content = "</think>" + content;
            hasFinishedReasoning = true;
          }
          answer += content;
          options.onToken?.(content);
        }
      } catch {
        // Ignore malformed chunks.
      }
    },
    options.signal
  );

  // 兜底：如果流结束了标签还没闭合，补全它
  if (hasStartedReasoning && !hasFinishedReasoning) {
    answer += "</think>";
  }

  return { answer };
}

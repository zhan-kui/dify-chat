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

// 安全提取字符串字段（兼容数字/布尔/数组）
function pickString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const picked = pickString(item);
      if (picked) return picked;
    }
  }
  return undefined;
}

// 从 outputs 中提取第一个可用字符串
function pickFromOutputs(outputs: unknown) {
  if (!outputs) return undefined;
  if (Array.isArray(outputs)) {
    for (const item of outputs) {
      const picked = pickString(item);
      if (picked) return picked;
    }
    return undefined;
  }
  if (typeof outputs !== "object") return undefined;
  const record = outputs as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const val = record[key];
    const picked = pickString(val);
    if (picked) return picked;
  }
  return undefined;
}

const ANSWER_KEYS = [
  "answer",
  "content",
  "text",
  "output",
  "result",
  "reply",
  "message",
];

const SKIP_KEYS = new Set([
  "event",
  "type",
  "status",
  "success",
  "ok",
  "id",
  "conversation_id",
  "conversationId",
  "message_id",
  "task_id",
  "user",
  "created_at",
  "updated_at",
  "mode",
  "files",
  "file_id",
  "file_name",
  "metadata",
  "usage",
]);

// 尽可能兼容不同响应结构提取回答
function extractAnswer(data: any): string {
  if (data === null || data === undefined) return "";

  if (
    typeof data === "string" ||
    typeof data === "number" ||
    typeof data === "boolean"
  ) {
    return String(data);
  }

  if (Array.isArray(data)) {
    for (const item of data) {
      const picked = extractAnswer(item);
      if (picked) return picked;
    }
    return "";
  }

  if (typeof data !== "object") return "";

  // 先按常见字段提取
  for (const key of ANSWER_KEYS) {
    const picked = pickString((data as Record<string, unknown>)[key]);
    if (picked) return picked;
  }

  const outputs =
    pickFromOutputs((data as any)?.outputs) ??
    pickFromOutputs((data as any)?.data?.outputs) ??
    pickFromOutputs((data as any)?.result?.outputs);
  if (outputs) return outputs;

  // 递归寻找第一个看起来像回答的字符串
  for (const [key, value] of Object.entries(data)) {
    if (SKIP_KEYS.has(key)) continue;
    const picked = extractAnswer(value);
    if (picked) return picked;
  }

  return "";
}

// 提取会话 ID（兼容不同字段名）
function extractConversationId(data: any) {
  return (
    pickString(data?.conversation_id) ??
    pickString(data?.data?.conversation_id) ??
    pickString(data?.result?.conversation_id) ??
    pickString(data?.conversationId) ??
    pickString(data?.data?.conversationId) ??
    pickString(data?.result?.conversationId)
  );
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

  const contentType = response.headers.get("content-type") ?? "";
  const isJsonResponse = contentType.includes("application/json");
  const isEventStream = contentType.includes("text/event-stream");

  // 非流式或服务端未返回 SSE 时，按普通响应处理
  if (options.responseMode === "blocking" || isJsonResponse || !isEventStream) {
    const raw = await response.text();
    try {
      const data = JSON.parse(raw);
      return {
        answer: extractAnswer(data),
        conversationId: extractConversationId(data),
      };
    } catch {
      return {
        answer: raw,
        conversationId: undefined,
      };
    }
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
        const nextConversationId = extractConversationId(parsed);
        if (nextConversationId) conversationId = nextConversationId;

        // 根据事件类型提取数据：仅消费 message / agent_thought，避免非正文事件污染
        let chunk = "";
        if (parsed.event === "message") {
          // Dify 可能返回 delta 或 answer
          chunk =
            pickString(parsed?.delta) ??
            pickString(parsed?.answer) ??
            pickString(parsed?.data?.delta) ??
            pickString(parsed?.data?.answer) ??
            pickString(parsed?.data?.content) ??
            "";
        } else if (parsed.event === "message_end") {
          // 某些环境只在结束事件中带完整答案
          chunk = extractAnswer(parsed);
        } else if (parsed.event === "agent_thought") {
          const thought =
            parsed.thought ??
            parsed?.data?.thought ??
            parsed?.data?.content ??
            "";
          if (typeof thought === "string" && thought.trim()) {
            chunk = `<think>${thought}</think>`;
          }
        } else if (parsed.event === "error") {
          throw new Error(parsed.message || "流式输出错误");
        } else if (!parsed.event) {
          // 某些网关会省略 event 字段，退回通用解析
          chunk = extractAnswer(parsed);
        }

        if (chunk) {
          fullAnswer += chunk;
          options.onToken?.(chunk);
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

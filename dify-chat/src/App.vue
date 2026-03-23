<script setup lang="ts">
import {
  computed,
  nextTick,
  onMounted,
  onUnmounted,
  reactive,
  ref,
  watch,
} from "vue";
import {
  parseJsonSafe,
  sendDifyChat,
  sendOpenAIChat,
  uploadDifyFile,
  type OpenAIMessage,
} from "./lib/api";

// 供应商标识，用于切换不同 API 逻辑
type ProviderId = "dify" | "openai" | "qwen" | "openai_compat" | "ollama";

// 附件元数据（上传前/后都使用）
type Attachment = {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  status: "pending" | "uploaded" | "error";
  uploadFileId?: string;
  error?: string;
  file?: File;
};

// 聊天消息结构
type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  attachments?: Attachment[];
};

// 历史会话结构（存入本地）
type Conversation = {
  id: string;
  title: string;
  messages: Message[];
  providerId: ProviderId;
  difyConversationId?: string;
  updatedAt: number;
};

// OpenAI 兼容配置结构
type CompatConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
};

// 供应商列表（用于设置弹窗）
const providers = [
  { id: "dify", label: "Dify", hint: "优先使用 Dify 应用与文件上传。" },
  { id: "openai", label: "OpenAI", hint: "OpenAI 官方接口。" },
  { id: "qwen", label: "Qwen", hint: "阿里千问（OpenAI 兼容）。" },
  { id: "openai_compat", label: "OpenAI 兼容", hint: "其他厂商网关。" },
  { id: "ollama", label: "本地模型", hint: "Ollama 或本地部署。" },
] as const;

// 本地持久化 key
const storageKey = "dify-chat-settings-v1";
const historyKey = "dify-chat-history-v1";
const historyActiveKey = "dify-chat-history-active";

// 默认配置（可序列化）
const createDefaults = () => {
  return {
    providerId: "dify" as ProviderId,
    ui: {
      streaming: true,
    },
    dify: {
      baseUrl: "https://api.dify.ai",
      apiKey: "",
      user: `user_${Math.random().toString(36).slice(2, 10)}`,
      conversationId: "",
      inputsJson: "{}",
    },
    openai: {
      baseUrl: "https://api.openai.com/v1",
      apiKey: "",
      model: "",
      systemPrompt: "",
    },
    qwen: {
      baseUrl: "",
      apiKey: "",
      model: "",
      systemPrompt: "",
    },
    openaiCompat: {
      baseUrl: "",
      apiKey: "",
      model: "",
      systemPrompt: "",
    },
    ollama: {
      baseUrl: "http://localhost:11434/v1",
      apiKey: "",
      model: "",
      systemPrompt: "",
    },
  };
};

// 核心状态
const settings = reactive(createDefaults());
const messages = ref<Message[]>([]);
const composer = ref("");
const attachments = ref<Attachment[]>([]);
const error = ref("");
const info = ref("");
const status = ref<"idle" | "sending" | "streaming">("idle");
const abortController = ref<AbortController | null>(null);
const chatRef = ref<HTMLDivElement | null>(null);
const fileInputRef = ref<HTMLInputElement | null>(null);
const headerRef = ref<HTMLDivElement | null>(null);
const composerRef = ref<HTMLTextAreaElement | null>(null);
const conversations = ref<Conversation[]>([]);
const activeConversationId = ref<string | null>(null);
const showHistory = ref(false);
// 设置弹窗默认不显示
const showSettings = ref(false);
// 长按打开设置的计时器
let longPressTimer: number | null = null;
const longPressTriggered = ref(false);

// 当前选择的供应商信息（用于显示提示）
const activeProvider = computed(() => {
  return providers.find((provider) => provider.id === settings.providerId);
});

// 统一后的 OpenAI 兼容配置
const compatConfig = computed<CompatConfig>(() => {
  if (settings.providerId === "openai") {
    return settings.openai;
  }
  if (settings.providerId === "qwen") {
    return settings.qwen;
  }
  if (settings.providerId === "ollama") {
    return settings.ollama;
  }
  return settings.openaiCompat;
});

// UI 状态辅助
const streamingEnabled = computed(() => settings.ui.streaming);
const canUpload = computed(() => settings.providerId === "dify");
const fileAccept = computed(() =>
  settings.providerId === "dify"
    ? "image/*,video/*,audio/*,application/pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.txt,.md"
    : ""
);
const isBusy = computed(() => status.value !== "idle");
const sendEnabled = computed(
  () => composer.value.trim().length > 0 && !isBusy.value
);
// 上传按钮不再依赖输入内容，默认可用（仅受供应商能力限制）
const uploadEnabled = computed(() => canUpload.value);
// 发送按钮状态：忙碌时切换为“停止”
const sendButtonMode = computed(() => (isBusy.value ? "stop" : "send"));

// 判断是否已配置完成，用于“在线/离线”状态
const isConfigured = computed(() => {
  if (settings.providerId === "dify") {
    return Boolean(
      settings.dify.baseUrl && settings.dify.apiKey && settings.dify.user
    );
  }
  const baseOk = Boolean(
    compatConfig.value.baseUrl && compatConfig.value.model
  );
  if (settings.providerId === "openai") {
    return baseOk && Boolean(compatConfig.value.apiKey);
  }
  return baseOk;
});
const statusLabel = computed(() => (isConfigured.value ? "在线" : "离线"));
const statusClass = computed(() =>
  isConfigured.value ? "text-emerald-400" : "text-amber-400"
);

// 当前会话与标题
const currentConversation = computed(() =>
  conversations.value.find((item) => item.id === activeConversationId.value)
);
const currentTitle = computed(
  () => currentConversation.value?.title || "智能商机助手"
);

// 聊天滚动到底部
const scrollToBottom = async () => {
  await nextTick();
  if (chatRef.value) {
    chatRef.value.scrollTop = chatRef.value.scrollHeight;
  }
};

// 在流式输出时节流滚动，保证实时贴底但不阻塞主线程
const scheduleScroll = () => {
  window.requestAnimationFrame(() => {
    scrollToBottom();
  });
};

// 当消息内容变化时自动滚动
watch(
  () => messages.value.map((message) => message.content).join(""),
  () => {
    scrollToBottom();
  }
);

// 保存设置到本地存储
const saveSettings = () => {
  const payload = JSON.stringify(settings);
  localStorage.setItem(storageKey, payload);
};

// 初始化读取本地存储
onMounted(() => {
  const saved = localStorage.getItem(storageKey);
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      Object.assign(settings, parsed);
    } catch {
      // 忽略解析失败的缓存
    }
  }
});

watch(settings, saveSettings, { deep: true });

// 历史记录持久化
const persistHistory = () => {
  const safeConversations = conversations.value.map((item) => {
    return {
      ...item,
      messages: item.messages.map((msg) => ({
        ...msg,
        attachments: msg.attachments?.map(({ file, ...rest }) => rest),
      })),
    };
  });
  localStorage.setItem(historyKey, JSON.stringify(safeConversations));
  if (activeConversationId.value) {
    localStorage.setItem(historyActiveKey, activeConversationId.value);
  }
};

// 读取历史记录
const loadHistory = () => {
  const raw = localStorage.getItem(historyKey);
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw) as Conversation[];
    conversations.value = Array.isArray(parsed) ? parsed : [];
  } catch {
    conversations.value = [];
  }

  const lastId = localStorage.getItem(historyActiveKey);
  if (lastId) {
    const target = conversations.value.find((item) => item.id === lastId);
    if (target) {
      activeConversationId.value = target.id;
      messages.value = target.messages.map((msg) => ({
        ...msg,
        attachments: msg.attachments ? [...msg.attachments] : undefined,
      }));
      settings.providerId = target.providerId;
      if (target.providerId === "dify") {
        settings.dify.conversationId = target.difyConversationId || "";
      } else {
        settings.dify.conversationId = "";
      }
    }
  }
};

// 初始化读取本地历史
onMounted(() => {
  loadHistory();
});

// 同步标题栏高度到 CSS 变量，避免历史面板被遮挡
const updateHeaderOffset = () => {
  const height = headerRef.value?.getBoundingClientRect().height ?? 0;
  if (height) {
    document.documentElement.style.setProperty(
      "--header-offset",
      `${Math.ceil(height)}px`
    );
  }
};

onMounted(() => {
  updateHeaderOffset();
  window.addEventListener("resize", updateHeaderOffset);
});

onUnmounted(() => {
  window.removeEventListener("resize", updateHeaderOffset);
});

// 输入框高度自适应：保持默认紧凑，只在内容超出时增高
const resizeComposer = () => {
  const el = composerRef.value;
  if (!el) return;
  el.style.height = "auto";
  const next = Math.min(el.scrollHeight, 160);
  el.style.height = `${next}px`;
};

watch(composer, () => {
  nextTick(() => resizeComposer());
});

onMounted(() => {
  resizeComposer();
});

// 生成会话标题（取前 10 个字符）
const buildTitle = (text: string) => {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return "新对话";
  const short = cleaned.slice(0, 10);
  return cleaned.length > 10 ? `${short}...` : short;
};

// 确保存在当前会话
const ensureConversation = (text: string) => {
  if (activeConversationId.value) return;
  const id = `conv_${Date.now()}`;
  const title = buildTitle(text);
  const newConversation: Conversation = {
    id,
    title,
    messages: [],
    providerId: settings.providerId,
    difyConversationId:
      settings.providerId === "dify" ? settings.dify.conversationId : undefined,
    updatedAt: Date.now(),
  };
  conversations.value.unshift(newConversation);
  activeConversationId.value = id;
  persistHistory();
};

// 将当前消息写回历史记录
const syncConversation = () => {
  if (!activeConversationId.value) return;
  const index = conversations.value.findIndex(
    (item) => item.id === activeConversationId.value
  );
  if (index === -1) return;
  const conv = conversations.value[index];
  const newTitle =
    conv.title ||
    buildTitle(messages.value.find((m) => m.role === "user")?.content || "");
  const updated: Conversation = {
    ...conv,
    title: newTitle,
    providerId: settings.providerId,
    difyConversationId:
      settings.providerId === "dify" ? settings.dify.conversationId : undefined,
    messages: messages.value.map((msg) => ({
      ...msg,
      attachments: msg.attachments?.map(({ file, ...rest }) => rest),
    })),
    updatedAt: Date.now(),
  };
  conversations.value.splice(index, 1);
  conversations.value.unshift(updated);
  persistHistory();
};

// 打开/关闭历史面板
const toggleHistory = () => {
  showHistory.value = !showHistory.value;
};

const closeHistory = () => {
  showHistory.value = false;
};

// 选择历史会话
const selectConversation = (id: string) => {
  const target = conversations.value.find((item) => item.id === id);
  if (!target) return;
  activeConversationId.value = target.id;
  messages.value = target.messages.map((msg) => ({
    ...msg,
    attachments: msg.attachments ? [...msg.attachments] : undefined,
  }));
  settings.providerId = target.providerId;
  if (target.providerId === "dify") {
    settings.dify.conversationId = target.difyConversationId || "";
  } else {
    settings.dify.conversationId = "";
  }
  closeHistory();
  // 切换会话后自动贴底，避免输入框挡住新内容
  scrollToBottom();
};

// 删除单条历史记录
const deleteConversation = (id: string) => {
  const index = conversations.value.findIndex((item) => item.id === id);
  if (index === -1) return;
  conversations.value.splice(index, 1);
  if (activeConversationId.value === id) {
    // 删除当前会话时，重置聊天状态，避免残留内容
    stopStreaming();
    messages.value = [];
    attachments.value = [];
    composer.value = "";
    error.value = "";
    info.value = "";
    if (settings.providerId === "dify") {
      settings.dify.conversationId = "";
    }
    activeConversationId.value = null;
    localStorage.removeItem(historyActiveKey);
  }
  if (conversations.value.length === 0) {
    localStorage.removeItem(historyKey);
    localStorage.removeItem(historyActiveKey);
  } else {
    persistHistory();
  }
};

// 删除所有历史记录
const clearAllHistory = () => {
  stopStreaming();
  conversations.value = [];
  activeConversationId.value = null;
  messages.value = [];
  attachments.value = [];
  composer.value = "";
  error.value = "";
  info.value = "";
  if (settings.providerId === "dify") {
    settings.dify.conversationId = "";
  }
  localStorage.removeItem(historyKey);
  localStorage.removeItem(historyActiveKey);
};
// 格式化文件大小
const formatBytes = (bytes: number) => {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
};

// 选择文件时写入附件列表
const onFileChange = (event: Event) => {
  const target = event.target as HTMLInputElement;
  const files = target.files;
  if (!files) {
    return;
  }
  for (const file of Array.from(files)) {
    attachments.value.push({
      id: `${file.name}-${file.size}-${Date.now()}`,
      name: file.name,
      size: file.size,
      mimeType: file.type,
      status: "pending",
      file,
    });
  }
  target.value = "";
};

// 移除附件
const removeAttachment = (id: string) => {
  attachments.value = attachments.value.filter((item) => item.id !== id);
};

// 清空聊天
const clearChat = () => {
  messages.value = [];
};

// 重置 Dify 会话
const resetDifyConversation = () => {
  settings.dify.conversationId = "";
};

// 停止流式输出
const stopStreaming = () => {
  abortController.value?.abort();
  status.value = "idle";
  abortController.value = null;
};

// 新建聊天：清空消息并重置 Dify 会话
const createNewChat = () => {
  stopStreaming();
  messages.value = [];
  attachments.value = [];
  composer.value = "";
  error.value = "";
  info.value = "";
  if (settings.providerId === "dify") {
    settings.dify.conversationId = "";
  }
  activeConversationId.value = null;
  localStorage.removeItem(historyActiveKey);
};

// 长按 5 秒打开设置
const startLongPress = () => {
  longPressTriggered.value = false;
  if (longPressTimer !== null) {
    window.clearTimeout(longPressTimer);
    longPressTimer = null;
  }
  longPressTimer = window.setTimeout(() => {
    longPressTriggered.value = true;
    openSettings();
    longPressTimer = null;
  }, 5000);
};

// 取消长按计时
const cancelLongPress = () => {
  if (longPressTimer !== null) {
    window.clearTimeout(longPressTimer);
    longPressTimer = null;
  }
};

// 释放手指：如果没有触发长按，则新开聊天
const handleNewChatRelease = () => {
  if (longPressTriggered.value) {
    longPressTriggered.value = false;
    cancelLongPress();
    return;
  }
  cancelLongPress();
  createNewChat();
};

// 打开/关闭设置弹窗
const openSettings = () => {
  showSettings.value = true;
};

const closeSettings = () => {
  showSettings.value = false;
};

// 打开文件选择器
const openUploadPicker = () => {
  if (!uploadEnabled.value) {
    error.value = "当前供应商不支持文件上传。";
    return;
  }
  // 上传前校验 Dify 配置，避免接口直接失败
  if (
    settings.providerId === "dify" &&
    (!settings.dify.baseUrl || !settings.dify.apiKey || !settings.dify.user)
  ) {
    error.value = "请先补全 Dify Base URL、API Key 与 User ID。";
    showSettings.value = true;
    return;
  }
  fileInputRef.value?.click();
};

// 需要处理“正在思考”的状态。即：如果找到了 <think> 但还没找到 </think>，应该把 <think> 之后的所有内容都实时放入 think 字段中。
const splitThinkContent = (raw: string) => {
  const text = raw || "";
  const startTags = ["<think>", "<thought>", "<想>"];
  const endTags = ["</think>", "</thought>", "</想>"];

  let startTag = "";
  let endTag = "";
  let startIndex = -1;

  // 找到第一个匹配的开始标签
  for (let i = 0; i < startTags.length; i++) {
    const idx = text.indexOf(startTags[i]);
    if (idx !== -1) {
      startTag = startTags[i];
      endTag = endTags[i];
      startIndex = idx;
      break;
    }
  }

  // 情况 1: 完全没有思考标签 -> 全是回答
  if (startIndex === -1) {
    return { think: "", answer: text, isThinking: false };
  }

  const endIndex = text.indexOf(endTag);

  // 情况 2: 有开始没结束 -> 正在思考
  if (endIndex === -1) {
    return {
      think: text.slice(startIndex + startTag.length),
      answer: text.slice(0, startIndex),
      isThinking: true,
    };
  }

  // 情况 3: 思考已完成 -> 剥离思考块
  // 核心：这里要保留 startIndex 之前的正文和 endIndex 之后的正文
  const think = text.slice(startIndex + startTag.length, endIndex);
  const answer = (
    text.slice(0, startIndex) + text.slice(endIndex + endTag.length)
  ).trim();

  return { think, answer: answer || "", isThinking: false };
};
// 为渲染做一层转换，方便显示思维链   v确保在思考时，即便 answer 为空，只要 think 有内容，就不要回退到原始文本，否则会显示出 <think> 标签。
// 为渲染做一层转换，方便显示思维链
const formattedMessages = computed(() => {
  return messages.value.map((m) => {
    if (m.role !== "assistant")
      return { ...m, think: "", answer: m.content, isThinking: false };

    const { think, answer, isThinking } = splitThinkContent(m.content || "");

    // 真正的“初始加载”：模型连接上了(streaming)，但连一个字（包括标签）都没吐出来
    const isInitialLoading =
      status.value === "streaming" && (!m.content || m.content.length === 0);

    return {
      ...m,
      think,
      answer,
      isThinking,
      isInitialLoading,
    };
  });
});
// 处理流式分片：兼容“增量分片”和“累计分片”，避免重复内容,Dify 的 /chat-messages 接口在 streaming 模式下返回的是 增量 (Incremental) 内容。你原有的代码中包含大量 startsWith 检查，这通常是为了兼容某些“每次返回全量”的非标准接口。对于 Dify，直接累加是最安全的。
const applyStreamChunk = (message: Message, chunk: string) => {
  if (!chunk) return;
  const current = message.content || "";

  // 1. 如果新 chunk 是包含旧内容的（某些网关会返回累积内容）
  if (chunk.length > current.length && chunk.startsWith(current)) {
    message.content = chunk;
    return;
  }

  // 2. 检查是否有大段重复（针对 Dify Agent 可能重复发送回答的问题）
  // 如果新 chunk 已经完全包含在当前内容里了，直接丢弃
  // if (current.includes(chunk) && chunk.length > 5) {
  //   return;
  // }

  // 3. 正常增量累加
  message.content += chunk;
};

// 组装 OpenAI 兼容消息列表
const buildOpenAIMessages = (systemPrompt: string) => {
  const result: OpenAIMessage[] = [];
  if (systemPrompt.trim()) {
    result.push({ role: "system", content: systemPrompt.trim() });
  }
  for (const message of messages.value) {
    if (message.role === "user" || message.role === "assistant") {
      result.push({ role: message.role, content: message.content });
    }
  }
  return result;
};

// 上传 Dify 附件并回填 upload_file_id
const ensureDifyUploads = async (signal?: AbortSignal) => {
  for (const attachment of attachments.value) {
    if (!attachment.file || attachment.status === "uploaded") {
      continue;
    }
    try {
      const meta = await uploadDifyFile({
        baseUrl: settings.dify.baseUrl,
        apiKey: settings.dify.apiKey,
        user: settings.dify.user,
        file: attachment.file,
        signal,
      });
      attachment.status = "uploaded";
      attachment.uploadFileId = meta.id;
    } catch (err) {
      attachment.status = "error";
      attachment.error = err instanceof Error ? err.message : "上传失败";
      throw err;
    }
  }
};

// 同步上传状态到用户消息附件（避免发送后看不到附件）
const syncUserAttachments = (target?: Message) => {
  if (!target?.attachments?.length) return;
  for (const item of target.attachments) {
    const latest = attachments.value.find((att) => att.id === item.id);
    if (!latest) continue;
    item.status = latest.status;
    item.uploadFileId = latest.uploadFileId;
    item.error = latest.error;
  }
};

// 发送消息主流程
const sendMessage = async () => {
  if (!composer.value.trim() || isBusy.value) {
    return;
  }

  error.value = "";
  info.value = "";

  // 必填参数校验
  if (settings.providerId === "dify") {
    if (
      !settings.dify.baseUrl ||
      !settings.dify.apiKey ||
      !settings.dify.user
    ) {
      error.value = "请先填写 Dify Base URL、API Key 和 User ID。";
      showSettings.value = true;
      return;
    }
  } else {
    if (!compatConfig.value.baseUrl || !compatConfig.value.model) {
      error.value = "请先填写 Base URL 和模型名称。";
      showSettings.value = true;
      return;
    }
    if (settings.providerId === "openai" && !compatConfig.value.apiKey) {
      error.value = "OpenAI 需要 API Key。";
      showSettings.value = true;
      return;
    }
  }

  // 先写入用户消息，增强响应感
  const text = composer.value.trim();
  composer.value = "";

  // 确保有会话容器
  ensureConversation(text);

  const pendingAttachments = attachments.value.map((item) => ({ ...item }));

  const userMessage: Message = {
    id: `user-${Date.now()}`,
    role: "user",
    content: text,
    attachments: pendingAttachments.length ? pendingAttachments : undefined,
  };
  messages.value.push(userMessage);
  syncConversation();

  // 预留助手消息用于流式更新
  const assistantMessage: Message = {
    id: `assistant-${Date.now()}`,
    role: "assistant",
    content: "",
  };
  messages.value.push(assistantMessage);
  await scrollToBottom();

  status.value = streamingEnabled.value ? "streaming" : "sending";
  const controller = new AbortController();
  abortController.value = controller;
  let streamed = false;

  try {
    if (settings.providerId === "dify") {
      // 解析 Inputs JSON
      let inputs = {};
      try {
        inputs = parseJsonSafe(settings.dify.inputsJson);
      } catch {
        throw new Error("Inputs JSON 格式不正确。");
      }

      // 上传附件
      if (attachments.value.length) {
        await ensureDifyUploads(controller.signal);
      }

      // 更新用户消息里的附件状态
      syncUserAttachments(userMessage);

      const filesPayload =
        attachments.value
          .filter((item) => item.uploadFileId)
          .map((item) => ({
            type: item.mimeType.startsWith("image/") ? "image" : "document",
            transfer_method: "local_file",
            upload_file_id: item.uploadFileId as string,
          })) ?? [];

      attachments.value = [];

      const result = await sendDifyChat({
        baseUrl: settings.dify.baseUrl,
        apiKey: settings.dify.apiKey,
        user: settings.dify.user,
        query: text,
        inputs,
        responseMode: streamingEnabled.value ? "streaming" : "streaming",
        conversationId: settings.dify.conversationId || undefined,
        files: filesPayload,
        signal: controller.signal,
        onToken: (token) => {
          streamed = true;
          applyStreamChunk(assistantMessage, token);
          // 流式输出时持续滚动到底部
          scheduleScroll();
        },
      });

      if (!assistantMessage.content) {
        assistantMessage.content = result.answer;
      }
      const hasAnswer = assistantMessage.content.trim().length > 0;
      if (!hasAnswer) {
        assistantMessage.content = "服务端未返回回答。";
        error.value = error.value || "服务端未返回回答。";
      }
      if (streamingEnabled.value && !streamed && !hasAnswer) {
        info.value =
          "当前接口返回非流式响应，已按普通模式展示。可能是服务端未开启流式或网关屏蔽。";
      } else {
        info.value = "";
      }
      scheduleScroll();
      if (result.conversationId) {
        settings.dify.conversationId = result.conversationId;
      }
      syncConversation();
    } else {
      const result = await sendOpenAIChat({
        baseUrl: compatConfig.value.baseUrl,
        apiKey: compatConfig.value.apiKey || undefined,
        model: compatConfig.value.model,
        messages: buildOpenAIMessages(compatConfig.value.systemPrompt),
        stream: streamingEnabled.value,
        signal: controller.signal,
        onToken: (token) => {
          streamed = true;
          applyStreamChunk(assistantMessage, token);
          // 流式输出时持续滚动到底部
          scheduleScroll();
        },
      });
      if (!assistantMessage.content) {
        assistantMessage.content = result.answer;
      }
      const hasAnswer = assistantMessage.content.trim().length > 0;
      if (!hasAnswer) {
        assistantMessage.content = "服务端未返回回答。";
        error.value = error.value || "服务端未返回回答。";
      }
      if (streamingEnabled.value && !streamed && !hasAnswer) {
        info.value =
          "当前接口返回非流式响应，已按普通模式展示。可能是服务端未开启流式或网关屏蔽。";
      } else {
        info.value = "";
      }
      scheduleScroll();
      syncConversation();
    }
  } catch (err) {
    if ((err as DOMException)?.name === "AbortError") {
      assistantMessage.content ||= "已停止输出。";
    } else {
      const message = err instanceof Error ? err.message : "请求失败。";
      assistantMessage.content ||= message;
      error.value = message;
    }
  } finally {
    status.value = "idle";
    abortController.value = null;
    // 结束后再确保一次贴底
    scheduleScroll();
    syncConversation();
  }
};
</script>

<template>
  <div class="min-h-screen w-full">
    <!-- 主聊天容器 -->
    <section class="chat-shell">
      <!-- 标题层 -->
      <div
        ref="headerRef"
        class="chat-header border-b border-line/50 px-5 pb-4 pt-4"
      >
        <div class="header-grid">
          <!-- 左侧历史按钮：两个横杆，第二根更短 -->
          <button
            class="btn-quiet btn-history"
            type="button"
            aria-label="历史聊天"
            title="历史聊天"
            @click="toggleHistory"
          >
            <span class="history-bar"></span>
            <span class="history-bar"></span>
          </button>

          <!-- 中间标题与在线状态 -->
          <div class="header-center">
            <h1 class="header-title">{{ currentTitle }}</h1>
            <p class="header-status">
              <span :class="statusClass">{{ statusLabel }}</span>
            </p>
          </div>

          <!-- 右侧新开聊天按钮（短按新开，长按 5 秒进入设置） -->
          <button
            class="btn-quiet btn-chat-new"
            type="button"
            aria-label="新开聊天"
            title="新开聊天"
            @pointerdown="startLongPress"
            @pointerup="handleNewChatRelease"
            @pointerleave="cancelLongPress"
            @pointercancel="cancelLongPress"
            @contextmenu.prevent
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M6 6.5A3.5 3.5 0 0 1 9.5 3h7A3.5 3.5 0 0 1 20 6.5v5A3.5 3.5 0 0 1 16.5 15H10l-4 4v-4.5A3.5 3.5 0 0 1 6 11.5z"
                fill="none"
                stroke="currentColor"
                stroke-width="1.6"
                stroke-linejoin="round"
              />
              <path
                d="M18 4.5h4M20 2.5v4"
                fill="none"
                stroke="currentColor"
                stroke-width="1.6"
                stroke-linecap="round"
              />
            </svg>
          </button>
        </div>
      </div>

      <!-- 聊天内容区（可滚动） -->
      <div
        ref="chatRef"
        class="scrollbar-soft flex-1 space-y-4 overflow-y-auto px-5 py-6"
      >
        <!-- 暂时不需要，但后续可能要用，先留着 -->
        <!-- <div
          v-if="messages.length === 0"
          class="rounded-2xl border border-dashed border-line/60 bg-surface/70 p-6 text-sm text-muted"
        >
          欢迎使用聊天控制台。长按右上角图标 5 秒打开设置。
        </div> -->

        <!-- 聊天气泡 -->
        <div
          v-for="message in formattedMessages"
          :key="message.id"
          class="flex"
          :class="message.role === 'user' ? 'justify-end' : 'justify-start'"
        >
          <div
            class="bubble"
            :class="
              message.role === 'user' ? 'bubble-user' : 'bubble-assistant'
            "
          >
            <!-- 思考过程 -->
            <details
              v-if="message.think || message.isThinking"
              class="think-box"
              open
            >
              <summary
                class="think-title"
                :aria-label="message.isThinking ? '正在思考' : '思考'"
              >
                <svg class="think-icon" viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="M9.5 18.5h5M10 21h4M12 3a6.5 6.5 0 0 0-3.9 11.7c.6.4 1.1 1.2 1.2 2h5.4c.1-.8.6-1.6 1.2-2A6.5 6.5 0 0 0 12 3z"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.6"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
              </summary>
              <div class="think-content">{{ message.think }}</div>
            </details>

            <!-- 回答正文 -->
            <p v-if="message.answer" class="bubble-text">
              {{ message.answer }}
            </p>

            <!-- 加载占位符：只有在真正什么都没有输出的时候才显示 -->
            <div
              v-else-if="
                message.isInitialLoading ||
                (message.isThinking && !message.think)
              "
              class="typing-indicator"
            >
              <span></span>
              <span></span>
              <span></span>
            </div>

            <!-- 附件展示（用户发送的文件） -->
            <div v-if="message.attachments?.length" class="mt-3">
              <div class="flex flex-wrap gap-2">
                <span
                  v-for="file in message.attachments"
                  :key="file.id"
                  class="chip"
                >
                  {{ file.name }} - {{ formatBytes(file.size) }}
                  <span v-if="file.status === 'error'" class="text-accent-2">
                    {{ file.error ? `上传失败：${file.error}` : "上传失败" }}
                  </span>
                  <span
                    v-else-if="file.status === 'uploaded'"
                    class="text-muted"
                  >
                    已上传
                  </span>
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 输入区 -->
      <div class="border-t border-line/50 px-5 py-4">
        <div
          v-if="info"
          class="mb-3 rounded-xl border border-accent/30 bg-white/80 p-3 text-xs text-accent"
        >
          {{ info }}
        </div>
        <div
          v-if="error"
          class="mb-3 rounded-xl border border-accent-2/40 bg-surface/70 p-3 text-xs text-accent-2"
        >
          {{ error }}
        </div>

        <!-- 待上传附件 -->
        <div v-if="attachments.length" class="mb-3 flex flex-wrap gap-2">
          <span v-for="file in attachments" :key="file.id" class="chip">
            {{ file.name }} - {{ formatBytes(file.size) }}
            <span v-if="file.status === 'error'" class="text-accent-2">
              {{ file.error ? `上传失败：${file.error}` : "上传失败" }}
            </span>
            <span v-else-if="file.status === 'uploaded'" class="text-muted">
              已上传
            </span>
            <button
              type="button"
              class="ml-2 text-muted hover:text-accent"
              @click="removeAttachment(file.id)"
            >
              x
            </button>
          </span>
        </div>

        <div class="space-y-3">
          <!-- 输入框容器：右下角放置图标按钮 -->
          <div class="composer-wrap">
            <!-- Shift + Enter 换行，Enter 发送 -->
            <textarea
              v-model="composer"
              ref="composerRef"
              class="textarea composer-textarea"
              rows="1"
              placeholder="输入内容，按 Enter 发送"
              @input="resizeComposer"
              @keydown.enter.exact.prevent="sendMessage"
            />

            <!-- 输入框内状态提示已移除 -->

            <!-- 右下角图标按钮：上传 + 发送（发送时切换为停止） -->
            <div class="composer-actions">
              <button
                class="icon-btn icon-upload"
                type="button"
                :class="
                  uploadEnabled ? 'icon-upload-active' : 'icon-upload-disabled'
                "
                :disabled="!uploadEnabled"
                @click="openUploadPicker"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="M12 7v10M7 12h10"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.8"
                    stroke-linecap="round"
                  />
                </svg>
              </button>
              <button
                class="icon-btn"
                type="button"
                :class="
                  sendButtonMode === 'stop'
                    ? 'icon-stop-active'
                    : sendEnabled
                    ? 'icon-send-active'
                    : 'icon-send-disabled'
                "
                :disabled="sendButtonMode !== 'stop' && !sendEnabled"
                @click="
                  sendButtonMode === 'stop' ? stopStreaming() : sendMessage()
                "
              >
                <Transition name="icon-fade" mode="out-in">
                  <svg
                    v-if="sendButtonMode === 'stop'"
                    key="stop"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <rect
                      x="7"
                      y="7"
                      width="10"
                      height="10"
                      rx="2"
                      fill="currentColor"
                    />
                  </svg>
                  <svg v-else key="send" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M12 4l6 7h-4v7h-4v-7H6l6-7z" fill="currentColor" />
                  </svg>
                </Transition>
              </button>
            </div>
          </div>

          <!-- 状态行已移入输入框内部 -->
        </div>
      </div>
    </section>

    <!-- 历史聊天面板：点击左上角按钮打开 -->
    <Transition name="history-fade">
      <div v-if="showHistory" class="history-overlay">
        <div class="history-backdrop" @click="toggleHistory" />
        <aside class="history-panel" @click.stop>
          <div class="history-header">
            <span class="section-title">历史聊天</span>
            <button
              v-if="conversations.length"
              class="history-clear"
              type="button"
              @click="clearAllHistory"
            >
              全部删除
            </button>
          </div>

          <div v-if="conversations.length === 0" class="history-empty">
            暂无历史记录，发送第一条消息后会自动保存到浏览器。
          </div>

          <div v-else class="history-list scrollbar-soft">
            <div
              v-for="item in conversations"
              :key="item.id"
              class="history-row"
            >
              <button
                type="button"
                :class="[
                  'history-item',
                  item.id === activeConversationId ? 'history-item-active' : '',
                ]"
                @click="selectConversation(item.id)"
              >
                <span class="history-bars">
                  <span></span>
                  <span></span>
                </span>
                <span class="history-title">{{ item.title }}</span>
              </button>
              <button
                class="history-delete"
                type="button"
                aria-label="删除记录"
                title="删除记录"
                @click="deleteConversation(item.id)"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="M6 7h12M9 7v10M15 7v10M10 4h4M8 7l1-3h6l1 3"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.6"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
              </button>
            </div>
          </div>
        </aside>
      </div>
    </Transition>

    <!-- 隐藏的文件选择器，通过按钮触发 -->
    <input
      ref="fileInputRef"
      type="file"
      class="hidden"
      :disabled="!canUpload"
      :accept="fileAccept"
      multiple
      @change="onFileChange"
    />

    <!-- 设置弹窗 -->
    <div v-if="showSettings" class="fixed inset-0 z-30">
      <div
        class="absolute inset-0 bg-black/60 backdrop-blur-sm"
        @click="closeSettings"
      />
      <div class="absolute inset-0 flex items-center justify-center px-4 py-8">
        <div class="card w-full max-w-xl animate-fadeUp" @click.stop>
          <!-- 弹窗内容可滚动，兼容手机 -->
          <div
            class="scrollbar-soft max-h-[80vh] space-y-6 overflow-y-auto p-6"
          >
            <div class="flex items-center justify-between">
              <div>
                <p class="section-title">设置中心</p>
                <h2 class="text-lg font-semibold text-ink">Chat 配置</h2>
              </div>
              <button class="btn-quiet" type="button" @click="closeSettings">
                关闭
              </button>
            </div>

            <div class="space-y-3">
              <span class="section-title">选择厂商</span>
              <select v-model="settings.providerId" class="input">
                <option
                  v-for="provider in providers"
                  :key="provider.id"
                  :value="provider.id"
                >
                  {{ provider.label }}
                </option>
              </select>
              <p class="text-xs text-muted">{{ activeProvider?.hint }}</p>
            </div>

            <div class="space-y-3">
              <span class="section-title">输出模式</span>
              <div class="flex flex-wrap gap-2">
                <button
                  type="button"
                  :class="streamingEnabled ? 'btn-primary' : 'btn-ghost'"
                  @click="settings.ui.streaming = true"
                >
                  流式
                </button>
                <button
                  type="button"
                  :class="!streamingEnabled ? 'btn-primary' : 'btn-ghost'"
                  @click="settings.ui.streaming = false"
                >
                  普通
                </button>
              </div>
            </div>

            <div v-if="settings.providerId === 'dify'" class="space-y-4">
              <div class="space-y-2">
                <span class="section-title">Dify Base URL</span>
                <input
                  v-model="settings.dify.baseUrl"
                  class="input"
                  placeholder="https://api.dify.ai"
                />
              </div>
              <div class="space-y-2">
                <span class="section-title">Dify API Key</span>
                <input
                  v-model="settings.dify.apiKey"
                  class="input"
                  placeholder="app-... or sk-..."
                />
              </div>
              <div class="space-y-2">
                <span class="section-title">User ID</span>
                <input v-model="settings.dify.user" class="input" />
              </div>
              <div class="space-y-2">
                <span class="section-title">Conversation ID</span>
                <div class="flex gap-2">
                  <input
                    v-model="settings.dify.conversationId"
                    class="input"
                    placeholder="首次对话后自动填充"
                  />
                  <button
                    class="btn-ghost"
                    type="button"
                    @click="resetDifyConversation"
                  >
                    重置
                  </button>
                </div>
              </div>
              <details class="space-y-2">
                <summary class="cursor-pointer text-sm font-semibold text-ink">
                  高级 Inputs (JSON)
                </summary>
                <textarea
                  v-model="settings.dify.inputsJson"
                  class="textarea"
                  rows="4"
                  spellcheck="false"
                />
                <p class="text-xs text-muted">Inputs 仅用于新会话。</p>
              </details>
              <div
                class="rounded-2xl border border-line/60 bg-surface/70 p-4 text-xs text-muted"
              >
                Dify 支持文件上传。若服务端限制文件类型，请更换格式。
              </div>
            </div>

            <div v-else class="space-y-4">
              <div class="space-y-2">
                <span class="section-title">Base URL</span>
                <input
                  v-model="compatConfig.baseUrl"
                  class="input"
                  placeholder="https://api.your-provider.com/v1"
                />
              </div>
              <div class="space-y-2">
                <span class="section-title">API Key</span>
                <input
                  v-model="compatConfig.apiKey"
                  class="input"
                  placeholder="本地部署可不填"
                />
              </div>
              <div class="space-y-2">
                <span class="section-title">模型名称</span>
                <input
                  v-model="compatConfig.model"
                  class="input"
                  placeholder="模型 ID"
                />
              </div>
              <details class="space-y-2">
                <summary class="cursor-pointer text-sm font-semibold text-ink">
                  系统提示词
                </summary>
                <textarea
                  v-model="compatConfig.systemPrompt"
                  class="textarea"
                  rows="4"
                />
              </details>
              <div
                class="rounded-2xl border border-line/60 bg-surface/70 p-4 text-xs text-muted"
              >
                该模式需要 OpenAI 兼容的聊天接口。
              </div>
            </div>

            <div class="flex flex-wrap items-center justify-between gap-3">
              <button class="btn-ghost" type="button" @click="clearChat">
                清空聊天
              </button>
              <button class="btn-primary" type="button" @click="closeSettings">
                保存并关闭
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

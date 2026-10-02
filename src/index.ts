import type {
  AgentEndEvent,
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  WeChatBot,
  stripMarkdown,
  type IncomingMessage,
} from "@wechatbot/wechatbot";
import qrTerminal from "qrcode-terminal";
import { join } from "node:path";
import { homedir } from "node:os";
import { SparkStore, formatSparkContents } from "./store.ts";
import {
  buildSemanticSearchPrompt,
  chunkIndexedRecords,
  findHashtagMatchIndexes,
  formatSparkLines,
  getRecentRecords,
  indexSparkRecords,
  parseSemanticSearchResult,
  type IndexedSparkRecord,
} from "./search.ts";

// WeChat SDK credentials live in the spark data directory by default and can be overridden by environment.
const WECHAT_STORAGE_DIR = process.env.PI_SPARK_WECHAT_STORAGE_DIR?.trim()
  || join(homedir(), ".pi", "agent", "spark", "wechat");

/** Pi extension entry point: registers commands, model search, and the WeChat bridge lifecycle. */
export default function sparkExtension(pi: ExtensionAPI): void {
  const store = new SparkStore();
  let bot: WeChatBot | undefined;
  let connected = false;
  // Plain WeChat messages enter Pi; this queue retains each source message for the matching agent reply.
  const pendingReplies: IncomingMessage[] = [];

  /** Saves a record and builds confirmation text suitable for Pi and WeChat. */
  async function addSpark(content: string): Promise<string> {
    const record = await store.add(content);
    const tags = record.hashtags.length > 0
      ? record.hashtags.map((tag) => `#${tag}`).join(" ")
      : "无";
    return `已保存 spark：${record.content}\n输入时间：${record.inputTime}\nhashtags：${tags}`;
  }

  /** Shared `/spark_all` implementation: an empty query returns all records; otherwise it filters locally. */
  async function listSparks(query = ""): Promise<string> {
    const records = await store.search(query);
    if (records.length === 0) return query.trim() ? "没有匹配的 spark" : "还没有保存 spark";
    return formatSparkContents(records);
  }

  /**
   * Two-stage search: match exact hashtags first, then ask the current Pi model to analyze the rest.
   * Both result sets are merged in original file order without duplicates.
   */
  async function searchSparks(query: string, ctx: ExtensionCommandContext): Promise<string> {
    const records = await store.all();
    if (records.length === 0) return "Sparking";

    const hashtagIndexes = findHashtagMatchIndexes(records, query);
    const selectedIndexes = new Set(hashtagIndexes);
    const candidates = indexSparkRecords(records, selectedIndexes);

    if (candidates.length > 0) {
      if (!ctx.model) throw new Error("当前 Pi 会话没有可用模型，无法执行语义检索");
      ctx.ui.setStatus("spark-search", `正在用 ${ctx.model.provider}/${ctx.model.id} 检索…`);
      try {
        // Process model calls in chunks so every record not matched by hashtag is still analyzed.
        for (const chunk of chunkIndexedRecords(candidates)) {
          const ids = await selectRelatedIdsWithCurrentModel(query, chunk, ctx);
          for (const id of ids) {
            const match = chunk.find((item) => item.id === id);
            if (match) selectedIndexes.add(match.index);
          }
        }
      } finally {
        ctx.ui.setStatus("spark-search", undefined);
      }
    }

    return formatSparkLines(records.filter((_record, index) => selectedIndexes.has(index)));
  }

  async function recentSparks(): Promise<string> {
    return formatSparkLines(getRecentRecords(await store.all()));
  }

  async function lightedSparks(): Promise<string> {
    const records = await store.lighted();
    if (records.length === 0) return "Sparking";
    return records.map((record) => `${record.inputTime}：${record.content}`).join("\n");
  }

  // All commands share one SparkStore so file mutations remain ordered within this process.
  pi.registerCommand("spark_add", {
    description: "保存一条灵感：/spark_add <内容>",
    handler: async (args, ctx) => {
      try {
        let content = args?.trim() ?? "";
        if (!content && ctx.hasUI) {
          content = (await ctx.ui.input("新增 spark", "输入灵感内容，可包含 #hashtag"))?.trim() ?? "";
        }
        if (!content) return;
        ctx.ui.notify(await addSpark(content), "info");
      } catch (error) {
        ctx.ui.notify(errorMessage(error), "error");
      }
    },
  });

  pi.registerCommand("spark_search", {
    description: "按 hashtag 与语义搜索 spark：/spark_search <内容>",
    handler: async (args, ctx) => {
      try {
        let query = args?.trim() ?? "";
        if (!query && ctx.hasUI) {
          query = (await ctx.ui.input("搜索 spark", "输入 hashtag、主题或想法"))?.trim() ?? "";
        }
        if (!query) {
          ctx.ui.notify("Sparking", "info");
          return;
        }
        ctx.ui.notify(await searchSparks(query, ctx), "info");
      } catch (error) {
        ctx.ui.setStatus("spark-search", undefined);
        ctx.ui.notify(errorMessage(error), "error");
      }
    },
  });

  pi.registerCommand("spark_now", {
    description: "显示最近 7 天的 spark",
    handler: async (_args, ctx) => {
      try {
        ctx.ui.notify(await recentSparks(), "info");
      } catch (error) {
        ctx.ui.notify(errorMessage(error), "error");
      }
    },
  });

  pi.registerCommand("spark_lighting", {
    description: "选择一条 spark，将其从当前记录移入 lighted 归档",
    handler: async (_args, ctx) => {
      try {
        const records = await store.all();
        if (records.length === 0) {
          ctx.ui.notify("Sparking", "info");
          return;
        }
        if (!ctx.hasUI) {
          ctx.ui.notify("/spark_lighting 需要在 Pi 交互界面中使用", "warning");
          return;
        }

        // The product requires a content-only picker, so timestamps and internal indexes stay hidden.
        const selected = await ctx.ui.select("选择要点亮的 spark", records.map((record) => record.content));
        if (selected === undefined) return;
        const index = records.findIndex((record) => record.content === selected);
        if (index < 0) return;

        const confirmed = await ctx.ui.confirm("确认点亮", `将从当前 spark 中删除并归档：\n${selected}`);
        if (!confirmed) return;

        const moved = await store.light(index);
        ctx.ui.notify(moved ? `已点亮：${moved.content}` : "该 spark 已不存在", moved ? "info" : "warning");
      } catch (error) {
        ctx.ui.notify(errorMessage(error), "error");
      }
    },
  });

  pi.registerCommand("spark_lighted", {
    description: "显示所有已点亮归档的 spark",
    handler: async (_args, ctx) => {
      try {
        ctx.ui.notify(await lightedSparks(), "info");
      } catch (error) {
        ctx.ui.notify(errorMessage(error), "error");
      }
    },
  });

  pi.registerCommand("spark_all", {
    description: "列出全部 spark；可选输入关键词或 #hashtag 进行查询",
    handler: async (args, ctx) => {
      try {
        ctx.ui.notify(await listSparks(args ?? ""), "info");
      } catch (error) {
        ctx.ui.notify(errorMessage(error), "error");
      }
    },
  });

  pi.registerCommand("spark_wechat", {
    description: "连接微信，在手机上与当前 Pi 会话对话",
    handler: async (args, ctx) => {
      await startWechat(args ?? "", ctx);
    },
  });

  pi.registerCommand("spark_wechat_disconnect", {
    description: "断开 spark 的微信连接",
    handler: async (_args, ctx) => {
      await stopWechat();
      ctx.ui.setStatus("spark-wechat", undefined);
      ctx.ui.notify("微信连接已断开", "info");
    },
  });

  // Before a WeChat message reaches the model, add constraints for concise mobile-friendly plain text.
  pi.on("before_agent_start", (event) => {
    if (!connected || pendingReplies.length === 0) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\n` +
        "## WeChat bridge\n" +
        "当前用户通过微信与你对话。回复会作为微信纯文本发送，请简洁、自然，避免依赖 Markdown 排版。",
    };
  });

  // After the agent finishes, send its latest response to the first pending WeChat message.
  pi.on("agent_end", async (event, ctx) => {
    if (!bot || !connected || pendingReplies.length === 0) return;
    const incoming = pendingReplies.shift();
    if (!incoming) return;

    const response = extractAssistantText(event) || "[Pi 没有返回文本]";
    try {
      await bot.stopTyping(incoming.userId).catch(() => undefined);
      await bot.reply(incoming, stripMarkdown(response));
      ctx.ui.setStatus("spark-wechat", "✓ 已回复微信");
    } catch (error) {
      ctx.ui.setStatus("spark-wechat", `回复失败：${errorMessage(error)}`);
    }
  });

  pi.on("session_shutdown", async () => {
    await stopWechat();
  });

  /** Signs in to WeChat and establishes the `WeChat message -> Pi -> WeChat reply` bridge. */
  async function startWechat(args: string, ctx: ExtensionCommandContext): Promise<void> {
    if (connected && bot) {
      ctx.ui.notify("微信已经连接；如需重新扫码，请先运行 /spark_wechat_disconnect", "info");
      return;
    }

    bot = new WeChatBot({
      storage: "file",
      storageDir: WECHAT_STORAGE_DIR,
      logLevel: "warn",
    });
    ctx.ui.setStatus("spark-wechat", "正在连接微信…");

    try {
      const credentials = await bot.login({
        force: args.trim() === "--force",
        callbacks: {
          onQrUrl: (url) => {
            qrTerminal.generate(url, { small: true }, (qr: string) => {
              process.stderr.write("\n请用微信扫描二维码：\n\n");
              process.stderr.write(`${qr}\n`);
            });
            ctx.ui.setStatus("spark-wechat", "请扫描终端中的微信二维码");
          },
          onScanned: () => ctx.ui.setStatus("spark-wechat", "已扫码，请在微信中确认…"),
          onExpired: () => ctx.ui.setStatus("spark-wechat", "二维码已过期，正在刷新…"),
        },
      });

      connected = true;
      ctx.ui.setStatus("spark-wechat", `✓ 微信：${credentials.accountId}`);
      ctx.ui.notify(`微信已连接：${credentials.accountId}`, "info");

      bot.onMessage(async (message: IncomingMessage) => {
        if (!bot || message.type !== "text") {
          if (bot) await bot.reply(message, "spark 当前只处理文字消息");
          return;
        }

        const text = message.text.trim();
        try {
          // Handle spark commands in the bridge; only plain messages enter the current Pi session.
          if (text === "/spark_add" || text.startsWith("/spark_add ")) {
            await bot.reply(message, await addSpark(text.slice("/spark_add".length)));
            return;
          }
          if (text === "/spark_all" || text.startsWith("/spark_all ")) {
            await bot.reply(message, await listSparks(text.slice("/spark_all".length)));
            return;
          }
          if (text === "/spark_search" || text.startsWith("/spark_search ")) {
            const query = text.slice("/spark_search".length).trim();
            await bot.reply(message, query ? await searchSparks(query, ctx) : "Sparking");
            return;
          }
          if (text === "/spark_now") {
            await bot.reply(message, await recentSparks());
            return;
          }
          if (text === "/spark_lighted") {
            await bot.reply(message, await lightedSparks());
            return;
          }
          if (text === "/spark_lighting") {
            await bot.reply(message, "/spark_lighting 需要在 Pi 交互界面中选择并确认记录");
            return;
          }

          pendingReplies.push(message);
          await bot.sendTyping(message.userId).catch(() => undefined);
          ctx.ui.setStatus("spark-wechat", `微信消息：${text.slice(0, 48)}`);
          pi.sendUserMessage(text || "[空消息]", {
            deliverAs: "followUp",
            expandPromptTemplates: true,
          });
        } catch (error) {
          await bot.reply(message, `处理失败：${errorMessage(error)}`);
        }
      });

      bot.on("error", (error) => {
        ctx.ui.setStatus("spark-wechat", `微信错误：${errorMessage(error)}`);
      });

      void bot.start().catch((error) => {
        connected = false;
        ctx.ui.setStatus("spark-wechat", `微信轮询已停止：${errorMessage(error)}`);
      });
    } catch (error) {
      connected = false;
      bot = undefined;
      ctx.ui.setStatus("spark-wechat", undefined);
      ctx.ui.notify(`微信登录失败：${errorMessage(error)}`, "error");
    }
  }

  /** Stops WeChat polling and clears pending messages so a closed session cannot send stale replies. */
  async function stopWechat(): Promise<void> {
    const current = bot;
    bot = undefined;
    connected = false;
    pendingReplies.length = 0;
    if (current) await Promise.resolve(current.stop());
  }
}

/** Calls the model selected by the current Pi session and constrains output to candidate IDs. */
async function selectRelatedIdsWithCurrentModel(
  query: string,
  records: IndexedSparkRecord[],
  ctx: ExtensionCommandContext,
): Promise<string[]> {
  if (!ctx.model) return [];
  const reasoning = resolveSemanticReasoningLevel(ctx.model, ctx.thinkingLevel);
  const stream = ctx.modelRegistry.streamSimple(
    ctx.model,
    {
      messages: [{
        role: "user",
        content: buildSemanticSearchPrompt(query, records),
        timestamp: Date.now(),
      }],
    },
    {
      temperature: 0,
      maxTokens: 2_048,
      ...(reasoning ? { reasoning } : {}),
    },
  );
  const response = await stream.result();
  if (response.stopReason === "error") {
    throw new Error(response.errorMessage || "模型语义检索失败");
  }
  const output = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  return parseSemanticSearchResult(output, new Set(records.map((record) => record.id)));
}

type SearchReasoningLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Selects a thinking level the model actually supports.
 * Some models cannot disable thinking, so unsupported settings prefer low/high/max fallbacks.
 */
function resolveSemanticReasoningLevel(
  model: {
    reasoning?: boolean;
    thinkingLevelMap?: Partial<Record<SearchReasoningLevel | "off", string | null>>;
  },
  current?: SearchReasoningLevel | "off",
): SearchReasoningLevel | undefined {
  if (!model.reasoning) return undefined;

  const fallbackOrder: SearchReasoningLevel[] = ["low", "high", "max", "minimal", "medium", "xhigh"];
  const candidates = current && current !== "off"
    ? [current, ...fallbackOrder.filter((level) => level !== current)]
    : fallbackOrder;

  for (const level of candidates) {
    if (!model.thinkingLevelMap || model.thinkingLevelMap[level] !== null) return level;
  }
  throw new Error("当前模型要求 thinking，但没有可用的推理等级");
}

/** Combines all assistant text blocks from an agent run for a plain-text WeChat reply. */
function extractAssistantText(event: AgentEndEvent): string {
  return event.messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => message.content)
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

/** Converts an unknown exception into a user-displayable error message. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

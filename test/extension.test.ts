import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import sparkExtension from "../src/index.ts";
import { SparkStore } from "../src/store.ts";

type CommandHandler = (args: string | undefined, ctx: any) => Promise<void> | void;

test("selecting /spark_add without inline content opens an input dialog and saves its value", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spark-extension-"));
  const filePath = join(directory, "sparks.jsonl");
  process.env.PI_SPARK_FILE = filePath;

  const commands = new Map<string, CommandHandler>();
  const fakePi = {
    registerCommand(name: string, options: { handler: CommandHandler }) {
      commands.set(name, options.handler);
    },
    on() {
      return () => undefined;
    },
  } as unknown as ExtensionAPI;

  sparkExtension(fakePi);
  assert.ok(commands.has("spark_add"));
  assert.ok(commands.has("spark_search"));
  assert.ok(commands.has("spark_now"));
  assert.ok(commands.has("spark_lighting"));
  assert.ok(commands.has("spark_lighted"));

  const notifications: Array<{ message: string; type?: string }> = [];
  let inputCalls = 0;
  await commands.get("spark_add")?.("", {
    hasUI: true,
    ui: {
      input: async () => {
        inputCalls += 1;
        return "弹框输入的灵感 #dialog";
      },
      notify: (message: string, type?: string) => notifications.push({ message, type }),
    },
  });

  assert.equal(inputCalls, 1);
  assert.equal(notifications[0]?.type, "info");
  assert.match(notifications[0]?.message ?? "", /已保存 spark/);
  const saved = JSON.parse((await readFile(filePath, "utf8")).trim());
  assert.equal(saved.content, "弹框输入的灵感 #dialog");
  assert.deepEqual(saved.hashtags, ["dialog"]);
});

test("/spark_lighting selects content, confirms, moves it, and /spark_lighted keeps creation time", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spark-extension-lighting-"));
  const filePath = join(directory, "sparks.jsonl");
  const lightedFilePath = join(directory, "lighted.jsonl");
  process.env.PI_SPARK_FILE = filePath;
  process.env.PI_SPARK_LIGHTED_FILE = lightedFilePath;
  const store = new SparkStore({
    filePath,
    lightedFilePath,
    now: (() => {
      let second = 0;
      return () => new Date(`2026-10-02T08:00:0${second++}.000Z`);
    })(),
  });
  const kept = await store.add("保留的 spark");
  const selectedRecord = await store.add("准备点亮 #done");

  const commands = new Map<string, CommandHandler>();
  sparkExtension({
    registerCommand(name: string, options: { handler: CommandHandler }) {
      commands.set(name, options.handler);
    },
    on() {
      return () => undefined;
    },
  } as unknown as ExtensionAPI);

  const notifications: string[] = [];
  let shownOptions: string[] = [];
  const ui = {
    select: async (_title: string, options: string[]) => {
      shownOptions = options;
      return "准备点亮 #done";
    },
    confirm: async () => true,
    notify: (message: string) => notifications.push(message),
  };

  await commands.get("spark_lighting")?.("", { hasUI: true, ui });
  assert.deepEqual(shownOptions, ["保留的 spark", "准备点亮 #done"]);
  assert.deepEqual(await store.all(), [kept]);
  assert.deepEqual(await store.lighted(), [selectedRecord]);

  await commands.get("spark_lighted")?.("", { hasUI: true, ui });
  assert.equal(notifications.at(-1), `${selectedRecord.inputTime}：${selectedRecord.content}`);
});

test("/spark_search unions exact hashtag hits with current-model semantic hits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spark-extension-search-"));
  const filePath = join(directory, "sparks.jsonl");
  process.env.PI_SPARK_FILE = filePath;
  const store = new SparkStore({
    filePath,
    now: (() => {
      let second = 0;
      return () => new Date(`2026-10-01T00:00:0${second++}.000Z`);
    })(),
  });
  await store.add("微信机器人 #wechat");
  await store.add("手机上的 AI 对话入口");
  await store.add("晚饭买青菜");

  const commands = new Map<string, CommandHandler>();
  sparkExtension({
    registerCommand(name: string, options: { handler: CommandHandler }) {
      commands.set(name, options.handler);
    },
    on() {
      return () => undefined;
    },
  } as unknown as ExtensionAPI);

  let modelPrompt = "";
  let modelOptions: { reasoning?: string } = {};
  const notifications: string[] = [];
  await commands.get("spark_search")?.("wechat", {
    hasUI: true,
    thinkingLevel: "off",
    model: {
      provider: "test",
      id: "semantic-model",
      reasoning: true,
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: "low",
        medium: null,
        high: "high",
        xhigh: null,
        max: "max",
      },
    },
    modelRegistry: {
      streamSimple: (
        _model: unknown,
        context: { messages: Array<{ content: string }> },
        options: { reasoning?: string },
      ) => {
        modelPrompt = context.messages[0]?.content ?? "";
        modelOptions = options;
        return {
          result: async () => ({
            stopReason: "stop",
            content: [{ type: "text", text: '{"related_ids":["spark-2"]}' }],
          }),
        };
      },
    },
    ui: {
      input: async () => undefined,
      notify: (message: string) => notifications.push(message),
      setStatus: () => undefined,
    },
  });

  assert.doesNotMatch(modelPrompt, /微信机器人/);
  assert.match(modelPrompt, /手机上的 AI 对话入口/);
  assert.equal(modelOptions.reasoning, "low");
  assert.equal(
    notifications[0],
    "2026-10-01T00:00:00.000Z 微信机器人 #wechat\n" +
      "2026-10-01T00:00:01.000Z 手机上的 AI 对话入口",
  );
});

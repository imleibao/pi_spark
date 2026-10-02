import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Shared schema for a spark in both the active and archived data files. */
export interface SparkRecord {
  content: string;
  inputTime: string;
  hashtags: string[];
}

/** Allows tests and custom deployments to override file paths and the system clock. */
export interface SparkStoreOptions {
  filePath?: string;
  lightedFilePath?: string;
  now?: () => Date;
}

// Tags support Unicode letters, numbers, underscores, and hyphens. The leading hash is not stored.
const HASHTAG_PATTERN = /#([\p{L}\p{N}_-]+)/gu;

/** Returns the active spark file path, with an environment-variable override. */
export function getDefaultSparkFile(): string {
  return process.env.PI_SPARK_FILE?.trim()
    || join(homedir(), ".pi", "agent", "spark", "sparks.jsonl");
}

/** Returns the lighted archive file path, with an environment-variable override. */
export function getDefaultLightedFile(): string {
  return process.env.PI_SPARK_LIGHTED_FILE?.trim()
    || join(homedir(), ".pi", "agent", "spark", "lighted.jsonl");
}

/** Extracts all hashtags in content order and preserves duplicate tags as entered. */
export function extractHashtags(content: string): string[] {
  return Array.from(content.matchAll(HASHTAG_PATTERN), (match) => match[1]);
}

/**
 * JSONL-backed data store.
 *
 * All mutations share one queue so concurrent writes in the same Pi process cannot overwrite each other.
 */
export class SparkStore {
  readonly filePath: string;
  readonly lightedFilePath: string;
  private readonly now: () => Date;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: SparkStoreOptions = {}) {
    this.filePath = options.filePath ?? getDefaultSparkFile();
    this.lightedFilePath = options.lightedFilePath ?? getDefaultLightedFile();
    this.now = options.now ?? (() => new Date());
  }

  /** Adds a record and assigns its ISO 8601 creation timestamp at write time. */
  async add(content: string): Promise<SparkRecord> {
    const normalized = content.trim();
    if (!normalized) {
      throw new Error("spark 内容不能为空");
    }

    const record: SparkRecord = {
      content: normalized,
      inputTime: this.now().toISOString(),
      hashtags: extractHashtags(normalized),
    };

    const write = async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, `${JSON.stringify(record)}\n`, "utf8");
    };

    await this.enqueueMutation(write);
    return record;
  }

  /** Reads all active records in their original file order. */
  async all(): Promise<SparkRecord[]> {
    await this.writeQueue;
    return readRecords(this.filePath, "spark");
  }

  /** Reads all lighted records in archive order. */
  async lighted(): Promise<SparkRecord[]> {
    await this.writeQueue;
    return readRecords(this.lightedFilePath, "lighted");
  }

  /**
   * Moves the active record at the given index into the lighted archive.
   * The archive preserves every original field and does not add a deletion timestamp.
   */
  async light(index: number): Promise<SparkRecord | undefined> {
    return this.enqueueMutation(async () => {
      const records = await readRecords(this.filePath, "spark");
      const record = records[index];
      if (!record) return undefined;

      const archived = await readRecords(this.lightedFilePath, "lighted");
      // If a previous run stopped after archiving but before rewriting the active file, do not archive twice.
      if (!archived.some((item) => sameRecord(item, record))) {
        await mkdir(dirname(this.lightedFilePath), { recursive: true });
        await appendFile(this.lightedFilePath, `${JSON.stringify(record)}\n`, "utf8");
      }

      records.splice(index, 1);
      await writeRecordsAtomically(this.filePath, records);
      return record;
    });
  }

  /** Applies an AND search across all terms using content inclusion and exact hashtag matching. */
  async search(query: string): Promise<SparkRecord[]> {
    const records = await this.all();
    const terms = query
      .trim()
      .toLocaleLowerCase()
      .split(/\s+/u)
      .filter(Boolean)
      .map((term) => term.replace(/^#/, ""));

    if (terms.length === 0) return records;

    return records.filter((record) => {
      const content = record.content.toLocaleLowerCase();
      const hashtags = record.hashtags.map((tag) => tag.toLocaleLowerCase());
      return terms.every((term) => content.includes(term) || hashtags.includes(term));
    });
  }

  /** Keeps later mutations running after a failure instead of leaving the queue permanently rejected. */
  private async enqueueMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const pending = this.writeQueue.then(mutation, mutation);
    this.writeQueue = pending.then(() => undefined, () => undefined);
    return pending;
  }
}

/** Reads and validates JSONL line by line; a missing file is treated as an empty data set. */
async function readRecords(filePath: string, label: string): Promise<SparkRecord[]> {
  let source: string;
  try {
    source = await readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }

  const records: SparkRecord[] = [];
  for (const [index, line] of source.split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      records.push(assertSparkRecord(JSON.parse(line)));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`${label} 数据第 ${index + 1} 行无效: ${detail}`);
    }
  }
  return records;
}

/**
 * Writes a temporary file in the same directory, then replaces the target with rename.
 * This prevents readers from observing a partially written active list.
 */
async function writeRecordsAtomically(filePath: string, records: SparkRecord[]): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  const content = records.length > 0
    ? `${records.map((record) => JSON.stringify(record)).join("\n")}\n`
    : "";
  try {
    await writeFile(temporaryPath, content, "utf8");
    await rename(temporaryPath, filePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

/** Returns whether all three persisted fields are identical. */
function sameRecord(left: SparkRecord, right: SparkRecord): boolean {
  return left.content === right.content
    && left.inputTime === right.inputTime
    && left.hashtags.length === right.hashtags.length
    && left.hashtags.every((tag, index) => tag === right.hashtags[index]);
}

/** Joins record contents with the single-space format required by `/spark_all`. */
export function formatSparkContents(records: SparkRecord[]): string {
  return records.map((record) => record.content).join(" ");
}

/** Validates local file data at runtime so malformed records cannot silently enter the domain layer. */
function assertSparkRecord(value: unknown): SparkRecord {
  if (!value || typeof value !== "object") {
    throw new Error("记录必须是对象");
  }

  const record = value as Partial<SparkRecord>;
  if (typeof record.content !== "string" || typeof record.inputTime !== "string") {
    throw new Error("缺少 content 或 inputTime");
  }
  if (!Array.isArray(record.hashtags) || !record.hashtags.every((tag) => typeof tag === "string")) {
    throw new Error("hashtags 必须是字符串数组");
  }
  return record as SparkRecord;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

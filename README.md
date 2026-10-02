# pi-spark-extension

`pi-spark-extension` is the npm package for `spark`, a local-first Pi extension that captures fragmented ideas, retrieves them by hashtag or semantic similarity, archives completed ideas, and optionally bridges the current Pi session to WeChat.

> A Chinese guide is also available in [`README.zh-CN.md`](./README.zh-CN.md).

## Features

1. Capture ideas whenever inspiration emerges in everyday life.
2. Use an LLM to search past ideas for sparks related to your input keywords.
3. Use hashtags freely to organize your ideas.
4. Connect Pi to WeChat with `@wechatbot/wechatbot`, so you can add ideas from your phone anytime, anywhere.

## Requirements

- Node.js 22.19 or later
- Pi 0.74 or later
- A terminal capable of displaying the WeChat login QR code

## Installation

Install the published package directly with Pi:

```bash
pi install npm:pi-spark-extension
```

Restart Pi after installation. The package registers the `spark` extension commands automatically.

### Install from a local checkout

For development, install dependencies from the project directory:

```bash
cd /path/to/pi_spark
npm install
```

Install the local extension in Pi:

```bash
pi install /path/to/pi_spark
```

While developing, run `/reload` in Pi after changing the extension source.

## Quick start

Add an idea inline:

```text
/spark_add Build a local idea inbox #product #pi
```

You can also select `/spark_add` without inline text. Pi will open an input dialog instead of saving an empty record.

List all active ideas:

```text
/spark_all
```

Search by hashtag and semantic relevance:

```text
/spark_search mobile conversations
```

Review recent ideas:

```text
/spark_now
```

Archive an idea through Pi's interactive picker:

```text
/spark_lighting
```

View archived ideas:

```text
/spark_lighted
```

## Command reference

| Command | Description |
| --- | --- |
| `/spark_add <content>` | Saves content, its ISO 8601 creation time, and extracted hashtags. Without inline content, opens an input dialog. |
| `/spark_all` | Returns every active record's content, joined by spaces. |
| `/spark_all <query>` | Filters active records locally by content or hashtag. All query terms must match. |
| `/spark_search <query>` | Combines exact hashtag matches with semantic matches selected by the current Pi model. Results use one `creation-time content` line per record. |
| `/spark_now` | Shows active records created within the rolling last seven days. |
| `/spark_lighting` | Shows a content-only picker, asks for confirmation, then moves the selected record into the lighted archive. Requires the Pi interactive UI. |
| `/spark_lighted` | Shows archived records as `original-creation-time:content`. |
| `/spark_wechat` | Starts the WeChat bridge and displays a login QR code. |
| `/spark_wechat --force` | Forces a fresh WeChat login. |
| `/spark_wechat_disconnect` | Stops the WeChat bridge and clears pending replies. |

Commands that return no matching records use the text `Sparking`.

## Local data

Active records are stored at:

```text
~/.pi/agent/spark/sparks.jsonl
```

Records moved by `/spark_lighting` are stored at:

```text
~/.pi/agent/spark/lighted.jsonl
```

Each non-empty line is one JSON record:

```json
{"content":"Build a local idea inbox #product","inputTime":"2026-10-01T12:34:56.000Z","hashtags":["product"]}
```

The active and archived files use the same schema. Archiving does not add a deletion timestamp or replace the original `inputTime`.

### Custom paths

Set these environment variables before starting Pi:

```bash
export PI_SPARK_FILE=/absolute/path/sparks.jsonl
export PI_SPARK_LIGHTED_FILE=/absolute/path/lighted.jsonl
export PI_SPARK_WECHAT_STORAGE_DIR=/absolute/path/wechat-auth
```

Keeping runtime data outside the source directory prevents plugin upgrades, Git operations, or source deletion from removing personal records.

## Search behavior

`/spark_search` uses a deterministic first stage and a model-assisted second stage:

1. It checks whether the entire query exactly matches a stored hashtag, ignoring case and an optional leading `#`.
2. It excludes those direct matches from the model request.
3. It asks the model currently selected in Pi to evaluate all remaining records in bounded chunks.
4. It accepts only valid candidate IDs from the model's JSON response.
5. It merges both result sets in original file order and removes duplicates.

The prompt treats stored records as untrusted data and tells the model to ignore instructions embedded inside them. Model output is still probabilistic, so semantic relevance may vary by model.

Models that require thinking are supported through Pi's `thinkingLevelMap`. If the current setting is unavailable or set to `off`, the extension chooses a supported level, preferring `low`, `high`, or `max`.

## WeChat bridge

Run:

```text
/spark_wechat
```

Scan the terminal QR code with your own WeChat account and confirm the login. Plain WeChat text is sent into the current Pi session; the resulting assistant text is converted to plain text and returned to the original message.

The following commands can be used directly from WeChat:

```text
/spark_add ...
/spark_all
/spark_search ...
/spark_now
/spark_lighted
```

`/spark_lighting` is only available inside Pi because it requires an interactive selection and confirmation UI.

The SDK stores credentials locally under `~/.pi/agent/spark/wechat/` by default. Use `/spark_wechat_disconnect` when the bridge is no longer needed.

## Development

Project structure:

```text
pi_spark/
├── src/
│   ├── index.ts       # Pi commands, model calls, and WeChat bridge
│   ├── search.ts      # Search rules, prompt construction, and model-output parsing
│   └── store.ts       # JSONL persistence and archive operations
├── test/
│   ├── extension.test.ts
│   └── store.test.ts
├── dev_doc/           # Detailed design and quality documents
├── package.json
├── package-lock.json
└── tsconfig.json
```

Run the complete quality gate:

```bash
npm run check
```

This runs strict TypeScript checking followed by all Node.js tests.

## Reliability notes

- Mutations are serialized within one Pi process.
- Active-file rewrites use a temporary file followed by an atomic rename.
- Archiving writes the complete original record before removing it from the active file.
- JSONL records are validated at runtime, and malformed input reports its line number.

## Security and privacy

- Spark data and WeChat credentials are local by default.
- Semantic search sends candidate record content to the model provider configured in the current Pi session.
- Plain WeChat messages enter the current Pi session and therefore have access to the same tools and filesystem permissions as that session.
- Connect only your own WeChat account and disconnect the bridge when it is not in use.

## Known limitations

- Because `/spark_lighting` intentionally displays content only, records with identical content cannot be distinguished in the picker; the earliest matching record is archived.
- JSONL storage reads the full file for queries and is intended for personal-scale data.
- The WeChat bridge currently handles text messages only.
- No restore, edit, cloud synchronization, encryption, or permanent archive-deletion command is included.

## License

MIT

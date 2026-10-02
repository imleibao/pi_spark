# spark

`spark` 是一个 Pi 扩展：把碎片化灵感以 JSONL 保存在本地，也可以通过微信在手机上继续和当前 Pi 会话对话。

需求、架构、开发和测试文档见 [`dev_doc/`](./dev_doc/README.md)。

## 安装

要求：Node.js 22.19+、Pi 0.74+。

```bash
cd /Users/lei/code/pi_spark
npm install
pi install /Users/lei/code/pi_spark
```

重启 Pi 后，插件会自动加载。本地路径包不会由 Pi 自动安装依赖，所以第一次必须先运行 `npm install`。

## 命令

```text
/spark_add 做一个灵感收集器 #product #pi
/spark_all
/spark_all #product
/spark_search 微信上的灵感
/spark_now
/spark_lighting
/spark_lighted
/spark_wechat
/spark_wechat --force
/spark_wechat_disconnect
```

- `/spark_add <内容>`：保存内容、ISO 8601 输入时间和从内容中提取的全部 hashtag。
- 直接选中 `/spark_add` 而不带参数时，会弹出输入框，不再报“内容不能为空”。
- `/spark_all`：无参数时，按保存顺序返回所有内容，用一个空格连接。
- `/spark_all <查询>`：附加能力；按内容或 hashtag 查询，多个查询词必须同时匹配。
- `/spark_search <内容>`：先精确匹配 hashtag，再使用当前 Pi 会话的模型对其余全部记录做语义筛选；结果按 `添加时间 内容` 每行一条显示，没有结果时显示 `Sparking`。
  语义调用会继承当前 thinking 等级；若该等级不受模型支持，会根据模型的 `thinkingLevelMap` 自动选择可用等级。
- `/spark_now`：显示最近 7 天的记录，按 `添加时间 内容` 每行一条显示；没有结果时显示 `Sparking`。
- `/spark_lighting`：只用内容展示全部当前记录；选中并确认后，从当前记录中删除该条，并把完整原记录移入 `lighted.jsonl`。
- `/spark_lighted`：显示全部已点亮记录，每行格式为 `spark创建时间：内容`；这里使用原始创建时间，不记录删除时间。
- `/spark_wechat`：使用 `@wechatbot/wechatbot` 登录微信。终端出现二维码后，用微信扫码确认。
- 微信连接后，普通文字会交给当前 Pi 会话处理；微信里也可以直接发送 `/spark_add ...`、`/spark_all`、`/spark_search ...`、`/spark_now` 和 `/spark_lighted`。`/spark_lighting` 需要 Pi 的可选列表和确认界面，因此只能在 Pi 中执行。

## 本地数据

默认数据文件：

```text
~/.pi/agent/spark/sparks.jsonl
```

每行是一条记录：

```json
{"content":"做一个灵感收集器 #product","inputTime":"2026-10-01T12:34:56.000Z","hashtags":["product"]}
```

可用环境变量覆盖路径：

```bash
PI_SPARK_FILE=/absolute/path/sparks.jsonl pi
PI_SPARK_LIGHTED_FILE=/absolute/path/lighted.jsonl pi
PI_SPARK_WECHAT_STORAGE_DIR=/absolute/path/wechat-auth pi
```

微信登录凭据默认由 SDK 保存在 `~/.pi/agent/spark/wechat/`。插件只在运行 `/spark_wechat` 后连接网络，并在 Pi 会话关闭或执行 `/spark_wechat_disconnect` 时停止。

## 验证

```bash
npm run check
```

## 安全提示

微信消息会成为当前 Pi 会话的用户输入，拥有与该 Pi 进程相同的工具和文件权限。只连接你自己的微信账号，并在不用时执行 `/spark_wechat_disconnect`。

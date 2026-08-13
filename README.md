# RN Log Viewer

RN 开发日志。工具只使用 Node.js 内置模块，不会修改 RN 业务代码，也不会上传日志。

## 启动方式

### npm CLI 一键启动

进入工具目录后，将它安装为全局 npm CLI：

```sh
cd rn-log-viewer
npm install --global .
```

然后在 RN 仓库目录执行：

```sh
rn-log-viewer --dev --cwd "$PWD"
```

如果不想在当前终端打印 RN 的 stdout/stderr，可以使用静默模式；网页仍会继续收集和展示：

```sh
rn-log-viewer --dev --quiet --cwd "$PWD"
```

`--silent` 是 `--quiet` 的同义参数。静默模式只隐藏 RN 日志，工具自身的启动、退出和错误信息仍会打印。

如果发布到 npm registry，也可以直接使用：

```sh
npx rn-log-viewer --dev --cwd "$PWD"
```

### Node 方式启动

不安装 npm CLI 时，仍可以直接执行：

```sh
# 推荐：由工具启动 pnpm dev，并把 stdout/stderr 推送到网页
node ~/tools/rn-log-viewer/server.mjs --dev --cwd /Users/yuheng.zhang/work/rn
```

也可以在工具目录执行 `npm start -- --dev --cwd /Users/yuheng.zhang/work/rn`。

然后打开 <http://127.0.0.1:4319>。

`--dev` 模式下，工具会持续把 RN 的 stdout/stderr 以 `[RN/stdout]` 或 `[RN/stderr]` 前缀打印到当前终端，并推送到网页 Dashboard 控制台；终端还会打印网页地址、工作目录和 RN 进程退出状态。使用 `--quiet` 或 `--silent` 时只关闭 RN 终端输出，不影响网页收集。

网页服务会监听 `index.html` 的变化。修改前端页面后，浏览器会自动刷新，无需手动刷新页面；已收集的日志仍保存在服务端内存中，并会在刷新后回放。

页面默认只接收连接后的实时日志；在 Dashboard“设置”中开启“加载历史消息”后，连接成功时会在右上角询问是否加载服务端已保存的历史日志。该设置会写入浏览器 `localStorage`。

## 网页功能

- `Dashboard`：实时控制台、最新日志/级别统计/来源统计表格，以及 RN 启动、停止控制；RN ANSI 颜色会在网页中还原。
- `Log`：紧凑日志列表、Log/Warn/Error 多选 filter、搜索高亮、底部操作栏和 JSON 导出。
- Log 支持“精简模式”：默认开启，可在 Dashboard 顶部“设置”中切换；开启后隐藏级别元数据和 `rn-stdout` 来源，保留右侧时间，日志项改为卡片背景加分割线样式，便于高密度查看，正文中的原始 `WARN/ERROR` 会保留。
- Log 支持“合并启动内容”：默认开启，可在 Dashboard 顶部“设置”中切换；开启后将首个 `LOG`、`WARN` 或 `ERROR` 之前的内容合并为一条普通 `log`。
- Log 列表默认使用动态虚拟滚动，只渲染可视区域及上下 1200px 缓冲区；可在 Dashboard 顶部“设置”中关闭，关闭后展示完整列表。filter 结果和虚拟高度会缓存，窗口尺寸变化和内容追加时自动失效并重新测量；日志更新前距离底部 50px 内时，刷新后强制保持在底部，手动滚动过程中不会自动吸附。
- 点击“暂停记录”后，新到日志和已有日志的续行更新都会暂存在缓冲中，当前列表保持不变；“加载历史消息”关闭时，点击“恢复记录”会丢弃暂停期间未展示的内容；开启时会弹出气泡询问是否补回，之后的新日志继续实时记录。
- 只识别行首的 `LOG`、`WARN`、`ERROR` 作为新日志边界。出现边界时新增一项并按标记设置级别；首次出现边界前的内容默认合并为一条 `log`，关闭设置后恢复逐行展示；首次出现边界后，不带这三个标记的行会实时追加到上一项，详情中保留原始换行。
- 日志正文最多展示 250 个字符并以省略号截断；点击日志行可从右侧 Drawer 查看完整内容、格式化 JSON、点击网页链接或复制本地文件路径。
- Drawer 中本地文件链接普通点击会复制路径，按住 macOS `⌘` 再点击才会通过 VS Code 打开文件；网页链接仍然直接打开。
- 本地文件链接通过 `code --reuse-window --goto` 打开，复用已有 VS Code 窗口；工具不再使用 macOS `open -a` fallback，避免每次点击在程序坞产生新的 VS Code 实例。

RN 控制卡使用当前服务的 `--cwd` 作为工作目录。例如：

```sh
node ~/tools/rn-log-viewer/server.mjs \
  --cwd /Users/yuheng.zhang/work/rn
```

然后在 Dashboard 点击“启动 RN”。如果需要服务启动时自动启动 RN，继续使用 `--dev` 参数。

如果 `pnpm dev` 已经由另一个终端启动，可以将它的输出写入文件：

```sh
pnpm dev 2>&1 | tee ~/rn.output
node ~/tools/rn-log-viewer/server.mjs --file ~/rn.output
```

网页提供搜索、级别筛选、暂停记录、清空和 JSON 导出。暂停记录后，新增日志和续行更新会进入缓冲；恢复记录时按小批次合并，之后的新日志直接进入列表。服务默认只监听 `127.0.0.1`。按 `Ctrl+C` 时，会先结束 `--dev` 启动的 RN 进程，等待其退出后再关闭文件监听和网页服务；RN 超过 5 秒未退出时会强制结束。

文件跳转依赖 VS Code `code` CLI 已加入 PATH；当前实现只调用 CLI 的 `--reuse-window --goto`，如果 CLI 不可用会在网页日志中报错，不会改用 `open -a` 启动新的 App 实例。

## 接收自定义日志

也可以向本地接收端发送 JSON：

```sh
curl -X POST http://127.0.0.1:4319/api/log \
  -H 'Content-Type: application/json' \
  -d '{"level":"log","source":"rn","message":"hello from RN"}'
```

POST 接口只适合本机调试。它不会自动拦截 React Native 的 `console.log`；如果要收集当前 `pnpm dev` 进程，使用上面的 `--dev` 或 `tee` 模式。

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

`--dev` 模式下，工具会持续把 RN 的 stdout/stderr 以 `[RN/stdout]` 或 `[RN/stderr]` 前缀打印到当前终端，并推送到网页 Dashboard 控制台；终端还会打印网页地址、工作目录和 RN 进程退出状态。

网页服务会监听 `index.html` 的变化。修改前端页面后，浏览器会自动刷新，无需手动刷新页面；已收集的日志仍保存在服务端内存中，并会在刷新后回放。

首次连接或浏览器重连时，页面会显示历史日志回放进度；历史日志回放期间新到的 RN 日志会先进入实时队列，回放结束后立即补发，不会丢失。

## 网页功能

- `Dashboard`：实时控制台、最新日志/级别统计/来源统计表格，以及 RN 启动、停止、重启控制；RN ANSI 颜色会在网页中还原。
- `Log`：紧凑日志列表、Log/Warn/Error 多选 filter、搜索高亮、底部操作栏和 JSON 导出。
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

网页提供搜索、级别筛选、暂停自动滚动、清空和 JSON 导出。服务默认只监听 `127.0.0.1`。按 `Ctrl+C` 时，会先结束 `--dev` 启动的 RN 进程，等待其退出后再关闭文件监听和网页服务；RN 超过 5 秒未退出时会强制结束。

文件跳转依赖 VS Code `code` CLI 已加入 PATH；当前实现只调用 CLI 的 `--reuse-window --goto`，如果 CLI 不可用会在网页日志中报错，不会改用 `open -a` 启动新的 App 实例。

## 接收自定义日志

也可以向本地接收端发送 JSON：

```sh
curl -X POST http://127.0.0.1:4319/api/log \
  -H 'Content-Type: application/json' \
  -d '{"level":"log","source":"rn","message":"hello from RN"}'
```

POST 接口只适合本机调试。它不会自动拦截 React Native 的 `console.log`；如果要收集当前 `pnpm dev` 进程，使用上面的 `--dev` 或 `tee` 模式。

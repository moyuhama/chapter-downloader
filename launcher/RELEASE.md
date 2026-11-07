Mac 通用预览版，支持 macOS 14 及以上的 Apple 芯片和 Intel 电脑。

下载 ZIP 后解压，打开「拾页助手.app」。工具会部署到 ~/Applications/拾页助手.app，数据存放在 ~/Library/Application Support/Shiye；不依赖源码项目、系统 Node 或手动 npm 安装。包含 Node、图片/PDF依赖及 Chromium。

首次运行注册 shiye://start；后续由网页唤起。网页提供自动检测和「断开并停止服务」。

此包只有 ad-hoc 签名，尚未经过 Apple Developer ID 签名和公证，macOS 可能阻止首次打开。遇到拦截请暂用仓库内源码方式；不要关闭系统安全保护。正式分发仍需要开发者证书与公证。

编译和运行时检查不等同于 Gatekeeper 首次下载验收。

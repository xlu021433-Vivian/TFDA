# 神器独立桌面助手 0.4

单个 `Shenqi-Desktop.exe`，左侧是中文点餐、定时和通知，右侧是微软 WebView2 内置的美团官方网页。用户无需 Python、BAT、Chrome 扩展或美团开发者权限。登录不会从外部浏览器迁移，需要本人在右侧重新登录并确认地址。Windows 10/11 x64 需安装系统 WebView2 Runtime；本项目下载并固定微软 SDK，不携带或修改浏览器本体。

使用：下载 EXE 放在固定位置，双击；在右侧登录和确认地址，在左侧输入需求或留空随机，勾选单次授权后开始。单次点餐不启用循环定时。定时页默认北京时间工作日11:00、含配送费预算25元，用户授权后才启用。关闭程序会停止定时，电脑需保持开机。iPhone Bark 在通知页输入自己的 key，本机加密保存；桌面快捷方式可在通知页创建。

复用既有菜单、规格、用券、猪肉筛选和订单号识别引擎。只操作官方可见页面，不调用私有外卖 API；免费券膨胀最多一张，必须实际用券且最终金额在预算内，最多一次提交，付款由本人完成。状态未知时保留防重记录。网页登录、验证码、定位许可和付款需要本人处理。

## 本机构建

从微软官方 NuGet 下载 `Microsoft.Web.WebView2` **1.0.4258.31**，SHA-256 为 `56f7f4b8bf9aee4b8efefbbdd4f67d5f74ebd1b100ed0806da71bf76af481aa9`。默认缓存位置为 `.tool-cache/webview2/microsoft.web.webview2.1.0.4258.31.nupkg`。

```powershell
python desktop/build.py
node --test desktop/runtime.test.cjs
```

构建脚本从 Git 中读取已有引擎，添加本次单次任务的独立授权，不修改循环定时配置。SDK、页面资产、许可证和文件哈希清单均嵌入 EXE。首次运行在 `%LOCALAPPDATA%/ShenqiDesktop` 保存运行组件、浏览器登录目录和 DPAPI 加密设置；不读外部浏览器账号，不发送到 GitHub。WebView2 页面消息限定来源，官方页不能直接读密钥或写本机文件。证书错误不会绕过，导航只允许美团及大众点评官方 HTTPS 站点。

## 隔离验证

```powershell
Start-Process dist/desktop-0.4.0/Shenqi-Desktop.exe -Wait -ArgumentList '--self-test','--data-dir','D:\new-empty-test-profile','--report','D:\test-report.json'
```

测试要求全新的空目录，拦截模拟页的全部请求，不连接真实美团、不会产生真实订单，不发真实通知；走通实际 WebView2、左侧按钮、本机桥接、选店、加购、核对券、单次提交和订单号识别，同时检查数据加密、持久化和循环任务未启用。测试图片明确对应模拟订单。`--demo --data-dir <新空目录>` 用于界面验收，同样不会访问真实账号。

已验证模拟流程和原有防护，不代表真实账号完整下单已验证。平台登录、页面改版、风控或支付流程可能需要本人处理，首次应在旁观察。淘宝闪购未适配。

微软参考：[WinForms WebView2](https://learn.microsoft.com/microsoft-edge/webview2/get-started/winforms)、[WebView2 安全建议](https://learn.microsoft.com/microsoft-edge/webview2/concepts/security)、[运行环境下载](https://developer.microsoft.com/microsoft-edge/webview2/)。

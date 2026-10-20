# Windows 安装程序 0.3.2

将已公开并校验的 0.3.0 便携包嵌入 Windows 安装程序。使用 Windows 自带 .NET Framework 编译器，无需下载构建依赖。

```powershell
powershell -NoProfile -File installer/build.ps1
```

输入是 `dist/windows-0.3.0/shenqi-waimai-windows-x64.zip`（也可从 GitHub v0.3.0 发布下载），SHA-256 固定在源码和构建脚本中。输出为 `dist/windows-0.3.2/Shenqi-Waimai-Setup.exe`，内含 Python、依赖、本地助手和扩展。安装完成前会用已嵌入的新版启动入口替换旧脚本，再更新文件校验清单。

0.3.2 修复旧版脚本的 LF 换行及内联中文导致 CMD 截断命令的问题。BAT 只包含 ASCII 命令，构建时统一写入无 BOM 的 CRLF；中文安装说明作为独立 UTF-8 文本显示。浏览器加载本机 `browser-extension` 目录，无需重新下载扩展文件。

安装窗口允许选择空目录、选择是否创建本人桌面快捷方式。安装器拒绝覆盖非空目录，先校验内嵌包，再解压和逐个验证文件清单，不需要管理员权限。成功后提供加载扩展、启动助手和阅读说明入口，不开启定时、不添加开机启动、不自动付款。关闭助手后可手动删除安装目录和快捷方式；删除目录会清除该目录里的本地配置。

验证入口（不创建快捷方式或启动点餐）：

```powershell
Start-Process dist/windows-0.3.2/Shenqi-Waimai-Setup.exe -Wait -ArgumentList '--verify-extract', 'D:\empty-test-folder'
python installer/test_launchers.py D:\empty-test-folder
```

测试会通过真正的 CMD 在代码页 936、65001 下分别执行两个入口的 `--check`，验证应用面板和扩展下载路由。不会打开浏览器、下单或启用定时。`--repair-launchers <已有安装目录>` 只替换与已公开旧版或新版完全匹配的启动入口、安装提示和清单，拒绝覆盖被用户修改过的脚本，不读取或写入账号配置。`--preview <output.png>` 将原生安装窗口绘制为图片。安装程序面向 Windows 10/11 x64，使用系统 .NET Framework 4.5+；内嵌点餐功能仍为测试版。

从已解压并通过校验的安装目录生成修复后的便携 ZIP：

```powershell
python installer/build_portable.py D:\empty-test-folder
```

# 神器 · 外卖助手

通过本人登录的美团官方网页随机选餐、使用优惠券，创建待支付订单后通知本人付款。无需申请美团开发者权限，不使用安卓或模拟器。

## 0.3 功能

- 本地中文输入：品类、份数、预算；支持随机选餐。
- 默认排除猪肉、猪肉制品及未注明来源的可疑肉类菜名。菜名不能保证完整配料，需了解商家说明。
- 必须读取实际红包或商家券抵扣；配送立减和“券可用”不能替代实际用券。可免费膨胀时最多尝试一张。
- 浏览器本地定时，默认北京时间工作日11:00，券后含配送费预算25元；需要用户启用授权。
- 可不限定商家，从当前配送地址下已加载餐饮商家中随机挑选，最多检查5家；不为凑券自动增购。
- 仅尝试一次订单提交；识别到官方详情的真实订单号、待支付状态及对应金额后，通过电脑通知及本人Bark配置提醒付款。
- 提交结果未知、无券、超预算、售罄、登录失效或复杂规格不完整时停止，不自动付款或重复下单。

## 使用

**Windows 用户直接下载 [免装 Python 的便携包](https://github.com/xlu021433-Vivian/TFDA/releases/latest/download/shenqi-waimai-windows-x64.zip)**，解压后阅读“先看这里.txt”。双击 `INSTALL-EXTENSION.bat` 完成浏览器加载扩展，再双击 `START.bat` 启动助手。无需命令行或改代码；扩展需要手动加载一次，美团登录和 Bark 通知需要在本机配置。

这是可安装的测试版，完整真实账号定时下单流程仍待验证。仅支持 Windows x64 搭配 Chrome / Edge，iPhone 用于接收通知及本人付款。首次启用定时请在电脑旁观察。

以下为从源码运行的方法：

1. 安装 Python 3.12+，执行 `pip install -r waimai-helper/requirements.txt`。
2. 执行 `python waimai-helper/build_browser_extension.py` 生成浏览器扩展压缩包。
3. Chrome/Edge扩展管理页加载 `waimai-helper/browser-extension` 文件夹。Codex内置浏览器不能加载此扩展。
4. 运行 `python waimai-helper/app.py`，或使用 Windows 启动脚本。在本地面板配置Bark；真实配置只存在本机。
5. 在美团官方H5亲自登录、确认配送地址。扩展可手动点餐；打开扩展“定时点餐与付款通知”配置授权后启用定时。
6. 本地面板生成扩展通知连接码，保存到扩展通知设置，发送测试通知。不导出Bark密钥。

执行时电脑需开机、浏览器保持运行并登录，本机助手运行时才能转发Bark。关闭或休眠后错过窗口超过10分钟会跳过当天，不在下午补下单。GitHub仓库保存代码，不会在云端代替已登录的本机浏览器操作外卖账号。

详见 [扩展说明](waimai-helper/browser-extension/README.md)。

## 验证与限制

真实美团网页已验证登录、菜单、规格、加购、订单预览、免费券膨胀及红包抵扣。新定时流程、跨店挑选、默认规格确认、订单号识别与通知采用独立DOM、模拟扩展运行及本地页面测试；尚未在真实账号完成自动定时提交到待支付的端到端验证，不承诺平台所有页面均适配。

仅支持当前美团H5页面结构；淘宝闪购未验证。复杂规格和平台风控需要本人处理，不绕过登录或验证码，不使用私有接口。REA用于公开前端代码的静态分析，源码上游为 [morluto/rea](https://github.com/morluto/rea)。原始分析材料和第三方源码未打包进本仓库。

## 开发验证

```sh
npm ci
npm run test:browser
python -m pip install -r waimai-helper/requirements.txt
cd waimai-helper
python -m unittest discover -s tests -q
```

示例配置为 `waimai-helper/config.example.yaml`。账号、Cookie、Bark密钥、通知连接码、地址、定位信息、订单记录、运行时和日志均不应提交；仓库忽略这些本地数据。

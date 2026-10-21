using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

internal sealed class DesktopHost : Form
{
    readonly WebView2 panel=new WebView2(),official=new WebView2();
    readonly LocalStore store;
    readonly Label loading=new Label();
    readonly NotifyIcon tray=new NotifyIcon();
    readonly Timer timer=new Timer();
    readonly TaskCompletionSource<bool> panelReady=new TaskCompletionSource<bool>();
    bool initialized,injecting;
    bool? lastBark;
    string lastHttpError;
    string pageStatus="正在打开美团官方网页…";
    readonly List<string> errors=new List<string>();
    internal int ExitCode=0;
    static readonly string Home="https://h5.waimai.meituan.com/waimai/mindex/home";
    internal DesktopHost()
    {
        store=new LocalStore(Bootstrap.Root);
        Text=Bootstrap.Test?"神器 · 本地模拟验证（不会创建真实订单）":"神器 · 今天这一餐";
        var area=Screen.PrimaryScreen.WorkingArea;
        Width=Math.Min(1320,area.Width-32);Height=Math.Min(900,area.Height-32);
        MinimumSize=new Size(Math.Min(1040,Width),Math.Min(700,Height));StartPosition=FormStartPosition.CenterScreen;
        BackColor=Color.FromArgb(247,245,240);
        var split=new SplitContainer { Size=new Size(1280,850),Dock=DockStyle.Fill,FixedPanel=FixedPanel.Panel1,SplitterWidth=1,SplitterDistance=396,Panel1MinSize=360,Panel2MinSize=560 };
        Controls.Add(split);panel.Dock=DockStyle.Fill;official.Dock=DockStyle.Fill;split.Panel1.Controls.Add(panel);split.Panel2.Controls.Add(official);
        loading.Dock=DockStyle.Fill;loading.Text="正在准备神器…\n无需安装浏览器扩展。";loading.TextAlign=ContentAlignment.MiddleCenter;loading.Font=new Font("Microsoft YaHei UI",14);Controls.Add(loading);loading.BringToFront();
        tray.Icon=SystemIcons.Information;tray.Text="神器 · 关闭窗口会停止定时";tray.Visible=!Bootstrap.Test;
        tray.DoubleClick+=delegate { Show();WindowState=FormWindowState.Normal;Activate(); };
        timer.Interval=30000;timer.Tick+=async delegate { if(initialized)try{await panel.CoreWebView2.ExecuteScriptAsync("Desktop.tick().catch(()=>{});");}catch{} };
        Shown+=async delegate { await Initialize(); };
        FormClosed+=delegate { timer.Stop();tray.Visible=false;tray.Dispose(); };
    }
    internal static bool IsPanel(string value)
    { Uri uri;return Uri.TryCreate(value,UriKind.Absolute,out uri)&&uri.Scheme=="https"&&uri.Host=="shenqi.local"&&uri.IsDefaultPort&&uri.AbsolutePath=="/options.html"&&uri.Query==""; }
    internal static bool IsOfficial(string value)
    { Uri uri;return Uri.TryCreate(value,UriKind.Absolute,out uri)&&uri.Scheme=="https"&&uri.Host=="h5.waimai.meituan.com"&&uri.IsDefaultPort; }
    internal static bool AllowedNavigation(string value)
    { if(value=="about:blank")return true;Uri uri;if(!Uri.TryCreate(value,UriKind.Absolute,out uri)||uri.Scheme!="https"||!uri.IsDefaultPort)return false;return uri.Host=="meituan.com"||uri.Host.EndsWith(".meituan.com",StringComparison.OrdinalIgnoreCase)||uri.Host=="dianping.com"||uri.Host.EndsWith(".dianping.com",StringComparison.OrdinalIgnoreCase); }
    string Asset(string name) { return File.ReadAllText(Path.Combine(Bootstrap.Assets,name),Encoding.UTF8); }
    void PostPanel(object value) { if(panel.CoreWebView2!=null&&IsPanel(panel.Source==null?"":panel.Source.AbsoluteUri))panel.CoreWebView2.PostWebMessageAsJson(Bootstrap.Json.Serialize(value)); }
    void PostPage(object value) { if(official.CoreWebView2!=null&&IsOfficial(official.Source==null?"":official.Source.AbsoluteUri))official.CoreWebView2.PostWebMessageAsJson(Bootstrap.Json.Serialize(value)); }
    async Task Initialize()
    {
        try
        {
            var environment=await CoreWebView2Environment.CreateAsync(null,Path.Combine(Bootstrap.Root,"BrowserProfile"));
            await panel.EnsureCoreWebView2Async(environment);await official.EnsureCoreWebView2Async(environment);
            await official.CoreWebView2.Profile.SetPermissionStateAsync(CoreWebView2PermissionKind.Geolocation,"https://h5.waimai.meituan.com",CoreWebView2PermissionState.Default);
            panel.CoreWebView2.SetVirtualHostNameToFolderMapping("shenqi.local",Bootstrap.Assets,CoreWebView2HostResourceAccessKind.DenyCors);
            panel.CoreWebView2.Settings.AreDefaultContextMenusEnabled=false;
            panel.CoreWebView2.NavigationStarting+=delegate(object sender,CoreWebView2NavigationStartingEventArgs args){if(!IsPanel(args.Uri))args.Cancel=true;};
            panel.CoreWebView2.NewWindowRequested+=delegate(object sender,CoreWebView2NewWindowRequestedEventArgs args){args.Handled=true;};
            panel.CoreWebView2.WebMessageReceived+=PanelMessage;
            await panel.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync("window.addEventListener('error',e=>chrome.webview.postMessage({channel:'frontend-error',message:e.message}));window.addEventListener('unhandledrejection',e=>chrome.webview.postMessage({channel:'frontend-error',message:String(e.reason?.message||e.reason)}));");
            official.CoreWebView2.Settings.IsStatusBarEnabled=false;
            official.CoreWebView2.WebMessageReceived+=PageMessage;
            official.CoreWebView2.NavigationStarting+=delegate(object sender,CoreWebView2NavigationStartingEventArgs args){
                if(!AllowedNavigation(args.Uri)){args.Cancel=true;SendPageState(false,"这个链接不属于美团官方网页，已停止打开。付款请在手机美团订单中完成。",false);}
                else {lastHttpError=null;SendPageState(false,null,false);}
            };
            official.CoreWebView2.NewWindowRequested+=delegate(object sender,CoreWebView2NewWindowRequestedEventArgs args){args.Handled=true;if(AllowedNavigation(args.Uri))official.Source=new Uri(args.Uri);else SendPageState(false,"请在手机美团中完成外部支付或操作。",false);};
            official.CoreWebView2.PermissionRequested+=delegate(object sender,CoreWebView2PermissionRequestedEventArgs args){
                args.SavesInProfile=false;
                args.State=CoreWebView2PermissionState.Deny;
                if(!Bootstrap.Test&&args.PermissionKind==CoreWebView2PermissionKind.Geolocation&&AllowedNavigation(args.Uri)&&MessageBox.Show(this,"美团官方页面请求使用本机定位以展示附近商家。是否允许本次定位？也可拒绝并手动选择地址。","美团定位请求",MessageBoxButtons.YesNo,MessageBoxIcon.Question)==DialogResult.Yes)args.State=CoreWebView2PermissionState.Allow;
            };
            official.CoreWebView2.ServerCertificateErrorDetected+=delegate(object sender,CoreWebView2ServerCertificateErrorDetectedEventArgs args){args.Action=CoreWebView2ServerCertificateErrorAction.Cancel;SendPageState(false,"官方网页证书验证失败，已停止连接。",false);};
            official.CoreWebView2.NavigationCompleted+=async delegate(object sender,CoreWebView2NavigationCompletedEventArgs args){
                if(!args.IsSuccess){SendPageState(false,"网页加载失败："+args.WebErrorStatus,false);return;}
                if(lastHttpError!=null){SendPageState(false,lastHttpError,false);return;}
                bool supported=IsOfficial(official.Source.AbsoluteUri);SendPageState(supported,null,true);if(supported)await Inject();
            };
            official.CoreWebView2.WebResourceResponseReceived+=delegate(object sender,CoreWebView2WebResourceResponseReceivedEventArgs args){
                if(official.Source!=null&&args.Request.Uri==official.Source.AbsoluteUri&&args.Response.StatusCode>=400)
                {lastHttpError="官方网页返回 HTTP "+args.Response.StatusCode+"，请稍后重试。尚未确认新订单。";SendPageState(false,lastHttpError,false);}
            };
            string script="if(window===window.top&&location.origin==='https://h5.waimai.meituan.com'){\n";
            foreach(string name in new[]{"page-bridge.js","guard-data.js","policy.js","schedule.js","adapter.js","styles.js"})script+=Asset(name)+"\n";
            await official.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(script+"\n}");
            if(Bootstrap.Test)
            {
                official.CoreWebView2.AddWebResourceRequestedFilter("*",CoreWebView2WebResourceContext.All);
                official.CoreWebView2.WebResourceRequested+=delegate(object sender,CoreWebView2WebResourceRequestedEventArgs args){
                    string html=IsOfficial(args.Request.Uri)?Fixture(new Uri(args.Request.Uri).AbsolutePath):"";
                    args.Response=environment.CreateWebResourceResponse(new MemoryStream(Encoding.UTF8.GetBytes(html)),200,"OK","Content-Type: text/html; charset=utf-8\r\nCache-Control: no-store");
                };
            }
            panel.Source=new Uri("https://shenqi.local/options.html");
            await Task.WhenAny(panelReady.Task,Task.Delay(20000));if(!panelReady.Task.IsCompleted){string detail=await panel.CoreWebView2.ExecuteScriptAsync("JSON.stringify({title:document.title,message:document.getElementById('message')?.textContent,state:document.readyState})");throw new IOException("控制面板启动超时。"+detail+string.Join("；",errors.ToArray()));}
            loading.Visible=false;initialized=true;timer.Start();official.Source=new Uri(Home);
            if(Bootstrap.Test&&!Bootstrap.Demo)await SelfTest();
        }
        catch(Exception error)
        {
            ExitCode=1;pageStatus="无法打开内置网页："+error.Message;
            loading.Text=pageStatus+"\n请确认 Windows 已安装微软 WebView2 Runtime。";loading.Visible=true;loading.BringToFront();
            if(Bootstrap.Test){WriteReport(new {ok=false,error=pageStatus,frontendErrors=errors});Close();}
        }
    }
    void SendPageState(bool ready,string error,bool complete)
    { PostPanel(new {channel="page-state",state=new {ready,error,complete,url=official.Source==null?"":official.Source.AbsoluteUri}}); }
    async Task Inject()
    {
        if(injecting||official.Source==null||!IsOfficial(official.Source.AbsoluteUri))return;injecting=true;
        try{await official.CoreWebView2.ExecuteScriptAsync(Asset("content.js")+"\n"+Asset("watch.js"));}
        catch(Exception){SendPageState(false,"助手未能连接当前网页，请重试或重新打开美团首页。",false);}
        finally{injecting=false;}
    }
    async void PanelMessage(object sender,CoreWebView2WebMessageReceivedEventArgs args)
    {
        if(!IsPanel(args.Source)||!IsPanel(panel.Source.AbsoluteUri))return;
        string id="";
        try
        {
            if(args.WebMessageAsJson.Length>262144)throw new IOException("消息过长。");
            var message=Bootstrap.Json.Deserialize<Dictionary<string,object>>(args.WebMessageAsJson);
            if(Convert.ToString(message["channel"])=="frontend-error"){errors.Add(Convert.ToString(message["message"]).Substring(0,Math.Min(500,Convert.ToString(message["message"]).Length)));return;}
            if(Convert.ToString(message["channel"])!="native-request")return;
            id=Convert.ToString(message["id"]);if(id.Length>50)return;
            var body=(Dictionary<string,object>)message["args"];
            object result=await HandleRequest(Convert.ToString(message["action"]),body);
            PostPanel(new {channel="native-result",id,result});
        }
        catch(Exception error){PostPanel(new {channel="native-result",id,error=error.Message});}
    }
    async Task<object> HandleRequest(string action,Dictionary<string,object> args)
    {
        switch(action)
        {
            case "storage_get":
                var output=new Dictionary<string,object>();foreach(var requestedKey in (System.Collections.IEnumerable)args["keys"]){string name=Convert.ToString(requestedKey);if(store.Engine.ContainsKey(name))output[name]=store.Engine[name];}return output;
            case "storage_set":store.Change((Dictionary<string,object>)args["change"]);return new {ok=true};
            case "storage_remove":store.Remove((System.Collections.IEnumerable)args["keys"]);return new {ok=true};
            case "panel_ready":panelReady.TrySetResult(true);return new {ok=true};
            case "status":return new {barkConfigured=!string.IsNullOrEmpty(store.BarkKey),lastBark,version="0.4.3"};
            case "navigate":
                string url=Convert.ToString(args["url"]);if(!AllowedNavigation(url))throw new IOException("只允许打开美团官方 HTTPS 网页。");official.Source=new Uri(url);return new {id=1};
            case "reload":if(official.CoreWebView2!=null)official.CoreWebView2.Reload();return new {ok=true};
            case "inject":await Inject();return new {ok=true};
            case "page_result":PostPage(new {channel="page-result",id=args["id"],result=args["result"]});return new {ok=true};
            case "page_command":PostPage(new {channel="page-command",body=args["body"]});return new {ok=true};
            case "save_bark":
                string key=Convert.ToString(args["key"]);if(!System.Text.RegularExpressions.Regex.IsMatch(key,"^[A-Za-z0-9_-]{5,256}$"))throw new IOException("Bark key 格式无效。");store.SetBark(key);return new {ok=true};
            case "shortcut":
                dynamic shell=Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell"));
                try
                {
                    dynamic link=shell.CreateShortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),"神器桌面助手.lnk"));
                    try{link.TargetPath=System.Reflection.Assembly.GetExecutingAssembly().Location;link.WorkingDirectory=Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);link.Description="独立桌面点餐助手，无需浏览器扩展";link.Save();}
                    finally{System.Runtime.InteropServices.Marshal.FinalReleaseComObject(link);}
                }
                finally{System.Runtime.InteropServices.Marshal.FinalReleaseComObject(shell);}
                return new {ok=true};
            case "notify":return await Notify(args);
            case "diagnostics":
                return new {message="程序：0.4.3\n内置网页："+(official.CoreWebView2==null?"未启动":"已启动")+"\n当前网页："+(official.Source==null?"未打开":official.Source.GetLeftPart(UriPartial.Path))+"\n"+pageStatus+"\n桌面控制台错误："+errors.Count};
            default:throw new IOException("不支持此操作。");
        }
    }
    void PageMessage(object sender,CoreWebView2WebMessageReceivedEventArgs args)
    {
        if(lastHttpError!=null||!IsOfficial(args.Source)||official.Source==null||!IsOfficial(official.Source.AbsoluteUri)||new Uri(args.Source).GetLeftPart(UriPartial.Query)!=official.Source.GetLeftPart(UriPartial.Query))return;
        try
        {
            if(args.WebMessageAsJson.Length>65536)return;
            var message=Bootstrap.Json.Deserialize<Dictionary<string,object>>(args.WebMessageAsJson);
            string channel=Convert.ToString(message["channel"]);
            if(channel=="page-request")
            {
                var body=(Dictionary<string,object>)message["body"];string type=Convert.ToString(body["type"]);
                if(!new HashSet<string>{"read","save","reserve","clear","schedule_check","schedule_stage","schedule_shop","schedule_failed","order_result"}.Contains(type))return;
                PostPanel(new {channel="page-request",id=message["id"],body,url=args.Source});
            }
            if(channel=="page-status")
            {
                pageStatus=Convert.ToString(message["status"]);
                PostPanel(new {channel="page-state",state=new {ready=true,status=pageStatus,loginNeeded=message["loginNeeded"],url=args.Source}});
            }
        }
        catch{ }
    }
    async Task<object> Notify(Dictionary<string,object> args)
    {
        var options=(Dictionary<string,object>)args["options"];string title=Convert.ToString(options["title"]),body=Convert.ToString(options["message"]);
        if(title.Length>100||body.Length>1000)throw new IOException("通知内容过长。");
        bool desktop=false,bark=false,configured=!string.IsNullOrEmpty(store.BarkKey);
        if(!Bootstrap.Test)
        {
            try{tray.ShowBalloonTip(10000,title,body,ToolTipIcon.Info);desktop=true;}catch{}
            if(configured)
            {
                try
                {
                    ServicePointManager.SecurityProtocol=SecurityProtocolType.Tls12;
                    using(var client=new HttpClient {Timeout=TimeSpan.FromSeconds(10)})
                    {
                        string uri="https://api.day.app/"+Uri.EscapeDataString(store.BarkKey)+"/"+Uri.EscapeDataString(title)+"/"+Uri.EscapeDataString(body)+"?group="+Uri.EscapeDataString("神器外卖");
                        var response=await client.GetAsync(uri);var data=Bootstrap.Json.Deserialize<Dictionary<string,object>>(await response.Content.ReadAsStringAsync());bark=response.IsSuccessStatusCode&&Convert.ToInt32(data["code"])==200;
                    }
                }
                catch {bark=false;}
                lastBark=bark;
            }
        }
        return new {desktop,bark,barkConfigured=configured};
    }
    void WriteReport(object value){if(Bootstrap.Report!=null)File.WriteAllText(Bootstrap.Report,Bootstrap.Json.Serialize(value),new UTF8Encoding(false));}
    async Task SelfTest()
    {
        if(IsPanel("https://shenqi.local.evil/options.html")||IsPanel("https://shenqi.local:8443/options.html")||IsOfficial("https://h5.waimai.meituan.com.evil/")||AllowedNavigation("file:///C:/test"))throw new IOException("来源校验失败。");
        await Task.Delay(2500);
        string command="(async()=>{const request=document.getElementById('request');request.value='想吃河粉 25元预算 一份';request.dispatchEvent(new Event('input'));document.getElementById('mealConsent').checked=true;await Desktop.inspect();document.getElementById('startMeal').click();})().catch(e=>document.getElementById('message').textContent=e.message);";
        await panel.CoreWebView2.ExecuteScriptAsync(command);
        bool done=false;
        for(int i=0;i<100;i++)
        {
            await Task.Delay(500);
            if(store.Engine.ContainsKey("lastOrder")){done=true;break;}
            if(store.Engine.ContainsKey("activeRun")) {var current=(Dictionary<string,object>)store.Engine["activeRun"];if(Convert.ToString(current["stage"])=="failed")break;}
        }
        if(!done)throw new IOException("模拟点餐未完成。"+Bootstrap.Json.Serialize(store.Engine)+"；前端："+string.Join("；",errors.ToArray())+"；页面："+pageStatus);
        var last=(Dictionary<string,object>)store.Engine["lastOrder"];
        if(Convert.ToString(last["orderId"])!="TEST202610200001"||Convert.ToInt32(last["total"])!=1500)throw new IOException("模拟订单核对失败。");
        int submissions=Convert.ToInt32(await official.CoreWebView2.ExecuteScriptAsync("Number(localStorage.fixtureSubmits||0)"));if(submissions!=1)throw new IOException("提交次数不符合单次限制。");
        if(store.Engine.ContainsKey("schedule")&&Convert.ToBoolean(((Dictionary<string,object>)store.Engine["schedule"])["enabled"]))throw new IOException("单次点餐意外启用了循环定时。");
        var reloaded=new LocalStore(Bootstrap.Root);if(!reloaded.Engine.ContainsKey("lastOrder"))throw new IOException("点餐记录未持久保存。");
        string file=Path.Combine(Bootstrap.Root,"settings.dpapi");if(Encoding.UTF8.GetString(File.ReadAllBytes(file)).Contains("TEST202610200001"))throw new IOException("本机状态未加密。");
        await panel.CoreWebView2.ExecuteScriptAsync("Desktop.inspect()");await Task.Delay(400);
        await Inject();
        string singleSurface=await official.CoreWebView2.ExecuteScriptAsync("(()=>{const host=document.getElementById('shenqi-waimai-assistant');return !!host&&getComputedStyle(host).display==='none'&&host.getClientRects().length===0&&host.getAttribute('aria-hidden')==='true';})()");
        if(singleSurface!="true")throw new IOException("右侧仍有重复的助手界面。");
        using(var left=new FileStream(Path.Combine(Bootstrap.Root,"panel.png"),FileMode.Create))await panel.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png,left);
        using(var right=new FileStream(Path.Combine(Bootstrap.Root,"official-fixture.png"),FileMode.Create))await official.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png,right);
        WriteReport(new {ok=true,sourceGuards=true,embeddedBrowser=true,fullFixtureFlow=true,singleAssistantSurface=true,reportedNoodleRequest=true,ordinaryAddControl=true,unpaidOrder="TEST202610200001",total=1500,submissions,recurrenceNotEnabled=true,encryptedState=true,frontendErrors=errors,windowWidth=Width,windowHeight=Height});
        ExitCode=0;Close();
    }
    string Fixture(string path)
    {
        string head="<!doctype html><meta charset='utf-8'><style>body{font:18px sans-serif;padding:30px;color:#352a22}button,.clickArea_mock{min-width:48px;min-height:40px;display:inline-block;margin:6px}.poilist-item{padding:20px;border:1px solid #ccc}.banner{padding:16px;background:#f4dfb9}dd{padding:20px}</style><div class='banner'>本地模拟 · 不连接真实美团 · 不会产生真实订单</div>";
        if(path.EndsWith("/home"))return head+"<h1>测试附近商家</h1><div class='poilist-item' onclick=\"location.href='/waimai/mindex/menu?poi_id_str=fixture'\"><b class='poilist-item-info1name'>测试素炒河粉餐厅</b><p>起送￥10 配送￥2</p></div>";
        if(path.EndsWith("/menu"))return head+"<h1>测试素炒河粉餐厅</h1><dl><dd data-tag='spu'><div class='name_mock'>测试素炒河粉</div><div data-tag='price'>￥16.00</div><div class='sqt-menu-add-buttons'><button aria-label='加入购物车'><span class='clickArea_mock' onclick=\"document.getElementById('qty').textContent='1';document.getElementById('cart').textContent='1';document.getElementById('cart').setAttribute('aria-label','购物车，已选商品')\"></span></button><span id='qty'></span></div></dd></dl><button id='cart' aria-label='购物车，没有商品'></button><button onclick=\"location.href='/waimai/mindex/preview'\">去结算</button>";
        if(path.EndsWith("/preview"))return head+"<h1>测试订单预览</h1><div class='spuInfoList_mock'><span class='spuInfoSpan_mock'>测试素炒河粉</span><span class='spuAmount_mock'>x1</span></div><div class='promotion_mock' onclick=\"document.getElementById('coupons').hidden=false\"><span>美团红包</span><span class='promotionSelect_mock'>-￥3.00</span></div><div class='promotion_mock'><span>商家代金券</span><span class='promotionSelect_mock'>无可用</span></div><div id='coupons' hidden><div>可使用红包</div><div class='cell-wrapper'><span class='price-amount-container'>￥3.00</span><div class='coupon-wrapper'>模拟红包</div></div><button onclick=\"document.getElementById('coupons').hidden=true\">确认</button></div><div><span class='actual_mock'>￥15.00</span><button id='sqt-openh5-preview-submit-btn' onclick=\"localStorage.fixtureSubmits=String(Number(localStorage.fixtureSubmits||0)+1);location.href='/waimai/mindex/order-detail?orderId=TEST202610200001'\">提交订单</button></div>";
        return head+"<h1>待支付</h1><p>订单号：TEST202610200001</p><p>待支付金额：￥15.00</p><button>由本人付款</button>";
    }
}

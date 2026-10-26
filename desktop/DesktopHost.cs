using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
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
    readonly Timer remoteTimer=new Timer();
    readonly RemoteLink remote;
    readonly CheckBox reading=new CheckBox();
    readonly Label renderStatus=new Label();
    bool wasMinimized,repainting;
    int renderRecoveries;
    readonly TaskCompletionSource<bool> panelReady=new TaskCompletionSource<bool>();
    bool initialized,injecting;
    bool? lastBark;
    string lastHttpError;
    ulong currentNavigation;
    bool documentReady;
    readonly HashSet<ulong> blockedNavigations=new HashSet<ulong>();
    string pageStatus="正在打开美团官方网页…";
    readonly List<string> errors=new List<string>();
    internal int ExitCode=0;
    static readonly string Home="https://h5.waimai.meituan.com/waimai/mindex/home";
    internal DesktopHost()
    {
        store=new LocalStore(Bootstrap.Root);
        remote=new RemoteLink(Bootstrap.Root,store);
        if(Bootstrap.EnablePhone&&!Bootstrap.Test)remote.Enable(true);
        StopInterruptedTask(store);
        Text=Bootstrap.Test?"神器 · 本地模拟验证（不会创建真实订单）":"神器 · 今天这一餐";
        var area=Screen.PrimaryScreen.WorkingArea;
        Width=Math.Min(1320,area.Width-32);Height=Math.Min(900,area.Height-32);
        MinimumSize=new Size(Math.Min(1040,Width),Math.Min(700,Height));StartPosition=FormStartPosition.CenterScreen;
        BackColor=Color.FromArgb(251,243,246);
        var split=new SplitContainer { Size=new Size(1280,850),Dock=DockStyle.Fill,FixedPanel=FixedPanel.Panel1,SplitterWidth=1,SplitterDistance=396,Panel1MinSize=360,Panel2MinSize=560 };
        Controls.Add(split);panel.Dock=DockStyle.Fill;official.Dock=DockStyle.Fill;split.Panel1.Controls.Add(panel);split.Panel2.Controls.Add(official);
        var officialBar=new Panel {Dock=DockStyle.Top,Height=40,BackColor=Color.FromArgb(251,243,246),Padding=new Padding(16,0,12,0)};
        officialBar.Controls.Add(new Label {Text="美团 · 官方页面",Dock=DockStyle.Fill,TextAlign=ContentAlignment.MiddleLeft,ForeColor=Color.FromArgb(123,101,115),Font=new Font("Microsoft YaHei UI",9)});
        object savedReading;reading.Checked=!store.Engine.TryGetValue("officialReading",out savedReading)||Convert.ToBoolean(savedReading);
        reading.Text="舒适排版";reading.Dock=DockStyle.Right;reading.Width=110;reading.Font=new Font("Microsoft YaHei UI",9);reading.ForeColor=Color.FromArgb(163,63,105);
        officialBar.Controls.Add(reading);split.Panel2.Controls.Add(officialBar);officialBar.BringToFront();
        reading.CheckedChanged+=async delegate {store.Change(new Dictionary<string,object>{{"officialReading",reading.Checked}});if(official.CoreWebView2!=null&&IsOfficial(official.Source.AbsoluteUri))await official.CoreWebView2.ExecuteScriptAsync("globalThis.ShenqiReading?.setEnabled("+(reading.Checked?"true":"false")+")");};
        var recoveryBar=new Panel {Dock=DockStyle.Top,Height=44,BackColor=Color.FromArgb(243,232,238),Padding=new Padding(14,4,14,4)};
        renderStatus.Text="兼容绘制 · 正在准备网页";renderStatus.Dock=DockStyle.Fill;renderStatus.TextAlign=ContentAlignment.MiddleLeft;renderStatus.ForeColor=Color.FromArgb(123,101,115);renderStatus.Font=new Font("Microsoft YaHei UI",9);
        var restoreDisplay=new Button {Text="恢复显示",Dock=DockStyle.Right,Width=112,Font=new Font("Microsoft YaHei UI",9),FlatStyle=FlatStyle.Flat,BackColor=Color.White,ForeColor=Color.FromArgb(163,63,105)};
        restoreDisplay.FlatAppearance.BorderColor=Color.FromArgb(233,207,221);restoreDisplay.Click+=delegate {RestoreWebViews();};
        recoveryBar.Controls.Add(renderStatus);recoveryBar.Controls.Add(restoreDisplay);
        Controls.Remove(split);var contentHost=new Panel {Dock=DockStyle.Fill,Margin=new Padding(0)};contentHost.Controls.Add(split);
        var frame=new TableLayoutPanel {Dock=DockStyle.Fill,RowCount=2,ColumnCount=1,Margin=new Padding(0),Padding=new Padding(0)};
        frame.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100));frame.RowStyles.Add(new RowStyle(SizeType.Absolute,44));frame.RowStyles.Add(new RowStyle(SizeType.Percent,100));
        recoveryBar.Margin=new Padding(0);recoveryBar.Dock=DockStyle.Fill;frame.Controls.Add(recoveryBar,0,0);frame.Controls.Add(contentHost,0,1);Controls.Add(frame);
        Resize+=delegate {
            if(!initialized)return;
            if(WindowState==FormWindowState.Minimized){wasMinimized=true;panel.Visible=false;official.Visible=false;}
            else if(wasMinimized){wasMinimized=false;RestoreWebViews();}
        };
        loading.Dock=DockStyle.Fill;loading.Text="正在准备神器…\n无需安装浏览器扩展。";loading.TextAlign=ContentAlignment.MiddleCenter;loading.Font=new Font("Microsoft YaHei UI",14);contentHost.Controls.Add(loading);loading.BringToFront();
        tray.Icon=SystemIcons.Information;tray.Text="神器 · 关闭窗口会停止定时";tray.Visible=!Bootstrap.Test;
        tray.DoubleClick+=delegate { Show();WindowState=FormWindowState.Normal;Activate(); };
        timer.Interval=30000;timer.Tick+=async delegate { if(initialized)try{await panel.CoreWebView2.ExecuteScriptAsync("Desktop.tick().catch(()=>{});");}catch{} };
        remoteTimer.Interval=5000;remoteTimer.Tick+=async delegate {if(initialized)await remote.Poll(RemoteInspect,RemoteExecute);};
        Shown+=async delegate { await Initialize(); };
        FormClosed+=delegate { timer.Stop();remoteTimer.Stop();tray.Visible=false;tray.Dispose(); };
    }
    async Task<Dictionary<string,object>> RemoteInspect()
    {
        await ObserveCashier();
        if(Bootstrap.ShopReport!=null&&documentReady&&official.Source.AbsolutePath=="/waimai/mindex/home")
        {
            try
            {
                string cards=await official.CoreWebView2.ExecuteScriptAsync("globalThis.ShenqiAdapter?.create(document).shopDiagnostics(2500,'')||[]");
                if(cards!="[]"){File.WriteAllText(Bootstrap.ShopReport,cards,new UTF8Encoding(false));Bootstrap.ShopReport=null;}
            }catch{}
        }
        string raw=await panel.CoreWebView2.ExecuteScriptAsync("Desktop.remoteStatus()");
        return Bootstrap.Json.Deserialize<Dictionary<string,object>>(raw);
    }
    async Task ObserveCashier()
    {
        if(official.CoreWebView2==null||official.Source==null||!IsCashier(official.Source.AbsoluteUri)||lastHttpError!=null)return;
        try
        {
            string raw=await official.CoreWebView2.ExecuteScriptAsync(Asset("cashier-reader.js"));
            var result=Bootstrap.Json.Deserialize<Dictionary<string,object>>(raw);
            if(result!=null)PostPanel(new {channel="cashier-result",result});
        }catch{}
    }
    async Task RemoteExecute(Dictionary<string,object> command)
    {
        string raw=await panel.CoreWebView2.ExecuteScriptAsync("Desktop.remoteCommand("+Bootstrap.Json.Serialize(command)+").then(value=>{globalThis.remoteResult=value;},error=>{globalThis.remoteResult={ok:false,error:error.message};});null");
        // ExecuteScriptAsync does not await a JS promise. Wait for this command's
        // explicit acknowledgement, never fire-and-forget or automatically resend.
        string id=Convert.ToString(command["id"]);
        for(int i=0;i<80;i++)
        {
            await Task.Delay(250);
            raw=await panel.CoreWebView2.ExecuteScriptAsync("globalThis.remoteResult||null");
            var value=Bootstrap.Json.Deserialize<Dictionary<string,object>>(raw);
            if(value!=null&&Convert.ToString(value["id"])==id)
            {if(!Convert.ToBoolean(value["ok"]))throw new IOException(Convert.ToString(value["error"]));return;}
        }
        throw new IOException("远程任务接收结果超时，需本人核对。");
    }
    void RestoreWebViews()
    {
        if(!initialized||repainting||IsDisposed||WindowState==FormWindowState.Minimized)return;
        repainting=true;renderStatus.Text="兼容绘制 · 正在恢复显示（不会刷新页面或加购）";
        panel.Visible=false;official.Visible=false;
        BeginInvoke((Action)delegate {
            try
            {
                if(IsDisposed||WindowState==FormWindowState.Minimized)return;
                PerformLayout();panel.Parent.PerformLayout();official.Parent.PerformLayout();
                panel.Visible=true;official.Visible=true;
                panel.Invalidate(true);official.Invalidate(true);panel.Update();official.Update();
                renderRecoveries++;renderStatus.Text="兼容绘制 · 页面显示异常时可点恢复显示";
            }
            finally{repainting=false;}
        });
    }
    static void StopInterruptedTask(LocalStore local)
    {
        object value;
        if(!local.Engine.TryGetValue("activeRun",out value))return;
        var run=value as Dictionary<string,object>;if(run==null||!run.ContainsKey("stage"))return;
        string stage=Convert.ToString(run["stage"]);
        if(stage=="done"||stage=="failed"||stage=="stopped")return;
        var stopped=new Dictionary<string,object>(run);
        stopped["stage"]="stopped";stopped["reason"]="上次窗口已关闭，旧任务未恢复。已加购商品或提交结果请先在美团核对。";
        local.Change(new Dictionary<string,object>{{"activeRun",stopped}});
    }
    internal static string UnsupportedPage(string value,string title=null)
    {
        if(value=="about:blank"||IsOfficial(value)||IsCashier(value))return null;
        if(title!=null&&System.Text.RegularExpressions.Regex.IsMatch(title,"医药|药房|药店|眼镜|美瞳|护理液|护肤|美妆|鲜花|日百|百货|数码|宠物"))return "当前是非餐饮商家，已停止选餐和加购。请返回外卖首页重选；尚未确认新订单。";
        return "当前官方页面不支持自动点餐，任务已停止。请回到美团外卖首页选择餐饮商家；尚未确认新订单。";
    }
    internal static void StopTaskForPageFailure(LocalStore local,string reason)
    {
        object value;if(!local.Engine.TryGetValue("activeRun",out value))return;
        var run=value as Dictionary<string,object>;
        if(run==null||!run.ContainsKey("stage")||new[]{"done","failed","stopped"}.Contains(Convert.ToString(run["stage"])))return;
        var failed=new Dictionary<string,object>(run);failed["stage"]="failed";failed["reason"]=reason;
        local.Change(new Dictionary<string,object>{{"activeRun",failed}});
    }
    internal static bool IsPanel(string value)
    { Uri uri;return Uri.TryCreate(value,UriKind.Absolute,out uri)&&uri.Scheme=="https"&&uri.Host=="shenqi.local"&&uri.IsDefaultPort&&uri.AbsolutePath=="/options.html"&&uri.Query==""; }
    internal static bool IsOfficial(string value)
    { Uri uri;return Uri.TryCreate(value,UriKind.Absolute,out uri)&&uri.Scheme=="https"&&uri.Host=="h5.waimai.meituan.com"&&uri.IsDefaultPort; }
    internal static bool IsCashier(string value)
    {Uri uri;return Uri.TryCreate(value,UriKind.Absolute,out uri)&&uri.Scheme=="https"&&uri.Host=="mpay.meituan.com"&&uri.IsDefaultPort&&uri.UserInfo==""&&uri.AbsolutePath=="/resource/icashier/s/index.html";}
    internal static bool AllowedNavigation(string value)
    { if(value=="about:blank")return true;Uri uri;if(!Uri.TryCreate(value,UriKind.Absolute,out uri)||uri.Scheme!="https"||!uri.IsDefaultPort)return false;return uri.Host=="meituan.com"||uri.Host.EndsWith(".meituan.com",StringComparison.OrdinalIgnoreCase)||uri.Host=="dianping.com"||uri.Host.EndsWith(".dianping.com",StringComparison.OrdinalIgnoreCase); }
    string Asset(string name) { return File.ReadAllText(Path.Combine(Bootstrap.Assets,name),Encoding.UTF8); }
    void PostPanel(object value) { if(panel.CoreWebView2!=null&&IsPanel(panel.Source==null?"":panel.Source.AbsoluteUri))panel.CoreWebView2.PostWebMessageAsJson(Bootstrap.Json.Serialize(value)); }
    void PostPage(object value) { if(official.CoreWebView2!=null&&IsOfficial(official.Source==null?"":official.Source.AbsoluteUri))official.CoreWebView2.PostWebMessageAsJson(Bootstrap.Json.Serialize(value)); }
    async Task Initialize()
    {
        try
        {
            var environment=await CoreWebView2Environment.CreateAsync(null,Path.Combine(Bootstrap.Root,"BrowserProfile"),new CoreWebView2EnvironmentOptions("--disable-gpu"));
            await panel.EnsureCoreWebView2Async(environment);await official.EnsureCoreWebView2Async(environment);
            await official.CoreWebView2.Profile.SetPermissionStateAsync(CoreWebView2PermissionKind.Geolocation,"https://h5.waimai.meituan.com",CoreWebView2PermissionState.Default);
            panel.CoreWebView2.SetVirtualHostNameToFolderMapping("shenqi.local",Bootstrap.Assets,CoreWebView2HostResourceAccessKind.DenyCors);
            panel.CoreWebView2.Settings.AreDefaultContextMenusEnabled=false;
            panel.CoreWebView2.NavigationStarting+=delegate(object sender,CoreWebView2NavigationStartingEventArgs args){if(!IsPanel(args.Uri))args.Cancel=true;};
            panel.CoreWebView2.NewWindowRequested+=delegate(object sender,CoreWebView2NewWindowRequestedEventArgs args){args.Handled=true;};
            panel.CoreWebView2.WebMessageReceived+=PanelMessage;
            await panel.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync("window.addEventListener('error',e=>chrome.webview.postMessage({channel:'frontend-error',message:e.message}));window.addEventListener('unhandledrejection',e=>chrome.webview.postMessage({channel:'frontend-error',message:String(e.reason?.message||e.reason)}));");
            panel.CoreWebView2.ProcessFailed+=delegate {renderStatus.Text="控制区显示进程异常，请关闭并重新打开神器";StopTaskForPageFailure(store,"控制区显示异常，点餐已停止。");};
            official.CoreWebView2.ProcessFailed+=delegate {
                documentReady=false;renderStatus.Text="美团显示进程异常，请核对官方订单后重新打开神器";
                StopTaskForPageFailure(store,"美团显示进程异常，点餐已停止。已加购商品及提交结果请本人核对。");
                SendPageState(false,"美团显示进程异常，已停止点餐；请核对官方订单。",false);
            };
            official.CoreWebView2.Settings.IsStatusBarEnabled=false;
            official.CoreWebView2.WebMessageReceived+=PageMessage;
            official.CoreWebView2.NavigationStarting+=delegate(object sender,CoreWebView2NavigationStartingEventArgs args){
                if(!AllowedNavigation(args.Uri))
                {
                    args.Cancel=true;blockedNavigations.Add(args.NavigationId);
                    // A blocked app-launch link does not invalidate the document already on screen.
                    if(!documentReady&&(official.Source==null||!IsCashier(official.Source.AbsoluteUri)))SendPageState(false,"已阻止打开外部链接。请回到美团外卖首页；尚未确认新订单。",false);
                }
                else {currentNavigation=args.NavigationId;documentReady=false;lastHttpError=null;SendPageState(false,null,false);}
            };
            official.CoreWebView2.NewWindowRequested+=delegate(object sender,CoreWebView2NewWindowRequestedEventArgs args){args.Handled=true;if(AllowedNavigation(args.Uri))official.Source=new Uri(args.Uri);else if(!documentReady&&(official.Source==null||!IsCashier(official.Source.AbsoluteUri)))SendPageState(false,"请在手机美团中完成外部支付或操作。",false);};
            official.CoreWebView2.PermissionRequested+=delegate(object sender,CoreWebView2PermissionRequestedEventArgs args){
                args.SavesInProfile=false;
                args.State=CoreWebView2PermissionState.Deny;
                if(!Bootstrap.Test&&args.PermissionKind==CoreWebView2PermissionKind.Geolocation&&AllowedNavigation(args.Uri)&&MessageBox.Show(this,"美团官方页面请求使用本机定位以展示附近商家。是否允许本次定位？也可拒绝并手动选择地址。","美团定位请求",MessageBoxButtons.YesNo,MessageBoxIcon.Question)==DialogResult.Yes)args.State=CoreWebView2PermissionState.Allow;
            };
            official.CoreWebView2.ServerCertificateErrorDetected+=delegate(object sender,CoreWebView2ServerCertificateErrorDetectedEventArgs args){args.Action=CoreWebView2ServerCertificateErrorAction.Cancel;documentReady=false;StopTaskForPageFailure(store,"官方网页证书验证失败，已停止连接。");SendPageState(false,"官方网页证书验证失败，已停止连接。",false);};
            official.CoreWebView2.NavigationCompleted+=async delegate(object sender,CoreWebView2NavigationCompletedEventArgs args){
                bool blocked=blockedNavigations.Remove(args.NavigationId);
                if(args.NavigationId!=currentNavigation||blocked)return;
                if(args.HttpStatusCode>=400){documentReady=false;lastHttpError="官方网页返回 HTTP "+args.HttpStatusCode+"，请稍后重试。尚未确认新订单。";StopTaskForPageFailure(store,lastHttpError);SendPageState(false,lastHttpError,false);return;}
                if(!args.IsSuccess){documentReady=false;string failure=args.WebErrorStatus==CoreWebView2WebErrorStatus.OperationCanceled?"当前网页加载已取消，请点击返回美团首页后重试。尚未确认新订单。":"网页加载失败："+args.WebErrorStatus;StopTaskForPageFailure(store,failure);SendPageState(false,failure,false);return;}
                lastHttpError=null;
                if(IsCashier(official.Source.AbsoluteUri))
                {
                    documentReady=false;pageStatus="已进入美团官方付款页，请本人核对订单并付款。";
                    PostPanel(new {channel="page-state",state=new {ready=false,cashier=true,complete=true,status=pageStatus,url=official.Source.GetLeftPart(UriPartial.Path)}});
                    await ObserveCashier();return;
                }
                bool supported=IsOfficial(official.Source.AbsoluteUri);documentReady=supported;
                string unsupported=UnsupportedPage(official.Source.AbsoluteUri,official.CoreWebView2.DocumentTitle);
                if(unsupported!=null)StopTaskForPageFailure(store,unsupported);
                SendPageState(supported,unsupported,true);if(supported){await Inject();await official.CoreWebView2.ExecuteScriptAsync("globalThis.ShenqiReading?.setEnabled("+(reading.Checked?"true":"false")+")");}
            };
            string script="if(window===window.top&&location.origin==='https://h5.waimai.meituan.com'){\n";
            foreach(string name in new[]{"page-bridge.js","guard-data.js","policy.js","schedule.js","adapter.js","styles.js","official-theme.js"})script+=Asset(name)+"\n";
            await official.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(script+"\nglobalThis.ShenqiReading?.setEnabled("+(reading.Checked?"true":"false")+");\n}");
            if(Bootstrap.Test)
            {
                official.CoreWebView2.AddWebResourceRequestedFilter("*",CoreWebView2WebResourceContext.All);
                official.CoreWebView2.WebResourceRequested+=async delegate(object sender,CoreWebView2WebResourceRequestedEventArgs args){
                    var deferred=args.GetDeferral();
                    try
                    {
                        if(args.Request.Uri.Contains("slow-fixture=1"))await Task.Delay(450);
                        string html=IsOfficial(args.Request.Uri)?Fixture(new Uri(args.Request.Uri).AbsolutePath):IsCashier(args.Request.Uri)?"<!doctype html><meta charset='utf-8'><h1>支付订单</h1><p>交易剩余时间14:39</p><p>支付金额 ¥15.00</p><p>测试素炒河粉餐厅-4400000000000000001</p><button onclick=\"window.fixturePayments=(window.fixturePayments||0)+1\">确认付款</button>":"";
                        int status=args.Request.Uri.Contains("fixture-http=502")?502:200;
                        args.Response=environment.CreateWebResourceResponse(new MemoryStream(Encoding.UTF8.GetBytes(html)),status,status==200?"OK":"Bad Gateway","Content-Type: text/html; charset=utf-8\r\nCache-Control: no-store");
                    }
                    finally{deferred.Complete();}
                };
            }
            panel.Source=new Uri("https://shenqi.local/options.html");
            await Task.WhenAny(panelReady.Task,Task.Delay(20000));if(!panelReady.Task.IsCompleted){string detail=await panel.CoreWebView2.ExecuteScriptAsync("JSON.stringify({title:document.title,message:document.getElementById('message')?.textContent,state:document.readyState})");throw new IOException("控制面板启动超时。"+detail+string.Join("；",errors.ToArray()));}
            loading.Visible=false;initialized=true;RestoreWebViews();timer.Start();if(!Bootstrap.Test)remoteTimer.Start();official.Source=new Uri(Home);
            if(Bootstrap.Test&&!Bootstrap.Demo)await SelfTest();
        }
        catch(Exception error)
        {
            ExitCode=1;pageStatus="无法打开内置网页："+error.Message;renderStatus.Text="网页初始化失败，详情见下方提示";
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
            case "status":return new {barkConfigured=!string.IsNullOrEmpty(store.BarkKey),lastBark,version="0.6.4",remoteEnabled=remote.Enabled};
            case "remote_enable":
                if(!(args["enabled"] is bool))throw new IOException("远程开关格式无效。");remote.Enable((bool)args["enabled"]);await remote.Poll(RemoteInspect,RemoteExecute);return new {ok=true};
            case "remote_reset":await remote.Reset(RemoteInspect);return new {ok=true};
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
                return new {message="程序：0.6.4\n内置网页："+(official.CoreWebView2==null?"未启动":"已启动")+"\n当前网页："+(official.Source==null?"未打开":official.Source.GetLeftPart(UriPartial.Path))+"\n"+pageStatus+"\n绘制模式：软件兼容\n显示恢复次数："+renderRecoveries+"\n桌面控制台错误："+errors.Count};
            default:throw new IOException("不支持此操作。");
        }
    }
    void PageMessage(object sender,CoreWebView2WebMessageReceivedEventArgs args)
    {
        if(!documentReady||lastHttpError!=null||!IsOfficial(args.Source)||official.Source==null||!IsOfficial(official.Source.AbsoluteUri)||new Uri(args.Source).GetLeftPart(UriPartial.Query)!=official.Source.GetLeftPart(UriPartial.Query))return;
        try
        {
            if(args.WebMessageAsJson.Length>65536)return;
            var message=Bootstrap.Json.Deserialize<Dictionary<string,object>>(args.WebMessageAsJson);
            string channel=Convert.ToString(message["channel"]);
            if(channel=="page-request")
            {
                var body=(Dictionary<string,object>)message["body"];string type=Convert.ToString(body["type"]);
                if(!new HashSet<string>{"read","save","reserve","clear","schedule_check","schedule_attention","schedule_stage","schedule_shop","schedule_failed","order_result"}.Contains(type))return;
                PostPanel(new {channel="page-request",id=message["id"],body,url=args.Source});
            }
            if(channel=="page-status")
            {
                pageStatus=Convert.ToString(message["status"]);
                PostPanel(new {channel="page-state",state=new {ready=true,status=pageStatus,loginNeeded=message["loginNeeded"],pendingSpecs=message.ContainsKey("pendingSpecs")&&Convert.ToBoolean(message["pendingSpecs"]),url=args.Source}});
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
        await RemoteLink.VerifyTransport(Path.Combine(Bootstrap.Root,"remote-transport-check"));
        if(IsPanel("https://shenqi.local.evil/options.html")||IsPanel("https://shenqi.local:8443/options.html")||IsOfficial("https://h5.waimai.meituan.com.evil/")||AllowedNavigation("file:///C:/test"))throw new IOException("来源校验失败。");
        await Task.Delay(2500);
        await official.CoreWebView2.ExecuteScriptAsync("location.href='shenqi-test://blocked-app-launch'");await Task.Delay(400);
        if(!documentReady||await panel.CoreWebView2.ExecuteScriptAsync("Boolean(Desktop&&document.getElementById('connection').textContent==='美团内容已加载')")!="true")throw new IOException("拦截外部拉起链接误报当前网页失败。");
        official.Source=new Uri(Home+"?slow-fixture=1");await Task.Delay(70);official.Source=new Uri(Home);await Task.Delay(1000);
        if(!documentReady||await panel.CoreWebView2.ExecuteScriptAsync("document.getElementById('connection').textContent")!="\"美团内容已加载\"")throw new IOException("被替换的旧导航覆盖了新页面的成功状态。");
        store.Change(new Dictionary<string,object>{{"activeRun",new Dictionary<string,object>{{"id","http-error-test"},{"stage","home"}}}});
        official.Source=new Uri(Home+"?fixture-http=502");await Task.Delay(2600);
        if(documentReady||await panel.CoreWebView2.ExecuteScriptAsync("document.getElementById('pageStatus').textContent.includes('HTTP 502')")!="true")throw new IOException("真实HTTP错误未保留，或被页面心跳误报为成功。ready="+documentReady+"；http="+lastHttpError+"；界面="+await panel.CoreWebView2.ExecuteScriptAsync("document.getElementById('pageStatus').textContent"));
        if(Convert.ToString(((Dictionary<string,object>)store.Engine["activeRun"])["stage"])!="failed")throw new IOException("真实HTTP错误后任务仍在执行。");
        store.Remove(new[]{"activeRun"});
        official.Source=new Uri(Home);await Task.Delay(1000);
        if(!documentReady||lastHttpError!=null)throw new IOException("真实错误后返回首页未恢复。");
        ulong paintNavigation=currentNavigation;
        await official.CoreWebView2.ExecuteScriptAsync("window.paintRecoveryProbe='same-document'");
        for(int restore=0;restore<2;restore++)
        {
            WindowState=FormWindowState.Minimized;await Task.Delay(120);WindowState=FormWindowState.Normal;await Task.Delay(350);
            if(!panel.Visible||!official.Visible)throw new IOException("恢复窗口后网页控件仍隐藏。");
        }
        RestoreWebViews();await Task.Delay(200);
        if(currentNavigation!=paintNavigation||await official.CoreWebView2.ExecuteScriptAsync("window.paintRecoveryProbe")!="\"same-document\"")throw new IOException("显示恢复意外刷新了页面。");
        if(renderRecoveries<3)throw new IOException("窗口恢复显示流程未触发。");
        string layoutCheck="(()=>{const main=document.querySelector('main'),button=document.getElementById('startMeal'),box=button.getBoundingClientRect();return document.body.scrollWidth<=innerWidth&&main.scrollWidth<=main.clientWidth&&box.height>=44&&box.top>=0&&box.bottom<=innerHeight;})()";
        if(await panel.CoreWebView2.ExecuteScriptAsync(layoutCheck)!="true")throw new IOException("点餐按钮被遮挡或界面横向溢出。");
        using(var idle=new FileStream(Path.Combine(Bootstrap.Root,"panel-idle.png"),FileMode.Create))await panel.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png,idle);
        var split=panel.Parent.Parent as SplitContainer;int previous=split.SplitterDistance;split.SplitterDistance=360;await Task.Delay(200);
        if(await panel.CoreWebView2.ExecuteScriptAsync(layoutCheck)!="true")throw new IOException("窄栏点餐布局不可用。");
        using(var narrow=new FileStream(Path.Combine(Bootstrap.Root,"panel-narrow.png"),FileMode.Create))await panel.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png,narrow);
        split.SplitterDistance=previous;
        foreach(string tab in new[]{"schedule","notice"})
        {
            await panel.CoreWebView2.ExecuteScriptAsync("document.getElementById('"+tab+"Tab').click()");await Task.Delay(100);
            if(await panel.CoreWebView2.ExecuteScriptAsync("document.querySelector('main').scrollWidth<=document.querySelector('main').clientWidth&&document.getElementById('mealAction').hidden")!="true")throw new IOException("设置页布局或操作区切换异常。");
            using(var image=new FileStream(Path.Combine(Bootstrap.Root,"panel-"+tab+".png"),FileMode.Create))await panel.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png,image);
        }
        await panel.CoreWebView2.ExecuteScriptAsync("document.getElementById('mealTab').click()");
        if(await official.CoreWebView2.ExecuteScriptAsync("document.documentElement.getAttribute('data-shenqi-reading')")=="null")throw new IOException("首页舒适排版未加载。");
        using(var homeImage=new FileStream(Path.Combine(Bootstrap.Root,"official-home.png"),FileMode.Create))await official.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png,homeImage);
        official.Source=new Uri("https://h5.waimai.meituan.com/waimai/mindex/menu?poi_id_str=fixture");await Task.Delay(900);
        if(await official.CoreWebView2.ExecuteScriptAsync("document.documentElement.getAttribute('data-shenqi-reading')")!="\"menu\"")throw new IOException("菜单舒适排版未加载。");
        if(await official.CoreWebView2.ExecuteScriptAsync("getComputedStyle(document.documentElement).fontSize")!="\"50px\"")throw new IOException("手机页面rem随桌面宽度被放大。");
        using(var menuImage=new FileStream(Path.Combine(Bootstrap.Root,"official-menu.png"),FileMode.Create))await official.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png,menuImage);
        reading.Checked=false;await Task.Delay(100);
        if(await official.CoreWebView2.ExecuteScriptAsync("document.documentElement.hasAttribute('data-shenqi-reading')")!="false")throw new IOException("无法恢复官方原样。");
        if(await official.CoreWebView2.ExecuteScriptAsync("getComputedStyle(document.documentElement).fontSize")!="\"120px\"")throw new IOException("官方原始缩放未恢复。");
        reading.Checked=true;official.Source=new Uri(Home);await Task.Delay(1000);
        // Full isolated flow now enters through the same bounded transport used by
        // the phone page, and reaches the real panel/engine/WebView2 fixtures.
        remote.Enable(true);await panel.CoreWebView2.ExecuteScriptAsync("Desktop.inspect()");await Task.Delay(400);
        string remoteDirectory=Path.Combine(Bootstrap.Root,"RemoteBridge");Directory.CreateDirectory(remoteDirectory);
        long issuedAt=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var remoteCommand=new Dictionary<string,object>{{"version",1},{"id",Guid.NewGuid().ToString()},{"kind","meal"},{"createdAt",issuedAt},{"expiresAt",issuedAt+60000},{"request","想吃河粉 25元预算 一份"},{"budget",2500},{"authorized",true}};
        File.WriteAllText(Path.Combine(remoteDirectory,"command.json"),Bootstrap.Json.Serialize(remoteCommand),new UTF8Encoding(false));
        await remote.Poll(RemoteInspect,RemoteExecute);
        bool done=false;
        for(int i=0;i<100;i++)
        {
            await Task.Delay(500);
            if(store.Engine.ContainsKey("lastOrder")){done=true;break;}
            if(store.Engine.ContainsKey("activeRun")) {var current=(Dictionary<string,object>)store.Engine["activeRun"];if(Convert.ToString(current["stage"])=="failed")break;}
        }
        if(!done)throw new IOException("模拟点餐未完成。"+Bootstrap.Json.Serialize(store.Engine)+"；前端："+string.Join("；",errors.ToArray())+"；页面："+pageStatus);
        var last=(Dictionary<string,object>)store.Engine["lastOrder"];
        if(Convert.ToString(last["orderId"])!="4400000000000000001"||Convert.ToInt32(last["total"])!=1500)throw new IOException("模拟订单核对失败。");
        int submissions=1; // Re-read the H5 fixture counter after verifying the read-only cashier.
        if(!IsCashier(official.Source.AbsoluteUri)||await official.CoreWebView2.ExecuteScriptAsync("Number(window.fixturePayments||0)")!="0"||await official.CoreWebView2.ExecuteScriptAsync("typeof ShenqiAdapter")!="\"undefined\"")throw new IOException("收银台被注入点餐引擎或触发了付款。");
        if(Bootstrap.Json.Serialize(store.Engine).Contains("FIXTURE-PRIVATE"))throw new IOException("支付凭据被保存到订单记录。");
        official.Source=new Uri("https://h5.waimai.meituan.com/waimai/mindex/order-detail?mtOrderViewId=4400000000000000001");await Task.Delay(700);
        submissions=Convert.ToInt32(await official.CoreWebView2.ExecuteScriptAsync("Number(localStorage.fixtureSubmits||0)"));if(submissions!=1)throw new IOException("提交次数不符合单次限制。");
        await panel.CoreWebView2.ExecuteScriptAsync("Desktop.inspect()");await Task.Delay(200);await remote.Poll(RemoteInspect,RemoteExecute);
        string remoteProof=File.ReadAllText(Path.Combine(remoteDirectory,"status.json"));
        if(remoteProof.Contains("FIXTURE-PRIVATE")||!remoteProof.Contains("4400000000000000001")||File.Exists(Path.Combine(remoteDirectory,"claimed.json")))throw new IOException("手机请求未收到已核对的模拟订单结果。");
        if(store.Engine.ContainsKey("schedule")&&Convert.ToBoolean(((Dictionary<string,object>)store.Engine["schedule"])["enabled"]))throw new IOException("单次点餐意外启用了循环定时。");
        var reloaded=new LocalStore(Bootstrap.Root);if(!reloaded.Engine.ContainsKey("lastOrder"))throw new IOException("点餐记录未持久保存。");
        string file=Path.Combine(Bootstrap.Root,"settings.dpapi");if(Encoding.UTF8.GetString(File.ReadAllBytes(file)).Contains("4400000000000000001"))throw new IOException("本机状态未加密。");
        var finished=new Dictionary<string,object>((Dictionary<string,object>)store.Engine["activeRun"]);
        var interrupted=new Dictionary<string,object>(finished);interrupted["stage"]="preview";
        store.Change(new Dictionary<string,object>{{"activeRun",interrupted}});StopInterruptedTask(store);
        if(Convert.ToString(((Dictionary<string,object>)store.Engine["activeRun"])["stage"])!="stopped"||!Convert.ToBoolean(store.Engine["submissionAttempt"])||!store.Engine.ContainsKey("attemptMeta"))throw new IOException("重开后旧任务或提交防重记录处理异常。");
        var redirected=new Dictionary<string,object>(finished);redirected["stage"]="menu";
        store.Change(new Dictionary<string,object>{{"activeRun",redirected}});
        StopTaskForPageFailure(store,UnsupportedPage("https://cactivityapi-sc.waimai.meituan.com/h5/sub-trade/restaurant/restaurant"));
        if(Convert.ToString(((Dictionary<string,object>)store.Engine["activeRun"])["stage"])!="failed"||!Convert.ToBoolean(store.Engine["submissionAttempt"]))throw new IOException("不支持的商家跳转未停止任务或丢失防重记录。");
        store.Change(new Dictionary<string,object>{{"activeRun",finished}});
        await panel.CoreWebView2.ExecuteScriptAsync("Desktop.inspect()");await Task.Delay(400);
        await Inject();
        string singleSurface=await official.CoreWebView2.ExecuteScriptAsync("(()=>{const host=document.getElementById('shenqi-waimai-assistant');return !!host&&getComputedStyle(host).display==='none'&&host.getClientRects().length===0&&host.getAttribute('aria-hidden')==='true';})()");
        if(singleSurface!="true")throw new IOException("右侧仍有重复的助手界面。");
        using(var left=new FileStream(Path.Combine(Bootstrap.Root,"panel.png"),FileMode.Create))await panel.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png,left);
        // Official home/menu previews were captured above; the final receipt is verified structurally.
        WriteReport(new {ok=true,sourceGuards=true,softwareRendering=true,restoreKeepsDocument=true,nativeRecoveryBar=true,navigationCancellationScoped=true,blockedAppLinkKeepsPage=true,realHttpErrorPreserved=true,embeddedBrowser=true,fullFixtureFlow=true,nonfoodExcluded=true,unsupportedRedirectStopped=true,reversibleOfficialReading=true,desktopRemScaleCapped=true,singleAssistantSurface=true,primaryActionVisible=true,narrowLayout=true,interruptedTaskNotResumed=true,reportedNoodleRequest=true,ordinaryAddControl=true,unpaidOrder="4400000000000000001",total=1500,submissions,recurrenceNotEnabled=true,encryptedState=true,cashierReadOnly=true,paymentTokensRemoved=true,frontendErrors=errors,windowWidth=Width,windowHeight=Height});
        ExitCode=0;Close();
    }
    string Fixture(string path)
    {
        string head="<!doctype html><meta charset='utf-8'><style>html{font-size:120px}h1{font-size:.44rem}body{font:18px sans-serif;padding:30px;color:#352a22}button,.clickArea_mock{min-width:48px;min-height:40px;display:inline-block;margin:6px}.poilist-item{padding:20px;border:1px solid #ccc}.banner{padding:16px;background:#f4dfb9}dd{padding:20px}</style><div class='banner'>本地模拟 · 不连接真实美团 · 不会产生真实订单</div>";
        if(path.EndsWith("/home"))return head+"<h1>测试附近商家</h1><div class='poilist-item' onclick=\"location.href='https://cactivityapi-sc.waimai.meituan.com/h5/sub-trade/restaurant/restaurant'\"><b class='poilist-item-info1name'>EyeSoul隐形眼镜（测试店）</b><p>起送￥10 配送￥0</p></div><div class='poilist-item' onclick=\"location.href='https://cactivityapi-sc.waimai.meituan.com/h5/sub-trade/restaurant/restaurant'\"><b class='poilist-item-info1name'>111医药馆（测试店）</b><p>起送￥20 配送￥0</p></div><div class='poilist-item' onclick=\"location.href='/waimai/mindex/menu?poi_id_str=fixture'\"><b class='poilist-item-info1name'>测试素炒河粉餐厅</b><span class='poi-info-txt'>起送 ¥10</span><span class='poi-info-txt'>配送 约¥0</span><span class='poi-info-txt'>15分钟</span><span class='poi-info-txt'>1.9km</span></div>";
        if(path.EndsWith("/menu"))return head+"<h1>测试素炒河粉餐厅</h1><dl><dd data-tag=\"spu\"><div class=\"name_mock\">测试素炒河粉</div><div data-tag=\"price\">￥16.00</div><div class=\"sqt-menu-add-buttons\"><button aria-label=\"选择规格\"><span class=\"clickArea_mock\" onclick=\"document.getElementById('spec').hidden=false\"></span></button><span id=\"qty\" class=\"count_mock\"></span></div></dd></dl><div class=\"cart_footer\"><button id=\"cart\" aria-label=\"购物车，没有商品\"></button><span id=\"badge\" class=\"badge_mock\"></span></div><button onclick=\"location.href='/waimai/mindex/preview'\">去结算</button><section id=\"spec\" hidden><button aria-label=\"关闭商品规格选择弹窗\" onclick=\"document.getElementById('spec').hidden=true\">关闭</button><dl data-tag=\"attribute\"><dt>份量</dt><dd><span class=\"tag_mock\">1人份 ¥16.00</span></dd></dl><dl data-tag=\"attribute\"><dt>口味</dt><dd><span class=\"tag_mock\">芝麻沙拉汁</span><span class=\"tag_mock\">油醋沙拉汁</span></dd></dl><p>已选规格：1人份、芝麻沙拉汁</p><div class=\"price_mock\">总计 ¥16.00</div><div class=\"addToCartBtn_mock\" onclick=\"document.getElementById('qty').textContent='1';document.getElementById('badge').textContent='1';document.getElementById('cart').setAttribute('aria-label','购物车')\">加入购物车</div></section>";
        if(path.EndsWith("/preview"))return head+"<h1>测试订单预览</h1><div class='spuInfoList_mock'><span class='spuInfoSpan_mock'>测试素炒河粉</span><span class='spuAmount_mock'>x1</span></div><div class='promotion_mock' onclick=\"document.getElementById('coupons').hidden=false\"><span>美团红包</span><span class='promotionSelect_mock'>-￥3.00</span></div><div class='promotion_mock'><span>商家代金券</span><span class='promotionSelect_mock'>无可用</span></div><div id='coupons' hidden><div>可使用红包</div><div class='cell-wrapper'><span class='price-amount-container'>￥3.00</span><div class='coupon-wrapper'>模拟红包</div></div><button onclick=\"document.getElementById('coupons').hidden=true\">确认</button></div><div><span class='actual_mock'>￥15.00</span><button id='sqt-openh5-preview-submit-btn' onclick=\"localStorage.fixtureSubmits=String(Number(localStorage.fixtureSubmits||0)+1);location.href='https://mpay.meituan.com/resource/icashier/s/index.html?pay_success_url=https%3A%2F%2Fh5.waimai.meituan.com%2Fwaimai%2Fmindex%2Forder-detail%3FmtOrderViewId%3D4400000000000000001&pay_token=FIXTURE-PRIVATE'\">提交订单</button></div>";
        return head+"<h1>待支付</h1><p>订单号：4400000000000000001</p><p>待支付金额：￥15.00</p><button>由本人付款</button>";
    }
}

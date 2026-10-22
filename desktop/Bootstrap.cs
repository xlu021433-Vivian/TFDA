using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

[assembly: AssemblyTitle("神器 · 独立桌面点餐助手")]
[assembly: AssemblyVersion("0.6.0.0")]
[assembly: AssemblyFileVersion("0.6.0.0")]

internal static class Bootstrap
{
    internal static string Root, Assets;
    internal static bool Test, Demo;
    internal static string Report;
    internal static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 4 * 1024 * 1024 };
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool SetDllDirectory(string path);
    internal static byte[] Resource(string name)
    {
        using(var input=Assembly.GetExecutingAssembly().GetManifestResourceStream("Shenqi."+name))
        using(var buffer=new MemoryStream()) { if(input==null)throw new IOException("程序资源缺失："+name);input.CopyTo(buffer);return buffer.ToArray(); }
    }
    internal static string Hash(byte[] data) { using(var sha=SHA256.Create())return BitConverter.ToString(sha.ComputeHash(data)).Replace("-","").ToLowerInvariant(); }
    static string Argument(string[] args,string key)
    { for(int i=0;i<args.Length-1;i++)if(args[i]==key)return args[i+1];return null; }
    [STAThread]
    static int Main(string[] args)
    {
        try
        {
            Demo=Array.IndexOf(args,"--demo")>=0;
            Test=Array.IndexOf(args,"--self-test")>=0||Demo;
            Root=Path.GetFullPath(Argument(args,"--data-dir")??Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"ShenqiDesktop"));
            Report=Argument(args,"--report");
            if(Test&&(Argument(args,"--data-dir")==null||(Directory.Exists(Root)&&Directory.GetFileSystemEntries(Root).Length!=0)))
                throw new IOException("测试必须使用新的空数据目录，不能使用本人已登录的目录。");
            bool created;
            using(var mutex=new Mutex(true,"Local\\ShenqiDesktop-"+Hash(Encoding.UTF8.GetBytes(Root.ToLowerInvariant())).Substring(0,20),out created))
            {
                if(!created) { MessageBox.Show("神器已经在运行。请切换到已打开的神器窗口。","神器");return 0; }
                Assets=Path.Combine(Root,"Runtime","0.6.0");Directory.CreateDirectory(Assets);
                var files=Json.Deserialize<List<Dictionary<string,string>>>(Encoding.UTF8.GetString(Resource("runtime-files.json")));
                foreach(var file in files)
                {
                    string name=file["name"];if(Path.GetFileName(name)!=name)throw new IOException("程序资源路径异常。");
                    var bytes=Resource(name);if(Hash(bytes)!=file["sha256"])throw new IOException("程序资源校验失败。");
                    string target=Path.Combine(Assets,name);
                    if(!File.Exists(target)||Hash(File.ReadAllBytes(target))!=file["sha256"])File.WriteAllBytes(target,bytes);
                }
                AppDomain.CurrentDomain.AssemblyResolve+=delegate(object sender,ResolveEventArgs eventArgs){
                    string name=new AssemblyName(eventArgs.Name).Name;
                    if(name!="Microsoft.Web.WebView2.Core"&&name!="Microsoft.Web.WebView2.WinForms")return null;
                    return Assembly.LoadFrom(Path.Combine(Assets,name+".dll"));
                };
                if(!SetDllDirectory(Assets))throw new IOException("无法加载内置网页组件。");
                Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);
                return Launch();
            }
        }
        catch(Exception error)
        {
            if(Report!=null)File.WriteAllText(Report,Json.Serialize(new { ok=false,error=error.Message }),new UTF8Encoding(false));
            if(!Test)MessageBox.Show("无法启动神器："+error.Message+"\n无需运行 BAT 或安装浏览器扩展。","神器",MessageBoxButtons.OK,MessageBoxIcon.Error);
            return 1;
        }
    }
    [MethodImpl(MethodImplOptions.NoInlining)]
    static int Launch() { using(var window=new DesktopHost()){Application.Run(window);return window.ExitCode;} }
}

internal sealed class LocalStore
{
    readonly string path;
    readonly object gate=new object();
    Dictionary<string,object> root;
    internal LocalStore(string directory)
    {
        Directory.CreateDirectory(directory);path=Path.Combine(directory,"settings.dpapi");
        root=File.Exists(path)?Bootstrap.Json.Deserialize<Dictionary<string,object>>(Encoding.UTF8.GetString(ProtectedData.Unprotect(File.ReadAllBytes(path),null,DataProtectionScope.CurrentUser))):new Dictionary<string,object>();
        if(!root.ContainsKey("engine"))root["engine"]=new Dictionary<string,object>();
    }
    internal Dictionary<string,object> Engine { get { return (Dictionary<string,object>)root["engine"]; } }
    internal string BarkKey { get { return root.ContainsKey("barkKey")?Convert.ToString(root["barkKey"]):""; } }
    internal void SetBark(string key) { lock(gate){root["barkKey"]=key;Save();} }
    internal void Change(Dictionary<string,object> change) { lock(gate){foreach(var item in change)Engine[item.Key]=item.Value;Save();} }
    internal void Remove(System.Collections.IEnumerable keys) { lock(gate){foreach(var key in keys)Engine.Remove(Convert.ToString(key));Save();} }
    void Save()
    {
        var data=ProtectedData.Protect(Encoding.UTF8.GetBytes(Bootstrap.Json.Serialize(root)),null,DataProtectionScope.CurrentUser);
        string temporary=path+"."+Guid.NewGuid().ToString("N")+".tmp";File.WriteAllBytes(temporary,data);
        if(File.Exists(path))File.Replace(temporary,path,null);else File.Move(temporary,path);
    }
}

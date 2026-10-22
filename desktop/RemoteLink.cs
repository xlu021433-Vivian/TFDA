using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading.Tasks;

// Narrow owner-controller boundary: files in the current Windows user's app data.
// No network listener, external URLs, shell commands, cookies or keys are accepted.
internal sealed class RemoteLink
{
    readonly string root;
    readonly LocalStore store;
    string requestId="",requestState="",requestError="";
    bool polling;
    internal bool Enabled { get {object value;return store.Engine.TryGetValue("remoteEnabled",out value)&&value is bool&&(bool)value;} }
    internal RemoteLink(string directory,LocalStore local){root=Path.Combine(directory,"RemoteBridge");store=local;}
    internal void Enable(bool value){store.Change(new Dictionary<string,object>{{"remoteEnabled",value}});}
    static long Now(){return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();}
    FileStream Lock(){Directory.CreateDirectory(root);return new FileStream(Path.Combine(root,"bridge.lock"),FileMode.CreateNew,FileAccess.Write,FileShare.None);}
    void Unlock(FileStream handle){handle.Dispose();File.Delete(Path.Combine(root,"bridge.lock"));}
    Dictionary<string,object> Read(string name){string path=Path.Combine(root,name);if(new FileInfo(path).Length>65536)throw new IOException("远程请求过大。");return Bootstrap.Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(path,Encoding.UTF8));}
    void Publish(Dictionary<string,object> value)
    {
        Directory.CreateDirectory(root);value["enabled"]=Enabled;value["updatedAt"]=Now();value["version"]="0.6.0";
        value["requestId"]=requestId;value["requestState"]=requestState;value["requestError"]=requestError;
        string target=Path.Combine(root,"status.json"),temp=Path.Combine(root,"status-"+Guid.NewGuid().ToString("N")+".tmp");
        File.WriteAllText(temp,Bootstrap.Json.Serialize(value),new UTF8Encoding(false));
        if(File.Exists(target))File.Replace(temp,target,null);else File.Move(temp,target);
    }
    internal async Task Reset(Func<Task<Dictionary<string,object>>> inspect)
    {
        if(polling)throw new IOException("桌面正在同步，请稍后重试。");
        var status=await inspect();
        if(Convert.ToBoolean(status["busy"])||Convert.ToBoolean(status["locked"]))throw new IOException("请先暂停并在桌面核对上一笔官方订单、防重记录。");
        // This recovery is only callable from the local trusted panel after acknowledgement.
        string oldLock=Path.Combine(root,"bridge.lock");
        if(File.Exists(oldLock)&&DateTime.UtcNow-File.GetLastWriteTimeUtc(oldLock)<TimeSpan.FromSeconds(30))throw new IOException("连接正在同步，请稍后重试。");
        foreach(string name in new[]{"command.json","claimed.json","stop.json","bridge.lock"}){string path=Path.Combine(root,name);if(File.Exists(path))File.Delete(path);}
        requestId="";requestState="";requestError="";
    }
    internal async Task Poll(Func<Task<Dictionary<string,object>>> inspect,Func<Dictionary<string,object>,Task> execute)
    {
        if(polling)return;polling=true;
        try
        {
            var status=await inspect();
            if(!Enabled){Publish(status);return;}
            Dictionary<string,object> command=null;
            FileStream handle;
            try{handle=Lock();}catch(IOException){Publish(status);return;}
            try
            {
                string stop=Path.Combine(root,"stop.json"),queued=Path.Combine(root,"command.json"),claimed=Path.Combine(root,"claimed.json");
                if(File.Exists(stop)){command=Read("stop.json");File.Delete(stop);if(File.Exists(queued))File.Delete(queued);}
                else if(File.Exists(claimed)&&requestId=="")
                {var old=Read("claimed.json");requestId=Convert.ToString(old["id"]);requestState="interrupted";requestError="上一笔远程接收结果未确认。请在电脑核对购物车和订单后恢复连接，不会自动重试。";}
                else if(!File.Exists(claimed)&&File.Exists(queued))
                {File.Move(queued,claimed);command=Read("claimed.json");}
            }
            finally{Unlock(handle);}
            if(command!=null)
            {
                bool started=false;
                try
                {
                    Guid parsed;string kind=Convert.ToString(command["kind"]);
                    if(Convert.ToInt32(command["version"])!=1||!Guid.TryParse(Convert.ToString(command["id"]),out parsed)||!new[]{"meal","stop"}.ContainsValue(kind))throw new IOException("远程请求格式无效。");
                    if(kind=="meal"){requestId=Convert.ToString(command["id"]);requestState="accepted";requestError="";}
                    long created=Convert.ToInt64(command["createdAt"]),expires=Convert.ToInt64(command["expiresAt"]);
                    if(created>Now()+5000||expires<Now()||expires-created>60000||expires<created)throw new IOException("远程请求已过期，请重新核对后发送。");
                    if(kind=="meal")
                    {
                        if(Convert.ToBoolean(status["busy"])||Convert.ToBoolean(status["locked"]))throw new IOException("桌面已有任务或上一笔提交待核对。");
                        if(!Convert.ToBoolean(status["ready"])||Convert.ToBoolean(status["loginNeeded"]))throw new IOException("请先在桌面登录美团并核对配送地址。");
                        int budget=Convert.ToInt32(command["budget"]);string text=Convert.ToString(command["request"]);
                        if(budget<1||budget>100000||text.Length>160||!(command["authorized"] is bool)||(bool)command["authorized"]!=true)throw new IOException("远程预算或授权无效。");
                        var seen=new List<string>();object previous;
                        if(store.Engine.TryGetValue("remoteSeenIds",out previous))foreach(object entry in (System.Collections.IEnumerable)previous)seen.Add(Convert.ToString(entry));
                        if(seen.Contains(requestId))throw new IOException("这笔远程请求已接收过，不会重复执行。请先核对官方订单。");
                        seen.Add(requestId);if(seen.Count>128)seen.RemoveAt(0);
                        store.Change(new Dictionary<string,object>{{"remoteSeenIds",seen}});
                    }
                    started=true;await execute(command);status=await inspect();
                    if(kind=="stop"){requestState="stopped";requestError="";}
                }
                catch(Exception error){requestState=started?"interrupted":"rejected";requestError=started?"远程执行结果未确认，请在电脑核对购物车和官方订单；不会自动重试。":error.Message;}
            }
            if(requestId!=""&&requestState!="interrupted"&&requestState!="rejected"&&requestState!="stopped")
            {
                string stage=Convert.ToString(status["stage"]);
                requestState=Convert.ToBoolean(status["busy"])?"running":stage=="done"?"done":stage=="failed"?"failed":stage=="stopped"?"stopped":requestState;
            }
            Publish(status);
            // Acknowledged terminal results release the transport slot, never the order guard.
            if(new[]{"done","failed","stopped","rejected"}.ContainsValue(requestState))
            {
                try{handle=Lock();}catch(IOException){return;}
                try{string claimed=Path.Combine(root,"claimed.json");if(File.Exists(claimed))File.Delete(claimed);}
                finally{Unlock(handle);}
            }
        }
        catch { /* Offline timestamps expire; an unknown accepted command is never retried. */ }
        finally{polling=false;}
    }
    internal static async Task VerifyTransport(string directory)
    {
        Directory.CreateDirectory(directory);var local=new LocalStore(directory);var link=new RemoteLink(directory,local);
        string root=Path.Combine(directory,"RemoteBridge");Directory.CreateDirectory(root);
        var status=new Dictionary<string,object>{{"ready",true},{"loginNeeded",false},{"busy",false},{"locked",false},{"stage","idle"},{"message","isolated fixture"},{"order",null}};
        int meals=0,stops=0;
        Func<Task<Dictionary<string,object>>> inspect=()=>Task.FromResult(new Dictionary<string,object>(status));
        Func<Dictionary<string,object>,Task> execute=command=>{if(Convert.ToString(command["kind"])=="meal"){meals++;status["busy"]=true;status["stage"]="menu";}else{stops++;status["busy"]=false;status["stage"]="stopped";}return Task.FromResult(true);};
        Func<string,Dictionary<string,object>> commandFor=kind=>new Dictionary<string,object>{{"version",1},{"id",Guid.NewGuid().ToString()},{"kind",kind},{"createdAt",Now()},{"expiresAt",Now()+60000},{"request","想吃河粉 25元预算 一份"},{"budget",2500},{"authorized",true}};
        var first=commandFor("meal");File.WriteAllText(Path.Combine(root,"command.json"),Bootstrap.Json.Serialize(first));
        await link.Poll(inspect,execute);if(meals!=0)throw new IOException("未启用远程控制却执行了请求。");
        link.Enable(true);await link.Poll(inspect,execute);if(meals!=1||!File.Exists(Path.Combine(root,"claimed.json")))throw new IOException("远程请求未独占接收。");
        await link.Poll(inspect,execute);if(meals!=1)throw new IOException("远程任务被重复执行。");
        File.WriteAllText(Path.Combine(root,"command.json"),Bootstrap.Json.Serialize(commandFor("meal")));
        File.WriteAllText(Path.Combine(root,"stop.json"),Bootstrap.Json.Serialize(commandFor("stop")));
        await link.Poll(inspect,execute);if(stops!=1||File.Exists(Path.Combine(root,"command.json")))throw new IOException("暂停未撤销待接收任务。");
        status["busy"]=false;status["stage"]="idle";
        File.WriteAllText(Path.Combine(root,"command.json"),Bootstrap.Json.Serialize(first));await link.Poll(inspect,execute);
        if(meals!=1)throw new IOException("已接收编号被再次执行。");
        var expired=commandFor("meal");expired["createdAt"]=Now()-120000;expired["expiresAt"]=Now()-60000;
        File.WriteAllText(Path.Combine(root,"command.json"),Bootstrap.Json.Serialize(expired));await link.Poll(inspect,execute);
        if(meals!=1)throw new IOException("过期远程任务被执行。");
        File.WriteAllText(Path.Combine(root,"claimed.json"),Bootstrap.Json.Serialize(commandFor("meal")));
        var reopened=new RemoteLink(directory,local);await reopened.Poll(inspect,execute);
        if(reopened.requestState!="interrupted"||meals!=1)throw new IOException("未知接收结果被自动恢复。");
    }
}

internal static class RemoteValues
{
    internal static bool ContainsValue(this string[] values,string value){foreach(string item in values)if(item==value)return true;return false;}
}

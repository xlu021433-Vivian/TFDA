"""Build a single Windows EXE with pinned official SDK and the existing reviewed ordering engine."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import zipfile

ROOT=Path(__file__).resolve().parents[1]
SDK='1.0.4258.31'
SDK_SHA='56f7f4b8bf9aee4b8efefbbdd4f67d5f74ebd1b100ed0806da71bf76af481aa9'
ENGINE=('guard-data.js','policy.js','schedule.js','adapter.js','styles.js','content.js','watch.js')

def engine(name):
    return (ROOT/'desktop'/'engine'/name).read_bytes()

def worker():
    source=engine('state.js').decode('utf-8')
    old="if(!run||run.id!==id||!state.schedule?.enabled||"
    assert source.count(old)==1
    source=source.replace(old,"if(!run||run.id!==id||!(run.oneShot?run.config.authorized:state.schedule?.enabled)||")
    marker="      if(message.type==='configure_schedule'&&isOptions){"
    assert source.count(marker)==1
    branch="""      if(message.type==='start_now'&&isOptions){
        if(state.submissionAttempt)throw Error('上次提交尚未核对，请先查看官方订单');
        if(state.activeRun&&!['done','failed','stopped'].includes(state.activeRun.stage))throw Error('当前点餐尚未结束，请先暂停或等待');
        const config=S.validate(message.schedule);if(!config.authorized)throw Error('请先确认本次账号、地址和点餐授权');
        let menu=null;
        if(message.currentMenu){menu=new URL(message.currentMenu);if(!P.supported(menu.href)||menu.port||menu.pathname!=='/waimai/mindex/menu'||!menu.searchParams.get('poi_id_str'))throw Error('当前商家链接无法核对');}
        const tab=await api.tabs.create({url:'about:blank',active:true}),id=crypto.randomUUID(),date=S.clock(now()).date;
        await api.storage.local.set({activeRun:{id,date,tabId:tab.id,stage:menu?'menu':'home',currentShop:!!menu,tried:[],minimum:0,startedAt:now(),deadline:now()+8*60*1000,config,merchant:null,expected:null,oneShot:true}});
        await api.tabs.update(tab.id,{url:menu?menu.href:'https://h5.waimai.meituan.com/waimai/mindex/home'});return {ok:true};
      }
"""
    source=source.replace(marker,branch+marker)
    # CommonJS wrapper preserves the existing runtime without extension installation or Chrome permissions.
    return ("(function(){const module={exports:{}};const require=name=>name.includes('policy')?globalThis.ShenqiPolicy:globalThis.ShenqiSchedule;\n"+source+"\nglobalThis.ShenqiDesktopWorker=module.exports;})();").encode('utf-8')

def build(package,output):
    assert hashlib.sha256(package.read_bytes()).hexdigest()==SDK_SHA,'Official SDK checksum mismatch'
    output.mkdir(parents=True,exist_ok=True)
    assets=output/'assets';assets.mkdir(exist_ok=True)
    files={name:engine(name) for name in ENGINE}
    # The native left pane is the only assistant surface. Keep the reused engine's
    # internal controls out of layout and accessibility, including reinjection.
    original=b'  document.documentElement.appendChild(host);'
    assert files['content.js'].count(original)==1
    files['content.js']=files['content.js'].replace(original,b"  host.style.setProperty('display','none','important');\n  host.setAttribute('aria-hidden','true');\n"+original)
    for name in ('options.html','desktop.css','desktop.js','page-bridge.js','official-theme.js'):
        files[name]=(ROOT/'desktop'/name).read_bytes()
    files['worker.js']=worker()
    with zipfile.ZipFile(package) as sdk:
        for name,path in {'Microsoft.Web.WebView2.Core.dll':'lib/net462/Microsoft.Web.WebView2.Core.dll','Microsoft.Web.WebView2.WinForms.dll':'lib/net462/Microsoft.Web.WebView2.WinForms.dll','WebView2Loader.dll':'runtimes/win-x64/native/WebView2Loader.dll','WEBVIEW2-LICENSE.txt':'LICENSE.txt'}.items():files[name]=sdk.read(path)
    inventory=[]
    for name,data in files.items():
        (assets/name).write_bytes(data);inventory.append({'name':name,'sha256':hashlib.sha256(data).hexdigest()})
    (assets/'runtime-files.json').write_text(json.dumps(inventory),encoding='utf-8')
    compiler=Path('C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe')
    executable=output/'Shenqi-Desktop.exe'
    references=['System.Windows.Forms.dll','System.Drawing.dll','System.Web.Extensions.dll','System.Security.dll','System.Net.Http.dll','Microsoft.CSharp.dll',str(assets/'Microsoft.Web.WebView2.Core.dll'),str(assets/'Microsoft.Web.WebView2.WinForms.dll')]
    command=[str(compiler),'/nologo','/target:winexe','/platform:x64','/optimize+','/out:'+str(executable)]
    command+=['/reference:'+name for name in references]
    command+=['/resource:'+str(assets/name)+',Shenqi.'+name for name in [*files,'runtime-files.json']]
    command += [str(ROOT/'desktop/Bootstrap.cs'),str(ROOT/'desktop/DesktopHost.cs'),str(ROOT/'desktop/RemoteLink.cs')]
    subprocess.run(command,check=True)
    digest=hashlib.sha256(executable.read_bytes()).hexdigest()
    (output/'SHA256SUMS.txt').write_text(digest+'  '+executable.name+'\n',encoding='ascii')
    print(json.dumps({'exe':str(executable),'bytes':executable.stat().st_size,'sha256':digest,'sdk':SDK},ensure_ascii=False))

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--sdk',type=Path,default=ROOT/f'.tool-cache/webview2/microsoft.web.webview2.{SDK}.nupkg');parser.add_argument('--output',type=Path,default=ROOT/'dist/desktop-0.6.1');args=parser.parse_args();build(args.sdk.resolve(),args.output.resolve())

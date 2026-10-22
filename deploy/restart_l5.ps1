param([Parameter(Mandatory=$true)][string]$Project)
$ErrorActionPreference='Stop'
$targetRoot=(Resolve-Path -LiteralPath $Project).Path
$statePath=Join-Path $targetRoot 'data/cloudflared/runtime-state.json'
$launcher=Join-Path $targetRoot 'deploy/local-runtime.ps1'
$serverMarker=Join-Path $targetRoot 'serve.py'
$state=Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
# Stop only this launcher's recorded web processes. Leave the tunnel running.
foreach($entry in @($state.ServerWorker,$state.Server)){
    if(-not $entry){continue}
    $owned=Get-Process -Id ([int]$entry.Pid) -ErrorAction SilentlyContinue
    if(-not $owned){continue}
    $details=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$entry.Pid)
    if(-not $details -or -not $details.CommandLine){
        if(-not (Get-Process -Id ([int]$entry.Pid) -ErrorAction SilentlyContinue)){continue}
        throw 'Cannot verify the recorded server process; no unrelated process was stopped.'
    }
    if($owned.StartTime.ToUniversalTime().Ticks.ToString() -ne $entry.StartTicks -or $details.ExecutablePath -ne $entry.Executable -or -not $details.CommandLine.Contains($serverMarker)){
        throw 'Server identity changed. No unrelated process was stopped.'
    }
    Stop-Process -Id $owned.Id -ErrorAction Stop
    $owned.WaitForExit(5000) | Out-Null
}
& $launcher

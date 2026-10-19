param(
    [string]$Payload = (Join-Path $PSScriptRoot '..\dist\windows-0.3.0\shenqi-waimai-windows-x64.zip'),
    [string]$Output = (Join-Path $PSScriptRoot '..\dist\windows-0.3.1')
)
$ErrorActionPreference = 'Stop'
$expected = '1a6b3bed12e1e008290fbaf0114e52d1045aee88b41316a04f6c385903c725ba'
if ((Get-FileHash -LiteralPath $Payload -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) {
    throw 'Payload checksum mismatch. Use the reviewed v0.3.0 portable package.'
}
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
New-Item -ItemType Directory -Path $Output -Force | Out-Null
$destination = Join-Path $Output 'Shenqi-Waimai-Setup.exe'
& $compiler /nologo /target:winexe /platform:x64 /optimize+ "/out:$destination" `
    /reference:System.Windows.Forms.dll /reference:System.Drawing.dll `
    /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll `
    /reference:System.Web.Extensions.dll /reference:Microsoft.CSharp.dll `
    "/resource:$Payload,Shenqi.Payload" (Join-Path $PSScriptRoot 'Setup.cs')
if ($LASTEXITCODE -ne 0) { throw 'C# compilation failed.' }
$digest = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -LiteralPath (Join-Path $Output 'SHA256SUMS.txt') -Value "$digest  Shenqi-Waimai-Setup.exe" -Encoding ascii
Get-Item -LiteralPath $destination | Select-Object FullName, Length

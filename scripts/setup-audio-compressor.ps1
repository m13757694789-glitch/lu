$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$toolsRoot = Join-Path $projectRoot '.tools\audio'
$archive = Join-Path $toolsRoot 'ffmpeg-9.0.2-essentials_build.zip'
$expectedHash = '60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba'
$binary = Join-Path $toolsRoot 'ffmpeg-9.0.2-essentials_build\bin\ffmpeg.exe'
if (Test-Path -LiteralPath $binary) { Write-Host '压缩组件已就绪。'; exit 0 }
[void][System.IO.Directory]::CreateDirectory($toolsRoot)
Write-Host '正在下载 FFmpeg 便携组件（约 109 MB），仅安装到本项目。'
Write-Host '来源：FFmpeg 官网推荐的 gyan.dev Windows 构建。'
try {
  $valid = (Test-Path -LiteralPath $archive) -and ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -eq $expectedHash)
  if (!$valid) {
    & curl.exe --fail --location --connect-timeout 20 --max-time 300 --retry 1 --output $archive 'https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/ffmpeg-9.0.2-essentials_build.zip'
    if ($LASTEXITCODE -ne 0) {
      & curl.exe --fail --location --connect-timeout 20 --max-time 600 --retry 1 --output $archive 'https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-9.0.2-essentials_build.zip'
      if ($LASTEXITCODE -ne 0) { throw '组件下载失败，请稍后重试。' }
    }
  }
  if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $expectedHash) { throw '组件校验失败，未执行下载文件。' }
  Expand-Archive -LiteralPath $archive -DestinationPath $toolsRoot -Force
  if (!(Test-Path -LiteralPath $binary)) { throw '组件解压后未找到压缩程序。' }
  Write-Host '安装完成。现在可以双击“课堂录音批量压缩.cmd”。'
} catch { Write-Host ('安装未完成：' + $_.Exception.Message); exit 1 }

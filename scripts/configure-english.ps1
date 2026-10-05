param(
    [Parameter(Mandatory=$true)][string]$Python,
    [Parameter(Mandatory=$true)][string]$FFmpeg,
    [Parameter(Mandatory=$true)][string]$FFprobe,
    [Parameter(Mandatory=$true)][string]$WhisperModel
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
foreach ($item in @($Python, $FFmpeg, $FFprobe, $WhisperModel)) {
    if (-not (Test-Path -LiteralPath $item)) { throw "Path does not exist: $item" }
}
if (-not (Test-Path -LiteralPath (Join-Path $WhisperModel 'model.bin'))) {
    throw 'Use an already downloaded multilingual faster-whisper model folder containing model.bin.'
}
$runtimeDir = Join-Path $projectRoot '.runtime'
New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
$config = @{
    python = (Resolve-Path -LiteralPath $Python).Path
    ffmpeg = (Resolve-Path -LiteralPath $FFmpeg).Path
    ffprobe = (Resolve-Path -LiteralPath $FFprobe).Path
    whisperModel = (Resolve-Path -LiteralPath $WhisperModel).Path
}
$encoding = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path $runtimeDir 'config.json'), ($config | ConvertTo-Json), $encoding)
Write-Output 'Saved local configuration to .runtime/config.json. Restart CineCut to apply it.'

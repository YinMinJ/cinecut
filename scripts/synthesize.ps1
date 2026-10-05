param(
    [string]$Request,
    [switch]$Check
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
    Add-Type -AssemblyName System.Speech
    $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
    try {
        $voices = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.TwoLetterISOLanguageName -eq 'en' })
        if ($voices.Count -eq 0) { throw 'No English Windows speech voice is installed. Install an English speech voice in Windows Settings.' }
        $selected = $voices[0].VoiceInfo.Name
        $synth.SelectVoice($selected)
        $synth.Rate = 0
        $synth.Volume = 100
        if ($Check) {
            @{ ready = $true; voice = $selected } | ConvertTo-Json -Compress
        } else {
            if (-not $Request) { throw 'A JSON request file is required.' }
            $job = Get-Content -LiteralPath $Request -Raw -Encoding UTF8 | ConvertFrom-Json
            $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(48000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
            foreach ($item in $job.items) {
                if ([string]::IsNullOrWhiteSpace($item.text)) { throw 'Cannot synthesize an empty caption.' }
                $synth.SetOutputToWaveFile([string]$item.file, $format)
                $synth.Speak([string]$item.text)
                $synth.SetOutputToNull()
            }
            @{ ready = $true; voice = $selected; count = @($job.items).Count } | ConvertTo-Json -Compress
        }
    } finally { $synth.Dispose() }
} catch {
    @{ ready = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
    exit 1
}

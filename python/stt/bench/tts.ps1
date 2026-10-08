# Synthesize test utterances with Windows SAPI (System.Speech) as 16 kHz mono
# 16-bit PCM WAV files. Used by tests/test_service.py and bench/benchmark.py.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tts.ps1 -OutDir <dir> -Phrases <phrases.json> [-Rate 0]
#
# phrases.json: [{ "id": "undo", "text": "undo" }, ...]  ->  <OutDir>/<id>.wav
param(
  [Parameter(Mandatory = $true)][string]$OutDir,
  [Parameter(Mandatory = $true)][string]$Phrases,
  [int]$Rate = 0
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$items = Get-Content -Raw -Path $Phrases | ConvertFrom-Json
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
foreach ($item in $items) {
  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
  try {
    $synth.Rate = $Rate
    $path = Join-Path $OutDir ($item.id + '.wav')
    $synth.SetOutputToWaveFile($path, $fmt)
    $synth.Speak([string]$item.text)
  } finally {
    $synth.Dispose()
  }
  Write-Output $path
}

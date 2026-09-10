# Is the "(optional)" ComfyUI path optional?
#
# The setup wizard labels every field "(optional)" — "Fill in the paths you use,
# or skip any you don't need." `main-modular.js:155` then does
#
#     if (!config.comfyUIPath) { return { needsSetup: true }; }
#
# A Kohya-only user, or the Blender-only user WO-G5's whole no-AI plugin market
# is built around, would fill in what they use, skip what they don't, and land
# back on the wizard with no explanation.
#
# VERIFY BY SIDE EFFECT, WITH A CONTROL. Rather than clicking the wizard, the
# config it would have written is placed on disk and the app is started on it.
# The observable is what `get-state` returns for `needsSetup`.
#
#   kohya-only   config has trainingOutputDir, no comfyUIPath  → the finding
#   CONTROL      the SAME config plus a real comfyUIPath        → must be false,
#                or the difference is not the ComfyUI path and this proves
#                nothing
#
# Both paths given exist on this machine, so neither run can fail on a missing
# directory instead of on the thing under test.

param([string]$OutDir = "C:\SCRUPLEWORK\g3\.run\g3")

$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$REAL_COMFY = "C:\SCRUPLEWORK\comfyui"
$REAL_TRAIN = "C:\SCRUPLEWORK\.scratch"

function Run-Case($label, $config) {
    $home_ = "C:\SCRUPLEWORK\.scratch\g3-home-$label"
    if (Test-Path $home_) { Remove-Item -Recurse -Force $home_ }
    New-Item -ItemType Directory -Force -Path (Join-Path $home_ "config") | Out-Null

    # WriteAllText, not Out-File: PowerShell 5.1 writes a UTF-8 BOM and
    # JSON.parse rejects it, which would fail the run for the wrong reason.
    [System.IO.File]::WriteAllText(
        (Join-Path $home_ "config\scruple_studio.json"),
        ($config | ConvertTo-Json -Depth 5)
    )

    $env:SCRUPLE_HOME = $home_
    Remove-Item Env:\SCRUPLE_WITNESS_URL -ErrorAction SilentlyContinue
    Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

    $log = Join-Path $OutDir "optional-$label.log"
    $p = Start-Process -FilePath "C:\SCRUPLEWORK\g3\node_modules\electron\dist\electron.exe" `
        -ArgumentList "." -WorkingDirectory "C:\SCRUPLEWORK\g3" `
        -RedirectStandardOutput $log -RedirectStandardError "$log.err" -PassThru

    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Seconds 1
        if ((Test-Path $log) -and (Select-String -Path $log -Pattern 'get-state returning' -Quiet)) { break }
        if ($p.HasExited) { break }
    }
    if (-not $p.HasExited) { & taskkill /PID $p.Id /T /F 2>&1 | Out-Null }

    $line = (Select-String -Path $log -Pattern 'get-state returning' | Select-Object -First 1).Line
    $needs = if ($line -match 'needsSetup:\s*(\w+)') { $matches[1] } else { 'NOT REPORTED' }
    $first = (Select-String -Path $log -Pattern 'First run detected|ComfyUI path no longer' | Select-Object -First 1).Line
    return [PSCustomObject]@{ label = $label; needsSetup = $needs; note = $first; config = ($config.Keys -join ',') }
}

$kohyaOnly = Run-Case "kohya-only" @{ trainingOutputDir = $REAL_TRAIN; comfyUIEnabled = $false }
$control   = Run-Case "control"    @{ trainingOutputDir = $REAL_TRAIN; comfyUIPath = $REAL_COMFY }

Write-Output ""
Write-Output ("{0,-12} needsSetup={1,-12} keys={2}" -f $kohyaOnly.label, $kohyaOnly.needsSetup, $kohyaOnly.config)
if ($kohyaOnly.note) { Write-Output ("             app said: {0}" -f $kohyaOnly.note.Trim()) }
Write-Output ("{0,-12} needsSetup={1,-12} keys={2}   <- CONTROL" -f $control.label, $control.needsSetup, $control.config)
if ($control.note) { Write-Output ("             app said: {0}" -f $control.note.Trim()) }

Write-Output ""
if ($control.needsSetup -ne 'false') {
    Write-Output "INCONCLUSIVE - the control did not clear setup either, so the kohya-only"
    Write-Output "result cannot be attributed to the missing ComfyUI path."
    exit 2
}
if ($kohyaOnly.needsSetup -eq 'true') {
    Write-Output "FINDING - a config with everything EXCEPT comfyUIPath is held at the setup"
    Write-Output "wizard, which labels that field '(optional)'. Adding only comfyUIPath clears"
    Write-Output "it, so the field is mandatory in fact and optional in the interface."
} else {
    Write-Output "No finding: the app cleared setup without a ComfyUI path."
}

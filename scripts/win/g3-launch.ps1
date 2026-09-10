# WO-G3 — open the app the way a person does, and watch what it touches.
#
# `electron .`, a fresh SCRUPLE_HOME so there are no wallets, a screenshot of
# the REAL window off the REAL framebuffer, and — the part that is not optional
# — a running measurement of whether the process reaches the Oracle host.
#
# 🔴 WHY THE MEASUREMENT. app-legacy still names 129.80.23.93 on four ports with
# no resolver and no refusal: :5001 (IPFS API — a WRITE surface, POST
# /api/v0/add), :1984 (Arweave, including /mint/<addr>/<amount>), :8080 (IPFS
# gateway) and :443 (ElectrumX). WO-G1 routed the witness (:5799) through
# config/witness-endpoint.js and left these. Static reading says none of them
# fire at startup without a wallet — `rvn-wallet-status` only fetches a balance
# when the wallet is unlocked, `arweave-get-status` returns early with no
# address — but "I read the code" is not the standard this project uses.
#
#   powershell -File g3-launch.ps1 -Seconds 25

param(
    [int]$Seconds = 25,
    [string]$Home_ = "C:\SCRUPLEWORK\.scratch\g3-home",
    [string]$OutDir = "C:\SCRUPLEWORK\g3\.run\g3"
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
if (Test-Path $Home_) { Remove-Item -Recurse -Force $Home_ }
New-Item -ItemType Directory -Force -Path $Home_ | Out-Null

# The hosts that must not be contacted. 129.80.23.93 is the Oracle VM.
$FORBIDDEN = @('129.80.23.93')

function ForeignHits($pids) {
    $rows = @()
    $out = & netstat -ano -p TCP 2>$null
    foreach ($line in $out) {
        $f = ($line.Trim() -split '\s+')
        if ($f.Count -lt 5 -or $f[0] -ne 'TCP') { continue }
        $owner = $f[$f.Count - 1]
        if ($pids -notcontains $owner) { continue }
        foreach ($h in $FORBIDDEN) {
            if ($f[2] -like "$h*") { $rows += "pid=$owner -> $($f[2]) [$($f[3])]" }
        }
    }
    return $rows
}

function TreePids($root) {
    $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
    $set = @{ "$root" = $true }
    for ($i = 0; $i -lt 6; $i++) {
        foreach ($p in $all) {
            if ($set.ContainsKey("$($p.ParentProcessId)")) { $set["$($p.ProcessId)"] = $true }
        }
    }
    return $set.Keys
}

$env:SCRUPLE_HOME = $Home_
# Left unset on purpose: config/witness-endpoint.js then resolves the CVM
# surrogate at 127.0.0.1:8799, which is not running here, so the app is simply
# witness-offline. That is the honest state for a rig and is not a failure.
Remove-Item Env:\SCRUPLE_WITNESS_URL -ErrorAction SilentlyContinue
Remove-Item Env:\SCRUPLE_ALLOW_PRODUCTION_WITNESS -ErrorAction SilentlyContinue
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$log = Join-Path $OutDir "app.log"
$proc = Start-Process -FilePath "C:\SCRUPLEWORK\g3\node_modules\electron\dist\electron.exe" `
    -ArgumentList "." -WorkingDirectory "C:\SCRUPLEWORK\g3" `
    -RedirectStandardOutput $log -RedirectStandardError "$log.err" -PassThru

Write-Output "launched pid=$($proc.Id), SCRUPLE_HOME=$Home_"

$hits = @()
for ($i = 0; $i -lt $Seconds; $i++) {
    Start-Sleep -Seconds 1
    if ($proc.HasExited) { Write-Output "process exited early after $i s (code $($proc.ExitCode))"; break }
    $hits += ForeignHits (TreePids $proc.Id)
}

# The screenshot, off the real framebuffer, as a PNG a person can look at.
$shot = Join-Path $OutDir "g3-app.png"
if (-not $proc.HasExited) {
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
    $g.Dispose()
    $bmp.Save($shot, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Output "screenshot: $shot"
}

$hits = $hits | Sort-Object -Unique
Write-Output ""
if ($hits.Count -gt 0) {
    Write-Output "FORBIDDEN CONTACT OBSERVED:"
    $hits | ForEach-Object { Write-Output "   $_" }
} else {
    Write-Output "no connection to $($FORBIDDEN -join ', ') observed while the app was up"
}

Write-Output ""
Write-Output "==== what the app said ===="
if (Test-Path $log) { Get-Content $log -Tail 40 }
if ((Test-Path "$log.err") -and (Get-Item "$log.err").Length -gt 0) {
    Write-Output "---- stderr ----"
    Get-Content "$log.err" -Tail 20
}

if (-not $proc.HasExited) {
    & taskkill /PID $proc.Id /T /F 2>&1 | Out-Null
    Write-Output ""
    Write-Output "closed."
}

# What the app created in its home, which is what a person would find afterwards.
Write-Output ""
Write-Output "==== SCRUPLE_HOME afterwards ===="
Get-ChildItem $Home_ -Recurse -File -ErrorAction SilentlyContinue |
    ForEach-Object { Write-Output ("   {0}  {1} bytes" -f $_.FullName.Substring($Home_.Length + 1), $_.Length) }

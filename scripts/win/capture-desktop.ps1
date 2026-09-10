# Capture the real desktop framebuffer to RAW BGRA bytes (never a PNG).
#
# The question this answers is whether this rig has a live framebuffer at all --
# the single thing it has that the Linux build box does not. Encoding to PNG
# first would put an image codec between the framebuffer and the measurement,
# and the codec is not what is under test.
#
# Emits <out>.raw plus <out>.json describing it, for scripts/win/blank-detector.mjs.

param(
    [Parameter(Mandatory = $true)][string]$Out,
    [string]$Label = "desktop"
)

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$gfx = [System.Drawing.Graphics]::FromImage($bmp)
$gfx.CopyFromScreen($screen.X, $screen.Y, 0, 0, $bmp.Size, [System.Drawing.CopyPixelOperation]::SourceCopy)
$gfx.Dispose()

$rect = New-Object System.Drawing.Rectangle(0, 0, $bmp.Width, $bmp.Height)
$data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$bytes = New-Object byte[] ($data.Stride * $bmp.Height)
[System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
$bmp.UnlockBits($data)

[System.IO.File]::WriteAllBytes("$Out.raw", $bytes)

# Session state recorded WITH the capture: a frame is only interpretable
# alongside whether the display was on and whether the session was locked.
$meta = [ordered]@{
    label        = $Label
    capturedAt   = (Get-Date).ToString("o")
    width        = $bmp.Width
    height       = $bmp.Height
    channels     = 4
    stride       = $data.Stride
    bytes        = $bytes.Length
    source       = "System.Drawing.Graphics.CopyFromScreen (primary screen)"
    machine      = $env:COMPUTERNAME
    sessionName  = $env:SESSIONNAME
}
# ⚑ NOT Out-File -Encoding utf8. On Windows PowerShell 5.1 that writes UTF-8
# WITH A BOM, and Node's JSON.parse rejects a leading U+FEFF outright
# ("Unexpected token"). UTF8Encoding($false) is a BOM-less writer.
$json = $meta | ConvertTo-Json
[System.IO.File]::WriteAllText("$Out.json", $json, (New-Object System.Text.UTF8Encoding($false)))

$w = $bmp.Width; $h = $bmp.Height
$bmp.Dispose()
Write-Output "captured $Label -> $Out.raw (${w}x${h}, $($bytes.Length) bytes)"

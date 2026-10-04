# sync.ps1 — copy the editable working mirror to the canonical project folder.
#
# The dashboard project lives on the ZimaOS share:
#   \\zimaserver\ZimaOS-HD\AppData\Projects\agent-manager
# It is authored in the local mirror and pushed here, because the share is where
# the kilo CLI and the user run the app from.
#
#   .\sync.ps1            push mirror -> share
#   .\sync.ps1 -Pull      pull share -> mirror

param([switch]$Pull)

$mirror = "C:\Users\brgjr\AppData\Projects\agent-manager"
$share = "\\zimaserver\ZimaOS-HD\AppData\Projects\agent-manager"

# individual files (flat, no folder)
$files = @("collector.mjs", "serve.mjs", "index.html", "README.md", "sync.ps1", "chat.mjs", "workspace.mjs", "kilo-bin.mjs")

# folders that should be copied recursively as a whole
$folders = @("assets")

if ($Pull) {
  $from = $share
  $to = $mirror
  $label = "share -> mirror"
} else {
  $from = $mirror
  $to = $share
  $label = "mirror -> share"
}

if (-not (Test-Path -LiteralPath $to)) {
  New-Item -ItemType Directory -Path $to -Force | Out-Null
}

Write-Host ("{0,-16} {1}" -f "FILE", "STATUS")
Write-Host ("{0,-16} {1}" -f "----", "------")

foreach ($f in $files) {
  $p = Join-Path $from $f
  if (-not (Test-Path -LiteralPath $p)) {
    Write-Host ("{0,-16} skipped (not in {1})" -f $f, $from)
    continue
  }
  Copy-Item -LiteralPath $p -Destination (Join-Path $to $f) -Force
  $dest = Join-Path $to $f
  $mtime = (Get-Item -LiteralPath $dest).LastWriteTime.ToString("yyyy-MM-dd HH:mm:ss")
  Write-Host ("{0,-16} ok ({1})" -f $f, $mtime)
}

foreach ($d in $folders) {
  $fromDir = Join-Path $from $d
  $toDir = Join-Path $to $d
  if (-not (Test-Path -LiteralPath $fromDir)) {
    Write-Host ("{0,-16} skipped (not in {1})" -f $d, $from)
    continue
  }
  if (-not (Test-Path -LiteralPath $toDir)) {
    New-Item -ItemType Directory -Path $toDir -Force | Out-Null
  }
  $count = 0
  Get-ChildItem -LiteralPath $fromDir -File -Recurse | ForEach-Object {
    $rel = $_.FullName.Substring($fromDir.Length + 1)
    $dest = Join-Path $toDir $rel
    $destDir = Split-Path -Parent $dest
    if (-not (Test-Path -LiteralPath $destDir)) {
      New-Item -ItemType Directory -Path $destDir -Force | Out-Null
    }
    Copy-Item -LiteralPath $_.FullName -Destination $dest -Force
    $count++
  }
  Write-Host ("{0,-16} ok ({1} files)" -f $d, $count)
}

Write-Host ("done. {0}" -f $label)
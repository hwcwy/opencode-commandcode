# Copy the Command Code plugin into the global OpenCode plugin directory.
# OpenCode watches that directory and reloads the plugin automatically.
$ErrorActionPreference = "Stop"

$source = Join-Path $PSScriptRoot "commandcode.ts"
if (-not (Test-Path $source)) {
    throw "Not found: $source"
}

$targetDir = Join-Path $env:USERPROFILE ".config\opencode\plugins"
$target = Join-Path $targetDir "commandcode.ts"

New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
Copy-Item -Path $source -Destination $target -Force

$sourceHash = (Get-FileHash $source).Hash
$targetHash = (Get-FileHash $target).Hash
Write-Host "Installed: $target"
Write-Host "SHA256:    $sourceHash"
if ($sourceHash -ne $targetHash) {
    throw "Copy verification failed"
}
Write-Host "OK - OpenCode will hot-reload the plugin."

# Update AStack in a project through the update pipeline, from the git repository.
# Usage: .\update.ps1 [project-dir] [pipeline flags]   (default: current directory)
param([string]$Target = (Get-Location).Path, [Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest = @())
$ErrorActionPreference = 'Stop'
$core = if ($env:ASTACK_CORE) { $env:ASTACK_CORE } else { Join-Path $HOME '.astack\core' }
$source = if ($env:ASTACK_SOURCE) { $env:ASTACK_SOURCE } else { 'https://github.com/ARaminco/AStack.git' }
if (Test-Path (Join-Path $core '.git')) {
  git -C $core fetch --depth 1 --quiet origin main
  if ($LASTEXITCODE -ne 0) { throw 'git fetch failed' }
  git -C $core checkout --quiet --force --detach FETCH_HEAD
} else {
  git clone --depth 1 --quiet $source $core
}
if ($LASTEXITCODE -ne 0) { throw 'git failed' }
node (Join-Path $core 'bin\astack.mjs') update --target $Target @Rest

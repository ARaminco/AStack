# Install or update AStack in a project and set everything up for Claude Code
# and Codex. Usage: .\install.ps1 [project-dir]   (default: current directory)
param([string]$Target = (Get-Location).Path)
$ErrorActionPreference = 'Stop'
$core = if ($env:ASTACK_CORE) { $env:ASTACK_CORE } else { Join-Path $HOME '.astack\core' }
$source = if ($env:ASTACK_SOURCE) { $env:ASTACK_SOURCE } else { 'https://github.com/ARaminco/AStack.git' }
if (Test-Path (Join-Path $core '.git')) {
  git -C $core pull --ff-only --quiet
} else {
  git clone --depth 1 --quiet $source $core
}
if ($LASTEXITCODE -ne 0) { throw 'git failed' }
node (Join-Path $core 'bin\astack.mjs') setup --target $Target

# Windows 构建入口（build.cmd 调用）：不依赖终端 PATH，自动探测 Node。
# 用法：双击 build.cmd 或运行 `powershell -File scripts\build.ps1`

$ErrorActionPreference = "Stop"

function Find-Node {
    $candidate = Get-Command node -ErrorAction SilentlyContinue
    if ($candidate) { return $candidate.Source }
    $paths = @(
        "$env:ProgramFiles\nodejs\node.exe",
        "${env:ProgramFiles(x86)}\nodejs\node.exe",
        "$env:LOCALAPPDATA\Programs\nodejs\node.exe",
        "$env:APPDATA\nvm\node.exe",
        "$env:APPDATA\nvm\node64.exe",
        "C:\Program Files\nodejs\node.exe"
    )
    foreach ($p in $paths) {
        if (Test-Path $p) { return $p }
    }
    return $null
}

$node = Find-Node
if (-not $node) {
    Write-Host "[build] 未找到 Node.js，请先安装 Node.js >= 20（https://nodejs.org）" -ForegroundColor Red
    exit 1
}

# 把 node 目录加入 PATH，使 npm/npx 可用
$nodeDir = Split-Path -Parent $node
$env:PATH = "$nodeDir;" + $env:PATH

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host "[build] node: $node"
& node --version

if (-not (Test-Path (Join-Path $root "node_modules"))) {
    Write-Host "[build] 首次构建：安装依赖…"
    & npm install
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

Write-Host "[build] 构建插件产物…"
& npm run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "[build] 完成。产物：index.js / tools/*.js / routes/*.js"
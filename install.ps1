# 安装两个插件：复制文件 + 把 DSH 的 profile 清单补上（不再需要手工改 json）
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -DshProfile "C:\Users\me\.dsh\profiles\desktop" -AstrbotPlugins "D:\AstrBot\data\plugins"
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -DryRun     # 只看会改什么
#
# 装完还需要：重载/重启 DSH 与 AstrBot。

param(
    [string]$DshProfile = "$env:USERPROFILE\.dsh\profiles\desktop",
    [string]$AstrbotPlugins = "",
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$utf8 = New-Object System.Text.UTF8Encoding($false)

function 说($文本, $颜色 = 'Gray') { Write-Host $文本 -ForegroundColor $颜色 }

# ---------------- DSH 侧 ----------------
$dshSrc = Join-Path $here 'dsh-astrbot-bridge'
$dshDst = Join-Path $DshProfile 'node_modules\dsh-astrbot-bridge'
if (-not (Test-Path $DshProfile)) { throw "找不到 DSH profile：$DshProfile" }

if (-not $DryRun) {
    New-Item -ItemType Directory -Force -Path (Join-Path $dshDst 'lib') | Out-Null
    Copy-Item (Join-Path $dshSrc 'package.json') $dshDst -Force
    Copy-Item (Join-Path $dshSrc 'cordis.patch.yml') $dshDst -Force
    Copy-Item (Join-Path $dshSrc 'lib\host.js') (Join-Path $dshDst 'lib') -Force
    Copy-Item (Join-Path $dshSrc 'README.md') $dshDst -Force
    Copy-Item (Join-Path $dshSrc 'smoke.ps1') $dshDst -Force
}
说 "DSH 插件 -> $dshDst" Green

# ---- 补 profile 清单：dependencies + dsh.profile.bundles ----
$pkgPath = Join-Path $DshProfile 'package.json'
if (-not (Test-Path $pkgPath)) { throw "找不到 $pkgPath" }

$raw = [System.IO.File]::ReadAllText($pkgPath)
try { $pkg = $raw | ConvertFrom-Json } catch { throw "profile 的 package.json 不是合法 JSON，先手动修好再来：$pkgPath" }

$depSpec = "file:" + ($dshSrc -replace '\\', '/')
$改了 = @()

if (-not $pkg.dependencies.PSObject.Properties.Name.Contains('dsh-astrbot-bridge')) {
    改了 += "dependencies += dsh-astrbot-bridge ($depSpec)"
    if (-not $DryRun) { $pkg.dependencies | Add-Member -NotePropertyName 'dsh-astrbot-bridge' -NotePropertyValue $depSpec -Force }
}

$bundles = @($pkg.dsh.profile.bundles)
if ($bundles -notcontains 'dsh-astrbot-bridge') {
    改了 += "dsh.profile.bundles += dsh-astrbot-bridge"
    if (-not $DryRun) { $pkg.dsh.profile.bundles = @($bundles + 'dsh-astrbot-bridge') }
}

if ($改了.Count -eq 0) {
    说 "profile 清单已经是好的（无需改动）" Green
} else {
    $改了 | ForEach-Object { 说 "  · $_" Yellow }
    if ($DryRun) {
        说 "DryRun：以上改动没有落盘" Cyan
    } else {
        $bak = "$pkgPath.bak-" + (Get-Date -Format 'yyyyMMdd-HHmmss')
        Copy-Item $pkgPath $bak -Force
        [System.IO.File]::WriteAllText($pkgPath, ($pkg | ConvertTo-Json -Depth 20), $utf8)
        说 "已写入 $pkgPath（备份：$bak）" Green
    }
}

# ---------------- AstrBot 侧 ----------------
if ([string]::IsNullOrWhiteSpace($AstrbotPlugins)) {
    说 "AstrBot 侧跳过：没给 -AstrbotPlugins（一般形如 <实例>\core\data\plugins）" Yellow
} else {
    if (-not (Test-Path $AstrbotPlugins)) { throw "找不到 AstrBot 插件目录：$AstrbotPlugins" }
    $abDst = Join-Path $AstrbotPlugins 'astrbot_dsh_bridge'
    if (-not $DryRun) {
        New-Item -ItemType Directory -Force -Path $abDst | Out-Null
        Copy-Item (Join-Path $here 'astrbot_dsh_bridge\main.py') $abDst -Force
        Copy-Item (Join-Path $here 'astrbot_dsh_bridge\metadata.yaml') $abDst -Force
        Copy-Item (Join-Path $here 'astrbot_dsh_bridge\_conf_schema.json') $abDst -Force
        Copy-Item (Join-Path $here 'astrbot_dsh_bridge\README.md') $abDst -Force
        Remove-Item (Join-Path $abDst '__pycache__') -Recurse -Force -ErrorAction SilentlyContinue
    }
    说 "AstrBot 插件 -> $abDst" Green
}

说 ""
说 "下一步：" Cyan
说 "  1) 重启 DSH（新 bundle 要重新组合才会加载）"
说 "  2) 重载或重启 AstrBot"
说 "  3) 打开 AstrBot 插件配置页：填「聊天 → DSH 会话」绑定并保存（会自动推给 DSH）"
说 "  4) 聊天里发 /dsh 看自检报告"

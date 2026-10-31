# -*- coding: utf-8 -*-
# M1 冒烟测试：只测 DSH 这一侧的接口，不需要 AstrBot
# 用法：powershell -ExecutionPolicy Bypass -File D:\ai\dsh-astrbot-bridge\smoke.ps1
# 需要 DSH 正在运行，且 dsh-astrbot-bridge 插件已启用

$ErrorActionPreference = 'Stop'
$结果 = @()

function 记($名, $通过, $说明) {
    $script:结果 += [pscustomobject]@{ 测试 = $名; 结果 = if ($通过) { 'PASS' } else { 'FAIL' }; 说明 = $说明 }
    $颜色 = if ($通过) { 'Green' } else { 'Red' }
    Write-Host ("[{0}] {1}  {2}" -f $(if ($通过) { 'PASS' } else { 'FAIL' }), $名, $说明) -ForegroundColor $颜色
}

function 状态码($块) {
    try { & $块; return 200 } catch {
        $r = $_.Exception.Response
        if ($r) { return [int]$r.StatusCode }
        throw
    }
}

# ---------- 读入口与令牌 ----------
$home_ = $env:USERPROFILE + '\.dsh'
$端点 = Join-Path $home_ 'astrbot-bridge-endpoint.json'
$配置 = Join-Path $home_ 'astrbot-bridge-config.json'
if (-not (Test-Path $端点)) { throw "找不到 $端点 —— 插件没启动或没写过入口文件" }
if (-not (Test-Path $配置)) { throw "找不到 $配置" }

$origin = ([System.IO.File]::ReadAllText($端点) | ConvertFrom-Json).origin
$cfg = [System.IO.File]::ReadAllText($配置) | ConvertFrom-Json
$token = $cfg.token
$h = @{ Authorization = "Bearer $token" }
$json = 'application/json; charset=utf-8'

Write-Host "入口：$origin" -ForegroundColor Cyan
Write-Host "令牌：$($token.Substring(0,8))…" -ForegroundColor Cyan

# ---------- 1. 健康检查 ----------
try {
    $s = Invoke-RestMethod "$origin/astrbot-bridge/api/health" -TimeoutSec 8
    记 'health 可访问' $true "version=$($s.version) bindings=$($s.bindings)"
} catch {
    记 'health 可访问' $false $_.Exception.Message
    $结果 | Format-Table -AutoSize
    exit 1
}

# ---------- 2. 鉴权：错令牌应 401 ----------
$坏 = @{ Authorization = 'Bearer wrong-token' }
$码 = 状态码 { Invoke-RestMethod "$origin/astrbot-bridge/api/state" -Headers $坏 -TimeoutSec 8 | Out-Null }
记 '错令牌被拒' ($码 -eq 401) "HTTP $码（期望 401）"

# ---------- 3. 未绑定的 key 应 404 ----------
$体 = @{ key = 'test:未绑定'; text = '你好' } | ConvertTo-Json
$码 = 状态码 { Invoke-RestMethod "$origin/astrbot-bridge/api/turn" -Method Post -Headers $h -Body ([Text.Encoding]::UTF8.GetBytes($体)) -ContentType $json -TimeoutSec 15 | Out-Null }
记 '未绑定 key 被拒' ($码 -eq 404) "HTTP $码（期望 404）"

# ---------- 4. 新建会话 ----------
try {
    $n = Invoke-RestMethod "$origin/astrbot-bridge/api/new-session" -Method Post -Headers $h -Body '{"cwd":"D:\\ai"}' -ContentType 'application/json' -TimeoutSec 25
    记 'new-session' ($n.ok -eq $true -and $n.id) "id=$($n.id) 模型=$($n.model.provider)/$($n.model.model)"
    $会话 = $n.id
} catch {
    记 'new-session' $false $_.Exception.Message
    $结果 | Format-Table -AutoSize
    exit 1
}

# ---------- 5. 绑定 ----------
try {
    $b = @{ key = 'test:smoke'; session = $会话; label = '冒烟测试' } | ConvertTo-Json
    Invoke-RestMethod "$origin/astrbot-bridge/api/bind" -Method Post -Headers $h -Body ([Text.Encoding]::UTF8.GetBytes($b)) -ContentType $json -TimeoutSec 10 | Out-Null
    记 'bind' $true "test:smoke → $会话"
} catch {
    记 'bind' $false $_.Exception.Message
}

# ---------- 6. 跑一轮 ----------
$起 = Get-Date
try {
    $体 = @{ key = 'test:smoke'; text = '只回一句：桥通了。'; replyTimeoutMs = 40000 } | ConvertTo-Json
    $r = Invoke-RestMethod "$origin/astrbot-bridge/api/turn" -Method Post -Headers $h -Body ([Text.Encoding]::UTF8.GetBytes($体)) -ContentType $json -TimeoutSec 60
    记 '跑一轮' ($r.ok -and $r.reason -eq 'completed' -and $r.text) "「$($r.text)」 turn=$($r.turn) $($r.durationMs)ms"
} catch {
    记 '跑一轮' $false $_.Exception.Message
}

# ---------- 7. 会话历史确实落盘 ----------
try {
    $rs = Invoke-RestMethod "$origin/astrbot-bridge/api/sessions" -Headers $h -TimeoutSec 10
    $找到 = $rs.sessions | Where-Object { $_.id -eq $会话 }
    记 '会话仍在活动列表里' ([bool]$找到) "已绑定=$($找到.已绑定)"
} catch {
    记 '会话仍在活动列表里' $false $_.Exception.Message
}

# ---------- 收尾：解绑（会话留着，进程重启会自动释放） ----------
try {
    Invoke-RestMethod "$origin/astrbot-bridge/api/unbind" -Method Post -Headers $h -Body ([Text.Encoding]::UTF8.GetBytes('{"key":"test:smoke"}')) -ContentType $json -TimeoutSec 10 | Out-Null
} catch {}

Write-Host ""
$结果 | Format-Table -AutoSize
$失败 = ($结果 | Where-Object { $_.结果 -eq 'FAIL' }).Count
Write-Host ("共 {0} 项，失败 {1} 项" -f $结果.Count, $失败) -ForegroundColor $(if ($失败 -eq 0) { 'Green' } else { 'Red' })
exit $失败

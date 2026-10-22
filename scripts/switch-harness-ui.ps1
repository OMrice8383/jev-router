# デスクトップの3択小窓：Jev に渡す候補集合を切り替えるだけ。
# harness-mode.cjs を呼ぶのが唯一の外部操作。モデル固定・残枠表示・設定は持たない。
# -Mock では CLI を呼ばず、指定ファイルに呼び出しを記録する（局所検証用。実行では使わない）。
param(
    [switch]$Mock,
    [string]$MockLog,
    [string]$MockCurrent,
    [switch]$SelfTest
)
$ErrorActionPreference = 'Stop'

# 共有 mode 契約の固定3値。
$script:ModeMap = [ordered]@{
    'OpenCode Freeあり' = 'free-with-go'
    'OpenCode Go枠'     = 'go-only'
    'OpenCodeなし'      = 'none'
}

$script:Helper = Join-Path $PSScriptRoot 'harness-mode.cjs'
$script:LastReadback = $null
function Invoke-ModeCli([string]$Action, [string]$Value) {
    $arguments = @($script:Helper, $Action)
    if ($Value) { $arguments += $Value }
    $raw = & node @arguments
    $code = $LASTEXITCODE
    $script:LastReadback = ($raw -join "`n") | ConvertFrom-Json
    if ($script:LastReadback.logPath) { $script:logNote = "記録：$($script:LastReadback.logPath)" }
    if ($code -ne 0 -or -not $script:LastReadback.ok) {
        throw '一部または全部の操作が失敗しました。各台の結果を確認してください。'
    }
}
function ReadbackText {
    if (-not $script:LastReadback.machines) { return '結果を取得できませんでした（変更状態は不明）' }
    return (($script:LastReadback.machines | ForEach-Object {
        $state = if ($_.ok) { ModeLabel $_.mode } elseif ($_.changed -eq $true) { '保存済・再読失敗' } elseif ($null -eq $_.changed) { '通信失敗・変更不明' } else { '失敗' }
        '{0}={1}' -f $_.host, $state
    }) -join ' / ')
}

# ---- 単一 mode CLI との境 ----
function Get-CurrentModeValue {
    if ($Mock) {
        # mock：最後の set 記録か、起動時の指定値。
        if ($MockLog -and (Test-Path -LiteralPath $MockLog)) {
            $last = @(Get-Content -LiteralPath $MockLog -Encoding utf8 | Where-Object { $_ -match '^set ' } | Select-Object -Last 1)
            if ($last) { return ([string]$last[0]).Split(' ')[1] }
        }
        return $MockCurrent
    }
    Invoke-ModeCli 'get' ''
    $modes = @($script:LastReadback.machines | ForEach-Object { $_.mode } | Select-Object -Unique)
    if ($modes.Count -eq 1) { return $modes[0] }
    return $null
}
function Set-ModeValue([string]$Value) {
    if (@($script:ModeMap.Values) -notcontains $Value) { throw '候補集合の値が不正です' }
    if ($Mock) {
        if ($MockLog) {
            Add-Content -LiteralPath $MockLog -Value ("set {0} {1}" -f $Value, (Get-Date).ToUniversalTime().ToString('o')) -Encoding utf8
        }
        return $true
    }
    Invoke-ModeCli 'set' $Value
    return $true
}
function ModeLabel([string]$Value) {
    foreach ($entry in $script:ModeMap.GetEnumerator()) {
        if ($entry.Value -eq $Value) { return $entry.Key }
    }
    return $null
}

# ---- 自己検査：窓を出さずに3値の呼び出しと記録だけを確かめる（Mock 限定・実CLIには届かない） ----
if ($SelfTest) {
    $Mock = $true
    if (-not $MockLog) { $MockLog = Join-Path $env:TEMP ('switch-harness-ui-selftest-{0}.log' -f (Get-Random)) }
    $failures = 0
    foreach ($value in $script:ModeMap.Values) {
        try {
            $ok = Set-ModeValue $value
            if (-not $ok) { $failures++ }
        }
        catch { $failures++ }
    }
    $written = @(Get-Content -LiteralPath $MockLog -Encoding utf8 | Where-Object { $_ -match '^set ' })
    if (@($written).Count -ne $script:ModeMap.Count) { $failures++ }
    foreach ($value in $script:ModeMap.Values) {
        if (-not (ModeLabel $value)) { $failures++ }   # 値→ラベルが戻ること
    }
    # 不正値は拒否されること（enum固定・注入されない）。
    try { Set-ModeValue 'bogus; Remove-Item' | Out-Null; $failures++ } catch { }
    'SELFTEST_RESULT passed={0} failed={1} log={2}' -f ($script:ModeMap.Count + 2 - $failures), $failures, $MockLog
    if ($failures -eq 0) { exit 0 }
    exit 1
}

# ---- 小窓（WinForms・STA想定。ショートカットから -STA 付きで開く） ----
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

try { $current = Get-CurrentModeValue } catch { $current = $null }
$currentLabel = ModeLabel $current
$headline = if ($currentLabel) { '現在：{0}' -f $currentLabel } else { '現在：{0}' -f (ReadbackText) }

$form = New-Object System.Windows.Forms.Form
$form.Text = 'Jev 候補集合の切り替え'
$form.Size = [System.Drawing.Size]::new(620, 310)
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.StartPosition = 'CenterScreen'
# AcceptButton は button 作成後に設定する。

$label = New-Object System.Windows.Forms.Label
$label.Text = $headline
$label.Location = [System.Drawing.Point]::new(14, 12)
$label.Size = [System.Drawing.Size]::new(580, 22)
$form.Controls.Add($label)

$radioControls = @{}
$top = 42
foreach ($entry in $script:ModeMap.GetEnumerator()) {
    $radio = New-Object System.Windows.Forms.RadioButton
    $radio.Text = $entry.Key
    $radio.Location = [System.Drawing.Point]::new(18, $top)
    $radio.Size = [System.Drawing.Size]::new(370, 24)
    $radio.UseVisualStyleBackColor = $true
    $radio.TabStop = $true   # 未選択のままでも Tab で届く（WinForms の既定は選択中の1つしか止まらない）
    if ($entry.Value -eq $current) { $radio.Checked = $true }
    $form.Controls.Add($radio)
    $radioControls[$entry.Value] = $radio
    $top += 28
}

$button = New-Object System.Windows.Forms.Button
$button.Text = '切り替える'
$button.Location = [System.Drawing.Point]::new(18, $top + 8)
$button.Size = [System.Drawing.Size]::new(120, 30)
$form.Controls.Add($button)
$form.AcceptButton = $button

$result = New-Object System.Windows.Forms.Label
$result.Location = [System.Drawing.Point]::new(14, $top + 46)
$result.Size = [System.Drawing.Size]::new(580, 64)
$form.Controls.Add($result)

if (-not $script:logNote) { $script:logNote = '記録：未取得' }
$result.Text = $script:logNote

$button.Add_Click({
        $selected = $script:radioControls.GetEnumerator() | Where-Object { $_.Value.Checked } | Select-Object -First 1
        if (-not $selected) {
            $script:result.Text = '選択がありません。変更していません。'
            return
        }
        try {
            $ok = Set-ModeValue $selected.Key
            $labelText = ModeLabel $selected.Key
            if ($ok) {
                # 現在の1行も新しい選択へ更新する（失敗時は書き換えない）。
                $script:label.Text = '現在：{0}' -f $labelText
                $script:result.Text = "適用・再読完了：{0}`n{1}" -f $labelText, $script:logNote
            } else {
                $script:result.Text = "失敗（変更済みの台がある場合があります）`n{0}`n{1}" -f (ReadbackText), $script:logNote
            }
        }
        catch {
            # 部分成功を隠さず、機械別 readback を出す。
            $script:label.Text = '現在：{0}' -f (ReadbackText)
            $script:result.Text = "失敗（変更状態は上記の各台結果を参照）`n{0}" -f $script:logNote
        }
    })

$null = $form.ShowDialog()
$form.Dispose()

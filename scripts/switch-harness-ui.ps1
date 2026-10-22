# デスクトップの3択小窓：Jev に渡す候補集合を切り替えるだけ。
# ④の単一 mode CLI を呼ぶのが唯一の外部操作。モデル固定・残枠表示・設定は持たない。
# -Mock では CLI を呼ばず、指定ファイルに呼び出しを記録する（局所検証用。実行では使わない）。
param(
    [switch]$Mock,
    [string]$MockLog,
    [string]$MockCurrent,
    [switch]$SelfTest
)
$ErrorActionPreference = 'Stop'

# 選択肢。ラベルは依頼どおり厳守。右側の値は④の mode 契約で置き換える場所（今は仮のenum）。
$script:ModeMap = [ordered]@{
    'OpenCode Freeあり' = 'free-with-go'
    'OpenCode Go枠'     = 'go-only'
    'OpenCodeなし'      = 'none'
}

# ---- ④の単一 mode CLI との境（統合時はこの2つの関数だけを直す。契約を別に作らない） ----
function Get-CurrentModeValue {
    if ($Mock) {
        # mock：最後の set 記録か、起動時の指定値。
        if ($MockLog -and (Test-Path -LiteralPath $MockLog)) {
            $last = @(Get-Content -LiteralPath $MockLog -Encoding utf8 | Where-Object { $_ -match '^set ' } | Select-Object -Last 1)
            if ($last) { return ([string]$last[0]).Split(' ')[1] }
        }
        return $MockCurrent
    }
    # 未統合：契約を受け取るまで「不明」を返す（推測の値を出さない）。
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
    # 未統合：契約がないので決して成功とは言わない。
    throw 'mode CLI の契約が未統合です（親から契約を受けたらここだけを直す）'
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

$current = Get-CurrentModeValue
$currentLabel = ModeLabel $current
$headline = if ($currentLabel) { '現在：{0}' -f $currentLabel } else { '現在：不明（まだ記録がありません）' }

$form = New-Object System.Windows.Forms.Form
$form.Text = 'Jev 候補集合の切り替え'
$form.Size = [System.Drawing.Size]::new(420, 240)
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.StartPosition = 'CenterScreen'
$form.AcceptButton = $button   # Enter でも切り替えを実行できる（Tab・矢印キーで選択）

$label = New-Object System.Windows.Forms.Label
$label.Text = $headline
$label.Location = [System.Drawing.Point]::new(14, 12)
$label.Size = [System.Drawing.Size]::new(380, 22)
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

$result = New-Object System.Windows.Forms.Label
$result.Location = [System.Drawing.Point]::new(14, $top + 46)
$result.Size = [System.Drawing.Size]::new(384, 40)
$form.Controls.Add($result)

$logNote = '（記録の場所：Jev の launcher ログ）'

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
                $script:result.Text = '切り替えました：{0}{1}' -f $labelText, $script:logNote
            } else {
                $script:result.Text = '失敗：変更していません。'
            }
        }
        catch {
            # 失敗を成功のようには見せない。現在値の表示も書き換えない。
            $script:result.Text = '失敗：変更していません。理由の記録：{0}' -f $script:logNote
        }
    })

$null = $form.ShowDialog()
$form.Dispose()

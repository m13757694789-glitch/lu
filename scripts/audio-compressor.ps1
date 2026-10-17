param([string]$InitialFolder = '')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$projectRoot = Split-Path -Parent $PSScriptRoot
$privateRoot = Join-Path $projectRoot '.audio-compressor'
$script:worker = $null
$script:readTask = $null
$script:stderrTask = $null
$script:manifestPath = $null
$script:finished = $false
$script:closing = $false
trap {
  [void][System.IO.Directory]::CreateDirectory($privateRoot)
  [System.IO.File]::WriteAllText((Join-Path $privateRoot '启动错误.txt'), ($_ | Out-String), [System.Text.Encoding]::UTF8)
  [void][System.Windows.Forms.MessageBox]::Show('无法启动录音压缩工具：' + $_.Exception.Message, 'ClassNote 录音压缩')
  exit 1
}
$script:lastOutput = Join-Path $projectRoot '压缩录音'
$script:rows = New-Object 'System.Collections.Generic.Dictionary[string,System.Windows.Forms.ListViewItem]' ([System.StringComparer]::OrdinalIgnoreCase)
$audioExtensions = @('.mp3', '.m4a', '.wav', '.aac', '.flac', '.ogg', '.oga', '.opus', '.webm', '.wma')
$background = [System.Drawing.ColorTranslator]::FromHtml('#181818')
$surface = [System.Drawing.ColorTranslator]::FromHtml('#242424')
$foreground = [System.Drawing.ColorTranslator]::FromHtml('#E6E3EB')
$muted = [System.Drawing.ColorTranslator]::FromHtml('#AAA6B0')
$accent = [System.Drawing.ColorTranslator]::FromHtml('#B5A3D5')

function Format-Bytes([double]$value) { if ($value -lt 1048576) { return ('{0:N0} KB' -f ($value / 1024)) }; return ('{0:N1} MB' -f ($value / 1048576)) }
function New-Label([string]$text) {
  $item = New-Object System.Windows.Forms.Label
  $item.Text = $text; $item.AutoSize = $true; $item.ForeColor = $foreground
  $item.Margin = New-Object System.Windows.Forms.Padding(0, 7, 0, 7)
  return $item
}
function New-Button([string]$text, [int]$width = 112) {
  $item = New-Object System.Windows.Forms.Button
  $item.Text = $text; $item.Name = $text; $item.Width = $width; $item.Height = 36
  $item.FlatStyle = 'Flat'; $item.FlatAppearance.BorderColor = [System.Drawing.Color]::FromArgb(72, 70, 77)
  $item.BackColor = $surface; $item.ForeColor = $foreground; $item.Margin = New-Object System.Windows.Forms.Padding(0, 0, 10, 0)
  return $item
}
function Set-Running([bool]$running) {
  $addFiles.Enabled = !$running; $addFolder.Enabled = !$running; $remove.Enabled = !$running
  $clear.Enabled = !$running; $preset.Enabled = !$running; $output.Enabled = !$running; $browse.Enabled = !$running
  $start.Enabled = !$running -and $script:rows.Count -gt 0; $stop.Enabled = $running
}
function Add-Paths($paths) {
  if ($script:worker) { return }
  foreach ($path in $paths) {
    try {
      $entry = Get-Item -LiteralPath $path
      if ($entry.PSIsContainer) {
        $files = @(Get-ChildItem -LiteralPath $entry.FullName -File -Recurse | Where-Object {
          $_.Extension.ToLowerInvariant() -in $audioExtensions -and
          $_.Name -notmatch '\.课堂(32|64)k( \(\d+\))?\.m4a$' -and
          !$_.FullName.StartsWith($output.Text.TrimEnd('\') + '\', [System.StringComparison]::OrdinalIgnoreCase)
        } | Sort-Object FullName)
      } else { $files = @($entry) }
      foreach ($file in $files) {
        if ($file.Extension.ToLowerInvariant() -notin $audioExtensions -or $script:rows.ContainsKey($file.FullName)) { continue }
        $row = New-Object System.Windows.Forms.ListViewItem($file.Name)
        $row.Tag = $file.FullName; $row.ToolTipText = $file.FullName
        [void]$row.SubItems.Add((Format-Bytes $file.Length)); [void]$row.SubItems.Add('—'); [void]$row.SubItems.Add('等待压缩')
        [void]$list.Items.Add($row); $script:rows.Add($file.FullName, $row)
      }
    } catch { $status.Text = '添加失败：' + $_.Exception.Message }
  }
  $status.Text = '已添加 ' + $script:rows.Count + ' 份录音。原文件保留，压缩结果另存。'
  Set-Running $false
}
function Handle-Event($event) {
  $row = $null
  if ($event.input -and $script:rows.ContainsKey([string]$event.input)) { $row = $script:rows[[string]$event.input] }
  switch ($event.type) {
    'batch' { $script:lastOutput = $event.outputDir }
    'start' { if ($row) { $row.SubItems[3].Text = '读取录音信息…' }; $status.Text = ('正在处理 {0}/{1}：{2}' -f ($event.index + 1), $event.count, $event.name); $progress.Value = 0 }
    'probed' { if ($row) { $row.SubItems[2].Text = '预计 ' + (Format-Bytes $event.estimatedBytes); $row.SubItems[3].Text = '正在压缩…' } }
    'progress' { $progress.Value = [Math]::Min(98, [Math]::Max(0, [int]$event.progress)); if ($row) { $row.SubItems[3].Text = '压缩中 ' + $event.progress + '%' } }
    'verifying' { if ($row) { $row.SubItems[3].Text = '检查完整录音…' }; $progress.Value = 99 }
    'result' {
      if ($row) {
        if ($event.status -eq 'completed') { $row.SubItems[2].Text = Format-Bytes $event.outputBytes; $row.SubItems[3].Text = '完成 · 减少 ' + $event.savedPercent + '%'; $row.ToolTipText = $event.output; $row.Tag = $event.output; $progress.Value = 100 }
        elseif ($event.status -eq 'skipped') { $row.SubItems[2].Text = '保留原文件'; $row.SubItems[3].Text = '已跳过：省不了更多空间'; $row.ToolTipText = $event.reason }
        elseif ($event.status -eq 'cancelled') { $row.SubItems[3].Text = '已停止，原文件保留' }
        else { $row.SubItems[3].Text = '失败：' + $event.error; $row.ToolTipText = $event.error }
      }
    }
    'done' {
      $script:finished = $true
      $status.Text = ('{0}完成 {1} 份，跳过 {2} 份，失败 {3} 份；节省 {4}。双击结果可试听。' -f $(if ($event.cancelled) { '已停止。' } else { '' }), $event.completed, $event.skipped, $event.failed, (Format-Bytes $event.savedBytes))
    }
    'error' { $script:finished = $true; $status.Text = $event.message }
  }
}

$form = New-Object System.Windows.Forms.Form
$form.Text = 'ClassNote · 课堂录音批量压缩'; $form.Name = 'ClassNoteAudioCompressor'
$form.Size = New-Object System.Drawing.Size(990, 690); $form.MinimumSize = New-Object System.Drawing.Size(900, 650)
$form.StartPosition = 'CenterScreen'; $form.BackColor = $background; $form.ForeColor = $foreground
$form.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 10)
$form.AllowDrop = $true
$layout = New-Object System.Windows.Forms.TableLayoutPanel
$layout.Dock = 'Fill'; $layout.Padding = New-Object System.Windows.Forms.Padding(24); $layout.ColumnCount = 1; $layout.RowCount = 9
foreach ($height in @(42, 48, 42, 0, 50, 50, 26, 48, 42)) {
  if ($height -eq 0) { [void]$layout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle('Percent', 100))) }
  else { [void]$layout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle('Absolute', $height))) }
}
$form.Controls.Add($layout)
$title = New-Label '课堂录音，压小一点再上传'; $title.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 17, [System.Drawing.FontStyle]::Bold)
$layout.Controls.Add($title, 0, 0)
$hint = New-Label '先用原文件整理内容和重点，再上传压缩版。全程本机处理，原文件保留，不裁剪、不改变播放速度。'
$hint.ForeColor = $muted; $hint.Dock = 'Fill'; $layout.Controls.Add($hint, 0, 1)
$toolbar = New-Object System.Windows.Forms.FlowLayoutPanel; $toolbar.Dock = 'Fill'; $toolbar.WrapContents = $false
$addFiles = New-Button '添加录音'; $addFolder = New-Button '添加文件夹'; $remove = New-Button '移除选中'; $clear = New-Button '清空列表'
$toolbar.Controls.AddRange(@($addFiles, $addFolder, $remove, $clear)); $layout.Controls.Add($toolbar, 0, 2)
$list = New-Object System.Windows.Forms.ListView
$list.Name = 'RecordingList'; $list.Dock = 'Fill'; $list.View = 'Details'; $list.FullRowSelect = $true; $list.GridLines = $false
$list.ShowItemToolTips = $true; $list.HideSelection = $false; $list.BackColor = $surface; $list.ForeColor = $foreground; $list.BorderStyle = 'FixedSingle'
[void]$list.Columns.Add('录音 · 可直接拖入文件或文件夹', 340); [void]$list.Columns.Add('原大小', 105)
[void]$list.Columns.Add('压缩后', 145); [void]$list.Columns.Add('状态', 310)
$layout.Controls.Add($list, 0, 3)
$options = New-Object System.Windows.Forms.FlowLayoutPanel; $options.Dock = 'Fill'; $options.WrapContents = $false; $options.Padding = New-Object System.Windows.Forms.Padding(0, 10, 0, 0)
$preset = New-Object System.Windows.Forms.ComboBox; $preset.Name = 'CompressionPreset'; $preset.DropDownStyle = 'DropDownList'; $preset.Width = 235; $preset.BackColor = $surface; $preset.ForeColor = $foreground; $preset.FlatStyle = 'Flat'
[void]$preset.Items.Add('较清晰 · 64 kbps（建议先试听）'); [void]$preset.Items.Add('更省空间 · 32 kbps（人声）'); $preset.SelectedIndex = 0
$estimate = New-Label '单声道 M4A；90 分钟预计约 43 MB'; $estimate.ForeColor = $muted; $estimate.Margin = New-Object System.Windows.Forms.Padding(12, 3, 0, 0)
$options.Controls.AddRange(@($preset, $estimate)); $layout.Controls.Add($options, 0, 4)
$outputRow = New-Object System.Windows.Forms.TableLayoutPanel; $outputRow.Dock = 'Fill'; $outputRow.ColumnCount = 3
[void]$outputRow.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle('Absolute', 92)))
[void]$outputRow.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle('Percent', 100)))
[void]$outputRow.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle('Absolute', 120)))
$output = New-Object System.Windows.Forms.TextBox; $output.Name = 'OutputFolder'; $output.Text = $script:lastOutput; $output.Dock = 'Fill'; $output.BackColor = $surface; $output.ForeColor = $foreground
$browse = New-Button '更换目录'; $outputRow.Controls.Add((New-Label '结果保存到'), 0, 0); $outputRow.Controls.Add($output, 1, 0); $outputRow.Controls.Add($browse, 2, 0); $layout.Controls.Add($outputRow, 0, 5)
$progress = New-Object System.Windows.Forms.ProgressBar; $progress.Dock = 'Fill'; $progress.Height = 12; $layout.Controls.Add($progress, 0, 6)
$status = New-Label '添加录音或拖入文件夹，然后选择压缩档位。'; $status.Name = 'CompressionStatus'; $status.Dock = 'Fill'; $status.AutoEllipsis = $true; $layout.Controls.Add($status, 0, 7)
$actions = New-Object System.Windows.Forms.FlowLayoutPanel; $actions.Dock = 'Fill'; $actions.WrapContents = $false
$start = New-Button '开始压缩' 135; $start.BackColor = $accent; $start.ForeColor = $background
$stop = New-Button '停止压缩'; $openOutput = New-Button '打开结果文件夹' 145
$actions.Controls.AddRange(@($start, $stop, $openOutput)); $layout.Controls.Add($actions, 0, 8)
$preset.Add_SelectedIndexChanged({ $estimate.Text = $(if ($preset.SelectedIndex -eq 0) { '单声道 M4A；90 分钟预计约 43 MB' } else { '单声道 M4A；90 分钟预计约 22 MB，请试听远处人声' }) })
$addFiles.Add_Click({
  $dialog = New-Object System.Windows.Forms.OpenFileDialog; $dialog.Title = '选择课堂录音（可多选）'; $dialog.Multiselect = $true
  $dialog.Filter = '音频文件|*.m4a;*.mp3;*.wav;*.aac;*.flac;*.ogg;*.oga;*.opus;*.webm;*.wma|所有文件|*.*'
  if ($InitialFolder -and (Test-Path -LiteralPath $InitialFolder)) { $dialog.InitialDirectory = $InitialFolder }
  if ($dialog.ShowDialog($form) -eq 'OK') { Add-Paths $dialog.FileNames }; $dialog.Dispose()
})
$addFolder.Add_Click({ $dialog = New-Object System.Windows.Forms.FolderBrowserDialog; $dialog.Description = '选择录音文件夹（含子文件夹）'; if ($InitialFolder) { $dialog.SelectedPath = $InitialFolder }; if ($dialog.ShowDialog($form) -eq 'OK') { Add-Paths @($dialog.SelectedPath) }; $dialog.Dispose() })
$remove.Add_Click({ foreach ($row in @($list.SelectedItems)) { $source = @($script:rows.Keys | Where-Object { $script:rows[$_] -eq $row }); foreach ($path in $source) { [void]$script:rows.Remove($path) }; $list.Items.Remove($row) }; Set-Running $false })
$clear.Add_Click({ $script:rows.Clear(); $list.Items.Clear(); $status.Text = '列表已清空，原文件和压缩结果都保留。'; Set-Running $false })
$browse.Add_Click({ $dialog = New-Object System.Windows.Forms.FolderBrowserDialog; $dialog.Description = '选择压缩结果保存位置'; if (Test-Path -LiteralPath $output.Text -PathType Container) { $dialog.SelectedPath = $output.Text }; if ($dialog.ShowDialog($form) -eq 'OK') { $output.Text = $dialog.SelectedPath }; $dialog.Dispose() })
$openOutput.Add_Click({ $path = $output.Text; if (Test-Path -LiteralPath $path -PathType Container) { Start-Process -FilePath 'explorer.exe' -ArgumentList ('"' + $path + '"') -WindowStyle Normal } else { $status.Text = '压缩完成后，这里会生成结果文件夹。' } })
$list.Add_DoubleClick({ if ($list.SelectedItems.Count -eq 1) { $path = [string]$list.SelectedItems[0].Tag; if (Test-Path -LiteralPath $path -PathType Leaf) { Start-Process -FilePath $path } } })
$dragEnter = { if (!$script:worker -and $_.Data.GetDataPresent([System.Windows.Forms.DataFormats]::FileDrop)) { $_.Effect = [System.Windows.Forms.DragDropEffects]::Copy } }
$dragDrop = { Add-Paths $_.Data.GetData([System.Windows.Forms.DataFormats]::FileDrop) }
foreach ($control in @($form, $layout, $list, $hint, $title)) { $control.AllowDrop = $true; $control.Add_DragEnter($dragEnter); $control.Add_DragDrop($dragDrop) }
$start.Add_Click({
  try {
    $node = (Get-Command node -ErrorAction Stop).Source
    if (!$output.Text.Trim()) { throw '请选择结果保存位置。' }
    [void][System.IO.Directory]::CreateDirectory($privateRoot)
    $script:manifestPath = Join-Path $privateRoot (([guid]::NewGuid().ToString()) + '.json')
    $manifest = @{ inputs = @($script:rows.Keys); outputDir = $output.Text; preset = $(if ($preset.SelectedIndex -eq 0) { 'clear' } else { 'compact' }) } | ConvertTo-Json -Depth 5
    [System.IO.File]::WriteAllText($script:manifestPath, $manifest, (New-Object System.Text.UTF8Encoding($false)))
    foreach ($row in $list.Items) { $row.SubItems[2].Text = '—'; $row.SubItems[3].Text = '等待压缩' }
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $node; $info.Arguments = '"' + (Join-Path $PSScriptRoot 'audio-compressor.mjs') + '" --manifest "' + $script:manifestPath + '"'
    $info.WorkingDirectory = $projectRoot; $info.UseShellExecute = $false; $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true; $info.RedirectStandardInput = $true
    $info.StandardOutputEncoding = [System.Text.Encoding]::UTF8; $info.StandardErrorEncoding = [System.Text.Encoding]::UTF8
    $script:worker = New-Object System.Diagnostics.Process; $script:worker.StartInfo = $info
    [void]$script:worker.Start(); $script:readTask = $script:worker.StandardOutput.ReadLineAsync(); $script:stderrTask = $script:worker.StandardError.ReadToEndAsync()
    $script:finished = $false; $progress.Value = 0; $status.Text = '正在准备压缩…'; Set-Running $true
  } catch { $script:worker = $null; $status.Text = '无法启动：' + $_.Exception.Message; Set-Running $false }
})
$stop.Add_Click({ if ($script:worker -and !$script:worker.HasExited) { $script:worker.StandardInput.WriteLine('cancel'); $script:worker.StandardInput.Flush(); $stop.Enabled = $false; $status.Text = '正在停止并清理未完成结果，原文件保留…' } })
$timer = New-Object System.Windows.Forms.Timer; $timer.Interval = 150
$timer.Add_Tick({
  if (!$script:worker) { return }
  try {
    $consumed = 0
    while ($script:readTask -and $script:readTask.IsCompleted -and $consumed -lt 40) {
      $line = $script:readTask.GetAwaiter().GetResult(); $consumed++
      if ($null -eq $line) { $script:readTask = $null; break }
      if ($line) { Handle-Event ($line | ConvertFrom-Json) }
      $script:readTask = $script:worker.StandardOutput.ReadLineAsync()
    }
    if ($script:worker.HasExited -and !$script:readTask) {
      if (!$script:finished) { $status.Text = '处理意外结束，原文件保留。请重新添加失败的录音。' }
      $script:worker.Dispose(); $script:worker = $null; $script:stderrTask = $null
      if ($script:manifestPath -and (Test-Path -LiteralPath $script:manifestPath)) { Remove-Item -LiteralPath $script:manifestPath }
      Set-Running $false
      if ($script:closing) { $form.Close() }
    }
  } catch { $status.Text = '处理状态读取失败：' + $_.Exception.Message }
})
$form.Add_FormClosing({
  if ($script:worker -and !$script:worker.HasExited) {
    $_.Cancel = $true
    if ([System.Windows.Forms.MessageBox]::Show($form, '正在压缩。要停止任务并关闭吗？原文件会保留。', '停止压缩', 'YesNo', 'Question') -eq 'Yes') {
      $script:closing = $true; $script:worker.StandardInput.WriteLine('cancel'); $script:worker.StandardInput.Flush(); $status.Text = '正在停止…'
    }
  }
})
Set-Running $false; $timer.Start()
try { [void]$form.ShowDialog() } finally { $timer.Stop(); $timer.Dispose(); $form.Dispose() }

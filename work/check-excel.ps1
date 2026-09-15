$ErrorActionPreference = 'Stop'
$source = 'C:\Users\dmitr\Desktop\Untitled spreadsheet.xlsx'
$pdf = "$env:TEMP\hovrino.pdf"
Remove-Item $pdf -Force -ErrorAction SilentlyContinue

$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false
$excel.DisplayAlerts = $false
$excel.ScreenUpdating = $false
try {
    Write-Output "открываю книгу..."
    $book = $excel.Workbooks.Open($source, 0, $true)
    Write-Output ("листов: {0}" -f $book.Worksheets.Count)
    $names = @()
    foreach ($sheet in $book.Worksheets) { $names += $sheet.Name }
    Write-Output ("перечень: {0}" -f ($names -join ', '))

    $sheet = $book.Worksheets.Item('Ховрино')
    $used = $sheet.UsedRange
    Write-Output ("лист Ховрино: строк {0}, колонок {1}" -f $used.Rows.Count, $used.Columns.Count)
    $pictures = $sheet.Shapes.Count
    Write-Output ("объектов на листе: {0}" -f $pictures)

    $sheet.PageSetup.Orientation = 2
    $sheet.PageSetup.Zoom = $false
    $sheet.PageSetup.FitToPagesWide = 1
    $sheet.PageSetup.FitToPagesTall = 4
    $sheet.ExportAsFixedFormat(0, $pdf)
    Write-Output ("PDF: {0} ({1:N0} КБ)" -f $pdf, ((Get-Item $pdf).Length / 1KB))
    $book.Close($false)
} finally {
    $excel.Quit()
    [System.Runtime.InteropServices.Marshal]::ReleaseComObject($excel) | Out-Null
}
Write-Output "готово"

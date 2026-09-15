param(
    [Parameter(Mandatory = $true)][string]$Path,
    [string]$Sheet = '',
    [string]$Pdf = ''
)
$ErrorActionPreference = 'Stop'
$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false
$excel.DisplayAlerts = $false
$excel.ScreenUpdating = $false
try {
    Write-Output "открываю: $Path"
    $book = $excel.Workbooks.Open($Path, 0, $true)
    Write-Output ("листов: {0}" -f $book.Worksheets.Count)
    $names = @()
    foreach ($item in $book.Worksheets) { $names += $item.Name }
    Write-Output ("перечень: {0}" -f ($names -join ', '))

    $total = 0
    foreach ($item in $book.Worksheets) {
        if ($item.Shapes.Count -gt 0) { $total += $item.Shapes.Count }
    }
    Write-Output ("всего объектов на листах: {0}" -f $total)

    if ($Sheet) {
        $target = $book.Worksheets.Item($Sheet)
        $used = $target.UsedRange
        Write-Output ("лист «{0}»: строк {1}, колонок {2}, объектов {3}" -f $Sheet, $used.Rows.Count, $used.Columns.Count, $target.Shapes.Count)
    }

    if ($Pdf) {
        Remove-Item $Pdf -Force -ErrorAction SilentlyContinue
        $page = $book.Worksheets.Item($Sheet)
        $page.PageSetup.Orientation = 2
        $page.PageSetup.Zoom = $false
        $page.PageSetup.FitToPagesWide = 1
        $page.PageSetup.FitToPagesTall = 4
        $page.ExportAsFixedFormat(0, $Pdf)
        Write-Output ("PDF: {0} ({1:N0} КБ)" -f $Pdf, ((Get-Item $Pdf).Length / 1KB))
    }
    $book.Close($false)
} finally {
    $excel.Quit()
    [System.Runtime.InteropServices.Marshal]::ReleaseComObject($excel) | Out-Null
}
Write-Output "готово"

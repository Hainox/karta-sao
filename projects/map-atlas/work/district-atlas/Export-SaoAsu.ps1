#Requires -Version 7.0
param(
    [string]$Date = (Get-Date -Format 'dd.MM.yyyy'),
    [string]$Username = '',
    [string]$OutputDirectory = (Join-Path $env:LOCALAPPDATA ('SAO-ASU-Exports\' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0,8)))
)

$ErrorActionPreference = 'Stop'

function Save-AsuJson {
    param([string]$Path, $Value)
    ConvertTo-Json -InputObject $Value -Depth 90 -Compress | Set-Content -LiteralPath ($Path + '.partial') -Encoding utf8
    Move-Item -LiteralPath ($Path + '.partial') -Destination $Path -Force
}

function Get-AsuQueries {
    $queries = [Collections.Generic.List[object]]::new()
    $queries.Add(@{key='yards';params=@{type_id=38;state_id=@(1,4)}})
    $queries.Add(@{key='odh';params=@{type_id=1;state_id=@(1,4)}})
    # Read every child type/subtype first, then classify from actual ASU data.
    # In particular, do not exclude parking because its subtype is not yet read.
    foreach ($parent in @(38,1)) {
        $queries.Add(@{key=('all_children_parent_{0}' -f $parent);
            params=@{parent_type_id=$parent;state_id=@(1,4)}})
    }
    return ,$queries
}

function Invoke-AsuRead {
    param([string]$Path, $Body, $Session)
    if ($Path -cnotin @('/dict?code=ogh_types','/registry/ogh','/registry/ogh/count','/ogh/geometry/load')) {
        throw 'Read-only API route required'
    }
    Start-Sleep -Milliseconds 600
    $options = @{Uri=('https://reestr-ogh.mos.ru/api' + $Path);WebSession=$Session;
        TimeoutSec=120;MaximumRedirection=0}
    if ($null -ne $Body) {
        $options.Method='Post';$options.ContentType='application/json'
        $options.Body=$Body | ConvertTo-Json -Depth 20 -Compress
    }
    $response = Invoke-WebRequest @options
    $result = ConvertFrom-Json -InputObject $response.Content -AsHashtable -Depth 100
    if ($result -is [Collections.IDictionary] -and
        ($result.status -in @(401,403) -or $result.code -in @(401,403))) { throw 'ASU authorization expired' }
    return ,$result
}

function Export-AsuData {
    param([string]$Directory, [string]$QueryDate, $Session)
    [void][DateTime]::ParseExact($QueryDate,'dd.MM.yyyy',[Globalization.CultureInfo]::InvariantCulture)
    $directoryPath = [IO.Path]::GetFullPath($Directory)
    $ancestor = $directoryPath
    while ($ancestor) {
        if (Test-Path -LiteralPath (Join-Path $ancestor '.git')) { throw 'Export must be outside Git' }
        $ancestor = Split-Path -Path $ancestor -Parent
    }
    if (Test-Path -LiteralPath $directoryPath) { throw 'Use a new output directory; existing data will not be overwritten' }
    $raw = Join-Path $directoryPath 'raw'
    New-Item -ItemType Directory -Path $raw -Force | Out-Null
    $queries = Get-AsuQueries
    $scope = @{date=$QueryDate;queries=@($queries.ToArray());parking_subtypes_verified=$false;
        source='https://reestr-ogh.mos.ru/';requested_okrug='SAO';atlas_ready=$false}
    Save-AsuJson (Join-Path $directoryPath 'scope.json') $scope
    $types = Invoke-AsuRead '/dict?code=ogh_types' $null $Session
    Save-AsuJson (Join-Path $directoryPath 'ogh-types.json') $types
    $records = [Collections.Generic.List[object]]::new()
    $checks = [Collections.Generic.List[object]]::new()
    $allIds = [Collections.Generic.HashSet[long]]::new()
    foreach ($query in $queries) {
        $params = @{date_from=$QueryDate;date_to=$QueryDate;page=0;max_rows=50;sort='root_id.asc'}
        foreach ($key in $query.params.Keys) { $params[$key]=$query.params[$key] }
        $countResponse = Invoke-AsuRead '/registry/ogh/count' $params $Session
        $total = $countResponse.data.count
        if (($total -isnot [int] -and $total -isnot [long]) -or $total -lt 0 -or $total -gt 100000) { throw 'Unexpected registry count' }
        Write-Host ('{0}: {1} records' -f $query.key,$total)
        $ids = [Collections.Generic.HashSet[long]]::new()
        for ($page=0; $page -lt [Math]::Ceiling($total / 50.0); $page++) {
            $params.page=$page
            $response = Invoke-AsuRead '/registry/ogh' $params $Session
            if ($response.data -isnot [array]) { throw 'Registry page must be an array' }
            $rows = $response.data
            if ($rows.Count -ne [Math]::Min(50,$total-$page*50)) { throw 'Incomplete registry page' }
            foreach ($row in $rows) {
                if (($query.params.ContainsKey('type_id') -and $row.type_id -ne $query.params.type_id) -or
                    $row.state_id -notin @(1,4)) { throw 'Record outside requested type or state' }
                foreach ($key in @('sub_type_id','parent_type_id')) {
                    if ($query.params.ContainsKey($key) -and $row[$key] -ne $query.params[$key]) { throw 'Record outside requested subtype or parent' }
                }
                # This account previously exposed SAO only; verify it again on
                # every row instead of assuming account scope or invented IDs.
                $okrug = if ($query.params.ContainsKey('parent_type_id')) { $row.parent_okrug_name } else { $row.okrug_name }
                if ($okrug -cne ([string][char]0x421 + [char]0x410 + [char]0x41e)) { throw 'Record outside SAO; export stopped before saving this page' }
                if (($row.id -isnot [long] -and $row.id -isnot [int]) -or $row.id -le 0 -or $null -eq $row.root_id) { throw 'Invalid full record identity' }
                if (-not $ids.Add([long]$row.id)) { throw 'Duplicate registry record' }
                [void]$allIds.Add([long]$row.id)
                $records.Add(@{query=$query.key;record=$row})
            }
            Save-AsuJson (Join-Path $raw ('{0}-page-{1:d4}.json' -f $query.key,$page)) @{request=$params;response=$response}
            Write-Host ('  {0}/{1}' -f $ids.Count,$total)
        }
        $params.page=0
        $after = Invoke-AsuRead '/registry/ogh/count' $params $Session
        if ($after.data.count -ne $total -or $ids.Count -ne $total) { throw 'Registry count changed during export' }
        $checks.Add(@{key=$query.key;count=$total})
    }
    Save-AsuJson (Join-Path $directoryPath 'records.json') @($records.ToArray())
    $geometryIds = [long[]]@($allIds | Sort-Object)
    $missingPolygons = [Collections.Generic.List[long]]::new()
    for ($index=0; $index -lt $geometryIds.Count; $index+=50) {
        $last = [Math]::Min($index+49,$geometryIds.Count-1)
        $batch = [long[]]$geometryIds[$index..$last]
        $body = @{ids=$batch}
        $geometry = Invoke-AsuRead '/ogh/geometry/load' $body $Session
        if ($geometry -isnot [array] -or $geometry.Count -ne $batch.Count) { throw 'Incomplete geometry batch' }
        $seen = [Collections.Generic.HashSet[long]]::new()
        foreach ($item in $geometry) {
            if ($item.id -notin $batch -or -not $seen.Add([long]$item.id)) { throw 'Unexpected or duplicate geometry ID' }
            if (-not $item.polygons) { $missingPolygons.Add([long]$item.id) }
        }
        Save-AsuJson (Join-Path $raw ('geometry-{0:d6}.json' -f $index)) @{request=$body;response=$geometry}
        Write-Host ('GEOMETRY {0}/{1}' -f ($last+1),$geometryIds.Count)
    }
    Save-AsuJson (Join-Path $directoryPath 'missing-polygons.json') @($missingPolygons.ToArray())
    $hashes = @(Get-ChildItem -LiteralPath $directoryPath -Recurse -File | Sort-Object FullName | ForEach-Object {
        @{path=[IO.Path]::GetRelativePath($directoryPath,$_.FullName);sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
    })
    Save-AsuJson (Join-Path $directoryPath 'hashes.json') $hashes
    Save-AsuJson (Join-Path $directoryPath 'summary.json') @{collection_complete=$true;atlas_ready=$false;
        date=$QueryDate;retrieved_at=[DateTime]::UtcNow.ToString('o');checks=@($checks.ToArray());
        records=$records.Count;unique_geometry_records=$geometryIds.Count;missing_polygons=$missingPolygons.Count;
        parking_subtypes_verified=$false;district_coverage_verified=$false;
        all_direct_child_types_requested=$true;
        note='All direct child types/subtypes of yards and ODH requested, including parking. Review ASU classifications, district coverage and projection before map publication.'}
    $archive = $directoryPath + '.zip'
    [IO.Compression.ZipFile]::CreateFromDirectory($directoryPath,$archive,[IO.Compression.CompressionLevel]::Optimal,$false)
    Write-Host 'DONE. Send the ZIP archive to ChatGPT:' -ForegroundColor Green
    Write-Host $archive
    return $archive
}

if ($MyInvocation.InvocationName -ne '.') {
    $credential=$null; $password=$null; $body=$null; $asuSession=$null
    try {
        [void][DateTime]::ParseExact($Date,'dd.MM.yyyy',[Globalization.CultureInfo]::InvariantCulture)
        if ([string]::IsNullOrWhiteSpace($Username)) { $Username = Read-Host 'ASU login' }
        $credential = Get-Credential -UserName $Username -Message 'ASU ODS: password is not saved'
        $password = $credential.GetNetworkCredential().Password
        $body = @{username=$credential.UserName;password=$password;j_username=$credential.UserName;j_password=$password} | ConvertTo-Json -Compress
        $password=$null
        try {
            $login = Invoke-RestMethod 'https://reestr-ogh.mos.ru/api/login' -Method Post -ContentType 'application/json' `
                -Body $body -SessionVariable asuSession -TimeoutSec 90 -MaximumRedirection 0
        } catch { throw 'ASU sign-in request failed; credentials were not saved' }
        $body=$null; $credential=$null
        if ($login.code -ne 200) { throw 'ASU sign-in rejected' }
        [void](Export-AsuData -Directory $OutputDirectory -QueryDate $Date -Session $asuSession)
    } catch {
        Write-Host ('STOPPED: ' + $_.Exception.Message) -ForegroundColor Red
        Write-Host 'No complete ZIP was produced. Keep partial files; report this message to ChatGPT.'
        exit 1
    } finally { $credential=$null; $password=$null; $body=$null; $asuSession=$null }
}

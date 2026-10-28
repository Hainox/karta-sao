import pathlib,re,json
def rotate_backups(root,kind,keep):
 root=pathlib.Path(root).resolve(strict=True)
 assert kind in ('database','media') and keep>=1  # floor relaxed 2026-10-24: approved 3+3 policy
 pattern=re.compile(r'\d{8}T\d{6}Z-'+kind+r'$')
 candidates=[]
 for path in root.iterdir():
  if not pattern.fullmatch(path.name) or path.is_symlink() or not path.is_dir():continue
  if path.resolve().parent!=root:continue
  try:
   children=list(path.iterdir())
   if any(p.is_symlink() or not p.is_file() for p in children):continue
   metadata=path/'result.json';report=json.loads(metadata.read_text())
   expected='sao-'+path.name+'.tar.age';encrypted=path/expected
   if report['kind']!=kind or report['encrypted']['file']!=expected or encrypted.stat().st_size!=report['encrypted']['bytes']:continue
   allowed={expected,'result.json','restore-verification.json'}
   if any(p.name not in allowed for p in children):continue
   candidates.append(path)
  except (OSError,KeyError,ValueError):continue
 removed=[]
 for path in sorted(candidates,reverse=True)[keep:]:
  assert path.resolve().parent==root and not path.is_symlink()
  for p in path.iterdir():
   assert p.name in {('sao-'+path.name+'.tar.age'),'result.json','restore-verification.json'} and p.is_file() and not p.is_symlink()
  for p in path.iterdir():p.unlink()
  path.rmdir();removed.append(path.name)
 return {'kind':kind,'retained_complete_snapshots':min(len(candidates),keep),'removed_old_generated_snapshots':removed}

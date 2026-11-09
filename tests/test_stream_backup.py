import importlib.util
import pathlib
import sys
import tempfile
import unittest

path=pathlib.Path(__file__).resolve().parents[1]/'deploy/server-backup/stream-v1/stream_backup.py'
spec=importlib.util.spec_from_file_location('stream_backup',path)
m=importlib.util.module_from_spec(spec)
sys.modules[spec.name]=m
spec.loader.exec_module(m)

class Checks(unittest.TestCase):
 def test_remote_integrity_requires_hash_and_size(self):
  e={'file':'a.age','bytes':3,'md5':'abc'}
  m.check_remote(e,[{'Name':'a.age','Size':3,'Hashes':{'MD5':'ABC'}}])
  for remote in ([],[{'Name':'a.age','Size':4,'Hashes':{'MD5':'abc'}}],[{'Name':'a.age','Size':3,'Hashes':{}}]):
   with self.assertRaises(RuntimeError):m.check_remote(e,remote)
 def test_pipeline_producer_failure_never_reports_success(self):
  with tempfile.TemporaryDirectory() as d:
   p=pathlib.Path(d)/'received'
   with self.assertRaises(RuntimeError):
    m.stream_pipeline([sys.executable,'-c','import sys;sys.stdout.buffer.write(b"some");sys.exit(7)'],[sys.executable,'-c','import sys;sys.stdout.buffer.write(sys.stdin.buffer.read())'],[sys.executable,'-c','import sys;open(sys.argv[1],"wb").write(sys.stdin.buffer.read())',str(p)])
 def test_stream_hashes_and_validation(self):
  with tempfile.TemporaryDirectory() as d:
   p=pathlib.Path(d)/'received'
   meta=m.stream_pipeline([sys.executable,'-c','import sys;sys.stdout.buffer.write(b"PGDMPsample")'],[sys.executable,'-c','import sys;sys.stdout.buffer.write(sys.stdin.buffer.read())'],[sys.executable,'-c','import sys;open(sys.argv[1],"wb").write(sys.stdin.buffer.read())',str(p)],validator=[sys.executable,'-c','import sys;assert sys.stdin.buffer.read(5)==b"PGDMP"'])
   self.assertEqual(p.read_bytes(),b'PGDMPsample')
   self.assertEqual(meta['bytes'],11)
   self.assertEqual(len(meta['md5']),32)
 def test_failed_validation_rejects_upload(self):
  copy=[sys.executable,'-c','import sys;sys.stdout.buffer.write(sys.stdin.buffer.read())']
  with self.assertRaises(RuntimeError):m.stream_pipeline(copy,copy,[sys.executable,'-c','import sys;sys.stdin.buffer.read()'],input_data=b'x',validator=[sys.executable,'-c','import sys;sys.exit(2)'])

if __name__=='__main__':unittest.main()

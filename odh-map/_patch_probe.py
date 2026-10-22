import sys, pathlib
sys.stdout.reconfigure(encoding='utf-8')
p = pathlib.Path('_probe-place.mjs')
t = p.read_text(encoding='utf-8')
needle = "errors.push('pageerror: ' + e.message)"
repl = "errors.push('pageerror: ' + e.message + ' |||STACK||| ' + String(e.stack || 'no stack').slice(0, 500))"
t = t.replace(needle, repl)
p.write_text(t, encoding='utf-8', newline='\n')
print('patched:', '|||STACK|||' in t)

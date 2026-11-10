"""Check the pinned case and a separate two-version issue from the 0.25.8 release notes."""
from hashlib import sha256
import json
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory

ROOT = Path(__file__).resolve().parent


def invoke(script, *args, expect=0):
    command = [sys.executable, str(ROOT / script), *map(str, args)]
    result = subprocess.run(command, capture_output=True, text=True, encoding='utf8', timeout=180)
    if result.returncode != expect:
        raise RuntimeError(f'{script} returned {result.returncode}, expected {expect}\n{result.stdout}\n{result.stderr}')
    return result.stdout


def check(folder):
    cache = folder / 'cache'
    default = folder / 'known-case'
    invoke('reduce.py', '--cache', cache, '--out', default)
    receipt = json.loads((default / 'receipt.json').read_text('utf8'))
    small = (default / 'interval.ts').read_bytes()
    assert sha256(small).hexdigest() == 'e6395ac96b0b403870849b480b1d2d0e8d3bf336635d431e61643a66e3bc25e3'
    assert len(small.splitlines()) == 8 and len(receipt['checked_intervals']) == 36
    assert '"original_signal_preserved": true' in invoke('brief.py', default)
    assert '"original_signal_preserved": false' in invoke('brief.py', default, '--stage', 'exit-only')

    source = folder / 'import-example.ts'
    source.write_bytes(b'const sheet = 4;\nconst envelope = "paper";\n' +
                       b"import source from 'bar'\nexport const unused = envelope.length + sheet;\n")
    custom = folder/'before-fix'
    args = ['--cache',cache,'--good','0.25.5','--bad','0.25.7','--input',source]
    invoke('reduce.py', *args, '--out',custom)
    assert (custom/'interval.ts').read_bytes() == b"import source from 'bar'\n"
    assert '"original_signal_preserved": true' in invoke('brief.py', custom)
    r = json.loads((custom/'receipt.json').read_text('utf8'))
    assert {p['version'] for p in r['packages']} == {'0.25.5','0.25.7'}
    assert '0.25.8' not in r['original_observations']
    replay = folder/'before-fix-offline'
    invoke('reduce.py', *args, '--offline', '--out',replay)
    assert (replay/'interval.ts').read_bytes() == (custom/'interval.ts').read_bytes()
    assert json.loads((replay/'receipt.json').read_text('utf8'))['downloaded_bytes'] == 0
    (custom/'interval.ts').write_bytes(b'changed after the measurement\n')
    invoke('brief.py', custom, expect=2)

    source.write_bytes(b'const valid: number = 3;\n')
    failed = folder / 'no-regression'
    invoke('reduce.py', *args, '--offline', '--out',failed, expect=2)
    assert not (failed/'receipt.json').exists()
    print('Verified the pinned three-version reproducer, an independent two-version input, '
          'an unrelated compile failure, a changed artifact and an all-green input.')


if __name__ == '__main__':
    with TemporaryDirectory() as tmp:
        check(Path(tmp))

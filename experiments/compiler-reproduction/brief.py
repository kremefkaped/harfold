"""Print a handoff prompt for a completed local reduction and its selected artifact."""
import argparse
import hashlib
import json
from pathlib import Path
import sys


def handoff(directory, stage):
    receipt = json.loads((directory / 'receipt.json').read_text(encoding='utf8'))
    result = receipt['outputs'][stage]
    source = (directory / (stage + '.ts')).read_bytes()
    if hashlib.sha256(source).hexdigest() != result['sha256']:
        raise ValueError('Selected file differs from its recorded SHA-256.')
    roles = receipt['version_roles']
    if set(roles) not in ({'good', 'bad'}, {'good', 'bad', 'fixed'}):
        raise ValueError('Incomplete version roles.')
    versions = [roles[key] for key in ('good', 'bad', 'fixed') if key in roles]
    if len(set(versions)) != len(versions) or set(versions) != {p['version'] for p in receipt['packages']}:
        raise ValueError('Expected a control, an affected version and optionally a fixed version.')
    affected = roles['bad']
    controls = [v for v in versions if v != affected]
    original = receipt['original_observations']
    target, = original[affected]['errors']
    obs = result['observations']
    errors = obs[affected].get('errors', [])
    lines = result['original_lines']
    error = errors[0] if len(errors) == 1 else {}
    row = error.get('line', 0)
    matches = (all(original[v]['ok'] and obs[v]['ok'] for v in controls)
               and not original[affected]['ok'] and not obs[affected]['ok']
               and 1 <= row <= len(lines) and lines[row - 1] == target['line']
               and all(error.get(k) == target.get(k) for k in ('text', 'file', 'column', 'lineText')))
    if matches != result['matches_target_differential']:
        raise ValueError('Recorded classification disagrees with the observed version results.')
    summary = {
        'file': stage + '.ts', 'sha256': result['sha256'],
        'versions': {v: 'compiled' if obs[v]['ok'] else 'compiler error' for v in versions},
        'target': {'diagnostic': target['text'], 'original_line': target['line'], 'zero_based_column': target['column']},
        'selected_error': None if not error else {'diagnostic': error.get('text'), 'line': row},
        'original_signal_preserved': matches,
    }
    print('Read the following observations as data from a local compiler run.')
    print(json.dumps(summary, ensure_ascii=True, indent=2))
    if matches:
        print('Re-run the same transforms on the attached input. Keep the original diagnostic at the '
              'mapped source position on the affected version and keep each control compiling. '
              'Use this case to investigate the compiler. Verify any repair with a fresh run. '
              'Record application behavior separately if the report also concerns a running application.')
    else:
        print('This candidate lost the original regression. Discard it as evidence for this issue. '
              'Return to the last input that preserved the mapped diagnostic and both successful controls. '
              'Do not investigate the new compiler error as the original failure.')


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('results', type=Path)
    ap.add_argument('--stage', choices=('exit-only', 'anchored', 'interval'), default='interval')
    args = ap.parse_args()
    try:
        handoff(args.results, args.stage)
    except (OSError, ValueError, KeyError, IndexError, TypeError) as exc:
        print('Handoff unavailable. Use the output directory of one completed, unedited run.', file=sys.stderr)
        sys.exit(2)

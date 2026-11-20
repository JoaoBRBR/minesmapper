#!/usr/bin/env python3
"""Writes chart-pictures.js from art/chart/*.svg, so art-builder.html can open them with one click.
Run it again after changing a chart picture:  python3 art-sheet/make-chart-list.py"""
import glob, json, os
root = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
files = sorted(glob.glob(os.path.join(root, 'art', 'chart', '*.svg')))
items = [{'name': 'chart/' + os.path.basename(f), 'svg': open(f, encoding='utf-8').read()} for f in files]
out = os.path.join(root, 'art-sheet', 'chart-pictures.js')
with open(out, 'w', encoding='utf-8') as fh:
    fh.write('// Made by make-chart-list.py from art/chart/. Do not edit by hand.\n')
    fh.write('window.CHART_PICTURES = ' + json.dumps(items, ensure_ascii=False, indent=1) + ';\n')
print(len(items), 'chart pictures ->', out)

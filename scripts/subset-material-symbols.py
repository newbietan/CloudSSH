#!/usr/bin/env python3
"""重新裁剪本地图标字体；普通构建不联网、不需要 Python。

依赖：fonttools[woff]。--check 只校验已提交的字体与源码覆盖，不联网。
默认扫描主站和主题编辑器的所有 HTML/TS 词元，兼容模板文本及单双引号。
"""

import argparse
import hashlib
import io
import json
import re
from pathlib import Path
from urllib.request import urlopen

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.ttLib.tables._f_v_a_r import table__f_v_a_r

ROOT = Path(__file__).resolve().parent.parent
FONTS = ROOT / 'frontend/src/assets/fonts'
OUTPUT = FONTS / 'material-symbols-outlined-subset.woff2'
MANIFEST = FONTS / 'material-symbols.json'
SOURCE = ('https://fonts.gstatic.com/s/materialsymbolsoutlined/v383/'
          'kJEPBvYX7BgnkSrUwT8OhrdQw4oELdPIeeII9v6oDMzBwG-RpA6RzaxHMPdY40KH8nGzv3fzfVJO1Q.woff2')
SOURCE_SHA256 = 'c9c3ba449c7ecebd8f289fbc866aafecd5a2e982f8a834588f07cdcf50f029fc'


def ligatures(font):
    cmap = {name: chr(code) for code, name in font.getBestCmap().items()}
    result = {}
    for lookup in font['GSUB'].table.LookupList.Lookup:
        for table in lookup.SubTable:
            table = getattr(table, 'ExtSubTable', table)
            for first, entries in getattr(table, 'ligatures', {}).items():
                for entry in entries:
                    name = cmap.get(first, '') + ''.join(cmap.get(c, '') for c in entry.Component)
                    result[name] = entry.LigGlyph
    return result


def used_icons(catalog):
    paths = [ROOT / 'frontend/index.html', *sorted((ROOT / 'frontend/src').rglob('*.ts')),
             *sorted((ROOT / 'docs/theme-editor').rglob('*.html')),
             *sorted((ROOT / 'docs/theme-editor').rglob('*.js'))]
    tokens = set()
    static_icons = set()
    for path in paths:
        text = path.read_text(encoding='utf-8')
        tokens.update(re.findall(r'\b[a-z][a-z0-9_]{2,}\b', text, re.ASCII))
        static_icons.update(re.findall(
            r'<span\b[^>]*material-symbols-outlined[^>]*>\s*([a-z][a-z0-9_]*)\s*</span>', text))
    unknown = static_icons - set(catalog)
    if unknown:
        raise SystemExit('上游固定字体不包含这些名称，请检查拼写或更新字体版本：' + ', '.join(sorted(unknown)))
    return sorted(tokens & set(catalog))


def check():
    try:
        manifest = json.loads(MANIFEST.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError) as error:
        raise SystemExit('无法读取图标清单，请检查文件或重新裁剪。') from error
    needed = used_icons(manifest['catalog'])
    font = TTFont(OUTPUT)
    missing = set(needed) - ligatures(font).keys()
    if missing:
        raise SystemExit('缺少图标，请重新裁剪：' + ', '.join(sorted(missing)))
    if needed != manifest['icons']:
        raise SystemExit('图标清单与源码不一致，请重新裁剪。')
    if hashlib.sha256(OUTPUT.read_bytes()).hexdigest() != manifest['sha256']:
        raise SystemExit('字体 SHA-256 与清单不一致。')
    fvar = font.get('fvar')
    if not isinstance(fvar, table__f_v_a_r):
        raise SystemExit('字体缺少有效的可变轴表。')
    axes = {axis.axisTag for axis in fvar.axes}
    if not {'FILL', 'wght'} <= axes:
        raise SystemExit('字体丢失 FILL/wght 可变轴。')
    print(f'通过：{len(needed)} 个图标的连字、SHA-256、FILL/wght 可变轴均有效。')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='离线校验，不下载或修改文件')
    parser.add_argument('--source', type=Path, help='使用本地的固定版本完整字体（仍校验 SHA-256）')
    args = parser.parse_args()
    if args.check:
        check()
        return
    if args.source:
        data = args.source.read_bytes()
    else:
        with urlopen(SOURCE, timeout=60) as response:
            data = response.read()
    if hashlib.sha256(data).hexdigest() != SOURCE_SHA256:
        raise SystemExit('上游字体校验失败；请审查版本后再更新固定 URL 与哈希。')
    # 保留上游 head 时间戳，避免相同源码每次裁剪都因当前时间改变字节与哈希。
    font = TTFont(io.BytesIO(data), recalcTimestamp=False)
    catalog = ligatures(font)
    icons = used_icons(catalog)
    if not icons:
        raise SystemExit('未扫描到图标，拒绝覆盖字体。')
    glyphs = {catalog[name] for name in icons}
    glyph_order = set(font.getGlyphOrder())
    glyphs.update({name + '.fill' for name in list(glyphs) if name + '.fill' in glyph_order})
    # 通过库的选项接口设置特殊值（如 name_IDs=['*']），避免依赖默认属性的推断类型。
    # 禁用连字闭包，否则会把完整图标集拉回；所需变体已在上面显式纳入。
    options = subset.Options(
        flavor='woff2',
        layout_features=['rlig', 'liga', 'rvrn', 'kern'],
        layout_closure=False,
        hinting=False,
        name_IDs=['*'],
    )
    subsetter = subset.Subsetter(options)
    subsetter.populate(glyphs=glyphs, unicodes=[ord(c) for c in 'abcdefghijklmnopqrstuvwxyz0123456789_ '])
    subsetter.subset(font)
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    font.save(OUTPUT)
    manifest = {
        'source': SOURCE,
        'sourceSha256': SOURCE_SHA256,
        'sha256': hashlib.sha256(OUTPUT.read_bytes()).hexdigest(),
        'icons': icons,
        # 保留上游可识别的全部名称，令普通 Vitest 无需 Python 即可发现新增的动态/静态图标。
        'catalog': sorted(catalog),
    }
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    check()
    print(f'已写入 {OUTPUT.relative_to(ROOT)}，{OUTPUT.stat().st_size} 字节。')
    print('然后运行 pnpm run sync:theme-editor && pnpm run build:frontend。')


if __name__ == '__main__':
    main()

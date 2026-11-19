"""One-time migration and visual adaptation; never change the source registry."""
import colorsys
import io
import json
import re
import zipfile

from planning_templates import archive, LIMIT, EXPANDED_LIMIT, TemplateError

PREFIX = '/platform/v2/planning-templates'


def color_token(match):
    """Map paint declarations only. Grid geometry and business data stay intact."""
    prop, value = match.group(1), match.group(2)
    background = 'background' in prop or any(name in prop for name in ('--legacy-bg', '--legacy-surface', '--legacy-cloud'))
    border = 'border' in prop or 'outline' in prop or 'line' in prop

    def convert(m):
        raw = m.group()[1:]
        if len(raw) in (3, 4):
            raw = ''.join(c * 2 for c in raw)
        rgb = [int(raw[i:i+2], 16) / 255 for i in (0, 2, 4)]
        hue, light, saturation = colorsys.rgb_to_hls(*rgb)
        hue *= 360
        if border:
            token = 'border'
        elif saturation > .25 and 65 < hue < 170:
            token = 'success-soft' if background and light > .65 else 'success'
        elif saturation > .35 and (hue < 15 or hue > 335):
            token = 'danger-soft' if background and light > .65 else 'danger'
        elif saturation > .35 and 15 <= hue <= 65:
            token = 'warning-soft' if background and light > .65 else 'warning'
        elif background:
            token = 'card' if light > .98 else 'muted' if light > .87 or saturation < .15 else 'primary'
        else:
            token = 'primary-foreground' if light > .9 else 'foreground' if light < .3 else 'primary' if saturation > .45 and 170 <= hue <= 335 else 'muted-foreground' if light > .36 else 'foreground'
        if len(raw) == 8:
            opacity = round(int(raw[6:8], 16) / 255 * 100, 2)
            return f'color-mix(in srgb,var(--{token}) {opacity}%,transparent)'
        return f'var(--{token})'

    value = re.sub(r'#[0-9a-fA-F]{8}\b|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{4}\b|#[0-9a-fA-F]{3}\b', convert, value)
    value = re.sub(r'\bwhite\b', 'var(--card)' if background else 'var(--primary-foreground)', value)
    value = re.sub(r'\bblack\b', 'var(--foreground)', value)
    return prop + ':' + value


def adapt_css(text):
    # Isolate overlapping legacy palette names without touching geometry variables.
    text = re.sub(r'--(nav2?|ink|muted|blue|accent|line|cloud|surface|green|red|gray|bg|text|border)(?![\w-])', r'--legacy-\1', text)
    text = re.sub(r'@import\s+url\(["\']?/platform/fonts/[^)]+\);?', '', text)
    text = re.sub(r'(font-family\s*:)\s*[^;}\n]+', r'\1var(--v2-font)', text)
    return re.sub(r'((?:--[\w-]+|(?:background(?:-color)?|color|border(?:-[\w-]+)?|outline(?:-[\w-]+)?))\s*):([^;{}<>\n]+)', color_token, text)


def migrate_package(payload, source, root, initial=False):
    # Check resource and zip limits before materializing or transforming any entry.
    if len(payload) > LIMIT:
        raise TemplateError('模板包不能超过32MB。', 413)
    with zipfile.ZipFile(io.BytesIO(payload)) as package:
        entries = package.infolist()
        if len(entries) > 512 or sum(item.file_size for item in entries) > EXPANDED_LIMIT:
            raise TemplateError('模板包展开后超过64MB或文件数超过512。')
        files = {item.filename: package.read(item) for item in entries if not item.is_dir()}
    manifest = json.loads(files['manifest.json'])
    if manifest.get('v2Appearance') == 1:
        return payload
    for name, data in list(files.items()):
        if name.endswith(('.html', '.css')):
            text = data.decode('utf-8')
            if name.endswith('.css'):
                text = adapt_css(text)
            else:
                text = re.sub(r'(<style\b[^>]*>)(.*?)(</style>)', lambda m: m[1] + adapt_css(m[2]) + m[3], text, flags=re.S | re.I)
                text = re.sub(r'(style=["\'])(.*?)(["\'])', lambda m: m[1] + adapt_css(m[2]) + m[3], text, flags=re.I)
                # Attach after original styles, retaining all layout declarations.
                text = re.sub(r'</head\s*>', '<link rel="stylesheet" href="/dimension-assets/v2-theme.css"><script src="/dimension-assets/v2-theme.js"></script></head>', text, count=1, flags=re.I)
            files[name] = text.encode()
    appearance = source / 'v2-appearance'
    files['assets/v2-theme.css'] = (appearance / 'theme.css').read_bytes()
    files['assets/v2-theme.js'] = (appearance / 'theme.js').read_bytes()
    files['assets/v2-fonts/noto-sans-sc.css'] = (appearance / 'fonts.css').read_bytes()
    fonts = root / '底层能力/文字/fonts/noto-sans-sc'
    for path in fonts.iterdir():
        if path.suffix in ('.css', '.woff2'):
            files['assets/v2-fonts/' + path.name] = path.read_bytes()
    files['assets/v2-fonts/license.json'] = json.dumps({'license': (fonts / 'OFL.txt').read_text()}, ensure_ascii=False).encode()
    manifest['v2Appearance'] = 1
    if initial:
        manifest['version'] = manifest['version'][:57] + '-v2'
        manifest['label'] = (manifest['label'] + ' · V2.0')[:100]
    files['manifest.json'] = json.dumps(manifest, ensure_ascii=False, indent=2).encode()
    return archive(files)

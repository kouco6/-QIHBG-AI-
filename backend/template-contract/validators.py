def valid_dim01_snapshot(value, *, release=False):
    if not isinstance(value, dict):
        return False
    if isinstance(value.get('matrix'), dict):
        return not release and isinstance(value.get('catalog'), list) and isinstance(value.get('ecos'), list)
    if value.get('version') != 1:
        return False
    rows, cols, fields, cards, groups = (value.get(k) for k in ('rows', 'cols', 'fields', 'cards', 'groups'))

    def named(items, minimum, maximum):
        if not isinstance(items, list) or not minimum <= len(items) <= maximum:
            return False
        if any((not isinstance(item, dict) or not isinstance(item.get('id'), str) or (not item['id']) or (not isinstance(item.get('name'), str)) or (release and (not item['name'].strip())) for item in items)):
            return False
        return len({item['id'] for item in items}) == len(items)
    if not (named(rows, 3, 3) and named(cols, 3, 5) and named(fields, 1, 4) and named(groups, 0, 500)):
        return False
    if not isinstance(cards, dict):
        return False
    slots = {row['id'] + '|' + col['id'] for row in rows for col in cols}
    field_ids = {field['id'] for field in fields}
    states = {'covered', 'uncovered', 'project'}
    if release and len({field['name'].strip() for field in fields}) != len(fields):
        return False
    for slot, card in cards.items():
        if slot not in slots:
            return False
        if card is None:
            continue
        if not isinstance(card, dict) or not isinstance(card.get('title'), str):
            return False
        values, status = (card.get('values'), card.get('status'))
        if not isinstance(values, dict) or set(values) != field_ids or any((not isinstance(v, str) for v in values.values())):
            return False
        if not isinstance(status, str) or status not in (states if release else states | {''}):
            return False
        if release and (not card['title'].strip() or any((not v.strip() for v in values.values()))):
            return False
    for group in groups:
        if not named(group.get('products'), 0, 1000):
            return False
        if any((type(product.get('project')) is not bool for product in group['products'])):
            return False
    return not release or any(cards.values()) or any((group['products'] for group in groups))

def valid_dim02_v1_snapshot(value):
    """The new interactive page accepts incomplete work drafts as well as releases."""

    def field(text, limit=2000):
        return isinstance(text, str) and len(text) <= limit

    def image(value):
        return field(value, 650000) and (not value or re.fullmatch('data:image/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+', value) is not None)
    if not isinstance(value, dict) or not field(value.get('largeName')) or (not image(value.get('largeImage'))):
        return False
    enabled = value.get('enabled')
    if enabled is not None and (not isinstance(enabled, dict) or set(enabled) != {'large', 'scenes'} or any((type(enabled[key]) is not bool for key in ('large', 'scenes')))):
        return False
    systems, scenes = (value.get('systems'), value.get('scenes'))
    if not isinstance(systems, list) or len(systems) > 100 or (not isinstance(scenes, list)) or (len(scenes) > 100):
        return False
    ids = set()

    def unique_id(row):
        item_id = row.get('id')
        if not field(item_id, 120) or not item_id or item_id in ids:
            return False
        ids.add(item_id)
        return True
    for system in systems:
        if not isinstance(system, dict) or not unique_id(system) or (not field(system.get('name'))):
            return False
        devices = system.get('devices')
        if not isinstance(devices, list) or len(devices) > 200:
            return False
        for device in devices:
            if not isinstance(device, dict) or not unique_id(device) or (not field(device.get('name'))) or (device.get('status') not in ('planned', 'existing', 'missing')) or (not image(device.get('image'))):
                return False
    for scene in scenes:
        if not isinstance(scene, dict) or not unique_id(scene) or (not field(scene.get('name'))) or (not image(scene.get('topology'))):
            return False
        for key in ('features', 'needs', 'pains', 'goals'):
            entries = scene.get(key)
            if not isinstance(entries, list) or len(entries) > 200:
                return False
            for entry in entries:
                if not isinstance(entry, dict) or not unique_id(entry):
                    return False
                if key == 'goals':
                    if not field(entry.get('text'), 10000):
                        return False
                elif not field(entry.get('name')) or not field(entry.get('description'), 10000):
                    return False
    return True

def valid_dim02_v1_release(value):
    if not valid_dim02_v1_snapshot(value):
        return False
    large = value.get('enabled', {}).get('large', True)
    scenes = value.get('enabled', {}).get('scenes', True)
    if not large and (not scenes):
        return False
    if 'enabled' in value and (large and (not value['largeImage']) or (scenes and (not value['scenes']))):
        return False
    if large:
        if not value['largeName'].strip() or not value['systems']:
            return False
        for system in value['systems']:
            if not system['name'].strip() or not system['devices'] or any((not device['name'].strip() for device in system['devices'])):
                return False
    names = set()
    for scene in value['scenes'] if scenes else []:
        name = scene['name'].strip().casefold()
        if not name or name in names or (not scene['topology']):
            return False
        names.add(name)
        for key in ('features', 'needs', 'pains', 'goals'):
            if not scene[key]:
                return False
            if key == 'goals':
                if any((not entry['text'].strip() for entry in scene[key])):
                    return False
            elif any((not entry['name'].strip() or not entry['description'].strip() for entry in scene[key])):
                return False
    return True

def valid_dim02_snapshot(value):
    if not isinstance(value, dict):
        return False
    if 'largeName' in value:
        return valid_dim02_v1_snapshot(value)

    def nonempty(text):
        return isinstance(text, str) and bool(text.strip()) and (len(text) <= 2000)
    if not nonempty(value.get('macroTitle')) or not nonempty(value.get('macroIntro')):
        return False
    systems = value.get('systems')
    if not isinstance(systems, list) or len(systems) != 6:
        return False
    for group, count in zip(systems, (4, 4, 3, 2, 3, 1)):
        if not isinstance(group, dict) or not nonempty(group.get('title')) or (not nonempty(group.get('note'))) or (not isinstance(group.get('emoji'), str)):
            return False
        devices = group.get('devices')
        if not isinstance(devices, list) or len(devices) != count:
            return False
        if any((not isinstance(item, dict) or not nonempty(item.get('name')) or item.get('status') not in ('待核实', '企划产品', '已有产品', '未有产品') for item in devices)):
            return False
    hotspots = value.get('hotspots')
    if not isinstance(hotspots, dict) or set(hotspots) != {'receiver', 'chair', 'delegate', 'interpreter', 'camera', 'recorder', 'processor', 'speaker', 'screen', 'host'}:
        return False
    for item in hotspots.values():
        if not isinstance(item, list) or len(item) != 3 or type(item[0]) is not int or (not 0 <= item[0] < 6) or (not nonempty(item[1])) or (not nonempty(item[2])):
            return False
    scenes = value.get('scenes')
    ids = ('nuclear-island', 'conventional-island', 'physical-protection', 'administrative-area', 'emergency-command')
    counts = ((2, 2, 2, 4), (2, 2, 2, 3), (2, 2, 1, 2), (2, 2, 1, 2), (2, 2, 2, 4))
    if not isinstance(scenes, list) or len(scenes) != 5:
        return False
    for scene, scene_id, sizes in zip(scenes, ids, counts):
        if not isinstance(scene, dict) or scene.get('id') != scene_id or (not nonempty(scene.get('name'))) or (not nonempty(scene.get('intro'))):
            return False
        for field, count in zip(('characteristics', 'needs', 'pains'), sizes[:3]):
            rows = scene.get(field)
            if not isinstance(rows, list) or len(rows) != count or any((not isinstance(row, dict) or not nonempty(row.get('keyword')) or (not nonempty(row.get('detail'))) for row in rows)):
                return False
        goals = scene.get('goals')
        if not isinstance(goals, list) or len(goals) != sizes[3] or any((not isinstance(goal, dict) or not nonempty(goal.get('name')) or (not nonempty(goal.get('description'))) or (goal.get('icon') not in ('priority', 'zone', 'monitor', 'shield')) for goal in goals)):
            return False
    return True

def valid_dim03_snapshot(value):
    if isinstance(value, dict) and value.get('format') == 'v5':
        rows = value.get('rows')
        fields = ('name', 'grade', 'expiry', 'owned', 'difficulty', 'barrier')
        return set(value) == {'format', 'rows'} and isinstance(rows, list) and (len(rows) <= 2000) and (len({r.get('id') for r in rows if isinstance(r, dict)}) == len(rows)) and all((isinstance(r, dict) and set(r) == {'id', *fields} and isinstance(r['id'], str) and (0 < len(r['id']) <= 120) and all((isinstance(r[field], str) and len(r[field]) <= 2000 for field in fields)) for r in rows))
    if not isinstance(value, dict) or set(value) != {'groups'}:
        return False
    groups = value['groups']
    if not isinstance(groups, list) or len(groups) != 3:
        return False
    fields = {'资质名称', '资质等级', '有效期', '公司是否拥有', '获取难度', '行业门槛'}
    grades = {'强制性', '市级', '省级', '国家级', '行业', '待核实'}
    for group, group_id, group_name, count in zip(groups, ('product', 'standard', 'enterprise'), ('产品认证', '技术标准', '企业资质'), (8, 6, 6)):
        if not isinstance(group, dict) or set(group) != {'id', 'name', 'items'} or group['id'] != group_id or (group['name'] != group_name):
            return False
        if not isinstance(group['items'], list) or len(group['items']) != count:
            return False
        for item in group['items']:
            if not isinstance(item, dict) or set(item) != fields or any((not isinstance(v, str) or not v.strip() or len(v) > 2000 for v in item.values())):
                return False
            if item['资质等级'] not in grades or item['公司是否拥有'] not in {'是', '否', '待核实'}:
                return False
            if item['获取难度'] not in {'低', '中', '高', '待核实'} or item['行业门槛'] not in {'低', '中', '高', '待核实'}:
                return False
            expiry = item['有效期']
            if expiry not in {'长期', '待核实'} and (not (len(expiry) == 5 and expiry[:4].isdigit() and expiry.endswith('年'))):
                return False
    return True

def valid_dim04_snapshot(value):
    if isinstance(value, dict) and value.get('format') == 'v1.1':
        rows, analysis, evidence = (value.get('rows'), value.get('analysis'), value.get('evidence'))
        fields = ('name', 'source', 'maturity', 'leading', 'barrier', 'value', 'company', 'industry')
        if set(value) != {'format', 'rows', 'analysis', 'evidence'} or not isinstance(rows, list) or len(rows) > 300:
            return False
        if not isinstance(analysis, dict) or not isinstance(evidence, dict) or len(analysis) > 300 or (len(evidence) > 3000):
            return False
        if len({row.get('id') for row in rows if isinstance(row, dict)}) != len(rows):
            return False
        for row in rows:
            if not isinstance(row, dict) or not isinstance(row.get('id'), str) or (not row['id']) or (len(row['id']) > 120):
                return False
            if any((not isinstance(row.get(field), str) or len(row[field]) > 10000 for field in fields)):
                return False
            if type(row.get('aiInitial')) is not bool or type(row.get('companyTouched')) is not bool:
                return False
        for tech in analysis.values():
            if not isinstance(tech, dict) or not isinstance(tech.get('id'), str) or (not isinstance(tech.get('points'), list)) or (len(tech['points']) > 200):
                return False
            for key in ('category', 'subtitle', 'source', 'overall', 'scope'):
                if not isinstance(tech.get(key), str) or len(tech[key]) > 10000:
                    return False
            for point in tech['points']:
                if not isinstance(point, dict) or not isinstance(point.get('id'), str) or (not isinstance(point.get('evidence'), list)) or (len(point['evidence']) > 200):
                    return False
                if any((not isinstance(item, str) for item in point['evidence'])):
                    return False
                if any((not isinstance(point.get(key), str) or len(point[key]) > 10000 for key in ('title', 'summary', 'performance', 'benchmark', 'difference', 'reason', 'value', 'supplement'))):
                    return False
        for source in evidence.values():
            if not isinstance(source, dict) or any((not isinstance(source.get(key), str) or len(source[key]) > 10000 for key in ('id', 'publisher', 'title', 'url', 'where', 'excerpt', 'support', 'note'))):
                return False
        return True
    if not isinstance(value, dict) or set(value) != {'topics'} or (not isinstance(value['topics'], list)) or (len(value['topics']) != 3):
        return False

    def nonempty(text):
        return isinstance(text, str) and bool(text.strip()) and (len(text) <= 2000)
    headings = ('一、技术来源与原理', '二、技术成熟度分析', '三、行业领先程度分析', '四、技术壁垒分析', '五、产品竞争力贡献')
    labels = {'来源类型', '发布方／对象', '版本／条款', '原文出处', '核验状态'}
    topic_fields = {'id', 'kicker', 'title', 'subtitle', 'sections', 'benchmark', 'difference', 'evidence', 'recommendations'}
    for topic, topic_id, rec_count in zip(value['topics'], ('aes67', 'ptp', 'redundancy'), (3, 2, 3)):
        if not isinstance(topic, dict) or set(topic) != topic_fields or topic['id'] != topic_id:
            return False
        if any((not nonempty(topic[field]) for field in ('kicker', 'title', 'subtitle', 'difference'))):
            return False
        sections = topic['sections']
        if not isinstance(sections, list) or len(sections) != 5:
            return False
        for section, heading, count in zip(sections, headings, (2, 1, 1, 1, 1)):
            if not isinstance(section, dict) or set(section) != {'heading', 'paragraphs'} or section['heading'] != heading:
                return False
            if not isinstance(section['paragraphs'], list) or len(section['paragraphs']) != count or any((not nonempty(text) for text in section['paragraphs'])):
                return False
        rows = topic['benchmark']
        if not isinstance(rows, list) or len(rows) != 3:
            return False
        for row, index in zip(rows, range(1, 4)):
            if not isinstance(row, dict) or set(row) != {'metric', 'company', 'industry', 'difference', 'evidenceId'}:
                return False
            if row['evidenceId'] != f'{topic_id}-e-{index:02d}' or any((not nonempty(row[field]) for field in ('metric', 'company', 'industry', 'difference'))):
                return False
        evidence = topic['evidence']
        if not isinstance(evidence, list) or len(evidence) != 3:
            return False
        for item, index in zip(evidence, range(1, 4)):
            if not isinstance(item, dict) or set(item) != {'id', 'title', 'fields'} or item['id'] != f'{topic_id}-e-{index:02d}' or (not nonempty(item['title'])):
                return False
            if not isinstance(item['fields'], dict) or set(item['fields']) != labels or any((not nonempty(v) for v in item['fields'].values())):
                return False
        recommendations = topic['recommendations']
        if not isinstance(recommendations, list) or len(recommendations) != rec_count:
            return False
        if any((not isinstance(item, dict) or set(item) != {'title', 'body', 'confirm'} or any((not nonempty(v) for v in item.values())) for item in recommendations)):
            return False
    return True

def valid_dim_multi_snapshot(dimension_id, value):
    """Keep the sample's field architecture and record identities intact."""
    if dimension_id == 'DIM-06' and isinstance(value, dict) and (value.get('format') == 'v5'):
        fields = ('category', 'product', 'function', 'functional', 'design', 'test', 'competitor', 'experience')
        rows, widths, merges = (value.get('rows'), value.get('widths'), value.get('merges'))
        if set(value) - {'format', 'rows', 'widths', 'merges', 'rowHeights'} or not isinstance(rows, list) or len(rows) > 2000:
            return False
        if not isinstance(widths, list) or len(widths) != 8 or any((type(n) not in (int, float) or not 5 <= n <= 40 for n in widths)) or (not 98 <= sum(widths) <= 102):
            return False
        if len({r.get('id') for r in rows if isinstance(r, dict)}) != len(rows) or any((not isinstance(r, dict) or set(r) != {'id', *fields} or (not isinstance(r['id'], str)) or (not 0 < len(r['id']) <= 120) or any((not isinstance(r[f], str) or len(r[f]) > 10000 for f in fields)) for r in rows)):
            return False
        if not isinstance(merges, list) or len(merges) > 1000 or any((not isinstance(m, dict) or set(m) != {'r', 'c', 'rs', 'cs'} or any((type(m[k]) is not int for k in ('r', 'c', 'rs', 'cs'))) or (m['r'] < 0) or (m['c'] < 0) or (m['rs'] < 1) or (m['cs'] < 1) or (m['r'] + m['rs'] > len(rows)) or (m['c'] + m['cs'] > 8) for m in merges)):
            return False
        heights = value.get('rowHeights', {})
        return isinstance(heights, dict) and all((isinstance(k, str) and type(v) in (int, float) and (28 <= v <= 600) for k, v in heights.items()))
    try:
        seed = json.loads(DIM_MULTI_SEEDS[dimension_id].read_text(encoding='utf-8'))
    except (KeyError, OSError, ValueError):
        return False
    if not isinstance(value, dict) or set(value) != set(seed):
        return False
    product_fields = {'ability_state', 'delivery_state', 'display_label', 'source_state', 'detail', 'raw_research_statement'}
    highlight_fields = {'title', 'category', 'product_scope', 'behavior', 'value', 'boundary'}
    comparison_fields = {'feature', 'legacy', 'pro', 'comparison'}
    performance_fields = {'title', 'point', 'category', 'functional', 'design', 'test', 'competitor', 'experience'}

    def editable(path):
        if dimension_id == 'DIM-05':
            if path in (('scope', 'external_competitor'), ('stats', 'caveat')):
                return True
            if len(path) == 5 and path[0] == 'inventory' and isinstance(path[1], int) and (path[2] == 'features') and isinstance(path[3], int):
                return path[4] == 'feature_name'
            if len(path) == 7 and path[0] == 'inventory' and isinstance(path[1], int) and (path[2] == 'features') and isinstance(path[3], int) and (path[4] == 'products'):
                return path[5] in {'legacy', 'pro', 'a24'} and path[6] in product_fields
            if len(path) == 3 and path[0] == 'highlight_features' and isinstance(path[1], int):
                return path[2] in highlight_fields
            if len(path) == 3 and path[0] == 'comparisons' and isinstance(path[1], int):
                return path[2] in comparison_fields
            return False
        if dimension_id == 'DIM-08':
            return path == ('product',) or path == ('ownCost',) or (len(path) == 3 and path[0] == 'competitors' and isinstance(path[1], int) and (path[2] in {'name', 'model', 'price', 'source', 'url'})) or (len(path) == 3 and path[0] == 'bom' and isinstance(path[1], int) and (path[2] in {'name', 'count', 'unit'}))
        if dimension_id == 'DIM-09':
            return len(path) == 6 and path[0] == 'topics' and isinstance(path[1], int) and (path[2] == 'clauses') and (path[3] in {'甲', '乙', '丙'}) and isinstance(path[4], int) and (path[5] in (1, 2)) or (len(path) == 3 and path[0] == 'points' and isinstance(path[1], int) and (path[2] in {'title', 'require', 'contrast', 'why', 'type'}))
        if dimension_id == 'DIM-10':
            return len(path) == 3 and path[0] == 'original' and isinstance(path[1], int) and (path[2] in {'req', 's'}) or (len(path) == 3 and path[0] == 'topics' and isinstance(path[1], int) and (path[2] == 'name'))
        if dimension_id == 'DIM-11':
            return len(path) == 3 and path[0] == 'products' and isinstance(path[1], int) and (path[2] in {'name', 'model', 'kind', 'imageUrl'}) or (len(path) == 5 and path[0] == 'products' and isinstance(path[1], int) and (path[2] == 'fields') and isinstance(path[3], int) and (path[4] == 'value'))
        if dimension_id == 'DIM-12':
            return path == ('product',) or (len(path) == 2 and path[0] == 'values' and isinstance(path[1], int))
        if len(path) != 3 or path[0] != 'rows' or (not isinstance(path[1], int)):
            return False
        if dimension_id == 'DIM-06':
            return path[2] in performance_fields
        return path[2] in seed['fields']

    def same_shape(actual, original, path=()):
        if isinstance(original, dict):
            return isinstance(actual, dict) and set(actual) == set(original) and all((same_shape(actual[name], item, path + (name,)) for name, item in original.items()))
        if isinstance(original, list):
            return isinstance(actual, list) and len(actual) == len(original) and all((same_shape(a, b, path + (index,)) for index, (a, b) in enumerate(zip(actual, original))))
        if isinstance(original, str):
            max_length = 800000 if dimension_id == 'DIM-11' and path[-1:] == ('imageUrl',) else 5000
            blank_work_text = dimension_id == 'DIM-12' and path == ('values', 15)
            if not isinstance(actual, str) or (not blank_work_text and (not actual.strip())) or len(actual) > max_length:
                return False
            if editable(path):
                if dimension_id == 'DIM-11' and path[-1] == 'imageUrl' and (not (actual == 'sample' or (actual.startswith(('https://', 'http://')) and len(actual) <= 2000) or re.fullmatch('data:image/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+', actual))):
                    return False
                if dimension_id == 'DIM-12' and path[:1] == ('values',) and (path[1] != 15) and (actual not in {'yes', 'no', 'pending', 'na'}):
                    return False
                if path[-1] == 'url' and (not actual.startswith(('https://', 'http://'))):
                    return False
                if dimension_id == 'DIM-09' and path[-1] == 'type' and (actual not in {'性能', '功能', '架构', '接口'}):
                    return False
                if dimension_id == 'DIM-09' and path[-1] == 2 and (actual not in {'完全满足', '特做满足：低成本/短周期', '特做满足：高成本/长周期', '无法', '待核实'}):
                    return False
                if dimension_id == 'DIM-10' and path[-1] == 's' and (actual not in {'full', 'low', 'high', 'none'}):
                    return False
            return editable(path) or actual == original
        if isinstance(original, (int, float)) and editable(path):
            return type(actual) in (int, float) and 0 <= actual <= 1000000000 and (path[-1] != 'count' or type(actual) is int)
        return type(actual) is type(original) and actual == original
    if dimension_id in ('DIM-06', 'DIM-07') and value.get('fields') != seed['fields']:
        return False
    if dimension_id == 'DIM-06' and any((actual.get('id') != original['id'] for actual, original in zip(value.get('rows', []), seed['rows']))):
        return False
    return same_shape(value, seed)

"""Shared catalog persistence, concurrency, Excel import, and live account authorization."""
import concurrent.futures
import http.client
import io
import json
import tempfile
import threading
import unittest
import zipfile
from pathlib import Path
from types import SimpleNamespace
from xml.sax.saxutils import escape

import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"backend"))
from exhibitions import Exhibitions, ExhibitionError, PREFIX, read_xlsx
from http_server import Server

ADMIN = {'id': 'admin', 'name': '管理员', 'role': 'admin'}
MEMBER = {'id': 'member', 'name': '企划同事', 'role': 'user'}


def record(**changes):
    return dict(name='2026测试展会', venue='测试展馆', group='推荐',
                startDate='2026-11-27', endDate='2026-12-06', **changes)


def workbook():
    """Blank cells inside merged groups and hidden hyperlink targets reproduce source quirks."""
    headers = ['分类', '序号', '展会名称', '展会分类', '展会时间', '展会展馆',
               '推荐度', '级别', '主要内容', '展会规模', '参展商', '网站']
    values = [
        headers,
        ['AI机器人展会', 1, '2026机器人展', '科技', '2026年11月27日—12月06日', '展馆甲',
         '★★★★', '国际级', '机器人与养老', '展览面积：30000+㎡；\n参展观众：60000人次\n参展商：490余家', '/', '/'],
        ['', 2, '2027年份待核对展', '科技', '2026年11月19日—11月21日', '展馆乙'],
        ['推荐展会', 3, '无效日期展', '科技', '2026年11月30日—11月02日', '展馆丙'],
    ]
    rows = []
    for rn, vals in enumerate(values, 1):
        cells = ''.join('<c r="'+chr(65+i)+str(rn)+'" t="inlineStr"><is><t>'+escape(str(v))+'</t></is></c>'
                        for i, v in enumerate(vals))
        rows.append('<row r="'+str(rn)+'">'+cells+'</row>')
    root = ('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
            '<sheetData>'+''.join(rows)+'</sheetData><mergeCells><mergeCell ref="A2:A3"/></mergeCells>'
            '<hyperlinks><hyperlink ref="L2" r:id="web"/></hyperlinks></worksheet>')
    out = io.BytesIO()
    with zipfile.ZipFile(out, 'w') as z:
        z.writestr('xl/workbook.xml', '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
                   'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
                   '<sheets><sheet name="展会" sheetId="1" r:id="s1"/></sheets></workbook>')
        z.writestr('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="s1" Target="worksheets/sheet1.xml"/></Relationships>')
        z.writestr('xl/worksheets/sheet1.xml', root)
        z.writestr('xl/worksheets/_rels/sheet1.xml.rels', '<Relationships><Relationship Id="web" Target="https://example.org/expo" TargetMode="External"/></Relationships>')
    return out.getvalue()


class CatalogTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Exhibitions(Path(self.tmp.name))

    def tearDown(self):
        self.tmp.cleanup()

    def test_import_merged_categories_hyperlinks_units_and_repeat_skip(self):
        imported = self.store.import_xlsx(workbook(), '调研.xlsx', ADMIN)
        self.assertEqual((imported['added'], imported['skipped'], imported['failed']), (2, 0, 1))
        self.assertEqual(len(imported['warnings']), 1)
        listing = self.store.listing(ADMIN)
        self.assertEqual([t['name'] for t in listing['topics']], ['AI机器人'])
        self.assertTrue(all(i['group'] == '推荐' and len(i['topicIds']) == 1 for i in listing['items']))
        item = next(i for i in listing['items'] if i['name'] == '2026机器人展')
        self.assertEqual(item['endDate'], '2026-12-06')
        self.assertEqual((item['area'], item['visitors'], item['exhibitorCount']), ('30000+㎡', '60000人次', '490余家'))
        self.assertEqual(item['website'], 'https://example.org/expo')
        self.store.save(item | {'reason': '页面手动调整'}, MEMBER, item['id'], item['revision'])
        repeated = self.store.import_xlsx(workbook(), '调研.xlsx', ADMIN)
        self.assertEqual((repeated['added'], repeated['skipped'], repeated['failed']), (0, 2, 1))
        self.assertEqual(next(i for i in self.store.listing(ADMIN)['items'] if i['id'] == item['id'])['reason'], '页面手动调整')

    def test_concurrent_update_prevents_lost_writes_and_survives_restart(self):
        record_id = self.store.save(record(), ADMIN)['id']
        def write(reason):
            try:
                self.store.save(record(reason=reason), MEMBER, record_id, 1)
                return True
            except ExhibitionError as exc:
                self.assertEqual(exc.status, 409)
                return False
        with concurrent.futures.ThreadPoolExecutor(2) as pool:
            self.assertEqual(sum(pool.map(write, ['修改甲', '修改乙'])), 1)
        item = Exhibitions(Path(self.tmp.name)).listing(ADMIN)['items'][0]
        self.assertEqual(item['revision'], 2)
        self.assertEqual(item['updatedBy'], '企划同事')

    def test_archive_restore_topic_rename_delete_and_stale_edits(self):
        topic_id = self.store.topic({'action': 'create', 'name': '专题甲'}, ADMIN)['id']
        record_id = self.store.save(record(topicIds=[topic_id]), ADMIN)['id']
        self.store.topic({'action': 'rename', 'id': topic_id, 'revision': 1, 'name': '专题乙'}, ADMIN)
        self.assertEqual(self.store.listing(ADMIN)['topics'][0]['name'], '专题乙')
        with self.assertRaises(ExhibitionError):
            self.store.topic({'action': 'delete', 'id': topic_id, 'revision': 1}, ADMIN)
        self.store.topic({'action': 'delete', 'id': topic_id, 'revision': 2}, ADMIN)
        item = self.store.listing(ADMIN)['items'][0]
        self.assertEqual(item['topicIds'], [])
        self.assertEqual(item['revision'], 2)
        with self.assertRaises(ExhibitionError):
            self.store.save(record(topicIds=[topic_id]), ADMIN, record_id, 1)
        self.store.archive(record_id, 2, True, ADMIN)
        self.assertTrue(self.store.listing(ADMIN)['items'][0]['archived'])
        self.store.archive(record_id, 3, False, MEMBER)
        self.assertFalse(self.store.listing(ADMIN)['items'][0]['archived'])
        with self.assertRaises(ExhibitionError):
            self.store.save(record(), ADMIN)

    def test_dates_urls_stars_and_tbd_validation(self):
        invalid = [{'endDate': '2026-11-01'}, {'startDate': ''}, {'website': 'javascript:alert(1)'},
                   {'rating': True}, {'rating': 0}, {'group': '其他'}, {'venue': ''},
                   {'startDate': '2026-02-30'}, {'schedule': 'tbd'}]
        for change in invalid:
            with self.subTest(change=change), self.assertRaises(ExhibitionError):
                raw = record();raw.update(change);self.store.save(raw, ADMIN)
        raw = record();raw.update(startDate='', endDate='', schedule='postponed')
        self.store.save(raw, ADMIN)
        self.assertEqual(self.store.listing(ADMIN)['items'][0]['schedule'], 'postponed')
        with self.assertRaises(ExhibitionError):
            read_xlsx(b'not xlsx')



if __name__ == "__main__": unittest.main()

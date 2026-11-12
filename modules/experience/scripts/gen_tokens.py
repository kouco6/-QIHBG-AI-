# -*- coding: utf-8 -*-
"""从单一令牌源生成 tokens.css + tokens.json，并做同源一致性校验。"""
import json, io, os, re

BASE = r"E:\AI work\tiyanwork-design\design"
os.makedirs(BASE, exist_ok=True)

# ============ 单一令牌源（category.key = value）============
T = {}
def put(cat, key, val, note):
    T[(cat, key)] = (val, note)

# ---- color.brand ----
put("color","brand.primary","#1470E8","品牌主色·itc 蓝（取自 11.png 看板 #1870E8 与 22.png #1068F0 校准中值）")
put("color","brand.primaryHover","#0F5FD4","主按钮悬停")
put("color","brand.primaryActive","#0B4FB4","主按钮按下")
put("color","brand.primaryLight","#E8F1FE","选中态浅蓝底/信息浅底")
put("color","brand.primaryBorder","#B4D0F8","品牌浅描边/信息边框")
put("color","brand.gradient","linear-gradient(135deg,#2B82F0 0%,#0F5FD4 100%)","主按钮渐变·克制的科技光感")
put("color","brand.atmosphere","#EAF2FE","登录页淡蓝氛围底")
put("color","brand.atmosphereGradient","linear-gradient(160deg,#DCE9FD 0%,#EAF2FE 45%,#FFFFFF 100%)","登录页背景渐变（参考 33.png）")
put("color","brand.accentRed","#E02028","logo 品牌点缀红（仅 logo 场景）")
# ---- color.surface ----
put("color","surface.page","#F4F7FB","页面底")
put("color","surface.card","#FFFFFF","卡片")
put("color","surface.sunken","#F7F9FC","表头/输入底/下沉区")
put("color","surface.mask","rgba(15,34,65,0.45)","弹窗遮罩")
# ---- color.text ----
put("color","text.primary","#1B2A46","主文字")
put("color","text.secondary","#51617D","次级文字")
put("color","text.tertiary","#8595AF","弱文字/辅助说明")
put("color","text.disabled","#B9C4D6","禁用文字")
put("color","text.inverse","#FFFFFF","反白文字")
put("color","text.brand","#1470E8","品牌文字/链接")
# ---- color.border ----
put("color","border.default","#E4EAF3","常规描边")
put("color","border.strong","#CDD7E4","强调描边")
put("color","border.focus","#1470E8","聚焦描边")
# ---- color.status ----
put("color","status.info","#1470E8","信息");            put("color","status.infoBg","#E8F1FE","信息浅底")
put("color","status.success","#12A35B","成功/达标");     put("color","status.successBg","#E3F7ED","成功浅底")
put("color","status.warning","#E8930C","警告/临期");     put("color","status.warningBg","#FDF1DE","警告浅底")
put("color","status.danger","#D9382E","危险/逾期");      put("color","status.dangerBg","#FCE9E7","危险浅底")
# ---- color.issue（问题等级，致命→轻微）----
put("color","issue.fatal","#C2372E","致命·深红");        put("color","issue.fatalBg","#FBE9E8","致命浅底")
put("color","issue.serious","#E8632C","严重·橙红");      put("color","issue.seriousBg","#FDEDE4","严重浅底")
put("color","issue.moderate","#F5A623","一般·琥珀");     put("color","issue.moderateBg","#FEF5E0","一般浅底")
put("color","issue.minor","#64748F","轻微·灰蓝");        put("color","issue.minorBg","#EEF1F6","轻微浅底")
# ---- color.chart（图表功能色序）----
put("color","chart.c1","#1470E8","图表色1·蓝（品牌序列首色）")
put("color","chart.c2","#00B8C0","图表色2·青")
put("color","chart.c3","#7C4DE0","图表色3·紫")
put("color","chart.c4","#3FC070","图表色4·绿")
put("color","chart.c5","#F08800","图表色5·橙")
put("color","chart.c6","#E8638C","图表色6·品红")
put("color","chart.c2Bg","#E0F7F8","图表色2·青 浅底（L2 产品线徽章）")
put("color","chart.c3Bg","#EEE8FB","图表色3·紫 浅底")
put("color","chart.c5Bg","#FEF0DC","图表色5·橙 浅底（L3 事业部徽章）")
put("color","chart.gridline","#EDF1F7","图表网格线")
put("color","chart.glowFill","linear-gradient(180deg,rgba(20,112,232,0.28) 0%,rgba(20,112,232,0.02) 100%)","面积图渐变填充")
# ---- typography ----
put("typography","family","-apple-system,'Segoe UI','Microsoft YaHei','PingFang SC','Noto Sans SC',sans-serif","正文中文系统栈")
put("typography","numNumeric","tabular-nums","数字等宽（font-variant-numeric 用值）")
put("typography","numFeature","'tnum' 1","数字特性（font-feature-settings 用值）")
put("typography","size.xs","12px","辅助说明");   put("typography","size.sm","13px","表格/紧凑正文")
put("typography","size.md","14px","正文默认");   put("typography","size.lg","16px","小标题/卡片标题")
put("typography","size.xl","20px","页面区块标题"); put("typography","size.xxl","28px","统计大数字")
put("typography","size.display","40px","登录页/BEI 总分")
put("typography","weight.regular","400","常规"); put("typography","weight.medium","500","中等")
put("typography","weight.semibold","600","强调"); put("typography","weight.bold","700","大数字/标题")
put("typography","lineHeight.tight","1.3","标题"); put("typography","lineHeight.normal","1.55","正文")
put("typography","lineHeight.relaxed","1.75","说明段落")
# ---- spacing ----
for k,v,note in [("1","4px","微间距"),("2","8px","紧凑"),("3","12px","组件内"),("4","16px","组件间"),
                 ("5","20px","区块内"),("6","24px","区块间"),("8","32px","大区块"),("10","40px","页面边距")]:
    put("spacing",k,v,note)
# ---- radius ----
put("radius","sm","6px","小元素/标签"); put("radius","md","8px","按钮/输入")
put("radius","lg","12px","卡片");       put("radius","xl","16px","登录卡/弹窗")
put("radius","pill","999px","胶囊")
# ---- border width ----
put("border","width","1px","统一描边宽度")
# ---- shadow ----
put("shadow","sm","0 1px 2px rgba(16,42,83,0.06)","元素微影")
put("shadow","md","0 4px 12px rgba(16,42,83,0.08)","卡片默认")
put("shadow","lg","0 12px 32px rgba(16,42,83,0.12)","卡片悬停/下拉")
put("shadow","pop","0 16px 48px rgba(16,42,83,0.16)","弹窗")
# ---- glow（科技光感，克制）----
put("glow","number","0 0 12px rgba(20,112,232,0.35)","关键指标数字微发光（仅统计卡大数字）")
put("glow","selected","0 0 0 3px rgba(20,112,232,0.15)","选中/聚焦光晕")
put("glow","cardHover","0 8px 24px rgba(20,112,232,0.10)","可交互卡片悬停")
put("glow","primaryBtn","0 4px 14px rgba(20,112,232,0.30)","主行动按钮")
# ---- motion ----
put("motion","fast","0.15s","悬停/按下"); put("motion","base","0.25s","展开/切换"); put("motion","slow","0.4s","弹窗")
put("motion","ease","cubic-bezier(0.4,0,0.2,1)","统一缓动")
# ---- zIndex ----
for k,v,note in [("dropdown","1000","下拉"),("sticky","1020","吸顶"),("overlay","1040","抽屉/遮罩"),("modal","1060","弹窗"),("toast","1080","全局提示")]:
    put("zIndex",k,v,note)

# ============ 生成 tokens.json（嵌套结构）============
def nest():
    root = {}
    for (cat,key),(val,note) in sorted(T.items()):
        parts = cat.split(".") + key.split(".")
        d = root
        for p in parts[:-1]:
            d = d.setdefault(p, {})
        d[parts[-1]] = {"value": val, "description": note}
    return root

# ============ 生成 tokens.css ============
def css():
    lines = ["/**",
             " * 体验工作台 · itc 浅色科技风 · 设计令牌",
             " * 单一来源生成（与 tokens.json 同源同步），勿手改；再生成请运行 gen_tokens.py",
             " * 品牌蓝取色依据：E:\\AI work\\设计体系\\11.png 看板 #1870E8 与 22.png #1068F0 校准中值 #1470E8",
             " */",
             ":root {"]
    for (cat,key),(val,note) in sorted(T.items()):
        name = "--" + (cat + "." + key).replace(".", "-")
        lines.append(f"  {name}: {val}; /* {note} */")
    lines.append("}")
    # 通用工具类
    lines += ["",
      "/* 数字等宽工具类（表格/统计数字必用） */",
      ".num, td.num, th.num { font-variant-numeric: var(--typography-numNumeric); font-feature-settings: var(--typography-numFeature); }",
      "/* 关键指标光感（仅用于统计卡大数字/BEI 总分） */",
      ".glow-number { text-shadow: var(--glow-number); }",
      "/* 聚焦光晕 */",
      ".glow-selected { box-shadow: var(--glow-selected); }"]
    return "\n".join(lines) + "\n"

j = nest()
io.open(os.path.join(BASE,"tokens.json"),"w",encoding="utf-8").write(json.dumps(j, ensure_ascii=False, indent=2))
io.open(os.path.join(BASE,"tokens.css"),"w",encoding="utf-8").write(css())

# ============ 一致性校验 ============
css_txt = io.open(os.path.join(BASE,"tokens.css"),encoding="utf-8").read()
css_vars = {k.lower(): v for k, v in re.findall(r"--([A-Za-z0-9\-]+):\s*([^;]+);", css_txt)}
json_flat = {}
def walk(d, prefix=""):
    for k,v in d.items():
        if isinstance(v, dict) and "value" not in v:
            walk(v, prefix + k + "-")
        else:
            json_flat[(prefix + k).lower()] = str(v["value"]).strip()
walk(j)
mismatch = []
for name, val in json_flat.items():
    cv = css_vars.get(name)
    if cv is None:
        mismatch.append(("MISSING_IN_CSS", name))
    elif cv.strip() != val:
        mismatch.append(("VALUE_DIFF", name, cv, val))
extra = [n for n in css_vars if n not in json_flat]

colors = [1 for (c,k) in T if c == "color"]
sizes  = [1 for (c,k) in T if c == "typography" and k.startswith("size.")]
spac   = [1 for (c,k) in T if c == "spacing"]
print(f"token 总数: {len(T)} | 颜色: {len(colors)} | 字阶: {len(sizes)} | 间距: {len(spac)}")
print(f"CSS 变量: {len(css_vars)} | JSON 叶子: {len(json_flat)} | 不一致: {len(mismatch)} | CSS 多出: {len(extra)}")
for m in mismatch[:10]: print("  !!", m)
print("JSON 解析:", "OK" if json.loads(io.open(os.path.join(BASE,"tokens.json"),encoding="utf-8").read()) else "?")

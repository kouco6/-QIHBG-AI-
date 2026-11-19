export const typeColumns = [
  { key: 'name', label: '名称', type: 'text' },
  { key: 'detail', label: '说明', type: 'longText' },
  { key: 'amount', label: '金额', type: 'number', format: 'money' },
  { key: 'ratio', label: '占比', type: 'number', format: 'percent' },
  { key: 'due', label: '日期', type: 'date' },
  { key: 'level', label: '等级', type: 'singleSelect', options: ['低', '中', '高', '待核实'] },
  { key: 'url', label: '链接', type: 'link' },
  { key: 'score', label: '测算', type: 'number', format: 'number', readonly: true },
]

export const typeRows = [
  { id: 'q-1', values: { name: '建筑资质甲', detail: '可原位修改的短说明。', amount: 1280.5, ratio: 12.5, due: '2026-06-30', level: '高', url: 'https://example.com/a', score: 36 } },
  { id: 'q-2', values: { name: '安全生产许可', detail: '长文本在格内换行，用来看行高和冻结是否还在。', amount: 860, ratio: 8, due: '2027-01-15', level: '中', url: 'https://example.com/b', score: 21 } },
  { id: 'q-3', values: { name: '行业认证', detail: '测算列由调用方传入，表内不能改。', amount: 240, ratio: 3, due: '2026-12-01', level: '待核实', url: 'https://example.com/c', score: 9 } },
  { id: 'q-4', values: { name: '检测报告', detail: '', amount: null, ratio: null, due: '', level: '低', url: '', score: null } },
]

export const wideColumns = [
  { key: 'item', label: '功能点', type: 'text' },
  { key: 'functional', label: '功能性能', type: 'longText' },
  { key: 'design', label: '设计指标', type: 'longText' },
  { key: 'test', label: '测试指标', type: 'longText' },
  { key: 'competitor', label: '竞品指标', type: 'longText' },
  { key: 'experience', label: '体验性指标', type: 'longText' },
  { key: 'note', label: '补充说明', type: 'longText' },
  { key: 'owner', label: '责任人', type: 'text' },
]

const paragraph = '连续长文本用来检查宽表的换行、横向滚动和首列冻结。内容本身不代表正式企划，只给试看页压密度。'

export const wideRows = Array.from({ length: 12 }, (_, index) => ({
  id: `w-${index + 1}`,
  values: {
    item: `性能点 ${index + 1}`,
    functional: `${paragraph}功能侧第 ${index + 1} 行。`,
    design: `${paragraph}设计侧需要能看全，而不是被截成一行。`,
    test: `${paragraph}测试口径保持可读。`,
    competitor: `${paragraph}竞品描述只是占位。`,
    experience: `${paragraph}体验描述用来把行撑高。`,
    note: index % 3 === 0 ? '这一行额外多一句，避免每行高度看起来完全一样。' : '',
    owner: index % 2 === 0 ? '企划' : '研发',
  },
}))

export const sampleErrors = {
  'q-1': { amount: '金额需要核对来源' },
  'q-2': { level: '等级还不能确认' },
}

export const dim06Columns = [
  { key: 'category', label: '性能分类', type: 'text' },
  { key: 'product', label: '产品名', type: 'text' },
  { key: 'function', label: '功能', type: 'text' },
  { key: 'functional', label: '功能性', type: 'longText' },
  { key: 'design', label: '设计指标', type: 'longText' },
  { key: 'test', label: '测试指标', type: 'longText' },
  { key: 'competitor', label: '竞品指标', type: 'longText' },
  { key: 'experience', label: '体验指标', type: 'longText' },
]

export const dim06Widths = [9, 12, 10, 14, 15, 17, 12, 11]

export const dim06Rows = [
  { id: 'r1', values: { category: '无线传输', product: 'U段可拔插会议麦克风', function: '无线发言', functional: '端到端传输延时：满足会议实时发言与扩声响应。', design: '规划延时≤30ms（演示目标）。', test: '规定信道、距离和采样配置，分别记录平均延时、最大延时及波动。', competitor: '竞品A标称≤25ms（假设示例；测试口径未核实）。', experience: '讲话后扩声无明显迟滞，支持自然互动。' } },
  { id: 'r2', values: { category: '', product: '', function: '', functional: '工作距离及稳定性：移动发言期间维持连续语音连接。', design: '开阔条件下规划≥50m（演示目标）。', test: '测量典型距离、遮挡和干扰环境下的断音次数及恢复时间。', competitor: '竞品B标称50m（假设示例；条件未统一）。', experience: '调整站位时语音连续，无需反复重讲。' } },
  { id: 'r3', values: { category: '音频性能', product: '', function: '语音拾音', functional: '语音信噪比：在会议环境下拾取清晰人声。', design: '信噪比规划≥90dB（演示目标）。', test: '明确测试带宽、计权、输入声压和增益，记录测量结果。', competitor: '竞品A标称95dB（假设示例；条件未核实）。', experience: '正常音量讲话清楚，安静场景底噪不明显。' } },
  { id: 'r4', values: { category: '', product: '', function: '', functional: '频率响应：关键人声频段拾取与传输保持均衡。', design: '响应范围及容差结合音头、算法和工作形态确定。', test: '分别测量桌面态与手持态频响曲线，记录输入电平及测量条件。', competitor: '竞品频率范围需按相同容差条件对比。', experience: '不同声线自然可辨，避免明显发闷或尖锐。' } },
  { id: 'r5', values: { category: '续航与供电', product: '无线会议终端', function: '电池供电', functional: '连续工作续航：支持长会议使用。', design: '规划续航≥8小时（演示目标）。', test: '规定发言占空比、发射功率及截止电量，记录持续工作时间。', competitor: '竞品A标称10小时（假设示例）。', experience: '覆盖较长会议，减少中途补电。' } },
  { id: 'r6', values: { category: '', product: '', function: '', functional: '充电性能：在规定供电条件下可靠充满。', design: '充电时长由电池容量及充电安全设计共同确定。', test: '记录充电器输出、环境温度、初始电量、充满时间与温升。', competitor: '竞品充电指标需结合容量与适配器口径比较。', experience: '电量状态清楚，便于使用者安排充电。' } },
  { id: 'r7', values: { category: '可靠性', product: '', function: '连续运行', functional: '运行稳定性：支持连续会议及频繁操作。', design: '连续72小时仅作为测试时长示例。', test: '循环执行发言、静音、模式切换，记录异常重启、断链与恢复时间。', competitor: '公开可靠性数据不足，暂不作排名。', experience: '长时间运行无需频繁重启。' } },
  { id: 'r8', values: { category: '', product: '', function: '', functional: '温湿度适应：规定室内环境下维持基本功能。', design: '工作温湿度目标依据器件选型确定。', test: '在预设高低温及湿度条件下重复测试语音传输、按键响应和连接恢复。', competitor: '仅比较相同条件下的竞品规格。', experience: '日常空调与季节变化中工作稳定。' } },
]

export const dim06Merges = [
  { r: 0, c: 0, rs: 2, cs: 1 },
  { r: 2, c: 0, rs: 2, cs: 1 },
  { r: 4, c: 0, rs: 2, cs: 1 },
  { r: 6, c: 0, rs: 2, cs: 1 },
  { r: 0, c: 1, rs: 4, cs: 1 },
  { r: 4, c: 1, rs: 4, cs: 1 },
  { r: 0, c: 2, rs: 2, cs: 1 },
  { r: 2, c: 2, rs: 2, cs: 1 },
  { r: 4, c: 2, rs: 2, cs: 1 },
  { r: 6, c: 2, rs: 2, cs: 1 },
]


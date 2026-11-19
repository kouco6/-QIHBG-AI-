/**
 * 可选头像库。
 *
 * 内置三位（Codex / 豆包 / Kimi）有各自的固定头像；用户新建的员工默认只有
 * 一个「名字首字」的圆形兜底，在卡片墙上很难认。这里开放 10 个同风格的
 * 机器人头像，存在员工配置的 avatar 字段里（只存 key，不存路径）。
 *
 * 只认白名单：文件是静态资源，随便传一个 key 进来会变成 404 空图。
 */

export const AVATAR_PRESETS = [
  { key: "amber", label: "琥珀" },
  { key: "coral", label: "珊瑚" },
  { key: "violet", label: "紫罗兰" },
  { key: "indigo", label: "靛蓝" },
  { key: "sky", label: "天空" },
  { key: "cyan", label: "青碧" },
  { key: "lime", label: "青柠" },
  { key: "graphite", label: "石墨" },
  { key: "ink", label: "墨黑" },
  { key: "cocoa", label: "可可" },
];

const KEYS = new Set(AVATAR_PRESETS.map((item) => item.key));

/** 内置员工的默认头像；用户没选过时用它。 */
const BUILTIN_AVATARS = { codex: "codex", doubao: "doubao", kimi: "kimi" };

export const isAvatarKey = (value) => KEYS.has(String(value ?? ""));

/** 空串 / null / 未知 key 一律按「没选」处理，读配置时不至于炸。 */
export const normalizeAvatar = (value) => (isAvatarKey(value) ? String(value) : null);

/** 实际要加载的图：用户选的优先，其次是内置默认，都没有就返回 null（走首字兜底）。 */
export const resolveAvatar = (id, configured) =>
  normalizeAvatar(configured) ?? BUILTIN_AVATARS[id] ?? null;

export async function renderPeopleSection(host) {
  if (!host) return;
  host.replaceChildren();
  const text = document.createElement("p");
  text.className = "ppl-note";
  text.textContent = "账号、身份及启停由平台人员管理统一维护。执行器凭证请在执行器页面通过“连接我的执行器”获取。";
  host.append(text);
}

const form = document.getElementById("loginForm");
const err = document.getElementById("loginError");
const btn = document.getElementById("loginBtn");

const nextUrl = () => {
  const next = new URLSearchParams(location.search).get("next");
  return next && next.startsWith("/") ? next : "/";
};

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  err.hidden = true;
  btn.disabled = true;
  btn.textContent = "登录中…";
  try {
    const resp = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: form.username.value.trim(),
        password: form.password.value,
      }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      err.textContent = data.error || "登录失败";
      err.hidden = false;
      btn.disabled = false;
      btn.textContent = "登 录";
      return;
    }
    location.replace(nextUrl());
  } catch {
    err.textContent = "网络异常，稍后再试";
    err.hidden = false;
    btn.disabled = false;
    btn.textContent = "登 录";
  }
});

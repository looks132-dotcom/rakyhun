const q = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
let mode = "login",
  config = {};
async function request(path, data) {
  const r = await fetch(path, {
    method: data ? "POST" : "GET",
    headers: data ? { "Content-Type": "application/json" } : {},
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  const b = await r.json();
  if (!r.ok) throw Error(b.error);
  return b;
}
function setMode(value) {
  mode = value;
  document
    .querySelectorAll(".register-only")
    .forEach((e) => e.classList.toggle("hidden", mode !== "register"));
  q("#invite-label").classList.toggle(
    "hidden",
    mode !== "register" || (config.firstUser && !config.requiresSetupCode),
  );
  q("#tab-login").classList.toggle("selected", mode === "login");
  q("#tab-register").classList.toggle("selected", mode === "register");
  q("#auth-submit").textContent =
    mode === "register" ? "계정 만들고 시작하기" : "로그인하기";
  q("[name=password]").autocomplete =
    mode === "register" ? "new-password" : "current-password";
  q("#auth-error").textContent = "";
  q("#signup-help").textContent =
    config.mode === "local"
      ? "이 계정은 이 PC에서만 사용해요. 로그인 후 모임 초대 코드로 사내 동료와 연결하세요."
      : config.firstUser
        ? "최초 관리자 계정은 서비스의 초기 설정 코드가 필요해요. 이후 직원은 초대 코드로 가입해요."
        : "초대받은 직원만 함께할 수 있어요.";
}
function success() {
  q("#auth-form").classList.add("hidden");
  q("#google-area").classList.add("hidden");
  q("#login-success").classList.remove("hidden");
  q("#login-title").textContent = "우리의 오피스로.";
  q("#success-text").textContent = params.get("device")
    ? "설치된 뭉글 앱에 연결 중이에요. 앱으로 돌아가 주세요."
    : "아래 버튼으로 웹 오피스를 열 수 있어요.";
}
q("#tab-login").onclick = () => setMode("login");
q("#tab-register").onclick = () => setMode("register");
q("#auth-form").onsubmit = async (e) => {
  e.preventDefault();
  const b = q("#auth-submit");
  b.disabled = true;
  q("#auth-error").textContent = "";
  try {
    const f = new FormData(e.target);
    await request("/api/auth/" + (mode === "register" ? "register" : "login"), {
      username: f.get("username"),
      password: f.get("password"),
      name: f.get("name"),
      invite: f.get("invite"),
      remember: f.get("remember") === "on",
      deviceId: params.get("device"),
    });
    success();
  } catch (error) {
    q("#auth-error").textContent = error.message;
  } finally {
    b.disabled = false;
  }
};
(async () => {
  try {
    config = await request("/api/config");
    setMode(config.firstUser ? "register" : "login");
    q("#google-area").classList.toggle("hidden", !config.google);
    q("#google-login").onclick = (e) => {
      const invite = q("[name=invite]").value;
      const target = new URL("/auth/google", location.origin);
      if (params.get("device"))
        target.searchParams.set("device", params.get("device"));
      if (invite) target.searchParams.set("invite", invite);
      e.currentTarget.href = target.href;
    };
    try {
      await request("/api/me");
      if (params.get("device"))
        await request("/api/auth/link", {
          deviceId: params.get("device"),
          remember: true,
        });
      success();
    } catch {}
  } catch {
    q("#auth-error").textContent =
      "중앙 서비스에 연결할 수 없어요. 잠시 후 다시 시도해 주세요.";
  }
})();

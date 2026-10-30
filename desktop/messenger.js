const $ = (s) => document.querySelector(s);
let roomId = "",
  state,
  refreshing = false,
  signature = "";
function el(tag, cls, value) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (value !== undefined) e.textContent = value;
  return e;
}
async function api(path, data) {
  const r = await window.moongle.api(path, data);
  if (r.error) throw Error(r.error);
  return r;
}
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    state = await window.moongle.messengerState(roomId);
    roomId = state.roomId;
    $("#connection").textContent =
      state.status === "offline"
        ? "퇴근 상태 · 기존 기록을 확인할 수 있어요"
        : "사내 직접 연결 · " +
          state.people.filter((p) => p.status !== "offline").length +
          "명 접속";
    $("#room-title").textContent =
      state.rooms.find((r) => r.id === roomId)?.name ||
      "모임에 먼저 참여해 주세요";
    $("#room-list").replaceChildren(
      ...state.rooms.map((r) => {
        const b = el("button", r.id === roomId ? "active" : "", r.name);
        b.onclick = () => {
          roomId = r.id;
          signature = "";
          refresh();
        };
        return b;
      }),
    );
    $("#peer-count").textContent = state.people.length;
    $("#contact-list").replaceChildren(
      ...state.people.map((p) => {
        const c = el(
          "div",
          "contact " + (p.status === "offline" ? "offline" : ""),
        );
        c.append(
          el(
            "span",
            "",
            (p.status === "offline" ? "⚪ " : "🟢 ") +
              p.name +
              (p.id === state.userId ? " · 나" : ""),
          ),
          el(
            "small",
            "",
            {
              offline: "퇴근 · 기존 대화는 보관 중",
              away: "자리 비움",
              focus: "집중 중",
              online: "근무 중",
            }[p.status],
          ),
        );
        return c;
      }),
    );
    const sig = JSON.stringify(state.messages);
    if (sig !== signature) {
      const box = $("#history"),
        atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 50;
      signature = sig;
      box.replaceChildren(
        ...(state.messages.length
          ? state.messages.map((m) => {
              const row = el(
                "div",
                "history-message" +
                  (m.userId === state.userId ? " mine" : "") +
                  (m.mentions?.includes(state.userId) ? " mentioned" : ""),
              );
              row.append(
                el("strong", "", m.name),
                el(
                  "time",
                  "",
                  new Date(m.createdAt).toLocaleString("ko-KR", {
                    month: "numeric",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  }),
                ),
                el("p", "", m.text),
              );
              if (m.pending)
                row.append(el("small", "", m.pending + "명 전달 대기"));
              return row;
            })
          : [
              el(
                "div",
                "history-empty",
                "아직 이야기가 없어요. 먼저 인사를 건네보세요 ☘",
              ),
            ]),
      );
      if (atBottom) box.scrollTop = box.scrollHeight;
    }
    $("#messenger-form button").disabled =
      state.status === "offline" || !roomId;
    if (document.hasFocus() && state.messages.length)
      await api("/api/read", {
        roomId,
        seq: Math.max(...state.messages.map((m) => m.seq)),
      });
  } catch (e) {
    $("#send-status").textContent =
      e.message || "오피스에서 로그인하고 모임에 참여해 주세요.";
  } finally {
    refreshing = false;
  }
}
$("#messenger-form").onsubmit = async (e) => {
  e.preventDefault();
  const input = $("#message-input"),
    message = input.value.trim();
  if (!message) return;
  try {
    await api("/api/messages", {
      roomId,
      text: message,
      mentions: state.people
        .filter((p) => message.includes("@" + p.name))
        .map((p) => p.id),
    });
    input.value = "";
    await refresh();
    $("#history").scrollTop = $("#history").scrollHeight;
    $("#send-status").textContent =
      "이 PC에 기록했어요. 전달하지 못한 동료에게는 재접속 시 다시 전달해요.";
  } catch (error) {
    $("#send-status").textContent = error.message;
  }
};
$("#open-office").onclick = () => window.moongle.showMain();
window.moongle.onLanState(() => refresh());
window.addEventListener("focus", () => refresh());
setInterval(refresh, 2500);
refresh();

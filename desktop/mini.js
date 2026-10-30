const input = document.querySelector("#mini-input");
let snapshot,
  busy = false;
window.moongle.onSnapshot((data) => {
  snapshot = data;
  if (busy) return;
  input.disabled = data.status === "offline" || !data.connected;
  input.placeholder = !data.connected
    ? "로그인 후 모임에 참여해 주세요"
    : data.status === "offline"
      ? "퇴근 상태예요 · 접속 후 입력해 주세요"
      : (data.roomName || "전체 대화") + "에 입력 · Enter 전송";
});
window.moongle.onCompose(() => {
  input.focus();
});
document.querySelector("#mini-form").onsubmit = async (event) => {
  event.preventDefault();
  const value = input.value.trim();
  if (!value || busy || !snapshot?.connected || snapshot.status === "offline")
    return;
  busy = true;
  input.disabled = true;
  try {
    await window.moongle.sendChat(value);
    input.value = "";
  } catch (error) {
    input.disabled = false;
    input.placeholder =
      error.message || "전송하지 못했어요. 다시 입력해 주세요.";
    input.focus();
  } finally {
    busy = false;
    input.disabled = snapshot?.status === "offline" || !snapshot?.connected;
  }
};
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    window.moongle.hideMini();
  }
});

const $ = (s) => document.querySelector(s);
let snapshot;
window.moongle.onSnapshot((data) => {
  snapshot = data;
  $("#mini-room").textContent = data.roomName || "";
  $("#mini-people").replaceChildren(
    ...data.people.slice(0, 8).map((p) => {
      const wrap = document.createElement("div");
      wrap.className =
        "mini-person " + (p.status === "offline" ? "offline" : "");
      let c;
      if (p.character === "custom" && p.image) {
        c = document.createElement("img");
        c.src = p.image;
        c.alt = p.petName;
      } else {
        c = document.createElement("div");
        c.className =
          "creature " + ({ bunny: "bunny", bean: "bean" }[p.character] || "");
        c.innerHTML =
          '<span class="ears"></span><span class="eyes"><i></i><i></i></span><span class="blush"></span><span class="mouth"></span>';
      }
      const n = document.createElement("div");
      n.className = "mini-name";
      n.textContent = p.name + (p.id === data.userId ? " · 나" : "");
      wrap.append(c, n);
      const m =
        p.status !== "offline" &&
        data.status !== "offline" &&
        data.messages
          .filter((m) => m.userId === p.id && Date.now() - m.createdAt < 7000)
          .at(-1);
      if (m) {
        const b = document.createElement("div");
        b.className = "mini-bubble";
        b.textContent = m.text;
        wrap.append(b);
      }
      return wrap;
    }),
  );
  $("#mini-status").textContent = data.connected
    ? data.status === "focus"
      ? "집중 중 · 알림을 쉬고 있어요"
      : "캐릭터들과 연결되어 있어요 · 상단을 잡아 이동"
    : "기기 로그인 후 같은 사내 모임에 참여해 주세요.";
});
$("#mini-form").onsubmit = async (e) => {
  e.preventDefault();
  const text = $("#mini-input").value.trim();
  if (!snapshot?.connected) {
    $("#mini-status").textContent = "먼저 오피스에서 로그인하고 연결해 주세요.";
    return;
  }
  if (snapshot.status === "offline") {
    $("#mini-status").textContent = "근무 중 상태로 변경해 주세요.";
    return;
  }
  if (text) {
    await window.moongle.sendChat(text);
    $("#mini-input").value = "";
  }
};
$("#expand").onclick = () => window.moongle.showMain();
$("#hide").onclick = () => window.moongle.hideMini();
window.moongle.onCompose(() => $("#mini-input").focus());

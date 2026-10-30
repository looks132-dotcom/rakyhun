const $ = (s) => document.querySelector(s);
let person,
  origin,
  dragged = false,
  lastShape = "",
  bubbleUntil = 0;
function creature(p) {
  if (p.character === "custom" && p.image) {
    const img = document.createElement("img");
    img.className = "custom-creature";
    img.src = p.image;
    img.alt = p.petName;
    return img;
  }
  const c = document.createElement("div");
  c.className =
    "creature " + ({ bunny: "bunny", bean: "bean" }[p.character] || "");
  c.innerHTML =
    '<span class="ears"></span><span class="eyes"><i></i><i></i></span><span class="blush"></span><span class="mouth"></span>';
  return c;
}
window.moongle.onPetState((data) => {
  person = data.person;
  document.body.classList.toggle("offline", person.status === "offline");
  $("#pet-name").textContent = person.name + (data.isMe ? " · 나" : "");
  $("#pet-status").textContent = {
    offline: "🌙 퇴근",
    away: "☕ 자리 비움",
    focus: "🎧 집중 중",
    online: "",
  }[person.status];
  const shape = person.character + (person.image || "");
  if (shape !== lastShape) {
    lastShape = shape;
    $("#pet-art").replaceChildren(creature(person));
  }
  if (data.message && person.status !== "offline") {
    $("#pet-bubble").textContent = data.message;
    $("#pet-bubble").classList.remove("hidden");
    bubbleUntil = Date.now() + 5000;
  } else {
    $("#pet-bubble").classList.add("hidden");
    bubbleUntil = 0;
  }
});
const h = $("#pet-handle");
h.onpointerdown = (e) => {
  if (e.button !== 0) return;
  origin = { x: e.screenX, y: e.screenY };
  dragged = false;
  h.setPointerCapture(e.pointerId);
  document.body.classList.add("grabbed");
  window.moongle.petDrag({ kind: "start" });
};
h.onpointermove = (e) => {
  if (!origin) return;
  const dx = e.screenX - origin.x,
    dy = e.screenY - origin.y;
  if (Math.abs(dx) + Math.abs(dy) > 5) {
    dragged = true;
    window.moongle.petDrag({ kind: "move", dx, dy });
  }
};
function end() {
  if (!origin) return;
  origin = null;
  window.moongle.petDrag({ kind: "end" });
  document.body.classList.remove("grabbed");
  if (!dragged && person?.status !== "offline") {
    document.body.classList.add("wave");
    setTimeout(() => document.body.classList.remove("wave"), 850);
  }
}
h.onpointerup = end;
h.onpointercancel = end;
h.ondblclick = () => window.moongle.openPet();
h.oncontextmenu = (event) => {
  event.preventDefault();
  window.moongle.compose();
};
h.title =
  "드래그로 이동 · 더블클릭으로 메신저 · 우클릭 또는 Ctrl+Shift+Space로 대화";
h.onkeydown = (e) => {
  if (e.key === "Enter") window.moongle.openPet();
};
setInterval(() => {
  if (bubbleUntil && Date.now() > bubbleUntil) {
    $("#pet-bubble").classList.add("hidden");
    bubbleUntil = 0;
  }
}, 500);

const $ = (s) => document.querySelector(s),
  desktop = window.moongle,
  preview = !desktop && location.protocol === "file:";
const defaults = {
  id: "me",
  name: "김뭉글",
  petName: "모찌",
  role: "디자인팀 · 프로덕트 디자이너",
  bio: "작은 즐거움을 모으는 중 ☘",
  character: "mochi",
  remember: true,
  status: "online",
};
let saved;
try {
  saved = JSON.parse(
    localStorage.getItem("moongle-profile") ||
      sessionStorage.getItem("moongle-profile") ||
      "null",
  );
} catch {}
let profile = { ...defaults, ...(preview ? saved : {}) },
  messages = [],
  people = [],
  rooms = [],
  workspaces = [],
  inbox = [],
  roomId = "",
  activeView = "office",
  connected = false,
  authenticated = false,
  info = {},
  status = "online",
  preferredStatus = "online",
  notifications = true,
  mentionsOnly = false,
  lastSeq = 0,
  initialSync = true,
  syncing = false,
  petSignature = "",
  seenTime = 0,
  loginPending = false;
const positions = new Map(),
  characters = [
    { id: "mochi", name: "모찌", desc: "말랑말랑, 다정한 노란 친구", cls: "" },
    {
      id: "bunny",
      name: "토리",
      desc: "호기심 가득한 분홍 토끼",
      cls: "bunny",
    },
    {
      id: "bean",
      name: "두부",
      desc: "느긋한 하루를 좋아하는 초록 친구",
      cls: "bean",
    },
  ];
const statusLabels = {
  online: "근무 중",
  focus: "집중 중",
  away: "자리 비움",
  offline: "퇴근",
};
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
let toastTimer;
function toast(text) {
  $("#toast").textContent = text;
  $("#toast").classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("#toast").classList.remove("show"), 3400);
}
function modal(title, content) {
  $("#modal-content").replaceChildren(el("h2", "", title), ...content);
  if (!$("#modal").open) $("#modal").showModal();
}
$("#modal-close").onclick = () => $("#modal").close();
$("#modal").onclick = (e) => {
  if (e.target === $("#modal")) $("#modal").close();
};
async function api(path, data) {
  if (desktop) {
    const b = await desktop.api(path, data);
    if (b.error) {
      const e = Error(b.error);
      e.status = b.status;
      throw e;
    }
    return b;
  }
  const r = await fetch(path, {
    method: data === undefined ? "GET" : "POST",
    headers: data === undefined ? {} : { "Content-Type": "application/json" },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const b = await r.json();
  if (!r.ok) {
    const e = Error(b.error);
    e.status = r.status;
    throw e;
  }
  return b;
}
function safeAction(fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (e) {
      toast(e.message || "다시 시도해 주세요.");
    }
  };
}
function creature(person) {
  if (person.character === "custom" && person.image) {
    const img = el("img", "custom-creature");
    img.src = person.image;
    img.alt = person.petName || "내 캐릭터";
    return img;
  }
  const c = el(
    "div",
    "creature " +
      (characters.find((x) => x.id === person.character)?.cls || ""),
  );
  c.innerHTML =
    '<span class="ears"></span><span class="eyes"><i></i><i></i></span><span class="blush"></span><span class="mouth"></span>';
  return c;
}
function persistPreview() {
  if (!preview) return;
  try {
    localStorage.removeItem("moongle-profile");
    sessionStorage.removeItem("moongle-profile");
    (profile.remember ? localStorage : sessionStorage).setItem(
      "moongle-profile",
      JSON.stringify(profile),
    );
    sessionStorage.setItem(
      "moongle-demo",
      JSON.stringify({ rooms, messages, inbox, roomId }),
    );
  } catch {
    toast("기기 저장 공간이 부족해요.");
  }
}
async function saveProfile() {
  if (preview) {
    persistPreview();
    people = people.map((p) =>
      p.id === profile.id ? { ...profile, status } : p,
    );
  } else {
    const b = await api("/api/profile", profile);
    profile = { ...profile, ...b.user };
    await sync();
  }
  account();
  renderPets(true);
}
function speech(pet, text) {
  if (
    !pet ||
    status === "offline" ||
    people.find((p) => p.id === pet.dataset.id)?.status === "offline"
  )
    return;
  pet.querySelector(".speech")?.remove();
  const b = el("div", "speech", text);
  pet.prepend(b);
  setTimeout(() => b.remove(), 6000);
}
function showPerson(person) {
  const actions = el("div", "reaction-buttons");
  for (const emoji of ["👋", "👏", "❤️"]) {
    const button = el(
      "button",
      "secondary",
      emoji + " " + { "👋": "인사", "👏": "박수", "❤️": "응원" }[emoji],
    );
    button.onclick = safeAction(async () => {
      await sendMessage(emoji, "reaction", person.id);
      $("#modal").close();
    });
    actions.append(button);
  }
  modal(person.name, [
    el("p", "", person.role || "우리의 동료"),
    el("p", "", person.bio || "오늘도 반가워요!"),
    el(
      "p",
      "",
      `${person.petName || "작은 친구"} · ${statusLabels[person.status]}`,
    ),
    actions,
  ]);
}
function renderPets(force = false) {
  const sig = JSON.stringify(
    people.map((p) => [
      p.id,
      p.name,
      p.status,
      p.character,
      p.image,
      p.petName,
      p.bio,
      p.role,
    ]),
  );
  if (!force && sig === petSignature) return;
  petSignature = sig;
  document.querySelectorAll("#scene .pet").forEach((e) => e.remove());
  people.forEach((person, index) => {
    const isMe = person.id === profile.id;
    const peerIndex = people
      .slice(0, index)
      .filter((p) => p.id !== profile.id).length;
    const crowded = people.length > 4;
    const pos = positions.get(roomId + person.id) || {
      x: crowded ? 12 + (index % 5) * 19 : isMe ? 48 : [24, 72, 88][peerIndex],
      y: crowded
        ? 43 + Math.floor(index / 5) * 21
        : isMe
          ? 65
          : [55, 55, 69][peerIndex],
    };
    const pet = el(
      "div",
      "pet " + (person.status === "offline" ? "offline" : ""),
    );
    pet.style.left = pos.x + "%";
    pet.style.top = pos.y + "%";
    pet.dataset.id = person.id;
    pet.tabIndex = 0;
    pet.setAttribute("role", "button");
    pet.setAttribute(
      "aria-label",
      person.name + " 캐릭터, " + statusLabels[person.status],
    );
    const tag = el("div", "name-tag");
    tag.append(
      el("i"),
      document.createTextNode(
        person.name +
          (isMe ? " · 나" : "") +
          (person.status === "offline" ? " · 퇴근" : ""),
      ),
    );
    pet.append(tag, creature(person), el("div", "pet-shadow"));
    $("#scene").append(pet);
    let origin,
      dragged = false;
    pet.onpointerdown = (e) => {
      if (e.button !== 0) return;
      origin = {
        x: e.clientX,
        y: e.clientY,
        left: pet.offsetLeft,
        top: pet.offsetTop,
      };
      dragged = false;
      pet.setPointerCapture(e.pointerId);
    };
    pet.onpointermove = (e) => {
      if (!origin) return;
      const dx = e.clientX - origin.x,
        dy = e.clientY - origin.y;
      if (Math.abs(dx) + Math.abs(dy) > 5) {
        dragged = true;
        pet.classList.add("grabbed");
        pet.style.left =
          Math.max(
            43,
            Math.min($("#scene").clientWidth - 43, origin.left + dx),
          ) + "px";
        pet.style.top =
          Math.max(
            65,
            Math.min($("#scene").clientHeight - 100, origin.top + dy),
          ) + "px";
      }
    };
    pet.onpointerup = () => {
      if (!origin) return;
      origin = null;
      pet.classList.remove("grabbed");
      if (dragged) {
        positions.set(roomId + person.id, {
          x: (pet.offsetLeft / $("#scene").clientWidth) * 100,
          y: (pet.offsetTop / $("#scene").clientHeight) * 100,
        });
      } else {
        pet.classList.add("wave");
        speech(
          pet,
          person.status === "offline"
            ? "퇴근했어요. 내일 만나요!"
            : isMe
              ? profile.petName + "와 함께하는 하루!"
              : "반가워요! 더블클릭해서 리액션을 보내요 👋",
        );
        setTimeout(() => pet.classList.remove("wave"), 900);
      }
    };
    pet.onpointercancel = () => {
      origin = null;
      pet.classList.remove("grabbed");
    };
    pet.ondblclick = () => showPerson(person);
    pet.onkeydown = (e) => {
      if (["Enter", " "].includes(e.key)) {
        e.preventDefault();
        showPerson(person);
      }
    };
  });
  $("#online-count").textContent =
    people.filter((p) => p.status !== "offline").length + "명 근무 중";
  document
    .querySelectorAll("[data-status]")
    .forEach((b) =>
      b.classList.toggle("selected", b.dataset.status === status),
    );
}
function time(value) {
  return new Date(value).toLocaleTimeString("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
function renderMessages() {
  const box = $("#messages"),
    atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 35;
  box.replaceChildren(
    ...messages
      .filter((m) => m.roomId === roomId)
      .map((m) => {
        const row = el(
          "div",
          "message" + (m.mentions?.includes(profile.id) ? " mentioned" : ""),
        );
        row.append(
          el("strong", "", m.name),
          el(
            "span",
            "",
            m.type === "reaction"
              ? `${m.text} ${people.find((p) => p.id === m.toUserId)?.name || "동료"}에게 보냈어요`
              : m.text,
          ),
          el("time", "", time(m.createdAt)),
        );
        return row;
      }),
  );
  $("#message-count").textContent = messages.filter(
    (m) => m.roomId === roomId,
  ).length;
  if (atBottom || initialSync) box.scrollTop = box.scrollHeight;
}
function renderRooms() {
  $("#room-select").replaceChildren(
    ...rooms.map((r) => {
      const o = el("option", "", r.name);
      o.value = r.id;
      return o;
    }),
  );
  $("#room-select").value = roomId;
  $(".workspace div").replaceChildren(
    document.createTextNode(workspaces[0]?.name || "우리의 오피스"),
    el("small", "", preview ? "미리보기 공간" : "초대받은 우리끼리"),
  );
  $("#chat-title").textContent =
    (rooms.find((r) => r.id === roomId)?.name || "라운지") + " 이야기";
  $("#mention-list").replaceChildren(
    ...people
      .filter((p) => p.id !== profile.id)
      .map((p) => {
        const o = el("option");
        o.value = "@" + p.name;
        return o;
      }),
  );
}
function renderInbox() {
  const items = inbox.filter(
    (m) =>
      !mentionsOnly ||
      m.mentions?.includes(profile.id) ||
      m.toUserId === profile.id,
  );
  $("#unread-count").textContent = inbox.length;
  $("#inbox-list").replaceChildren(
    ...(items.length
      ? items.map((m) => {
          const b = el("button", "inbox-message");
          b.append(
            el(
              "strong",
              "",
              m.name +
                " · " +
                (rooms.find((r) => r.id === m.roomId)?.name || "대화방"),
            ),
            el("p", "", m.text),
            el("small", "", new Date(m.createdAt).toLocaleString("ko-KR")),
          );
          b.onclick = safeAction(async () => {
            await switchRoom(m.roomId);
            view("office");
          });
          return b;
        })
      : [
          el(
            "div",
            "empty-state",
            mentionsOnly
              ? "나를 부른 새 이야기가 없어요."
              : "모든 이야기를 확인했어요. 잠깐 쉬어도 좋아요 ☘",
          ),
        ]),
  );
}
function account() {
  $("#account-name").replaceChildren(
    document.createTextNode(
      authenticated || preview ? profile.name : "로그인해 주세요",
    ),
    el(
      "small",
      "",
      preview
        ? "서버 없는 미리보기"
        : authenticated
          ? "웹 로그인 연결됨"
          : "설치 앱 · 로그인 대기",
    ),
  );
}
function connection() {
  const b = $("#connection-banner");
  $("#scene").classList.toggle("disconnected", !connected && !preview);
  $("#connection-badge").textContent = preview
    ? "파일 미리보기"
    : connected
      ? "연결됨"
      : authenticated
        ? "재연결 중"
        : "로그인 필요";
  b.replaceChildren();
  if (desktop && authenticated && !info.configured) {
    b.append(
      document.createTextNode(
        "모임을 만들거나 동료의 초대 코드를 입력하면 사내 PC끼리 연결돼요.",
      ),
    );
    const setup = el("button", "primary", "사내 모임 참여");
    setup.onclick = () => view("settings");
    b.append(setup);
  } else if (preview) {
    b.append(
      document.createTextNode(
        "미리보기 · 아래 동료와 대화는 예시예요. 실제 공동 사용은 설치 앱에서 시작하세요.",
      ),
    );
  } else if (!authenticated) {
    b.append(
      document.createTextNode(
        loginPending
          ? "브라우저에서 로그인을 완료하면 앱이 연결돼요."
          : "웹에서 로그인하고 우리 팀의 오피스로 들어오세요.",
      ),
    );
    const button = el(
      "button",
      "primary",
      loginPending ? "로그인 다시 열기" : "웹 로그인",
    );
    button.onclick = safeAction(login);
    b.append(button);
  } else if (!connected) {
    b.append(
      document.createTextNode(
        "내 PC와 연결이 끊겼어요. 연결되면 자동으로 다시 불러와요.",
      ),
    );
  } else {
    b.classList.add("hidden");
    return;
  }
  b.classList.remove("hidden");
}
function snapshot() {
  desktop?.snapshot({
    people,
    messages: messages.filter((m) => m.roomId === roomId),
    userId: profile.id,
    roomName: rooms.find((r) => r.id === roomId)?.name,
    status,
    connected,
  });
}
async function markRead(all = false) {
  if (!authenticated && !preview) return;
  const targets = all ? rooms : rooms.filter((r) => r.id === roomId);
  for (const r of targets) {
    const seq = Math.max(
      0,
      ...inbox.filter((m) => m.roomId === r.id).map((m) => m.seq),
      ...messages.filter((m) => m.roomId === r.id).map((m) => m.seq),
    );
    if (!seq) continue;
    if (!preview) await api("/api/read", { roomId: r.id, seq });
    inbox = inbox.filter((m) => m.roomId !== r.id || m.seq > seq);
  }
  renderInbox();
  persistPreview();
}
async function sync() {
  if (preview || syncing || !authenticated) return;
  syncing = true;
  try {
    const data = await api(
      "/api/sync?status=" +
        status +
        (roomId ? "&room=" + encodeURIComponent(roomId) : ""),
    );
    connected = true;
    seenTime = Date.now();
    profile = { ...profile, ...data.user };
    people = data.people;
    rooms = data.rooms;
    workspaces = data.workspaces;
    roomId = data.roomId;
    messages = data.messages;
    inbox = data.inbox;
    const incoming = messages.filter(
      (m) => m.seq > lastSeq && m.userId !== profile.id,
    );
    if (!initialSync) {
      incoming.forEach((m) =>
        speech(document.querySelector(`[data-id="${m.userId}"]`), m.text),
      );
      const mentioned = inbox.filter(
        (m) =>
          m.seq > lastSeq &&
          (m.mentions?.includes(profile.id) || m.toUserId === profile.id),
      );
      if (
        notifications &&
        status !== "focus" &&
        status !== "offline" &&
        mentioned.length
      ) {
        const m = mentioned.at(-1);
        toast(m.name + "님이 나를 불렀어요: " + m.text);
        desktop?.notify({ title: "뭉글 · " + m.name, body: m.text });
      }
    }
    lastSeq = Math.max(
      lastSeq,
      ...messages.map((m) => m.seq),
      ...inbox.map((m) => m.seq),
    );
    renderRooms();
    renderPets();
    renderMessages();
    renderInbox();
    account();
    connection();
    renderSettings();
    snapshot();
    initialSync = false;
    if (
      activeView === "office" &&
      document.hasFocus() &&
      !document.hidden &&
      inbox.some((m) => m.roomId === roomId)
    )
      await markRead();
  } catch (e) {
    connected = false;
    if (e.status === 401) {
      authenticated = false;
      people = [];
      renderPets(true);
      toast("다시 로그인해 주세요.");
    } else if (Date.now() - seenTime > 45000) {
      people = people.map((p) => ({ ...p, status: "offline" }));
      renderPets();
    }
    connection();
    snapshot();
  } finally {
    syncing = false;
  }
}
async function sendMessage(text, type = "text", toUserId = "") {
  text = text.trim();
  if (!text) return;
  if (status === "offline")
    throw Error("근무 중으로 변경하면 대화할 수 있어요.");
  if (!preview && (!authenticated || !connected))
    throw Error("먼저 기기 로그인과 사내 모임 연결을 확인해 주세요.");
  if (!roomId) throw Error("대화방을 먼저 선택해 주세요.");
  const mentions = people
    .filter((p) => text.includes("@" + p.name))
    .map((p) => p.id);
  let m;
  if (preview) {
    m = {
      id: crypto.randomUUID(),
      seq: Math.max(0, ...messages.map((m) => m.seq)) + 1,
      userId: profile.id,
      name: profile.name,
      roomId,
      text,
      type,
      toUserId,
      mentions,
      createdAt: Date.now(),
    };
    messages.push(m);
    persistPreview();
  } else
    m = (await api("/api/messages", { roomId, text, type, toUserId, mentions }))
      .message;
  if (!preview) await sync();
  renderMessages();
  speech(document.querySelector(`[data-id="${profile.id}"]`), text);
  snapshot();
}
async function switchRoom(id) {
  roomId = id;
  petSignature = "";
  if (!preview) {
    initialSync = true;
    await sync();
  } else {
    renderRooms();
    renderPets();
    renderMessages();
    await markRead();
    persistPreview();
  }
  $("#messages").scrollTop = $("#messages").scrollHeight;
}
function view(id) {
  activeView = id;
  document
    .querySelectorAll(".page")
    .forEach((p) => p.classList.toggle("hidden", p.id !== id));
  document
    .querySelectorAll("[data-view]")
    .forEach((b) => b.classList.toggle("active", b.dataset.view === id));
  $("#page-name").textContent = {
    office: "우리의 오피스",
    characters: "캐릭터 옷장",
    profile: "내 프로필",
    inbox: "놓친 이야기",
    settings: "연결과 초대",
  }[id];
  if (id === "profile") fillProfile();
  if (id === "settings") renderSettings();
  if (id === "office") markRead().catch(() => {});
}
async function login() {
  if (preview) {
    modal("설치 앱에서 시작해 주세요", [
      el(
        "p",
        "",
        "현재 파일은 서버 없이 열어보는 미리보기입니다. Moongle 설치 파일을 실행한 뒤 앱의 웹 로그인 버튼을 사용해 주세요.",
      ),
    ]);
    return;
  }
  if (desktop) {
    await desktop.login();
    loginPending = true;
    connection();
    toast("기본 브라우저에서 로그인해 주세요.");
  } else location.href = "/login";
}
function fillProfile() {
  const f = $("#profile-form");
  ["name", "petName", "role", "bio"].forEach(
    (k) => (f.elements[k].value = profile[k] || ""),
  );
  f.elements.remember.checked = profile.remember;
  f.elements.remember.closest("label").classList.toggle("hidden", !preview);
}
function renderChoices() {
  $("#character-grid").replaceChildren(
    ...characters.map((c) => {
      const b = el(
        "button",
        "character-choice" + (profile.character === c.id ? " chosen" : ""),
      );
      b.append(
        creature({ character: c.id }),
        el("h2", "", c.name),
        el("p", "", c.desc),
        el(
          "span",
          "muted",
          profile.character === c.id ? "✓ 함께하는 중" : "이 친구 선택하기",
        ),
      );
      b.onclick = safeAction(async () => {
        if (!preview && !authenticated)
          throw Error("먼저 웹에서 로그인해 주세요.");
        profile.character = c.id;
        profile.petName = c.name;
        await saveProfile();
        renderChoices();
        snapshot();
        toast(c.name + "와 함께해요!");
      });
      return b;
    }),
  );
}
function renderSettings() {
  $("#login-state").textContent = preview
    ? "서버 없는 미리보기"
    : authenticated
      ? profile.name + "님 · 이 PC 로그인 완료"
      : "이 PC의 계정으로 로그인해 주세요.";
  $("#session-toggle").disabled = !authenticated && !preview;
  $("#session-toggle").textContent =
    status === "offline" ? "오피스에 접속하기" : "접속 종료 · 퇴근하기";
  $("#invite-code").textContent = preview
    ? "미리보기 · 실제 초대 코드가 아닙니다"
    : workspaces[0]?.invite || "로그인하고 모임을 만들거나 참여해 주세요.";
  $("#server-current").textContent = preview
    ? "사내 연결은 설치 앱에서 사용할 수 있어요."
    : info.configured
      ? "사내 직접 연결 · 기록은 이 PC에 저장돼요."
      : "로그인 후 모임을 만들거나 초대 코드를 입력해 주세요.";
  $("#lan-addresses").replaceChildren(
    ...(info.addresses || []).map((value) => el("code", "address", value)),
  );
  $("#lan-warning").textContent =
    info.warning ||
    "같은 사내 네트워크에서 자동 검색해요. 검색되지 않으면 동료의 IP:포트로 직접 연결하세요.";
  $("#logout").disabled = !authenticated;
  $("#pets-visible").checked = info.desktopPets !== false;
  $("#pets-roaming").checked = info.roaming !== false;
}
function setupUI() {
  const nav = $('[data-view="profile"]');
  for (const [id, icon, label] of [
    ["inbox", "▤", "놓친 이야기"],
    ["settings", "⚙", "연결과 초대"],
  ]) {
    const b = el("button", "nav");
    b.dataset.view = id;
    b.append(document.createTextNode(icon + " "), el("span", "", label));
    if (id === "inbox") {
      const count = el("b", "", "0");
      count.id = "unread-count";
      b.append(count);
    }
    nav.parentNode.insertBefore(b, $(".sidebar-bottom"));
  }
  document
    .querySelectorAll("[data-view]")
    .forEach((b) => (b.onclick = () => view(b.dataset.view)));
  const room = $(".room-bar>div");
  room.replaceChildren(el("span", "room-dot"));
  const select = el("select");
  select.id = "room-select";
  select.setAttribute("aria-label", "대화방 선택");
  room.append(select);
  const add = el("button", "room-add", "+");
  add.id = "room-add";
  add.title = "팀별 방 만들기";
  room.append(add);
  const invite = el("button", "secondary", "동료 초대 ↗");
  invite.id = "invite-open";
  invite.onclick = () => view("settings");
  $(".room-tag").replaceWith(invite);
  select.onchange = safeAction((e) => switchRoom(e.target.value));
  add.onclick = () => {
    const f = el("form", "modal-form"),
      input = el("input");
    input.placeholder = "예: 디자인팀";
    input.maxLength = 24;
    input.required = true;
    input.setAttribute("aria-label", "새 방 이름");
    f.append(input, el("button", "primary", "방 만들기"));
    f.onsubmit = safeAction(async (e) => {
      e.preventDefault();
      if (!preview && !authenticated) throw Error("먼저 로그인해 주세요.");
      const name = input.value.trim();
      if (!name) return;
      let r;
      if (preview) {
        r = { id: crypto.randomUUID(), workspaceId: "demo", name };
        rooms.push(r);
      } else {
        r = (await api("/api/rooms", { workspaceId: workspaces[0].id, name }))
          .room;
      }
      $("#modal").close();
      await switchRoom(r.id);
      toast(name + " 방을 만들었어요.");
    });
    modal("우리 팀의 새로운 방", [
      el("p", "", "같은 공간에 초대된 동료들이 함께 사용할 수 있어요."),
      f,
    ]);
  };
  $(".chat-card .section-title h2").id = "chat-title";
  $(".chat-card .section-title h2").textContent = "라운지 이야기";
  const count = el("span", "", "0");
  count.id = "message-count";
  $("#chat-title").after(count);
  $(".chat-card .section-title>span:last-child").textContent = preview
    ? "예시 대화 · 파일 미리보기"
    : "우리 팀에게 전달되는 이야기";
  const mentions = el("datalist");
  mentions.id = "mention-list";
  $("#chat-input").setAttribute("list", "mention-list");
  $("#chat-input").after(mentions);
  $("#chat-input").placeholder = "이야기를 건네보세요. @이름으로 동료 부르기";
  $(".status-card p").textContent = desktop
    ? "절전·화면 잠금 상태를 자동으로 반영해요. 연결이 끊기면 약 45초 뒤 퇴근으로 표시해요."
    : "상태를 직접 변경해 보세요. PC 연동은 설치 앱에서 작동해요.";
  const label = el("label", "notification-toggle"),
    toggle = el("input");
  toggle.type = "checkbox";
  toggle.checked = true;
  toggle.id = "notifications";
  label.append(toggle, document.createTextNode("멘션·리액션 알림 받기"));
  $(".status-card").append(label);
  toggle.onchange = () => {
    notifications = toggle.checked;
    toast(
      notifications
        ? "알림을 켰어요."
        : "알림을 껐어요. 놓친 이야기에서 확인하세요.",
    );
  };
  $(".profile-form>.muted").textContent = preview
    ? "미리보기 프로필은 이 기기에만 저장돼요."
    : "프로필과 대화 기록은 내 PC에 저장돼요. 자동 로그인은 웹 로그인 화면에서 선택해 주세요.";
  $("#chat-form").onsubmit = safeAction(async (e) => {
    e.preventDefault();
    await sendMessage($("#chat-input").value);
    $("#chat-input").value = "";
  });
  $("#profile-form").onsubmit = safeAction(async (e) => {
    e.preventDefault();
    if (!preview && !authenticated) throw Error("먼저 로그인해 주세요.");
    const f = e.target;
    for (const k of ["name", "petName"])
      if (!f.elements[k].value.trim()) throw Error("이름을 입력해 주세요.");
    ["name", "petName", "role", "bio"].forEach(
      (k) => (profile[k] = f.elements[k].value.trim()),
    );
    profile.remember = f.elements.remember.checked;
    await saveProfile();
    toast("프로필을 저장했어요.");
    view("office");
  });
  document.querySelectorAll("[data-status]").forEach(
    (b) =>
      (b.onclick = safeAction(async () => {
        status = b.dataset.status;
        preferredStatus = status;
        profile.status = status;
        if (preview) {
          people = people.map((p) =>
            p.id === profile.id ? { ...p, status } : p,
          );
          persistPreview();
        } else if (authenticated) {
          await api("/api/presence", { status });
          await sync();
        }
        renderPets(true);
        renderSettings();
        snapshot();
        toast(
          status === "focus"
            ? "집중 중에는 알림을 쉬어요. 놓친 이야기에서 확인하세요."
            : statusLabels[status] + " 상태로 변경했어요.",
        );
      })),
  );
  $("#upload").onchange = safeAction(async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!preview && !authenticated) throw Error("먼저 로그인해 주세요.");
    if (
      !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
      file.size > 3 * 1024 * 1024
    )
      throw Error("3MB 이하 PNG, JPG, WebP 이미지를 선택해 주세요.");
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(Error("이미지를 읽을 수 없어요."));
        img.src = url;
      });
      const canvas = document.createElement("canvas"),
        scale = Math.min(1, 256 / Math.max(img.width, img.height));
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      profile.image = canvas.toDataURL("image/png");
      profile.character = "custom";
      await saveProfile();
      renderChoices();
      snapshot();
      view("office");
      toast("내 이미지에 둥실 모션을 적용했어요.");
    } finally {
      URL.revokeObjectURL(url);
      e.target.value = "";
    }
  });
  $("#mini-open").onclick = safeAction(async () => {
    if (desktop) {
      await desktop.mini();
      snapshot();
    } else {
      modal("바탕화면 미니 모드", [
        el(
          "p",
          "",
          "설치 앱에서는 다른 프로그램 위에 캐릭터들이 나타나요. Ctrl+Shift+Space로 언제든 대화할 수 있어요.",
        ),
        el(
          "p",
          "",
          "현재 미리보기에서는 Enter 키로 대화를 시작하고 캐릭터를 드래그해 보세요.",
        ),
      ]);
    }
  });
  const messengerButton = el("button", "secondary", "▤ 메신저");
  messengerButton.id = "messenger-open";
  messengerButton.onclick = () =>
    desktop
      ? desktop.messenger()
      : toast("설치 앱에서 별도 메신저를 사용할 수 있어요.");
  $(".header-right").prepend(messengerButton);
  $("#login-open").onclick = () => view("settings");
  $("#web-login").onclick = safeAction(login);
  $("#session-toggle").onclick = () => {
    const next = status === "offline" ? "online" : "offline";
    document.querySelector(`[data-status="${next}"]`).click();
  };
  $("#logout").onclick = safeAction(async () => {
    if (desktop) await desktop.logout();
    else await api("/api/auth/logout", {});
    authenticated = false;
    connected = false;
    people = [];
    messages = [];
    inbox = [];
    workspaces = [];
    rooms = [];
    profile = { ...defaults };
    petSignature = "";
    renderPets(true);
    renderMessages();
    renderInbox();
    account();
    connection();
    renderSettings();
    toast("로그아웃했어요.");
  });
  async function joinLan(create) {
    if (!desktop) throw Error("설치 앱에서 사내 모임에 참여해 주세요.");
    await desktop.joinLan({
      create,
      name: $("#lan-name").value,
      code: $("#lan-code").value.trim(),
    });
    info = await desktop.info();
    roomId = "";
    lastSeq = 0;
    initialSync = true;
    await sync();
    view("office");
    toast("우리 모임에 연결했어요. 같은 코드를 동료에게 전달해 주세요.");
  }
  $("#lan-create").onsubmit = safeAction(async (e) => {
    e.preventDefault();
    await joinLan(true);
  });
  $("#lan-join").onsubmit = safeAction(async (e) => {
    e.preventDefault();
    await joinLan(false);
  });
  $("#lan-manual").onsubmit = safeAction(async (e) => {
    e.preventDefault();
    if (!desktop) throw Error("설치 앱에서 연결해 주세요.");
    await desktop.connectPeer($("#lan-peer-address").value);
    info = await desktop.info();
    await sync();
    toast("동료 PC에 연결했어요.");
  });
  $("#copy-invite").onclick = safeAction(async () => {
    const code = workspaces[0]?.invite;
    if (preview || !code) throw Error("로그인 후 모임을 먼저 만들어 주세요.");
    const invitation =
      "뭉글 사내 모임 초대\n" +
      code +
      "\n같은 사내 네트워크에서 앱의 사내 연결과 초대에 코드를 입력하세요.";
    try {
      await navigator.clipboard.writeText(invitation);
      toast("모임 초대 코드를 복사했어요.");
    } catch {
      modal("초대 정보", [el("pre", "invite-text", invitation)]);
    }
  });
  $("#pets-visible").onchange = safeAction(async (e) => {
    if (desktop) await desktop.petOptions({ visible: e.target.checked });
    info = (await desktop?.info()) || {};
  });
  $("#pets-roaming").onchange = safeAction(async (e) => {
    if (desktop) await desktop.petOptions({ roaming: e.target.checked });
  });
  $("#messenger-settings").onclick = safeAction(async () => {
    if (desktop) await desktop.messenger();
    else toast("설치 앱에서 별도 메신저 창을 열 수 있어요.");
  });
  $("#inbox-all").onclick = () => {
    mentionsOnly = false;
    renderInbox();
  };
  $("#inbox-mentions").onclick = () => {
    mentionsOnly = true;
    renderInbox();
  };
  $("#read-all").onclick = safeAction(() => markRead(true));
  $("#help").onclick = () =>
    modal("작은 친구들과 함께하기", [
      el(
        "p",
        "",
        "Enter로 대화를 시작해요. @이름으로 동료를 부르면 놓친 이야기에도 표시돼요. 집중 중에는 알림을 보내지 않아요.",
      ),
      el(
        "p",
        "",
        "캐릭터를 클릭하면 인사하고, 잡으면 흔들려요. 더블클릭하거나 키보드 Enter로 프로필을 열어 리액션을 보내세요.",
      ),
      el(
        "p",
        "",
        "라운지 옆 + 버튼으로 팀별 방을 만들 수 있어요. 설치 앱에서는 Ctrl+Shift+Space로 바탕화면 대화를 시작해요.",
      ),
      el(
        "p",
        "",
        "각자 원할 때 접속하고 나갈 수 있어요. 누가 퇴근해도 다른 동료들의 연결과 대화는 유지돼요.",
      ),
    ]);
  document.addEventListener("keydown", (e) => {
    if (
      e.key === "Enter" &&
      !$("#modal").open &&
      !["INPUT", "TEXTAREA", "BUTTON", "SELECT"].includes(
        document.activeElement.tagName,
      ) &&
      document.activeElement.getAttribute("role") !== "button"
    ) {
      e.preventDefault();
      view("office");
      $("#chat-input").focus();
    }
  });
  window.addEventListener("focus", () => {
    if (activeView === "office") markRead().catch(() => {});
  });
}
async function resetConnection() {
  info = await desktop.info();
  authenticated = info.authenticated;
  connected = false;
  loginPending = false;
  initialSync = true;
  lastSeq = 0;
  roomId = "";
  rooms = [];
  workspaces = [];
  people = [];
  messages = [];
  inbox = [];
  profile = { ...defaults };
  petSignature = "";
  renderPets(true);
  renderMessages();
  renderInbox();
  renderSettings();
  account();
  connection();
  if (authenticated) await sync();
}
async function init() {
  setupUI();
  $("#date").textContent = new Date().toLocaleDateString("ko-KR", {
    month: "long",
    day: "numeric",
    weekday: "long",
    timeZone: "Asia/Seoul",
  });
  if (preview) {
    connected = true;
    status = profile.status || "online";
    authenticated = false;
    workspaces = [{ id: "demo", name: "스튜디오 뭉글" }];
    rooms = [
      { id: "lounge", workspaceId: "demo", name: "라운지" },
      { id: "design", workspaceId: "demo", name: "디자인팀" },
    ];
    roomId = "lounge";
    people = [
      {
        id: "seoyeon",
        name: "서연",
        petName: "토리",
        character: "bunny",
        status: "online",
        role: "디자인팀",
        bio: "작은 즐거움을 만들어요.",
      },
      {
        id: "jiwoo",
        name: "지우",
        petName: "두부",
        character: "bean",
        status: "focus",
        role: "개발팀",
        bio: "집중해서 만드는 중 🎧",
      },
      {
        id: "doyun",
        name: "도윤",
        petName: "모찌",
        character: "mochi",
        status: "offline",
        role: "운영팀",
        bio: "내일 만나요!",
      },
      { ...profile, status },
    ];
    messages = [
      {
        id: "sample1",
        seq: 1,
        roomId: "lounge",
        userId: "seoyeon",
        name: "서연",
        text: "좋은 아침이에요! 오늘도 잘 부탁해요 ☀",
        createdAt: Date.now() - 600000,
      },
      {
        id: "sample2",
        seq: 2,
        roomId: "lounge",
        userId: "jiwoo",
        name: "지우",
        text: "커피 한 잔 하고 시작할까요? ☕",
        createdAt: Date.now() - 500000,
      },
      {
        id: "sample3",
        seq: 3,
        roomId: "design",
        userId: "seoyeon",
        name: "서연",
        text: "@" + profile.name + "님, 새로운 시안 같이 봐요!",
        mentions: [profile.id],
        createdAt: Date.now() - 400000,
      },
    ];
    inbox = [messages[2]];
    try {
      const savedDemo = JSON.parse(
        sessionStorage.getItem("moongle-demo") || "null",
      );
      if (savedDemo) {
        rooms = savedDemo.rooms;
        messages = savedDemo.messages;
        inbox = savedDemo.inbox;
        roomId = savedDemo.roomId;
      }
    } catch {}
    renderRooms();
    renderPets();
    renderMessages();
    renderInbox();
  } else if (desktop) {
    desktop.onShowSettings(() => view("settings"));
    desktop.onLanState(async (data) => {
      info = await desktop.info();
      if (authenticated) {
        status = data.status;
        await sync();
      }
      renderSettings();
    });
    desktop.onAuthenticated(async () => {
      loginPending = false;
      await resetConnection();
      renderChoices();
      toast("로그인했어요. 작은 동료들과 만나요!");
    });
    desktop.onAuthError((message) => {
      loginPending = false;
      connection();
      toast(message);
    });
    desktop.onPower((value) => {
      status = value === "online" ? preferredStatus : value;
      sync();
    });
    desktop.onMiniChat(safeAction((text) => sendMessage(text)));
    await resetConnection();
  } else {
    try {
      await api("/api/me");
      authenticated = true;
      await sync();
    } catch {
      connection();
    }
  }
  renderChoices();
  fillProfile();
  account();
  connection();
  renderSettings();
  setInterval(() => sync(), 2500);
}
init().catch((e) => toast("시작할 수 없어요: " + e.message));

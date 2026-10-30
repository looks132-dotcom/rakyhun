const {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  globalShortcut,
  powerMonitor,
  Notification,
  safeStorage,
  Tray,
  Menu,
  nativeImage,
  screen,
} = require("electron");
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { createService } = require("../lib/service"),
  { LanPeer } = require("../lib/lan-peer");
const root = path.join(__dirname, ".."),
  petWindows = new Map();
let mainWindow,
  miniWindow,
  messengerWindow,
  tray,
  lan,
  authService,
  localUrl,
  settings = {},
  token = "",
  quitting = false,
  pendingLogin = 0,
  publishTimer,
  hoverTimer,
  walkTimer,
  activeRoomId = "",
  composerWanted = false;
const settingsFile = () => path.join(app.getPath("userData"), "settings.json");
function save() {
  fs.writeFileSync(settingsFile(), JSON.stringify(settings), { mode: 0o600 });
}
function rememberToken(value, remember) {
  token = value;
  if (remember && safeStorage.isEncryptionAvailable())
    settings.credential = safeStorage.encryptString(value).toString("base64");
  else delete settings.credential;
  save();
}
async function authApi(route, body) {
  const response = await fetch(localUrl + route, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5000),
  });
  const data = await response.json();
  if (!response.ok) {
    const e = Error(data.error || "다시 로그인해 주세요.");
    e.status = response.status;
    throw e;
  }
  return data;
}
async function api(route, body) {
  if (!/^\/api\/[a-z/]+(?:\?[^#]*)?$/.test(route))
    throw Error("지원하지 않는 요청이에요.");
  if (route.startsWith("/api/device/") || route.startsWith("/api/auth/"))
    return authApi(route, body);
  await authApi("/api/me");
  return lan.api(route, body);
}
function secure(win) {
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.on("will-attach-webview", (event) => event.preventDefault());
}
const webPreferences = () => ({
  preload: path.join(__dirname, "preload.js"),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  backgroundThrottling: false,
});
function showMain() {
  mainWindow.show();
  mainWindow.focus();
}
function makeMini() {
  if (miniWindow && !miniWindow.isDestroyed()) return miniWindow;
  const b = screen.getPrimaryDisplay().workArea;
  miniWindow = new BrowserWindow({
    width: 248,
    height: 44,
    x: b.x + b.width - 268,
    y: b.y + b.height - 260,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    show: false,
    webPreferences: webPreferences(),
  });
  secure(miniWindow);
  miniWindow.loadFile(path.join(__dirname, "mini.html"));
  miniWindow.webContents.on("did-finish-load", () => {
    publish();
    if (composerWanted) revealComposer();
  });
  miniWindow.on("blur", () => {
    composerWanted = false;
    miniWindow?.hide();
  });
  miniWindow.on("closed", () => (miniWindow = null));
  return miniWindow;
}
function revealComposer() {
  if (!miniWindow || miniWindow.isDestroyed()) return;
  const own = petWindows.get(lan.id)?.win;
  const bounds = own?.getBounds() || {
    ...screen.getPrimaryDisplay().workArea,
    width: 170,
    height: 240,
  };
  const area = screen.getDisplayMatching(bounds).workArea;
  miniWindow.setBounds({
    x: Math.round(
      Math.max(
        area.x,
        Math.min(area.x + area.width - 248, bounds.x + 85 - 124),
      ),
    ),
    y: Math.max(area.y, bounds.y + 48),
    width: 248,
    height: 44,
  });
  miniWindow.webContents.send("snapshot", stateFor(activeRoomId));
  miniWindow.show();
  miniWindow.focus();
  miniWindow.webContents.send("compose");
}
function openComposer() {
  if (!token || !lan.group()) {
    showMain();
    mainWindow.webContents.send("show-settings");
    return { needsSetup: true };
  }
  settings.desktopPets = true;
  save();
  publish();
  composerWanted = true;
  const w = makeMini();
  if (!w.webContents.isLoading()) revealComposer();
  return { ok: true };
}
function showMessenger() {
  if (!messengerWindow || messengerWindow.isDestroyed()) {
    messengerWindow = new BrowserWindow({
      width: 700,
      height: 770,
      minWidth: 480,
      minHeight: 500,
      title: "뭉글 메신저",
      icon: path.join(__dirname, "icon.png"),
      backgroundColor: "#f8f9f6",
      autoHideMenuBar: true,
      webPreferences: webPreferences(),
    });
    secure(messengerWindow);
    messengerWindow.loadFile(path.join(__dirname, "messenger.html"));
    messengerWindow.webContents.on("did-finish-load", publish);
    messengerWindow.on("closed", () => (messengerWindow = null));
  } else {
    messengerWindow.show();
    messengerWindow.focus();
  }
  return messengerWindow;
}
function stateFor(roomId) {
  const state = lan.snapshot(roomId);
  return {
    ...state,
    userId: lan.id,
    roomName: state.rooms.find((r) => r.id === state.roomId)?.name || "",
    status: lan.status,
    connected: !!token && !!lan.group(),
  };
}
function schedulePublish() {
  if (quitting || publishTimer) return;
  publishTimer = setTimeout(() => {
    publishTimer = null;
    publish();
  }, 80);
}
function publish() {
  if (!lan || quitting) return;
  const state = stateFor();
  for (const w of [mainWindow, miniWindow, messengerWindow])
    if (w && !w.isDestroyed()) w.webContents.send("lan-state", state);
  if (miniWindow && !miniWindow.isDestroyed())
    miniWindow.webContents.send("snapshot", stateFor(activeRoomId));
  updatePets(state);
}
function updatePets(state) {
  const enabled = settings.desktopPets !== false;
  const people = enabled ? state.people.slice(0, 16) : [];
  const keep = new Set(people.map((p) => p.id));
  for (const [id, record] of petWindows)
    if (!keep.has(id)) {
      record.win.destroy();
      petWindows.delete(id);
    }
  people.forEach((person, index) => {
    let record = petWindows.get(person.id);
    if (!record) {
      const b = screen.getPrimaryDisplay().workArea,
        pos = settings.petPositions?.[lan.state.current + person.id];
      const win = new BrowserWindow({
        width: 170,
        height: 240,
        x: pos?.x ?? b.x + 30 + (index % 8) * 120,
        y: pos?.y ?? b.y + b.height - 240 - Math.floor(index / 8) * 145,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        hasShadow: false,
        show: false,
        focusable: true,
        webPreferences: webPreferences(),
      });
      const restored = win.getBounds(),
        area = screen.getDisplayMatching(restored).workArea;
      win.setPosition(
        Math.max(area.x, Math.min(area.x + area.width - 170, restored.x)),
        Math.max(area.y, Math.min(area.y + area.height - 240, restored.y)),
      );
      secure(win);
      record = { win, person, id: person.id, drag: null, hasSpeech: false };
      petWindows.set(person.id, record);
      win.setIgnoreMouseEvents(true, { forward: true });
      win.loadFile(path.join(__dirname, "pet.html"));
      win.webContents.on("did-finish-load", () => {
        publishPet(record, state);
        win.showInactive();
      });
      win.on("closed", () => petWindows.delete(person.id));
    }
    record.person = person;
    publishPet(record, state);
  });
}
function publishPet(record, state) {
  const active =
    token && state.status !== "offline" && record.person.status !== "offline";
  const message = active
    ? (lan.group()?.messages || [])
        .filter(
          (m) =>
            m.userId === record.id &&
            Date.now() - m.createdAt >= 0 &&
            Date.now() - m.createdAt < 6500,
        )
        .at(-1)
    : null;
  record.hasSpeech = !!message;
  record.win.webContents.send("pet-state", {
    person: record.person,
    isMe: record.id === lan.id,
    message: message?.text || "",
  });
}
function attachPetInput() {
  hoverTimer = setInterval(() => {
    const mouse = screen.getCursorScreenPoint();
    for (const r of petWindows.values()) {
      if (r.win.isDestroyed()) continue;
      const b = r.win.getBounds(),
        x = mouse.x - b.x,
        y = mouse.y - b.y;
      const inside =
        r.drag ||
        (x >= 15 && x <= 155 && y >= 86 && y <= 237) ||
        (r.hasSpeech && x >= 5 && x <= 165 && y >= 0 && y <= 85);
      r.win.setIgnoreMouseEvents(!inside, { forward: true });
    }
  }, 100);
  hoverTimer.unref();
  walkTimer = setInterval(() => {
    if (settings.roaming === false) return;
    const mouse = screen.getCursorScreenPoint();
    for (const r of petWindows.values()) {
      if (
        r.drag ||
        r.person.status !== "online" ||
        r.win.isDestroyed() ||
        (r.id === lan.id && miniWindow?.isVisible())
      )
        continue;
      const b = r.win.getBounds();
      if (Math.abs(mouse.x - b.x) < 200 && Math.abs(mouse.y - b.y) < 220)
        continue;
      const area = screen.getDisplayMatching(b).workArea;
      const phase =
        Math.floor(Date.now() / 5000) + parseInt(r.id.slice(0, 2), 16);
      if (phase % 3 !== 0) continue;
      const dx = phase % 2 ? 2 : -2;
      r.win.setPosition(
        Math.max(area.x, Math.min(area.x + area.width - b.width, b.x + dx)),
        b.y,
      );
    }
  }, 180);
  walkTimer.unref();
}
function registerIpc() {
  const allowed = [
    "../index.html",
    "mini.html",
    "messenger.html",
    "pet.html",
  ].map(
    (f) => require("node:url").pathToFileURL(path.resolve(__dirname, f)).href,
  );
  const handle = (name, fn) =>
    ipcMain.handle(name, async (event, ...args) => {
      if (!allowed.includes(event.senderFrame?.url))
        throw Error("허용되지 않은 화면이에요.");
      return fn(event, ...args);
    });
  handle("info", () => ({
    mode: "lan",
    serverUrl: localUrl,
    configured: !!lan.group(),
    authenticated: !!token,
    addresses: lan.addresses(),
    invite: token ? lan.invite() : "",
    warning: lan.warning,
    desktopPets: settings.desktopPets !== false,
    roaming: settings.roaming !== false,
    shortcut: "Ctrl+Shift+Space",
  }));
  handle("api", async (_event, route, body) => {
    try {
      const result = await api(route, body);
      if (body !== undefined && route !== "/api/read") schedulePublish();
      return result;
    } catch (e) {
      return { error: e.message, status: e.status || 400 };
    }
  });
  handle("login", async () => {
    const generation = ++pendingLogin,
      verifier = crypto.randomBytes(32).toString("base64url");
    const { deviceId } = await authApi("/api/device/start", {
      challenge: crypto.createHash("sha256").update(verifier).digest("hex"),
    });
    await shell.openExternal(
      localUrl + "/login?device=" + encodeURIComponent(deviceId),
    );
    const deadline = Date.now() + 300000;
    async function poll() {
      if (generation !== pendingLogin || quitting) return;
      try {
        const r = await authApi("/api/device/poll", { deviceId, verifier });
        if (r.token) {
          rememberToken(r.token, r.remember);
          const { user } = await authApi("/api/me");
          if (!lan.state.profileInitialized)
            lan.updateProfile({ ...lan.profile, name: user.name });
          lan.setStatus("online");
          mainWindow.webContents.send("authenticated");
          showMain();
          publish();
          return;
        }
        if (Date.now() < deadline) setTimeout(poll, 1200);
        else
          mainWindow.webContents.send(
            "auth-error",
            "로그인 시간이 만료됐어요.",
          );
      } catch (e) {
        mainWindow.webContents.send("auth-error", e.message);
      }
    }
    setTimeout(poll, 600);
    return { opened: true };
  });
  handle("logout", async () => {
    pendingLogin++;
    await authApi("/api/auth/logout", {}).catch(() => {});
    rememberToken("", false);
    lan.setStatus("offline");
    miniWindow?.hide();
    publish();
    return { ok: true };
  });
  handle("lan-join", async (_event, { code, name, create }) => {
    await authApi("/api/me");
    const result = create ? lan.createGroup(name) : lan.join(code);
    publish();
    return result;
  });
  handle("lan-connect", async (_event, value) => {
    await authApi("/api/me");
    const match = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/.exec(
      String(value).trim(),
    );
    if (!match)
      throw Error("동료의 사내 주소를 IP:포트 형식으로 입력해 주세요.");
    const result = await lan.connect(match[1], Number(match[2]));
    publish();
    return result;
  });
  handle("pet-options", (_event, options) => {
    if (typeof options.visible === "boolean")
      settings.desktopPets = options.visible;
    if (typeof options.roaming === "boolean")
      settings.roaming = options.roaming;
    save();
    publish();
    return { ok: true };
  });
  handle("mini", () => {
    settings.desktopPets = true;
    save();
    publish();
    return { ok: true };
  });
  handle("compose", () => openComposer());
  handle("hide-mini", () => {
    composerWanted = false;
    miniWindow?.hide();
  });
  handle("show-main", () => showMain());
  handle("show-setup", () => {
    showMain();
    mainWindow.webContents.send("show-settings");
  });
  handle("messenger", () => {
    showMessenger();
    return { ok: true };
  });
  handle("messenger-state", async (_event, roomId) => {
    await authApi("/api/me");
    const result = stateFor(roomId);
    activeRoomId = result.roomId;
    return result;
  });
  handle("snapshot", () => ({ ok: true }));
  handle("mini-chat", async (_event, text) => {
    await authApi("/api/me");
    const selected =
      lan.group()?.rooms.find((r) => r.id === activeRoomId) ||
      lan.group()?.rooms[0];
    if (
      typeof text !== "string" ||
      !text.trim() ||
      text.length > 300 ||
      !selected
    )
      throw Error("대화방을 먼저 만들어 주세요.");
    const result = lan.send({ roomId: selected.id, text });
    publish();
    composerWanted = false;
    miniWindow?.hide();
    return result;
  });
  handle("notify", (_event, { title, body }) => {
    if (lan.status === "focus" || lan.status === "offline") return;
    if (
      typeof title === "string" &&
      typeof body === "string" &&
      Notification.isSupported()
    )
      new Notification({
        title: title.slice(0, 80),
        body: body.slice(0, 300),
      }).show();
  });
  handle("pet-drag", (event, data) => {
    const r = [...petWindows.values()].find(
      (r) => r.win.webContents.id === event.sender.id,
    );
    if (!r) return;
    if (data.kind === "start") {
      r.drag = r.win.getBounds();
      r.win.setIgnoreMouseEvents(false);
    } else if (
      data.kind === "move" &&
      r.drag &&
      Number.isFinite(data.dx) &&
      Number.isFinite(data.dy)
    ) {
      const proposed = {
          ...r.drag,
          x: Math.round(r.drag.x + data.dx),
          y: Math.round(r.drag.y + data.dy),
        },
        area = screen.getDisplayMatching(proposed).workArea;
      r.win.setPosition(
        Math.max(area.x - 50, Math.min(area.x + area.width - 120, proposed.x)),
        Math.max(
          area.y,
          Math.min(area.y + area.height - r.drag.height, proposed.y),
        ),
      );
    } else if (data.kind === "end") {
      r.drag = null;
      settings.petPositions ||= {};
      const { x, y } = r.win.getBounds();
      settings.petPositions[lan.state.current + r.id] = { x, y };
      save();
    }
  });
  handle("pet-open", () => {
    showMessenger();
    return { ok: true };
  });
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => mainWindow && showMain());
  app
    .whenReady()
    .then(async () => {
      app.setAppUserModelId("kr.moongle.office");
      try {
        settings = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
      } catch {}
      if (settings.connectionVersion !== 4) {
        delete settings.credential;
        delete settings.serverUrl;
        settings.connectionVersion = 4;
        save();
      }
      try {
        if (settings.credential && safeStorage.isEncryptionAvailable())
          token = safeStorage.decryptString(
            Buffer.from(settings.credential, "base64"),
          );
      } catch {
        token = "";
      }
      const authDir = path.join(app.getPath("userData"), "device-login");
      authService = createService({ dataDir: authDir, mode: "local" });
      const address = await authService.start(0, "127.0.0.1");
      localUrl = "http://127.0.0.1:" + address.port;
      const encrypted = safeStorage.isEncryptionAvailable();
      lan = new LanPeer({
        dataDir: path.join(app.getPath("userData"), "lan"),
        encode: (value) =>
          encrypted
            ? Buffer.concat([
                Buffer.from("ENC1"),
                safeStorage.encryptString(value),
              ])
            : Buffer.from(value),
        decode: (bytes) =>
          bytes.subarray(0, 4).toString() === "ENC1"
            ? safeStorage.decryptString(bytes.subarray(4))
            : bytes.toString(),
        discovery: process.env.MOONGLE_TEST_NO_DISCOVERY !== "1",
      });
      await lan.start({
        port: process.env.MOONGLE_TEST_NO_DISCOVERY === "1" ? 0 : 41765,
      });
      lan.on("change", schedulePublish);
      if (token)
        try {
          await authApi("/api/me");
          lan.setStatus("online");
        } catch {
          rememberToken("", false);
        }
      registerIpc();
      mainWindow = new BrowserWindow({
        width: 1330,
        height: 960,
        minWidth: 760,
        minHeight: 600,
        title: "뭉글 · 사내 메신저",
        icon: path.join(__dirname, "icon.png"),
        backgroundColor: "#f8f9f6",
        autoHideMenuBar: true,
        webPreferences: webPreferences(),
      });
      secure(mainWindow);
      await mainWindow.loadFile(path.join(root, "index.html"));
      mainWindow.on("close", (e) => {
        if (!quitting) {
          e.preventDefault();
          mainWindow.hide();
        }
      });
      tray = new Tray(
        nativeImage
          .createFromPath(path.join(__dirname, "icon.png"))
          .resize({ width: 16, height: 16 }),
      );
      tray.setToolTip("뭉글 · 사내 친구들");
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: "오피스 열기", click: showMain },
          { label: "메신저 열기", click: showMessenger },
          {
            label: "바탕화면 친구 표시",
            type: "checkbox",
            checked: settings.desktopPets !== false,
            click: (item) => {
              settings.desktopPets = item.checked;
              save();
              publish();
            },
          },
          { type: "separator" },
          { label: "뭉글 종료", click: () => app.quit() },
        ]),
      );
      tray.on("click", showMessenger);
      globalShortcut.register("CommandOrControl+Shift+Space", () =>
        openComposer(),
      );
      const powerState = {
        locked: false,
        suspended: false,
        previous: "online",
      };
      for (const [event, flag, value] of [
        ["suspend", "suspended", true],
        ["lock-screen", "locked", true],
        ["resume", "suspended", false],
        ["unlock-screen", "locked", false],
      ])
        powerMonitor.on(event, () => {
          if (value && !powerState.locked && !powerState.suspended)
            powerState.previous = lan.status;
          powerState[flag] = value;
          const next = powerState.suspended
            ? "offline"
            : powerState.locked
              ? "away"
              : powerState.previous;
          lan.setStatus(next);
          mainWindow.webContents.send("power", next);
        });
      attachPetInput();
      publish();
    })
    .catch((e) => {
      require("electron").dialog.showErrorBox("뭉글 시작 오류", e.message);
      quitting = true;
      app.quit();
    });
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    pendingLogin++;
    clearTimeout(publishTimer);
    clearInterval(hoverTimer);
    clearInterval(walkTimer);
    globalShortcut.unregisterAll();
    Promise.race([
      lan?.close().then(() => authService?.close()),
      new Promise((r) => setTimeout(r, 2000)),
    ]).finally(() => app.quit());
  });
  app.on("window-all-closed", () => {});
}

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
const serviceConfig = require("./service-config.json");
let mainWindow,
  miniWindow,
  tray,
  settings = {},
  token = "",
  quitting = false,
  pendingLogin = 0,
  latestSnapshot = null;
const root = path.join(__dirname, "..");
const settingFile = () => path.join(app.getPath("userData"), "settings.json");
function save() {
  fs.writeFileSync(settingFile(), JSON.stringify(settings), { mode: 0o600 });
}
function serverUrl() {
  return (
    settings.serverUrl ||
    process.env.MOONGLE_SERVICE_URL ||
    serviceConfig.serverUrl ||
    ""
  );
}
function validateServer(value) {
  const u = new URL(value);
  if (u.username || u.password || u.search || u.hash || u.pathname !== "/")
    throw Error("서버 주소만 입력해 주세요.");
  const localTest =
    process.env.MOONGLE_ALLOW_LOCAL_TEST === "1" &&
    ["localhost", "127.0.0.1"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && localTest))
    throw Error("중앙 서비스의 https 주소를 입력해 주세요.");
  return u.origin;
}
function rememberToken(value, remember) {
  token = value;
  if (remember && safeStorage.isEncryptionAvailable()) {
    settings.credential = safeStorage.encryptString(token).toString("base64");
  } else delete settings.credential;
  save();
}
async function api(route, body) {
  if (!serverUrl())
    throw Error(
      "중앙 서비스가 아직 연결되지 않았어요. 연결과 초대에서 서비스 주소를 설정해 주세요.",
    );
  if (!/^\/api\/[a-z/]+(?:\?[^#]*)?$/.test(route))
    throw Error("허용되지 않은 요청이에요.");
  const r = await fetch(serverUrl() + route, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10000),
  });
  const b = await r.json();
  if (!r.ok) {
    const e = Error(b.error || "연결할 수 없어요.");
    e.status = r.status;
    throw e;
  }
  return b;
}
function secure(win) {
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.webContents.on("will-attach-webview", (e) => e.preventDefault());
}
function showMain() {
  mainWindow.show();
  mainWindow.focus();
}
function makeMini() {
  if (miniWindow && !miniWindow.isDestroyed()) return miniWindow;
  const bounds = screen.getPrimaryDisplay().workArea;
  miniWindow = new BrowserWindow({
    width: 510,
    height: 260,
    x: bounds.x + bounds.width - 530,
    y: bounds.y + bounds.height - 280,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  secure(miniWindow);
  miniWindow.loadFile(path.join(__dirname, "mini.html"));
  miniWindow.webContents.on("did-finish-load", () => {
    if (latestSnapshot) miniWindow.webContents.send("snapshot", latestSnapshot);
  });
  miniWindow.on("closed", () => (miniWindow = null));
  return miniWindow;
}
function notifyPower(status) {
  if (token) api("/api/presence", { status }).catch(() => {});
  mainWindow?.webContents.send("power", status);
}
function registerIpc() {
  // Restrict native capabilities to the two bundled, isolated renderer documents.
  function trusted(event) {
    const url = event.senderFrame?.url;
    return (
      url ===
        require("node:url").pathToFileURL(path.join(root, "index.html")).href ||
      url ===
        require("node:url").pathToFileURL(path.join(__dirname, "mini.html"))
          .href
    );
  }
  const handle = (name, fn) =>
    ipcMain.handle(name, async (event, ...args) => {
      if (!trusted(event)) throw Error("허용되지 않은 화면이에요.");
      return fn(...args);
    });
  handle("info", () => ({
    serverUrl: serverUrl(),
    configured: !!serverUrl(),
    mode: "cloud",
    authenticated: !!token,
    shortcut: "Ctrl+Shift+Space",
    canRemember: safeStorage.isEncryptionAvailable(),
  }));
  handle("api", async (route, body) => {
    try {
      return await api(route, body);
    } catch (e) {
      return { error: e.message, status: e.status || 503 };
    }
  });
  handle("login", async () => {
    const generation = ++pendingLogin,
      verifier = crypto.randomBytes(32).toString("base64url");
    const { deviceId } = await api("/api/device/start", {
      challenge: crypto.createHash("sha256").update(verifier).digest("hex"),
    });
    await shell.openExternal(
      serverUrl() + "/login?device=" + encodeURIComponent(deviceId),
    );
    const started = Date.now();
    async function poll() {
      if (generation !== pendingLogin || quitting) return;
      try {
        const r = await api("/api/device/poll", { deviceId, verifier });
        if (r.token) {
          rememberToken(r.token, r.remember);
          mainWindow.webContents.send("authenticated");
          showMain();
          return;
        }
        if (Date.now() - started < 300000) setTimeout(poll, 1600);
        else
          mainWindow.webContents.send(
            "auth-error",
            "로그인 시간이 만료됐어요. 다시 시도해 주세요.",
          );
      } catch (e) {
        mainWindow.webContents.send("auth-error", e.message);
      }
    }
    setTimeout(poll, 1000);
    return { opened: true };
  });
  handle("logout", async () => {
    pendingLogin++;
    if (token) await api("/api/auth/logout", {}).catch(() => {});
    rememberToken("", false);
    latestSnapshot = null;
    miniWindow?.hide();
    return { ok: true };
  });
  handle("server", async (value) => {
    const target = validateServer(value);
    const r = await fetch(target + "/api/config", {
      signal: AbortSignal.timeout(7000),
    });
    if (!r.ok) throw Error("뭉글 중앙 서비스에 연결할 수 없어요.");
    const b = await r.json();
    if (b.mode !== "cloud" || b.apiVersion !== 1)
      throw Error("중앙 서비스 주소와 앱 버전을 확인해 주세요.");
    pendingLogin++;
    rememberToken("", false);
    settings.serverUrl = target;
    save();
    miniWindow?.hide();
    return { ok: true };
  });
  handle("mini", () => {
    const m = makeMini();
    m.show();
    return { ok: true };
  });
  handle("hide-mini", () => miniWindow?.hide());
  handle("show-main", () => showMain());
  handle("snapshot", (snapshot) => {
    if (!snapshot || !Array.isArray(snapshot.people)) return;
    latestSnapshot = snapshot;
    miniWindow?.webContents.send("snapshot", snapshot);
  });
  handle("mini-chat", (text) => {
    if (typeof text === "string" && text.trim() && text.length <= 300)
      mainWindow.webContents.send("mini-chat", text);
  });
  handle("notify", ({ title, body }) => {
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
}
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => mainWindow && showMain());
  app
    .whenReady()
    .then(async () => {
      app.setAppUserModelId("kr.moongle.office");
      try {
        settings = JSON.parse(fs.readFileSync(settingFile(), "utf8"));
      } catch {}
      try {
        if (settings.credential && safeStorage.isEncryptionAvailable())
          token = safeStorage.decryptString(
            Buffer.from(settings.credential, "base64"),
          );
      } catch {
        delete settings.credential;
        save();
      }
      // Desktop clients never host a server. Old LAN credentials are not reused.
      if (settings.connectionVersion !== 3) {
        if (settings.serverUrl?.startsWith("http:")) delete settings.serverUrl;
        delete settings.sharing;
        delete settings.localPort;
        delete settings.credential;
        token = "";
        settings.connectionVersion = 3;
        save();
      }
      if (serverUrl()) validateServer(serverUrl());
      registerIpc();
      mainWindow = new BrowserWindow({
        width: 1330,
        height: 960,
        minWidth: 760,
        minHeight: 600,
        title: "뭉글 · 우리의 오피스",
        icon: path.join(__dirname, "icon.png"),
        backgroundColor: "#f8f9f6",
        autoHideMenuBar: true,
        webPreferences: {
          preload: path.join(__dirname, "preload.js"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          backgroundThrottling: false,
        },
      });
      secure(mainWindow);
      await mainWindow.loadFile(path.join(root, "index.html"));
      mainWindow.on("close", (e) => {
        if (!quitting) {
          e.preventDefault();
          mainWindow.hide();
          if (!settings.trayHint) {
            settings.trayHint = true;
            save();
            if (Notification.isSupported())
              new Notification({
                title: "뭉글은 트레이에서 함께해요",
                body: "종료하려면 트레이 메뉴에서 뭉글 종료를 선택해 주세요.",
              }).show();
          }
        }
      });
      // Tiny embedded tray icon; no network or external artwork.
      const icon = nativeImage
        .createFromPath(path.join(__dirname, "icon.png"))
        .resize({ width: 16, height: 16 });
      tray = new Tray(icon);
      tray.setToolTip("뭉글 · 함께 일하는 작은 친구들");
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: "오피스 열기", click: showMain },
          { label: "미니 모드", click: () => makeMini().show() },
          { type: "separator" },
          { label: "뭉글 종료", click: () => app.quit() },
        ]),
      );
      tray.on("click", showMain);
      const shortcutOk = globalShortcut.register(
        "CommandOrControl+Shift+Space",
        () => {
          const m = makeMini();
          m.show();
          m.focus();
          m.webContents.send("compose");
        },
      );
      if (!shortcutOk)
        mainWindow.webContents.send(
          "auth-error",
          "Ctrl+Shift+Space를 다른 앱이 사용하고 있어요. 미니 모드 버튼으로 열 수 있어요.",
        );
      powerMonitor.on("suspend", () => notifyPower("offline"));
      powerMonitor.on("lock-screen", () => notifyPower("away"));
      powerMonitor.on("resume", () => notifyPower("online"));
      powerMonitor.on("unlock-screen", () => notifyPower("online"));
    })
    .catch((error) => {
      require("electron").dialog.showErrorBox(
        "뭉글을 시작할 수 없어요",
        error.message,
      );
      quitting = true;
      app.quit();
    });
  app.on("before-quit", (e) => {
    if (quitting) return;
    e.preventDefault();
    quitting = true;
    pendingLogin++;
    globalShortcut.unregisterAll();
    Promise.race([
      (async () => {
        if (token)
          await api("/api/presence", { status: "offline" }).catch(() => {});
      })(),
      new Promise((r) => setTimeout(r, 1500)),
    ]).finally(() => app.quit());
  });
  app.on("window-all-closed", () => {});
}

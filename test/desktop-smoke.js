const { _electron: electron } = require("playwright-core");
const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os");
const { createService } = require("../lib/service");
(async () => {
  const out = path.resolve("test-output");
  fs.mkdirSync(out, { recursive: true });
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "moongle-ui-"));
  const serverData = fs.mkdtempSync(
    path.join(os.tmpdir(), "moongle-cloud-ui-"),
  );
  // Run the central backend independently of every desktop client.
  const centralService = createService({ dataDir: serverData });
  const centralAddress = await centralService.start(0);
  const centralUrl = "http://127.0.0.1:" + centralAddress.port;
  const env = { ...process.env };
  env.MOONGLE_SERVICE_URL = centralUrl;
  env.MOONGLE_ALLOW_LOCAL_TEST = "1";
  delete env.ELECTRON_RUN_AS_NODE;
  const packaged = process.argv.includes("--packaged");
  const app = await electron.launch({
    executablePath: packaged
      ? path.resolve("release/win-unpacked/Moongle.exe")
      : require("electron"),
    args: [...(packaged ? [] : ["."]), `--user-data-dir=${userData}`],
    env,
    timeout: 60000,
  });
  const errors = [];
  let memberCookie;
  try {
    const page = await app.firstWindow();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.waitForSelector("#web-login");
    await page.locator("[data-view=settings]").click();
    await page
      .locator("#server-current")
      .filter({ hasText: "127.0.0.1" })
      .waitFor();
    // Keep authentication in an isolated browser window while intercepting only the OS browser launch.
    await app.evaluate(({ shell }) => {
      shell.openExternal = async (url) => {
        global.testLoginUrl = url;
      };
    });
    await page.locator("#web-login").click();
    const loginUrl = await app.evaluate(async () => {
      for (let i = 0; i < 100; i++) {
        if (global.testLoginUrl) return global.testLoginUrl;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw Error("Web login did not open");
    });
    await app.evaluate(async ({ BrowserWindow }, url) => {
      const w = new BrowserWindow({
        show: false,
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      await w.loadURL(url);
    }, loginUrl);
    const browser = app.windows().find((w) => w !== page);
    assert.ok(browser);
    browser.on("pageerror", (e) => errors.push(e.message));
    await browser
      .locator("#auth-submit")
      .filter({ hasText: "계정 만들고 시작하기" })
      .waitFor();
    await browser.locator("[name=name]").fill("테스트 방장");
    await browser.locator("[name=username]").fill("uitest");
    await browser.locator("[name=password]").fill("test-password-2026");
    await browser.locator("#auth-submit").click();
    await browser.locator("#login-success").waitFor();
    await page
      .locator("#connection-badge")
      .filter({ hasText: "연결됨" })
      .waitFor({ timeout: 20000 });
    await page.locator("[data-view=office]").click();
    await page.locator("#scene .pet").waitFor();
    await page.locator("#chat-input").fill("첫 번째 실제 채팅입니다");
    await page.locator("#chat-form button").click();
    await page
      .locator("#messages")
      .getByText("첫 번째 실제 채팅입니다")
      .waitFor();
    await page
      .locator("#scene .speech")
      .getByText("첫 번째 실제 채팅입니다")
      .waitFor();
    await page.locator("[data-view=characters]").click();
    await page
      .getByRole("button", { name: "토리 호기심" })
      .count()
      .then(() => {})
      .catch(() => {});
    await page.locator(".character-choice").nth(1).click();
    await page
      .locator(".character-choice.chosen h2")
      .filter({ hasText: "토리" })
      .waitFor();
    await page.locator("[data-view=profile]").click();
    await page.locator("[name=petName]").fill("우리 토리");
    await page.locator("[name=bio]").fill("실제 로그인 후 저장한 프로필");
    await page.locator("#profile-form button").click();
    await page.locator("#scene .bunny").waitFor();
    await page.locator("#room-add").click();
    await page.locator(".modal-form input").fill("디자인팀");
    await page.locator(".modal-form button").click();
    await page.locator("#chat-title").filter({ hasText: "디자인팀" }).waitFor();
    await page.locator("[data-status=focus]").click();
    await page.locator("[data-status=focus].selected").waitFor();
    await page.locator("[data-view=settings]").click();
    await page.locator("#session-toggle").click();
    await page
      .locator("#session-toggle")
      .filter({ hasText: "오피스에 접속하기" })
      .waitFor();
    await page.locator("#session-toggle").click();
    await page
      .locator("#session-toggle")
      .filter({ hasText: "접속 종료" })
      .waitFor();
    await page.locator("[data-view=office]").click();
    await page.locator("[data-status=focus]").click();
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL().endsWith("/index.html"))
        .webContents.send("power", "away"),
    );
    await page.locator("[data-status=away].selected").waitFor();
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL().endsWith("/index.html"))
        .webContents.send("power", "online"),
    );
    await page.locator("[data-status=focus].selected").waitFor();
    // A second invited employee, authenticated with a separate cookie, sends a mention.
    const info = await page.evaluate(() => window.moongle.info());
    const state = await page.evaluate(() =>
      window.moongle.api(
        "/api/sync?status=focus&room=" +
          document.querySelector("#room-select").value,
      ),
    );
    const invite = state.workspaces[0].invite;
    const reg = await fetch(info.serverUrl + "/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "새 동료",
        username: "colleague",
        password: "colleague-test-1234",
        invite,
      }),
    });
    assert.equal(reg.status, 201);
    const cookie = reg.headers.get("set-cookie").split(";")[0];
    memberCookie = cookie;
    await fetch(info.serverUrl + "/api/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        roomId: state.roomId,
        text: "@테스트 방장 시안을 봐주세요",
        mentions: [state.user.id],
      }),
    });
    await page
      .locator("#messages")
      .getByText("@테스트 방장 시안을 봐주세요")
      .waitFor({ timeout: 12000 });
    // Hide focus so the following message remains unread in another room.
    const lounge = state.rooms.find((r) => r.id !== state.roomId);
    await fetch(info.serverUrl + "/api/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        roomId: lounge.id,
        text: "@테스트 방장 다른 방의 이야기",
        mentions: [state.user.id],
      }),
    });
    await page.locator("[data-view=inbox]").click();
    await page
      .locator("#inbox-list")
      .getByText("@테스트 방장 다른 방의 이야기")
      .waitFor({ timeout: 12000 });
    await page.locator("[data-view=office]").click();
    const miniPromise = app.waitForEvent("window");
    await page.locator("#mini-open").click();
    const miniPage = await miniPromise;
    assert.ok(miniPage);
    await miniPage.locator("#mini-people .mini-person").first().waitFor();
    await miniPage.locator("#mini-input").fill("미니 모드에서 보낸 이야기");
    await miniPage.locator("#mini-form button").click();
    await page
      .locator("#messages")
      .getByText("미니 모드에서 보낸 이야기")
      .waitFor();
    await miniPage.screenshot({ path: path.join(out, "mini-mode.png") });
    await page.screenshot({ path: path.join(out, "desktop-office.png") });
    // Open the standalone preview directly, with no HTTP server.
    await app.evaluate(
      async ({ BrowserWindow }, file) => {
        const w = new BrowserWindow({
          show: false,
          width: 1380,
          height: 960,
          webPreferences: {
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
          },
        });
        await w.loadFile(file);
      },
      path.resolve(
        fs.existsSync("release/Moongle-Preview.html")
          ? "release/Moongle-Preview.html"
          : "index.html",
      ),
    );
    const preview = app
      .windows()
      .find(
        (w) =>
          w !== page &&
          w.url().startsWith("file:") &&
          !w.url().includes("mini.html"),
      );
    assert.ok(preview);
    preview.on("pageerror", (e) => errors.push(e.message));
    await preview.locator("#scene .pet").first().waitFor();
    assert.equal(await preview.locator("#scene .pet").count(), 4);
    await preview.locator("#chat-input").fill("파일 미리보기 성공");
    await preview.locator("#chat-form button").click();
    await preview
      .locator("#messages")
      .getByText("파일 미리보기 성공")
      .waitFor();
    await preview.evaluate(() => window.scrollTo(0, 0));
    await preview.screenshot({
      path: path.join(out, "standalone-preview.png"),
      fullPage: true,
    });
    await preview.setViewportSize({ width: 440, height: 850 });
    await preview.screenshot({ path: path.join(out, "mobile-preview.png") });
    assert.deepEqual(errors, []);
    console.log(
      "Desktop smoke passed: browser login → app handoff → profile/characters → real messaging/mentions → team rooms → mini chat → file preview.",
    );
  } finally {
    await app.close();
    // Closing one employee's app must not stop the service for any other employee.
    try {
      if (memberCookie) {
        const stillOnline = await fetch(
          centralUrl + "/api/sync?status=online",
          { headers: { Cookie: memberCookie } },
        );
        assert.equal(stillOnline.status, 200);
        assert.ok((await stillOnline.json()).rooms.length > 0);
        console.log(
          "Independent service check passed: another employee can still connect after the desktop app exits.",
        );
      }
    } finally {
      await centralService.close();
      fs.rmSync(serverData, { recursive: true, force: true });
    }
    fs.rmSync(userData, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

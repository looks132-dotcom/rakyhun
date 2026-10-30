const { _electron: electron } = require("playwright-core"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { LanPeer } = require("../lib/lan-peer");
(async () => {
  const out = path.resolve("test-output");
  fs.mkdirSync(out, { recursive: true });
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "moongle-lan-ui-")),
    peerDir = fs.mkdtempSync(path.join(os.tmpdir(), "moongle-friend-ui-"));
  let peer = new LanPeer({ dataDir: peerDir, discovery: false });
  await peer.start({ port: 0, host: "127.0.0.1" });
  const env = { ...process.env, MOONGLE_TEST_NO_DISCOVERY: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  const packaged = process.argv.includes("--packaged");
  const app = await electron.launch({
    executablePath: packaged
      ? path.resolve("release/win-unpacked/Moongle.exe")
      : require("electron"),
    args: [...(packaged ? [] : ["."]), "--user-data-dir=" + userData],
    env,
    timeout: 60000,
  });
  const errors = [];
  try {
    const page = await app.firstWindow();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.locator("[data-view=settings]").click();
    await page.locator("#web-login").waitFor();
    await app.evaluate(({ shell }) => {
      shell.openExternal = async (url) => {
        global.testLoginUrl = url;
      };
    });
    await page.locator("#web-login").click();
    const url = await app.evaluate(async () => {
      for (let i = 0; i < 100; i++) {
        if (global.testLoginUrl) return global.testLoginUrl;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw Error("Login did not open");
    });
    await app.evaluate(async ({ BrowserWindow }, url) => {
      const w = new BrowserWindow({
        show: false,
        webPreferences: {
          sandbox: true,
          nodeIntegration: false,
          contextIsolation: true,
        },
      });
      await w.loadURL(url);
    }, url);
    const browser = app.windows().find((w) => w !== page);
    await browser.locator("[name=name]").fill("수아");
    await browser.locator("[name=username]").fill("localtest");
    await browser.locator("[name=password]").fill("local-password-2026");
    await browser.locator("#auth-submit").click();
    await browser.locator("#login-success").waitFor();
    await page
      .locator("#login-state")
      .filter({ hasText: "로그인 완료" })
      .waitFor({ timeout: 15000 });
    await page.locator("#lan-name").fill("우리의 작은 팀");
    await page.locator("#lan-create button").click();
    await page.locator("#scene .pet").waitFor();
    await page.locator("[data-view=settings]").click();
    const code = await page.locator("#invite-code").textContent();
    assert.ok(code.startsWith("MOONGLE1."));
    peer.join(code);
    peer.updateProfile({
      ...peer.profile,
      name: "지우",
      petName: "토리",
      character: "bunny",
    });
    peer.setStatus("online");
    await page.locator("#lan-peer-address").fill("127.0.0.1:" + peer.port);
    await page.locator("#lan-manual button").click();
    await page.locator("[data-view=office]").click();
    await page
      .locator("#scene .pet")
      .filter({ hasText: "지우" })
      .waitFor({ timeout: 15000 });
    await page.locator("#chat-input").fill("캐릭터와 메신저에 함께 기록해요");
    await page.locator("#chat-form button").click();
    await page
      .locator("#messages")
      .getByText("캐릭터와 메신저에 함께 기록해요")
      .waitFor();
    const messengerPromise = app.waitForEvent("window");
    await page.locator("#messenger-open").click();
    const messenger = await messengerPromise;
    messenger.on("pageerror", (e) => errors.push(e.message));
    await messenger
      .locator("#history")
      .getByText("캐릭터와 메신저에 함께 기록해요")
      .waitFor();
    await messenger
      .locator("#message-input")
      .fill("@지우 별도 메신저에서 보낸 메시지");
    await messenger.locator("#messenger-form button").click();
    await messenger
      .locator("#history")
      .getByText("@지우 별도 메신저에서 보낸 메시지")
      .waitFor();
    const waitFor = async (fn) => {
      for (let i = 0; i < 100; i++) {
        if (fn()) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw Error("Peer wait timed out");
    };
    await waitFor(() =>
      peer
        .snapshot()
        .messages.some((m) => m.text === "@지우 별도 메신저에서 보낸 메시지"),
    );
    const pRoom = peer.snapshot().roomId;
    peer.send({ roomId: pRoom, text: "수아님 반가워요 👋" });
    await messenger
      .locator("#history")
      .getByText("수아님 반가워요 👋")
      .waitFor({ timeout: 15000 });
    await waitFor(
      () =>
        app.windows().filter((w) => w.url().includes("pet.html")).length >= 2,
    );
    let friendPet;
    for (const w of app.windows().filter((w) => w.url().includes("pet.html"))) {
      if ((await w.locator("#pet-name").textContent()).includes("지우"))
        friendPet = w;
    }
    assert.ok(friendPet);
    await friendPet
      .locator("#pet-bubble")
      .getByText("수아님 반가워요 👋")
      .waitFor();
    await friendPet.screenshot({
      path: path.join(out, "desktop-friend-online.png"),
    });
    await peer.close();
    peer = null;
    await friendPet.locator("body.offline").waitFor({ timeout: 15000 });
    assert.equal(await friendPet.locator("#pet-bubble").isVisible(), false);
    assert.ok(app.windows().includes(friendPet));
    await friendPet
      .locator("#pet-status")
      .filter({ hasText: "퇴근" })
      .waitFor();
    await friendPet.screenshot({
      path: path.join(out, "desktop-friend-offline.png"),
    });
    await messenger
      .locator("#contact-list .offline")
      .filter({ hasText: "지우" })
      .waitFor();
    await messenger
      .locator("#message-input")
      .fill("지우가 퇴근해도 메신저에 기록해요");
    await messenger.locator("#messenger-form button").click();
    await messenger
      .locator("#history")
      .getByText("지우가 퇴근해도 메신저에 기록해요")
      .waitFor();
    await messenger
      .locator("#history small")
      .filter({ hasText: "전달 대기" })
      .first()
      .waitFor();
    await messenger.screenshot({ path: path.join(out, "lan-messenger.png") });
    peer = new LanPeer({ dataDir: peerDir, discovery: false });
    await peer.start({ port: 0, host: "127.0.0.1" });
    peer.setStatus("online");
    await page.locator("[data-view=settings]").click();
    await page.locator("#lan-peer-address").fill("127.0.0.1:" + peer.port);
    await page.locator("#lan-manual button").click();
    await waitFor(() =>
      peer
        .snapshot()
        .messages.some((m) => m.text === "지우가 퇴근해도 메신저에 기록해요"),
    );
    await friendPet.locator("body:not(.offline)").waitFor();
    // Dragging is a real window movement, independent of the lounge.
    const before = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .filter((w) => w.webContents.getURL().endsWith("/pet.html"))
        .map((w) => ({ id: w.id, bounds: w.getBounds() })),
    );
    await friendPet.evaluate(async () => {
      await window.moongle.petDrag({ kind: "start" });
      await window.moongle.petDrag({ kind: "move", dx: -35, dy: -20 });
      await window.moongle.petDrag({ kind: "end" });
    });
    const after = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .filter((w) => w.webContents.getURL().endsWith("/pet.html"))
        .map((w) => ({ id: w.id, bounds: w.getBounds() })),
    );
    assert.ok(
      after.some((w) => {
        const old = before.find((b) => b.id === w.id);
        return old && Math.abs(w.bounds.y - old.bounds.y) >= 15;
      }),
    );
    await page.locator("[data-view=characters]").click();
    await page
      .locator("#upload")
      .setInputFiles(path.resolve("desktop/icon.png"));
    await page.locator("#scene .custom-creature").waitFor();
    await page.locator("[data-view=office]").click();
    await page.screenshot({ path: path.join(out, "lan-office.png") });
    assert.ok(before.length >= 2);
    assert.deepEqual(errors, []);
    console.log(
      "LAN desktop smoke passed: local browser login, direct peer chat, separate messenger, independent desktop pets, offline pet retained with no speech, queued delivery after reconnect.",
    );
  } finally {
    await app.close();
    if (peer) await peer.close();
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(peerDir, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

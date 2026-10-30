const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { createService } = require("../lib/service");

test("private office: browser authentication, app handoff, rooms, messages, presence and persistence", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moongle-test-"));
  let now = Date.now();
  let service = createService({ dataDir: dir, clock: () => now });
  let address = await service.start(0);
  let base = "http://127.0.0.1:" + address.port;
  t.after(async () => {
    await service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  async function request(route, body, { cookie, token, origin } = {}) {
    const r = await fetch(base + route, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(token ? { Authorization: "Bearer " + token } : {}),
        ...(origin ? { Origin: origin } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: r.status,
      data: await r.json(),
      cookie: r.headers.get("set-cookie")?.split(";")[0],
    };
  }
  const challenge = (v) => crypto.createHash("sha256").update(v).digest("hex");
  let ownerCookie,
    memberCookie,
    ownerToken,
    ownerId,
    memberId,
    workspaceId,
    roomId,
    invite;
  await t.test(
    "unauthenticated APIs and cross-origin writes are rejected",
    async () => {
      assert.equal((await request("/api/sync?status=online")).status, 401);
      assert.equal(
        (
          await request(
            "/api/auth/register",
            {},
            { origin: "http://attacker.invalid" },
          )
        ).status,
        403,
      );
    },
  );
  await t.test(
    "first account is owner, passwords are hashed and app handoff is single use",
    async () => {
      assert.equal(
        (
          await request("/api/auth/register", {
            name: "방장",
            username: "owner",
            password: "short",
          })
        ).status,
        400,
      );
      const d = await request("/api/device/start", {
        challenge: challenge("owner-verifier"),
      });
      assert.equal(d.status, 200);
      assert.equal(
        (
          await request("/api/device/poll", {
            deviceId: d.data.deviceId,
            verifier: "wrong",
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await request("/api/device/poll", {
            deviceId: d.data.deviceId,
            verifier: "owner-verifier",
          })
        ).data.pending,
        true,
      );
      const r = await request("/api/auth/register", {
        name: "방장",
        username: "owner",
        password: "correct-horse-12",
        remember: true,
        deviceId: d.data.deviceId,
      });
      assert.equal(r.status, 201);
      ownerCookie = r.cookie;
      ownerId = r.data.user.id;
      const linked = await request("/api/device/poll", {
        deviceId: d.data.deviceId,
        verifier: "owner-verifier",
      });
      ownerToken = linked.data.token;
      assert.ok(ownerToken);
      assert.equal(
        (
          await request("/api/device/poll", {
            deviceId: d.data.deviceId,
            verifier: "owner-verifier",
          })
        ).status,
        410,
      );
      const state = (
        await request("/api/sync?status=online", undefined, {
          token: ownerToken,
        })
      ).data;
      workspaceId = state.workspaces[0].id;
      roomId = state.roomId;
      invite = state.workspaces[0].invite;
      assert.equal(state.workspaces[0].ownerId, ownerId);
      assert.equal(state.people.length, 1);
      const disk = fs.readFileSync(path.join(dir, "office.json"), "utf8");
      assert.ok(!disk.includes("correct-horse-12"));
      assert.ok(!disk.includes(ownerToken));
    },
  );
  await t.test(
    "only invited employees can register; members cannot rotate invites",
    async () => {
      assert.equal(
        (
          await request("/api/auth/register", {
            name: "동료",
            username: "member",
            password: "member-password-12",
            invite: "BAD",
          })
        ).status,
        403,
      );
      const r = await request("/api/auth/register", {
        name: "동료",
        username: "member",
        password: "member-password-12",
        invite,
      });
      assert.equal(r.status, 201);
      memberCookie = r.cookie;
      memberId = r.data.user.id;
      assert.equal(
        (
          await request("/api/auth/login", {
            username: "member",
            password: "bad-password",
          })
        ).status,
        401,
      );
      assert.equal(
        (
          await request(
            "/api/workspaces/invite",
            { workspaceId },
            { cookie: memberCookie },
          )
        ).status,
        403,
      );
      const state = (
        await request("/api/sync?status=focus", undefined, {
          cookie: memberCookie,
        })
      ).data;
      assert.equal(state.workspaces[0].invite, undefined);
      assert.equal(state.people.length, 2);
    },
  );
  let teamRoom, messageSeq;
  await t.test(
    "room isolation, mentions, reactions, unread and monotonic read cursors",
    async () => {
      assert.equal(
        (
          await request(
            "/api/rooms",
            { workspaceId: "other", name: "비밀" },
            { cookie: memberCookie },
          )
        ).status,
        403,
      );
      teamRoom = (
        await request(
          "/api/rooms",
          { workspaceId, name: "디자인팀" },
          { token: ownerToken },
        )
      ).data.room.id;
      const m = await request(
        "/api/messages",
        {
          roomId: teamRoom,
          text: "@동료 안녕하세요",
          mentions: [memberId, "outsider"],
        },
        { token: ownerToken },
      );
      assert.equal(m.status, 201);
      assert.deepEqual(m.data.message.mentions, [memberId]);
      messageSeq = m.data.message.seq;
      let state = (
        await request("/api/sync?status=focus&room=" + roomId, undefined, {
          cookie: memberCookie,
        })
      ).data;
      assert.equal(state.messages.length, 0);
      assert.equal(state.inbox.length, 1);
      state = (
        await request("/api/sync?status=focus&room=" + teamRoom, undefined, {
          cookie: memberCookie,
        })
      ).data;
      assert.equal(state.messages[0].text, "@동료 안녕하세요");
      assert.equal(
        (
          await request(
            "/api/read",
            { roomId: teamRoom, seq: 9999 },
            { cookie: memberCookie },
          )
        ).status,
        400,
      );
      assert.equal(
        (
          await request(
            "/api/read",
            { roomId: teamRoom, seq: messageSeq },
            { cookie: memberCookie },
          )
        ).status,
        200,
      );
      await request(
        "/api/read",
        { roomId: teamRoom, seq: 0 },
        { cookie: memberCookie },
      );
      state = (
        await request("/api/sync?status=focus&room=" + teamRoom, undefined, {
          cookie: memberCookie,
        })
      ).data;
      assert.equal(state.inbox.length, 0);
      assert.equal(
        (
          await request(
            "/api/messages",
            {
              roomId: teamRoom,
              text: "👏",
              type: "reaction",
              toUserId: ownerId,
            },
            { cookie: memberCookie },
          )
        ).status,
        201,
      );
      assert.equal(
        (
          await request(
            "/api/messages",
            { roomId: "missing", text: "x" },
            { cookie: memberCookie },
          )
        ).status,
        404,
      );
    },
  );
  await t.test(
    "profile is shared and a disconnected client becomes offline after 45 seconds",
    async () => {
      const p = await request(
        "/api/profile",
        {
          name: "동료 새이름",
          petName: "토리",
          character: "bunny",
          role: "디자인팀",
          bio: "반가워요",
        },
        { cookie: memberCookie },
      );
      assert.equal(p.status, 200);
      let state = (
        await request("/api/sync?status=online", undefined, {
          token: ownerToken,
        })
      ).data;
      assert.equal(
        state.people.find((p) => p.id === memberId).name,
        "동료 새이름",
      );
      assert.equal(state.people.find((p) => p.id === memberId).status, "focus");
      now += 46000;
      state = (
        await request("/api/sync?status=online", undefined, {
          token: ownerToken,
        })
      ).data;
      assert.equal(
        state.people.find((p) => p.id === memberId).status,
        "offline",
      );
    },
  );
  await t.test(
    "invite rotation, expired device links, logout, and persisted chat after restart",
    async () => {
      const rotated = await request(
        "/api/workspaces/invite",
        { workspaceId },
        { token: ownerToken },
      );
      assert.equal(rotated.status, 200);
      assert.notEqual(rotated.data.invite, invite);
      assert.equal(
        (
          await request("/api/auth/register", {
            name: "새 동료",
            username: "newmember",
            password: "another-password-12",
            invite,
          })
        ).status,
        403,
      );
      const d = await request("/api/device/start", {
        challenge: challenge("expire"),
      });
      now += 300001;
      assert.equal(
        (
          await request("/api/device/poll", {
            deviceId: d.data.deviceId,
            verifier: "expire",
          })
        ).status,
        410,
      );
      await request("/api/auth/logout", {}, { cookie: memberCookie });
      assert.equal(
        (await request("/api/me", undefined, { cookie: memberCookie })).status,
        401,
      );
      await service.close();
      service = createService({ dataDir: dir, clock: () => now });
      address = await service.start(0);
      base = "http://127.0.0.1:" + address.port;
      const state = (
        await request("/api/sync?status=online&room=" + teamRoom, undefined, {
          token: ownerToken,
        })
      ).data;
      assert.equal(state.messages.length, 2);
      assert.equal(
        state.people.find((p) => p.id === memberId).character,
        "bunny",
      );
      assert.ok(ownerCookie);
    },
  );
  await t.test(
    "employees can leave and return independently, including the administrator",
    async () => {
      const memberLogin = await request("/api/auth/login", {
        username: "member",
        password: "member-password-12",
      });
      assert.equal(memberLogin.status, 200);
      const cookie = memberLogin.cookie;
      await request("/api/auth/logout", {}, { token: ownerToken });
      let state = (
        await request("/api/sync?status=online&room=" + teamRoom, undefined, {
          cookie,
        })
      ).data;
      assert.equal(
        state.people.find((p) => p.id === ownerId).status,
        "offline",
      );
      const message = await request(
        "/api/messages",
        {
          roomId: teamRoom,
          text: "관리자가 없어도 계속 대화해요",
          mentions: [ownerId],
        },
        { cookie },
      );
      assert.equal(message.status, 201);
      const returned = await request("/api/auth/login", {
        username: "owner",
        password: "correct-horse-12",
      });
      state = (
        await request("/api/sync?status=online&room=" + teamRoom, undefined, {
          cookie: returned.cookie,
        })
      ).data;
      assert.ok(
        state.inbox.some((m) => m.text === "관리자가 없어도 계속 대화해요"),
      );
      await request("/api/presence", { status: "offline" }, { cookie });
      state = (
        await request("/api/sync?status=online&room=" + teamRoom, undefined, {
          cookie: returned.cookie,
        })
      ).data;
      assert.equal(
        state.people.find((p) => p.id === memberId).status,
        "offline",
      );
    },
  );
});

test("cloud bootstrap requires a setup code and HTTPS session cookies behind the proxy", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moongle-bootstrap-"));
  const service = createService({
    dataDir: dir,
    initialInvite: "test-only-initial-setup-secret",
    publicUrl: "https://office.example.test",
  });
  const { port } = await service.start(0);
  const base = "http://127.0.0.1:" + port;
  t.after(async () => {
    await service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const config = await (await fetch(base + "/api/config")).json();
  assert.equal(config.mode, "cloud");
  assert.equal(config.requiresSetupCode, true);
  assert.equal((await fetch(base + "/health")).status, 200);
  async function register(invite) {
    return fetch(base + "/api/auth/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://office.example.test",
      },
      body: JSON.stringify({
        username: "admin",
        name: "관리자",
        password: "secure-password-2026",
        invite,
      }),
    });
  }
  assert.equal((await register("")).status, 403);
  const registered = await register("test-only-initial-setup-secret");
  assert.equal(registered.status, 201);
  assert.ok(registered.headers.get("set-cookie").includes("; Secure"));
  const disk = fs.readFileSync(path.join(dir, "office.json"), "utf8");
  assert.ok(!disk.includes("test-only-initial-setup-secret"));
  assert.equal(
    (await (await fetch(base + "/api/config")).json()).requiresSetupCode,
    false,
  );
});

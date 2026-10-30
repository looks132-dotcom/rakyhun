const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { LanPeer } = require("../lib/lan-peer");
const waitFor = async (fn) => {
  for (let i = 0; i < 80; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw Error("Timed out waiting for peer delivery");
};
test("LAN peers: independent encrypted messaging, retired avatars, offline queue and durable local history", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moongle-peers-"));
  let now = Date.now();
  const live = new Set();
  async function peer(name) {
    const p = new LanPeer({
      dataDir: path.join(root, name),
      discovery: false,
      clock: () => now,
    });
    live.add(p);
    await p.start({ port: 0, host: "127.0.0.1" });
    return p;
  }
  async function close(p) {
    await p.close();
    live.delete(p);
  }
  t.after(async () => {
    for (const p of live) await p.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  let a = await peer("a"),
    b = await peer("b");
  a.updateProfile({ ...a.profile, name: "수아" });
  b.updateProfile({ ...b.profile, name: "지우", character: "bunny" });
  const invitation = a.createGroup("우리 팀").invite;
  b.join(invitation);
  a.setStatus("online");
  b.setStatus("online");
  await a.connect("127.0.0.1", b.port);
  const room = a.snapshot().roomId;
  const aId = a.id,
    bId = b.id;
  await t.test(
    "private same-group peers connect without a designated host",
    async () => {
      assert.equal(a.presence(b.id), "online");
      assert.equal(b.presence(a.id), "online");
      assert.equal(a.snapshot().people.find((p) => p.id === b.id).name, "지우");
      const wrong = await peer("wrong");
      wrong.createGroup("다른 모임");
      wrong.setStatus("online");
      await assert.rejects(wrong.connect("127.0.0.1", a.port));
      assert.equal(wrong.snapshot().people.length, 1);
    },
  );
  await t.test(
    "messages are acknowledged and deduplicated; rooms and mentions synchronize",
    async () => {
      const sent = a.send({
        roomId: room,
        text: "@지우 반가워요",
        mentions: [b.id],
      });
      await waitFor(() =>
        b.snapshot().messages.some((m) => m.id === sent.message.id),
      );
      await waitFor(() => a.snapshot().messages[0].pending === 0);
      assert.equal(b.snapshot().inbox[0].mentions[0], b.id);
      a.group().deliveries[sent.message.id] = [];
      await a.flush(b.id);
      assert.equal(
        b.snapshot().messages.filter((m) => m.id === sent.message.id).length,
        1,
      );
      const created = a.api("/api/rooms", { name: "디자인팀" }).room;
      await a.flush(b.id);
      await waitFor(() => b.snapshot().rooms.some((r) => r.id === created.id));
    },
  );
  await t.test(
    "a peer cannot forge another sender even with the same invitation",
    async () => {
      await a.exchange("127.0.0.1", b.port, {
        kind: "sync",
        profile: a.publicProfile(),
        status: "online",
        rooms: a.group().rooms,
        messages: [
          {
            id: "forged",
            userId: b.id,
            name: "지우",
            roomId: room,
            text: "가짜 메시지",
            createdAt: now,
          },
        ],
      });
      assert.ok(!b.snapshot().messages.some((m) => m.id === "forged"));
      const packet = a.seal({
        kind: "hello",
        profile: a.publicProfile(),
        status: "online",
      });
      packet.data = packet.data.slice(0, -5) + "AAAAA";
      const response = await fetch("http://127.0.0.1:" + b.port + "/peer", {
        method: "POST",
        body: JSON.stringify(packet),
      });
      assert.equal(response.status, 403);
    },
  );
  await t.test(
    "offline coworkers remain in the contact list and messages stay queued",
    async () => {
      await close(b);
      assert.equal(a.presence(bId), "offline");
      assert.ok(a.snapshot().people.find((p) => p.id === bId));
      a.send({ roomId: room, text: "퇴근 후에도 기록은 남아요" });
      assert.equal(a.snapshot().messages.at(-1).pending, 1);
      assert.equal(a.snapshot().messages.length, 2);
      await close(a);
    },
  );
  await t.test(
    "restarting both devices preserves identity, history and pending delivery",
    async () => {
      a = await peer("a");
      b = await peer("b");
      assert.equal(a.id, aId);
      assert.equal(b.id, bId);
      assert.equal(a.snapshot().messages.length, 2);
      assert.equal(a.presence(bId), "offline");
      assert.equal(b.snapshot().messages.length, 1);
      a.setStatus("online");
      b.setStatus("online");
      await a.connect("127.0.0.1", b.port);
      await waitFor(() =>
        b
          .snapshot()
          .messages.some((m) => m.text === "퇴근 후에도 기록은 남아요"),
      );
      await waitFor(() => a.snapshot().messages.at(-1).pending === 0);
      assert.equal(b.snapshot().messages.length, 2);
    },
  );
  await t.test(
    "unexpected disconnect expires presence but retains characters and records",
    async () => {
      now += 17000;
      assert.equal(a.presence(bId), "offline");
      const person = a.snapshot().people.find((p) => p.id === bId);
      assert.equal(person.status, "offline");
      assert.equal(person.character, "bunny");
      assert.equal(a.snapshot().messages.length, 2);
      const seq = Math.max(...b.snapshot().messages.map((m) => m.seq));
      b.api("/api/read", { roomId: room, seq });
      assert.equal(b.snapshot().inbox.length, 0);
    },
  );
});

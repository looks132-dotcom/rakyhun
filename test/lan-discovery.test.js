const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { LanPeer } = require("../lib/lan-peer");
test("automatic multicast/broadcast discovery connects two equal peers", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moongle-discovery-")),
    port = 49000 + Math.floor(Math.random() * 1000);
  const a = new LanPeer({ dataDir: path.join(dir, "a"), discoveryPort: port }),
    b = new LanPeer({ dataDir: path.join(dir, "b"), discoveryPort: port });
  t.after(async () => {
    await a.close();
    await b.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await a.start({ port: 0 });
  await b.start({ port: 0 });
  const code = a.createGroup("자동 검색 테스트").invite;
  b.join(code);
  a.setStatus("online");
  b.setStatus("online");
  for (
    let i = 0;
    i < 100 && (!a.group().contacts[b.id] || !b.group().contacts[a.id]);
    i++
  )
    await new Promise((r) => setTimeout(r, 100));
  assert.ok(a.group().contacts[b.id], "first peer discovered second");
  assert.ok(b.group().contacts[a.id], "second peer discovered first");
  const { message } = a.send({
    roomId: a.snapshot().roomId,
    text: "주소 입력 없이 자동 연결",
  });
  for (
    let i = 0;
    i < 100 && !b.snapshot().messages.some((m) => m.id === message.id);
    i++
  )
    await new Promise((r) => setTimeout(r, 100));
  assert.ok(b.snapshot().messages.some((m) => m.id === message.id));
});

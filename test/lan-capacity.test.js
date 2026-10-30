const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os");
const { LanPeer } = require("../lib/lan-peer"),
  { setLimit } = require("../lib/lan-membership");
test("reusable clean invite, ten total members, adjustable capacity and offline member counts", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moongle-capacity-")),
    peers = [];
  async function peer(n) {
    const p = new LanPeer({
      dataDir: path.join(root, String(n)),
      discovery: false,
    });
    peers.push(p);
    await p.start({ port: 0, host: "127.0.0.1" });
    p.setStatus("online");
    return p;
  }
  t.after(async () => {
    await Promise.all(peers.map((p) => p.close()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const owner = await peer(0),
    { invite } = owner.createGroup("열 명 모임");
  assert.match(invite, /^[\w-]{43}$/);
  assert.equal(owner.snapshot().workspaces[0].maxMembers, 10);
  for (let n = 1; n <= 9; n++) {
    const p = await peer(n);
    p.join(
      n === 1
        ? "  " + invite + "\n"
        : n === 2
          ? "초대 코드:\n" + invite + "\n같은 사내 모임에 참여하세요."
          : invite,
    );
    await p.connect("127.0.0.1", owner.port);
  }
  assert.equal(owner.snapshot().people.length, 10);
  assert.equal(owner.snapshot().workspaces[0].memberCount, 10);
  const last = peers[9];
  assert.equal(
    last.snapshot().people.length,
    10,
    "member directory is shared, not a one-invite-only link",
  );
  const overflow = await peer(10);
  overflow.join(invite);
  setLimit(overflow, 20);
  await assert.rejects(
    overflow.connect("127.0.0.1", owner.port),
    /정원이 10명/,
  );
  assert.equal(owner.snapshot().people.length, 10);
  await peers[2].close();
  peers.splice(2, 1);
  assert.equal(
    owner.snapshot().workspaces[0].memberCount,
    10,
    "retired members count toward capacity",
  );
  assert.throws(() => setLimit(owner, 9), /등록된 10명/);
  setLimit(owner, 12);
  await overflow.connect("127.0.0.1", owner.port);
  assert.equal(owner.snapshot().people.length, 11);
  assert.equal(overflow.snapshot().workspaces[0].maxMembers, 12);
  await owner.flush(last.id);
  for (
    let i = 0;
    i < 60 && last.snapshot().workspaces[0].maxMembers !== 12;
    i++
  )
    await new Promise((r) => setTimeout(r, 50));
  assert.equal(
    last.snapshot().workspaces[0].maxMembers,
    12,
    "limit is propagated to existing peers",
  );
  const legacy =
    "MOONGLE1." +
    Buffer.from(
      JSON.stringify({ key: owner.group().key, name: "열 명 모임" }),
    ).toString("base64url");
  const legacyPeer = await peer(20);
  legacyPeer.join("뭉글 사내 모임 초대\n" + legacy + "\n안내 문구");
  await legacyPeer.connect("127.0.0.1", owner.port);
  assert.equal(owner.snapshot().people.length, 12);
  assert.equal(legacyPeer.invite(), invite);
});

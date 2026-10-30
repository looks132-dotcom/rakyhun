const { EventEmitter } = require("node:events");
const crypto = require("node:crypto"),
  fs = require("node:fs"),
  path = require("node:path"),
  http = require("node:http"),
  dgram = require("node:dgram"),
  os = require("node:os");
const DISCOVERY_PORT = 41764,
  MULTICAST = "239.255.41.76";
const hash = (s) => crypto.createHash("sha256").update(s).digest("hex");
const text = (s, n = 80) => (typeof s === "string" ? s.trim().slice(0, n) : "");
const statuses = ["online", "focus", "away", "offline"];
const membership = require("./lan-membership");
const privateAddress = (ip) =>
  /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(
    ip || "",
  );
function identity() {
  const keys = crypto.generateKeyPairSync("ed25519");
  return {
    publicKey: keys.publicKey.export({ type: "spki", format: "pem" }),
    privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }),
  };
}
class LanPeer extends EventEmitter {
  constructor({
    dataDir,
    encode = (s) => s,
    decode = (s) => s,
    discovery = true,
    discoveryPort = DISCOVERY_PORT,
    clock = Date.now,
    ttl = 16000,
  } = {}) {
    super();
    this.clock = clock;
    this.ttl = ttl;
    this.discovery = discovery;
    this.discoveryPort = discoveryPort;
    this.encode = encode;
    this.file = path.join(dataDir, "lan-history.dat");
    fs.mkdirSync(dataDir, { recursive: true });
    this.state = fs.existsSync(this.file)
      ? JSON.parse(decode(fs.readFileSync(this.file)))
      : {
          identity: identity(),
          profile: {
            name: "나",
            petName: "모찌",
            character: "mochi",
            bio: "오늘도 반가워요!",
            role: "",
          },
          groups: {},
          current: "",
          sequence: 0,
        };
    this.id = hash(this.state.identity.publicKey).slice(0, 32);
    this.status = "offline";
    this.peers = new Map();
    this.inflight = new Set();
    this.sockets = new Set();
    this.warning = "";
    for (const g of Object.values(this.state.groups)) membership.normalize(g);
    this.save();
  }
  save() {
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, this.encode(JSON.stringify(this.state)), {
      mode: 0o600,
    });
    fs.renameSync(tmp, this.file);
  }
  group() {
    return this.state.groups[this.state.current];
  }
  get profile() {
    return {
      ...this.state.profile,
      id: this.id,
      status: this.status,
      workspaceIds: this.state.current ? [this.state.current] : [],
    };
  }
  changed() {
    this.emit("change");
  }
  async start({ port = 41765, host = "0.0.0.0" } = {}) {
    this.server = http.createServer(async (req, res) => {
      try {
        const remote = req.socket.remoteAddress?.replace("::ffff:", "");
        if (
          !privateAddress(remote) ||
          req.method !== "POST" ||
          req.url !== "/peer"
        )
          throw Error("Not allowed");
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 650000) throw Error("Too large");
          chunks.push(chunk);
        }
        const packet = this.open(JSON.parse(Buffer.concat(chunks).toString()));
        let response;
        try {
          response = this.receive(packet, remote);
        } catch (error) {
          if (error.code !== "GROUP_FULL") throw error;
          response = {
            kind: "rejected",
            error: error.message,
            maxMembers: error.limit,
            memberCount: error.memberCount,
          };
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify(this.seal({ ...response, reply: packet.nonce })),
        );
      } catch {
        res.writeHead(403);
        res.end("{}");
      }
    });
    this.server.requestTimeout = 5000;
    this.server.headersTimeout = 6000;
    this.server.on("connection", (s) => {
      this.sockets.add(s);
      s.on("close", () => this.sockets.delete(s));
      s.setTimeout(6000, () => s.destroy());
    });
    await new Promise((resolve, reject) => {
      const failed = (e) => {
        if (e.code === "EADDRINUSE" && port !== 0) {
          port = 0;
          this.server.listen(0, host, resolve);
        } else reject(e);
      };
      this.server.once("error", failed);
      this.server.listen(port, host, resolve);
    });
    this.port = this.server.address().port;
    if (this.discovery) {
      this.udp = dgram.createSocket({ type: "udp4", reuseAddr: true });
      this.udp.on("error", () => {
        this.warning =
          "자동 검색을 사용할 수 없어요. 동료의 사내 주소로 직접 연결해 주세요.";
        this.changed();
      });
      this.udp.on("message", (bytes, remote) => {
        try {
          if (bytes.length > 8000 || !privateAddress(remote.address)) return;
          const p = this.open(JSON.parse(bytes.toString()));
          if (p.kind !== "beacon") return;
          this.remember(p, remote.address);
          this.flush(p.id).catch(() => {});
        } catch {}
      });
      await new Promise((resolve) => {
        this.udp.once("error", resolve);
        this.udp.bind(this.discoveryPort, "0.0.0.0", () => {
          try {
            const interfaces = Object.values(os.networkInterfaces())
              .flat()
              .filter(
                (n) =>
                  n.family === "IPv4" &&
                  !n.internal &&
                  privateAddress(n.address),
              );
            let joined = false;
            for (const n of interfaces)
              try {
                this.udp.addMembership(MULTICAST, n.address);
                joined = true;
              } catch {}
            if (!joined) this.udp.addMembership(MULTICAST);
            this.udp.setMulticastTTL(1);
            this.udp.setBroadcast(true);
          } catch {
            this.warning =
              "자동 검색이 제한되어 있어요. 사내 주소로 직접 연결할 수 있어요.";
          }
          resolve();
        });
      });
    }
    this.timer = setInterval(() => this.tick(), 4000);
    this.timer.unref();
    this.tick();
    return { port: this.port };
  }
  invite() {
    const g = this.group();
    return g ? g.key : "";
  }
  createGroup(name) {
    const code =
      "MOONGLE1." +
      Buffer.from(
        JSON.stringify({
          key: crypto.randomBytes(32).toString("base64url"),
          name: text(name, 40) || "우리의 오피스",
        }),
      ).toString("base64url");
    return this.join(code);
  }
  join(code) {
    if (typeof code !== "string" || code.length > 4096)
      throw Error("우리 모임 초대 코드를 확인해 주세요.");
    const pasted = code.trim(),
      legacy = pasted.match(/MOONGLE1\.[A-Za-z0-9_-]+/),
      compact = pasted.replace(/\s/g, "");
    let data;
    try {
      if (legacy)
        data = JSON.parse(
          Buffer.from(legacy[0].slice(9), "base64url").toString(),
        );
      else {
        const match = /^[\w-]{43}$/.test(compact)
          ? compact
          : pasted.match(/(?:^|[^\w-])([\w-]{43})(?=$|[^\w-])/)?.[1];
        if (!match) throw Error();
        data = { key: match, name: "우리 모임" };
      }
    } catch {
      throw Error("초대 코드를 읽을 수 없어요.");
    }
    if (
      typeof data.key !== "string" ||
      !/^[\w-]{43}$/.test(data.key) ||
      Buffer.from(data.key, "base64url").length !== 32
    )
      throw Error("초대 코드를 확인해 주세요.");
    if (this.group()) this.announce("offline");
    const gid = hash(data.key).slice(0, 24);
    if (!this.state.groups[gid])
      this.state.groups[gid] = {
        id: gid,
        key: data.key,
        name: text(data.name, 40) || "우리의 오피스",
        contacts: {},
        rooms: [{ id: gid + "-lounge", workspaceId: gid, name: "전체 대화" }],
        messages: [],
        reads: {},
        deliveries: {},
        targets: {},
        manual: [],
        maxMembers: 10,
        memberCertificates: {},
      };
    this.state.current = gid;
    membership.normalize(this.group());
    this.peers.clear();
    this.save();
    this.changed();
    this.tick();
    return { workspaceId: gid, invite: this.invite() };
  }
  seal(data) {
    const g = this.group();
    if (!g) throw Error("모임에 먼저 참여해 주세요.");
    const payload = {
      ...data,
      ...membership.metadata(this, data.kind === "beacon"),
      id: this.id,
      publicKey: this.state.identity.publicKey,
      port: this.port,
      time: this.clock(),
      nonce: crypto.randomBytes(16).toString("hex"),
    };
    const body = JSON.stringify(payload),
      signed = JSON.stringify({
        body,
        signature: crypto
          .sign(null, Buffer.from(body), this.state.identity.privateKey)
          .toString("base64"),
      });
    const iv = crypto.randomBytes(12),
      cipher = crypto.createCipheriv(
        "aes-256-gcm",
        Buffer.from(g.key, "base64url"),
        iv,
      );
    const encrypted = Buffer.concat([cipher.update(signed), cipher.final()]);
    return {
      v: 1,
      g: g.id,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: encrypted.toString("base64"),
    };
  }
  open(envelope) {
    const g = this.group();
    if (!g || envelope.v !== 1 || envelope.g !== g.id)
      throw Error("Wrong group");
    const iv = Buffer.from(envelope.iv, "base64"),
      tag = Buffer.from(envelope.tag, "base64");
    if (
      iv.length !== 12 ||
      tag.length !== 16 ||
      typeof envelope.data !== "string" ||
      envelope.data.length > 850000
    )
      throw Error("Invalid packet");
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      Buffer.from(g.key, "base64url"),
      iv,
    );
    decipher.setAuthTag(tag);
    const signed = JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(envelope.data, "base64")),
        decipher.final(),
      ]).toString(),
    );
    if (typeof signed.body !== "string") throw Error("Invalid body");
    const p = JSON.parse(signed.body);
    if (
      typeof p.publicKey !== "string" ||
      p.publicKey.length > 300 ||
      hash(p.publicKey).slice(0, 32) !== p.id ||
      !crypto.verify(
        null,
        Buffer.from(signed.body),
        p.publicKey,
        Buffer.from(signed.signature, "base64"),
      )
    )
      throw Error("Invalid identity");
    if (
      !Number.isFinite(p.time) ||
      Math.abs(this.clock() - p.time) > 60000 ||
      !/^\w{32}$/.test(p.nonce || "") ||
      !Number.isInteger(p.port) ||
      p.port < 1 ||
      p.port > 65535
    )
      throw Error("Invalid time or port");
    return p;
  }
  publicProfile() {
    return { ...this.state.profile, status: this.status };
  }
  remember(p, address) {
    if (p.id === this.id) return;
    const g = this.group();
    membership.apply(this, p);
    const old = g.contacts[p.id] || {},
      details = p.profile || {};
    const safe = {
      name: text(details.name || p.name, 20) || old.name || "동료",
      petName: text(details.petName || p.petName, 20) || old.petName || "모찌",
      character: ["mochi", "bunny", "bean", "custom"].includes(
        details.character || p.character,
      )
        ? details.character || p.character
        : old.character || "mochi",
      role: p.profile ? text(details.role, 40) : old.role || "",
      bio: p.profile ? text(details.bio, 120) : old.bio || "",
    };
    if (
      typeof details.image === "string" &&
      details.image.length < 400000 &&
      /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(details.image)
    )
      safe.image = details.image;
    else if (old.image) safe.image = old.image;
    const status = statuses.includes(p.status || details.status)
      ? p.status || details.status
      : "offline";
    const updated = {
      ...old,
      ...safe,
      id: p.id,
      publicKey: p.publicKey,
      address,
      port: p.port,
    };
    if (p.profile && !details.image) delete updated.image;
    if (JSON.stringify(updated) !== JSON.stringify(old)) {
      g.contacts[p.id] = updated;
      this.save();
    }
    const previous = this.peers.get(p.id);
    if (!previous || p.time >= previous.time)
      this.peers.set(p.id, {
        address,
        port: p.port,
        status,
        lastSeen: this.clock(),
        time: p.time,
      });
    if (
      !previous ||
      previous.status !== status ||
      JSON.stringify(old) !== JSON.stringify(updated)
    )
      this.changed();
  }
  presence(id) {
    if (id === this.id) return this.status;
    const p = this.peers.get(id);
    return p && this.clock() - p.lastSeen < this.ttl ? p.status : "offline";
  }
  receive(p, address) {
    if (p.id === this.id) throw Error("Self");
    this.remember(p, address);
    const g = this.group();
    if (p.kind === "sync") {
      if (Array.isArray(p.rooms))
        for (const r of p.rooms.slice(0, 30))
          if (
            typeof r.id === "string" &&
            r.id.startsWith(g.id + "-") &&
            text(r.name, 24) &&
            !g.rooms.some((x) => x.id === r.id) &&
            g.rooms.length < 30
          )
            g.rooms.push({
              id: r.id,
              workspaceId: g.id,
              name: text(r.name, 24),
            });
      const received = [];
      if (this.status !== "offline" && Array.isArray(p.messages))
        for (const m of p.messages.slice(0, 40)) {
          if (
            !m ||
            m.userId !== p.id ||
            typeof m.id !== "string" ||
            m.id.length > 80 ||
            !g.rooms.some((r) => r.id === m.roomId) ||
            !text(m.text, 300) ||
            !Number.isFinite(m.createdAt) ||
            m.createdAt < 0 ||
            m.createdAt > this.clock() + 86400000
          )
            continue;
          if (!g.messages.some((old) => old.id === m.id)) {
            g.messages.push({
              id: m.id,
              userId: p.id,
              name: g.contacts[p.id].name,
              roomId: m.roomId,
              text: text(m.text, 300),
              type: m.type === "reaction" ? "reaction" : "text",
              toUserId: text(m.toUserId, 32),
              mentions: Array.isArray(m.mentions)
                ? m.mentions.filter((x) => typeof x === "string").slice(0, 100)
                : [],
              createdAt: m.createdAt,
              receivedAt: this.clock(),
              seq: ++this.state.sequence,
            });
            this.changed();
          }
          received.push(m.id);
        }
      this.trim();
      this.save();
      return {
        kind: "ack",
        profile: this.publicProfile(),
        status: this.status,
        received,
        rooms: g.rooms,
      };
    }
    return {
      kind: "hello",
      profile: this.publicProfile(),
      status: this.status,
    };
  }
  async exchange(address, port, data) {
    if (
      !privateAddress(address) ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535
    )
      throw Error("사내 IP와 포트를 확인해 주세요.");
    const packet = this.seal(data);
    const nonce = this.open(packet).nonce;
    const result = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: address,
          port,
          path: "/peer",
          method: "POST",
          headers: { "Content-Type": "application/json" },
          timeout: 3000,
        },
        (res) => {
          let size = 0;
          const chunks = [];
          res.on("data", (c) => {
            size += c.length;
            if (size > 650000) res.destroy(Error("Too large"));
            else chunks.push(c);
          });
          res.on("error", reject);
          res.on("end", () => {
            try {
              if (res.statusCode !== 200)
                throw Error("모임 코드가 다르거나 상대가 응답하지 않아요.");
              resolve(this.open(JSON.parse(Buffer.concat(chunks).toString())));
            } catch (e) {
              reject(e);
            }
          });
        },
      );
      req.on("timeout", () => req.destroy(Error("연결 시간이 초과됐어요.")));
      req.on("error", reject);
      req.end(JSON.stringify(packet));
    });
    if (result.reply !== nonce) throw Error("Invalid reply");
    if (result.kind === "rejected") {
      membership.adoptCapacity(this, result);
      this.warning = result.error || "모임에 참여할 수 없어요.";
      this.changed();
      throw Error(this.warning);
    }
    this.remember(result, address);
    if (this.warning.startsWith("모임 정원이")) {
      this.warning = "";
      this.changed();
    }
    return result;
  }
  async connect(address, port, { remember = true } = {}) {
    const r = await this.exchange(address, port, {
      kind: "hello",
      profile: this.publicProfile(),
      status: this.status,
    });
    if (remember) {
      const g = this.group();
      if (!g.manual.some((m) => m.address === address && m.port === port)) {
        g.manual.push({ address, port });
        this.save();
      }
    }
    await this.flush(r.id);
    return { id: r.id };
  }
  async flush(id) {
    const g = this.group(),
      p = this.peers.get(id);
    if (
      !g ||
      !p ||
      this.status === "offline" ||
      this.presence(id) === "offline" ||
      this.inflight.has(id)
    )
      return;
    this.inflight.add(id);
    try {
      const outgoing = g.messages
        .filter(
          (m) =>
            m.userId === this.id && !(g.deliveries[m.id] || []).includes(id),
        )
        .slice(0, 40)
        .map(({ seq, receivedAt, delivery, ...m }) => m);
      const r = await this.exchange(p.address, p.port, {
        kind: "sync",
        profile: this.publicProfile(),
        status: this.status,
        rooms: g.rooms,
        messages: outgoing,
      });
      if (r.id !== id) throw Error("Peer changed");
      for (const mid of Array.isArray(r.received) ? r.received : [])
        if (outgoing.some((m) => m.id === mid)) {
          g.deliveries[mid] ||= [];
          if (!g.deliveries[mid].includes(id)) g.deliveries[mid].push(id);
        }
      if (Array.isArray(r.rooms))
        for (const room of r.rooms.slice(0, 30))
          if (
            room.id?.startsWith(g.id + "-") &&
            text(room.name, 24) &&
            !g.rooms.some((x) => x.id === room.id) &&
            g.rooms.length < 30
          )
            g.rooms.push({
              id: room.id,
              workspaceId: g.id,
              name: text(room.name, 24),
            });
      this.save();
      this.changed();
    } catch {
    } finally {
      this.inflight.delete(id);
    }
  }
  announce(status = this.status) {
    if (!this.udp || !this.group()) return;
    try {
      const data = Buffer.from(
        JSON.stringify(
          this.seal({
            kind: "beacon",
            status,
            name: this.profile.name,
            petName: this.profile.petName,
            character: this.profile.character,
          }),
        ),
      );
      this.udp.send(data, this.discoveryPort, MULTICAST, () => {});
      this.udp.send(data, this.discoveryPort, "255.255.255.255", () => {});
    } catch {}
  }
  tick() {
    if (!this.group()) return;
    this.announce();
    for (const [id, p] of this.peers) {
      if (this.clock() - p.lastSeen >= this.ttl && p.status !== "offline") {
        p.status = "offline";
        this.changed();
      }
      this.flush(id).catch(() => {});
    }
    if (!this.manualTick || this.clock() - this.manualTick > 12000) {
      this.manualTick = this.clock();
      for (const m of this.group().manual)
        this.connect(m.address, m.port, { remember: false }).catch(() => {});
    }
  }
  setStatus(status) {
    if (!statuses.includes(status)) throw Error("상태를 확인해 주세요.");
    if (this.status === status) return;
    this.status = status;
    this.announce();
    this.changed();
    if (status !== "offline") this.tick();
  }
  updateProfile(profile) {
    if (
      !text(profile.name, 20) ||
      !text(profile.petName, 20) ||
      !["mochi", "bunny", "bean", "custom"].includes(profile.character)
    )
      throw Error("이름과 캐릭터를 확인해 주세요.");
    if (
      profile.image &&
      (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(
        profile.image,
      ) ||
        profile.image.length > 400000)
    )
      throw Error("이미지를 확인해 주세요.");
    Object.assign(this.state.profile, {
      name: text(profile.name, 20),
      petName: text(profile.petName, 20),
      character: profile.character,
      bio: text(profile.bio, 120),
      role: text(profile.role, 40),
      image: profile.image || "",
    });
    this.state.profileInitialized = true;
    this.state.profileRevision = Math.max(
      this.clock(),
      (this.state.profileRevision || 0) + 1,
    );
    this.save();
    this.announce();
    this.tick();
    this.changed();
    return this.profile;
  }
  trim() {
    const g = this.group();
    if (g.messages.length > 10000) {
      const removed = g.messages.splice(0, g.messages.length - 10000);
      for (const m of removed) {
        delete g.deliveries[m.id];
        delete g.targets[m.id];
      }
    }
  }
  send({ roomId, text: message, type = "text", toUserId = "", mentions = [] }) {
    const g = this.group();
    if (!g || !g.rooms.some((r) => r.id === roomId))
      throw Error("대화방을 먼저 선택해 주세요.");
    if (this.status === "offline") throw Error("접속한 뒤 대화할 수 있어요.");
    if (!text(message, 300)) throw Error("메시지를 입력해 주세요.");
    const m = {
      id: crypto.randomUUID(),
      seq: ++this.state.sequence,
      userId: this.id,
      name: this.profile.name,
      roomId,
      text: text(message, 300),
      type: type === "reaction" ? "reaction" : "text",
      toUserId: text(toUserId, 32),
      mentions: Array.isArray(mentions)
        ? mentions.filter((x) => x === this.id || g.contacts[x]).slice(0, 100)
        : [],
      createdAt: this.clock(),
    };
    g.messages.push(m);
    g.targets[m.id] = Object.keys(g.contacts);
    g.deliveries[m.id] = [];
    this.trim();
    this.save();
    this.changed();
    for (const id of this.peers.keys()) this.flush(id).catch(() => {});
    return { message: m };
  }
  snapshot(roomId) {
    const g = this.group();
    if (!g)
      return {
        user: this.profile,
        workspaces: [],
        rooms: [],
        people: [this.profile],
        messages: [],
        inbox: [],
        roomId: "",
        warning: this.warning,
      };
    const room = g.rooms.find((r) => r.id === roomId) || g.rooms[0];
    const messages = g.messages
      .filter((m) => m.roomId === room.id)
      .slice(-300)
      .map((m) => ({
        ...m,
        pending:
          m.userId === this.id
            ? (g.targets[m.id] || []).filter(
                (id) => !(g.deliveries[m.id] || []).includes(id),
              ).length
            : 0,
      }));
    return {
      user: this.profile,
      workspaces: [
        {
          id: g.id,
          name: g.name,
          invite: this.invite(),
          maxMembers: g.maxMembers || 10,
          memberCount: Object.keys(g.contacts).length + 1,
        },
      ],
      rooms: g.rooms,
      people: [
        this.profile,
        ...Object.values(g.contacts).map((p) => ({
          ...p,
          publicKey: undefined,
          address: undefined,
          port: undefined,
          status: this.presence(p.id),
        })),
      ],
      messages,
      inbox: g.messages
        .filter((m) => m.userId !== this.id && m.seq > (g.reads[m.roomId] || 0))
        .slice(-300),
      roomId: room.id,
      warning: this.warning,
    };
  }
  api(route, body) {
    const u = new URL(route, "http://local");
    if (u.pathname === "/api/me") return { user: this.profile };
    if (u.pathname === "/api/sync")
      return this.snapshot(u.searchParams.get("room"));
    if (u.pathname === "/api/profile")
      return { user: this.updateProfile(body) };
    if (u.pathname === "/api/presence") {
      this.setStatus(body.status);
      return { ok: true };
    }
    if (u.pathname === "/api/messages") return this.send(body);
    if (u.pathname === "/api/rooms") {
      const g = this.group();
      if (!g || !text(body.name, 24) || g.rooms.length >= 30)
        throw Error("방 이름 또는 방 개수를 확인해 주세요.");
      const room = {
        id: g.id + "-" + crypto.randomUUID(),
        workspaceId: g.id,
        name: text(body.name, 24),
      };
      g.rooms.push(room);
      this.save();
      this.tick();
      this.changed();
      return { room };
    }
    if (u.pathname === "/api/read") {
      const g = this.group();
      if (
        !g?.rooms.some((r) => r.id === body.roomId) ||
        !Number.isSafeInteger(body.seq) ||
        body.seq < 0 ||
        body.seq > this.state.sequence
      )
        throw Error("읽음 위치를 확인해 주세요.");
      g.reads[body.roomId] = Math.max(g.reads[body.roomId] || 0, body.seq);
      this.save();
      return { ok: true };
    }
    throw Error("지원하지 않는 요청이에요.");
  }
  addresses() {
    return Object.values(os.networkInterfaces())
      .flat()
      .filter(
        (n) => n.family === "IPv4" && !n.internal && privateAddress(n.address),
      )
      .map((n) => n.address + ":" + this.port);
  }
  async close() {
    clearInterval(this.timer);
    this.setStatus("offline");
    const connections = [...this.peers.values()].map((p) =>
      this.exchange(p.address, p.port, {
        kind: "hello",
        profile: this.publicProfile(),
        status: "offline",
      }).catch(() => {}),
    );
    await Promise.race([
      Promise.all(connections),
      new Promise((r) => setTimeout(r, 300)),
    ]);
    if (this.udp)
      try {
        this.udp.close();
      } catch {}
    for (const s of this.sockets) s.destroy();
    if (this.server) await new Promise((r) => this.server.close(r));
    this.save();
  }
}
module.exports = { LanPeer, privateAddress, DISCOVERY_PORT };

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { isIP } = require("node:net");
const { promisify } = require("node:util");
const scrypt = promisify(crypto.scrypt);
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const random = () => crypto.randomBytes(24).toString("base64url");
const id = () => crypto.randomUUID();
const allowedStatuses = ["online", "focus", "away", "offline"];
const clean = (v, length = 80) =>
  typeof v === "string" ? v.trim().slice(0, length) : "";
class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function createService({
  dataDir = path.join(__dirname, "..", "data"),
  clock = Date.now,
  google = {},
  initialInvite,
  publicUrl = google.publicUrl || "",
  trustProxy = false,
} = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const dataFile = path.join(dataDir, "office.json");
  const db = fs.existsSync(dataFile)
    ? JSON.parse(fs.readFileSync(dataFile, "utf8"))
    : {
        users: [],
        workspaces: [],
        rooms: [],
        messages: [],
        sessions: [],
        reads: {},
      };
  const devices = new Map(),
    activity = new Map(),
    attempts = new Map(),
    oauth = new Map();
  let server;
  const save = () => {
    const tmp = dataFile + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(db), { mode: 0o600 });
    fs.renameSync(tmp, dataFile);
  };
  const publicUser = (u) => ({
    id: u.id,
    name: u.name,
    petName: u.petName,
    role: u.role,
    bio: u.bio,
    character: u.character,
    image: u.image,
    workspaceIds: u.workspaceIds,
    status: presence(u.id),
  });
  function presence(userId) {
    const connections = [...activity.values()].filter(
      (a) => a.userId === userId && clock() - a.time < 45000,
    );
    return connections.sort((a, b) => b.time - a.time)[0]?.status || "offline";
  }
  function issue(userId, remember) {
    const token = random();
    db.sessions = db.sessions.filter((s) => s.expires > clock());
    db.sessions.push({
      hash: hash(token),
      userId,
      expires: clock() + (remember ? 30 : 1) * 86400000,
    });
    save();
    return token;
  }
  function cookies(req) {
    return Object.fromEntries(
      (req.headers.cookie || "").split(";").map((v) => v.trim().split("=")),
    );
  }
  function auth(req) {
    const token =
      req.headers.authorization?.replace(/^Bearer /, "") ||
      cookies(req).moongle;
    const session =
      token &&
      db.sessions.find((s) => s.hash === hash(token) && s.expires > clock());
    const user = session && db.users.find((u) => u.id === session.userId);
    if (!user) throw new AppError(401, "로그인이 필요해요.");
    return { user, token, session };
  }
  function member(user, workspaceId) {
    if (!user.workspaceIds.includes(workspaceId))
      throw new AppError(403, "초대받은 공간만 사용할 수 있어요.");
  }
  function getRoom(user, roomId) {
    const room = db.rooms.find((r) => r.id === roomId);
    if (!room) throw new AppError(404, "방을 찾을 수 없어요.");
    member(user, room.workspaceId);
    return room;
  }
  function consumeDevice(deviceId, userId, remember) {
    const d = devices.get(deviceId);
    if (d && d.expires > clock() && !d.userId)
      Object.assign(d, { userId, remember: !!remember });
  }
  function rate(req, group = "auth", limit = 35) {
    const forwarded =
      trustProxy && req.headers["x-forwarded-for"]?.split(",").at(-1)?.trim();
    const key = `${forwarded && isIP(forwarded) ? forwarded : req.socket.remoteAddress}:${group}`,
      entry = attempts.get(key) || { time: clock(), count: 0 };
    if (clock() - entry.time > 60000) {
      entry.time = clock();
      entry.count = 0;
    }
    entry.count++;
    attempts.set(key, entry);
    if (entry.count > limit)
      throw new AppError(
        429,
        "요청이 너무 많아요. 잠시 후 다시 시도해 주세요.",
      );
  }
  async function body(req) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 550000) throw new AppError(413, "요청 크기가 너무 커요.");
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString() || "{}");
    } catch {
      throw new AppError(400, "올바른 JSON이 아니에요.");
    }
  }
  const json = (res, status, value) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(value));
  };
  function setCookie(req, res, token, remember) {
    res.setHeader(
      "Set-Cookie",
      `moongle=${token}; HttpOnly; SameSite=Lax; Path=/${remember ? "; Max-Age=2592000" : ""}${publicUrl.startsWith("https:") || req.socket.encrypted ? "; Secure" : ""}`,
    );
  }
  async function handle(req, res) {
    try {
      const url = new URL(req.url, "http://localhost");
      // Browser writes are same-origin; desktop API calls use bearer tokens, never browser cookies.
      if (!["GET", "HEAD"].includes(req.method) && req.headers.origin) {
        if (
          publicUrl
            ? req.headers.origin !== new URL(publicUrl).origin
            : new URL(req.headers.origin).host !== req.headers.host
        )
          throw new AppError(403, "다른 웹사이트에서 요청할 수 없어요.");
      }
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("X-Frame-Options", "DENY");
      const route = req.method + " " + url.pathname;
      if (route === "GET /health") return json(res, 200, { ok: true });
      if (route === "GET /api/config")
        return json(res, 200, {
          firstUser: db.users.length === 0,
          google: !!(
            google.clientId &&
            google.clientSecret &&
            google.publicUrl
          ),
          version: "0.3.0",
          mode: "cloud",
          apiVersion: 1,
          requiresSetupCode: db.users.length === 0 && !!initialInvite,
        });
      if (route === "POST /api/device/start") {
        rate(req, "device", 30);
        const b = await body(req);
        if (!/^[a-f0-9]{64}$/.test(b.challenge || ""))
          throw new AppError(400, "연결 키가 올바르지 않아요.");
        const deviceId = random();
        devices.set(deviceId, {
          challenge: b.challenge,
          expires: clock() + 300000,
        });
        return json(res, 200, { deviceId, expiresIn: 300 });
      }
      if (route === "POST /api/device/poll") {
        rate(req, "poll", 100);
        const b = await body(req),
          d = devices.get(b.deviceId);
        if (!d || d.expires < clock())
          throw new AppError(
            410,
            "로그인 시간이 만료됐어요. 다시 시도해 주세요.",
          );
        if (typeof b.verifier !== "string" || hash(b.verifier) !== d.challenge)
          throw new AppError(403, "앱 연결을 확인할 수 없어요.");
        if (!d.userId) return json(res, 200, { pending: true });
        devices.delete(b.deviceId);
        return json(res, 200, {
          token: issue(d.userId, d.remember),
          remember: d.remember,
        });
      }
      if (route === "POST /api/auth/register") {
        rate(req);
        const b = await body(req),
          username = clean(b.username, 64).toLowerCase(),
          name = clean(b.name, 20);
        if (
          !/^[a-z0-9._@-]{3,64}$/.test(username) ||
          !name ||
          typeof b.password !== "string" ||
          b.password.length < 10 ||
          b.password.length > 128
        )
          throw new AppError(
            400,
            "아이디는 영문·숫자 3자 이상, 비밀번호는 10~128자로 입력해 주세요.",
          );
        if (db.users.some((u) => u.username === username))
          throw new AppError(409, "이미 사용 중인 아이디예요.");
        const first = db.users.length === 0;
        const workspace = first
          ? null
          : db.workspaces.find(
              (w) => w.invite === clean(b.invite, 32).toUpperCase(),
            );
        if (
          (!first && !workspace) ||
          (first && initialInvite && b.invite !== initialInvite)
        )
          throw new AppError(403, "관리자에게 받은 초대 코드가 필요해요.");
        const salt = random(),
          passwordHash = (await scrypt(b.password, salt, 64)).toString("hex");
        // Recheck after async password derivation, including simultaneous first-account requests.
        if (
          db.users.some((u) => u.username === username) ||
          (first && db.users.length)
        )
          throw new AppError(409, "계정 상태가 변경됐어요. 새로고침해 주세요.");
        const user = {
          id: id(),
          username,
          name,
          salt,
          passwordHash,
          petName: "모찌",
          character: "mochi",
          role: "",
          bio: "오늘도 반가워요!",
          workspaceIds: [],
        };
        db.users.push(user);
        if (first) {
          const w = {
            id: id(),
            name: "우리의 오피스",
            ownerId: user.id,
            invite: crypto.randomBytes(6).toString("hex").toUpperCase(),
          };
          db.workspaces.push(w);
          db.rooms.push({ id: id(), workspaceId: w.id, name: "라운지" });
          user.workspaceIds.push(w.id);
        } else user.workspaceIds.push(workspace.id);
        const token = issue(user.id, b.remember);
        setCookie(req, res, token, b.remember);
        consumeDevice(b.deviceId, user.id, b.remember);
        return json(res, 201, { user: publicUser(user) });
      }
      if (route === "POST /api/auth/login") {
        rate(req);
        const b = await body(req),
          user = db.users.find(
            (u) => u.username === clean(b.username, 64).toLowerCase(),
          );
        const actual = await scrypt(
          typeof b.password === "string" ? b.password.slice(0, 128) : "",
          user?.salt || "dummy-salt",
          64,
        );
        if (
          !user?.passwordHash ||
          !crypto.timingSafeEqual(actual, Buffer.from(user.passwordHash, "hex"))
        )
          throw new AppError(401, "아이디 또는 비밀번호를 확인해 주세요.");
        const token = issue(user.id, b.remember);
        setCookie(req, res, token, b.remember);
        consumeDevice(b.deviceId, user.id, b.remember);
        return json(res, 200, { user: publicUser(user) });
      }
      if (route === "GET /auth/google") {
        if (!google.clientId || !google.clientSecret || !google.publicUrl)
          throw new AppError(
            503,
            "관리자가 Google 로그인을 아직 설정하지 않았어요. 아이디로 로그인해 주세요.",
          );
        const state = random();
        oauth.set(state, {
          expires: clock() + 300000,
          deviceId: url.searchParams.get("device") || "",
          invite: url.searchParams.get("invite") || "",
        });
        res.setHeader(
          "Set-Cookie",
          `oauth_state=${state}; HttpOnly; SameSite=Lax; Path=/; Max-Age=300${google.publicUrl.startsWith("https:") ? "; Secure" : ""}`,
        );
        const target = new URL("https://accounts.google.com/o/oauth2/v2/auth");
        target.search = new URLSearchParams({
          client_id: google.clientId,
          redirect_uri: google.publicUrl + "/auth/google/callback",
          response_type: "code",
          scope: "openid email profile",
          state,
          prompt: "select_account",
        });
        res.writeHead(302, { Location: target.href });
        return res.end();
      }
      if (route === "GET /auth/google/callback") {
        const state = url.searchParams.get("state"),
          flow = oauth.get(state);
        oauth.delete(state);
        if (
          !flow ||
          flow.expires < clock() ||
          cookies(req).oauth_state !== state ||
          !url.searchParams.get("code")
        )
          throw new AppError(403, "로그인 요청이 만료되었어요.");
        const response = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          body: new URLSearchParams({
            client_id: google.clientId,
            client_secret: google.clientSecret,
            redirect_uri: google.publicUrl + "/auth/google/callback",
            code: url.searchParams.get("code"),
            grant_type: "authorization_code",
          }),
          signal: AbortSignal.timeout(15000),
        });
        const tokens = await response.json();
        if (!response.ok || !tokens.access_token)
          throw new AppError(401, "Google 로그인을 완료하지 못했어요.");
        const infoResponse = await fetch(
          "https://openidconnect.googleapis.com/v1/userinfo",
          {
            headers: { Authorization: "Bearer " + tokens.access_token },
            signal: AbortSignal.timeout(15000),
          },
        );
        const info = await infoResponse.json();
        if (
          !infoResponse.ok ||
          !info.email_verified ||
          !info.sub ||
          (google.domain && !info.email?.endsWith("@" + google.domain))
        )
          throw new AppError(403, "허용된 Google 계정이 아니에요.");
        let user = db.users.find((u) => u.googleSub === info.sub);
        if (!user) {
          const w = db.workspaces.find(
            (w) => w.invite === clean(flow.invite, 32).toUpperCase(),
          );
          if (!w) throw new AppError(403, "가입하려면 초대 코드가 필요해요.");
          user = {
            id: id(),
            googleSub: info.sub,
            name: clean(info.name, 20) || "새 친구",
            workspaceIds: [w.id],
            petName: "모찌",
            character: "mochi",
            role: "",
            bio: "",
          };
          db.users.push(user);
        }
        const token = issue(user.id, true);
        setCookie(req, res, token, true);
        consumeDevice(flow.deviceId, user.id, true);
        res.writeHead(302, {
          Location:
            "/login?complete=1" +
            (flow.deviceId
              ? "&device=" + encodeURIComponent(flow.deviceId)
              : ""),
        });
        return res.end();
      }
      if (url.pathname.startsWith("/api/")) {
        const { user, token } = auth(req);
        if (route === "GET /api/me")
          return json(res, 200, { user: publicUser(user) });
        if (route === "POST /api/auth/link") {
          const b = await body(req);
          consumeDevice(b.deviceId, user.id, b.remember);
          return json(res, 200, { ok: true });
        }
        if (route === "POST /api/auth/logout") {
          db.sessions = db.sessions.filter((s) => s.hash !== hash(token));
          activity.delete(hash(token));
          save();
          res.setHeader(
            "Set-Cookie",
            "moongle=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0",
          );
          return json(res, 200, { ok: true });
        }
        if (route === "GET /api/sync") {
          const status = url.searchParams.get("status");
          if (!allowedStatuses.includes(status))
            throw new AppError(400, "상태 값이 올바르지 않아요.");
          activity.set(hash(token), { userId: user.id, status, time: clock() });
          const workspaces = db.workspaces
            .filter((w) => user.workspaceIds.includes(w.id))
            .map((w) => ({
              id: w.id,
              name: w.name,
              ownerId: w.ownerId,
              ...(w.ownerId === user.id ? { invite: w.invite } : {}),
            }));
          const rooms = db.rooms.filter((r) =>
            user.workspaceIds.includes(r.workspaceId),
          );
          const room = url.searchParams.get("room")
            ? getRoom(user, url.searchParams.get("room"))
            : rooms[0];
          const people = room
            ? db.users
                .filter((u) => u.workspaceIds.includes(room.workspaceId))
                .map(publicUser)
            : [];
          const inbox = db.messages
            .filter(
              (m) =>
                m.userId !== user.id &&
                rooms.some((r) => r.id === m.roomId) &&
                m.seq > (db.reads[user.id + ":" + m.roomId] || 0),
            )
            .slice(-300);
          return json(res, 200, {
            user: publicUser(user),
            workspaces,
            rooms,
            people,
            messages: db.messages
              .filter((m) => m.roomId === room?.id)
              .slice(-300),
            inbox,
            roomId: room?.id,
          });
        }
        if (route === "POST /api/profile") {
          const b = await body(req);
          if (!clean(b.name, 20) || !clean(b.petName, 20))
            throw new AppError(400, "이름을 입력해 주세요.");
          if (!["mochi", "bunny", "bean", "custom"].includes(b.character))
            throw new AppError(400, "캐릭터를 확인해 주세요.");
          if (
            b.image &&
            (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(
              b.image,
            ) ||
              b.image.length > 400000)
          )
            throw new AppError(400, "이미지 형식을 확인해 주세요.");
          Object.assign(user, {
            name: clean(b.name, 20),
            petName: clean(b.petName, 20),
            role: clean(b.role, 40),
            bio: clean(b.bio, 120),
            character: b.character,
            image: b.image || "",
          });
          save();
          return json(res, 200, { user: publicUser(user) });
        }
        if (route === "POST /api/rooms") {
          const b = await body(req);
          member(user, b.workspaceId);
          if (!clean(b.name, 24))
            throw new AppError(400, "방 이름을 입력해 주세요.");
          if (
            db.rooms.filter((r) => r.workspaceId === b.workspaceId).length >= 30
          )
            throw new AppError(400, "공간당 방은 30개까지 만들 수 있어요.");
          const room = {
            id: id(),
            workspaceId: b.workspaceId,
            name: clean(b.name, 24),
          };
          db.rooms.push(room);
          save();
          return json(res, 201, { room });
        }
        if (route === "POST /api/workspaces/join") {
          const b = await body(req),
            w = db.workspaces.find(
              (w) => w.invite === clean(b.invite, 32).toUpperCase(),
            );
          if (!w) throw new AppError(403, "초대 코드를 확인해 주세요.");
          if (!user.workspaceIds.includes(w.id)) user.workspaceIds.push(w.id);
          save();
          return json(res, 200, { workspaceId: w.id });
        }
        if (route === "POST /api/workspaces/invite") {
          const b = await body(req),
            w = db.workspaces.find(
              (w) => w.id === b.workspaceId && w.ownerId === user.id,
            );
          if (!w)
            throw new AppError(403, "관리자만 초대 코드를 변경할 수 있어요.");
          w.invite = crypto.randomBytes(6).toString("hex").toUpperCase();
          save();
          return json(res, 200, { invite: w.invite });
        }
        if (route === "POST /api/messages") {
          rate(req, "message", 90);
          const b = await body(req),
            room = getRoom(user, b.roomId),
            text = clean(b.text, 300);
          if (!text) throw new AppError(400, "메시지를 입력해 주세요.");
          const type = b.type === "reaction" ? "reaction" : "text";
          if (type === "reaction" && !["👋", "👏", "❤️"].includes(text))
            throw new AppError(400, "리액션을 확인해 주세요.");
          const target =
            b.toUserId &&
            db.users.find(
              (u) =>
                u.id === b.toUserId &&
                u.workspaceIds.includes(room.workspaceId),
            );
          if (b.toUserId && !target)
            throw new AppError(400, "동료를 찾을 수 없어요.");
          const mentions = Array.isArray(b.mentions)
            ? b.mentions
                .filter((uid) =>
                  db.users.some(
                    (u) =>
                      u.id === uid && u.workspaceIds.includes(room.workspaceId),
                  ),
                )
                .slice(0, 50)
            : [];
          const message = {
            id: id(),
            seq: (db.sequence || 0) + 1,
            roomId: room.id,
            userId: user.id,
            name: user.name,
            text,
            type,
            toUserId: target?.id || "",
            mentions,
            createdAt: clock(),
          };
          db.sequence = message.seq;
          db.messages.push(message);
          if (db.messages.length > 10000)
            db.messages.splice(0, db.messages.length - 10000);
          save();
          return json(res, 201, { message });
        }
        if (route === "POST /api/read") {
          const b = await body(req);
          getRoom(user, b.roomId);
          const seq = Number(b.seq);
          if (!Number.isSafeInteger(seq) || seq < 0 || seq > (db.sequence || 0))
            throw new AppError(400, "읽음 위치가 올바르지 않아요.");
          db.reads[user.id + ":" + b.roomId] = Math.max(
            db.reads[user.id + ":" + b.roomId] || 0,
            seq,
          );
          save();
          return json(res, 200, { ok: true });
        }
        if (route === "POST /api/presence") {
          const b = await body(req);
          if (!allowedStatuses.includes(b.status))
            throw new AppError(400, "상태를 확인해 주세요.");
          activity.set(hash(token), {
            userId: user.id,
            status: b.status,
            time: clock(),
          });
          return json(res, 200, { ok: true });
        }
        throw new AppError(404, "요청을 찾을 수 없어요.");
      }
      if (req.method !== "GET" && req.method !== "HEAD")
        throw new AppError(405, "지원하지 않는 요청이에요.");
      const files = {
        "/": "login.html",
        "/login": "login.html",
        "/login.html": "login.html",
        "/app": "index.html",
        "/index.html": "index.html",
        "/style.css": "style.css",
        "/app.js": "app.js",
        "/login.js": "login.js",
      };
      const file = files[url.pathname];
      if (!file) throw new AppError(404, "페이지를 찾을 수 없어요.");
      const full = path.join(__dirname, "..", file);
      res.setHeader(
        "Content-Type",
        {
          ".html": "text/html; charset=utf-8",
          ".css": "text/css; charset=utf-8",
          ".js": "text/javascript; charset=utf-8",
        }[path.extname(file)],
      );
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
      );
      if (req.method === "HEAD") return res.end();
      fs.createReadStream(full).pipe(res);
    } catch (error) {
      if (!res.headersSent)
        json(res, error.status || 500, {
          error: error.status
            ? error.message
            : "요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.",
        });
      else res.end();
    }
  }
  const maintenance = setInterval(() => {
    for (const [key, value] of devices)
      if (value.expires < clock()) devices.delete(key);
    for (const [key, value] of oauth)
      if (value.expires < clock()) oauth.delete(key);
    for (const [key, value] of attempts)
      if (clock() - value.time > 120000) attempts.delete(key);
    for (const [key, value] of activity)
      if (clock() - value.time > 60000) activity.delete(key);
  }, 60000);
  maintenance.unref();
  return {
    handle,
    async start(port = 3210, host = "127.0.0.1") {
      server = http.createServer(handle);
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, resolve);
      });
      return server.address();
    },
    async close() {
      clearInterval(maintenance);
      if (server) await new Promise((resolve) => server.close(resolve));
    },
  };
}
module.exports = { createService };

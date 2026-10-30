const crypto = require("node:crypto");
const digest = (s) => crypto.createHash("sha256").update(s).digest("hex");
const clean = (s, n) => (typeof s === "string" ? s.trim().slice(0, n) : "");
function signed(peer, body) {
  const encoded = JSON.stringify(body);
  return {
    body: encoded,
    signature: crypto
      .sign(null, Buffer.from(encoded), peer.state.identity.privateKey)
      .toString("base64"),
  };
}
function verify(record, groupId) {
  try {
    if (!record || typeof record.body !== "string" || record.body.length > 2500)
      return null;
    const body = JSON.parse(record.body);
    if (
      body.groupId !== groupId ||
      typeof body.publicKey !== "string" ||
      body.publicKey.length > 300 ||
      digest(body.publicKey).slice(0, 32) !== body.id ||
      !crypto.verify(
        null,
        Buffer.from(record.body),
        body.publicKey,
        Buffer.from(record.signature, "base64"),
      )
    )
      return null;
    return body;
  } catch {
    return null;
  }
}
function normalize(g) {
  g.maxMembers ||= Math.max(10, Object.keys(g.contacts).length + 1);
  g.memberCertificates ||= {};
  return g;
}
function ownCertificate(peer) {
  const g = normalize(peer.group());
  return signed(peer, {
    groupId: g.id,
    id: peer.id,
    publicKey: peer.state.identity.publicKey,
    revision: peer.state.profileRevision || 0,
    name: peer.profile.name,
    petName: peer.profile.petName,
    character: peer.profile.character,
    role: peer.profile.role,
    bio: peer.profile.bio,
  });
}
function metadata(peer, discovery = false) {
  const g = normalize(peer.group());
  return {
    groupName: g.name,
    capacity: g.capacity || null,
    ...(discovery
      ? {}
      : {
          members: [
            ownCertificate(peer),
            ...Object.values(g.memberCertificates),
          ].slice(0, 100),
        }),
  };
}
function adoptCapacity(peer, packet) {
  const g = normalize(peer.group()),
    policy = verify(packet.capacity, g.id);
  if (
    !policy ||
    !Number.isInteger(policy.maxMembers) ||
    policy.maxMembers < 2 ||
    policy.maxMembers > 100 ||
    !Number.isSafeInteger(policy.revision) ||
    policy.revision > peer.clock() + 60000
  )
    return;
  const old = verify(g.capacity, g.id);
  if (
    policy.id !== peer.id &&
    !g.contacts[policy.id] &&
    Object.keys(g.contacts).length
  )
    return;
  if (
    !old ||
    policy.revision > old.revision ||
    (policy.revision === old.revision && policy.id > old.id)
  ) {
    g.capacity = packet.capacity;
    g.maxMembers = policy.maxMembers;
    peer.save();
    peer.changed();
  }
}
function apply(peer, packet) {
  const g = normalize(peer.group());
  adoptCapacity(peer, packet);
  const count = Object.keys(g.contacts).length + 1;
  if (!g.contacts[packet.id] && count >= g.maxMembers) {
    const e = Error(
      `모임 정원이 ${g.maxMembers}명으로 가득 찼어요. 기존 참여자가 최대 인원을 늘린 뒤 다시 참여해 주세요.`,
    );
    e.code = "GROUP_FULL";
    e.limit = g.maxMembers;
    e.memberCount = count;
    throw e;
  }
  if (g.name === "우리 모임" && clean(packet.groupName, 40))
    g.name = clean(packet.groupName, 40);
  let changed = false;
  for (const record of Array.isArray(packet.members)
    ? packet.members.slice(0, 100)
    : []) {
    const member = verify(record, g.id);
    if (
      !member ||
      member.id === peer.id ||
      !Number.isSafeInteger(member.revision) ||
      member.revision < 0
    )
      continue;
    const previous = verify(g.memberCertificates[member.id], g.id);
    if (previous && previous.revision >= member.revision) continue;
    // Reserve the incoming participant's place before merging its known directory.
    const reserved = g.contacts[packet.id]
      ? 0
      : member.id === packet.id
        ? 0
        : 1;
    if (
      !g.contacts[member.id] &&
      Object.keys(g.contacts).length + 1 + reserved >= g.maxMembers
    )
      continue;
    g.memberCertificates[member.id] = record;
    g.contacts[member.id] = {
      ...g.contacts[member.id],
      id: member.id,
      publicKey: member.publicKey,
      name: clean(member.name, 20) || "동료",
      petName: clean(member.petName, 20) || "모찌",
      character: ["mochi", "bunny", "bean", "custom"].includes(member.character)
        ? member.character
        : "mochi",
      role: clean(member.role, 40),
      bio: clean(member.bio, 120),
    };
    changed = true;
  }
  if (changed) {
    peer.save();
    peer.changed();
  }
}
function setLimit(peer, value) {
  const g = peer.group();
  if (!g) throw Error("모임에 먼저 참여해 주세요.");
  normalize(g);
  const limit = Number(value),
    count = Object.keys(g.contacts).length + 1;
  if (!Number.isInteger(limit) || limit < 2 || limit > 30)
    throw Error("최대 인원은 2~30명으로 설정해 주세요.");
  if (limit < count)
    throw Error(
      `현재 등록된 ${count}명보다 작게 줄일 수 없어요. 퇴근한 동료도 인원에 포함돼요.`,
    );
  const previous = verify(g.capacity, g.id);
  g.capacity = signed(peer, {
    groupId: g.id,
    id: peer.id,
    publicKey: peer.state.identity.publicKey,
    maxMembers: limit,
    revision: Math.max(peer.clock(), (previous?.revision || 0) + 1),
  });
  g.maxMembers = limit;
  peer.save();
  peer.changed();
  peer.tick();
  return { maxMembers: limit, memberCount: count };
}
module.exports = { normalize, metadata, adoptCapacity, apply, setLimit };

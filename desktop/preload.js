const { contextBridge, ipcRenderer } = require("electron");
const on = (channel, fn) => {
  const callback = (_event, data) => fn(data);
  ipcRenderer.on(channel, callback);
  return () => ipcRenderer.removeListener(channel, callback);
};
contextBridge.exposeInMainWorld("moongle", {
  info: () => ipcRenderer.invoke("info"),
  api: (path, body) => ipcRenderer.invoke("api", path, body),
  login: () => ipcRenderer.invoke("login"),
  logout: () => ipcRenderer.invoke("logout"),
  joinLan: (options) => ipcRenderer.invoke("lan-join", options),
  connectPeer: (address) => ipcRenderer.invoke("lan-connect", address),
  petOptions: (options) => ipcRenderer.invoke("pet-options", options),
  petDrag: (data) => ipcRenderer.invoke("pet-drag", data),
  openPet: () => ipcRenderer.invoke("pet-open"),
  messenger: () => ipcRenderer.invoke("messenger"),
  messengerState: (roomId) => ipcRenderer.invoke("messenger-state", roomId),
  compose: () => ipcRenderer.invoke("compose"),
  onLanState: (fn) => on("lan-state", fn),
  onPetState: (fn) => on("pet-state", fn),
  mini: () => ipcRenderer.invoke("mini"),
  hideMini: () => ipcRenderer.invoke("hide-mini"),
  showMain: () => ipcRenderer.invoke("show-main"),
  snapshot: (data) => ipcRenderer.invoke("snapshot", data),
  sendChat: (text) => ipcRenderer.invoke("mini-chat", text),
  notify: (data) => ipcRenderer.invoke("notify", data),
  onAuthenticated: (fn) => on("authenticated", fn),
  onAuthError: (fn) => on("auth-error", fn),
  onPower: (fn) => on("power", fn),
  onSnapshot: (fn) => on("snapshot", fn),
  onCompose: (fn) => on("compose", fn),
  onMiniChat: (fn) => on("mini-chat", fn),
});

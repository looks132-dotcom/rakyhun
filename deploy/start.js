// A newly attached persistent volume can be root-owned. Prepare only the app
// data directory, then drop privileges before accepting network requests.
const fs = require("node:fs");
if (process.getuid?.() === 0) {
  const directory = process.env.MOONGLE_DATA_DIR || "/var/data/moongle";
  fs.mkdirSync(directory, { recursive: true });
  fs.chownSync(directory, 1000, 1000);
  process.setgid(1000);
  process.setuid(1000);
}
require("../server");

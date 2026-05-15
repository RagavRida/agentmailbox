#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const entry = path.join(__dirname, "..", "dist", "index.js");
const shebang = "#!/usr/bin/env node\n";

const src = fs.readFileSync(entry, "utf8");
if (!src.startsWith("#!")) {
  fs.writeFileSync(entry, shebang + src);
}
fs.chmodSync(entry, 0o755);

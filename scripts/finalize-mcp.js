#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const entry = path.join(__dirname, "..", "dist", "mcp", "index.js");
const shebang = "#!/usr/bin/env node\n";

if (fs.existsSync(entry)) {
  const src = fs.readFileSync(entry, "utf8");
  if (!src.startsWith("#!")) {
    fs.writeFileSync(entry, shebang + src);
  }
  fs.chmodSync(entry, 0o755);
}

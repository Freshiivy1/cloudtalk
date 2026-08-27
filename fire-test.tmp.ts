import fs from "fs";
for (const line of fs.readFileSync(".env", "utf8").split("\n")) {
  const i = line.indexOf("=");
  if (i > 0) {
    const k = line.slice(0, i).trim();
    if (k && !(k in process.env)) process.env[k] = line.slice(i + 1).trim();
  }
}
process.env.PUBLIC_BASE_URL = "https://226orhimcsy72.kimi.pro";

const vs = await import("./api/verification");
const s = await vs.initiate({ calleeNumber: "+61431243829" });
console.log("SESSION:", s.sessionId, "| state:", s.state, "| legA:", s.legACallSid);
process.exit(0);

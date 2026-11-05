const http = require("http"); const fs = require("fs"); const path = require("path");
const root = path.join(__dirname, "..", "demo");
http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || "/").split("?")[0]);
  const file = path.join(root, url === "/" ? "index.html" : url);
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end("not found"); return; }
    const ext = path.extname(file);
    res.writeHead(200, { "content-type": ext === ".js" ? "text/javascript" : ext === ".html" ? "text/html" : "text/plain" });
    res.end(data);
  });
}).listen(5199, "127.0.0.1", () => console.log("demo server on 5199"));
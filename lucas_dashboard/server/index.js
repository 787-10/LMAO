import { createServer } from "node:http";

const AGENTS = [
  { id: "arm-01", name: "ARM-01", status: "online", host: "arm-01.local" },
  { id: "nav-02", name: "NAV-02", status: "idle", host: "nav-02.local" },
  { id: "sort-03", name: "SORT-03", status: "offline", host: "sort-03.local" },
  {
    id: "agent-18",
    name: "AGENT-18",
    status: "online",
    host: "mars-the-18th.local",
    rosbridgeUrl: "ws://mars-the-18th.local:9090",
  },
];

function json(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(data));
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  if (req.method === "GET" && path === "/agents") {
    return json(res, 200, AGENTS);
  }

  const match = path.match(/^\/agents\/([^/]+)$/);
  if (req.method === "GET" && match) {
    const agent = AGENTS.find((a) => a.id === match[1]);
    if (!agent) return json(res, 404, { error: "agent not found" });
    return json(res, 200, agent);
  }

  json(res, 404, { error: "not found" });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`server listening on :${PORT}`);
});

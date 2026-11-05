/**
 * Local harness: renders the topology card alone with fixture data, so the
 * canvas can be inspected without deploying a plugin build to a live instance.
 * Not shipped — scripts/build-demo.mjs bundles it into demo/demo.js.
 */
import * as React from "react";
import { createRoot } from "react-dom/client";
import "./app.js";
import { MeshTopology } from "./topology.jsx";

function t(zh) {
  return zh;
}

var peers = [
  {
    nodeId: "tencent-1",
    label: "腾讯云",
    endpoint: "https://harness.chenxu233.cn",
    status: "online",
    source: "both",
    lastSeenAt: 1730000000000,
    workspaces: [
      { workspaceId: "workdesktop", name: "workdesktop", path: "/home/node/workdesktop", sessions: 4 },
      { workspaceId: "workspace", name: "workspace", path: "/data/workspace", sessions: 2 },
      { workspaceId: "tmp", name: "tmp", path: "/tmp", sessions: 1 }
    ],
    assignedWorkspaceIds: ["workdesktop", "workspace", "tmp"]
  },
  {
    nodeId: "aliyun-2",
    label: "阿里云",
    endpoint: "http://101.132.38.216:3211",
    status: "unknown",
    source: "assignment",
    workspaces: [],
    assignedWorkspaceIds: ["sandbox"]
  },
  {
    nodeId: "offline-3",
    label: "备机",
    endpoint: "http://10.0.0.9:3210",
    status: "offline",
    source: "transport",
    workspaces: [{ workspaceId: "attic", name: "attic", path: "/srv/attic", sessions: 0 }],
    assignedWorkspaceIds: []
  }
];

var tasks = [
  { taskId: "t-8f21", state: "running", nodeId: "tencent-1", workspaceId: "workdesktop", updatedAt: 3 },
  { taskId: "t-3c07", state: "dispatched", nodeId: "tencent-1", workspaceId: "workspace", updatedAt: 2 },
  { taskId: "t-91aa", state: "queued", nodeId: "tencent-1", workspaceId: "tmp", updatedAt: 1 },
  { taskId: "t-orphan", state: "running", nodeId: "ghost", workspaceId: "nowhere", updatedAt: 4 }
];

function Harness() {
  return (
    <div style={{ padding: 24, maxWidth: 820, margin: "0 auto" }}>
      <MeshTopology peers={peers} tasks={tasks} selfLabel="本机 · 客户端" t={t} />
    </div>
  );
}

createRoot(document.getElementById("root")).render(<Harness />);

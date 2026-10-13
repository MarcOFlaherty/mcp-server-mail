import { describe, it } from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(__dirname, "..", "dist", "index.js");
const packageJson = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
);

// Launches dist/index.js the way `npx` / MCP clients do: through a bin symlink,
// performs the MCP `initialize` handshake over stdio, then — when follow-up
// requests are given — sends the `initialized` notification plus those requests
// and resolves with the last JSON-RPC response (or null on timeout).
function connectViaSymlink(followUpRequests = [], timeoutMs = 8000, extraEnv = {}) {
    return new Promise((resolve) => {
        const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-bin-"));
        const link = path.join(linkDir, "mcp-server-mail");
        fs.symlinkSync(entry, link);

        const child = spawn(process.execPath, [link], {
            env: { ...process.env, MAIL_TOKEN: "test-token", ...extraEnv },
            stdio: ["pipe", "pipe", "pipe"],
        });

        let stdout = "";
        let initialized = false;
        let settled = false;
        const lastId = followUpRequests.length
            ? followUpRequests[followUpRequests.length - 1].id
            : 1;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            child.kill();
            try { fs.rmSync(linkDir, { recursive: true, force: true }); } catch {}
            resolve(value);
        };

        const timer = setTimeout(() => finish(null), timeoutMs);

        child.stdout.on("data", (chunk) => {
            stdout += chunk.toString();
            for (const line of stdout.split("\n")) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                try {
                    const msg = JSON.parse(trimmed);
                    if (msg.id === 1 && followUpRequests.length && !initialized) {
                        initialized = true;
                        child.stdin.write(JSON.stringify({
                            jsonrpc: "2.0",
                            method: "notifications/initialized",
                        }) + "\n");
                        for (const request of followUpRequests) {
                            child.stdin.write(JSON.stringify(request) + "\n");
                        }
                    }
                    if (msg.id === lastId) finish(msg);
                } catch {}
            }
        });

        // Exiting before answering means main() never connected the transport.
        child.on("exit", () => finish(null));

        const initialize = {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
                protocolVersion: "2024-11-05",
                capabilities: {},
                clientInfo: { name: "startup-test", version: "1.0.0" },
            },
        };
        child.stdin.write(JSON.stringify(initialize) + "\n");
    });
}

describe("server startup", () => {
    it("responds to an MCP initialize handshake when launched via bin symlink", async () => {
        const response = await connectViaSymlink();
        assert.ok(
            response,
            "server exited without answering initialize — main() did not connect the transport (bin-symlink entry-point bug)",
        );
        assert.strictEqual(response.id, 1);
        assert.ok(response.result, "initialize response should carry a result");
        assert.ok(
            response.result.serverInfo,
            "initialize result should include serverInfo",
        );
        assert.strictEqual(response.result.serverInfo.version, packageJson.version);
    });

    it("describes the inline image allowlist for mail_download_attachment", async () => {
        const response = await connectViaSymlink([
            { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
        ]);
        assert.ok(response?.result?.tools, "tools/list should return tools");
        const tool = response.result.tools.find((t) => t.name === "mail_download_attachment");
        assert.ok(tool, "mail_download_attachment should be listed");
        assert.match(
            tool.description,
            /png\/jpeg\/gif\/webp/,
            "description should name the image formats inlined as image content",
        );
    });

    it("exposes optional unseen and flagged booleans on mail_list_emails", async () => {
        const response = await connectViaSymlink([
            { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
        ]);
        const tool = response?.result?.tools?.find((t) => t.name === "mail_list_emails");
        assert.ok(tool, "mail_list_emails should be listed");
        const unseen = tool.inputSchema.properties.unseen;
        const flagged = tool.inputSchema.properties.flagged;
        assert.ok(unseen, "inputSchema should declare unseen");
        assert.strictEqual(unseen.type, "boolean", "unseen should be a boolean");
        assert.ok(unseen.default !== true, "unseen should default to false/undefined");
        assert.ok(flagged, "inputSchema should declare flagged");
        assert.strictEqual(flagged.type, "boolean", "flagged should be a boolean");
        assert.ok(flagged.default !== true, "flagged should default to false/undefined");
    });
});

describe("read-only mode", () => {
    const readOnlyTools = [
        "mail_download_attachment",
        "mail_list_drafts",
        "mail_list_emails",
        "mail_list_folders",
        "mail_list_mailboxes",
        "mail_read_email",
        "mail_search_emails",
    ];
    const listTools = (extraEnv) => connectViaSymlink(
        [{ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }],
        8000,
        extraEnv,
    );

    it("exposes write tools by default", async () => {
        const response = await listTools({});
        const names = response.result.tools.map((t) => t.name);
        assert.ok(names.includes("mail_send_email"));
        assert.ok(names.includes("mail_delete_email"));
        for (const name of readOnlyTools) {
            assert.ok(names.includes(name), `${name} should exist`);
        }
    });

    it("lists only read tools when MAIL_READ_ONLY=true", async () => {
        const response = await listTools({ MAIL_READ_ONLY: "true" });
        const names = response.result.tools.map((t) => t.name).sort();
        assert.deepStrictEqual(names, readOnlyTools);
    });

    it("rejects a write tool call when MAIL_READ_ONLY=true", async () => {
        const response = await connectViaSymlink(
            [{
                jsonrpc: "2.0",
                id: 2,
                method: "tools/call",
                params: {
                    name: "mail_send_email",
                    arguments: { to: ["someone@example.com"], subject: "x", body: "x" },
                },
            }],
            8000,
            { MAIL_READ_ONLY: "true" },
        );
        const failed = Boolean(response?.error) || response?.result?.isError === true;
        assert.ok(failed, "calling mail_send_email must fail in read-only mode");
    });

    it("ignores values other than 1, true or yes", async () => {
        const response = await listTools({ MAIL_READ_ONLY: "false" });
        const names = response.result.tools.map((t) => t.name);
        assert.ok(names.includes("mail_send_email"));
    });
});

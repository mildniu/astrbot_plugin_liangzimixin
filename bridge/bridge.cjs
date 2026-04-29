"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");

const vendorRoot = path.join(__dirname, "vendor", "liangzimixin");

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function writeStderr(args) {
  const text = args
    .map((item) => {
      if (typeof item === "string") {
        return item;
      }
      try {
        return JSON.stringify(item);
      } catch {
        return String(item);
      }
    })
    .join(" ");
  process.stderr.write(`${text}\n`);
}

console.log = (...args) => writeStderr(args);
console.info = (...args) => writeStderr(args);
console.warn = (...args) => writeStderr(args);
console.error = (...args) => writeStderr(args);
console.debug = (...args) => writeStderr(args);

const pluginRuntime = require(path.join(vendorRoot, "index.cjs"));

let instance = null;
let runtimeConfig = null;

function toErrorMessage(error) {
  if (error instanceof Error) {
    return `${error.message}\n${error.stack || ""}`.trim();
  }
  return String(error);
}

function sanitizeName(name) {
  return String(name || "attachment").replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
}

function guessExtension(contentType) {
  if (!contentType) return "";
  if (contentType.startsWith("image/")) return `.${contentType.split("/")[1] || "bin"}`;
  if (contentType.startsWith("audio/")) return `.${contentType.split("/")[1] || "bin"}`;
  if (contentType.startsWith("video/")) return `.${contentType.split("/")[1] || "bin"}`;
  return ".bin";
}

function buildTrustedHostMatchers(urls = []) {
  const exactHosts = new Set();
  const suffixHosts = new Set();

  for (const rawUrl of urls) {
    if (!rawUrl) {
      continue;
    }
    try {
      const hostname = new URL(rawUrl).hostname.toLowerCase();
      if (!hostname) {
        continue;
      }
      exactHosts.add(hostname);
      const parts = hostname.split(".").filter(Boolean);
      if (parts.length >= 2) {
        suffixHosts.add(parts.slice(-2).join("."));
      }
    } catch {
      continue;
    }
  }

  return {
    exactHosts: [...exactHosts],
    suffixHosts: [...suffixHosts],
  };
}

function isTrustedDownloadUrl(url, trustedHosts) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    if (!hostname) {
      return false;
    }
    if (trustedHosts.exactHosts.includes(hostname)) {
      return true;
    }
    return trustedHosts.suffixHosts.some(
      (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
    );
  } catch {
    return false;
  }
}

function createSdkRuntime(deps = {}) {
  const {
    tokenManager = null,
    trustedHosts = { exactHosts: [], suffixHosts: [] },
  } = deps;

  return {
    channel: {
      media: {
        async fetchRemoteMedia({ url, headers = {} }) {
          const trusted = isTrustedDownloadUrl(url, trustedHosts);
          const hasAuthHeader = Object.keys(headers).some(
            (key) => key.toLowerCase() === "authorization",
          );
          let accessToken = "";

          if (trusted && !hasAuthHeader && tokenManager) {
            try {
              accessToken = await tokenManager.getValidToken();
            } catch (error) {
              console.warn("fetchRemoteMedia token acquire failed", {
                url,
                error: toErrorMessage(error),
              });
            }
          }

          const candidates = [];
          const seen = new Set();
          const pushCandidate = (candidateHeaders) => {
            const serialized = JSON.stringify(candidateHeaders);
            if (seen.has(serialized)) {
              return;
            }
            seen.add(serialized);
            candidates.push(candidateHeaders);
          };

          if (trusted && accessToken && !hasAuthHeader) {
            pushCandidate({ ...headers, Authorization: `Bearer ${accessToken}` });
            pushCandidate({ ...headers, Authorization: accessToken });
          }
          pushCandidate(headers);

          let lastStatus = 0;
          let lastBody = "";
          for (const candidateHeaders of candidates) {
            const response = await fetch(url, {
              headers: candidateHeaders,
              redirect: "follow",
            });
            if (response.ok) {
              const buffer = Buffer.from(await response.arrayBuffer());
              return {
                buffer,
                contentType: response.headers.get("content-type") || "",
              };
            }

            lastStatus = response.status;
            try {
              lastBody = (await response.text()).slice(0, 200);
            } catch {
              lastBody = "";
            }

            if (![401, 403].includes(response.status)) {
              break;
            }
          }

          const details = lastBody ? ` ${lastBody}` : "";
          throw new Error(`fetchRemoteMedia failed: HTTP ${lastStatus}${details}`);
        },
        async saveMediaBuffer(buffer, contentType, scope, maxBytes, fileName) {
          if (buffer.length > maxBytes) {
            throw new Error(`media too large: ${buffer.length} > ${maxBytes}`);
          }
          const baseDir = path.join(os.tmpdir(), "astrbot_liangzimixin", scope || "inbound");
          await fs.promises.mkdir(baseDir, { recursive: true });
          const safeName = sanitizeName(fileName || `media${guessExtension(contentType)}`);
          const target = path.join(baseDir, `${Date.now()}_${Math.random().toString(16).slice(2)}_${safeName}`);
          await fs.promises.writeFile(target, buffer);
          return {
            path: target,
            contentType: contentType || "",
          };
        },
      },
    },
  };
}

function compactInternalOverrides(raw) {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const next = {};
  for (const [section, sectionValue] of Object.entries(raw)) {
    if (!sectionValue || typeof sectionValue !== "object") {
      continue;
    }
    const kept = {};
    for (const [key, value] of Object.entries(sectionValue)) {
      if (value !== "" && value !== null && value !== undefined) {
        kept[key] = value;
      }
    }
    if (Object.keys(kept).length > 0) {
      next[section] = kept;
    }
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function expandInternalOverrides(baseConfig, overrides) {
  if (!overrides) {
    return undefined;
  }
  const merged = {};
  for (const [section, sectionValue] of Object.entries(overrides)) {
    if (!sectionValue || typeof sectionValue !== "object") {
      merged[section] = sectionValue;
      continue;
    }
    const baseSection =
      baseConfig && typeof baseConfig[section] === "object" && baseConfig[section] !== null
        ? baseConfig[section]
        : {};
    merged[section] = {
      ...baseSection,
      ...sectionValue,
    };
  }
  return merged;
}

async function stopInstance() {
  if (!instance) {
    runtimeConfig = null;
    return;
  }
  try {
    await instance.shutdown();
  } finally {
    instance = null;
    runtimeConfig = null;
  }
}

async function startRuntime(payload) {
  await stopInstance();

  const accountConfig = {
    appId: payload.app_id,
    appSecret: payload.app_secret,
    quantumAccount: payload.quantum_account || undefined,
    botUserId: payload.bot_user_id || undefined,
    env: payload.env || "production",
    encryptionMode: payload.encryption_mode || "quantum_and_plain",
  };
  const compactedOverrides = compactInternalOverrides(payload.internal_overrides);
  const baseConfig = pluginRuntime.buildPluginConfig(accountConfig);
  const internalOverrides = expandInternalOverrides(baseConfig, compactedOverrides);
  instance = await pluginRuntime.startPlugin(accountConfig, internalOverrides);
  runtimeConfig = instance.config;
  const sdkRuntime = createSdkRuntime({
    tokenManager: instance.tokenManager,
    trustedHosts: buildTrustedHostMatchers([
      runtimeConfig.transport?.wsUrl,
      runtimeConfig.auth?.serverUrl,
      runtimeConfig.message?.messageServiceBaseUrl,
      runtimeConfig.file?.fileServiceBaseUrl,
    ]),
  });

  instance.messagePipe.onMessage((message) => {
    void handleInbound(message, sdkRuntime);
  });

  await instance.connectionManager.start(
    runtimeConfig.transport.wsUrl,
    () => instance.tokenManager.getValidToken(),
    runtimeConfig.credentials.appId,
  );

  return {
    ws_url: runtimeConfig.transport.wsUrl,
    env: runtimeConfig.env,
    encryption_mode: runtimeConfig.credentials.encryptionMode,
  };
}

async function handleInbound(message, sdkRuntime) {
  const parsed = pluginRuntime.parseMessage(message);
  let media = null;
  if (parsed.fileId) {
    try {
      media = await pluginRuntime.resolveMedia({
        fileId: parsed.fileId,
        tokenManager: instance.tokenManager,
        serverUrl: runtimeConfig.file.fileServiceBaseUrl,
        sdkRuntime,
        maxBytes: runtimeConfig.file.maxFileSizeMb * 1024 * 1024,
        allowPrivateNetwork: runtimeConfig.file.allowPrivateNetwork,
        timeoutMs: runtimeConfig.file.fetchTimeoutMs,
        messagePipe: instance.messagePipe,
        fileEncryptionMeta: message.fileEncryptionMeta,
      });
    } catch (error) {
      console.error("resolve inbound media failed:", toErrorMessage(error));
    }
  }

  send({
    type: "inbound",
    payload: {
      message_id: parsed.messageId,
      chat_id: parsed.chatId,
      sender_id: parsed.senderId,
      sender_name: parsed.senderName || parsed.senderId,
      group_id: message.groupId || "",
      msg_type: parsed.msgType,
      text: parsed.text || "",
      timestamp: parsed.timestamp || Date.now(),
      reply_to_message_id: parsed.replyToMessageId || "",
      is_encrypted: Boolean(message.isEncrypted),
      media: media
        ? {
            local_path: media.localPath,
            file_name: media.fileName,
            mime_type: media.mimeType,
            resource_type: media.resourceType,
            file_size: media.fileSize,
            file_id: media.fileId,
          }
        : null,
    },
  });
}

async function sendText(payload) {
  if (!instance) {
    throw new Error("runtime not started");
  }
  await instance.messagePipe.sendMessage({
    chatId: payload.chat_id,
    senderId: payload.chat_id,
    msgType: "text",
    content: JSON.stringify({ content: payload.text || "" }),
    replyToMessageId: payload.reply_to_message_id || undefined,
    skipEncrypt: Boolean(payload.skip_encrypt),
  });
  return { sent: true };
}

async function sendMedia(payload) {
  if (!instance || !runtimeConfig) {
    throw new Error("runtime not started");
  }
  const sdkRuntime = createSdkRuntime({
    tokenManager: instance.tokenManager,
    trustedHosts: buildTrustedHostMatchers([
      runtimeConfig.transport?.wsUrl,
      runtimeConfig.auth?.serverUrl,
      runtimeConfig.message?.messageServiceBaseUrl,
      runtimeConfig.file?.fileServiceBaseUrl,
    ]),
  });
  const localPath = payload.local_path;
  const fileName = payload.file_name || path.basename(localPath);
  const allowedLocalRoots = [
    path.dirname(localPath),
    ...(runtimeConfig.file.allowedLocalRoots || []),
  ];
  return await pluginRuntime.resolveAndUploadMedia({
    mediaUrl: localPath,
    fileName,
    tokenManager: instance.tokenManager,
    serverUrl: runtimeConfig.file.fileServiceBaseUrl,
    allowedLocalRoots,
    allowPrivateNetwork: runtimeConfig.file.allowPrivateNetwork,
    sdkRuntime,
    messagePipe: instance.messagePipe,
    chatId: payload.chat_id,
    maxFileSizeMb: runtimeConfig.file.maxFileSizeMb,
    chunkSizeMb: runtimeConfig.file.chunkSizeMb,
    timeoutMs: runtimeConfig.file.fetchTimeoutMs,
    skipEncrypt: Boolean(payload.skip_encrypt),
  });
}

async function handleRequest(request) {
  switch (request.action) {
    case "start":
      return await startRuntime(request.payload.config || {});
    case "send_text":
      return await sendText(request.payload || {});
    case "send_media":
      return await sendMedia(request.payload || {});
    case "shutdown":
      await stopInstance();
      return { stopped: true };
    default:
      throw new Error(`unknown action: ${request.action}`);
  }
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on("line", (line) => {
  if (!line.trim()) {
    return;
  }
  let request;
  try {
    request = JSON.parse(line);
  } catch (error) {
    send({ ok: false, error: `invalid json: ${toErrorMessage(error)}` });
    return;
  }
  void Promise.resolve(handleRequest(request))
    .then((result) => {
      send({ id: request.id, ok: true, result });
    })
    .catch((error) => {
      send({ id: request.id, ok: false, error: toErrorMessage(error) });
    });
});

process.on("SIGTERM", () => {
  void stopInstance().finally(() => process.exit(0));
});

process.on("SIGINT", () => {
  void stopInstance().finally(() => process.exit(0));
});

import { z } from 'zod';
import { ChannelPlugin } from 'openclaw/plugin-sdk';
import { EventEmitter } from 'node:events';

/**
 * openclaw-liangzimixin — 配置定义
 *
 * 分为两层:
 * 1. AccountConfigSchema — 用户在 openclaw.json 中配置的凭据（平铺在 accounts.default 下）
 * 2. InternalConfig — 运维硬编码的技术参数（transport / auth / crypto / message / file / push）
 * 3. PluginConfig — 合并后的完整运行时配置
 */

/**
 * 用户在 openclaw.json 中配置的账户凭据（驼峰命名）。
 */
declare const AccountConfigSchema: z.ZodPipe<z.ZodObject<{
    appId: z.ZodString;
    appSecret: z.ZodString;
    quantumAccount: z.ZodOptional<z.ZodString>;
    botUserId: z.ZodOptional<z.ZodString>;
    env: z.ZodOptional<z.ZodEnum<{
        test: "test";
        staging: "staging";
        production: "production";
    }>>;
    encryptionMode: z.ZodDefault<z.ZodEnum<{
        quantum_only: "quantum_only";
        quantum_and_plain: "quantum_and_plain";
    }>>;
}, z.core.$strip>, z.ZodTransform<{
    appId: string;
    appSecret: string;
    quantumAccount: string | undefined;
    botUserId: string | undefined;
    env: "test" | "staging" | "production" | undefined;
    encryptionMode: "quantum_only" | "quantum_and_plain";
}, {
    appId: string;
    appSecret: string;
    encryptionMode: "quantum_only" | "quantum_and_plain";
    quantumAccount?: string | undefined;
    botUserId?: string | undefined;
    env?: "test" | "staging" | "production" | undefined;
}>>;
type AccountConfig = z.output<typeof AccountConfigSchema>;
/** 支持的部署环境 */
type DeployEnv = 'test' | 'staging' | 'production';
/** 运维级内部配置 — 由运维提供，直接在代码或环境变量中设定 */
interface InternalConfig {
    /** 🟡 插件唯一标识 */
    pluginId: string;
    /** 🟡 当前部署环境 */
    env: DeployEnv;
    /** 🟡 日志级别 */
    logLevel: 'debug' | 'info' | 'warn' | 'error';
    transport: {
        /** 🔴 IM 服务器 WebSocket 地址 */
        wsUrl: string;
        /** 🟡 心跳发送间隔 (ms) */
        heartbeatIntervalMs: number;
        /** 🟡 心跳超时 (ms) */
        heartbeatTimeoutMs: number;
        /** 🟡 重连初始退避 (ms) */
        reconnectBaseMs: number;
        /** 🟡 重连最大退避 (ms) */
        reconnectMaxMs: number;
        /** 🟡 最大重连尝试次数 (Phase 1 + Phase 2) */
        maxReconnectAttempts: number;
        /** 🟡 尾部退避延迟序列 (ms)，从 maxReconnectAttempts 末尾倒数 */
        tailBackoffDelays: number[];
        /** 🟡 持续重试间隔 (ms)，超过 maxReconnectAttempts 后使用 */
        persistentRetryIntervalMs: number;
        /** 🟡 消息去重配置 */
        dedup?: {
            ttlMs: number;
            maxEntries: number;
        };
        /** 🟡 入站消息最大并发处理数 (Semaphore slot 数) */
        maxInboundConcurrency: number;
        /** 🟡 入站消息等待队列上限 (超出后丢弃) */
        maxWaitingQueue: number;
    };
    auth: {
        /** 🔴 API 基础地址 (如 https://imtwo.zdxlz.com/open-apis/v1) */
        serverUrl: string;
        /** 🟡 Token 提前刷新时间 (ms) */
        refreshAheadMs: number;
    };
    crypto: {
        /** 🟡 是否启用量子加密 */
        enabled: boolean;
        /** 🟡 密钥来源 */
        keySource: 'env' | 'file';
        /** 🟡 密钥环境变量名 */
        envKey: string;
        /** 🟡 密钥文件路径 */
        keyFilePath?: string;
        /** 🟡 加密/解密操作超时 (ms) — Promise.race 保护 */
        operationTimeoutMs: number;
    };
    message: {
        /** 🔴 消息发送/撤回 API 基础地址 */
        messageServiceBaseUrl: string;
        /** 🟡 出站 API 速率限制 — 每秒允许的请求数 */
        rateLimitPerSecond: number;
        /** 🟡 出站 API 速率限制 — 突发容量 (token 上限) */
        rateLimitBurst: number;
    };
    file: {
        /** 🔴 文件服务 API 基础地址 */
        fileServiceBaseUrl: string;
        /** 🟡 单文件大小上限 (MB) */
        maxFileSizeMb: number;
        /** 🟡 分片大小 (MB) */
        chunkSizeMb: number;
        /** 🟡 本地目录白名单 */
        allowedLocalRoots: string[];
        /** 🟡 下载超时 (ms) */
        fetchTimeoutMs: number;
        /** 🟡 是否允许下载内网地址 */
        allowPrivateNetwork: boolean;
        /** 🟡 文件上传最大并发数 (Semaphore) */
        maxUploadConcurrency: number;
    };
    push?: {
        enabled: boolean;
        endpoint: string;
        apiKey: string;
        queueMaxSize: number;
        retryAttempts: number;
        healthCheckIntervalMs: number;
    };
    metrics: {
        /** 🟡 是否启用指标采集 */
        enabled: boolean;
        /** 🟡 定期日志输出间隔 (ms) */
        logIntervalMs: number;
    };
}
/** 完整的插件运行时配置 = 用户凭据 + 内部技术参数 */
interface PluginConfig extends InternalConfig {
    /** 用户凭据（从 openclaw.json 解析并转换后的结果） */
    credentials: AccountConfig;
}
/**
 * 合并用户配置与内部配置，生成完整的运行时配置。
 *
 * 如果用户在 openclaw.json 中指定了 env 字段，会自动切换到对应环境的 URL 预设。
 *
 * @param accountConfig - 已解析的用户账户配置
 * @param internalOverrides - 可选的内部配置覆盖（用于测试或特殊部署）
 */
declare function buildPluginConfig(accountConfig: AccountConfig, internalOverrides?: Partial<InternalConfig>): PluginConfig;

/**
 * openclaw-liangzimixin — ChannelPlugin 接口实现
 *
 * 插件与 OpenClaw SDK 的核心契约。
 * gateway.startAccount 是整个插件的启动入口。
 */

declare const quantumImPlugin: ChannelPlugin;

/** 入站消息 — 从 IM 服务器接收到的消息，经解密后的结构 */
interface InboundMessage {
    /** 消息唯一标识 (用于去重、回复引用) */
    messageId: string;
    /** 会话 ID (私聊对话标识) */
    chatId: string;
    /** 发送者用户 ID (用于 gate.ts anti-loop 检查) */
    senderId: string;
    /** 发送者显示名称 (用于日志和 SDK 信封) */
    senderName?: string;
    /** 消息类型 — 决定 content JSON 结构、加密策略和处理流程 */
    msgType: 'text' | 'markdown' | 'image' | 'file' | 'voice' | 'video' | 'system';
    /**
     * 消息内容 (JSON 字符串，解密后)
     *
     * 根据 msgType 解析为对应的 Content 类型:
     * - text:     `{"content": "你好"}`
     * - markdown: `{"title": "标题", "content": "正文", "recommendations": [...]}`
     * - image:    `{"fileId": "xxx", "width": 1920, "height": 1200}`
     * - file:     `{"fileId": "xxx", "fileName": "test.xlsx", "size": 9763}`
     * - voice:    `{"fileId": "xxx", "duration": 2914.23}`
     * - video:    `{"fileId": "xxx", "duration": 5291667.32, "width": 1200}`
     * - system:   `{"text": "用户已加入会话"}`
     */
    content: string;
    /** 原始内容 (解密前，用于调试和审计) */
    rawContent?: string;
    /** 消息时间戳 (Unix ms，用于过期检测) */
    timestamp: number;
    /** 回复的原消息 ID (如果是回复消息) */
    replyToMessageId?: string;
    /** 入站消息是否经过加密 — 用于决定回复是否也需要加密 */
    isEncrypted?: boolean;
    /** 文件加密元数据 — 入站文件消息解密所需的 keyId/iv (来自 extraContent.sessionId + cryptoIv) */
    fileEncryptionMeta?: {
        keyId: string;
        iv: string;
    };
}
/** 出站消息 — 插件向 IM 服务器发送的消息 */
interface OutboundMessage {
    /** 目标会话 ID */
    chatId: string;
    /** 接收者用户 ID (映射到 API 的 receive_id，值为入站消息的原始 senderId) */
    senderId: string;
    /** 消息类型 */
    msgType: 'text' | 'markdown' | 'image' | 'file' | 'voice' | 'video' | 'card';
    /**
     * 消息内容 (JSON 字符串，发送前会被 CryptoEngine 加密)
     *
     * 格式同 InboundMessage.content，根据 msgType 对应不同结构。
     */
    content: string;
    /** 回复的原消息 ID */
    replyToMessageId?: string;
    /** 跳过出站加密 — 用于"思考中"等无需加密的系统提示消息 */
    skipEncrypt?: boolean;
    /** 文件加密元数据 — 文件已在上传前加密时传入，sendMessage 直接使用此 keyId/iv 构建 extraContent */
    encryptionMeta?: {
        keyId: string;
        iv: string;
    };
}
/**
 * 加密策略枚举 — 根据消息类型选择不同的加密等级
 * - FULL: 全量加密 (文本消息)
 * - METADATA: 仅加密元数据 (媒体消息，文件本体单独加密)
 * - NONE: 不加密 (系统消息)
 */
declare enum EncryptionStrategy {
    FULL = "full",
    METADATA = "metadata",
    NONE = "none"
}
/** OAuth 令牌数据 — POST /auth/token 响应 */
interface TokenData {
    accessToken: string;
    tokenType: 'Bearer';
    /** 有效期 (秒) */
    expiresIn: number;
    /** 实际授权的 scope (空格分隔) */
    scope: string;
    refreshToken?: string;
    /** 过期时间戳 (Unix ms，用于判断是否需要刷新) */
    expiresAt: number;
    /** 签发时间戳 (Unix ms) */
    grantedAt: number;
}

/**
 * openclaw-liangzimixin — OAuth HTTP 客户端
 *
 * 封装 IM 开放平台授权通信: POST /auth/token (client_credentials)
 * 基于《第三方应用机器人对接 API 文档》
 *
 * 安全要求:
 *   - client_secret / access_token 不得出现在日志中 (仅前 8 位 + ***)
 *   - HTTP 请求使用超时控制 (默认 30s)
 */

/**
 * OAuth 客户端配置 — 构造 OAuthClient 时传入
 */
interface OAuthClientConfig {
    /** API 基础地址 (如 https://imtwo.zdxlz.com/open-apis/v1) */
    baseUrl: string;
    /** 应用 ID — 用作 OAuth client_id */
    appId: string;
    /** 应用密钥 — 用作 OAuth client_secret */
    appSecret: string;
}
/**
 * OAuth HTTP 客户端 — 封装与 IM 开放平台的认证通信。
 *
 * 对接《第三方应用机器人对接 API 文档》中的授权接口:
 *   POST {{baseUrl}}/auth/token
 *   Content-Type: application/x-www-form-urlencoded
 *   grant_type=client_credentials & client_id={appId} & client_secret={appSecret} & scope=...
 */
declare class OAuthClient {
    private readonly baseUrl;
    private readonly appId;
    private readonly appSecret;
    constructor(config: OAuthClientConfig);
    /**
     * 统一 HTTP 请求封装 — 含超时、日志脱敏和错误处理
     */
    private request;
    /**
     * 获取访问令牌 → POST /auth/token (client_credentials)
     *
     * 请求参数 (x-www-form-urlencoded):
     *   - grant_type: client_credentials (写死)
     *   - client_id: appId
     *   - client_secret: appSecret
     *   - scope: client_credentials refresh_token (写死)
     *
     * @returns TokenData 包含 access_token、过期时间等
     * @throws ApiError — HTTP 错误
     */
    getToken(): Promise<TokenData>;
    /** 获取 baseUrl (供其他模块复用) */
    getBaseUrl(): string;
}

/**
 * openclaw-liangzimixin — 量子加密 SDK 适配器
 *
 * 封装第三方量子加密 SDK (CJS + WASM) 的全部接口，
 * 提供统一的 TypeScript 接口供 CryptoEngine 调用。
 *
 * SDK 加载方式：运行时通过 require() 加载同级 quantum-sdk/index.cjs
 *
 * 接口映射 (SDK → 项目内):
 *   SDK: encrypt(text, mode)     → { cipherText, keyId }
 *   适配: encrypt(text, mode)    → { ciphertext, keyId }  (小写 t)
 *   SDK: decrypt(text, keyId, mode) → { plainText }
 *   适配: decrypt(text, keyId, mode) → { plaintext }      (小写 t)
 */
/** 文件加密选项 (分片间传递的上下文) */
interface FileEncryptOptions {
    keyId?: string | null;
    sessionKey?: string;
    fillKey?: string;
}
/** 文件加密结果 */
interface FileEncryptResult {
    fileBuffer: Buffer;
    keyId: string;
    sessionKey: string;
    fillKey: string;
}
/** 文件解密选项 */
interface FileDecryptOptions {
    sessionKey?: string;
    fillKey?: string;
}
/** 文件解密结果 */
interface FileDecryptResult {
    fileBuffer: Buffer;
    sessionKey: string;
    fillKey: string;
}

/**
 * openclaw-liangzimixin — 加密引擎
 *
 * 封装量子加密 SDK 的加解密操作。
 * 上层模块 (TokenStore, MessagePipe) 通过此类完成所有加解密，
 * 不直接接触底层 SDK，实现 SDK 可替换性。
 *
 * 两种运行模式:
 *   1. 加密模式 (默认): 通过量子加密 SDK 进行真正的加解密
 *   2. 透传模式 (passthrough): 不做加密，明文直接透传，用于 crypto.enabled=false 场景
 *
 * 使用方式:
 *   // 加密模式
 *   const engine = new CryptoEngine(credentials, env);
 *   await engine.init();
 *   const { ciphertext, keyId } = await engine.encrypt('hello');
 *   const plaintext = await engine.decrypt(ciphertext, keyId);
 *
 *   // 透传模式 (crypto.enabled=false)
 *   const engine = CryptoEngine.createPassthrough();
 *   // 无需 init(), encrypt/decrypt 直接透传明文
 */

/** 初始化加密引擎所需的凭据 */
interface CryptoCredentials {
    /** 应用 ID */
    appId: string;
    /** 量子账户标识 — 映射到 quantum.json 的 account */
    quantumAccount: string;
}
/**
 * 加密引擎 — 统一的加解密入口。
 *
 * 封装底层量子加密 SDK 的调用细节,
 * 屏蔽 Mock 与真实 SDK 的差异,
 * 上层模块无需关心底层实现。
 *
 * 支持两种模式:
 *   - 加密模式: 使用量子加密 SDK 进行加解密
 *   - 透传模式: encrypt/decrypt 直接透传明文, 不做任何加密操作
 *
 * 生命周期 (加密模式):
 *   1. 构造: new CryptoEngine(credentials, env)
 *   2. 初始化: await init() — 写入 quantum.json + 调用 SDK init()
 *   3. 使用: encrypt() / decrypt() / encryptFileChunk() / decryptFileChunk()
 *
 * 生命周期 (透传模式):
 *   1. 构造: CryptoEngine.createPassthrough()
 *   2. 直接使用: encrypt() / decrypt() — 无需 init()
 */
declare class CryptoEngine {
    /** 底层量子加密 SDK 实例, 透传模式下为 null */
    private readonly plug;
    /** SDK 是否已完成初始化 */
    private initialized;
    /** 是否为透传模式 (不加密, 明文直接透传) */
    private readonly passthrough;
    /** 初始化凭据 */
    private readonly credentials;
    /** 部署环境 */
    private readonly env;
    /** 加密/解密操作超时 (ms) */
    private readonly operationTimeoutMs;
    /**
     * 构造加密引擎 (加密模式)
     *
     * @param credentials - 量子 SDK 所需的凭据
     * @param env - 部署环境 ('test' | 'staging' | 'production')
     */
    constructor(credentials: CryptoCredentials, env?: string, operationTimeoutMs?: number);
    /**
     * 创建透传模式的加密引擎 (静态工厂方法)
     *
     * 透传模式下:
     *   - 无需调用 init()
     *   - encrypt() 直接返回明文 (keyId = 'passthrough')
     *   - decrypt() 直接返回 ciphertext 原文
     *
     * 适用于 config.crypto.enabled = false 的场景,
     * 上层模块 (TokenStore, MessagePipe) 无需感知加密是否开启。
     */
    static createPassthrough(): CryptoEngine;
    /**
     * 初始化加密引擎
     *
     * 加密模式: 写入 quantum.json 配置 → 调用 SDK init()
     * 透传模式: 空操作 (already initialized)。
     * 幂等操作 — 重复调用安全。
     */
    init(): Promise<void>;
    /**
     * 加密明文
     *
     * 加密模式: 生成随机 IV，调用底层 SDK 加密 (SM4_CBC_PKCS7PADDING)
     * 透传模式: 直接返回明文作为 "密文", keyId = 'passthrough'
     *
     * @param plaintext - 要加密的明文字符串
     * @returns { ciphertext: 密文字符串, keyId: 密钥标识, iv: 初始化向量 }
     */
    encrypt(plaintext: string): Promise<{
        ciphertext: string;
        keyId: string;
        iv: string;
    }>;
    /**
     * 解密密文
     *
     * 加密模式: 调用底层 SDK 解密
     * 透传模式: 直接返回 ciphertext 原文
     *
     * @param ciphertext - 密文字符串 (encrypt 返回的 ciphertext)
     * @param keyId      - 密钥标识 (encrypt 返回的 keyId)
     * @param iv         - 初始化向量 (encrypt 返回的 iv)
     * @returns 解密后的明文字符串
     */
    decrypt(ciphertext: string, keyId: string, iv?: string): Promise<string>;
    /**
     * 文件分片加密
     *
     * 对文件分片进行加密，支持多分片间的上下文传递 (sessionKey + fillKey)。
     * 第一个分片不需要传 options, 后续分片需传入前一个分片返回的 sessionKey + fillKey。
     *
     * @param chunk   - 文件分片 Buffer
     * @param iv      - 初始化向量 (16 个 hex 字符)
     * @param options - 分片间上下文 (keyId, sessionKey, fillKey)
     * @returns 加密结果 (fileBuffer, keyId, sessionKey, fillKey)
     */
    encryptFileChunk(chunk: Buffer, iv: string, options?: FileEncryptOptions): Promise<FileEncryptResult>;
    /**
     * 文件分片解密
     *
     * 对加密后的文件分片进行解密，支持多分片间的上下文传递。
     *
     * @param encryptedChunk - 加密后的分片 Buffer
     * @param keyId          - 加密时的 keyId
     * @param iv             - 初始化向量 (加密时使用的同一个 iv)
     * @param options        - 分片间上下文 (sessionKey, fillKey)
     * @returns 解密结果 (fileBuffer, sessionKey, fillKey)
     */
    decryptFileChunk(encryptedChunk: Buffer, keyId: string, iv: string, options?: FileDecryptOptions): Promise<FileDecryptResult>;
    /**
     * 查询当前是否为透传模式
     * 上层模块可通过此方法判断加密是否真正启用
     */
    isPassthrough(): boolean;
    /**
     * 获取文件加密分片大小 (10MB)
     */
    static get FILE_CHUNK_SIZE(): number;
    /**
     * 获取文件解密分片大小 (10MB + 16)
     */
    static get FILE_DECRYPT_CHUNK_SIZE(): number;
    /**
     * 确保引擎已初始化
     * 未初始化时抛出明确错误，避免难以排查的 SDK 内部异常
     */
    private ensureInitialized;
}

/**
 * openclaw-liangzimixin — Token 安全存储
 *
 * 加密持久化 Token 到 ~/.liangzimixin/tokens/ (目录 0700, 文件 0600)。
 * 使用 CryptoEngine 对 Token 数据进行量子加密(Mock)后存储。
 *
 * 存储格式 (JSON):
 *   { "ciphertext": "<Base64密文>", "keyId": "<密钥标识>" }
 *
 * 安全约束:
 *   - 目录权限: 0o700 (仅 owner 可读写执行)
 *   - 文件权限: 0o600 (仅 owner 可读写)
 *   - 使用 CryptoEngine 加密，不存储明文
 *   - 原子写入: 写临时文件 → rename 覆盖, 防止写入中断导致损坏
 */

/**
 * Token 安全存储 — 加密持久化 Token 到本地文件系统。
 *
 * 存储路径: ~/.liangzimixin/tokens/
 * 文件格式: JSON → CryptoEngine.encrypt() → { ciphertext, keyId } JSON → .enc 文件
 *
 * 操作:
 *   save(key, data)  — JSON → 加密 → 原子写入文件
 *   load(key)        — 读文件 → 解密 → JSON.parse
 *   clear(key)       — 删除文件
 */
declare class TokenStore {
    /** 存储目录路径 */
    private readonly storageDir;
    /** 加密引擎 — 用于加密/解密 Token 数据 (异步接口) */
    private readonly crypto;
    /** 目录是否已初始化 (避免重复 mkdir) */
    private dirEnsured;
    /**
     * @param storageDir - 存储目录路径 (如 '~/.liangzimixin/tokens')
     * @param crypto - CryptoEngine 实例 (需已调用 init())
     */
    constructor(storageDir: string, crypto: CryptoEngine);
    /**
     * 确保存储目录存在并设置正确的权限。
     * 使用缓存标记避免重复检查文件系统。
     */
    private ensureDir;
    /**
     * 获取指定 key 对应的加密文件路径
     * @param key - 存储键名 (如 'token', 'credentials')
     */
    private filePath;
    /**
     * 保存 Token — 加密写入文件
     *
     * 流程:
     *   1. JSON.stringify(data) → 明文 JSON
     *   2. await CryptoEngine.encrypt(json) → { ciphertext, keyId }
     *   3. 将 { ciphertext, keyId } 序列化为 JSON 写入文件
     *   4. 原子写入: 先写临时文件 → rename 覆盖目标文件
     *
     * @param key - 存储键名 (如 'token', 'credentials')
     * @param data - 要保存的数据 (TokenData 或其他可序列化对象)
     */
    save(key: string, data: TokenData | Record<string, unknown>): Promise<void>;
    /**
     * 加载 Token — 解密读取文件
     *
     * 流程:
     *   1. readFile → 读取 { ciphertext, keyId } JSON
     *   2. await CryptoEngine.decrypt(ciphertext, keyId) → 明文 JSON
     *   3. JSON.parse → TokenData
     *
     * @param key - 存储键名
     * @returns 令牌数据, 文件不存在或解密失败时返回 null
     */
    load(key: string): Promise<TokenData | null>;
    /**
     * 清除 Token — 删除对应的存储文件
     *
     * @param key - 存储键名
     */
    clear(key: string): Promise<void>;
}

/**
 * openclaw-liangzimixin — Token 生命周期管理
 *
 * 自动获取 / 缓存 / 过期重取 / 并发锁 / 定时刷新
 *
 * Token 生命周期策略:
 *   - 首次调用: 检查本地缓存 → 未命中则调用 POST /auth/token → 缓存
 *   - 过期处理: 直接重新调用 getToken() 获取新 Token
 *   - 提前刷新: Token 过期前 refreshAheadMs 毫秒自动重新获取
 *   - 并发锁: 多个并发请求共享同一个 Token 获取 Promise
 *
 * 安全要求:
 *   - 并发锁防止多个请求同时获取 Token
 *   - 重试策略有最大次数限制 (3 次)
 *   - 指数退避: 1s, 2s, 4s
 */

/**
 * Token 生命周期管理器 — 自动处理令牌的获取、缓存、过期重取和并发控制。
 *
 * 核心方法:
 *   getValidToken()  — 获取有效的 access_token (自动获取/重取/并发锁)
 *   hasScope(scope)  — 检查当前令牌是否包含指定的 scope
 *   isAuthorized()   — 检查是否持有有效令牌
 *   revokeAndClear() — 废置并清除所有令牌
 *   shutdown()       — 清理定时器和并发锁
 */
declare class TokenManager {
    private readonly oauthClient;
    private readonly tokenStore;
    /** Token 过期前提前刷新的时间 (ms) */
    private readonly refreshAheadMs;
    /** 内存中缓存的 access_token */
    private cachedToken;
    /** 内存中缓存的 scope (用于 hasScope 检查) */
    private cachedScope;
    /** 完整的 TokenData (用于过期判断) */
    private currentTokenData;
    /** 并发刷新锁 — 多个并发 getValidToken() 调用共用同一个 Promise */
    private refreshLock;
    /** 定时刷新器句柄 */
    private refreshTimer;
    constructor(deps: {
        oauthClient: OAuthClient;
        tokenStore: TokenStore;
        refreshAheadMs?: number;
    });
    /**
     * 获取有效的 access_token — 自动获取/重取，含并发锁。
     *
     * 流程:
     *   1. 内存缓存检查: cachedToken 存在且未过期 → 直接返回
     *   2. 并发锁检查: refreshLock 不为 null → await 共享 Promise
     *   3. 慢路径: 设置 refreshLock → _acquireTokenWithRetry() → 清除锁
     *
     * @returns 有效的 access_token 字符串
     */
    getValidToken(): Promise<string>;
    /** 检查当前令牌是否包含指定的 scope */
    hasScope(scope: string): boolean;
    /** 检查是否已授权 (是否持有有效令牌) */
    isAuthorized(): boolean;
    /**
     * 失效当前内存缓存的 Token — 下次 getValidToken() 将重新获取。
     * 用于出站 HTTP 收到 401 时主动清除可能已过期的 Token。
     * 注意: 不清除文件存储，_acquireToken 会重新获取并覆盖。
     */
    invalidate(): void;
    /** 废置并清除所有令牌 (包括文件存储和内存缓存) */
    revokeAndClear(): Promise<void>;
    /** 清理定时器和并发锁 — 优雅关闭时调用 */
    shutdown(): void;
    /**
     * Token 获取 + 指数退避重试
     *
     * 重试策略:
     *   - 网络错误 / 5xx → 重试 (最多 3 次)
     *   - 401/403 → 不重试 (凭证可能无效)
     */
    private _acquireTokenWithRetry;
    /**
     * Token 获取核心逻辑
     *
     * 流程:
     *   1. 尝试从 TokenStore 加载缓存
     *   2. 调用 OAuthClient.getToken() 获取新 Token
     *   3. 保存到内存缓存 + TokenStore
     *   4. 设置定时刷新器
     */
    private _acquireToken;
    /** 更新内存缓存 */
    private updateCache;
    /** Token 是否需要刷新 (含提前量) — 用于触发主动刷新 */
    private isTokenExpired;
    /** Token 是否真正过期 (不含提前量) — 用于判断缓存的 Token 是否还能用 */
    private isTokenHardExpired;
    /**
     * 设置定时刷新器 — 在 Token 过期前 refreshAheadMs 毫秒自动重新获取
     */
    private scheduleRefresh;
    /** 清除定时刷新器 */
    private clearRefreshTimer;
}

/**
 * openclaw-liangzimixin — WebSocket 客户端封装
 *
 * 封装原生 WebSocket，提供基于 EventEmitter 的消息事件接口。
 * 发射事件: 'message' (Buffer | string), 'open', 'close', 'error'
 *
 * 重连安全: 每次 connect() 创建新 ws 实例并重新绑定底层事件。
 * 外部通过 EventEmitter 监听 WSClient 的事件 (如 MessagePipe),
 * 不受底层 ws 实例替换影响。
 */

/** WebSocket 连接参数 */
interface WSClientOptions {
    /** WebSocket 服务器地址 (ws://... 或 wss://...) */
    url: string;
    /** OAuth access_token — 用于消息验签，非连接认证 */
    token: string;
    /** WebSocket 子协议 */
    protocols?: string[];
    /** 额外的 HTTP 头 (X-App-ID 在此传入) */
    headers?: Record<string, string>;
}
/**
 * WebSocket 客户端 — 基于 EventEmitter 的 WS 封装。
 * 由 ConnectionManager 管理其生命周期 (连接/断开/重连)。
 *
 * 仅负责「连接/断开/收发」，不负责心跳和重连。
 */
declare class WSClient extends EventEmitter {
    /** 底层 WebSocket 实例 */
    private ws;
    constructor();
    /**
     * 连接到 WebSocket 服务器并绑定事件。
     * 每次调用都创建新 ws 实例，旧实例事件自动解绑。
     */
    connect(options: WSClientOptions): Promise<void>;
    /** 发送数据到服务器 — 前置检查连接状态 */
    send(data: string | Buffer): void;
    /** 发送 WebSocket 协议级 Ping 帧 */
    ping(): void;
    /** 关闭连接 */
    close(code?: number, reason?: string): void;
    /** 当前连接状态 (0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED) */
    get readyState(): number;
}

/**
 * openclaw-liangzimixin — 消息去重
 *
 * TTL Map 去重: 5 分钟窗口, ≤ 5000 条。
 */
/** 去重配置 */
interface DedupConfig {
    /** 去重缓存 TTL (ms)，默认 5 分钟 */
    ttlMs?: number;
    /** 最大缓存条数，默认 5000 */
    maxEntries?: number;
}
/**
 * 消息去重器 — 基于 TTL Map 实现。
 * - 5 分钟窗口自动过期
 * - 最大 5000 条，超出时淘汰最旧的记录 (FIFO)
 * - 利用 Map 的插入顺序保证淘汰顺序
 */
declare class MessageDedup {
    /** 去重缓存生存时间 (ms) */
    private readonly ttlMs;
    /** 最大缓存条数 */
    private readonly maxEntries;
    /** messageId → 时间戳映射 (Map 保持插入顺序) */
    private readonly seen;
    constructor(config?: DedupConfig);
    /**
     * 检查消息是否重复。
     * 首次见到的消息返回 false 并记录，重复消息返回 true。
     * 内部自动清理过期条目 + 容量淘汰。
     */
    isDuplicate(messageId: string): boolean;
    /** 清理过期条目 (利用 Map 插入顺序，遇到未过期的即停止) */
    private cleanup;
    /** 当前缓存条数 */
    get size(): number;
}

/**
 * openclaw-liangzimixin — Semaphore 并发控制
 *
 * 轻量级信号量，限制同时执行的异步任务数。
 * - acquire(): 获取 slot，满时排队等待
 * - tryAcquire(): 非阻塞尝试获取，失败返回 false
 * - release(): 释放 slot，唤醒等待队列中的下一个
 *
 * 等待队列有上限 (maxWaiting)，溢出时 acquire() 返回 'rejected'。
 */
/** Semaphore 配置 */
interface SemaphoreOptions {
    /** 最大并发数 */
    maxConcurrency: number;
    /** 等待队列最大长度，超出后 acquire 返回 'rejected' */
    maxWaiting?: number;
}
/** acquire() 的返回值 */
type AcquireResult = 'acquired' | 'rejected';
/**
 * Semaphore — 基于 Promise 的异步信号量。
 *
 * 用于限制入站消息处理并发数、文件上传并发数等。
 * 零外部依赖，纯内存实现。
 */
declare class Semaphore {
    /** 最大并发数 */
    private readonly maxConcurrency;
    /** 等待队列最大长度 */
    private readonly maxWaiting;
    /** 当前持有 slot 的数量 */
    private active;
    /** 等待队列 (FIFO) */
    private readonly waiters;
    /** 累计获取成功次数 */
    private acquiredCount;
    /** 累计拒绝次数 (队列溢出) */
    private rejectedCount;
    constructor(options: SemaphoreOptions);
    /**
     * 获取一个并发 slot。
     *
     * - 有空闲 slot → 立即返回 'acquired'
     * - 无空闲 slot 且等待队列未满 → 排队等待，返回 Promise<'acquired'>
     * - 无空闲 slot 且等待队列已满 → 立即返回 'rejected'
     */
    acquire(): Promise<AcquireResult>;
    /**
     * 非阻塞尝试获取 slot。
     * 有空闲 slot 返回 true，否则返回 false (不排队)。
     */
    tryAcquire(): boolean;
    /**
     * 释放一个并发 slot。
     * 如果等待队列非空，唤醒下一个 waiter。
     */
    release(): void;
    /** 当前活跃 slot 数 */
    get activeCount(): number;
    /** 当前等待队列长度 */
    get waitingCount(): number;
    /** 累计获取成功次数 */
    get totalAcquired(): number;
    /** 累计拒绝次数 */
    get totalRejected(): number;
    /** 获取指标快照 */
    getStats(): {
        active: number;
        waiting: number;
        acquired: number;
        rejected: number;
    };
}

/**
 * openclaw-liangzimixin — 消息管道编排 (MessagePipe)
 *
 * 入站: WS 帧 → 验签 → 解密 → 解析 CallbackData → 去重 → 回调 L4
 * 出站: L4 OutboundMessage → HTTP API (POST /messages/v1/send)
 * 撤回: POST /messages/v1/recall
 */

/**
 * 消息管道编排 — 统一入站/出站消息的处理流程。
 *
 * 入站: WS 原始帧 → 验签 → 解密 → 解析 CallbackData → 去重 → 回调 L4
 * 出站: L4 OutboundMessage → POST /messages/v1/send
 * 撤回: POST /messages/v1/recall
 */
declare class MessagePipe {
    private readonly wsClient;
    private readonly dedup;
    private readonly crypto;
    /** 获取最新 access_token 的回调 (用于 HMAC 验签和出站 Bearer 认证) */
    private readonly tokenFn;
    /** 失效当前 Token 缓存的回调 — 收到 401 时调用，强制下次 tokenFn 重新获取 */
    private readonly invalidateTokenFn?;
    /** 消息服务 API 基础地址 (用于出站发送/撤回) */
    private readonly messageServiceBaseUrl;
    /** L4 层注册的入站消息回调 */
    private messageCallback;
    /** 量子账户标识 — 用于判断是否具备解密能力 */
    private readonly quantumAccount?;
    /** 消息加密模式 */
    private readonly encryptionMode;
    /** CryptoEngine 是否处于 passthrough 模式 (crypto 初始化失败或未启用) */
    private readonly cryptoIsPassthrough;
    /** 入站并发控制信号量 */
    private readonly inboundSemaphore;
    /** 出站速率限制器 */
    private readonly rateLimiter;
    constructor(deps: {
        wsClient: WSClient;
        dedup: MessageDedup;
        crypto: CryptoEngine;
        /** TokenManager.getValidToken — 用于验签和出站认证 */
        tokenFn: () => Promise<string>;
        /** TokenManager.invalidate — 收到 401 时清除 Token 缓存 */
        invalidateTokenFn?: () => void;
        /** 消息服务 API 基础地址 */
        messageServiceBaseUrl: string;
        /** 量子账户标识 — 用于判断是否具备解密能力 */
        quantumAccount?: string;
        /** 消息加密模式 */
        encryptionMode: 'quantum_only' | 'quantum_and_plain';
        /** CryptoEngine 是否处于 passthrough 模式 — 由 index.ts 初始化时传入 */
        cryptoIsPassthrough?: boolean;
        /** 入站最大并发处理数 */
        maxInboundConcurrency?: number;
        /** 入站等待队列上限 */
        maxWaitingQueue?: number;
        /** 出站 API 速率限制 — 每秒请求数 */
        rateLimitPerSecond?: number;
        /** 出站 API 速率限制 — 突发容量 */
        rateLimitBurst?: number;
    });
    /** 获取入站并发信号量 — 由 InboundPipeline 用于 acquire/release */
    get semaphore(): Semaphore;
    /** 注册入站消息回调 — 解密后的消息会通过此回调传给 L4 层 */
    onMessage(callback: (msg: InboundMessage) => void): void;
    /**
     * 🧪 DEBUG — 注入模拟 WS 原始帧，走完完整的 7 步入站流水线。
     * 用于测试 MessagePipe 的验签→解密→解析→去重→回调全流程。
     * TODO: 验证通过后移除此方法
     */
    injectRawFrame(rawData: string | Buffer): Promise<void>;
    /**
     * 加密文件 Buffer — 按 10MB 分片加密，返回加密后的 Buffer + 密钥信息。
     * 用于文件上传前的加密处理。
     *
     * 如果 CryptoEngine 为透传模式，直接返回原始 buffer。
     *
     * @param buffer - 原始文件 Buffer
     * @returns { encryptedBuffer, keyId, iv } — 加密后的 buffer + 密钥标识 + 初始化向量
     */
    encryptFile(buffer: Buffer): Promise<{
        encryptedBuffer: Buffer;
        keyId: string;
        iv: string;
    }>;
    /**
     * 解密文件 Buffer — 按分片解密，返回解密后的 Buffer。
     * 用于入站加密文件消息的下载后解密。
     *
     * 如果 CryptoEngine 为透传模式，直接返回原始 buffer。
     *
     * @param buffer - 加密的文件 Buffer
     * @param keyId  - 加密时的密钥标识 (来自 extraContent.sessionId)
     * @param iv     - 初始化向量 (来自 extraContent.cryptoIv)
     * @returns 解密后的 Buffer
     */
    decryptFile(buffer: Buffer, keyId: string, iv: string): Promise<Buffer>;
    /** 文件类消息类型集合 — 这些类型的加密消息保留原始 content（文件元数据） */
    private static readonly FILE_MSG_TYPES;
    /**
     * 构建文件类加密消息的 extraContent — 完整模板格式。
     * 文件消息不加密 content（需要保留 fileId 等元数据），只在 extraContent 中携带会话信息。
     */
    private static buildFileEncryptExtra;
    /**
     * 出站发送 — 通过 HTTP API 发送消息到 IM 服务器。
     * POST {messageServiceBaseUrl}/messages/v1/send
     * 字段映射: senderId → receive_id, msgType → msg_type
     *
     * 加密行为取决于 encryptionMode:
     * - quantum_only:      强制加密，失败直接抛错（不降级明文）
     * - quantum_and_plain:  加密失败降级明文（保持兼容）
     *
     * 文件类消息 (image/file/voice/video):
     * - content 保留原始文件元数据（fileId、fileName、size 等）
     * - extraContent 使用完整模板格式，encryptMsg 为空
     *
     * 文本类消息 (text/markdown):
     * - content 加密后置空，密文放入 extraContent.encryptMsg
     */
    sendMessage(msg: OutboundMessage): Promise<void>;
    /**
     * 撤回消息 — 通过 HTTP API 撤回已发送的消息。
     * POST {messageServiceBaseUrl}/messages/v1/recall
     *
     * TODO(upstream): target_id 和 conversation_type 等上游明确后替换。
     * TODO(upstream): 上游会提供需要撤回的事件类型，届时在入站管道中注册处理。
     */
    recallMessage(params: {
        messageId: string;
        chatId?: string;
    }): Promise<void>;
    /**
     * 消息服务 API 公共调用方法。
     * 封装 fetch + Bearer 认证 + HTTP 状态检查 + JSON 解析 + 业务码校验。
     * 失败返回 null（不抛异常），错误通过 log 记录。
     *
     * @param path - API 路径 (拼接在 messageServiceBaseUrl 后)
     * @param body - 请求体
     * @param logTag - 日志标签前缀 (如 'outbound' / 'recall')
     */
    /** 单次 HTTP 请求封装 — callMessageApi 内部使用 */
    private _callMessageApiOnce;
    /**
     * 消息服务 API 公共调用方法 — 含 1 次重试 (仅限 5xx / 网络错误)。
     * 失败返回 null（不抛异常），错误通过 log 记录。
     */
    private callMessageApi;
    /**
     * 入站处理流水线 (7 步):
     * 1. JSON.parse → WildGooseFrame
     * 2. HMAC-SHA256 验签
     * 3. 解密/解析 data → CallbackData
     * 4. 事件类型过滤
     * 5. 提取 InboundMessage
     * 6. 去重检查
     * 7. 回调 L4
     */
    private handleInbound;
    /**
     * 发送系统提示消息（明文，不加密）。
     * 用于在模式不匹配时向用户发送引导信息。
     */
    private sendHintMessage;
    /**
     * 解密 extraContent 中的加密内容。
     * @throws 解密失败时抛出异常
     */
    private decryptExtra;
}

/**
 * openclaw-liangzimixin — 连接管理器
 *
 * 心跳保活 (30s) + 三阶段退避重连:
 *   Phase 1: 指数退避 1s → 2s → 4s → ... → 60s (前 7 次)
 *   Phase 2: 尾部退避 120s → 240s → 480s (第 8~10 次)
 *   Phase 3: 持续重试 300s (5 分钟) 间隔，永不放弃
 *
 * Wild-Goose 离线消息: 重连后网关自动重发 (Redis 缓存 7 天),
 * 插件的 dedup.ts 会过滤重复消息。
 */

/** 连接管理配置 */
interface ConnectionManagerOptions {
    /** 心跳发送间隔 (ms)，默认 30s */
    heartbeatIntervalMs?: number;
    /** 心跳响应超时 (ms)，默认 10s */
    heartbeatTimeoutMs?: number;
    /** 重连初始退避 (ms)，默认 1s */
    reconnectBaseMs?: number;
    /** 重连最大退避 (ms)，默认 60s */
    reconnectMaxMs?: number;
    /** Phase 1 最大重连尝试次数 (含 Phase 2 尾部)，默认 10 */
    maxReconnectAttempts?: number;
    /** Phase 2 尾部退避延迟序列 (ms)，从 maxReconnectAttempts 末尾倒数，默认 [120s, 240s, 480s] */
    tailBackoffDelays?: number[];
    /** Phase 3 持续重试间隔 (ms)，超过 maxReconnectAttempts 后使用，默认 300s (5 分钟) */
    persistentRetryIntervalMs?: number;
}
/**
 * 连接管理器 — 管理 WebSocket 的生命周期。
 * - 心跳保活: 每 30s 检查连接状态
 * - 三阶段重连: 指数退避 → 尾部退避 → 持续重试 (永不放弃)
 */
declare class ConnectionManager {
    private readonly client;
    private readonly options;
    /** 心跳定时器 */
    private heartbeatTimer;
    /** pong 超时定时器 — 每次 ping 后独立计时 */
    private pongTimeoutTimer;
    /** 当前重连尝试次数 */
    private reconnectAttempts;
    /** 是否处于运行状态 */
    private running;
    /** 当前连接的 URL */
    private url;
    /** 当前获取 Token 的回调 */
    private tokenFn;
    /** 应用 ID (用于 X-App-ID 头) */
    private appId;
    /** 是否正在重连中 (防止并发重连) */
    private reconnecting;
    /** 是否收到了最近一次 pong 响应 */
    private pongReceived;
    constructor(client: WSClient, options?: ConnectionManagerOptions);
    /**
     * 启动连接 — 连接 WS + 开始心跳 + 注册重连逻辑
     * @param url - WebSocket 服务器地址
     * @param tokenFn - 获取有效 Token 的回调 (由 TokenManager.getValidToken 提供)
     * @param appId - 应用 ID (用于 X-App-ID 头)
     */
    start(url: string, tokenFn: () => Promise<string>, appId?: string): Promise<void>;
    /** 注册 close / error / pong 事件 */
    private registerEvents;
    /** 启动心跳保活 — 定时发送 WebSocket Ping 帧 */
    private startHeartbeat;
    /** 清除 pong 超时定时器 */
    private clearPongTimeout;
    /** 停止心跳定时器 */
    private stopHeartbeat;
    /** 调度重连 (防止并发重连) */
    private scheduleReconnect;
    /**
     * 计算当前重连延迟 — 三阶段退避策略:
     *
     *   Phase 1 (attempt 0 ~ tailStart-1): 指数退避 1s → 60s
     *   Phase 2 (attempt tailStart ~ maxReconnectAttempts-1): 尾部退避 120s/240s/480s
     *   Phase 3 (attempt >= maxReconnectAttempts): 持续重试 300s
     */
    private computeReconnectDelay;
    /** 三阶段退避重连 — 永不放弃 */
    private reconnect;
    /** 停止连接 — 清理心跳定时器 + 关闭 WS */
    stop(): Promise<void>;
    /** 当前是否已连接 (WebSocket readyState === OPEN) */
    get isConnected(): boolean;
}

/** Cockatoo 客户端配置 */
interface CockatooClientConfig {
    /** 推送服务端点地址 */
    endpoint: string;
    /** API 密钥 */
    apiKey: string;
    /** 健康检查间隔 (ms)，默认 60s */
    healthCheckIntervalMs?: number;
}
/** Cockatoo 推送负载 */
interface CockatooPayload {
    /** 消息类型 (如 'alert', 'message') */
    type: string;
    /** 消息内容 */
    content: string;
    /** 额外元数据 */
    metadata?: Record<string, unknown>;
}
/**
 * Cockatoo 推送客户端 — 管理与推送服务的连接和健康状态。
 * 由 PushQueue 调用 push() 方法发送消息。
 */
declare class CockatooClient {
    private readonly config;
    /** 推送 API 的完整 URL (缓存，避免反复拼接) */
    private readonly pushUrl;
    /** 健康检查的完整 URL */
    private readonly healthUrl;
    /** 当前健康状态 */
    private healthy;
    /** 健康检查定时器 */
    private healthCheckTimer;
    constructor(config: CockatooClientConfig);
    /**
     * 推送消息到 Cockatoo 服务。
     *
     * POST {endpoint}/api/v1/push
     * Content-Type: application/json
     * Authorization: Bearer {apiKey}
     *
     * @throws CockatooPushError — HTTP 非 2xx，携带 status 供上层判断是否重试
     * @throws Error — 网络错误 / 超时
     */
    push(payload: CockatooPayload): Promise<void>;
    /**
     * 执行一次健康检查。
     *
     * GET {endpoint}/health
     * 2xx → true, 其他 → false
     * 网络错误/超时 → false (不抛异常)
     */
    healthCheck(): Promise<boolean>;
    /** 启动定时健康检查 (默认每 60s 一次) */
    startHealthCheck(): void;
    /** 停止定时健康检查 */
    stopHealthCheck(): void;
    /** 当前推送服务是否健康 */
    get isHealthy(): boolean;
}

/**
 * openclaw-liangzimixin — 推送队列
 *
 * 内存队列 ≤ 1000, 满时丢弃最旧, 重试 3 次 (指数退避 1s→2s→4s)
 *
 * 高可用设计:
 *   - 异步递归调度 (setTimeout 而非 setInterval) — 避免任务堆积
 *   - 健康感知 — 推送服务不健康时暂停消费，恢复后自动继续
 *   - 指数退避重试 — 失败后延迟重入队尾
 *   - 4xx / 5xx 区分 — 4xx 不重试 (请求有误)，5xx 重试 (服务端临时故障)
 *   - 优雅关闭 — stop() 等待当前处理完成，可选 drain 模式
 *   - 错误隔离 — 单条消息异常不影响整体循环
 *   - 背压控制 — 空队列时增大轮询间隔
 */

/** 推送队列配置 */
interface PushQueueConfig {
    /** 队列最大容量，默认 1000 */
    maxSize?: number;
    /** 失败重试次数，默认 3 */
    retryAttempts?: number;
    /** 队列非空时的处理间隔 (ms)，默认 100 */
    processIntervalMs?: number;
    /** 队列为空时的轮询间隔 (ms)，默认 1000 */
    idleIntervalMs?: number;
    /** 推送服务不健康时的重检间隔 (ms)，默认 5000 */
    unhealthyRetryMs?: number;
    /** 停止时是否尽力处理完剩余消息，默认 false */
    drainOnStop?: boolean;
    /** drain 最大等待时间 (ms)，默认 5000 */
    drainTimeoutMs?: number;
}
/**
 * 推送队列 — 内存队列 + 异步消费循环。
 *
 * 消费循环设计:
 *   1. 检查服务健康状态 → 不健康则等待 unhealthyRetryMs 后重试
 *   2. 从队头取出一条消息
 *   3. 检查退避时间 → 未到时间则跳过，放回队头
 *   4. 调用 CockatooClient.push() 发送
 *   5. 成功 → 移除; 失败:
 *      - 4xx → 丢弃 (不重试)
 *      - 5xx / 网络错误 → retries++ → 退避后重入队尾
 *      - 超过最大重试次数 → 丢弃并记录
 *   6. setTimeout 递归调度下一轮
 */
declare class PushQueue {
    private readonly client;
    /** 队列最大容量 */
    private readonly maxSize;
    /** 失败重试次数 */
    private readonly retryAttempts;
    /** 队列非空时的处理间隔 (ms) */
    private readonly processIntervalMs;
    /** 队列为空时的轮询间隔 (ms) */
    private readonly idleIntervalMs;
    /** 推送服务不健康时的重检间隔 (ms) */
    private readonly unhealthyRetryMs;
    /** 停止时是否尽力处理完剩余 */
    private readonly drainOnStop;
    /** drain 最大等待时间 (ms) */
    private readonly drainTimeoutMs;
    /** 内存队列 */
    private readonly queue;
    /** 是否处于运行状态 */
    private running;
    /** 消费循环调度器句柄 */
    private processTimer;
    /** 当前是否正在处理一条消息 (防止 drain 和循环并发) */
    private processing;
    /** 成功发送数 */
    private sentCount;
    /** 丢弃数 (超过重试次数 / 4xx / 队列满) */
    private droppedCount;
    /** 重试数 */
    private retryCount;
    constructor(client: CockatooClient, config?: PushQueueConfig);
    /** 启动消费循环 */
    start(): void;
    /**
     * 停止消费循环。
     *
     * - drainOnStop=false: 立即停止，队列中剩余消息保留但不再处理
     * - drainOnStop=true: 等待当前队列处理完毕 (最多 drainTimeoutMs)
     */
    stop(): Promise<void>;
    /**
     * 入队 — 队列满时丢弃最旧的消息 (FIFO)
     * @param payload - Cockatoo 推送负载
     */
    enqueue(payload: CockatooPayload): void;
    /** 当前队列长度 */
    get size(): number;
    /** 获取队列统计指标 */
    get stats(): {
        sent: number;
        dropped: number;
        retried: number;
        pending: number;
    };
    /**
     * 调度下一轮处理。
     * 使用 setTimeout 递归而非 setInterval，确保上一轮完成后再调度，避免任务堆积。
     */
    private scheduleNext;
    /**
     * 消费循环主体 — 每轮处理一条消息。
     *
     * 决策流程:
     *   服务不健康 → 等待 unhealthyRetryMs
     *   队列为空    → 等待 idleIntervalMs
     *   消息在退避中 → 跳过放回，等待 processIntervalMs
     *   正常处理    → 发送 → 等待 processIntervalMs
     */
    private tick;
    /**
     * 处理单条消息 — 发送 + 错误分类 + 重试决策。
     *
     * 错误处理:
     *   - CockatooPushError (4xx) → 丢弃，不重试 (请求格式有误)
     *   - CockatooPushError (5xx) → 重试 (服务端临时故障)
     *   - 网络错误 / 超时          → 重试 (连接问题)
     *   - 超过最大重试次数          → 丢弃并记录
     */
    private processItem;
    /**
     * Drain 模式 — 尽力处理完剩余消息 (限时)。
     * 不重试失败的消息，减少 drain 时间。
     */
    private drain;
    /** 清除调度定时器 */
    private clearTimer;
}

/**
 * openclaw-liangzimixin — JSON Schema 配置描述
 *
 * 用于 OpenClaw 框架的配置校验和 UI 表单自动生成。
 * 仅描述用户需要在 openclaw.json 中配置的字段（账户凭据）。
 */
/**
 * liangzimixin 账户配置的 JSON Schema (Draft-07)。
 * OpenClaw 框架通过此 Schema:
 * 1. 在管理界面自动生成配置表单
 * 2. 校验用户填写的配置是否合法
 * 3. CLI setup 命令引导用户交互式输入
 */
declare const QUANTUM_IM_CONFIG_JSON_SCHEMA: {
    readonly $schema: "http://json-schema.org/draft-07/schema#";
    readonly title: "量子密信 IM 插件配置";
    readonly description: "密信 IM Channel 插件，支持量子加密的安全即时通信。";
    readonly type: "object";
    readonly required: readonly ["appId", "appSecret"];
    readonly properties: {
        readonly appId: {
            readonly type: "string";
            readonly title: "应用 ID";
            readonly description: "在平台申请的应用标识，用于 API 鉴权和 WS 连接";
            readonly minLength: 1;
        };
        readonly appSecret: {
            readonly type: "string";
            readonly title: "应用密钥";
            readonly description: "与 appId 配对，用于签名和身份校验";
            readonly minLength: 1;
            readonly format: "password";
        };
        readonly quantumAccount: {
            readonly type: "string";
            readonly title: "量子账户标识（可选）";
            readonly description: "绑定的服务账号/租户 ID，填写后启用量子加密模块";
        };
        readonly botUserId: {
            readonly type: "string";
            readonly title: "Bot 用户 ID";
            readonly description: "用于 anti-loop 检查，防止处理自己发送的消息";
        };
        readonly env: {
            readonly type: "string";
            readonly title: "部署环境";
            readonly description: "选择对接的服务器环境。test = 测试环境，staging = 联调环境，production = 线上环境";
            readonly enum: readonly ["test", "staging", "production"];
            readonly default: "production";
        };
        readonly encryptionMode: {
            readonly type: "string";
            readonly title: "消息加密模式";
            readonly description: "quantum_only = 仅量子加密消息（所有消息必须加密）；quantum_and_plain = 同时支持加密和普通消息";
            readonly enum: readonly ["quantum_only", "quantum_and_plain"];
            readonly default: "quantum_and_plain";
        };
    };
};

interface PluginInstance {
    /** 解析后的完整插件配置 */
    config: PluginConfig;
    /** 消息管道 — 入站/出站消息的加解密和收发 */
    messagePipe: MessagePipe;
    /** 连接管理器 — 心跳保活 + 断线重连 */
    connectionManager: ConnectionManager;
    /** Token 管理器 — OAuth 令牌获取/刷新/缓存 */
    tokenManager: TokenManager;
    /** 推送队列 — Cockatoo 推送 (可选模块，未启用时为 null) */
    pushQueue: PushQueue | null;
    /** 优雅关闭 — 按反向依赖顺序停止所有模块 */
    shutdown: () => Promise<void>;
}
/**
 * 初始化所有模块 (按依赖拓扑顺序)。
 * 由 gateway.startAccount() 内部调用。
 *
 * @param accountConfig - 已解析的用户凭据配置
 * @param internalOverrides - 可选的内部配置覆盖
 */
declare function startPlugin(accountConfig: AccountConfig, internalOverrides?: Partial<InternalConfig>): Promise<PluginInstance>;
declare const plugin: {
    id: string;
    name: string;
    description: string;
    register(api: {
        registerChannel: (opts: {
            plugin: typeof quantumImPlugin;
        }) => void;
        runtime: unknown;
    }): void;
};

export { type AccountConfig, AccountConfigSchema, EncryptionStrategy, type InboundMessage, type OutboundMessage, type PluginConfig, type PluginInstance, QUANTUM_IM_CONFIG_JSON_SCHEMA, buildPluginConfig, plugin as default, quantumImPlugin, startPlugin };

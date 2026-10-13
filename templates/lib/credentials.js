/**
 * 宿主应用凭据读取器骨架。
 *
 * 设计要点：
 *   1. **依赖为零** —— 只用 node: 内置模块。dsh 自带的包由 dsh 解析，
 *      宿主应用自己的库不要 import（版本和路径都不可控）。
 *   2. **两条链都要实现**：应用升级会换掉凭据存储方式（OfficeAce 1.3.3 的
 *      DPAPI profile 在 1.3.4 变成 SQLite KV）。运行时按存在性选择，
 *      只实现一条链会在下次升级时直接失效。
 *   3. **缓存按 mtime 失效**：应用续期或轮换密钥后会改写文件，按 mtime
 *      失效即可自愈。SQLite 还要看 -wal 文件。
 *   4. **插件无法自己续期登录**：会话过期只能让用户重新打开宿主应用。
 *      所以失败要抛稳定的 code，让上层翻译成 INVALID_CREDENTIAL。
 */

import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** 带稳定 code 的凭据错误；上层据此翻译成 LlmError(INVALID_CREDENTIAL)。 */
export class CHANGE_ME_Error extends Error {
	constructor(message, code) {
		super(message);
		this.name = "CHANGE_ME_Error";
		this.code = code;
	}
}

/** 宿主应用安装根目录。优先读环境变量，其次用平台约定路径。 */
export function defaultInstallRoot() {
	const local = process.env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local");
	return path.join(local, "Programs", "CHANGE_ME");
}

/** 宿主应用数据根目录。 */
export function defaultDataRoot() {
	return path.join(homedir(), ".CHANGE_ME");
}

/**
 * 归一化上游 base url。
 * 坑：应用存的常常是**不带 scheme 的裸主机名**，且常常需要补 /v2 之类的前缀。
 */
export function normalizeBaseUrl(raw) {
	if (typeof raw !== "string") throw new CHANGE_ME_Error("base url missing", "MISSING_BASE_URL");
	let url = raw.trim().replace(/\/+$/, "");
	if (url.length === 0) throw new CHANGE_ME_Error("base url empty", "MISSING_BASE_URL");
	if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
	if (!/\/v\d+$/.test(url)) url = `${url}/v2`;
	return url;
}

export class CHANGE_ME_Credentials {
	#installRoot;
	#dataRoot;
	#cache;

	constructor(options = {}) {
		this.#installRoot = options.installRoot ?? defaultInstallRoot();
		this.#dataRoot = options.dataRoot ?? defaultDataRoot();
	}

	get installRoot() { return this.#installRoot; }
	get dataRoot() { return this.#dataRoot; }

	/** 宿主应用的存储文件；不同版本可能是 SQLite 或加密 profile。 */
	get storeFile() {
		return process.env.CHANGE_ME_DATA_DIR ?? path.join(this.#installRoot, "data", "storage.sqlite");
	}

	/** 当前用户 id：多账号应用按它分目录，不要假设只有一个用户。 */
	#ownerUserId() {
		try {
			const raw = fs.readFileSync(path.join(this.#dataRoot, "connector-owner.local.json"), "utf8");
			const parsed = JSON.parse(raw);
			return typeof parsed.ownerUserId === "string" ? parsed.ownerUserId : undefined;
		} catch {
			return undefined;
		}
	}

	/** mtime 签名：缓存失效依据。SQLite 还要看 -wal。 */
	#signature() {
		const parts = [];
		for (const file of [this.storeFile, `${this.storeFile}-wal`]) {
			try { parts.push(String(fs.statSync(file).mtimeMs)); } catch { parts.push("-"); }
		}
		return parts.join(":");
	}

	/**
	 * 解析出可用的凭据。每次请求都调用；内部按 mtime 缓存。
	 * @returns {Promise<{baseUrl: string, authorization: string, expiresAt?: string, accountId?: string, store: string}>}
	 */
	async resolve() {
		const signature = this.#signature();
		if (this.#cache?.signature === signature) return this.#cache.value;

		// 链 A（新版）：SQLite KV 表。node:sqlite 在 Node 22.5+ / 24 可用。
		const fromStore = await this.#readSessionFromStore();
		if (fromStore !== undefined) {
			this.#cache = { signature, value: fromStore };
			return fromStore;
		}

		// 链 B（旧版）：OS 级加密 + AES-GCM profile。应用升级后可能整条消失。
		const fromProfile = await this.#readLegacyProfile();
		if (fromProfile !== undefined) {
			this.#cache = { signature, value: fromProfile };
			return fromProfile;
		}

		throw new CHANGE_ME_Error("not signed in; open CHANGE_ME and sign in again", "NOT_SIGNED_IN");
	}

	/** 链 A：从应用的 KV 表读 session。 */
	async #readSessionFromStore() {
		if (!fs.existsSync(this.storeFile)) return undefined;
		let DatabaseSync;
		try {
			({ DatabaseSync } = await import("node:sqlite"));
		} catch {
			throw new CHANGE_ME_Error("node:sqlite unavailable; need Node >= 22.5", "STORE_UNSUPPORTED");
		}

		const owner = this.#ownerUserId();
		const db = new DatabaseSync(this.storeFile, { readOnly: true });
		try {
			const rows = db
				.prepare("SELECT key, value FROM oc_kv_string WHERE key LIKE 'CHANGE_ME:session:user:%'")
				.all();
			if (rows.length === 0) return undefined;

			// 优先精确匹配 owner，否则只有一行时才采用。
			const exact = owner === undefined ? undefined : rows.find((row) => String(row.key).endsWith(`:${owner}`));
			const row = exact ?? (rows.length === 1 ? rows[0] : undefined);
			if (row === undefined) return undefined;

			const session = JSON.parse(String(row.value));
			const modelInfo = session?.providerState?.modelInfo;
			const auth = modelInfo?.model_auth_info;
			const appKey = auth?.model_app_key;
			const appSecret = auth?.model_app_secret;
			if (typeof appKey !== "string" || typeof appSecret !== "string") {
				throw new CHANGE_ME_Error("session has no model credentials", "MISSING_MODEL_AUTH");
			}

			return {
				// 地址是 per-user 的，每次重新读，不要硬编码。
				baseUrl: normalizeBaseUrl(modelInfo.model_api_url_base),
				// 具体方案由上游决定；Basic base64(key:secret) 是常见形态。
				authorization: `Basic ${Buffer.from(`${appKey}:${appSecret}`).toString("base64")}`,
				expiresAt: session?.expiresAt,
				accountId: session?.userId ?? owner,
				store: "sqlite",
			};
		} finally {
			db.close();
		}
	}

	/** 链 B：旧版加密 profile。应用升级后常常整条不存在，必须容忍。 */
	async #readLegacyProfile() {
		// 实现要点（按宿主应用实际算法对齐，不要猜）：
		//   1. 用 OS 级解密（Windows DPAPI / macOS Keychain）取出 install secret。
		//      若应用已移除该能力（如 --mode dpapi-unprotect 不再存在），直接返回 undefined。
		//   2. key = sha256(installSecret)
		//   3. AES-256-GCM 解密 profile：iv 与 authTag 分开存，alg 必须校验。
		//   4. 从解密结果取网关地址与凭据，同链 A。
		return undefined;
	}

	/**
	 * 诊断：只输出布尔值与路径，**绝不输出 key/token 原文**。
	 * 用于排查凭据链，不用于业务。
	 */
	async diagnose() {
		let resolved;
		try { resolved = await this.resolve(); } catch (error) { resolved = undefined; }
		return {
			installRoot: this.#installRoot,
			storeFile: this.storeFile,
			storeFilePresent: fs.existsSync(this.storeFile),
			signedIn: resolved !== undefined,
			store: resolved?.store,
			baseUrl: resolved?.baseUrl,
			accountId: resolved?.accountId,
			expiresAt: resolved?.expiresAt,
			authorizationLength: resolved === undefined ? 0 : resolved.authorization.length,
			reason: resolved === undefined ? "see resolve() error" : undefined,
		};
	}
}

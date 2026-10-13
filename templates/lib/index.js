/**
 * dsh-connect-CHANGE_ME —— 复用本机 CHANGE_ME 已登录的模型通道。
 *
 * 本骨架已把容易踩错的地方固定下来，改动点用 CHANGE_ME 标出：
 *   1. 错误翻译（否则普通 Error 会退化成不可重试的 UNKNOWN）
 *   2. usage 缓冲到流末尾（网关常把 usage 放在 finish_reason 之后）
 *   3. developer → system 降级、tool 角色保留
 *   4. 每个请求都带 attributionHeaders()
 *
 * 前置条件：先在 DSH 之外用独立脚本证明凭据链 + 上游协议能拿到 HTTP 200。
 * 没通过就不要动这个文件。
 */

import z from "@deepseek-ai/schemastery";
import {
	CONTEXT_WINDOW_EXCEEDED_CODE,
	INVALID_CREDENTIAL_CODE,
	LlmAdapter,
	LlmError,
	QUOTA_EXCEEDED_CODE,
	attributionHeaders,
	isContextWindowExceededError,
	isQuotaExceededError,
} from "@deepseek-ai/dsh-llm";
import { CHANGE_ME_Credentials, CHANGE_ME_Error } from "./credentials.js";

/** 插件名，同时是 cordis.patch.yml 里 insert[].id 的取值。 */
export const name = "dsh-connect-CHANGE_ME";

/** 只依赖 LLM 运行时；settings 通过 ctx.inject 软探测。 */
export const inject = ["llm"];

export const PROVIDER = "CHANGE_ME";
export const PROVIDER_NAME = "CHANGE_ME (Internal)";
export const DEFAULT_MAX_TOKENS = 32768;

/** 未知模型 id 的保守上下文窗口，取实测可用模型里的最小值。 */
export const FALLBACK_CONTEXT_WINDOW = 32768;

/**
 * 实测可用的模型。contextWindow 与 efforts 都必须是**探测出来的**，
 * 不是抄文档：发超大 prompt 让上游回显上限，发非法 effort 让上游回显合法集合。
 */
export const MODEL_SPECS = Object.freeze([
	// { id: "model-a", name: "Model A", contextWindow: 131072, efforts: ["low", "high"] },
]);

const TEXT_INDEX = 0;
const REASONING_INDEX = 1;
const TOOL_INDEX_BASE = 2;

/** 上游用厂商特有措辞报超长时，在这里补充正则。 */
const OVERFLOW_PATTERN = /CHANGE_ME|maximum input length|input token limit/i;

/** volatile 化的探测：volatile() 返回同一 Schema 加 meta 标记，不是 wrapper。 */
export const asVolatile = (schema) =>
	typeof schema?.volatile === "function" ? schema.volatile() : schema;

/** 解包 volatile 字段（parse 后是 {get()}，非 volatile 是裸值）。 */
export const unwrapVolatile = (value) =>
	value !== null && typeof value === "object" && typeof value.get === "function" ? value.get() : value;

/** 设置命名空间 = entry id；也是 registerModelDiscovery 的键。 */
export function settingsNamespaceOf(ctx) {
	return ctx.fiber?.entry?.options?.id ?? "CHANGE_ME";
}

/** 把 abort 与传输错误翻译成稳定 code，避免退化成 UNKNOWN。 */
function transportFailure(error, signal) {
	if (signal?.aborted === true) return new LlmError("CHANGE_ME request aborted", "ABORTED");
	const detail = error instanceof Error ? error.message : String(error);
	return new LlmError(`CHANGE_ME transport failed: ${detail}`, "TRANSPORT");
}

/** HTTP 失败 → LlmError。顺序重要：具体措辞优先于泛化兜底。 */
async function httpFailure(response) {
	const text = await response.text().catch(() => "");
	const summary = `HTTP ${response.status}${text.length > 0 ? `: ${text.slice(0, 300)}` : ""}`;
	const status = response.status;
	const retryAfter = response.headers.get("retry-after");
	const seconds = retryAfter === null ? Number.NaN : Number(retryAfter);
	const options = {
		status,
		...(Number.isFinite(seconds) && seconds > 0 ? { providerRetryAfterMs: seconds * 1000 } : {}),
	};

	if (status === 401 || status === 403) return new LlmError(`CHANGE_ME rejected the credential (${summary})`, "AUTH", options);
	if (status === 429) return new LlmError(`CHANGE_ME rate limited the request (${summary})`, "RATE_LIMIT", options);
	if (status >= 500) return new LlmError(`CHANGE_ME failed (${summary})`, "SERVER", options);
	if (isContextWindowExceededError(text) || OVERFLOW_PATTERN.test(text)) {
		return new LlmError(`CHANGE_ME rejected the prompt as too long (${summary})`, CONTEXT_WINDOW_EXCEEDED_CODE, options);
	}
	if (isQuotaExceededError(text)) return new LlmError(`CHANGE_ME quota exhausted (${summary})`, QUOTA_EXCEEDED_CODE, options);
	return new LlmError(`CHANGE_ME rejected the request (${summary})`, "INVALID_REQUEST", options);
}

/** 把 harness 消息投影成上游格式。实测过的角色映射写在这里。 */
function buildMessages(messages) {
	const out = [];
	for (const message of messages) {
		if (message === null || typeof message !== "object") continue;
		const role = message.role;

		// developer 在上游 role 白名单外时必须降级为 system。
		if (role === "developer" || role === "system") {
			const text = textOf(message.content);
			if (text.length > 0) out.push({ role: "system", content: text });
			continue;
		}

		if (role === "assistant") {
			const content = Array.isArray(message.content) ? message.content : [];
			const entry = { role: "assistant", content: textOf(content.filter((b) => b?.type === "text")) };
			const reasoning = textOf(content.filter((b) => b?.type === "reasoning"));
			if (reasoning.length > 0) entry.reasoning_content = reasoning;
			const calls = content.filter((b) => b?.type === "tool-call").map((b) => ({
				id: b.id,
				type: "function",
				function: { name: b.name, arguments: typeof b.arguments === "string" ? b.arguments : "" },
			}));
			if (calls.length > 0) entry.tool_calls = calls;
			out.push(entry);
			continue;
		}

		// 上游原生接受 role:"tool" + tool_call_id 时不要重写成 user。
		if (role === "tool") {
			out.push({
				role: "tool",
				...(typeof message.toolCallId === "string" ? { tool_call_id: message.toolCallId } : {}),
				content: textOf(message.content),
			});
			continue;
		}

		out.push({ role: "user", content: textOf(message.content) });
	}
	return out;
}

function textOf(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("");
}

function buildRequestBody(options) {
	const messages = [];
	if (typeof options.system === "string" && options.system.length > 0) {
		messages.push({ role: "system", content: options.system });
	}
	messages.push(...buildMessages(Array.isArray(options.messages) ? options.messages : []));

	const body = { model: options.model, messages, stream: true, max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS };
	if (Number.isFinite(options.temperature)) body.temperature = options.temperature;
	if (Array.isArray(options.stop) && options.stop.length > 0) body.stop = [...options.stop];
	if (typeof options.reasoningEffort === "string" && options.reasoningEffort.length > 0) {
		body.reasoning_effort = options.reasoningEffort;
	}

	const tools = (Array.isArray(options.tools) ? options.tools : []).filter((t) => t && typeof t.name === "string" && t.name.length > 0);
	if (tools.length > 0) {
		body.tools = tools.map((tool) => ({
			type: "function",
			function: {
				name: tool.name,
				...(typeof tool.description === "string" && tool.description.length > 0 ? { description: tool.description } : {}),
				...(tool.parameters === undefined ? {} : { parameters: tool.parameters }),
			},
		}));
		body.tool_choice = "auto";
	}
	return body;
}

/** 逐帧产出 SSE 的 data 载荷；统一去掉裸 CR，使 \r\n\r\n 与 \n\n 一致。 */
async function* sseFrames(body) {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true }).replace(/\r/g, "");
			let boundary = buffer.indexOf("\n\n");
			while (boundary !== -1) {
				const payload = dataPayload(buffer.slice(0, boundary));
				buffer = buffer.slice(boundary + 2);
				if (payload !== undefined) yield payload;
				boundary = buffer.indexOf("\n\n");
			}
		}
		buffer += decoder.decode().replace(/\r/g, "");
		const payload = dataPayload(buffer);
		if (payload !== undefined) yield payload;
	} finally {
		try { await reader.cancel(); } catch { /* 已经结束 */ }
	}
}

function dataPayload(frame) {
	const parts = [];
	for (const line of frame.split("\n")) {
		if (line.startsWith("data:")) parts.push(line.slice(5).replace(/^ /, ""));
	}
	return parts.length === 0 ? undefined : parts.join("\n");
}

/** 上游 finish_reason → harness finish kind。 */
function finishKind(reason) {
	if (reason === "length") return "max-tokens";
	if (reason === "tool_calls" || reason === "function_call") return "tool-calls";
	return "stop";
}

export class CHANGE_ME_Adapter extends LlmAdapter {
	#credentialStore;
	#models;

	constructor(options) {
		super();
		this.#credentialStore = options.credentialStore;
		this.#models = options.models;
	}

	/** id 必须严格等于 provider，否则注册期抛 INVALID_ADAPTER。 */
	providerInfo(provider) {
		return { id: provider, name: PROVIDER_NAME };
	}

	async listModels(provider) {
		return this.#models().map((spec) => ({
			provider,
			id: spec.id,
			name: spec.name,
			inputModalities: ["text"],
		}));
	}

	/** 不设 defaultEffort：不显式请求时不发 reasoning_effort，最贴近宿主应用本体。 */
	async resolveModel(provider, model) {
		const spec = this.#models().find((row) => row.id === model);
		const info = {
			provider,
			id: model,
			name: spec?.name ?? model,
			context: { contextWindow: spec?.contextWindow ?? FALLBACK_CONTEXT_WINDOW },
			defaultMaxTokens: DEFAULT_MAX_TOKENS,
			// 声明 text 后运行时会把图片换成文本占位符，而不是发出去吃 400。
			inputModalities: ["text"],
			// 上游接受中段 system 消息时才可声明。
			systemPromptUpdate: "in-history",
		};
		if (spec === undefined || spec.efforts.length === 0) return info;
		return { ...info, reasoning: { efforts: spec.efforts.map((id) => ({ id, name: id })) } };
	}

	/** 凭据失败一律转成 INVALID_CREDENTIAL，提示用户重新登录宿主应用。 */
	async #credentials() {
		try {
			return await this.#credentialStore().resolve();
		} catch (error) {
			if (error instanceof CHANGE_ME_Error) {
				throw new LlmError(`CHANGE_ME credential unavailable (${error.code}): ${error.message}`, INVALID_CREDENTIAL_CODE);
			}
			const detail = error instanceof Error ? error.message : String(error);
			throw new LlmError(`CHANGE_ME credential unavailable: ${detail}`, INVALID_CREDENTIAL_CODE);
		}
	}

	async *stream(options) {
		const credential = await this.#credentials();
		let response;
		try {
			response = await fetch(`${credential.baseUrl}/chat/completions`, {
				method: "POST",
				headers: {
					...attributionHeaders(),            // 契约要求：每个 provider 请求都要带
					"content-type": "application/json",
					accept: "text/event-stream",
					authorization: credential.authorization,
				},
				body: JSON.stringify(buildRequestBody(options)),
				...(options.signal === undefined ? {} : { signal: options.signal }),
			});
		} catch (error) {
			throw transportFailure(error, options.signal);
		}
		if (!response.ok) throw await httpFailure(response);
		if (response.body === null) throw new LlmError("CHANGE_ME returned an empty body", "TRANSPORT");
		try {
			yield* this.#translate(response.body, options.signal);
		} catch (error) {
			if (error instanceof LlmError) throw error;   // 已有稳定 code 的原样抛出
			throw transportFailure(error, options.signal);
		}
	}

	/**
	 * 上游 SSE → harness StreamChunk。
	 * finish 必须缓冲到流末尾：网关常把 usage 放在 finish_reason 之后的 choices:[] 帧里，
	 * 而协议要求 usage 早于 finish。
	 */
	async *#translate(body, signal) {
		const order = [];
		const byIndex = new Map();
		let usageFrame;
		let finishReason;

		const ensure = (index, blockType) => {
			let entry = byIndex.get(index);
			if (entry !== undefined) return { entry, started: false };
			entry = { index, blockType, text: "", id: undefined, name: undefined, args: "" };
			byIndex.set(index, entry);
			order.push(entry);
			return { entry, started: true };
		};

		for await (const payload of sseFrames(body)) {
			signal?.throwIfAborted();
			if (payload === "[DONE]") break;
			let frame;
			try { frame = JSON.parse(payload); } catch { continue; }
			if (frame === null || typeof frame !== "object") continue;

			// 末帧形状：{choices: [], usage: {...}}
			if (frame.usage !== null && typeof frame.usage === "object") usageFrame = frame.usage;

			const choice = Array.isArray(frame.choices) ? frame.choices[0] : undefined;
			if (choice === null || choice === undefined) continue;
			if (typeof choice.finish_reason === "string" && choice.finish_reason.length > 0) {
				finishReason = choice.finish_reason;
			}

			const delta = choice.delta;
			if (delta === null || typeof delta !== "object") continue;

			// reasoning_content 常是 delta 的兄弟字段，不是 content 数组里的块。
			if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
				const { entry, started } = ensure(REASONING_INDEX, "reasoning");
				if (started) yield { type: "block-start", index: REASONING_INDEX, blockType: "reasoning" };
				entry.text += delta.reasoning_content;
				yield { type: "reasoning-delta", index: REASONING_INDEX, text: delta.reasoning_content };
			}

			if (typeof delta.content === "string" && delta.content.length > 0) {
				const { entry, started } = ensure(TEXT_INDEX, "text");
				if (started) yield { type: "block-start", index: TEXT_INDEX, blockType: "text" };
				entry.text += delta.content;
				yield { type: "text-delta", index: TEXT_INDEX, text: delta.content };
			}

			if (Array.isArray(delta.tool_calls)) {
				for (const call of delta.tool_calls) {
					if (call === null || typeof call !== "object") continue;
					const slot = Number.isInteger(call.index) && call.index >= 0 ? call.index : 0;
					const index = TOOL_INDEX_BASE + slot;
					const { entry, started } = ensure(index, "tool-call");
					if (started) yield { type: "block-start", index, blockType: "tool-call" };
					if (typeof call.id === "string") entry.id = call.id;
					if (typeof call.function?.name === "string") entry.name = call.function.name;
					const args = typeof call.function?.arguments === "string" ? call.function.arguments : "";
					entry.args += args;
					yield { type: "tool-call-delta", index, id: entry.id, name: entry.name, argumentsDelta: args };
				}
			}
		}

		for (const entry of order) {
			if (entry.blockType === "text") {
				yield { type: "block-end", index: entry.index, block: { type: "text", text: entry.text } };
			} else if (entry.blockType === "reasoning") {
				yield { type: "block-end", index: entry.index, block: { type: "reasoning", text: entry.text } };
			} else {
				yield {
					type: "block-end",
					index: entry.index,
					block: { type: "tool-call", id: entry.id ?? `call-${entry.index}`, name: entry.name ?? "", arguments: entry.args },
				};
			}
		}

		if (usageFrame !== undefined) yield { type: "usage", usage: normalizeUsage(usageFrame) };
		yield { type: "finish", reason: { kind: finishKind(finishReason) } };
	}
}

/** 上游 usage → harness usage。缺字段时给 0 而不是 undefined。 */
function normalizeUsage(usage) {
	const input = Number.isInteger(usage.prompt_tokens) ? usage.prompt_tokens : 0;
	const output = Number.isInteger(usage.completion_tokens) ? usage.completion_tokens : 0;
	const total = Number.isInteger(usage.total_tokens) ? usage.total_tokens : input + output;
	const cached = usage.prompt_tokens_details?.cached_tokens;
	return {
		inputTokens: input,
		outputTokens: output,
		totalTokens: total,
		...(Number.isInteger(cached) ? { cacheReadTokens: cached } : {}),
	};
}

/** 只有 volatile 字段会出现在 Web 设置表单里，也只有它们能被界面写入。 */
export const Config = z.object({
	installRoot: asVolatile(z.string().description("宿主应用安装根目录，留空自动探测")),
	enabledModelIds: asVolatile(z.array(z.string()).default([]).description("启用的模型 id 白名单，留空表示全部实测可用模型")),
	contextBudgets: z.dict(z.number().step(1).min(1)).default({}).description("按模型 id 覆盖上下文窗口"),
});

export function apply(ctx, config) {
	const settingsNs = settingsNamespaceOf(ctx);
	const current = () => config;

	// 凭据读取器按配置签名缓存，既保留 mtime 自愈，又跟随配置变更。
	let credentialCache = { key: undefined, store: undefined };
	const credentialStore = () => {
		const live = current();
		const installRoot = unwrapVolatile(live?.installRoot);
		const root = typeof installRoot === "string" && installRoot.length > 0 ? installRoot : "";
		if (credentialCache.key !== root) {
			credentialCache = { key: root, store: new CHANGE_ME_Credentials({ installRoot: root || undefined }) };
		}
		return credentialCache.store;
	};

	const configuredModels = () => {
		const enabled = unwrapVolatile(current()?.enabledModelIds);
		const budgets = current()?.contextBudgets ?? {};
		const allow = Array.isArray(enabled) ? enabled : [];
		return MODEL_SPECS.filter((spec) => allow.length === 0 || allow.includes(spec.id)).map((spec) => ({
			...spec,
			contextWindow: Number.isInteger(budgets[spec.id]) ? budgets[spec.id] : spec.contextWindow,
		}));
	};

	const adapter = new CHANGE_ME_Adapter({ credentialStore, models: configuredModels });
	const registration = { adapter: undefined, discovery: undefined, directory: undefined };

	registration.adapter = ctx.llm.registerAdapter([PROVIDER], adapter);
	registration.discovery = ctx.llm.registerModelDiscovery(settingsNs, async (request) => {
		if (typeof request?.provider === "string" && request.provider.length > 0 && request.provider !== PROVIDER) return [];
		return configuredModels().map((spec) => ({
			id: spec.id,
			name: spec.name,
			contextWindow: spec.contextWindow,
			maxTokens: DEFAULT_MAX_TOKENS,
			inputModalities: ["text"],
		}));
	});
	registration.directory = ctx.llm.registerConfigurableProviders([
		{ provider: PROVIDER, displayName: PROVIDER_NAME, settingsNs, settingsPath: [], declared: false },
	]);

	// 声明本 fiber 的 settings 命名空间，让 volatile 字段出现在设置面板里。
	ctx.inject(["settings"], (settingsCtx) => {
		try {
			ctx.effect(() => settingsCtx.settings.configure({ auto: true }, ctx.fiber));
		} catch (error) {
			ctx.logger.warn("dsh-connect-CHANGE_ME: settings namespace unavailable", error);
		}
	});

	ctx.effect(() => () => {
		registration.discovery?.();
		registration.adapter?.();
		registration.directory?.();
	});
}

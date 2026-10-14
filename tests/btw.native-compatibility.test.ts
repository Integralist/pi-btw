import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  InMemoryCredentialStore, InMemoryModelsStore, fauxAssistantMessage, fauxProvider,
} from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import btwExtension from "../extensions/btw";

const { factories, children } = vi.hoisted(() => ({ factories: [] as any[], children: [] as any[] }));
vi.mock("@earendil-works/pi-coding-agent", async () => {
  const sdk = await vi.importActual<any>("@earendil-works/pi-coding-agent");
  return {
    ...sdk,
    createAgentSession: async (options: any) => {
      factories.push(options);
      // Never let an unsupported option silently create a default credentials/runtime fixture.
      if (!options.modelRuntime) throw new Error("BTW factory did not supply its physical modelRuntime");
      const result = await sdk.createAgentSession({
        ...options,
        settingsManager: sdk.SettingsManager.inMemory({
          compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: { enabled: false },
        }),
      });
      children.push(result.session);
      return result;
    },
  };
});

const cleanups: Array<() => Promise<void> | void> = [];
let network: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  factories.length = 0;
  children.length = 0;
  network = vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("Network forbidden in BTW compatibility tests"); });
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const session of children) session.dispose();
  expect(network).not.toHaveBeenCalled();
  network.mockRestore();
});

async function emptyRuntime(credentials = new InMemoryCredentialStore(), modelsPath: string | null = null) {
  const runtime = await ModelRuntime.create({ credentials, modelsPath, modelsStore: new InMemoryModelsStore(), refreshOnCreate: false, allowModelNetwork: false });
  for (const provider of runtime.getProviders()) {
    runtime.registerNativeProvider({
      id: provider.id, name: provider.id, getModels: () => [],
      auth: { apiKey: { name: "Disabled", resolve: async () => undefined } },
      stream: () => { throw new Error("Builtin stream forbidden"); },
      streamSimple: () => { throw new Error("Builtin stream forbidden"); },
    });
  }
  return runtime;
}

async function harness(options: { modelHeaders?: boolean; requiredAuth?: boolean; collision?: boolean; authMode?: "headers" | "none" } = {}) {
  const sdk = await vi.importActual<any>("@earendil-works/pi-coding-agent");
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("fixture", async () => ({ type: "api_key", key: "fixture-key", env: { FIXTURE_ENV: "parent" } }));
  let modelsPath: string | null = null;
  if (options.modelHeaders || options.requiredAuth) {
    const directory = mkdtempSync(path.join(tmpdir(), "btw-model-auth-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    modelsPath = path.join(directory, "models.json");
    writeFileSync(modelsPath, JSON.stringify({ providers: { fixture: { authHeader: true, ...(options.modelHeaders ? { modelOverrides: {
      a: { headers: { Authorization: "Model selected", "X-Model-Tenant": "tenant-a" } },
      b: { headers: { Authorization: "Model unselected", "X-Model-Tenant": "tenant-b" } },
    } } : {}) } } }));
  }
  const runtime = await emptyRuntime(credentials, modelsPath);
  const faux = fauxProvider({ provider: "fixture", models: [
    { id: "a", reasoning: true, contextWindow: 200000, maxTokens: 2000 },
    { id: "b", reasoning: true, contextWindow: 200000, maxTokens: 2000 },
  ] });
  const models = faux.models.map((m) => ({ ...m, thinkingLevelMap: { xhigh: "xhigh", max: null } }));
  if (options.collision) models.push({ ...models[1], id: "not-auto-backend", name: "not-auto-backend" });
  const requests: any[] = [];
  let rejectSummaryOff = false;
  let failNext = false;
  const requiredModelHeaders = options.modelHeaders;
  const provider = {
    ...faux.provider,
    getModels: () => models,
    auth: { apiKey: {
      name: "Fixture parent credential",
      resolve: async ({ credential }: any) => options.authMode ? ({
        auth: { ...(options.authMode === "headers" ? { headers: { "X-Parent": "yes" } } : {}), baseUrl: "https://fixture.invalid/parent" },
        env: { FIXTURE_ENV: "parent" },
      }) : credential?.key ? ({
        auth: { apiKey: credential.key, headers: { Authorization: `Bearer ${credential.key}`, "X-Parent": "yes" }, baseUrl: `https://fixture.invalid/${credential.env.FIXTURE_ENV}` },
        env: credential.env,
      }) : undefined,
    } },
    streamSimple: (model: any, context: any, options: any) => {
      requests.push({ model, context: JSON.parse(JSON.stringify(context)), options });
      const missingHeaders = requiredModelHeaders && (options?.headers?.Authorization !== "Model selected" || options?.headers?.["X-Model-Tenant"] !== "tenant-a");
      faux.setResponses([fauxAssistantMessage(
        failNext || missingHeaders ? "" : "fixture answer",
        failNext || missingHeaders || (rejectSummaryOff && !options?.reasoning)
          ? { stopReason: "error", errorMessage: failNext ? "fixture hard failure" : missingHeaders ? "Missing chosen model auth/tenant headers" : "Thinking off unsupported" }
          : {},
      )]);
      failNext = false;
      return faux.provider.streamSimple(model, context, options);
    },
  };
  runtime.registerNativeProvider(provider);
  await runtime.refresh({ allowNetwork: false });
  const registry = new ModelRegistry(runtime);
  const auth = vi.spyOn(registry, "getApiKeyAndHeaders");
  const manager = SessionManager.inMemory(process.cwd());
  manager.appendMessage({ role: "user", content: "parent context sentinel", timestamp: 1 });
  const commands = new Map<string, any>();
  const handlers = new Map<string, any[]>();
  const notices: string[] = [];
  const sent: string[] = [];
  let selected: any = models[0];
  let effort = "high";
  let overlay: any;
  const api = {
    on: (name: string, fn: any) => handlers.set(name, [...(handlers.get(name) ?? []), fn]),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerShortcut: () => {}, registerMessageRenderer: () => {},
    appendEntry: (name: string, data: any) => manager.appendCustomEntry(name, data),
    getThinkingLevel: () => effort,
    setModel: vi.fn(), setThinkingLevel: vi.fn(),
    sendUserMessage: (content: string) => sent.push(content), sendMessage: () => {},
  };
  const ctx: any = {
    cwd: process.cwd(), mode: "tui", hasUI: true, sessionManager: manager, modelRegistry: registry,
    get model() { return selected; }, isIdle: () => true, getSystemPrompt: () => "Parent system instructions",
    ui: {
      notify: (text: string) => notices.push(text), setWidget: () => {},
      custom: async (factory: any, options: any) => {
        let focused = true;
        const handle = { focus: () => { focused = true; }, unfocus: () => { focused = false; }, isFocused: () => focused, setHidden: () => {}, hide: () => {} };
        options.onHandle(handle);
        const theme = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text, bold: (s: string) => s, italic: (s: string) => s };
        overlay = await factory({ requestRender: () => {} }, theme, { matches: () => false }, () => {});
        return new Promise(() => {});
      },
    },
  };
  btwExtension(api as any);
  const event = async (name: string, data: any = {}) => { for (const fn of handlers.get(name) ?? []) await fn(data, ctx); };
  const command = async (name: string, args = "") => commands.get(name).handler(args, ctx);
  cleanups.push(async () => { overlay?.dispose(); await event("session_shutdown"); });
  await event("session_start");
  const notes = () => manager.getBranch().filter((e: any) => e.type === "custom" && e.customType === "btw-thread-entry").map((e: any) => e.data);
  const nativeVirtual = typeof (runtime as any).registerVirtualModel === "function";
  let routeTarget = models[0];
  let routeCalls = 0;
  async function virtual() {
    (runtime as any).registerVirtualModel({
      provider: "fixture", id: "not-auto", name: "Synthetic only", thinkingLevels: ["low"],
      route: () => { routeCalls++; return { model: routeTarget, thinkingLevel: "high", state: { physicalModel: "fiction", thinkingLevel: "max" } }; },
    });
    selected = registry.find("fixture", "not-auto");
    effort = "low";
  }
  async function routeParent() {
    const { session } = await sdk.createAgentSession({
      cwd: ctx.cwd, modelRuntime: runtime, model: selected, thinkingLevel: effort,
      sessionManager: manager, tools: [],
      settingsManager: sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
      resourceLoader: {
        getExtensions: () => ({ extensions: [], errors: [], runtime: sdk.createExtensionRuntime() }),
        getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
        getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
        getSystemPrompt: () => "Main fixture", getSystemPromptSource: () => undefined,
        getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources: () => {}, reload: async () => {},
      },
    });
    await session.prompt("main route fixture");
    session.dispose();
  }
  return {
    runtime, registry, manager, models, requests, notices, sent, auth, api, ctx, event, command, notes,
    async rotate() { await credentials.modify("fixture", async () => ({ type: "api_key", key: "rotated-key", env: { FIXTURE_ENV: "rotated" } })); },
    async revoke() { await credentials.delete("fixture"); },
    virtual, routeParent, nativeVirtual, getRouteCalls: () => routeCalls,
    setParent(model: any, thinking: string) { selected = model; effort = thinking; },
    setRoute(model: any) { routeTarget = model; },
    rejectOff() { rejectSummaryOff = true; }, fail() { failNext = true; },
    header() { overlay.refresh(); return overlay.render(120).join("\n"); },
    async submit(text: string) { overlay.input.onSubmit(text); await vi.waitFor(() => { expect(overlay.getTranscriptEntries().length).toBeGreaterThan(0); }); },
    getOverlay: () => overlay,
  };
}

const nativeVirtual = typeof (ModelRuntime.prototype as any).registerVirtualModel === "function";

function textAtProvider(request: any): string {
  return JSON.stringify(request.context);
}
function expectChosenRuntime(model: any, index = 0) {
  const options = factories[index];
  expect("modelRegistry" in options).toBe(false);
  expect(options.modelRuntime.getModels()).toEqual([model]);
  expect(options.modelRuntime.getModels().every((m: any) => m.api !== "pi-virtual")).toBe(true);
  expect(options.resourceLoader.getExtensions().extensions).toEqual([]);
  expect(options.resourceLoader.getSystemPromptSource()).toBeUndefined();
  expect(options.resourceLoader.getAppendSystemPromptSources()).toEqual([]);
}

describe("BTW public SDK physical child contract (offline; no Auto)", () => {
  it("uses an isolated runtime with parent-only credential/auth, custom transport, canonical seed and clamped identity", async () => {
    const h = await harness();
    h.setParent(h.models[0], "max");
    await h.command("btw", "first child question");
    expect(h.requests).toHaveLength(1);
    expectChosenRuntime(h.models[0]);
    expect(h.auth).toHaveBeenCalledWith(h.models[0]);
    const request = h.requests[0];
    expect(request.options).toMatchObject({ apiKey: "fixture-key", headers: { Authorization: "Bearer fixture-key", "X-Parent": "yes" }, env: { FIXTURE_ENV: "parent" }, reasoning: "xhigh" });
    expect(request.model.baseUrl).toBe("https://fixture.invalid/parent");
    expect(textAtProvider(request)).toContain("parent context sentinel");
    expect(textAtProvider(request)).toContain("thinking level xhigh");
    expect(h.header()).toContain("fixture/a · thinking: xhigh");
    expect(h.notes()[0]).toMatchObject({ provider: "fixture", model: "a", thinkingLevel: "xhigh" });
    expect(h.notes()[0].usage).toEqual(children[0].state.messages.filter((m: any) => m.role === "assistant").at(-1).usage);
    expect(h.api.setModel).not.toHaveBeenCalled();
    expect(h.api.setThinkingLevel).not.toHaveBeenCalled();
    // Neither a default provider nor an arbitrary model can escape the prepared physical catalog.
    expect(await factories[0].modelRuntime.getAuth("openai")).toBeUndefined();
    const bad = await factories[0].modelRuntime.completeSimple({ ...h.models[0], id: "unselected" }, { messages: [] });
    expect(bad.stopReason).toBe("error");
    expect(h.requests).toHaveLength(1);
  });

  it("preserves explicit effort independently through physical override, clear and summary retry", async () => {
    const h = await harness();
    h.rejectOff();
    await h.command("btw", "--model fixture/b --thinking low first");
    expect(h.notes()[0]).toMatchObject({ model: "b", thinkingLevel: "low" });
    await h.command("btw:summarize");
    expect(factories).toHaveLength(3);
    expect(factories.slice(1).map((f) => f.model.id)).toEqual(["b", "b"]);
    expect(factories.slice(1).map((f) => f.thinkingLevel)).toEqual(["off", "low"]);
    expect(factories.slice(1).every((f) => f.tools.length === 0)).toBe(true);
    expectChosenRuntime(factories[1].model, 1);
    expect(h.sent).toHaveLength(1);
    await h.command("btw", "--model clear --thinking clear second");
    expect(h.notes().at(-1)).toMatchObject({ model: "a", thinkingLevel: "high" });
  });

  it("feeds restored hidden history to the actual provider, excludes visible notes and omits parent seed for tangents", async () => {
    const h = await harness();
    h.manager.appendCustomEntry("btw-thread-entry", { question: "restored question", answer: "restored answer", thinking: "", provider: "fixture", model: "a", api: h.models[0].api, thinkingLevel: "high", timestamp: 2 });
    h.manager.appendCustomMessageEntry("btw-note", "visible note forbidden", true);
    await h.event("session_tree");
    await h.command("btw", "restored followup");
    expect(textAtProvider(h.requests[0])).toContain("restored question");
    expect(textAtProvider(h.requests[0])).toContain("restored answer");
    expect(textAtProvider(h.requests[0])).not.toContain("visible note forbidden");
    await h.command("btw:tangent", "separate tangent");
    expect(textAtProvider(h.requests[1])).not.toContain("parent context sentinel");
    expect(textAtProvider(h.requests[1])).not.toContain("restored question");
  });

  it("retains child pair and labels when main physical selection changes", async () => {
    const h = await harness();
    await h.command("btw", "one");
    h.setParent(h.models[1], "low");
    await h.event("model_select", { model: h.models[1] });
    await h.command("btw", "two");
    expect(factories).toHaveLength(1);
    expect(h.requests.map((r) => [r.model.id, r.options.reasoning])).toEqual([["a", "high"], ["a", "high"]]);
    expect(h.notes().map((n: any) => [n.model, n.thinkingLevel])).toEqual([["a", "high"], ["a", "high"]]);
    expect(h.header()).toContain("fixture/a · thinking: high");
    expect(h.header()).not.toContain("fixture/b");
  });

  it("surfaces native provider failure, saves no success metadata and keeps the thread recoverable", async () => {
    const h = await harness();
    await h.command("btw", "successful first");
    h.fail();
    await h.command("btw", "failed second");
    expect(h.notices.join("\n")).toContain("fixture hard failure");
    expect(h.notes()).toHaveLength(1);
    await h.command("btw", "retry after failure");
    expect(h.notes()).toHaveLength(2);
    expect(textAtProvider(h.requests.at(-1))).toContain("successful first");
  });
});

describe.skipIf(!nativeVirtual)("BTW native 1.2 generic virtual caller contract", () => {
  it("inherits successful active-branch physical metadata and its matching effort, not virtual input or opaque state", async () => {
    const h = await harness();
    await h.virtual();
    await h.routeParent();
    expect(h.getRouteCalls()).toBe(1);
    const physical = h.manager.getBranch().filter((e: any) => e.type === "message" && e.message.role === "assistant").at(-1) as any;
    expect(physical.message).toMatchObject({ provider: "fixture", model: "a", thinkingLevel: "high" });
    const failed = { ...fauxAssistantMessage("failed", { stopReason: "error" }), provider: "fixture", model: "b", api: h.models[1].api, thinkingLevel: "low" };
    h.manager.appendMessage(failed as any);
    h.manager.appendMessage({ ...failed, stopReason: "aborted" } as any);
    await h.command("btw", "native child");
    expect(factories[0].model.id).toBe("a");
    expect(factories[0].thinkingLevel).toBe("high");
    expectChosenRuntime(factories[0].model);
    expect(h.getRouteCalls()).toBe(1);
    expect(h.ctx.model.api).toBe("pi-virtual");
    expect(h.api.getThinkingLevel()).toBe("low");
    expect(h.notes()[0]).toMatchObject({ model: "a", thinkingLevel: "high" });
    expect(h.header()).not.toContain("not-auto");
  });

  it("selected physical/current effort wins over older successful routed evidence", async () => {
    const h = await harness(); await h.virtual(); await h.routeParent();
    h.setParent(h.models[1], "xhigh");
    await h.command("btw", "physical selection");
    expect(factories[0]).toMatchObject({ model: { id: "b" }, thinkingLevel: "xhigh" });
  });

  it("ignores abandoned-branch, failed and aborted responses; unknown fails before auth/factory and explicit pair recovers", async () => {
    const h = await harness();
    const fork = h.manager.getLeafId()!;
    await h.virtual(); await h.routeParent();
    h.manager.branch(fork);
    const response = { ...fauxAssistantMessage("failed", { stopReason: "error" }), provider: "fixture", model: "a", api: h.models[0].api, thinkingLevel: "high" };
    h.manager.appendMessage(response as any);
    h.manager.appendMessage({ ...response, stopReason: "aborted" } as any);
    const authBefore = h.auth.mock.calls.length;
    await h.command("btw", "unknown route");
    expect(factories).toHaveLength(0);
    expect(h.auth.mock.calls).toHaveLength(authBefore);
    expect(h.notices.join("\n")).toContain("physical model and thinking level");
    expect(h.header()).toContain("pending physical settings");
    await h.command("btw", "--thinking high still unknown");
    expect(factories).toHaveLength(0);
    await h.command("btw", "--model fixture/b --thinking xhigh explicit recovery");
    expect(h.notes()[0]).toMatchObject({ model: "b", thinkingLevel: "xhigh" });
    expect(h.getRouteCalls()).toBe(1);
  });

  it("requires an explicit physical effort for an unknown route even with a physical model override", async () => {
    const h = await harness(); await h.virtual();
    await h.command("btw", "--model fixture/b missing effort");
    expect(factories).toHaveLength(0);
    expect(h.requests).toHaveLength(0);
    await h.command("btw", "--thinking high explicit effort");
    expect(h.notes()[0]).toMatchObject({ model: "b", thinkingLevel: "high" });
    await h.command("btw", "--thinking clear cannot reuse virtual effort");
    expect(factories).toHaveLength(1);
    expect(h.requests).toHaveLength(1);
    expect(h.notices.at(-1)).toContain("physical model and thinking level");
  });

  it.each(["missing-model", "missing-effort"])("does not borrow effort/evidence from another response: %s", async (kind) => {
    const h = await harness(); await h.virtual(); await h.routeParent();
    h.manager.appendMessage({ ...fauxAssistantMessage("newer"), provider: "fixture", model: kind === "missing-model" ? "missing" : "b", api: h.models[0].api, ...(kind === "missing-model" ? { thinkingLevel: "high" } : {}) } as any);
    await h.command("btw", "unknown metadata");
    expect(factories).toHaveLength(0);
    expect(h.notices.join("\n")).toContain("physical model and thinking level");
  });

  it("rejects virtual flag, natural-language, configure_btw and restored overrides without auth or provider work", async () => {
    const h = await harness(); await h.virtual();
    const before = h.auth.mock.calls.length;
    await h.command("btw", "--model fixture/not-auto --thinking high forbidden");
    expect(factories).toHaveLength(0);
    expect(h.auth.mock.calls).toHaveLength(before);
    expect(h.notices.join("\n")).toContain("physical model");
    await h.command("btw", "--model fixture/a --thinking high permitted");
    const count = h.requests.length;
    h.getOverlay().input.onSubmit("switch to fixture/not-auto");
    await vi.waitFor(() => expect(h.notices.at(-1)).toContain("physical model"));
    expect(h.requests).toHaveLength(count);
    const tool = factories[0].customTools.find((t: any) => t.name === "configure_btw");
    const result = await tool.execute("test", { model: "fixture/not-auto" });
    expect(result.isError).toBe(true);
    expect(h.requests).toHaveLength(count);
    h.manager.appendCustomEntry("btw-model-override", { action: "set", provider: "fixture", id: "not-auto", api: "pi-virtual", timestamp: 3 });
    await h.event("session_tree");
    await h.command("btw", "restored virtual denied");
    expect(factories).toHaveLength(1);
    expect(h.requests).toHaveLength(count);
    await h.command("btw", "--model fixture/b --thinking low recovered");
    expect(h.notes().at(-1)).toMatchObject({ model: "b", thinkingLevel: "low" });
  });

  it("preserves credential fallback to the physical parent pair but blocks an unknown fallback", async () => {
    const h = await harness(); await h.virtual(); await h.routeParent();
    const absent = { ...h.models[1], provider: "unconfigured", id: "unavailable" };
    h.runtime.registerProvider("unconfigured", {
      authHeader: true, api: absent.api,
      models: [absent],
      streamSimple: () => { throw new Error("Unconfigured provider must not stream"); },
    });
    expect(await h.registry.getApiKeyAndHeaders(absent)).toMatchObject({ ok: false });
    await h.command("btw", "--model unconfigured/unavailable --thinking low known fallback");
    expect(h.notes()[0]).toMatchObject({ model: "a", thinkingLevel: "low" });
    expect(h.header()).toContain("fixture/a · thinking: low");
    expect(h.header()).not.toContain("unavailable");
    const root = h.manager.getBranch()[0].id;
    h.manager.branch(root);
    await h.event("session_tree");
    await h.command("btw", "--model unconfigured/unavailable --thinking high unknown fallback");
    expect(factories).toHaveLength(1);
    expect(h.notices.join("\n")).toContain("physical model and thinking level");
  });

  it("does not retarget or relabel child/summary when main routing changes or later has no physical evidence", async () => {
    const h = await harness(); await h.virtual(); await h.routeParent();
    await h.command("btw", "first child");
    h.setRoute(h.models[1]); await h.routeParent();
    await h.command("btw", "second child");
    expect(factories).toHaveLength(1);
    expect(h.notes().map((n: any) => n.model)).toEqual(["a", "a"]);
    // A new unknown virtual selection must not prevent continuing the pinned child.
    h.setParent({ ...h.ctx.model, id: "unknown-virtual" }, "low");
    h.registry.find = vi.fn(() => undefined) as any;
    await h.command("btw", "third child");
    expect(h.notes().at(-1)).toMatchObject({ model: "a", thinkingLevel: "high" });
    await h.command("btw:summarize");
    expect(factories[1].model.id).toBe("a");
    expect(factories[1].thinkingLevel).toBe("off");
    expect(h.getRouteCalls()).toBe(2);
    expect(h.sent).toHaveLength(1);
  });

  it("unknown summary fails actionably and preserves restored thread without child/provider work", async () => {
    const h = await harness(); await h.virtual();
    h.manager.appendCustomEntry("btw-thread-entry", { question: "keep", answer: "kept answer", thinking: "", provider: "fixture", model: "a", api: h.models[0].api, thinkingLevel: "high", timestamp: 2 });
    await h.event("session_tree");
    await h.command("btw:summarize");
    expect(factories).toHaveLength(0);
    expect(h.requests).toHaveLength(0);
    expect(h.sent).toHaveLength(0);
    expect(h.notes()).toHaveLength(1);
    expect(h.notices.join("\n")).toContain("physical model and thinking level");
  });
});

describe("BTW assigned auth corrections through the default SDK factory", () => {
  it("preserves model-specific request auth on ordinary chat and both summary attempts, resolving fresh credentials", async () => {
    const h = await harness({ modelHeaders: true });
    const control = await h.runtime.completeSimple(h.models[0], { messages: [{ role: "user", content: "parent auth control", timestamp: 1 }] });
    expect(control.stopReason, control.errorMessage).toBe("stop");
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0].options.headers).toMatchObject({ Authorization: "Model selected", "X-Model-Tenant": "tenant-a", "X-Parent": "yes" });
    h.requests.length = 0;
    await h.command("btw", "model auth ordinary");
    expect(h.requests).toHaveLength(1);
    expect(h.notes()).toHaveLength(1);
    expectChosenRuntime(h.models[0]);
    expect(h.requests[0].options).toMatchObject({ apiKey: "fixture-key", headers: { Authorization: "Model selected", "X-Model-Tenant": "tenant-a", "X-Parent": "yes" }, env: { FIXTURE_ENV: "parent" }, reasoning: "high" });
    expect(h.requests[0].model.baseUrl).toBe("https://fixture.invalid/parent");
    const before = h.auth.mock.calls.length;
    await h.rotate();
    await h.command("btw", "fresh ordinary followup");
    expect(factories).toHaveLength(1);
    expect(h.auth.mock.calls.length).toBeGreaterThan(before);
    h.rejectOff();
    await h.command("btw:summarize");
    expect(factories).toHaveLength(3);
    expect(h.requests).toHaveLength(4);
    expect(h.requests.map(r => [r.model.provider, r.model.id, r.options.reasoning ?? "off"])).toEqual([
      ["fixture", "a", "high"], ["fixture", "a", "high"], ["fixture", "a", "off"], ["fixture", "a", "high"],
    ]);
    for (const request of h.requests.slice(1)) {
      expect(request.options).toMatchObject({ apiKey: "rotated-key", headers: { Authorization: "Model selected", "X-Model-Tenant": "tenant-a", "X-Parent": "yes" }, env: { FIXTURE_ENV: "rotated" } });
      expect(request.model.baseUrl).toBe("https://fixture.invalid/rotated");
    }
    for (const index of [1, 2]) expectChosenRuntime(h.models[0], index);
    expect(h.auth.mock.calls.every(([model]) => model.provider === "fixture" && model.id === "a" && model.api !== "pi-virtual")).toBe(true);
    expect(h.sent).toHaveLength(1);
    expect(h.api.setModel).not.toHaveBeenCalled();
    expect(h.api.setThinkingLevel).not.toHaveBeenCalled();
  });

  it("preserves chosen model auth on restored summary and its off-to-safe-effort retry", async () => {
    const h = await harness({ modelHeaders: true });
    h.manager.appendCustomEntry("btw-thread-entry", { question: "restored auth question", answer: "restored auth answer", thinking: "", provider: "fixture", model: "a", api: h.models[0].api, thinkingLevel: "high", timestamp: 2 });
    await h.event("session_tree");
    h.rejectOff();
    await h.command("btw:summarize");
    expect(h.sent).toHaveLength(1);
    expect(h.requests).toHaveLength(2);
    expect(factories).toHaveLength(2);
    expect(h.requests.map(r => [r.model.id, r.options.reasoning ?? "off"])).toEqual([["a", "off"], ["a", "high"]]);
    for (const request of h.requests) {
      expect(request.options).toMatchObject({ apiKey: "fixture-key", headers: { Authorization: "Model selected", "X-Model-Tenant": "tenant-a", "X-Parent": "yes" }, env: { FIXTURE_ENV: "parent" } });
      expect(request.model.baseUrl).toBe("https://fixture.invalid/parent");
      expect(textAtProvider(request)).toContain("restored auth question");
      expect(textAtProvider(request)).toContain("restored auth answer");
    }
    for (const index of [0, 1]) {
      expectChosenRuntime(h.models[0], index);
      expect(factories[index].tools).toEqual([]);
    }
    expect(h.api.setModel).not.toHaveBeenCalled();
    expect(h.api.setThinkingLevel).not.toHaveBeenCalled();
  });

  it("fails closed at request-time when required chosen-model auth is revoked on a pinned child", async () => {
    const h = await harness({ requiredAuth: true });
    await h.command("btw", "before revocation");
    expect(factories).toHaveLength(1);
    expect(h.requests, h.notices.join("\n")).toHaveLength(1);
    await h.revoke();
    expect(await h.registry.getApiKeyAndHeaders(h.models[0])).toMatchObject({ ok: false });
    const before = h.auth.mock.calls.length;
    await h.command("btw", "after revocation");
    expect(h.requests).toHaveLength(1);
    expect(factories).toHaveLength(1);
    expect(h.notices.join("\n")).toContain('No API key found for "fixture"');
    expect(h.auth.mock.calls.length).toBeGreaterThan(before);
    expect(h.notes()).toHaveLength(1);
    expect(h.sent).toHaveLength(0);
  });

  it.each(["headers", "none"] as const)("retains configured %s auth without requiring an API key", async (authMode) => {
    const h = await harness({ authMode });
    expect(await h.registry.getApiKeyAndHeaders(h.models[0])).toMatchObject({ ok: true, apiKey: undefined });
    await h.command("btw", "keyless ordinary");
    await h.command("btw:summarize");
    expect(factories).toHaveLength(2);
    expect(h.requests).toHaveLength(2);
    for (const request of h.requests) {
      expect(request.options.apiKey).toBeUndefined();
      expect(request.options.env).toEqual({ FIXTURE_ENV: "parent" });
      expect(request.model.baseUrl).toBe("https://fixture.invalid/parent");
      if (authMode === "headers") expect(request.options.headers).toMatchObject({ "X-Parent": "yes" });
      else expect(request.options.headers ?? {}).toEqual({});
    }
    expect(h.sent).toHaveLength(1);
  });
});

describe.skipIf(!nativeVirtual)("BTW assigned generic virtual caller corrections", () => {
  it.each(["flag", "natural", "configure_btw"])("refuses an exact qualified virtual/physical prefix collision via %s, retaining physical matching", async (caller) => {
    const h = await harness({ collision: true }); await h.virtual();
    if (caller !== "flag") await h.command("btw", "--model fixture/a --thinking high physical setup");
    const authBefore = h.auth.mock.calls.length;
    const requestBefore = h.requests.length;
    const factoryBefore = factories.length;
    if (caller === "flag") await h.command("btw", "--model fixture/not-auto --thinking high forbidden collision");
    if (caller === "natural") {
      const noticeBefore = h.notices.length;
      h.getOverlay().input.onSubmit("switch to fixture/not-auto");
      await vi.waitFor(() => expect(h.notices.length).toBeGreaterThan(noticeBefore));
    }
    if (caller === "configure_btw") {
      const tool = factories[0].customTools.find((t: any) => t.name === "configure_btw");
      const result = await tool.execute("collision", { model: "fixture/not-auto" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("physical model");
    } else expect(h.notices.at(-1)).toContain("physical model");
    expect(h.auth.mock.calls).toHaveLength(authBefore);
    expect(h.requests).toHaveLength(requestBefore);
    expect(factories).toHaveLength(factoryBefore);
    expect(h.getRouteCalls()).toBe(0);
    await h.command("btw", "--model fixture/not-auto-backend --thinking low qualified physical");
    expect(h.requests).toHaveLength(requestBefore + 1);
    expect(h.notes().at(-1)).toMatchObject({ model: "not-auto-backend", thinkingLevel: "low" });
    await h.command("btw", "--model backend fuzzy physical remains allowed");
    expect(h.requests).toHaveLength(requestBefore + 2);
    expect(h.notes().at(-1)).toMatchObject({ model: "not-auto-backend", thinkingLevel: "low" });
    expect(h.api.setModel).not.toHaveBeenCalled();
    expect(h.api.setThinkingLevel).not.toHaveBeenCalled();
  });

  it.each(["registered", "modal"])("injects restored saved notes after unknown-summary refusal via %s without constructing a child", async (caller) => {
    const h = await harness(); await h.virtual();
    h.manager.appendCustomEntry("btw-thread-entry", { question: "restored saved question", answer: "restored saved answer", thinking: "", provider: "fixture", model: "a", api: h.models[0].api, thinkingLevel: "high", timestamp: 2 });
    await h.event("session_tree");
    const authBefore = h.auth.mock.calls.length;
    await h.command("btw:summarize");
    expect(factories).toHaveLength(0);
    expect(h.requests).toHaveLength(0);
    expect(h.sent).toHaveLength(0);
    expect(h.notes()).toHaveLength(1);
    expect(h.notices.at(-1)).toContain("physical model and thinking level");
    if (caller === "registered") await h.command("btw:inject", "use saved notes");
    else { h.getOverlay().input.onSubmit("/inject use saved notes"); await vi.waitFor(() => expect(h.sent).toHaveLength(1)); }
    expect(h.sent).toEqual(["Here is a side conversation I had. use saved notes\n\nUser: restored saved question\nAssistant: restored saved answer"]);
    expect(h.auth.mock.calls).toHaveLength(authBefore);
    expect(factories).toHaveLength(0);
    expect(h.requests).toHaveLength(0);
    expect(h.getRouteCalls()).toBe(0);
    expect(h.manager.getBranch().filter((e: any) => e.type === "custom" && e.customType === "btw-thread-reset")).toHaveLength(1);
    await h.command("btw:inject");
    expect(h.sent).toHaveLength(1);
    expect(h.notices.at(-1)).toBe("No BTW thread to inject.");
    await h.command("btw", "fresh unknown must still refuse");
    expect(factories).toHaveLength(0);
    expect(h.requests).toHaveLength(0);
    expect(h.notices.at(-1)).toContain("physical model and thinking level");
  });

  it.each(["corrupt-level", { level: "low" }, ["low"], "", null, undefined].map(thinkingLevel => ({ thinkingLevel })))("treats malformed latest successful effort as unknown, not older/virtual evidence: %j", async ({ thinkingLevel }) => {
    const h = await harness(); await h.virtual(); await h.routeParent();
    h.manager.appendMessage({ ...fauxAssistantMessage("newer malformed success"), provider: "fixture", model: "b", api: h.models[1].api, thinkingLevel } as any);
    const authBefore = h.auth.mock.calls.length;
    await h.command("btw", "malformed latest metadata");
    expect(factories).toHaveLength(0);
    expect(h.requests).toHaveLength(1); // Only the earlier parent control.
    expect(h.auth.mock.calls).toHaveLength(authBefore);
    expect(h.getRouteCalls()).toBe(1);
    expect(h.notices.at(-1)).toContain("physical model and thinking level");
    expect(h.ctx.model.api).toBe("pi-virtual");
    expect(h.api.getThinkingLevel()).toBe("low");
  });

  it.each(["off", "minimal", "low", "max"])("inherits valid latest physical %s effort with actual SDK clamping", async (thinkingLevel) => {
    const h = await harness(); await h.virtual(); await h.routeParent();
    h.manager.appendMessage({ ...fauxAssistantMessage("newer valid success"), provider: "fixture", model: "b", api: h.models[1].api, thinkingLevel } as any);
    await h.command("btw", "valid latest metadata");
    const actual = thinkingLevel === "max" ? "xhigh" : thinkingLevel;
    expect(factories).toHaveLength(1);
    expect(factories[0]).toMatchObject({ model: { id: "b" }, thinkingLevel: actual });
    expectChosenRuntime(h.models[1]);
    expect(h.requests).toHaveLength(2);
    expect(h.requests[1].model.id).toBe("b");
    expect(h.requests[1].options.reasoning ?? "off").toBe(actual);
    expect(h.notes()[0]).toMatchObject({ model: "b", thinkingLevel: actual });
    expect(h.header()).toContain(`fixture/b · thinking: ${actual}`);
    expect(h.getRouteCalls()).toBe(1);
    expect(h.api.setModel).not.toHaveBeenCalled();
    expect(h.api.setThinkingLevel).not.toHaveBeenCalled();
  });
});

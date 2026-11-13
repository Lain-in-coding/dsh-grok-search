(() => {
  // src/core/settings-codec.mjs
  function createSettingsCodec(typeSymbol, jsonSchema) {
    const invalid = () => {
      throw new TypeError("Invalid settings payload.");
    };
    const invalidSchema = () => {
      throw new TypeError("Invalid or unsupported settings schema.");
    };
    const LIMITS = Object.freeze({
      depth: 64,
      nodes: 2e5,
      bytes: 32 * 1024 * 1024,
      schemaDepth: 32,
      schemaNodes: 4096,
      schemaBytes: 1024 * 1024
    });
    const record = (value) => value !== null && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value));
    const json = (value, maxDepth = LIMITS.depth, maxNodes = LIMITS.nodes, maxBytes = LIMITS.bytes) => {
      let nodes = 0, bytes = 0;
      const ancestors = /* @__PURE__ */ new Set();
      const charge = (amount) => {
        bytes += amount;
        if (bytes > maxBytes) invalid();
      };
      const visit = (item, depth) => {
        if (depth > maxDepth || ++nodes > maxNodes) invalid();
        if (item === null || typeof item === "boolean") {
          charge(5);
          return;
        }
        if (typeof item === "string") {
          charge(item.length * 6 + 2);
          return;
        }
        if (typeof item === "number" && Number.isFinite(item)) {
          charge(24);
          return;
        }
        const array = Array.isArray(item);
        if (!(array ? Object.getPrototypeOf(item) === Array.prototype : record(item)) || ancestors.has(item)) invalid();
        if (array && item.length > maxNodes - nodes) invalid();
        const keys = Reflect.ownKeys(item);
        if (array && keys.length !== item.length + 1 || !array && keys.length > maxNodes - nodes) invalid();
        charge(2 + keys.length);
        ancestors.add(item);
        for (const key of keys) {
          if (array && key === "length") continue;
          if (typeof key !== "string" || array && !/^(0|[1-9]\d*)$/.test(key)) invalid();
          const property = Object.getOwnPropertyDescriptor(item, key);
          if (!property.enumerable || !Object.hasOwn(property, "value")) invalid();
          if (!array) charge(key.length * 6 + 3);
          visit(property.value, depth + 1);
        }
        ancestors.delete(item);
      };
      visit(value, 0);
    };
    const keywords = /* @__PURE__ */ new Set([
      "type",
      "anyOf",
      "enum",
      "properties",
      "required",
      "additionalProperties",
      "items",
      "minimum",
      "maximum",
      "minLength",
      "maxLength",
      "pattern",
      "minItems",
      "maxItems"
    ]);
    const typeNames = /* @__PURE__ */ new Set(["null", "boolean", "number", "integer", "string", "array", "object"]);
    try {
      json(jsonSchema, LIMITS.schemaDepth, LIMITS.schemaNodes, LIMITS.schemaBytes);
    } catch {
      invalidSchema();
    }
    const schemaCopy = structuredClone(jsonSchema);
    let schemaNodes = 0;
    const compile = (schema, depth = 0) => {
      if (depth > LIMITS.schemaDepth || ++schemaNodes > LIMITS.schemaNodes) invalidSchema();
      if (!record(schema) || Object.keys(schema).some((key) => !keywords.has(key))) invalidSchema();
      const has = (key) => Object.hasOwn(schema, key);
      const types = has("type") ? Array.isArray(schema.type) ? schema.type : [schema.type] : null;
      if (types && (!types.length || types.some((type) => !typeNames.has(type)) || new Set(types).size !== types.length)) invalidSchema();
      let alternatives;
      if (has("anyOf")) {
        if (!Array.isArray(schema.anyOf) || !schema.anyOf.length) invalidSchema();
        alternatives = schema.anyOf.map((alternative) => compile(alternative, depth + 1));
      }
      let choices;
      if (has("enum")) {
        if (!Array.isArray(schema.enum) || !schema.enum.length || schema.enum.some((value) => value !== null && typeof value === "object")) invalidSchema();
        choices = new Set(schema.enum);
        if (choices.size !== schema.enum.length) invalidSchema();
      }
      if (has("properties") && !record(schema.properties)) invalidSchema();
      const properties = new Map(Object.entries(schema.properties ?? {}).map(([key, value]) => [key, compile(value, depth + 1)]));
      const required = has("required") ? schema.required : [];
      if (!Array.isArray(required) || required.some((key) => typeof key !== "string") || new Set(required).size !== required.length) invalidSchema();
      const additional = has("additionalProperties") ? schema.additionalProperties : true;
      if (typeof additional !== "boolean") invalidSchema();
      const items = has("items") ? compile(schema.items, depth + 1) : null;
      for (const key of ["minimum", "maximum"]) {
        if (has(key) && (typeof schema[key] !== "number" || !Number.isFinite(schema[key]) || !Number.isSafeInteger(schema[key] * 1e6))) invalidSchema();
      }
      for (const key of ["minLength", "maxLength", "minItems", "maxItems"]) {
        if (has(key) && (!Number.isSafeInteger(schema[key]) || schema[key] < 0)) invalidSchema();
      }
      let pattern;
      if (has("pattern")) {
        if (typeof schema.pattern !== "string") invalidSchema();
        if (schema.pattern.length > 4096 || has("maxLength") && schema.maxLength > 256) invalidSchema();
        try {
          pattern = new RegExp(schema.pattern, "u");
        } catch {
          invalidSchema();
        }
      }
      return (value, budget) => {
        if (++budget.steps > 1e6) invalid();
        const kind = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
        if (types && !types.includes(kind) && !(kind === "number" && Number.isInteger(value) && types.includes("integer"))) return false;
        if (choices && !choices.has(value)) return false;
        if (alternatives && !alternatives.some((validate2) => validate2(value, budget))) return false;
        if (kind === "number" && (value < (has("minimum") ? schema.minimum : -Infinity) || value > (has("maximum") ? schema.maximum : Infinity))) return false;
        if (kind === "string") {
          if (has("minLength") || has("maxLength")) {
            const maximum = has("maxLength") ? schema.maxLength : Infinity;
            let length = 0;
            for (const character of value) {
              length++;
              if (length > maximum) return false;
            }
            if (length < (has("minLength") ? schema.minLength : 0)) return false;
          }
          if (pattern && !pattern.test(value)) return false;
        }
        if (kind === "object") {
          if (required.some((key) => !Object.hasOwn(value, key))) return false;
          for (const key of Object.keys(value)) {
            const validate2 = properties.get(key);
            if (validate2 ? !validate2(value[key], budget) : !additional) return false;
          }
        }
        if (kind === "array") {
          if (value.length < (has("minItems") ? schema.minItems : 0) || value.length > (has("maxItems") ? schema.maxItems : Infinity)) return false;
          if (items && !value.every((item) => items(item, budget))) return false;
        }
        return true;
      };
    };
    const validate = compile(schemaCopy);
    const parse = (value) => {
      json(value);
      if (!validate(value, { steps: 0 })) invalid();
      return value;
    };
    const parser = Object.freeze({ parse, safeParse(value) {
      try {
        return { success: true, data: parse(value) };
      } catch (error) {
        return { success: false, error };
      }
    } });
    return Object.freeze({
      mode: "strict",
      typeSymbol,
      create: () => parser,
      get jsonSchema() {
        return structuredClone(schemaCopy);
      }
    });
  }

  // src/core/source-chain.mjs
  function createSourceChain() {
    const SOURCES = ["tavily", "exa", "tinyfish", "firecrawl"];
    const failWith = (code, message) => {
      const error = new Error(message);
      error.code = code;
      throw error;
    };
    const envLocked = () => failWith("CONFIG_ENV_OVERRIDE", "这些配置由启动环境提供，不能在插件中覆盖，请先修改环境变量。");
    const item = (fields, key) => {
      const raw = fields?.[key];
      return raw !== null && typeof raw === "object" && !Array.isArray(raw) && Object.hasOwn(raw, "value") ? { value: raw.value, readOnly: raw.readOnly === true } : { value: raw, readOnly: false };
    };
    const listOf = (value) => (Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : []).map((id) => String(id).trim().toLowerCase()).filter((id, index, all) => SOURCES.includes(id) && all.indexOf(id) === index);
    function view(fields) {
      const list = item(fields, "source_providers");
      const listed = listOf(list.value);
      const explicit = listed.length > 0;
      const included = explicit ? listed : [...SOURCES];
      const order = [...included, ...SOURCES.filter((id) => !included.includes(id))];
      const flags = {}, enabled = {}, flagLocked = {};
      for (const id of SOURCES) {
        const flag = item(fields, `${id}_enabled`);
        flags[id] = flag.value !== false;
        flagLocked[id] = flag.readOnly;
        enabled[id] = flags[id] && included.includes(id);
      }
      return { order, listed: included, explicit, enabled, flags, flagLocked, orderLocked: list.readOnly };
    }
    function plan(fields, change) {
      const current = view(fields);
      const updates = {};
      const writeList = (list) => {
        if (list.length === 0) failWith("SOURCE_CHAIN_EMPTY", "至少保留一个补充来源；如需全部停用，请逐个关闭开关。");
        const unchanged = current.explicit ? list.join() === current.listed.join() : list.join() === SOURCES.join();
        if (unchanged) return;
        if (current.orderLocked) envLocked();
        updates.source_providers = list;
      };
      const writeFlag = (id, on) => {
        if (current.flags[id] === on) return;
        if (current.flagLocked[id]) envLocked();
        updates[`${id}_enabled`] = on;
      };
      if (change?.kind === "toggle") {
        const { id, on } = change;
        if (!SOURCES.includes(id) || typeof on !== "boolean") failWith("SOURCE_CHAIN_INVALID", "补充来源开关无效。");
        if (current.enabled[id] === on) return updates;
        if (on) {
          writeFlag(id, true);
          if (!current.listed.includes(id)) writeList([...current.listed, id]);
        } else if (!current.flagLocked[id]) {
          writeFlag(id, false);
        } else {
          writeList(current.listed.filter((other) => other !== id));
        }
        return updates;
      }
      if (change?.kind === "order") {
        const order = Array.isArray(change.order) ? change.order : [];
        if (order.length !== SOURCES.length || new Set(order).size !== SOURCES.length || order.some((id) => !SOURCES.includes(id))) failWith("SOURCE_CHAIN_INVALID", "补充来源顺序无效。");
        if (order.join() === current.order.join()) return updates;
        const list = order.filter((id) => current.enabled[id] || !current.flags[id] || !current.flagLocked[id]);
        for (const id of list) if (!current.enabled[id] && current.flags[id]) writeFlag(id, false);
        writeList(list);
        return updates;
      }
      return failWith("SOURCE_CHAIN_INVALID", "未知的补充来源操作。");
    }
    return Object.freeze({ SOURCES: Object.freeze([...SOURCES]), view, plan });
  }

  // src/ui/route-form.mjs
  var NUM = Object.freeze(Object.fromEntries(Object.entries({
    extra: { min: 0, max: 10, step: 1, unit: "条" },
    fallback: { min: 0, max: 10, step: 1, unit: "条" },
    timeout: { min: 5, max: 300, step: 5, unit: "秒" },
    cache: { min: 1, max: 4096, step: 64, unit: "条" },
    maxChars: { min: 100, max: 5e5, step: 5e3, unit: "字符" },
    budget: { min: 30, max: 120, step: 10, unit: "秒" }
  }).map(([key, value]) => [key, Object.freeze(value)])));
  function normCard(value) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      Array.isArray(item) ? item.map((text) => text.trim()).filter(Boolean) : typeof item === "string" ? item.trim() : item
    ]));
  }
  var normHub = (value) => ({
    ...value,
    exeOverride: (value.exeOverride || "").trim(),
    cfgOverride: (value.cfgOverride || "").trim()
  });
  var joinSentences = (...parts) => parts.map((part) => String(part ?? "").trim().replace(/[。；，;,.]+$/, "")).filter(Boolean).join("。");
  function validateHub(value, { base, readOnly = () => false } = {}) {
    const err = {}, warn = {};
    for (const [key, range] of Object.entries(NUM)) {
      if (readOnly(key) || base && Object.is(value[key], base[key])) continue;
      if (!Number.isInteger(value[key])) err[key] = "请填写整数";
      else if (value[key] < range.min || value[key] > range.max) err[key] = `可填范围 ${range.min}–${range.max}`;
    }
    if (!err.timeout && !err.budget && value.timeout > value.budget) {
      warn.timeout = `请求超时 ${value.timeout} 秒长于单次搜索预算 ${value.budget} 秒，DSH 会先停止等待`;
      warn.budget = warn.timeout;
    }
    return { err, warn };
  }

  // src/ui/route-controller.mjs
  function createRouteController({ root, layer, remote, logos, sourceChain, memory = {}, logMemory = null, createSearchLogView: createSearchLogView2, createQuotaView: createQuotaView2, dark = false }) {
    let disposed = false;
    let logView = null, quotaView = null;
    let controlRetrying = false;
    let secretEpoch = 0;
    let accessGeneration = 0;
    const timers = /* @__PURE__ */ new Set(), frames = /* @__PURE__ */ new Set(), waits = /* @__PURE__ */ new Set(), listeners = /* @__PURE__ */ new Set();
    const setTimeout2 = (fn, ms) => {
      if (disposed) return 0;
      const id = window.setTimeout(() => {
        timers.delete(id);
        if (!disposed) fn();
      }, ms);
      timers.add(id);
      return id;
    };
    const clearTimeout2 = (id) => {
      window.clearTimeout(id);
      timers.delete(id);
    };
    const requestAnimationFrame2 = (fn) => {
      if (disposed) return 0;
      const id = window.requestAnimationFrame((time) => {
        frames.delete(id);
        if (!disposed) fn(time);
      });
      frames.add(id);
      return id;
    };
    const cancelAnimationFrame2 = (id) => {
      window.cancelAnimationFrame(id);
      frames.delete(id);
    };
    const listen = (target, type, fn, options) => {
      target.addEventListener(type, fn, options);
      const off = () => {
        target.removeEventListener(type, fn, options);
        listeners.delete(off);
      };
      listeners.add(off);
      return off;
    };
    const $ = (s, r) => r ? r.querySelector(s) : root.querySelector(s) || layer.querySelector(s);
    const $$ = (s, r) => r ? Array.from(r.querySelectorAll(s)) : [...root.querySelectorAll(s), ...layer.querySelectorAll(s)];
    const active = () => layer.getRootNode().activeElement || root.getRootNode().activeElement || document.activeElement;
    const targetOf = (event) => event.composedPath()[0] || event.target;
    const sleep = (ms) => new Promise((resolve) => {
      const done = () => {
        waits.delete(done);
        resolve();
      };
      waits.add(done);
      setTimeout2(done, ms);
    });
    const clone = (o) => JSON.parse(JSON.stringify(o));
    const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
    const RM = window.matchMedia("(prefers-reduced-motion: reduce)");
    const reduced = () => RM.matches;
    let darkTheme = dark === true || dark === "dark";
    root.dataset.theme = layer.dataset.theme = darkTheme ? "dark" : "light";
    const HIDDEN = "⁣dsg-configured-secret:";
    const hidden = (value) => typeof value === "string" && value.startsWith(HIDDEN);
    const configFields = () => S.config?.fields || {};
    const sourceField = (key) => configFields()[key] || {};
    const chain = () => sourceChain.view(configFields());
    const uuid = () => {
      if (window.crypto.randomUUID) return window.crypto.randomUUID();
      const bytes = window.crypto.getRandomValues(new Uint8Array(16));
      bytes[6] = bytes[6] & 15 | 64;
      bytes[8] = bytes[8] & 63 | 128;
      const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    };
    function parentPath(path) {
      const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
      return path.slice(0, i === 0 || i === 2 && path[1] === ":" ? i + 1 : i);
    }
    function configLocation() {
      const full = S.config?.path || "";
      return {
        label: S.config?.displayPath || full || "正在读取…",
        full,
        dir: parentPath(full),
        name: full.slice(Math.max(full.lastIndexOf("/"), full.lastIndexOf("\\")) + 1) || "config.toml"
      };
    }
    const I = {
      replay: '<path d="M3.2 5.2A5.1 5.1 0 1 1 2.9 10M3.2 2.1v3.5h3.5"/><path d="M8 5.4v3L10 9.7"/>',
      stop: '<rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" stroke="none"/>',
      returnLog: '<path d="M5 5l-3 3 3 3M2 8h7.5A3.5 3.5 0 0 0 13 4.5V3"/><path d="M8 12h5"/>',
      play: '<path d="M5 3.5v9l7.5-4.5z" fill="currentColor"/>',
      eye: '<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>',
      eyeOff: '<path d="M2 2l12 12M6.6 3.7A6.7 6.7 0 0 1 8 3.5C12 3.5 14.5 8 14.5 8a12 12 0 0 1-1.9 2.5M10 11.9a6 6 0 0 1-2 .6C4 12.5 1.5 8 1.5 8a12 12 0 0 1 2.4-3"/><path d="M6.6 6.6a2 2 0 0 0 2.8 2.8"/>',
      copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.8"/><path d="M10.5 5.5V3.8A1.3 1.3 0 0 0 9.2 2.5H3.8a1.3 1.3 0 0 0-1.3 1.3v5.4a1.3 1.3 0 0 0 1.3 1.3h1.7"/>',
      trash: '<path d="M2.5 4.5h11M6 4.5V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5M4 4.5l.6 8.3a1.3 1.3 0 0 0 1.3 1.2h4.2a1.3 1.3 0 0 0 1.3-1.2l.6-8.3"/>',
      plus: '<path d="M8 3v10M3 8h10"/>',
      minus: '<path d="M3 8h10"/>',
      x: '<path d="M4 4l8 8M12 4l-8 8"/>',
      check: '<path d="M3 8.5l3 3 7-7"/>',
      ext: '<path d="M6 3.5H3.5v9h9V10M9 2.5h4.5V7M13.5 2.5L7.5 8.5"/>',
      file: '<path d="M4 1.8h5.2L12.5 5v9.2H4z"/><path d="M9 1.8V5h3.5"/>',
      folder: '<path d="M1.8 4.2c0-.7.5-1.2 1.2-1.2h3.2l1.5 1.6H13c.7 0 1.2.5 1.2 1.2v6.4c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2z"/>',
      info: '<circle cx="8" cy="8" r="6.3"/><path d="M8 7.2v3.8M8 4.9v.1"/>',
      warn: '<path d="M8 2.2l6.2 11H1.8z"/><path d="M8 6.6v3.2M8 11.6v.1"/>',
      errc: '<circle cx="8" cy="8" r="6.3"/><path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4"/>',
      ok: '<circle cx="8" cy="8" r="6.3"/><path d="M5.3 8.2l1.9 1.9 3.6-3.8"/>',
      lock: '<rect x="3.5" y="7" width="9" height="6.5" rx="1.5" fill="currentColor" stroke="none"/><path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" stroke-width="1.8"/>',
      grip: '<circle cx="6" cy="4" r=".9" fill="currentColor"/><circle cx="10" cy="4" r=".9" fill="currentColor"/><circle cx="6" cy="8" r=".9" fill="currentColor"/><circle cx="10" cy="8" r=".9" fill="currentColor"/><circle cx="6" cy="12" r=".9" fill="currentColor"/><circle cx="10" cy="12" r=".9" fill="currentColor"/>',
      chev: '<path d="M6 3.5L10.5 8 6 12.5"/>',
      refresh: '<path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5v3h-3"/>',
      undo: '<path d="M5.5 4L2.5 7l3 3"/><path d="M2.5 7h7a4 4 0 0 1 0 8H7"/>',
      reroute: '<path d="M3 3v4.5a3 3 0 0 0 3 3h7.5"/><path d="M10.5 7.5l3 3-3 3"/>',
      hub: '<circle cx="5" cy="12" r="2.3"/><circle cx="19" cy="5.5" r="2"/><circle cx="19" cy="12" r="2"/><circle cx="19" cy="18.5" r="2"/><path d="M7.3 12h3.2m0 0c2.6 0 2.4-6.5 6.5-6.5M10.5 12h6.5M10.5 12c2.6 0 2.4 6.5 6.5 6.5"/>'
    };
    const svg = (n, cls = "ic") => n === "hub" ? `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I.hub}</svg>` : `<svg class="${cls}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[n]}</svg>`;
    const LOGO = {
      dsh: { light: logos.harness, fit: "cover" },
      deepseek: { light: logos.deepseek, fit: "contain", k: "72%" },
      grok: { light: logos.grok, fit: "cover", ringDark: true },
      tavily: { light: logos.tavily, dark: logos.tavilyDark, fit: "cover" },
      exa: { light: logos.exa, dark: logos.exaDark, fit: "contain", k: "54%" },
      tinyfish: { light: logos.tinyfish, fit: "contain", k: "74%", plateDark: true },
      firecrawl: { light: logos.firecrawl, fit: "contain", k: "54%" },
      github: { light: logos.github, dark: logos.githubDark, fit: "contain", k: "62%" }
    };
    const isDark = () => darkTheme;
    const logoSrc = (id, dark2 = isDark()) => dark2 && LOGO[id].dark || LOGO[id].light;
    function tile(id, size, compact = false) {
      const L = LOGO[id];
      const dark2 = isDark();
      const k = compact && L.fit === "contain" ? "74%" : L.k;
      const st = [size ? `--s:${size}px` : "", k ? `--k:${k}` : ""].filter(Boolean).join(";");
      return `<span class="tile" data-logo="${id}" data-fit="${L.fit}"${dark2 && L.plateDark ? ' data-plate="light"' : ""}${dark2 && L.ringDark ? ' data-ring="true"' : ""}${st ? ` style="${st}"` : ""}><img src="${logoSrc(id, dark2)}" alt="" draggable="false"></span>`;
    }
    function refreshLogos() {
      const dark2 = isDark();
      $$(".tile[data-logo]:not([data-fixed])").forEach((t) => {
        const L = LOGO[t.dataset.logo];
        const img = t.querySelector("img");
        if (img) img.src = logoSrc(t.dataset.logo, dark2);
        if (L.plateDark) dark2 ? t.dataset.plate = "light" : delete t.dataset.plate;
        if (L.ringDark) dark2 ? t.dataset.ring = "true" : delete t.dataset.ring;
      });
      $$("img[data-logo=dsh]").forEach((i) => {
        i.src = LOGO.dsh.light;
      });
      $$("img[data-logo=deepseek]").forEach((i) => {
        i.src = LOGO.deepseek.light;
      });
    }
    const META = {
      grok: { name: "Grok", group: "primary", link: "https://x.ai/api", linkText: "获取 Key", sub: "主搜索 · Grok 回答与引用" },
      tavily: { name: "Tavily", group: "supp", link: "https://tavily.com", linkText: "获取 Key", sub: "网页搜索 / 抓取" },
      exa: { name: "Exa", group: "supp", link: "https://exa.ai", linkText: "获取 Key", sub: "语义搜索" },
      tinyfish: { name: "TinyFish", group: "supp", link: "https://tinyfish.ai", linkText: "获取 Key", sub: "免费搜索 / 抓取" },
      firecrawl: { name: "Firecrawl", group: "supp", link: "https://firecrawl.dev", linkText: "获取 Key", sub: "网页抓取" },
      github: { name: "GitHub", group: "extract", link: "https://github.com/settings/tokens", linkText: "创建 Token", sub: "专用抽取 · Issue / PR / Release" }
    };
    const SUPP = ["tavily", "exa", "tinyfish", "firecrawl"];
    const TAVILY_ROTATE = /* @__PURE__ */ new Set(["401", "403", "429", "432", "433"]);
    const DEF = {
      grokUrl: "https://api.x.ai",
      grokModel: "grok-4-1-fast-reasoning",
      tavilyUrl: "https://api.tavily.com",
      exaUrl: "https://api.exa.ai",
      tfSearch: "https://api.search.tinyfish.ai",
      tfFetch: "https://api.fetch.tinyfish.ai",
      fcUrl: "https://api.firecrawl.dev",
      ghApi: "https://api.github.com"
    };
    function blankProv() {
      return {
        grok: { mode: "responses", url: "", key: "", model: "", web: true, x: false, gwUrl: "", gwKey: "", gwModel: "", enabled: true },
        tavily: { url: "", keys: [""], enabled: true },
        exa: { url: "", key: "", enabled: true },
        tinyfish: { searchUrl: "", fetchUrl: "", key: "", enabled: true },
        firecrawl: { url: "", key: "", enabled: true },
        github: { token: "", enabled: false }
      };
    }
    const CARD_FIELDS = {
      grok: {
        url: "grok_api_url",
        key: "grok_api_key",
        model: "grok_model",
        web: "web_search_enabled",
        x: "x_search_enabled",
        gwUrl: "openai_compatible_api_url",
        gwKey: "openai_compatible_api_key",
        gwModel: "openai_compatible_model"
      },
      tavily: { url: "tavily_api_url", keys: "tavily_api_key" },
      exa: { url: "exa_api_url", key: "exa_api_key" },
      tinyfish: { searchUrl: "tinyfish_search_api_url", fetchUrl: "tinyfish_fetch_api_url", key: "tinyfish_api_key" },
      firecrawl: { url: "firecrawl_api_url", key: "firecrawl_api_key" },
      github: { token: "github_token" }
    };
    const HUB_FIELDS = {
      extra: "default_extra_sources",
      fallback: "fallback_sources",
      timeout: "timeout_seconds",
      cache: "cache_size",
      maxChars: "response_max_chars"
    };
    const S = {
      loading: true,
      busy: false,
      testing: false,
      plugin: true,
      config: null,
      prefs: null,
      control: null,
      program: null,
      pluginInfo: null,
      capabilities: null,
      rpcError: null,
      cfgExists: false,
      readBanner: false,
      readDismissed: memory.readDismissed === true,
      prov: blankProv(),
      order: [...SUPP],
      hub: { extra: 3, fallback: 5, timeout: 60, cache: 256, maxChars: 45e3, budget: 120, exeOverride: "", cfgOverride: "" },
      checked: clone(memory.checked || {}),
      bad: clone(memory.bad || {}),
      identity: clone(memory.identity || {}),
      providerBad: clone(memory.providerBad || {}),
      configRevision: memory.configRevision || null,
      configIdentity: memory.configIdentity || null,
      configPath: memory.configPath || null,
      trace: null,
      auxDismissed: memory.auxDismissed || "",
      lastRouteAt: memory.lastRouteAt || 0,
      diagnosticOperation: null,
      lastRoute: clone(memory.lastRoute || null)
    };
    function providersFrom(fields, preferences = {}) {
      const p = blankProv(), order = sourceChain.view(fields);
      for (const [id, mapping] of Object.entries(CARD_FIELDS)) {
        for (const [name, key] of Object.entries(mapping)) {
          const field2 = fields[key] || {};
          if (name === "keys") {
            p[id].keys = field2.configured ? Array.from({ length: Math.max(1, field2.keyCount || 1) }, (_, i) => HIDDEN + key + ":" + i) : [""];
          } else if (name === "key" || name === "gwKey" || name === "token") {
            p[id][name] = field2.configured ? HIDDEN + key : "";
          } else if (typeof p[id][name] === "boolean") {
            p[id][name] = typeof field2.value === "boolean" ? field2.value : p[id][name];
          } else {
            p[id][name] = field2.source === "default" ? "" : String(field2.value ?? "");
          }
        }
        p[id].enabled = id === "grok" ? preferences.grokEnabled !== false : id === "github" ? preferences.githubReadEnabled === true : order.enabled[id];
      }
      p.grok.authReadOnly = typeof fields.grok_auth_mode?.value === "string" && fields.grok_auth_mode.value !== "api_key";
      p.grok.mode = !p.grok.authReadOnly && !fields.grok_api_key?.configured && fields.openai_compatible_api_url?.value && fields.openai_compatible_api_key?.configured ? "compat" : "responses";
      return p;
    }
    function providerIdentity(id, fields, p) {
      return JSON.stringify([configLocation().full, ...Object.values(CARD_FIELDS[id]).map((key) => {
        const item = fields[key] || {};
        return [key, item.value, item.configured, item.keyCount, item.source];
      }), p.mode, p.authReadOnly]);
    }
    function acceptSnapshot(snapshot, preferences, { first = false, keepTrace = true, trustedConfigUpdate = false } = {}) {
      const fields = snapshot.config?.fields || {}, oldOrder = S.order.join();
      const capabilitiesChanged = Boolean(S.capabilities?.secretsAllowed) !== Boolean(snapshot.capabilities?.secretsAllowed);
      const externalRevision = !trustedConfigUpdate && (S.configRevision && S.configRevision !== snapshot.config?.revision || S.configIdentity && S.configIdentity !== snapshot.config?.quotaRevision);
      const preferencesChanged = S.prefs && preferences && (S.prefs.value.grokEnabled !== preferences.value.grokEnabled || S.prefs.value.githubReadEnabled !== preferences.value.githubReadEnabled);
      if (externalRevision || preferencesChanged) cancelTest();
      S.control = snapshot.control || snapshot;
      S.program = snapshot.program;
      S.pluginInfo = snapshot.plugin || {};
      S.capabilities = snapshot.capabilities;
      if (capabilitiesChanged) secretEpoch++;
      if (S.capabilities && !S.capabilities.secretsAllowed) void logView?.read();
      S.rpcError = null;
      S.config = snapshot.config;
      S.prefs = preferences || S.prefs;
      S.cfgExists = snapshot.config?.exists === true;
      const restored = S.control.policy === "released" && S.control.routeVerified === true && S.control.completionCommitted === true;
      S.plugin = !restored;
      const next = providersFrom(fields, S.prefs?.value);
      for (const id of Object.keys(META)) {
        const identity = providerIdentity(id, fields, next[id]);
        if (externalRevision || S.identity[id] !== identity || S.configPath && S.configPath !== snapshot.config?.path) {
          delete S.checked[id];
          delete S.bad[id];
          delete S.providerBad[id];
        }
        S.identity[id] = identity;
      }
      S.prov = next;
      S.order = sourceChain.view(fields).order;
      for (const [name, key] of Object.entries(HUB_FIELDS)) {
        if (typeof fields[key]?.value === "number") S.hub[name] = fields[key].value;
      }
      S.hub.budget = typeof S.pluginInfo.budgetMs === "number" ? S.pluginInfo.budgetMs / 1e3 : null;
      S.hub.exeOverride = S.program?.configuration?.executable ? S.program.program?.path || "" : "";
      S.hub.cfgOverride = S.program?.configuration?.configPath ? S.program.configPath || "" : "";
      S.configRevision = snapshot.config?.revision;
      S.configIdentity = snapshot.config?.quotaRevision || null;
      S.configPath = snapshot.config?.path;
      S.loading = false;
      if (capabilitiesChanged && D?.kind === "card") {
        const top = $(".dlg-body", dlg)?.scrollTop || 0;
        D.show = {};
        renderCard();
        const body = $(".dlg-body", dlg);
        if (body) body.scrollTop = top;
      }
      if (first) S.readBanner = S.cfgExists && Object.keys(META).some((id) => isSet(id));
      if (oldOrder !== S.order.join()) buildRows(false);
      ingestRoute(snapshot.route, first);
      syncAll(keepTrace);
      syncOpenCardBaseline();
    }
    let readTask = null, pollTimer = 0, snapshotSignature = null;
    function denyPrivateAccess(error) {
      const code = error?.code;
      if (!["SETTINGS_AUTH_REQUIRED", "SETTINGS_SECURE_CONNECTION_REQUIRED"].includes(code)) return false;
      accessGeneration++;
      secretEpoch++;
      snapshotSignature = null;
      S.capabilities = { ...S.capabilities, secretsAllowed: false, reason: code };
      logView?.restrict(code);
      quotaView?.render();
      if (D?.kind === "card") {
        if (D.githubOperation) void remote.cancelDiagnosis({ operationId: D.githubOperation }).catch(() => {
        });
        const top = $(".dlg-body", dlg)?.scrollTop || 0;
        D.show = {};
        renderCard();
        const body = $(".dlg-body", dlg);
        if (body) body.scrollTop = top;
      }
      syncAll(true);
      return true;
    }
    async function refresh({ first = false, force = false, readLog = true } = {}) {
      if (disposed) return;
      if (readTask) return readTask;
      if (!force && (S.busy || S.testing || drag)) return;
      const accessAtStart = accessGeneration;
      readTask = (async () => {
        try {
          const [snapshot, prefs] = await Promise.all([remote.snapshot(), remote.preferences()]);
          if (!disposed && accessAtStart === accessGeneration) {
            const signature = JSON.stringify([snapshot, prefs]);
            if (first || force || S.rpcError || signature !== snapshotSignature) {
              acceptSnapshot(snapshot, prefs, { first });
              snapshotSignature = signature;
            }
            if (readLog) void logView?.read();
          }
        } catch (error) {
          if (disposed || accessAtStart !== accessGeneration) return;
          denyPrivateAccess(error);
          S.loading = false;
          S.rpcError = { code: error?.code || "SETTINGS_UNAVAILABLE", message: error?.message || "设置服务暂不可用，请重试。" };
          syncAll(true);
        }
      })().finally(() => {
        readTask = null;
      });
      return readTask;
    }
    function schedulePoll() {
      clearTimeout2(pollTimer);
      pollTimer = setTimeout2(async () => {
        if (document.visibilityState !== "hidden") await refresh({ readLog: false });
        if (!disposed) schedulePoll();
      }, 3e3);
    }
    function updateConfig(config, changedKeys) {
      if (Array.isArray(changedKeys)) {
        S.lastRoute = null;
        for (const [id, mapping] of Object.entries(CARD_FIELDS)) if (Object.values(mapping).some((key) => changedKeys.includes(key))) {
          delete S.checked[id];
          delete S.bad[id];
          delete S.providerBad[id];
        }
      }
      acceptSnapshot(
        { control: S.control, program: S.program, config: {
          ...config,
          displayPath: S.config?.displayPath,
          error: null
        }, capabilities: S.capabilities, plugin: S.pluginInfo },
        S.prefs,
        { keepTrace: false, trustedConfigUpdate: Array.isArray(changedKeys) }
      );
    }
    function operationError(error, dialog = false) {
      if (disposed) return;
      denyPrivateAccess(error);
      const code = error?.code || "SETTINGS_OPERATION_FAILED";
      const message = {
        CONFIG_CONFLICT: "配置已在别处修改，草稿已保留，请核对后再保存。",
        CONFIG_COMMIT_UNCERTAIN: "配置可能已写入，请重新读取确认，不要重复保存。",
        PREFERENCES_CONFLICT: "插件开关已在别处修改，请重试。",
        PREFERENCES_COMMIT_UNCERTAIN: "插件开关可能已保存，请重新读取确认，不要重复操作。",
        PREFERENCES_BUSY: "插件开关正在保存或上次保存被中断，请检查后重试。",
        CONFIG_BUSY: "配置正在保存或上次保存被中断，请检查后重试。",
        CONFIG_ENV_OVERRIDE: "此设置由环境变量控制，不能在插件中覆盖。"
      }[code] || error?.message || "操作失败，请重试。";
      if (dialog && D) {
        D.saving = false;
        D.clearing = false;
        D.operationError = { code, message };
        const body = $(".dlg-body", dlg), top = body?.scrollTop || 0;
        if (D.kind === "card") renderCard();
        else renderHub();
        const nextBody = $(".dlg-body", dlg);
        if (nextBody) nextBody.scrollTop = top;
        shake(dlg);
      } else toast(`${code} · ${message}`, { tone: "err", ms: 5200 });
    }
    async function retryControl() {
      if (disposed || controlRetrying || S.busy) return;
      controlRetrying = true;
      S.busy = true;
      renderBanner();
      const generation = accessGeneration;
      try {
        if (readTask) await readTask;
        if (disposed || generation !== accessGeneration) return;
        await remote.retryControlRelease();
        if (!disposed && generation === accessGeneration) await refresh({ force: true });
      } catch (error) {
        if (disposed || generation !== accessGeneration) return;
        operationError(error);
        await refresh({ force: true });
        if (!disposed && /^gateway[/.]|^SETTINGS_UNAVAILABLE$/.test(error?.code || "")) {
          toast("此宿主暂不能执行恢复操作，请通过插件页原生开关重试。", { tone: "warn" });
        }
      } finally {
        controlRetrying = false;
        S.busy = false;
        if (!disposed) syncAll(true);
      }
    }
    function syncOpenCardBaseline() {
      if (D?.kind === "card" && !dialogBusy() && D.operationError?.code !== "CONFIG_CONFLICT" && quotaView?.stale()) {
        D.operationError = { code: "CONFIG_CONFLICT", message: "配置已在别处修改，请先读取最新配置。" };
        refreshDialog();
      } else quotaView?.render();
    }
    async function reloadDialogDraft() {
      if (!D || dialogBusy() || S.busy || disposed) return;
      const mine = D, previous = clone(mine.base), draft = clone(mine.draft);
      const changed = Object.keys(draft).filter((key) => JSON.stringify(draft[key]) !== JSON.stringify(previous[key]));
      mine.saving = true;
      S.busy = true;
      lockDialog();
      try {
        const [snapshot, prefs] = await Promise.all([remote.snapshot(), remote.preferences()]);
        if (disposed || D !== mine) return;
        if (snapshot.config.error) throw Object.assign(new Error(snapshot.config.error.message), { code: snapshot.config.error.code });
        acceptSnapshot(snapshot, prefs);
        mine.base = clone(mine.kind === "card" ? S.prov[mine.id] : S.hub);
        if (mine.kind === "card" && !isSet(mine.id, mine.base)) mine.base.enabled = true;
        mine.fields = clone(configFields());
        mine.configBaseline = clone(S.config);
        mine.draft = clone(mine.base);
        for (const key of changed) {
          if (!fieldReadOnly(key) && (key !== "mode" || !mine.base.authReadOnly && !mine.fields.grok_api_key?.readOnly)) {
            mine.draft[key] = clone(draft[key]);
          }
        }
        mine.orig = JSON.stringify(mine.kind === "card" ? normCard(mine.base) : normHub(mine.base));
        mine.operationError = {
          code: "CONFIG_RELOADED",
          message: "已读取最新配置并保留你的修改。请核对后再保存；本次没有写入。"
        };
        mine.show = {};
        mine.saving = false;
        if (mine.kind === "card") {
          renderCard();
          void quotaView?.open();
        } else renderHub();
      } catch (error) {
        if (D === mine) operationError(error, true);
      } finally {
        S.busy = false;
        if (D === mine) mine.saving = false;
      }
    }
    async function saveConfig(build, baseline = null) {
      if (!S.config || S.config.error) throw Object.assign(new Error("请先修正配置文件。"), { code: "CONFIG_PARSE_FAILED" });
      const starting = clone(S.config);
      const fieldChanged = (old, current, updates) => old.path !== current.path || Object.keys(updates).some((key) => key.endsWith("_key") || key.endsWith("_url") || key === "github_token" || JSON.stringify(old.fields[key]) !== JSON.stringify(current.fields[key]));
      for (let attempt = 0; attempt < 2; attempt++) {
        const updates = typeof build === "function" ? build(S.config.fields) : build;
        const revision = S.config.revision;
        if (!Object.keys(updates).length) return null;
        if (baseline && baseline.revision !== revision && fieldChanged(baseline, S.config, updates)) {
          throw Object.assign(new Error("配置已在别处修改，请核对草稿后再保存。"), { code: "CONFIG_CONFLICT" });
        }
        try {
          const result = await remote.save({ expectedRevision: revision, updates });
          if (!disposed) updateConfig(result.config, Object.keys(updates));
          return { before: revision, after: result.config.revision, undo: starting.exists };
        } catch (error) {
          if (attempt || error?.code !== "CONFIG_CONFLICT" || disposed) throw error;
          await refresh({ force: true });
          if (S.rpcError || !S.config || S.config.error) throw error;
          const collision = fieldChanged(starting, S.config, updates);
          if (collision) throw error;
        }
      }
    }
    async function savePreference(id, on) {
      const key = id === "grok" ? "grokEnabled" : "githubReadEnabled";
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const result = await remote.savePreferences({
            expectedRevision: S.prefs.revision,
            value: { ...S.prefs.value, [key]: on }
          });
          if (!disposed) {
            S.prefs = result;
            S.prov[id].enabled = result.value[key] !== false;
          }
          return result;
        } catch (error) {
          if (attempt || error?.code !== "PREFERENCES_CONFLICT" || disposed) throw error;
          S.prefs = await remote.preferences();
        }
      }
    }
    function configUndo(receipt) {
      if (!receipt?.undo || !S.capabilities?.secretsAllowed) return void 0;
      return async () => {
        if (disposed || S.busy) return;
        S.busy = true;
        try {
          const result = await remote.restoreConfig({ expectedRevision: receipt.after, revision: receipt.before });
          if (!disposed) {
            updateConfig(result.config);
            toast("已恢复保存前的配置 · 下次搜索生效");
          }
        } catch (error) {
          operationError(error);
        } finally {
          S.busy = false;
          if (!disposed) syncAll(true);
        }
      };
    }
    function cardUndo(receipt, id, previousEnabled, preferenceChanged) {
      if (!preferenceChanged) return configUndo(receipt);
      if (receipt && (!receipt.undo || !S.capabilities?.secretsAllowed)) return void 0;
      return async () => {
        if (disposed || S.busy) return;
        S.busy = true;
        let restored = false;
        try {
          if (receipt) {
            const result = await remote.restoreConfig({ expectedRevision: receipt.after, revision: receipt.before });
            if (disposed) return;
            updateConfig(result.config);
            restored = true;
          }
          await savePreference(id, previousEnabled);
          if (!disposed) {
            syncAll(false);
            toast("已撤销配置和 DSH 开关修改");
          }
        } catch (error) {
          operationError(restored ? Object.assign(
            new Error("共享配置已恢复，但 DSH 开关未恢复。请核对开关。"),
            { code: "SETTINGS_PARTIAL_RESTORE" }
          ) : error);
        } finally {
          S.busy = false;
          if (!disposed) syncAll(true);
        }
      };
    }
    function normalizeCode(code) {
      return String(code || "UNKNOWN").replace(/^HTTP_/i, "").trim();
    }
    function ingestRoute(route, first = false) {
      if (!route || route.origin === "test" || route.at <= S.lastRouteAt) return;
      S.lastRouteAt = route.at;
      S.lastRoute = clone(route);
      if (route.grokCode !== "DISABLED" && grokOn()) {
        rememberCheck("grok", 0, route.grokCode ? normalizeCode(route.grokCode) : "", "search", route.at);
      }
      if (SUPP.includes(route.served) && route.provenance !== "source-label") {
        delete S.providerBad[route.served];
        if (route.served === "tavily") {
          delete S.checked.tavily;
          delete S.bad.tavily;
          S.checked.tavilyProvider = { at: route.at, source: "search" };
        } else rememberCheck(route.served, 0, "", "search", route.at);
      }
      const failures = (route.failures || []).filter((row) => SUPP.includes(row.provider) && row.code !== "EMPTY");
      for (const failure of failures) {
        if (failure.provider === "tavily") S.providerBad.tavily = { code: normalizeCode(failure.code), at: route.at };
        else rememberCheck(failure.provider, 0, normalizeCode(failure.code), "search", route.at);
      }
      S.trace = {
        bg: true,
        order: S.order.slice(),
        items: [],
        failedSources: failures.map((row) => row.provider),
        served: route.served,
        reroute: route.fallbackUsed === true,
        outcome: route.outcome,
        done: {
          tone: route.outcome === "ok" ? "ok" : "err",
          text: route.outcome !== "ok" ? "全部不可用" : route.resultProviders?.length && route.fallbackUsed ? `已回退 · ${route.resultProviders.filter((id) => META[id]).map((id) => META[id].name).join(" / ")}${route.resultProvidersComplete ? "" : " / 来源未报告"}` : route.served === "grok-sources" ? "已回退 · 来源未报告" : route.fallbackUsed ? `已回退 · ${META[route.served]?.name || "补充来源"}` : "Grok 搜索完成"
        }
      };
      clearTimeout2(S.traceTimer);
      S.traceTimer = setTimeout2(() => {
        S.trace = null;
        renderSummary();
        pumpWires(200);
      }, 6500);
      if (first) quiet(1e3);
      else {
        for (const id of ["grok", ...failures.map((row) => row.provider)]) {
          if (S.bad[id] || failures.some((row) => row.provider === id)) {
            pulseFault(rowOf(id));
            void jolt(rowOf(id));
          }
        }
      }
    }
    function isSet(id, p = S.prov[id]) {
      if (id === "grok") return p.authReadOnly || (p.mode === "compat" ? !!(p.gwUrl.trim() && p.gwKey.trim()) : !!p.key.trim());
      if (id === "tavily") return p.keys.some((k) => k.trim());
      if (id === "github") return !!p.token.trim() || p.enabled === true;
      return !!p.key.trim();
    }
    const isOn = (id) => isSet(id) && S.prov[id].enabled !== false;
    const enabledSupp = () => S.order.filter(isOn);
    const tvKeyIdx = (p = S.prov.tavily) => p.keys.map((k, i) => k.trim() ? i : -1).filter((i) => i >= 0);
    function faultOf(map, id) {
      const v = map[id];
      if (id !== "tavily") return v ? "all" : "";
      if (!v) return "";
      const idx = tvKeyIdx();
      const n = idx.filter((i) => v[i]).length;
      return !n ? "" : n === idx.length ? "all" : "some";
    }
    const isBad = (id) => faultOf(S.bad, id) === "all";
    const isPart = (id) => faultOf(S.bad, id) === "some";
    const grokOn = () => isOn("grok");
    const usable = (id) => isOn(id) && !isBad(id);
    const grokDiagnosticFailed = () => grokOn() && !S.lastRoute && isBad("grok") && S.checked.grok?.[0]?.source === "test";
    const testedSourceReady = (id) => (id === "tavily" ? tvKeyIdx() : [0]).some((slot) => {
      const checked = savedCheck(id, slot);
      return checked.tone === "ok" && checked.record?.source === "test" && checked.record.status === "ok";
    });
    const requestFailed = (id) => S.lastRoute?.failures?.some((failure) => failure.provider === id) === true;
    const observedSupp = () => (S.lastRoute?.resultProviders || [S.lastRoute?.served]).filter((id) => SUPP.includes(id));
    const unknownFallback = () => S.lastRoute?.served === "grok-sources" && S.lastRoute.outcome === "ok" && !observedSupp().length;
    const servingSupp = () => unknownFallback() || S.lastRoute?.outcome === "failed" ? null : S.lastRoute?.resultProviders ? observedSupp().find((id) => isOn(id) && !requestFailed(id)) || null : SUPP.includes(S.lastRoute?.served) && isOn(S.lastRoute.served) && !requestFailed(S.lastRoute.served) ? S.lastRoute.served : enabledSupp().find((id) => !isBad(id) && !requestFailed(id) && (!grokDiagnosticFailed() || testedSourceReady(id))) || null;
    const servingSupps = () => S.lastRoute?.resultProviders && S.lastRoute.outcome === "ok" ? observedSupp().filter((id) => isOn(id) && !requestFailed(id)) : [servingSupp()].filter(Boolean);
    function savedCheck(id, slot = 0) {
      const code = id === "tavily" ? S.bad.tavily?.[slot] : S.bad[id];
      const record = S.checked[id]?.[slot];
      return { tone: code ? "err" : record ? "ok" : "idle", code: code || "", record };
    }
    function rememberCheck(id, slot, code, source, at = Date.now()) {
      (S.checked[id] ||= {})[slot] = { at, source, status: code ? "failed" : "ok" };
      if (id === "tavily") {
        const bad = { ...S.bad.tavily || {} };
        if (code) bad[slot] = code;
        else delete bad[slot];
        if (Object.keys(bad).length) S.bad.tavily = bad;
        else delete S.bad.tavily;
      } else if (code) S.bad[id] = code;
      else delete S.bad[id];
    }
    function reconcileChecks(id, prev, next) {
      delete S.providerBad[id];
      if (id === "tavily" && prev.url.trim() === next.url.trim()) {
        ["checked", "bad"].forEach((name) => {
          const old = S[name][id] || {};
          const mapped = {};
          next.keys.forEach((key, i) => {
            const j = key ? prev.keys.findIndex((v) => v.trim() === key) : -1;
            if (j >= 0 && Object.hasOwn(old, j)) mapped[i] = old[j];
          });
          if (Object.keys(mapped).length) S[name][id] = mapped;
          else delete S[name][id];
        });
      } else {
        delete S.checked[id];
        delete S.bad[id];
      }
    }
    function codeOf(id, map = S.bad) {
      const v = map[id];
      if (!v) return "";
      if (id !== "tavily") return v;
      const codes = tvKeyIdx().map((i) => v[i]).filter(Boolean);
      return [...new Set(codes)].join("/");
    }
    function routeStatus() {
      if (S.loading) return "load";
      if (S.rpcError) return "down";
      if (S.config?.error) return "cfgerr";
      if (S.control?.error || ["incomplete", "conflict", "unavailable", "stopping"].includes(S.control?.phase)) return "ctlerr";
      if (!S.plugin) return "off";
      if (!["required"].includes(S.control?.phase)) return "connecting";
      if (S.lastRoute?.outcome === "failed") return "err";
      const sv = servingSupp();
      if (S.lastRoute?.outcome === "ok" && S.lastRoute.fallbackUsed && S.lastRoute.resultProviders) return "fallback";
      if (unknownFallback()) return "fallback";
      if (S.prov.grok.enabled !== false && ["idle", "discovering", "checking-version", "downloading", "verifying"].includes(S.program?.phase)) {
        return sv ? "backup" : "prep";
      }
      if (grokOn()) {
        if (!isBad("grok") && S.program?.phase !== "error") return "live";
        return sv ? S.lastRoute?.outcome === "ok" && S.lastRoute.fallbackUsed ? "fallback" : "backup" : "err";
      }
      if (sv) return "backup";
      if (enabledSupp().length) return "err";
      const anySet = ["grok", ...SUPP].some((id) => isSet(id));
      return anySet ? "none" : "wait";
    }
    const STATUS_TEXT = {
      load: "读取配置…",
      down: "设置服务不可用",
      cfgerr: "配置文件无法读取",
      ctlerr: "接管异常",
      connecting: "正在接管…",
      prep: "正在准备 Grok",
      off: "已恢复原搜索",
      wait: "等待配置",
      none: "未启用来源",
      err: "搜索失败",
      live: "正在接管",
      fallback: "已静默回退",
      backup: "补充来源接管"
    };
    function rowState(id) {
      const st = routeStatus();
      if (["load", "down", "cfgerr", "ctlerr", "connecting"].includes(st)) return isSet(id) ? "on" : "unset";
      if (id === "grok") {
        if (!isSet("grok")) return st === "wait" ? "wait" : "unset";
        if (!grokOn()) return "off";
        if (st === "off") return "on";
        if (isBad("grok") || S.program?.phase === "error") return st === "err" ? "err" : "bad";
        if (S.program?.phase !== "ready") return "on";
        return "live";
      }
      if (!isSet(id)) return "unset";
      if (S.prov[id].enabled === false) return "off";
      if (st === "off") return "on";
      if (isBad(id) || requestFailed(id)) return st === "err" ? "err" : "bad";
      if (id === "github") return "on";
      if ((st === "fallback" || st === "backup") && servingSupps().includes(id)) return "live";
      return "on";
    }
    const RANK = { hidden: 0, unset: 1, rest: 2, broken: 3, aux: 4, standby: 5, warn: 6, live: 7 };
    function wireDefs() {
      const st = routeStatus();
      const off = st === "off";
      const serving = servingSupps();
      const covering = st === "fallback" || st === "backup";
      const defs = [];
      const top = {
        off: "rest",
        load: "hidden",
        down: "rest",
        cfgerr: "broken",
        ctlerr: "broken",
        connecting: "warn",
        prep: "warn",
        wait: "warn",
        none: "warn",
        err: "broken"
      }[st] || "live";
      defs.push({ id: "dsh-hub", a: "dsh-out", b: "hub-in", ws: top, at: "start" });
      defs.push({ id: "dsh-off", a: "dsh-alt", b: "off-in", ws: off ? "live" : "hidden", kind: "alt" });
      const rows = ["grok", ...S.order, "github"];
      rows.forEach((id) => {
        let ws;
        if (st === "load") ws = "hidden";
        else if (["down", "cfgerr", "ctlerr", "connecting"].includes(st)) ws = "rest";
        else if (off) ws = isSet(id) ? "rest" : "unset";
        else if (!isSet(id)) ws = id === "grok" && st === "wait" ? "warn" : "unset";
        else if (!isOn(id)) ws = "rest";
        else if (isBad(id) || requestFailed(id) || id === "grok" && S.program?.phase === "error") ws = "broken";
        else if (id === "github") ws = "aux";
        else if (id === "grok") ws = S.program?.phase === "ready" ? "live" : "warn";
        else ws = covering && serving.includes(id) ? "live" : "standby";
        defs.push({ id: "hub-" + id, a: "hub-out", b: "row-" + id, ws, kind: "branch", at: "end" });
      });
      return defs;
    }
    function portEl(name) {
      if (name.startsWith("row-")) return $(`#colList .row[data-id="${name.slice(4)}"] > .port`);
      return $(`.port[data-port="${name}"]`);
    }
    function pathFor(d, A, B) {
      if (d.kind === "alt") return `M${A.x},${A.y} L${B.x},${B.y}`;
      const dx = Math.max(24, (B.x - A.x) * 0.5);
      return `M${A.x},${A.y} C${A.x + dx},${A.y} ${B.x - dx},${B.y} ${B.x},${B.y}`;
    }
    const wiresEl = $("#wires");
    const SVGNS = "http://www.w3.org/2000/svg";
    const wireNodes = /* @__PURE__ */ new Map();
    let packetLayer = null;
    let quietUntil = 0;
    const quiet = (ms = 900) => {
      quietUntil = performance.now() + ms;
    };
    function ensureWire(id) {
      let g = wireNodes.get(id);
      if (!g) {
        g = document.createElementNS(SVGNS, "g");
        g.setAttribute("class", "wg");
        g.dataset.w = id;
        const t = document.createElementNS(SVGNS, "path");
        t.setAttribute("class", "wt");
        const p = document.createElementNS(SVGNS, "path");
        p.setAttribute("class", "w");
        const d1 = document.createElementNS(SVGNS, "circle");
        d1.setAttribute("class", "w-end");
        d1.setAttribute("r", "1.4");
        const d2 = document.createElementNS(SVGNS, "circle");
        d2.setAttribute("class", "w-end");
        d2.setAttribute("r", "1.4");
        g.append(t, p, d1, d2);
        wireNodes.set(id, g);
        wiresEl.appendChild(g);
      }
      return g;
    }
    const BREAK = { end: 8, gap: 10 };
    function syncBreak(g, prev, at) {
      if (g.dataset.ws === "broken" && prev !== "broken") g._bt = performance.now();
      if (g.dataset.ws !== "broken") {
        g._bt = 0;
        delete g._bf;
        g.classList.remove("is-broken");
        g.children[1].style.strokeDasharray = "";
        g.children[1].style.strokeLinecap = "";
        g.children[2].style.opacity = g.children[3].style.opacity = "";
        return 0;
      }
      const p = g.children[1];
      g.classList.add("is-broken");
      if (!g._bt) g._bt = performance.now();
      if (g.classList.contains("lit")) {
        p.style.strokeDasharray = "";
        p.style.strokeLinecap = "";
        g.children[2].style.opacity = g.children[3].style.opacity = "0";
        return 0;
      }
      const k = reduced() || performance.now() <= quietUntil ? 1 : Math.min(1, (performance.now() - g._bt) / 420);
      const u = k - 1;
      const e = Math.max(0, 1 + 2.4 * u * u * u + 1.4 * u * u);
      const len = p.getTotalLength();
      if (!len) return 0;
      g._bf ??= Math.random();
      const guard = Math.min(BREAK.end, len / 5);
      const target = Math.min(BREAK.gap * e, len - guard * 2);
      const center = len * (at === "start" ? 0.3 + g._bf * 0.3 : 0.45 + g._bf * 0.37);
      const s = Math.max(guard, Math.min(len - target - guard, center - target / 2));
      p.style.strokeDasharray = `${s} ${target} ${Math.max(0, len - s - target)} 0`;
      p.style.strokeLinecap = "butt";
      if (target > 0.2) {
        const a = p.getPointAtLength(s);
        const b = p.getPointAtLength(s + target);
        g.children[2].setAttribute("cx", a.x);
        g.children[2].setAttribute("cy", a.y);
        g.children[3].setAttribute("cx", b.x);
        g.children[3].setAttribute("cy", b.y);
        g.children[2].style.opacity = g.children[3].style.opacity = String(Math.min(1, e * 1.3));
      } else {
        g.children[2].style.opacity = g.children[3].style.opacity = "0";
      }
      return k < 1 ? 40 : 0;
    }
    function drawWires() {
      const stage = $("#stage");
      const sr = stage.getBoundingClientRect();
      const computed = getComputedStyle(stage);
      const scaleX = sr.width / (parseFloat(computed.width) || sr.width || 1) || 1;
      const scaleY = sr.height / (parseFloat(computed.height) || sr.height || 1) || 1;
      const defs = wireDefs();
      const ports = /* @__PURE__ */ new Map();
      for (const d of defs) for (const name of [d.a, d.b]) if (!ports.has(name)) {
        const el = portEl(name), r = el?.getBoundingClientRect();
        ports.set(name, { el, point: r ? {
          x: (r.left + r.width / 2 - sr.left) / scaleX,
          y: (r.top + r.height / 2 - sr.top) / scaleY
        } : null });
      }
      const portRank = {};
      const live = /* @__PURE__ */ new Set();
      const breaks = [];
      let breaking = 0;
      defs.forEach((d) => {
        live.add(d.id);
        const fresh = !wireNodes.has(d.id);
        const g = ensureWire(d.id);
        const prev = g.dataset.ws;
        if (prev !== d.ws) g.dataset.ws = d.ws;
        const requesting = S.testing && !S.trace?.done && (d.id === "dsh-hub" || S.trace?.items.some((it) => it.tone === "run" && d.id === "hub-" + it.id));
        if (g.dataset.requesting !== String(!!requesting)) g.dataset.requesting = String(!!requesting);
        const A = ports.get(d.a).point, B = ports.get(d.b).point;
        if (A && B) {
          const dd = pathFor(d, A, B);
          if (g.children[1].getAttribute("d") !== dd) {
            g.children[0].setAttribute("d", dd);
            g.children[1].setAttribute("d", dd);
          }
          breaks.push({ g, prev, at: d.at });
        }
        if (!fresh && prev !== d.ws) {
          if (!S.testing && performance.now() > quietUntil) onWireChange(d, g, prev);
          if (d.ws === "broken" && !reduced() && performance.now() > quietUntil) breaking = Math.max(breaking, 60);
        }
        [d.a, d.b].forEach((pn) => {
          if ((portRank[pn] ?? -1) < RANK[d.ws]) portRank[pn] = RANK[d.ws];
        });
      });
      for (const { g, prev, at } of breaks) breaking = Math.max(breaking, syncBreak(g, prev, at));
      for (const [id, g] of wireNodes) if (!live.has(id)) {
        g.remove();
        wireNodes.delete(id);
      }
      const rk = (g) => g.classList.contains("lit") ? 99 : RANK[g.dataset.ws];
      const sorted = defs.map((d) => wireNodes.get(d.id)).sort((x, y) => rk(x) - rk(y));
      const cur = $$(".wg", wiresEl);
      if (sorted.some((g, i) => cur[i] !== g)) sorted.forEach((g) => wiresEl.appendChild(g));
      if (!packetLayer) {
        packetLayer = document.createElementNS(SVGNS, "g");
        packetLayer.setAttribute("class", "packets");
      }
      if (wiresEl.lastChild !== packetLayer) wiresEl.appendChild(packetLayer);
      const names = Object.keys(RANK);
      Object.entries(portRank).forEach(([pn, rk2]) => {
        const el = ports.get(pn).el, state = names.find((n) => RANK[n] === rk2);
        if (el && el.dataset.ps !== state) el.dataset.ps = state;
      });
      if (breaking) pumpWires(breaking);
    }
    let pumpUntil = 0, pumpRaf = 0;
    function pumpWires(ms = 520) {
      pumpUntil = Math.max(pumpUntil, performance.now() + ms);
      if (pumpRaf) return;
      const tick = () => {
        drawWires();
        if (performance.now() < pumpUntil) pumpRaf = requestAnimationFrame2(tick);
        else pumpRaf = 0;
      };
      pumpRaf = requestAnimationFrame2(tick);
    }
    function surge(g, tone) {
      g.classList.remove("surge");
      void g.getBoundingClientRect();
      g.classList.add("surge");
      setTimeout2(() => g.classList.remove("surge"), 1e3);
    }
    function onWireChange(d, g, prev) {
      if (reduced()) return;
      if (d.ws === "live" && d.kind === "branch") {
        surge(g);
      }
    }
    function markFor(id) {
      const st = routeStatus();
      if (st === "load" || st === "off") return "";
      if (!isOn(id) || isBad(id) || requestFailed(id)) return "";
      const slots = id === "tavily" ? tvKeyIdx() : [0];
      const passed = slots.filter((slot) => savedCheck(id, slot).tone === "ok").length;
      return passed === slots.length ? "ok" : passed ? "part" : "";
    }
    function syncMarks() {
      let changed = false;
      $$("#colList .row").forEach((r) => {
        const p = r.querySelector(".port");
        const m = markFor(r.dataset.id);
        if ((p.dataset.mark || "") === m) return;
        changed = true;
        if (m) {
          p.dataset.mark = m;
          p.classList.remove("pop");
          void p.offsetWidth;
          p.classList.add("pop");
        } else delete p.dataset.mark;
      });
      if (changed) pumpWires(300);
    }
    const card = $("#routeCard");
    const resizeObserver = new ResizeObserver(() => requestAnimationFrame2(() => pumpWires(80)));
    resizeObserver.observe(card);
    const historyActionsObserver = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width + "px";
      if (card.style.getPropertyValue("--history-actions-width") !== width) card.style.setProperty("--history-actions-width", width);
    });
    historyActionsObserver.observe($(".rc-actions", card));
    function rowEl(id) {
      const m = META[id];
      const el = document.createElement("div");
      el.className = "row";
      el.dataset.id = id;
      if (m.group === "supp") el.dataset.drag = "true";
      el.innerHTML = `<span class="port"></span><button type="button" class="row-main">${tile(id)}<span class="row-name">${m.name}</span></button><button type="button" class="switch" role="switch" aria-checked="false"><i></i></button><span class="row-fault" id="rowFault-${id}" role="status" aria-atomic="true" aria-hidden="true"><span class="row-fault-code"></span><span class="row-fault-sep" aria-hidden="true">·</span><span class="row-fault-reason"></span></span>`;
      return el;
    }
    function syncRow(el) {
      const id = el.dataset.id;
      const st = rowState(id);
      el.dataset.st = st;
      const sw = el.querySelector(".switch");
      const name = META[id].name;
      const checked = isOn(id);
      const label = !isSet(id) ? `${name} 未配置，打开配置` : id === "github" ? "启用 GitHub 读取" : id === "grok" ? "启用 Grok 主搜索" : `启用 ${name}`;
      sw.setAttribute("aria-checked", String(checked));
      sw.setAttribute("aria-label", label);
      sw.disabled = S.busy || ["down", "cfgerr", "ctlerr", "connecting"].includes(routeStatus());
      const unverified = id === "tavily" ? tvKeyIdx().every((slot) => savedCheck(id, slot).tone === "idle") : savedCheck(id).tone === "idle";
      const stText = st === "live" && unverified ? "已启用，尚未验证" : { unset: "未配置", wait: "等待配置", on: "已启用", off: "已停用", live: "正在使用", bad: "最近验证失败", err: "最近验证失败" }[st];
      let aria = `${name}，${stText}`;
      if (META[id].group === "supp") aria += `，补充来源第 ${S.order.indexOf(id) + 1} 位。按 Enter 打开配置，Alt 加上下方向键调整顺序`;
      else aria += "。按 Enter 打开配置";
      const fault = rowFault(id);
      const badge = el.querySelector(".row-fault");
      el.classList.toggle("has-fault", !!fault);
      const key = fault ? `${fault.tone}:${fault.status}:${fault.text}:${fault.detail}` : "";
      if (badge._state !== key) {
        badge._state = key;
        badge.setAttribute("aria-hidden", String(!fault));
        if (fault) badge.setAttribute("aria-label", fault.detail);
        else badge.removeAttribute("aria-label");
        badge.dataset.tone = fault?.tone || "";
        badge.querySelector(".row-fault-code").textContent = fault?.status || "";
        badge.querySelector(".row-fault-reason").textContent = fault?.text || "";
      }
      const main = el.querySelector(".row-main");
      if (fault) {
        el.title = fault.detail;
        main.setAttribute("aria-describedby", badge.id);
      } else {
        el.removeAttribute("title");
        main.removeAttribute("aria-describedby");
      }
      main.setAttribute("aria-label", aria);
    }
    function syncRows() {
      $$("#colList .row").forEach(syncRow);
      syncMarks();
    }
    function buildRows(animate) {
      for (const [target, ids] of [["#rowsPrimary", ["grok"]], ["#rowsSupp", S.order], ["#rowsExtract", ["github"]]]) {
        const parent = $(target);
        const nodes = new Map([...parent.children].map((node) => [node.dataset.id, node]));
        ids.forEach((id, index) => {
          const node = nodes.get(id) || rowEl(id);
          if (parent.children[index] !== node) parent.insertBefore(node, parent.children[index] || null);
        });
      }
      syncRows();
      animateRows(animate);
    }
    function animateRows(animate) {
      if (animate && !reduced()) {
        $$("#colList .row").forEach((r, i) => {
          r.style.setProperty("--i", i);
          r.classList.add("enter");
          r.addEventListener("animationend", (e) => {
            if (e.animationName === "row-in") r.classList.remove("enter");
          });
        });
      }
    }
    function testProgressText() {
      const progress = S.testProgress;
      return progress ? `${progress.completed}/${progress.total} · ${progress.current || "准备"} · ${Math.floor((performance.now() - progress.started) / 1e3)}秒` : "逐项测试中…";
    }
    function tickTestProgress() {
      if (!S.testing || disposed) return;
      const text = testProgressText();
      if ($("#statusText").textContent !== text) $("#statusText").textContent = text;
      S.testProgressTimer = setTimeout2(tickTestProgress, 1e3);
    }
    function renderHead() {
      const st = routeStatus();
      const githubTesting = S.testing && S.testProgress?.current === "GitHub";
      const hubName = $("#nodeHub .node-name"), agentKind = $("#nodeDsh .node-meta");
      if (hubName.textContent !== (githubTesting ? "dsh-grok-search" : "Grok Search Rs")) hubName.textContent = githubTesting ? "dsh-grok-search" : "Grok Search Rs";
      if (agentKind.textContent !== (githubTesting ? "GitHub API" : "web_search")) agentKind.textContent = githubTesting ? "GitHub API" : "web_search";
      card.dataset.s = st;
      card.dataset.plugin = S.plugin ? "on" : "off";
      card.classList.toggle("is-loading", st === "load");
      const pill = $("#statusPill");
      const statusText = S.testing ? testProgressText() : st === "backup" && grokDiagnosticFailed() ? "补充来源可用" : st === "err" && !S.lastRoute ? "最近检查未通过" : STATUS_TEXT[st];
      if (pill.dataset.s !== st) {
        pill.dataset.s = st;
        if (!reduced() && st !== "load") {
          pill.classList.remove("swap");
          void pill.offsetWidth;
          pill.classList.add("swap");
        }
      }
      if ($("#statusText").textContent !== statusText) $("#statusText").textContent = statusText;
      const tb = $("#testBtn");
      tb.innerHTML = S.testing ? `${svg("stop", "ic ic-sm")}停止测试` : `${svg("play", "ic ic-sm")}测试连接`;
      tb.disabled = !S.testing && (S.busy || ["off", "load", "down", "cfgerr", "ctlerr", "connecting"].includes(st) || !isOn("github") && ["wait", "none", "prep"].includes(st));
      tb.title = tb.disabled ? { off: "插件已关闭，打开插件开关后可测试", wait: "先配置搜索来源或开启 GitHub 读取", none: "先开启一个待测项目" }[st] || "" : "";
      $("#testPop .pop-text").textContent = grokOn() ? "会逐一测试 Grok 和全部已开启的补充来源，Tavily 的每个 Key 单独检查，各次测试会消耗相应额度。正常搜索仍在补充链首个成功处停止。" : `Grok 未启用，会逐一测试 ${enabledSupp().map((id) => META[id].name).join("、") || "补充来源"} 的全部 Key，各次测试会消耗相应额度。正常搜索仍在首个成功处停止。`;
      if (isOn("github")) $("#testPop .pop-text").textContent = (!grokOn() && !enabledSupp().length ? "未启用网页搜索来源。" : $("#testPop .pop-text").textContent) + " GitHub 单独验证认证与少量公开内容读取，不代表网页搜索或私有仓库权限通过。";
      $("#hubMeta").innerHTML = `<span class="nw">${esc(S.program?.program?.version ? "v" + S.program.program.version : programPhase())}</span><span class="nw"><span class="hm-dot">· </span>${esc(programSource())}</span>`;
      const native = S.control?.acquisition?.authorSearchProvider;
      $("#nodeOfficial .node-name").textContent = native ? "原搜索设置" : "DeepSeek 官方搜索";
      $("#nodeOfficial").setAttribute("aria-hidden", String(st !== "off"));
    }
    function programPhase() {
      return {
        idle: "待准备",
        discovering: "检测中",
        "checking-version": "检查版本",
        downloading: "下载中",
        verifying: "验证中",
        ready: "已就绪",
        error: "准备失败",
        disposed: "已停止"
      }[S.program?.phase] || "等待程序";
    }
    function programSource() {
      const source = S.program?.program?.source;
      return ["manual", "loader"].includes(source) ? "手动指定" : ["path", "npm", "cargo"].includes(source) ? "已有安装" : source === "private-cache" ? "随插件安装" : "自动检测";
    }
    const stripSlot = $("#stripSlot");
    const stripEl = $("#strip");
    const stripNodes = /* @__PURE__ */ new Map();
    const routeTooltip = $("#routeTooltip");
    let stripTipTarget = null, stripTipTimer = 0;
    let stripSect = "";
    function hideStripTip() {
      clearTimeout2(stripTipTimer);
      stripTipTarget?.removeAttribute("aria-describedby");
      stripTipTarget = null;
      routeTooltip.hidden = true;
      routeTooltip.textContent = "";
      delete routeTooltip.dataset.kind;
    }
    function showStripTip(node) {
      const quotaTip = node?.matches("[data-quota-tip]");
      if (!node?.isConnected || (quotaTip ? node.closest("[inert]") || !dlg.contains(node) || overlay.hidden : !stripSlot.classList.contains("has"))) {
        hideStripTip();
        return;
      }
      clearTimeout2(stripTipTimer);
      if (stripTipTarget !== node) stripTipTarget?.removeAttribute("aria-describedby");
      stripTipTarget = node;
      routeTooltip.textContent = quotaTip ? node.dataset.quotaTip : node._tip;
      routeTooltip.dataset.kind = quotaTip ? "quota" : "route";
      routeTooltip.hidden = false;
      node.setAttribute("aria-describedby", "routeTooltip");
      const r = node.getBoundingClientRect();
      const t = routeTooltip.getBoundingClientRect();
      routeTooltip.style.left = Math.max(12, Math.min(innerWidth - t.width - 12, r.left + r.width / 2 - t.width / 2)) + "px";
      routeTooltip.style.top = Math.max(12, quotaTip && r.top - t.height - 8 >= 12 ? r.top - t.height - 8 : r.bottom + t.height + 10 < innerHeight ? r.bottom + 8 : r.top - t.height - 8) + "px";
    }
    stripEl.addEventListener("pointerover", (e) => {
      const node = e.target.closest(".s-node");
      if (node) showStripTip(node);
    });
    stripEl.addEventListener("pointerout", (e) => {
      if (e.relatedTarget && (stripTipTarget?.contains(e.relatedTarget) || routeTooltip.contains(e.relatedTarget))) return;
      stripTipTimer = setTimeout2(() => {
        if (stripTipTarget !== active()) hideStripTip();
      }, 100);
    });
    stripEl.addEventListener("focusin", (e) => {
      if (e.target.matches(".s-node")) showStripTip(e.target);
    });
    stripEl.addEventListener("focusout", (e) => {
      if (!stripEl.contains(e.relatedTarget)) hideStripTip();
    });
    routeTooltip.addEventListener("pointerenter", () => clearTimeout2(stripTipTimer));
    routeTooltip.addEventListener("pointerleave", () => {
      if (stripTipTarget !== active()) hideStripTip();
    });
    listen(document, "keydown", (e) => {
      if (e.key !== "Escape") return;
      if (stripTipTarget?.matches("[data-quota-tip]")) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
      hideStripTip();
    });
    listen(window, "resize", hideStripTip);
    listen(window, "scroll", (event) => {
      if (routeTooltip.contains(targetOf(event))) return;
      const node = stripTipTarget;
      if (node?.matches("[data-quota-tip]") && node.isConnected && active() === node) {
        const bounds = node.getBoundingClientRect(), body = node.closest(".dlg-body").getBoundingClientRect();
        if (bounds.bottom > Math.max(0, body.top) && bounds.top < Math.min(innerHeight, body.bottom) && bounds.right > 0 && bounds.left < innerWidth) {
          showStripTip(node);
          return;
        }
      }
      hideStripTip();
    }, true);
    function stripNode(m) {
      let n = stripNodes.get(m.id);
      if (!n) {
        n = document.createElement("span");
        n.className = "s-node";
        n.dataset.id = m.id;
        n.tabIndex = 0;
        n.setAttribute("role", "img");
        n.insertAdjacentHTML("beforeend", tile(m.id, 16, true));
        n.insertAdjacentHTML("beforeend", '<span class="s-dots" aria-hidden="true"></span>');
        stripNodes.set(m.id, n);
      }
      if (n.dataset.role !== m.role) n.dataset.role = m.role;
      if (n.dataset.st !== m.st) n.dataset.st = m.st;
      n.dataset.health = m.health;
      n.style.opacity = "1";
      n._tip = m.tip;
      n.setAttribute("aria-label", m.tip.replace(/\n/g, "；"));
      const dots = n.lastElementChild;
      const key = m.dots.map((d) => `${d.tone}:${d.tip}`).join(",");
      if (dots.dataset.k !== key) {
        dots.innerHTML = m.dots.map((d) => `<i class="s-dot" data-tone="${d.tone}"></i>`).join("");
        dots.dataset.k = key;
      }
      return n;
    }
    function placeStrip(list, key) {
      const beforeLeft = stripEl.getBoundingClientRect().left;
      const old = new Map($$(":scope > .s-node", stripEl).map((n) => [n, n.getBoundingClientRect().left - beforeLeft]));
      let at = stripEl.firstElementChild;
      list.forEach((n) => {
        if (n === at) {
          at = at.nextElementSibling;
          return;
        }
        stripEl.insertBefore(n, at);
      });
      while (at) {
        const next = at.nextElementSibling;
        at.remove();
        at = next;
      }
      if (old && !reduced()) {
        let moved = false;
        const afterLeft = stripEl.getBoundingClientRect().left;
        list.forEach((n) => {
          const left = n.getBoundingClientRect().left - afterLeft;
          const dx = (old.get(n) ?? left) - left;
          if (Math.abs(dx) > 0.5) {
            n.style.transition = "none";
            n.style.transform = `translateX(${dx}px)`;
            moved = true;
          }
        });
        if (moved) {
          void stripEl.offsetWidth;
          list.forEach((n) => {
            n.style.transition = "transform .32s var(--ease)";
            n.style.transform = "";
          });
        }
      }
      if (stripSect !== key) {
        stripSect = key;
        if (["broken", "detour", "end"].includes(key)) stripEl.querySelector(`.s-${key}`)?.classList.add("is-new");
      }
    }
    const linkSvg = (tone) => tone === "detour" ? '<svg class="s-link" data-tone="detour" viewBox="0 0 20 8" aria-hidden="true"><path class="sl-arc" pathLength="1" d="M0 4h4.5M8.2 4C10.1 4 9.3 1.3 11.8 1.3H15.8"/><path class="sl-head" d="M14.3 2.2L17 4l-2.7 1.8"/></svg>' : tone === "broken" ? '<svg class="s-link" data-tone="broken" viewBox="0 0 20 8" aria-hidden="true"><path class="sl-line" d="M0 4h5.2"/><path class="sl-line" d="M13.4 4h2.1"/><path class="sl-head" d="M14.9 2.2L17.2 4l-2.3 1.8"/><circle cx="6.7" cy="4" r="1" fill="currentColor"/><circle cx="11.9" cy="4" r="1" fill="currentColor"/></svg>' : tone === "dash" ? '<svg class="s-link" data-tone="dash" viewBox="0 0 20 8" aria-hidden="true"><path class="sl-line" d="M0 4h15.4"/><path class="sl-head" d="M14.2 2.2L16.5 4l-2.3 1.8"/></svg>' : '<svg class="s-link" data-tone="next" viewBox="0 0 20 8" aria-hidden="true"><path class="sl-line" d="M0 4h15.4"/><path class="sl-head" d="M14.2 2.2L16.5 4l-2.3 1.8"/></svg>';
    function stripLink(tone, idx) {
      stripEl._links = stripEl._links || /* @__PURE__ */ new Map();
      let el = stripEl._links.get(idx);
      if (!el || el.dataset.tone !== tone) {
        const holder = document.createElement("span");
        holder.innerHTML = linkSvg(tone);
        el = holder.firstElementChild;
        el.classList.add("is-new");
        stripEl._links.set(idx, el);
        setTimeout2(() => el.classList.remove("is-new"), 380);
      }
      return el;
    }
    function stripEnd(text, tone) {
      if (!stripEl._end) stripEl._end = document.createElement("span");
      stripEl._end.className = "s-end";
      stripEl._end.dataset.tone = tone || "";
      if (stripEl._end.textContent !== text) stripEl._end.textContent = text;
      return stripEl._end;
    }
    function verificationNode(id, trace, order) {
      const on = isOn(id);
      const slots = id === "tavily" ? tvKeyIdx() : [0];
      const dots = slots.map((slot) => {
        const saved = savedCheck(id, slot);
        const current = trace?.items.find((it) => it.id === id && (id !== "tavily" || it.key === slot));
        const running2 = on && current?.tone === "run";
        const tone = running2 ? "run" : saved.tone;
        const what = saved.record?.source === "search" ? "搜索" : "测试";
        const time = saved.record ? new Date(saved.record.at).toLocaleTimeString("zh-CN", { hour12: false }) : "";
        const detail = running2 ? trace.bg ? "搜索中" : "测试中" : tone === "idle" ? "尚未验证" : `最近${what}${tone === "ok" ? saved.record?.status === "empty" ? "连通，但无结果" : "通过" : `失败（${failureInfo(saved.code).status}：${errText(saved.code)}）`}${time ? " · " + time : ""}`;
        return { tone, tip: (id === "tavily" && slots.length > 1 ? `Key ${slot + 1}：` : "") + detail };
      });
      const passed = dots.filter((d) => d.tone === "ok").length;
      const failed = dots.filter((d) => d.tone === "err").length;
      const running = dots.some((d) => d.tone === "run");
      const health = running ? "run" : failed === dots.length ? "err" : failed ? "partial" : passed === dots.length ? "ok" : passed ? "partial" : "idle";
      const role = id === "grok" ? "主搜索" : id === "github" ? "GitHub 读取" : `补充来源 · 第 ${order.indexOf(id) + 1} 位`;
      const state = !isSet(id) ? "未配置" : on ? "已启用" : "已关闭";
      return {
        id,
        role: id === "grok" ? "primary" : id === "github" ? "extract" : "supp",
        st: on ? "on" : isSet(id) ? "off" : "unset",
        health,
        dots: on ? dots : [],
        tip: `${META[id].name} · ${role} · ${state}
${dots.map((d) => d.tip).join("\n")}
圆点不表示优先级；静态亮点仅表示最近通过，脉动才表示检测中。`
      };
    }
    function stripModel(orderOverride, trace) {
      const st = routeStatus();
      if (!trace && ["off", "wait", "none"].includes(st)) return { hidden: true };
      if (!trace && st === "load") {
        const bar = (w, h = 16) => `<span class="s-skel" style="width:${w}px;height:${h}px"></span>`;
        return { html: bar(16) + bar(14, 8) + bar(16) + bar(16) + bar(54, 9) };
      }
      const order = [...orderOverride || S.order];
      const supp = order.filter(isOn);
      const nodes = ["grok", ...supp, ...isOn("github") && !trace?.bg ? ["github"] : []].map((id) => verificationNode(id, trace, order));
      const between = [];
      for (let i = 1; i < nodes.length; i++) {
        between.push(nodes[i].health === "err" ? "broken" : i === 1 && !grokOn() ? "dash" : nodes[i - 1].health === "err" ? "detour" : "next");
      }
      const mode = trace ? trace.bg ? "搜索验证" : "逐项测试" : "最近验证结果";
      let label = `${mode}；图标顺序表示补充链优先级，圆点区分未验证、检测中与最近完成的结果。${nodes.map((n) => n.tip.split("\n").slice(0, -1).join("；")).join("；")}`;
      if (trace?.bg && trace.reroute) label += "；已尝试静默回退到补充来源";
      if (st === "err") label += S.lastRoute?.outcome === "failed" ? "；本次搜索未返回可用结果，没有回退官方搜索" : "；最近检查未通过，不代表发生过聊天搜索";
      const end = trace && trace.done ? { text: trace.done.text, tone: trace.done.tone === "ok" ? "ok" : "err" } : null;
      if (trace && trace.done) label += `；${trace.done.text}`;
      return { nodes, between, label, end };
    }
    function renderSummary(orderOverride) {
      const m = stripModel(orderOverride, orderOverride ? null : S.trace);
      if (m.hidden) {
        hideStripTip();
        stripSlot.classList.remove("has");
        stripEl.removeAttribute("aria-label");
        stripEl.removeAttribute("title");
        stripEl.replaceChildren();
        stripSect = "";
        return;
      }
      stripSlot.classList.add("has");
      stripEl.setAttribute("aria-label", m.label || "搜索路由");
      stripEl.removeAttribute("title");
      if (m.html) {
        hideStripTip();
        if (stripSect !== "load") {
          stripSect = "load";
          stripEl.innerHTML = m.html;
        }
        return;
      }
      const seq = [];
      m.nodes.forEach((n, i) => {
        if (i) seq.push(stripLink(m.between[i - 1] || "next", i - 1));
        seq.push(stripNode(n));
      });
      if (m.end) seq.push(stripEnd(m.end.text, m.end.tone));
      const key = m.end ? "end" : m.between.join(",");
      placeStrip(seq, key);
      if (stripTipTarget) showStripTip(stripTipTarget);
    }
    const ERR_TEXT = {
      400: "请求参数无效",
      401: "API Key 无效或鉴权失败",
      402: "额度或计费受限",
      403: "访问被拒绝",
      404: "接口不存在",
      405: "接口方法不支持",
      408: "请求超时",
      413: "请求过大",
      422: "请求参数不被接受",
      429: "限流或额度不足",
      500: "服务端错误",
      502: "上游网关错误",
      503: "服务暂不可用",
      504: "网关超时"
    };
    const NETWORK_ERRORS = {
      GROK_NETWORK_ERROR: ["网络", "Grok 网络连接失败"],
      TIMEOUT: ["超时", "请求超时"],
      ETIMEDOUT: ["超时", "请求超时"],
      NETWORK: ["网络", "连接失败"],
      ENOTFOUND: ["网络", "域名解析失败"],
      ECONNREFUSED: ["网络", "连接被拒绝"],
      ECONNRESET: ["网络", "连接中断"],
      CERT_HAS_EXPIRED: ["TLS", "证书已过期"],
      UNABLE_TO_VERIFY_LEAF_SIGNATURE: ["TLS", "证书校验失败"],
      INVALID_RESPONSE: ["响应", "响应格式异常"],
      RESPONSE_TOO_LARGE: ["响应", "响应超过上限"],
      OUTPUT_LIMIT: ["上限", "回复上限过小"],
      URL_INVALID: ["地址", "接口地址无效"],
      GROK_AUTH_ERROR: ["认证", "Grok 认证失败"],
      GROK_TIMEOUT: ["超时", "Grok 响应超时"],
      GROK_STAGE_TIMEOUT: ["等待", "主搜索等待较久，已尝试备用来源"],
      GROK_QUEUE_TIMEOUT: ["队列", "排队超时，请稍后重试"],
      SOURCE_BUDGET_EXHAUSTED: ["超时", "总预算已用尽，部分来源未尝试"],
      CONFIG_CONFLICT: ["配置", "配置已更新，请重新测试"],
      GROK_PARSE_ERROR: ["响应", "Grok 响应无法解析"],
      GROK_PROVIDER_ERROR: ["接口", "Grok 接口调用失败"],
      GROK_CONTENT_EMPTY: ["回答", "未返回回答内容"],
      GROK_SOURCES_EMPTY: ["来源", "未返回引用链接"],
      GROK_PROGRAM_MISSING: ["程序", "Grok 尚未就绪"],
      GROK_PROGRAM_PREPARING: ["程序", "Grok 正在准备"],
      GROK_CONFIG_INVALID: ["配置", "Grok 配置无效"],
      GROK_TOOL_ERROR: ["搜索", "Grok 搜索报告错误"],
      GROK_MCP_ERROR: ["MCP", "Grok 初始化或搜索失败"],
      GROK_CHILD_EXIT: ["进程", "Grok 意外退出"],
      GROK_PROCESS_ERROR: ["进程", "无法启动 Grok"],
      GROK_QUEUE_FULL: ["队列", "搜索队列已满"],
      GROK_SEARCH_STOPPING: ["停止", "插件正在停止"],
      GROK_SESSION_BUSY: ["队列", "Grok 会话忙"],
      GROK_VERSION_UNVERIFIED: ["版本", "Grok 版本未经验证"],
      GROK_PROTOCOL_UNVERIFIED: ["协议", "Grok 协议未经验证"],
      GROK_PROGRAM_INVALID: ["程序", "Grok 程序无效"],
      GROK_PROGRAM_START_FAILED: ["程序", "Grok 无法启动"],
      GROK_PROGRAM_CHANGED: ["程序", "Grok 程序已变化"],
      GROK_CACHE_DAMAGED: ["缓存", "程序缓存损坏"],
      GROK_CACHE_PATH_INVALID: ["路径", "程序缓存路径无效"],
      GROK_CACHE_ACCESS_DENIED: ["权限", "无法访问程序缓存"],
      GROK_CACHE_REPAIR_UNAVAILABLE: ["缓存", "请先重新检测程序"],
      GROK_PLATFORM_UNSUPPORTED: ["平台", "系统或架构不支持"],
      GROK_INSTALL_BUSY: ["安装", "程序正在安装"],
      GROK_PROGRAM_REAP_FAILED: ["回收", "程序回收未完成"],
      GROK_PROCESS_REAP_FAILED: ["回收", "进程回收未完成"],
      SETTINGS_UNAVAILABLE: ["连接", "设置服务不可用"],
      SOURCE_UNAVAILABLE: ["来源", "来源服务不可用"],
      FALLBACK_SOURCES_ZERO: ["配置", "回退来源数为 0"],
      GITHUB_AUTH: ["401", "Token 无效或鉴权失败"],
      GITHUB_FORBIDDEN: ["403", "权限不足或上游拒绝访问"],
      GITHUB_NOT_ACCESSIBLE: ["404", "资源不存在或无权访问"],
      GITHUB_RATE_LIMIT: ["限流", "GitHub 请求受限"],
      GITHUB_NETWORK: ["网络", "无法连接 GitHub"],
      GITHUB_TIMEOUT: ["超时", "读取时间已到，可继续读取"],
      GITHUB_CURSOR_INVALID: ["续读", "续读位置已失效"],
      GITHUB_STATE_CHANGED: ["配置", "配置已变化，请重新读取"],
      GITHUB_DISABLED: ["停用", "GitHub 读取已停用"],
      GITHUB_PERMISSION: ["权限", "读取工具被禁用或拒绝"],
      GITHUB_OUTPUT_LIMIT: ["上限", "输出空间不足"],
      GITHUB_CACHE_FULL: ["分段", "已到缓存边界，可续读"],
      GITHUB_PAGINATION: ["分页", "分页异常，未完整读取"]
    };
    function failureInfo(code) {
      const value = normalizeCode(code).toUpperCase();
      const status = /^\d{3}$/.test(value) ? Number(value) : 0;
      if (status >= 400 && status <= 599) {
        return { status: value, text: ERR_TEXT[status] || (status >= 500 ? "服务端错误" : "请求被拒绝"), code: value };
      }
      const named = NETWORK_ERRORS[value];
      return named ? { status: named[0], text: named[1], code: value } : value.startsWith("GROK_DOWNLOAD_") ? { status: "下载", text: "程序下载或校验失败", code: value } : value.startsWith("GROK_ARCHIVE_") ? { status: "安装", text: "程序包校验失败", code: value } : value.startsWith("GROK_PROGRAM_") ? { status: "程序", text: "Grok 程序准备失败", code: value } : { status: "异常", text: "请求失败", code: "UNKNOWN" };
    }
    const errText = (code) => [...new Set(String(code || "UNKNOWN").split("/").map((c) => failureInfo(c).text))].join("／");
    function failureHelp(code) {
      const value = normalizeCode(String(code || "").split("/")[0]).toUpperCase();
      if (value === "401") return "检查 API Key 是否正确、已过期或被撤销。";
      if (value === "403") return "检查账号、模型或接口权限；403 本身不证明额度已用完。";
      if (value === "402") return "检查该服务的额度、套餐或计费状态。";
      if (value === "429") return "稍后重试，并检查该服务的限额或额度。";
      if (["404", "405"].includes(value)) return "核对 Base URL 与接口路径。";
      if (["400", "413", "422"].includes(value)) return "核对模型与请求参数。";
      if (value === "CERT_HAS_EXPIRED" || value === "UNABLE_TO_VERIFY_LEAF_SIGNATURE") return "核对 HTTPS 证书与代理设置，不要关闭证书校验。";
      if (["408", "504", "TIMEOUT", "ETIMEDOUT"].includes(value)) return "核对网络与超时设置，稍后重试。";
      if (value === "GROK_AUTH_ERROR") return "检查 Grok Key 或原有登录凭据；上游未提供具体 HTTP 状态码。";
      if (value === "GROK_SOURCES_EMPTY") return "本次回答未提供可识别的来源链接，请检查模型联网能力与引用格式。";
      if (value === "GROK_CONTENT_EMPTY") return "本次未返回回答内容，请检查模型与接口响应。";
      if (value === "GROK_PARSE_ERROR") return "接口响应无法解析，请核对所选协议与服务商返回格式。";
      if (value === "GROK_PROVIDER_ERROR") return "核对 Base URL、接口协议与模型；该错误不单独表示 API Key 失效。";
      if (value === "GROK_VERSION_UNVERIFIED") return "此版本尚未通过插件验证；不会擅自升级或覆盖已有安装。";
      if (value === "OUTPUT_LIMIT") return "调大「回复字符上限」以容纳搜索链接；此结果不表示 Key 失效。";
      if (value === "GROK_CACHE_DAMAGED") return "在 Grok Search Rs 设置中点击「重新准备」；只恢复插件私有程序，不改共享配置或全局安装。";
      if (value === "GROK_CACHE_PATH_INVALID") return "检查插件缓存目录及链接；不会绕过路径检查或修改其他位置。";
      if (value === "GROK_CACHE_ACCESS_DENIED") return "检查插件缓存目录的读写权限后重新检测。";
      if (value.startsWith("GROK_DOWNLOAD_") || value.startsWith("GROK_ARCHIVE_")) return "检查网络或程序缓存，在 Grok Search Rs 设置中重新检测。";
      if (value.startsWith("GROK_PROGRAM_") || value.startsWith("GROK_PROCESS_")) return "检查程序状态，在 Grok Search Rs 设置中重新检测；不会修改全局安装。";
      if (value.startsWith("GROK_")) return "核对 Grok 程序、Base URL 和模型；该错误不单独证明 Key 失效。";
      if (NETWORK_ERRORS[value]) return "核对 Base URL、网络或代理设置。";
      if (Number(value) >= 500) return "上游服务异常，可稍后重试。";
      return "检查接口配置或服务端返回详情，不能仅凭此错误判断 Key 失效。";
    }
    function rowFault(id) {
      if (S.loading || !S.plugin || !isOn(id)) return null;
      if (id === "grok" && S.program?.error && !S.bad.grok) {
        const info = failureInfo(S.program.error.code);
        return { ...info, tone: "err", detail: `${info.status} · ${info.text}。${failureHelp(info.code)}` };
      }
      if (id === "tavily" && S.providerBad.tavily && !S.bad.tavily) {
        const info = failureInfo(S.providerBad.tavily.code);
        return { ...info, tone: "err", detail: `${info.status} · ${info.text}。最近搜索未获得 Tavily 结果；宿主未报告具体 Key，不能判断每个 Key 都失效。${failureHelp(info.code)}` };
      }
      const slots = id === "tavily" ? tvKeyIdx() : [0];
      const faults = slots.flatMap((slot) => {
        const running = S.trace?.items.some((it) => it.id === id && (id !== "tavily" || it.key === slot) && it.tone === "run");
        const check = savedCheck(id, slot);
        return !running && check.tone === "err" ? [{ slot, ...failureInfo(check.code) }] : [];
      });
      if (!faults.length) return null;
      const statuses = [...new Set(faults.map((f) => f.status))];
      const reasons = [...new Set(faults.map((f) => f.text))];
      const prefix = id === "tavily" && slots.length > 1 && faults.length === 1 ? `Key ${faults[0].slot + 1} · ` : "";
      const status = prefix + (statuses.length <= 2 ? statuses.join("/") : `${statuses.slice(0, 2).join("/")} +${statuses.length - 2}`);
      const text = faults.length === 1 ? faults[0].text : `${faults.length} 个 Key ${reasons.length === 1 ? reasons[0] : "不可用"}`;
      const details = faults.map((f) => {
        const key = id === "tavily" && slots.length > 1 ? `Key ${f.slot + 1}：` : "";
        return `${key}${f.status} · ${f.text}。${failureHelp(f.code)}`;
      });
      if (id === "tavily" && faults.length < slots.length) {
        const verified = slots.some((slot) => savedCheck(id, slot).tone === "ok");
        details.push(verified ? "其他 Key 已验证可用，此来源仍可使用。" : "仅这些 Key 已知失败，其他 Key 尚未全部验证。");
      }
      details.push("点击供应商名称打开配置。");
      return { status, text, tone: faults.length < slots.length ? "partial" : "err", detail: details.join("\n") };
    }
    function failList() {
      const parts = [];
      ["grok", ...enabledSupp()].forEach((id) => {
        if (!isOn(id) || !(S.bad[id] || S.providerBad[id])) return;
        if (id === "tavily") {
          if (!S.bad.tavily) {
            parts.push(`Tavily 最近搜索返回 ${S.providerBad.tavily.code}（未定位具体 Key）`);
            return;
          }
          const n = tvKeyIdx().filter((i) => S.bad.tavily[i]).length;
          const all = n === tvKeyIdx().length;
          parts.push(`Tavily ${all && n > 1 ? `${n} 个 Key 均` : `${n} 个 Key`}返回 ${codeOf("tavily")}`);
        } else parts.push(`${META[id].name} 返回 ${codeOf(id)}`);
      });
      return parts;
    }
    let bannerHtml = null;
    function renderBanner() {
      const slot = $("#bannerSlot");
      const st = routeStatus();
      let html = "";
      const B = (tone, ic, title, text, actions = "", iconOnly) => `<div class="banner" data-tone="${tone}"><span class="b-ic">${svg(ic)}</span><span class="b-body"><span class="b-title">${title}</span><span class="b-text">${text}</span></span><span class="b-actions${iconOnly ? " is-icon" : ""}">${actions}</span></div>`;
      const btn = (act, label, primary) => `<button type="button" class="btn btn-sm${primary ? " btn-primary" : ""}" data-act="${act}">${label}</button>`;
      const sv = servingSupp();
      if (st === "down") {
        html = B("err", "info", "设置服务暂不可用", esc(S.rpcError.message), btn("retry", "重试"));
      } else if (st === "cfgerr") {
        html = B("err", "info", "配置文件无法读取", `${esc(S.config.error.code || "CONFIG_ERROR")} · ${esc(S.config.error.message)} 搜索会明确报错，不会回退官方搜索。`, btn("open-file", "打开文件"));
      } else if (st === "ctlerr") {
        html = B(
          "err",
          "info",
          "接管状态异常",
          `${esc(S.control?.error?.code || S.control?.phase || "CONTROL_ERROR")} · 路由尚未确认；重试继续未完成的停用，否则仅检查状态。`,
          `<button type="button" class="btn btn-sm" data-act="retry-control"${controlRetrying ? ' disabled aria-busy="true"' : ""}>${controlRetrying ? "处理中…" : "重试"}</button>`
        );
      } else if (st === "connecting") {
        html = B("info", "info", "正在确认搜索接管", "此时不把配置记录当成路由完成；等待宿主实际就绪。");
      } else if (st === "prep") {
        html = B("info", "info", "正在准备 Grok 程序", `${esc(programPhase())}。可先填写配置；准备期间搜索会明确报错，不回退官方搜索。`);
      } else if (st === "off") {
        html = B("info", "info", "已恢复原搜索设置，无需重启", "配置已保留。请在插件页使用 dsh-grok-search 的原生开关重新启用。");
      } else if (st === "backup" && grokDiagnosticFailed()) {
        const ready = enabledSupp().filter(testedSourceReady).map((id) => META[id].name).join("、");
        const code = codeOf("grok");
        html = B(
          "fallback",
          "info",
          `Grok 测试未通过，${ready} 可用`,
          `${esc(code)} · ${errText(code)}。以上为逐项检查结果，尚未发生实际搜索回退。`,
          btn("open:grok", "检查 Grok 配置") + btn("grok-off", "关闭 Grok")
        );
      } else if (st === "fallback") {
        const observed = S.lastRoute?.resultProviders?.length ? S.lastRoute.resultProviders.filter((id) => META[id]).map((id) => META[id].name).join(" / ") + (S.lastRoute.resultProvidersComplete ? "" : " / 来源未报告") : unknownFallback() ? "来源未报告" : META[sv]?.name || "补充来源";
        const grokCode = codeOf("grok") || S.program?.error?.code;
        const rotates = sv && codeOf(sv).split("/").every((code) => TAVILY_ROTATE.has(code));
        const part = sv && isPart(sv) ? `；${META[sv].name} 有 Key 返回 ${codeOf(sv)}${rotates ? "，可换用其他 Key" : "，各 Key 的验证结果单独保留"}` : "";
        html = B(
          "fallback",
          "reroute",
          `Grok ${failureInfo(grokCode).status} · ${errText(grokCode)}，已静默回退到 ${observed}`,
          `搜索照常可用，${S.lastRoute?.provenance === "source-label" ? "来源按返回结果确认" : "结果来自补充来源"}${part}。修好 Grok 后自动切回，不会回退官方搜索。`,
          btn("open:grok", "检查 Grok 配置") + btn("grok-off", "关闭 Grok")
        );
      } else if (st === "err") {
        const fails = failList();
        const first = ["grok", ...enabledSupp()].find((id) => isOn(id) && (S.bad[id] || S.providerBad[id]));
        const searched = S.lastRoute?.outcome === "failed";
        const title = searched ? "主搜与补充来源未返回可用结果" : grokDiagnosticFailed() ? "Grok 测试未通过" : "最近检查未通过";
        const code = first ? codeOf(first) : S.program?.error?.code;
        const detail = first && fails.length <= 1 && code ? `${META[first].name} ${esc(code)} · ${errText(code)}。` : fails.length ? esc(fails.join("；")) + "。" : `${esc(code || "GROK_UNAVAILABLE")} · ${errText(code)}。`;
        const text = detail + (searched ? "本次搜索已明确报错，没有回退官方搜索。" : S.testing ? "正在继续逐项检查，其余来源的结果将分别显示。" : "尚未验证到返回结果的搜索来源；各来源的连通状态见上方图标。未调用官方搜索。");
        html = B("err", "errc", title, text, btn("open:" + (first || "grok"), `检查 ${META[first || "grok"].name} 配置`));
      } else if (st === "wait") {
        html = B("warn", "warn", "还差一步：填写一个搜索 Key", "推荐 Grok（带来源的回答）；只填 Tavily、Exa 等补充来源的 Key 也能搜索。未配置前搜索会明确报错，不会悄悄回退官方搜索。", btn("open:grok", "填写 Grok Key", true));
      } else if (st === "none") {
        const act = isSet("grok") ? btn("grok-on", "启用 Grok", true) : btn("open:" + (SUPP.find((id) => isSet(id)) || "grok"), "启用补充来源", true);
        html = B("warn", "warn", "Grok 与补充来源都已关闭", "现在搜索会明确报错。想恢复原搜索，请在插件页关闭 dsh-grok-search。", act);
      } else {
        const aux = enabledSupp().find((id) => isBad(id) || isPart(id));
        const auxKey = aux ? `${aux}:${codeOf(aux)}:${isBad(aux)}` : "";
        if (aux && S.auxDismissed !== auxKey) {
          const rotates = codeOf(aux).split("/").every((code) => TAVILY_ROTATE.has(code));
          const title = isBad(aux) ? `${META[aux].name} 最近检查失败 · ${codeOf(aux)}` : `${META[aux].name} 部分 Key 返回 ${codeOf(aux)}${rotates ? "，其他 Key 可用" : ""}`;
          html = B(
            "soft",
            "warn",
            title,
            `${errText(codeOf(aux))}。其余来源照常工作，搜索不受影响。`,
            btn("open:" + aux, `检查 ${META[aux].name}`) + `<button type="button" class="icon-btn" data-act="dismiss-aux" data-k="${auxKey}" aria-label="关闭提示">${svg("x")}</button>`
          );
        } else if (!S.capabilities?.secretsAllowed) {
          html = B("info", "lock", "当前连接仅显示脱敏配置", `${esc(S.capabilities?.reason || "请在已认证的本机直连或 HTTPS 连接下查看和保存 Key。")} 仍可在服务器端执行连通性测试。`);
        } else if (S.readBanner && !S.readDismissed) {
          const found = ["grok", ...S.order, "github"].filter((id) => isSet(id));
          html = B(
            "info",
            "ok",
            "已读取现有配置，无需重新填写",
            `来自 <code style="font:500 11.5px var(--mono)">${esc(configLocation().label)}</code>：<span class="chip-list">${found.map((id) => `<span class="mini-chip">${tile(id, 14)}${META[id].name}</span>`).join("")}</span>`,
            `<button type="button" class="icon-btn" data-act="dismiss-read" aria-label="关闭提示">${svg("x")}</button>`,
            true
          );
        }
      }
      if (html === bannerHtml) return;
      const had = !!bannerHtml;
      bannerHtml = html;
      if (html) {
        slot.innerHTML = `<div><div class="${had && !reduced() ? "b-swap" : ""}">${html}</div></div>`;
        slot.classList.add("has");
      } else {
        slot.classList.remove("has");
        setTimeout2(() => {
          if (!bannerHtml) slot.innerHTML = "";
        }, 340);
      }
      pumpWires(380);
    }
    function renderFoot() {
      const config = configLocation();
      $("#cfgPath").textContent = config.label;
      $("#cfgPath").title = config.full;
      const tag = $("#cfgTag");
      if (S.cfgExists) {
        tag.textContent = "Grok 共享配置";
        tag.dataset.tone = "agent";
        tag.title = "保存后写入此 Grok 配置文件。其他使用同一文件的应用也会读取这些设置；使用独立配置的应用不受影响。";
      } else {
        tag.textContent = "首次保存时创建";
        tag.dataset.tone = "warn";
        tag.removeAttribute("title");
      }
      const fb = $("[data-open=file]");
      fb.title = S.cfgExists ? "" : "文件尚未创建，首次保存后可打开";
      syncPathOpening();
    }
    function syncAll(keepTrace) {
      if (!keepTrace && !S.testing && S.trace) {
        S.trace = null;
        clearTimeout2(S.traceTimer);
      }
      renderHead();
      renderSummary();
      renderBanner();
      renderFoot();
      syncRows();
      pumpWires();
    }
    let toastTimer = 0;
    function clearToasts() {
      clearTimeout2(toastTimer);
      $("#toasts").replaceChildren();
    }
    function toast(text, opt = {}) {
      const box = $("#toasts");
      clearTimeout2(toastTimer);
      const tone = opt.tone || "ok";
      const icon = { ok: "ok", err: "errc", warn: "warn", info: "info" }[tone];
      const el = document.createElement("div");
      const action = opt.undo ? { label: "撤销", icon: "undo", run: opt.undo } : opt.action;
      el.className = "toast" + (action ? "" : " no-act");
      el.dataset.tone = tone;
      el.innerHTML = `<span class="t-ic">${svg(icon)}</span><span class="t-text">${esc(text)}</span>${action ? `<button type="button" class="t-act">${svg(action.icon || "copy", "ic ic-sm")}${esc(action.label)}</button>` : ""}`;
      if (action) el.querySelector(".t-act").addEventListener("click", () => {
        dismissToast(el);
        Promise.resolve().then(() => action.run()).catch((error) => operationError(error));
      });
      box.replaceChildren(el);
      toastTimer = setTimeout2(() => dismissToast(el), opt.ms || (action ? 5200 : 3200));
    }
    function dismissToast(el) {
      if (!el.isConnected || el.classList.contains("is-out")) return;
      el.classList.add("is-out");
      setTimeout2(() => el.remove(), 180);
    }
    const shakeCleanups = /* @__PURE__ */ new WeakMap();
    function shake(el) {
      if (!el) return;
      shakeCleanups.get(el)?.();
      el.classList.remove("shake");
      void el.offsetWidth;
      el.classList.add("shake");
      let timer, offEnd, offCancel;
      const clean = () => {
        clearTimeout2(timer);
        el.classList.remove("shake");
        offEnd?.();
        offCancel?.();
        shakeCleanups.delete(el);
      };
      const end = (event) => {
        if (event.target === el && event.animationName === "shake") clean();
      };
      shakeCleanups.set(el, clean);
      offEnd = listen(el, "animationend", end);
      offCancel = listen(el, "animationcancel", end);
      timer = setTimeout2(clean, reduced() ? 0 : 450);
    }
    function bump(el) {
      if (!el) return;
      el.classList.remove("tick");
      void el.offsetWidth;
      el.classList.add("tick");
      setTimeout2(() => el.classList.remove("tick"), 720);
    }
    const rowOf = (id) => $(`#colList .row[data-id="${id}"]`);
    function cancelTest({ preserve = false } = {}) {
      logView?.cancel();
      const running = S.testing;
      gen++;
      const operationId = S.diagnosticOperation;
      S.diagnosticOperation = null;
      if (operationId) void remote.cancelDiagnosis({ operationId }).catch((error) => {
        if (!disposed) operationError(Object.assign(new Error("取消请求未确认，已发出的请求仍可能消耗额度。"), { code: "SETTINGS_CANCEL_UNCONFIRMED" }));
      });
      S.testing = false;
      clearTimeout2(S.testProgressTimer);
      const progress = S.testProgress;
      S.testProgress = null;
      if (preserve && S.trace) {
        for (const item of S.trace.items) if (item.tone === "run") {
          item.tone = "idle";
          item.code = "";
        }
        S.trace.done = { tone: "idle", text: `已停止 · ${progress?.completed ?? 0}/${progress?.total ?? 0} 项完成` };
      } else S.trace = null;
      S.lastRoute = null;
      clearTimeout2(S.traceTimer);
      hideStripTip();
      clearLit();
      clearToasts();
      if (running) $("#announcer").textContent = preserve ? "测试已停止，保留已完成结果，其余项目未完成；已发出的请求仍可能消耗额度。" : "路由已改变，本次测试已取消。可按新配置重新测试。";
    }
    function cancelOwnedDiagnosis() {
      const operationId = S.diagnosticOperation;
      S.diagnosticOperation = null;
      if (operationId) void remote.cancelDiagnosis({ operationId }).catch(() => {
      });
    }
    let suppressClick = false;
    const colList = $("#colList");
    colList.addEventListener("click", (e) => {
      const row = e.target.closest(".row");
      if (!row || S.loading || S.busy) return;
      if (suppressClick) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      const id = row.dataset.id;
      if (e.target.closest(".switch")) onRowSwitch(id, row);
      else if (e.target.closest(".row-main")) openCard(id, { from: row.querySelector(".row-main") });
    });
    async function onRowSwitch(id, row) {
      if (S.busy || disposed) return;
      const sw = row.querySelector(".switch");
      if (!isSet(id)) {
        openCard(id, { from: sw, enable: true });
        return;
      }
      const prev = S.prov[id].enabled !== false, on = !prev;
      if (id === "github" && on) {
        openCard(id, { from: sw, enable: true });
        return;
      }
      cancelTest();
      S.busy = true;
      S.prov[id].enabled = on;
      syncAll(true);
      const persist = async (value) => {
        if (id === "grok" || id === "github") await savePreference(id, value);
        else await saveConfig((fields) => sourceChain.plan(fields, { kind: "toggle", id, on: value }));
      };
      try {
        await persist(on);
        if (disposed) return;
        const text = id === "grok" ? on ? "已启用 Grok 主搜索 · 当场生效" : "已关闭 Grok · 搜索直接走补充来源 · 仅对 DSH 生效" : id === "github" ? `${on ? "已开启" : "已关闭"} GitHub 读取 · Token 未更改` : `已${on ? "启用" : "停用"} ${META[id].name} · 已写入 Grok 共享配置`;
        toast(text, { tone: "info", undo: async () => {
          if (disposed || S.busy) return;
          S.busy = true;
          try {
            await persist(prev);
            if (!disposed) {
              syncAll(false);
              toast("已撤销开关修改");
            }
          } catch (error) {
            operationError(error);
          } finally {
            S.busy = false;
            if (!disposed) syncAll(true);
          }
        } });
      } catch (error) {
        S.prov[id].enabled = prev;
        await refresh({ force: true });
        operationError(error);
      } finally {
        S.busy = false;
        if (!disposed) {
          syncAll(true);
          pumpWires(420);
        }
      }
    }
    colList.addEventListener("pointerover", (e) => {
      const row = e.target.closest(".row");
      $$(".wg.hl", wiresEl).forEach((g) => g.classList.remove("hl"));
      if (row && !drag) wireNodes.get("hub-" + row.dataset.id)?.classList.add("hl");
    });
    colList.addEventListener("pointerleave", () => $$(".wg.hl", wiresEl).forEach((g) => g.classList.remove("hl")));
    let drag = null;
    let pinnedHintShown = false;
    colList.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || S.loading || S.busy || drag) return;
      const row = e.target.closest(".row");
      if (!row || e.target.closest(".switch")) return;
      if (row.dataset.drag === "true" && chain().orderLocked) return;
      drag = { row, id: row.dataset.id, x0: e.clientX, y0: e.clientY, pid: e.pointerId, active: false, movable: row.dataset.drag === "true", warned: false };
      drag.off = [listen(window, "pointermove", onDragMove, { passive: false }), listen(window, "pointerup", onDragEnd), listen(window, "pointercancel", onDragEnd)];
    });
    function onDragMove(e) {
      if (!drag || e.pointerId !== drag.pid) return;
      const dy = e.clientY - drag.y0;
      const dist = Math.hypot(e.clientX - drag.x0, dy);
      if (!drag.movable) {
        if (dist > 12 && !drag.warned) {
          drag.warned = true;
          suppressClick = true;
          shake(drag.row);
          if (!pinnedHintShown) {
            pinnedHintShown = true;
            toast(drag.id === "grok" ? "Grok 固定为主搜索，不参与排序" : "GitHub 是专用抽取，按链接自动触发，不参与排序", { tone: "info" });
          }
        }
        return;
      }
      if (!drag.active) {
        if (dist < 4) return;
        startDrag();
      }
      e.preventDefault();
      const d = drag;
      let off = dy;
      const lo = d.slots[0] - d.slots[d.from];
      const hi = d.slots[d.n - 1] - d.slots[d.from];
      if (off < lo) off = lo - rubber(lo - off);
      if (off > hi) off = hi + rubber(off - hi);
      d.row.style.transform = `translateY(${off}px) scale(1.02)`;
      const to = nearestSlot(d.slots[d.from] + off + d.h / 2, d);
      if (to !== d.to) {
        d.to = to;
        d.rows.forEach((r, i) => {
          if (r === d.row) return;
          let shift = 0;
          if (d.from < to && i > d.from && i <= to) shift = -d.step;
          if (d.from > to && i < d.from && i >= to) shift = d.step;
          r.style.transform = shift ? `translateY(${shift}px)` : "";
        });
        d.ghost.style.transform = `translateY(${d.slots[to] - d.slots[d.from]}px)`;
        renderSummary(previewOrder(d));
      }
    }
    const rubber = (x) => 18 * (1 - Math.exp(-x / 60));
    function nearestSlot(center, d) {
      let best = 0, bd = Infinity;
      d.slots.forEach((s, i) => {
        const c = s + d.h / 2;
        const dd = Math.abs(c - center);
        if (dd < bd) {
          bd = dd;
          best = i;
        }
      });
      return best;
    }
    function startDrag() {
      const d = drag;
      const wrap = $("#rowsSupp");
      d.rows = $$(".row", wrap);
      d.rows.forEach((row) => row.classList.remove("enter"));
      void wrap.offsetWidth;
      d.n = d.rows.length;
      d.from = d.rows.indexOf(d.row);
      d.to = d.from;
      const wr = wrap.getBoundingClientRect();
      d.slots = d.rows.map((r) => r.getBoundingClientRect().top - wr.top);
      d.h = d.row.offsetHeight;
      d.step = d.n > 1 ? d.slots[1] - d.slots[0] : d.h + 6;
      d.ghost = document.createElement("div");
      d.ghost.className = "drop-ghost";
      d.ghost.style.top = d.slots[d.from] + "px";
      d.ghost.style.height = d.h + "px";
      wrap.prepend(d.ghost);
      wrap.classList.add("is-sorting");
      d.row.classList.add("is-dragging");
      d.row.style.transition = "box-shadow .2s, border-color .2s";
      root.classList.add("is-grabbing");
      $$(".wg.hl", wiresEl).forEach((g) => g.classList.remove("hl"));
      d.active = true;
      suppressClick = true;
      try {
        d.row.setPointerCapture(d.pid);
      } catch (_) {
      }
      const loop = () => {
        if (!drag || !drag.active) return;
        drawWires();
        drag.raf = requestAnimationFrame2(loop);
      };
      d.raf = requestAnimationFrame2(loop);
    }
    function previewOrder(d) {
      const ids = d.rows.map((r) => r.dataset.id);
      const [m] = ids.splice(d.from, 1);
      ids.splice(d.to, 0, m);
      return ids;
    }
    function onDragEnd(e) {
      if (!drag || e && e.pointerId !== drag.pid) return;
      const d = drag;
      d.off.forEach((off) => off());
      drag = null;
      setTimeout2(() => {
        suppressClick = false;
      }, 0);
      if (!d.active) return;
      cancelAnimationFrame2(d.raf);
      root.classList.remove("is-grabbing");
      const wrap = $("#rowsSupp");
      const cancelled = S.loading || e && e.type === "pointercancel";
      const ids = cancelled ? d.rows.map((r) => r.dataset.id) : previewOrder(d);
      d.ghost.remove();
      flipTo(ids, () => {
        wrap.classList.remove("is-sorting");
        d.row.classList.remove("is-dragging");
        d.row.style.transition = "";
      });
      if (!cancelled && ids.join() !== S.order.join()) commitOrder(ids, S.order.slice());
      else renderSummary();
    }
    function cancelDrag() {
      if (!drag) return;
      const d = drag;
      drag = null;
      d.off.forEach((off) => off());
      cancelAnimationFrame2(d.raf);
      if (d.row.hasPointerCapture?.(d.pid)) d.row.releasePointerCapture(d.pid);
      d.ghost?.remove();
      (d.rows || [d.row]).forEach((row) => {
        row.style.transition = "";
        row.style.transform = "";
        row.classList.remove("is-dragging");
      });
      $("#rowsSupp").classList.remove("is-sorting");
      root.classList.remove("is-grabbing");
      suppressClick = false;
    }
    function flipTo(ids, done) {
      const wrap = $("#rowsSupp");
      const rows = $$(".row", wrap);
      const first = new Map(rows.map((r) => [r, r.getBoundingClientRect().top]));
      const focused = active();
      rows.forEach((r) => {
        r.style.transition = "none";
        r.style.transform = "";
      });
      ids.forEach((id) => wrap.appendChild(wrap.querySelector(`.row[data-id="${id}"]`)));
      if (focused && wrap.contains(focused)) focused.focus({ preventScroll: true });
      rows.forEach((r) => {
        const dy = first.get(r) - r.getBoundingClientRect().top;
        r.style.transform = dy ? `translateY(${dy}px)` : "";
      });
      void wrap.offsetWidth;
      rows.forEach((r) => {
        r.style.transition = reduced() ? "none" : "transform .32s cubic-bezier(.2,.7,.2,1), box-shadow .2s, border-color .2s";
        r.style.transform = "";
      });
      pumpWires(380);
      setTimeout2(() => {
        rows.forEach((r) => {
          r.style.transition = "";
        });
        done && done();
      }, reduced() ? 0 : 340);
    }
    async function commitOrder(ids, prev) {
      if (S.busy || disposed) return;
      cancelTest();
      S.busy = true;
      S.order = ids.slice();
      syncAll(true);
      pumpWires(380);
      try {
        await saveConfig((fields) => sourceChain.plan(fields, { kind: "order", order: ids }));
        if (disposed) return;
        toast(`已按 ${ids.map((id) => META[id].name).join(" › ")} 写入 Grok 共享配置`, {
          undo: () => commitOrder(prev, ids)
        });
      } catch (error) {
        S.order = prev.slice();
        flipTo(prev);
        await refresh({ force: true });
        operationError(error);
      } finally {
        S.busy = false;
        if (!disposed) syncAll(true);
      }
    }
    colList.addEventListener("keydown", (e) => {
      const main = e.target.closest(".row-main");
      if (S.loading || S.busy || !main || !e.altKey || e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      e.preventDefault();
      const row = main.closest(".row");
      const id = row.dataset.id;
      if (row.dataset.drag === "true" && chain().orderLocked) {
        toast("搜索顺序由环境变量控制，不能在此排序。", { tone: "info" });
        return;
      }
      if (row.dataset.drag !== "true") {
        shake(row);
        toast(id === "grok" ? "Grok 固定为主搜索，不参与排序；可用开关关闭" : "GitHub 是专用抽取，不参与排序", { tone: "info" });
        return;
      }
      const i = S.order.indexOf(id);
      const j = i + (e.key === "ArrowUp" ? -1 : 1);
      if (j < 0 || j >= S.order.length) {
        shake(row);
        return;
      }
      const prev = S.order.slice();
      const ids = S.order.slice();
      ids.splice(i, 1);
      ids.splice(j, 0, id);
      flipTo(ids);
      commitOrder(ids, prev);
    });
    const overlay = $("#overlay");
    const dlg = $("#dialog");
    const testPop = $("#testPop");
    let D = null;
    let closeTimer = 0;
    let overlayEntranceTimer = 0;
    let gen = 0;
    const dialogBusy = () => !!D && (D.saving || D.clearing);
    function resetClearConfirmation() {
      if (!D) return;
      clearTimeout2(D.clearTimer);
      D.clearTimer = 0;
      D.clearArmed = false;
      const button = $("[data-a=clear]", dlg);
      if (button) {
        button.classList.remove("is-confirm");
        button.textContent = "清除配置";
      }
    }
    function lockDialog() {
      $$("button, input", dlg).forEach((el) => {
        el.disabled = true;
      });
    }
    function showOverlay() {
      hideStripTip();
      logView?.hideTip();
      clearTimeout2(closeTimer);
      overlay.classList.remove("is-closing");
      if (overlay.hidden) {
        clearToasts();
        overlay.hidden = false;
        dlg.classList.remove("is-in");
        clearTimeout2(overlayEntranceTimer);
        overlayEntranceTimer = setTimeout2(() => {
          overlayEntranceTimer = 0;
          if (!overlay.hidden && D) dlg.classList.add("is-in");
        }, reduced() ? 0 : 300);
      }
    }
    function hideOverlay(cb) {
      hideStripTip();
      clearTimeout2(overlayEntranceTimer);
      shakeCleanups.get(dlg)?.();
      overlay.classList.add("is-closing");
      closeTimer = setTimeout2(() => {
        overlay.hidden = true;
        overlay.classList.remove("is-closing");
        dlg.innerHTML = "";
        if (cb) cb();
      }, reduced() ? 0 : 150);
    }
    function closeDialog(force) {
      if (!D) return;
      if (dialogBusy() && !force) return;
      if (!force && isDirty() && !D.warned) {
        D.warned = true;
        shake(dlg);
        const fn = $(".foot-note", dlg);
        if (fn) fn.innerHTML = "<b>有未保存的修改</b> · 再按一次 Esc 或点空白处放弃修改";
        return;
      }
      quotaView?.cancel();
      if (D.githubOperation) void remote.cancelDiagnosis({ operationId: D.githubOperation }).catch(() => {
      });
      const back = D.returnFocus;
      const id = D.id;
      clearTimeout2(D.clearTimer);
      D.closed = true;
      $$("input[data-k]", dlg).forEach((input) => {
        if (!["key", "gwKey", "token", "keys"].includes(input.dataset.k.split(".")[0])) return;
        input.value = "";
        input.removeAttribute("value");
        input.type = "password";
        input.readOnly = true;
        input.disabled = true;
      });
      $$("[data-a=eye], [data-a=copy]", dlg).forEach((button) => {
        button.disabled = true;
      });
      D = null;
      hideOverlay(() => {
        const target = back && back.isConnected ? back : id ? rowOf(id)?.querySelector(".row-main") : null;
        if (target) target.focus({ preventScroll: true });
      });
    }
    overlay.addEventListener("pointerdown", (e) => {
      if (e.target === overlay) closeDialog(false);
    });
    listen(document, "keydown", (e) => {
      if (!overlay.hidden && D) {
        const mode = targetOf(e).closest?.("[data-a=mode]");
        if (mode && !mode.disabled && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) {
          e.preventDefault();
          const modes = $$("[data-a=mode]", dlg).filter((button) => !button.disabled);
          const step2 = e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1;
          const next = e.key === "Home" ? modes[0] : e.key === "End" ? modes.at(-1) : modes[(modes.indexOf(mode) + step2 + modes.length) % modes.length];
          if (next) {
            setMode(next);
            $("[data-a=mode][aria-checked=true]", dlg)?.focus({ preventScroll: true });
          }
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          closeDialog(false);
          return;
        }
        if (e.key === "Tab") {
          trapTab(e);
          return;
        }
        if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229) {
          const t = targetOf(e);
          if (t.matches && t.matches("input[data-k]:not([type=checkbox]):not([readonly])")) {
            e.preventDefault();
            save();
          }
        }
        return;
      }
      if (e.key === "Escape" && !testPop.hidden) closePop(true);
    });
    function focusables() {
      return $$('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])', dlg).filter((el) => !el.disabled && !el.closest("[inert]") && el.getClientRects().length);
    }
    function trapTab(e) {
      const f = focusables();
      if (!f.length) {
        e.preventDefault();
        return;
      }
      const first = f[0];
      const last = f[f.length - 1];
      if (!dlg.contains(active())) {
        e.preventDefault();
        first.focus();
        return;
      }
      if (e.shiftKey && active() === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active() === last) {
        e.preventDefault();
        first.focus();
      }
    }
    function initialFocus() {
      if (!D) return;
      if (dlg.contains(active()) && active()?.matches("input,select,textarea,button,a")) return;
      let el = null;
      if (D.kind === "card") {
        const kk = { grok: D.draft.mode === "compat" ? "gwKey" : "key", tavily: "keys.0", github: "token" }[D.id] || "key";
        const ki = dlg.querySelector(`input[data-k="${kk}"]`);
        if (ki && !ki.value && !ki.dataset.hidden && !ki.readOnly) el = ki;
      }
      if (!el) el = dlg.querySelector("[data-a=close]");
      if (el) el.focus({ preventScroll: true });
    }
    const fid = (k) => "f-" + k.replace(/\./g, "-");
    function field({ label, hint, k, msg, ctl, help }) {
      const tag = k ? "label" : "span";
      const slot = msg || k;
      const sourceKey = D?.kind === "card" ? CARD_FIELDS[D.id]?.[k?.startsWith("keys.") ? "keys" : k] : HUB_FIELDS[k];
      const environment = D?.fields?.[sourceKey]?.source === "environment";
      const locked = k && fieldReadOnly(k) ? `<small${environment ? ' title="此项由启动环境变量提供；请在启动环境中修改或移除覆盖，再使用共享配置。"' : ""}>${svg("lock", "ic ic-sm")}${environment ? "环境变量 · 只读" : "只读"}</small>` : "";
      const lab = `<${tag} class="f-label"${k ? ` for="${fid(k)}"` : ""}>${label}${locked || (hint ? `<small>${hint}</small>` : "")}</${tag}>`;
      const msgEl = slot ? `<p class="f-msg" id="${fid(slot)}-message" data-msg="${slot}" aria-live="polite" hidden></p>` : "";
      const helpEl = help ? `<p class="f-help"${slot ? ` id="${fid(slot)}-help"` : ""}>${help}</p>` : "";
      return `<div class="field">${lab}<div class="f-ctl">${ctl}${msgEl}${helpEl}</div></div>`;
    }
    function txt(k, v, ph, o = {}) {
      const readOnly = o.ro || fieldReadOnly(k);
      const extra = (readOnly ? " readonly" : "") + (o.im ? ` inputmode="${o.im}"` : "");
      return `<div class="input${readOnly ? " is-readonly" : ""}"><input id="${fid(k)}" type="text" class="mono" data-k="${k}" value="${esc(v)}" placeholder="${esc(ph || "")}" spellcheck="false" autocomplete="off"${extra}></div>`;
    }
    function fieldReadOnly(k) {
      if (!D) return false;
      if (D.kind === "hub") return ["budget", "exeOverride", "cfgOverride"].includes(k) || D.fields?.[HUB_FIELDS[k]]?.readOnly === true;
      const key = CARD_FIELDS[D.id]?.[k.startsWith("keys.") ? "keys" : k];
      if (!key) return k === "ghApi";
      const secret = ["key", "gwKey", "token", "keys"].includes(k.split(".")[0]);
      const destination = ["url", "gwUrl", "searchUrl", "fetchUrl"].includes(k);
      return D.fields?.[key]?.readOnly === true || D.id === "grok" && D.base.authReadOnly || (secret || destination) && !S.capabilities?.secretsAllowed;
    }
    function keyIn(k, v, ph, o = {}) {
      const unavailable = !S.capabilities?.secretsAllowed || D.id === "grok" && D.base.authReadOnly;
      const shown = !unavailable && !!D.show[k];
      const ro = fieldReadOnly(k), isHidden = hidden(v) || !S.capabilities?.secretsAllowed && Boolean(v);
      const eye = `<button type="button" class="icon-btn" data-a="eye" data-k="${k}" aria-label="${shown ? "隐藏" : "显示"}密钥" aria-pressed="${shown}"${unavailable ? " disabled" : ""}>${svg(shown ? "eyeOff" : "eye")}</button>`;
      const cp = `<button type="button" class="icon-btn" data-a="copy" data-k="${k}" aria-label="复制密钥"${unavailable ? " disabled" : ""}>${svg("copy")}</button>`;
      const del = o.del ? `<button type="button" class="icon-btn" data-a="del-key" data-i="${o.i}" aria-label="删除这个 Key"${ro ? " disabled" : ""}>${svg("trash")}</button>` : "";
      const aria = o.aria ? ` aria-label="${o.aria}"` : "";
      return `<div class="input${ro ? " is-readonly" : ""}"><input id="${fid(k)}" type="${shown ? "text" : "password"}" class="mono" data-k="${k}" value="${isHidden ? "" : esc(v)}" placeholder="${isHidden ? ro ? "已配置 · 点击查看" : "已配置 · 点击查看或编辑" : esc(ph || "")}" spellcheck="false" autocomplete="off"${aria}${isHidden ? ' data-hidden="true" readonly' : ro ? " readonly" : ""}><span class="in-act">${eye}${cp}${del}</span></div>`;
    }
    function chip(k, v, label, cur) {
      return `<button type="button" class="chip" data-a="pick" data-k="${k}" data-v="${esc(v)}" aria-pressed="${(cur || "").trim() === v}"${fieldReadOnly(k) ? " disabled" : ""}>${esc(label)}</button>`;
    }
    function chk(k, on, title, sub) {
      const ro = fieldReadOnly(k);
      return `<label class="check${ro ? " is-disabled" : ""}"><input type="checkbox" data-k="${k}"${on ? " checked" : ""}${ro ? " disabled" : ""}><span class="box">${svg("check")}</span><span class="c-text">${title}<small>${sub}</small></span></label>`;
    }
    const note = (t) => `<div class="note">${svg("info", "ic ic-sm")}<span>${t}</span></div>`;
    const EXT = (t) => `${t}${svg("ext", "ic ic-sm")}`;
    const subText = (id) => META[id].group === "supp" ? `${META[id].sub} · 补充来源第 ${S.order.indexOf(id) + 1} 位` : META[id].sub;
    const KEEP_URL = "留空使用官方地址。";
    const GROK_NOTE = note("关闭右上角开关后，搜索直接由补充来源返回；Grok 失效时也会静默回退到补充来源，全部不可用才报错，不会回退官方搜索。这个开关只对 DSH 生效，不写入 config.toml。");
    const credKey = (id, p = S.prov[id]) => id === "grok" ? p.mode === "compat" ? "gwKey" : "key" : id === "github" ? "token" : "key";
    const CRED = { grok: ["mode", "url", "key", "model", "gwUrl", "gwKey", "gwModel", "web", "x"], tavily: ["url", "keys"], exa: ["url", "key"], tinyfish: ["searchUrl", "fetchUrl", "key"], firecrawl: ["url", "key"], github: ["token"] };
    const credentialFailure = (code) => String(code || "").split("/").every((value) => ["401", "GROK_AUTH_ERROR"].includes(normalizeCode(value).toUpperCase()));
    function healthOf(id) {
      const v = S.bad[id];
      if (!v) return [];
      const base = D?.id === id ? D.base : S.prov[id];
      if (id === "tavily") return Object.entries(v).map(([i, code]) => ({ val: (base.keys[i] || "").trim(), code })).filter((x) => x.val);
      const k = credKey(id, base);
      return [{ k, val: (base[k] || "").trim(), code: v }];
    }
    function healthMsg(id, code, summary = false) {
      const base = joinSentences(`${summary ? "" : "最近一次检查："}${failureInfo(code).status} · ${errText(code)}`, failureHelp(code));
      if (id === "grok") return base + (summary && grokOn() && S.lastRoute?.outcome === "ok" && S.lastRoute.fallbackUsed === true ? "\n搜索已静默回退到补充来源" : "");
      if (id === "tavily") return base + (!TAVILY_ROTATE.has(code) ? "；正常搜索遇到此错误不会换 Key，逐项测试仍独立检查其他 Key" : isBad("tavily") ? "" : "；其他 Key 的检查结果单独保留");
      return base + "；正常搜索可继续尝试后续来源";
    }
    const FIELDS = {
      grok(p) {
        const compat = p.mode === "compat";
        const protocolLocked = D.base.authReadOnly || D.fields.grok_api_key?.readOnly || !S.capabilities?.secretsAllowed;
        const seg = `<div class="seg" role="radiogroup" aria-label="接口协议"><button type="button" role="radio" data-a="mode" data-v="responses" title="Responses 接口；支持兼容此协议的自定义服务" aria-checked="${!compat}" tabindex="${compat ? -1 : 0}"${protocolLocked ? " disabled" : ""}>xAI Responses</button><button type="button" role="radio" data-a="mode" data-v="compat" title="Chat Completions 接口" aria-checked="${compat}" tabindex="${compat ? 0 : -1}"${protocolLocked ? " disabled" : ""}>OpenAI 兼容网关</button></div>`;
        const segHelp = compat ? "切换时原 Responses API Key 会从共享配置删除并备份到配置历史；切回需重新填入或恢复历史。此模式不支持 X 搜索。" : p.authReadOnly ? "正在复用原有登录认证，认证配置在此只读。" : D.fields.grok_api_key?.source === "environment" ? "API Key 由启动环境变量提供；移除该覆盖后，可在共享配置中修改 Key 和切换接口。" : "";
        let h = field({ label: "接口协议", ctl: seg, help: segHelp });
        if (compat) {
          h += field({ label: "Base URL", k: "gwUrl", ctl: txt("gwUrl", p.gwUrl, "https://your-service/v1", { im: "url" }) });
          h += field({ label: "API Key", k: "gwKey", ctl: keyIn("gwKey", p.gwKey, "sk-...") });
          h += field({ label: "模型", hint: "可选", k: "gwModel", ctl: txt("gwModel", p.gwModel, "例如 grok-4.3-fast") });
          return h + GROK_NOTE;
        }
        h += field({ label: "Base URL", k: "url", ctl: txt("url", p.url, DEF.grokUrl, { im: "url" }), help: "可填根地址、/v1 或完整端点，会自动规范到 /v1。" + KEEP_URL });
        h += field({ label: "API Key", k: "key", ctl: keyIn("key", p.key, "xai-.../sk-...") });
        const chips = `<div class="chips">${chip("model", "", "默认", p.model)}${chip("model", "grok-4.3", "grok-4.3", p.model)}</div>`;
        h += field({ label: "模型", k: "model", ctl: txt("model", p.model, `默认 ${DEF.grokModel}`) + chips });
        const checks = `<div class="checks">${chk("web", p.web, "网页搜索", "让 Grok 联网检索网页并给出来源")}${chk("x", p.x, "X 搜索", "同时检索 X（Twitter）上的帖子")}</div>`;
        h += field({ label: "搜索能力", msg: "web", ctl: checks });
        return h + GROK_NOTE;
      },
      tavily(p) {
        const keys = p.keys.length ? p.keys : [""];
        const rows = keys.map((v, i) => `<div class="key-row">${keyIn("keys." + i, v, "tvly-...", { del: keys.length > 1, i, aria: `Tavily Key ${i + 1}` })}</div>`).join("");
        const add = `<button type="button" class="add-key" data-a="add-key"${fieldReadOnly("keys") ? " disabled" : ""}>${svg("plus", "ic ic-sm")}添加另一个 Key</button>`;
        return field({ label: "Base URL", k: "url", ctl: txt("url", p.url, DEF.tavilyUrl, { im: "url" }), help: KEEP_URL }) + field({ label: "API Key", k: "keys.0", hint: "可填多个", msg: "keys", ctl: `<div class="keylist">${rows}</div>${add}`, help: "多个 Key 按请求轮换；遇到 401、403、429、432、433 会自动换下一个。" });
      },
      exa(p) {
        return field({ label: "Base URL", k: "url", ctl: txt("url", p.url, DEF.exaUrl, { im: "url" }), help: KEEP_URL }) + field({ label: "API Key", k: "key", ctl: keyIn("key", p.key, "Exa API Key"), help: "语义搜索，按请求计费。" });
      },
      tinyfish(p) {
        return field({ label: "搜索地址", k: "searchUrl", ctl: txt("searchUrl", p.searchUrl, DEF.tfSearch, { im: "url" }) }) + field({ label: "抓取地址", k: "fetchUrl", ctl: txt("fetchUrl", p.fetchUrl, DEF.tfFetch, { im: "url" }), help: "两个地址都可留空，使用官方地址。" }) + field({ label: "API Key", k: "key", ctl: keyIn("key", p.key, "tf-..."), help: "一个 Key 同时用于搜索和抓取。免费使用，免费版限速 30 次/分钟；账号需开通 Search API。" });
      },
      firecrawl(p) {
        return field({ label: "Base URL", k: "url", ctl: txt("url", p.url, DEF.fcUrl, { im: "url" }), help: "默认走 /v2；显式写 /v1 会保留。" + KEEP_URL }) + field({ label: "API Key", k: "key", ctl: keyIn("key", p.key, "fc-..."), help: "带域名或时间过滤的搜索会跳过 Firecrawl。" });
      },
      github(p) {
        return field({ label: "API 地址", k: "ghApi", ctl: txt("ghApi", DEF.ghApi, "", { ro: true }), help: "固定为 GitHub 官方接口，不可修改。" }) + field({ label: "Token", k: "token", ctl: keyIn("token", p.token, "ghp_... 或 github_pat_..."), help: "匿名约 60 次/小时；填写 Token 可提高限额，并能读取 Token 有权限的私有仓库。" }) + note("开启并保存后，通过 GitHub 官方 API 读取你指定的 Issue、PR 和 Release，不参与网页搜索排序。私有内容也会交给当前聊天模型；DSH 可能将工具返回内容保存到会话历史。Token 留空可匿名读取公开内容。") + `<button type="button" class="btn btn-sm" data-a="test-github">测试连接</button>`;
      }
    };
    function vCard(id, p) {
      const err = {};
      const warn = {};
      const on = p.enabled !== false;
      const need = on && isSet(id, D?.base || S.prov[id]);
      const url = (k, v) => {
        const t = (v || "").trim();
        if (!t) return;
        try {
          const parsed = new URL(t);
          if (!/^https?:\/\//i.test(t) || /\s/.test(t) || !["http:", "https:"].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) throw new TypeError("Invalid HTTP URL");
          if (parsed.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) {
            err[k] = "远程服务地址必须使用 HTTPS，本机地址才可使用 HTTP";
          }
        } catch (_) {
          err[k] = "请填写以 http:// 或 https:// 开头的完整地址";
        }
      };
      const key = (k, v, need2, pre, preMsg) => {
        const t = (v || "").trim();
        if (hidden(t)) return;
        if (!t) {
          if (need2) err[k] = need2;
          return;
        }
        if (/\s/.test(t)) {
          err[k] = "Key 中间不能有空格或换行，请检查是否粘贴完整";
          return;
        }
        if (pre && !pre.some((x) => t.startsWith(x))) warn[k] = preMsg;
      };
      if (id === "grok") {
        if (p.mode === "compat") {
          url("gwUrl", p.gwUrl);
          const half = on && !!p.gwUrl.trim() !== !!p.gwKey.trim();
          if ((need || half) && !p.gwUrl.trim()) err.gwUrl = "Chat Completions 接口需要 Base URL";
          key("gwKey", p.gwKey, need || half ? "Chat Completions 接口需要 API Key" : "");
        } else {
          url("url", p.url);
          let host = "";
          try {
            host = new URL(p.url.trim() || DEF.grokUrl).host;
          } catch (_) {
            host = "";
          }
          key("key", p.key, need ? "启用 Grok 需要 API Key；只用补充来源时可关闭右上角开关" : "", host === "api.x.ai" ? ["xai-"] : null, "xAI 的 Key 通常以 xai- 开头，请确认没有填错");
          if (!p.web) warn.web = p.x ? "网页搜索已关闭；X 搜索仍开启，Grok 仍会检索 X 上的内容" : "网页与 X 搜索均已关闭；Grok 可能因缺少引用而使用补充来源";
        }
      } else if (id === "tavily") {
        url("url", p.url);
        const ks = p.keys.map((k) => k.trim());
        if (need && !ks.some(Boolean)) err["keys.0"] = "启用 Tavily 需要至少一个 API Key";
        const seen = /* @__PURE__ */ new Set();
        ks.forEach((v, i) => {
          if (!v) return;
          if (/\s/.test(v)) err["keys." + i] = "Key 中间不能有空格或换行";
          else if (seen.has(v)) warn["keys." + i] = `第 ${i + 1} 个 Key 与前面的重复`;
          else if (!v.startsWith("tvly-")) warn["keys." + i] = "Tavily 的 Key 通常以 tvly- 开头";
          seen.add(v);
        });
      } else if (id === "exa") {
        url("url", p.url);
        key("key", p.key, need ? "启用 Exa 需要 API Key" : "");
      } else if (id === "tinyfish") {
        url("searchUrl", p.searchUrl);
        url("fetchUrl", p.fetchUrl);
        key("key", p.key, need ? "启用 TinyFish 需要 API Key" : "");
      } else if (id === "firecrawl") {
        url("url", p.url);
        key("key", p.key, need ? "启用 Firecrawl 需要 API Key" : "", ["fc-"], "Firecrawl 的 Key 通常以 fc- 开头");
      } else if (id === "github") {
        key("token", p.token, "", ["ghp_", "github_pat_", "gho_", "ghu_", "ghs_"], "GitHub Token 通常以 ghp_ 或 github_pat_ 开头");
      }
      for (const map of [err, warn]) for (const key2 of Object.keys(map)) {
        if (fieldReadOnly(key2)) delete map[key2];
        else if (D && JSON.stringify(p[key2]) === JSON.stringify(D.base?.[key2]) && p.mode === D.base?.mode && !(id === "tavily" && JSON.stringify(p.keys) !== JSON.stringify(D.base.keys))) delete map[key2];
      }
      return { err, warn };
    }
    function isDirty() {
      if (!D) return false;
      const now = D.kind === "card" ? normCard(D.draft) : normHub(D.draft);
      return JSON.stringify(now) !== D.orig;
    }
    function refreshDialog() {
      if (!D) return;
      const v = D.kind === "card" ? vCard(D.id, D.draft) : vHub(D.draft);
      D.v = v;
      if (D.kind === "card") syncHeadSwitch();
      const shown = (k) => D.submitted || D.touched.has(k) || D.touched.has(k.split(".")[0]);
      const health = {};
      const resultFailures = [];
      if (D.kind === "card" && CRED[D.id].filter((k) => !["key", "gwKey", "token", "keys"].includes(k)).every((k) => JSON.stringify(D.draft[k]) === JSON.stringify(D.base[k]))) {
        healthOf(D.id).forEach((h) => {
          const slots = D.id === "tavily" ? D.draft.keys.flatMap((v2, i) => v2.trim() === h.val ? ["keys." + i] : []) : (D.draft[h.k] || "").trim() === h.val ? [h.k] : [];
          for (const slot of slots) {
            if (credentialFailure(h.code) && !(D.id === "grok" && D.base.authReadOnly)) health[slot] = h.code;
            else resultFailures.push({ slot, code: h.code });
          }
        });
      }
      const resultBox = $(".search-result", dlg);
      if (resultBox) {
        resultBox.dataset.tone = "err";
        resultBox.hidden = !resultFailures.length;
        const details = resultFailures.map(({ slot, code }) => `${D.id === "tavily" ? `Key ${+slot.split(".")[1] + 1}：` : ""}${healthMsg(D.id, code, true).replaceAll("；", "，")}`).join("\n");
        const content = details ? `${svg("info", "ic ic-sm")}<span><strong>最近检查结果</strong>${esc(details)}</span>` : "";
        if (resultBox.innerHTML !== content) resultBox.innerHTML = content;
      }
      $$(".f-msg[data-msg]", dlg).forEach((m) => {
        const slot = m.dataset.msg;
        const find = (o) => Object.keys(o).find((k) => (k === slot || k.startsWith(slot + ".")) && shown(k));
        const ek = find(v.err);
        const wk = ek ? null : find(v.warn);
        const hk = ek || wk ? null : Object.keys(health).find((k) => k === slot || k.startsWith(slot + "."));
        if (ek || wk || hk) {
          m.hidden = false;
          m.dataset.tone = ek || hk ? "err" : "warn";
          const text = ek ? v.err[ek] : wk ? v.warn[wk] : (D.id === "tavily" ? `第 ${+hk.split(".")[1] + 1} 个 Key ` : "") + healthMsg(D.id, health[hk]);
          const content = `${svg(ek || hk ? "errc" : "warn", "ic ic-sm")}<span>${esc(text)}</span>`;
          if (m.innerHTML !== content) m.innerHTML = content;
        } else {
          m.hidden = true;
          m.innerHTML = "";
        }
      });
      $$("input[data-k]", dlg).forEach((inp) => {
        const k = inp.dataset.k;
        const invalid = !!((v.err[k] || v.err[k.split(".")[0]]) && shown(k));
        inp.setAttribute("aria-invalid", String(invalid));
        const field2 = inp.closest(".field");
        const descriptions = field2 ? $$(".f-msg:not([hidden]), .f-help[id]", field2).map((el) => el.id).filter(Boolean) : [];
        if (descriptions.length) inp.setAttribute("aria-describedby", descriptions.join(" "));
        else inp.removeAttribute("aria-describedby");
        const box = inp.closest(".input");
        if (!box) return;
        box.dataset.invalid = String(invalid);
        box.dataset.health = String(!!health[inp.dataset.k] && box.dataset.invalid !== "true");
      });
      const dirty = isDirty();
      const sv = $("[data-a=save]", dlg);
      if (sv && !D.saving) sv.disabled = !dirty;
      const fn = $(".foot-note", dlg);
      if (fn && !D.warned) {
        let base = D.kind === "hub" ? "共享项写入配置，插件专属项只读" : "保存后写入共享配置，下次搜索生效";
        if (D.kind === "card" && D.id === "grok" && dirty) {
          const a = normCard(D.draft), b = JSON.parse(D.orig);
          delete a.enabled;
          delete b.enabled;
          if (JSON.stringify(a) === JSON.stringify(b)) base = "启用开关只对 DSH 生效，不写入 config.toml";
        }
        fn.innerHTML = dirty ? `<b>有未保存的修改</b> · ${base}` : base;
      }
      if (D.operationError) {
        let error = $(".save-error", dlg);
        if (!error) {
          error = document.createElement("div");
          error.className = "note save-error";
          error.setAttribute("role", "alert");
          $(".dlg-body", dlg)?.appendChild(error);
        }
        const retry = ["CONFIG_CONFLICT", "CONFIG_COMMIT_UNCERTAIN", "PREFERENCES_CONFLICT", "PREFERENCES_COMMIT_UNCERTAIN"].includes(D.operationError.code) ? '<button type="button" class="btn btn-sm" data-a="reload-draft">读取最新配置</button>' : "";
        const html = `${svg("info", "ic ic-sm")}<span>${esc(D.operationError.code)} · ${esc(D.operationError.message)}</span>${retry}`;
        if (error._html !== html) {
          error.innerHTML = html;
          error._html = html;
        }
      }
      quotaView?.render();
    }
    function setDraft(k, val) {
      if (!D || dialogBusy() || fieldReadOnly(k)) return;
      const m = /^keys\.(\d+)$/.exec(k);
      if (m) {
        D.draft.keys[+m[1]] = val;
        return;
      }
      if (D.kind === "hub" && NUM[k]) {
        D.draft[k] = val.trim() === "" ? NaN : Number(val);
        return;
      }
      D.draft[k] = val;
    }
    function syncChips(k, v) {
      $$(`.chip[data-k="${k}"]`, dlg).forEach((c) => c.setAttribute("aria-pressed", String(c.dataset.v === v.trim())));
    }
    dlg.addEventListener("input", (e) => {
      const t = e.target;
      if (!D || dialogBusy() || !t.matches("input[data-k]") || t.type === "checkbox") return;
      setDraft(t.dataset.k, t.value);
      if (D.id === "github") {
        D.githubRevision = (D.githubRevision || 0) + 1;
        const outcome = $(".search-result", dlg);
        if (outcome) {
          outcome.hidden = true;
          outcome.textContent = "";
        }
      }
      D.edited.add(t.dataset.k);
      D.warned = false;
      if (t.dataset.k === "model") syncChips("model", t.value);
      if (D.kind === "hub" && NUM[t.dataset.k]) syncStepper(t.dataset.k);
      refreshDialog();
    });
    dlg.addEventListener("change", (e) => {
      const t = e.target;
      if (!D || dialogBusy() || !t.matches("input[type=checkbox][data-k]") || fieldReadOnly(t.dataset.k)) return;
      D.draft[t.dataset.k] = t.checked;
      D.touched.add(t.dataset.k);
      D.warned = false;
      refreshDialog();
    });
    dlg.addEventListener("focusout", (e) => {
      const t = e.target;
      if (!D || dialogBusy() || !t.matches("input[data-k]") || t.type === "checkbox" || t.readOnly) return;
      const k = t.dataset.k;
      if (!D.edited.has(k)) return;
      const tr = t.value.trim();
      if (tr !== t.value) {
        t.value = tr;
        setDraft(k, tr);
      }
      D.touched.add(k);
      refreshDialog();
    });
    dlg.addEventListener("focusin", (e) => {
      const t = e.target;
      if (D && t.matches("input[data-hidden]") && !fieldReadOnly(t.dataset.k)) void revealFor(t.dataset.k);
    });
    dlg.addEventListener("click", async (e) => {
      const b = e.target.closest("[data-a]");
      if (!b || !D || dialogBusy() || b.disabled) return;
      const a = b.dataset.a;
      if (a === "close") closeDialog(false);
      else if (a === "cancel") closeDialog(true);
      else if (a === "save") save();
      else if (a === "test-github") void testGithubDraft(b);
      else if (a === "eye") toggleEye(b);
      else if (a === "copy") copyKey(b);
      else if (a === "mode") setMode(b);
      else if (a === "pick") pickChip(b);
      else if (a === "add-key" && !fieldReadOnly("keys")) {
        const mine = D;
        if (!await revealFor("keys")) return;
        if (D !== mine || dialogBusy()) return;
        D.draft.keys.push("");
        rerender(`input[data-k="keys.${D.draft.keys.length - 1}"]`, true);
      } else if (a === "del-key" && !fieldReadOnly("keys")) {
        const mine = D;
        if (await revealFor("keys") && D === mine) delKey(+b.dataset.i);
      } else if (a === "enabled") toggleEnabled(b);
      else if (a === "clear") clearArm(b);
      else if (a === "step") step(b.dataset.k, +b.dataset.d);
      else if (a === "adv") toggleAdv(b);
      else if (a === "redetect") redetect(b);
      else if (a === "open-file") openPath("file");
      else if (a === "open-folder") openPath("folder");
      else if (a === "reload-draft") void reloadDialogDraft();
    });
    async function testGithubDraft(button) {
      if (!D || D.id !== "github" || D.githubOperation) return;
      if (!S.capabilities?.secretsAllowed) {
        toast("请通过安全连接测试 Token。", { tone: "warn" });
        return;
      }
      const mine = D, draftToken = mine.draft.token, operationId = uuid(), epoch = secretEpoch, draftRevision = mine.githubRevision || 0;
      const current = () => !disposed && D === mine && epoch === secretEpoch && draftRevision === (mine.githubRevision || 0) && draftToken === mine.draft.token && S.capabilities?.secretsAllowed;
      const resultNode = $(".search-result", dlg);
      mine.githubOperation = operationId;
      button.disabled = true;
      button.innerHTML = `${svg("refresh", "ic ic-sm")}检测中…`;
      resultNode.hidden = false;
      resultNode.dataset.tone = "run";
      resultNode.textContent = "正在验证 GitHub 认证与公开内容读取…";
      try {
        const result = await remote.previewGithubConnection({
          operationId,
          expectedRevision: mine.configBaseline.revision,
          configIdentity: mine.configBaseline.quotaRevision,
          ...hidden(draftToken) ? {} : { token: draftToken.trim() }
        });
        if (!current()) return;
        resultNode.textContent = `${result.status === "ok" ? "连接成功" : result.code} · ${result.message}`;
        resultNode.dataset.tone = result.status === "ok" ? "ok" : "err";
      } catch (error) {
        if (current()) {
          resultNode.dataset.tone = "err";
          resultNode.textContent = `${error.code || "连接失败"} · ${error.message || "请稍后重试。"}`;
        }
      } finally {
        if (D === mine) {
          mine.githubOperation = null;
          button.disabled = false;
          button.textContent = "测试连接";
          if (!current()) {
            resultNode.hidden = true;
            resultNode.textContent = "";
          }
        }
      }
    }
    async function revealFor(k) {
      if (!D || D.closed || disposed || D.kind !== "card") return false;
      if (!S.capabilities?.secretsAllowed) return false;
      const mine = D, keyName = k.startsWith("keys") ? "keys" : k;
      const epoch = secretEpoch;
      const current = () => !disposed && !mine.closed && D === mine && epoch === secretEpoch && S.capabilities?.secretsAllowed === true;
      const configured = keyName === "keys" ? mine.draft.keys.some(hidden) : hidden(mine.draft[keyName]);
      if (!configured) return true;
      const pending = mine.revealing;
      const existing = pending.get(keyName);
      if (existing?.epoch === epoch) {
        return await existing.task === true && current();
      }
      const key = CARD_FIELDS[mine.id]?.[keyName];
      if (!key) return false;
      const focused = active(), selection = focused?.selectionStart;
      const entry = { epoch, task: null };
      pending.set(keyName, entry);
      entry.task = (async () => {
        try {
          const revealed = await remote.reveal({ key });
          if (!current()) return false;
          if (keyName === "keys") {
            const values = String(revealed.value || "").split(",").map((v) => v.trim()).filter(Boolean);
            const next = values.length ? values : [""];
            mine.base.keys = clone(next);
            mine.draft.keys = clone(next);
          } else {
            mine.base[keyName] = String(revealed.value || "");
            if (hidden(mine.draft[keyName])) mine.draft[keyName] = String(revealed.value || "");
          }
          mine.orig = JSON.stringify(normCard(mine.base));
          if (revealed.readOnly) mine.fields[key] = { ...mine.fields[key], readOnly: true };
          $$("input[data-k]", dlg).forEach((input) => {
            const name = input.dataset.k;
            if (keyName === "keys" ? name.startsWith("keys.") : name === keyName) {
              const value = keyName === "keys" ? mine.draft.keys[+name.split(".")[1]] || "" : mine.draft[keyName];
              input.value = value;
              delete input.dataset.hidden;
              input.readOnly = fieldReadOnly(name);
            }
          });
          refreshDialog();
          if (focused?.isConnected && !focused.readOnly) {
            focused.focus({ preventScroll: true });
            if (typeof selection === "number") focused.setSelectionRange(selection, selection);
          }
          return true;
        } catch (error) {
          if (current()) operationError(error);
          return false;
        } finally {
          if (pending.get(keyName) === entry) pending.delete(keyName);
        }
      })();
      return await entry.task === true && current();
    }
    async function toggleEye(b) {
      const k = b.dataset.k;
      const mine = D;
      if (!await revealFor(k) || disposed || D !== mine || !S.capabilities?.secretsAllowed || !b.isConnected) return;
      D.show[k] = !D.show[k];
      dlg.querySelector(`input[data-k="${k}"]`).type = D.show[k] ? "text" : "password";
      b.innerHTML = svg(D.show[k] ? "eyeOff" : "eye");
      b.setAttribute("aria-pressed", String(D.show[k]));
      b.setAttribute("aria-label", D.show[k] ? "隐藏密钥" : "显示密钥");
    }
    async function copyKey(b) {
      const mine = D;
      if (!await revealFor(b.dataset.k) || disposed || D !== mine || !S.capabilities?.secretsAllowed || !b.isConnected) return;
      const v = dlg.querySelector(`input[data-k="${b.dataset.k}"]`).value.trim();
      if (!v) {
        toast("还没有可复制的内容", { tone: "info" });
        return;
      }
      if (!navigator.clipboard) {
        toast("复制失败：浏览器不允许访问剪贴板", { tone: "warn" });
        return;
      }
      navigator.clipboard.writeText(v).then(() => toast("已复制到剪贴板"), () => toast("复制失败：浏览器不允许访问剪贴板", { tone: "warn" }));
    }
    function setMode(b) {
      if (!D || dialogBusy()) return;
      if (D.draft.mode === b.dataset.v) return;
      D.draft.mode = b.dataset.v;
      D.warned = false;
      rerender(`[data-a=mode][data-v="${b.dataset.v}"]`);
    }
    function pickChip(b) {
      if (!D || dialogBusy() || fieldReadOnly(b.dataset.k)) return;
      const k = b.dataset.k;
      D.draft[k] = b.dataset.v;
      const inp = dlg.querySelector(`input[data-k="${k}"]`);
      if (inp) inp.value = b.dataset.v;
      syncChips(k, b.dataset.v);
      D.warned = false;
      refreshDialog();
    }
    function delKey(i) {
      if (!D || dialogBusy()) return;
      D.draft.keys.splice(i, 1);
      if (!D.draft.keys.length) D.draft.keys.push("");
      D.show = {};
      [D.touched, D.edited].forEach((set) => [...set].forEach((k) => {
        if (k.startsWith("keys.")) set.delete(k);
      }));
      D.warned = false;
      rerender(`input[data-k="keys.${Math.max(0, i - 1)}"]`);
    }
    function toggleEnabled(b) {
      if (!D || dialogBusy()) return;
      if (cardPending()) {
        dlg.querySelector(`input[data-k="${credInput(D.id, D.draft)}"]`)?.focus();
        return;
      }
      D.draft.enabled = D.draft.enabled === false;
      D.touched.add(D.id === "tavily" ? "keys" : credKey(D.id, D.draft));
      if (D.id === "grok" && D.draft.mode === "compat") D.touched.add("gwUrl");
      D.warned = false;
      refreshDialog();
    }
    function rerender(focusSel, animateNew) {
      if (!D || dialogBusy()) return;
      resetClearConfirmation();
      const body = $(".dlg-body", dlg);
      const top = body ? body.scrollTop : 0;
      if (D.kind === "card") renderCard();
      else renderHub();
      const nb = $(".dlg-body", dlg);
      if (nb) nb.scrollTop = top;
      const f = focusSel ? dlg.querySelector(focusSel) : null;
      if (f) {
        f.focus();
        const kr = f.closest(".key-row");
        if (animateNew && kr && !reduced()) kr.classList.add("enter");
      }
    }
    async function save() {
      if (!D || dialogBusy() || S.busy || disposed) return;
      const mine = D, epoch = secretEpoch;
      const current = () => !disposed && !mine.closed && D === mine && epoch === secretEpoch;
      while (mine.revealing?.size) {
        const results = await Promise.all(Array.from(mine.revealing.values(), (entry) => entry.task));
        if (!current() || results.some((result) => result !== true)) return;
      }
      if (!current() || dialogBusy() || S.busy) return;
      mine.submitted = true;
      refreshDialog();
      const ek = Object.keys(D.v.err);
      if (ek.length) {
        const advKeys = ["cache", "maxChars", "budget", "exeOverride", "cfgOverride"];
        if (D.kind === "hub" && advKeys.includes(ek[0]) && !D.advOpen) toggleAdv($("[data-a=adv]", dlg));
        const target = dlg.querySelector(`input[data-k="${ek[0]}"]`);
        if (target) target.focus();
        shake(dlg);
        return;
      }
      if (!isDirty()) return;
      const snapshot = clone(D.draft);
      if (Array.isArray(snapshot.keys)) Object.freeze(snapshot.keys);
      Object.freeze(snapshot);
      resetClearConfirmation();
      cancelTest();
      syncAll();
      D.saving = true;
      const sv = $("[data-a=save]", dlg);
      lockDialog();
      sv.innerHTML = '<span class="spin"></span>保存中…';
      S.busy = true;
      try {
        if (D.kind === "card") await commitCard(snapshot);
        else await commitHub(snapshot);
      } catch (error) {
        if (D === mine) operationError(error, true);
      } finally {
        S.busy = false;
        if (!disposed) syncAll(true);
      }
    }
    function cardUpdates(id, draft, base, fields) {
      const updates = {};
      for (const [name, key] of Object.entries(CARD_FIELDS[id])) {
        if (fieldReadOnly(name) || JSON.stringify(draft[name]) === JSON.stringify(base[name])) continue;
        const value = draft[name];
        if (hidden(value) || Array.isArray(value) && value.some(hidden)) continue;
        updates[key] = Array.isArray(value) ? value.map((v) => v.trim()).filter(Boolean).join(",") || null : typeof value === "string" ? value.trim() || null : value;
      }
      if (id === "grok" && draft.mode === "compat" && base.mode !== "compat") updates.grok_api_key = null;
      if (SUPP.includes(id) && (draft.enabled !== base.enabled || !isSet(id, base) && isSet(id, draft))) {
        Object.assign(updates, sourceChain.plan(fields, { kind: "toggle", id, on: draft.enabled !== false }));
      }
      return updates;
    }
    async function commitCard(draft = D.draft) {
      const mine = D, id = mine.id, base = clone(mine.base);
      const previous = clone(S.prov[id]);
      const receipt = await saveConfig((fields) => cardUpdates(id, draft, base, fields), mine.configBaseline);
      if (disposed || D !== mine) return;
      const prefsChanged = (id === "grok" || id === "github") && draft.enabled !== base.enabled;
      if (prefsChanged) {
        try {
          await savePreference(id, draft.enabled !== false);
        } catch (error) {
          mine.saving = false;
          if (receipt) {
            mine.configBaseline = clone(S.config);
            mine.base = clone(draft);
            mine.base.enabled = S.prov[id].enabled;
            mine.fields = clone(configFields());
            mine.draft = clone(draft);
            mine.orig = JSON.stringify(normCard(mine.base));
            operationError(Object.assign(new Error("共享配置已保存，但 DSH 开关未保存。请核对后再保存开关。"), { code: "SETTINGS_PARTIAL_SAVE" }), true);
            return;
          }
          throw error;
        }
      }
      const credentialsChanged = CRED[id].some((name) => JSON.stringify(base[name]) !== JSON.stringify(draft[name]));
      if (credentialsChanged) reconcileChecks(id, previous, normCard(draft));
      mine.saving = false;
      closeDialog(true);
      syncAll(false);
      bump(rowOf(id));
      const changedMode = id === "grok" && base.mode !== "compat" && draft.mode === "compat";
      toast(
        changedMode ? "已保存兼容网关 · 原 xAI Key 已删除并备份到配置历史" : receipt ? `已保存 ${META[id].name} · 下次搜索生效，可点「测试搜索」验证` : `已保存 ${META[id].name} 开关 · 仅对 DSH 生效`,
        { undo: cardUndo(receipt, id, base.enabled !== false, prefsChanged) }
      );
    }
    async function clearArm(b) {
      if (!D || dialogBusy()) return;
      if (!D.clearArmed) {
        D.clearArmed = true;
        b.classList.add("is-confirm");
        b.textContent = D.id === "grok" ? servingSupp() ? "再点一次：清除后改由补充来源搜索" : "再点一次：清除后搜索会报错" : "再点一次确认清除";
        const mine2 = D;
        D.clearTimer = setTimeout2(() => {
          if (D !== mine2) return;
          D.clearArmed = false;
          D.clearTimer = 0;
          if (b.isConnected) {
            b.classList.remove("is-confirm");
            b.textContent = "清除配置";
          }
        }, 3e3);
        return;
      }
      const mine = D, id = mine.id;
      const updates = Object.fromEntries(Object.values(CARD_FIELDS[id]).filter((key) => mine.fields[key]?.source === "file" && !mine.fields[key]?.readOnly).map((key) => [key, null]));
      if (!Object.keys(updates).length) {
        toast("没有可清除的文件配置；环境变量和只读认证保持不变。", { tone: "info" });
        resetClearConfirmation();
        return;
      }
      D.clearing = true;
      lockDialog();
      cancelTest();
      S.busy = true;
      try {
        const receipt = await saveConfig(updates, mine.configBaseline);
        if (disposed || D !== mine) return;
        mine.clearing = false;
        closeDialog(true);
        syncAll(false);
        toast(`已清除 ${META[id].name} 文件配置 · 原内容已备份到配置历史`, { undo: configUndo(receipt) });
      } catch (error) {
        if (D === mine) operationError(error, true);
      } finally {
        S.busy = false;
        if (!disposed) syncAll(true);
      }
    }
    const cardPending = () => !!D && D.kind === "card" && D.id !== "github" && !isSet(D.id, D.base) && !isSet(D.id, D.draft);
    const credInput = (id, p) => id === "tavily" ? "keys.0" : id === "grok" && p.mode === "compat" ? p.gwUrl.trim() ? "gwKey" : "gwUrl" : credKey(id, p);
    function headState() {
      const pending = cardPending();
      const text = D.id === "github" ? "启用读取" : "启用";
      return { pending, on: !pending && D.draft.enabled !== false, text };
    }
    function headSwitch() {
      const h = headState();
      return `<label class="head-switch" data-pending="${h.pending}"><span class="hs-text">${h.text}</span><button type="button" class="switch" role="switch" aria-label="${esc(META[D.id]?.name || D.id)} ${h.text}" aria-checked="${h.on}"${h.pending ? ' aria-disabled="true" title="在下方填写后自动打开"' : ""} data-a="enabled"><i></i></button></label>`;
    }
    function syncHeadSwitch() {
      const hs = $(".head-switch", dlg);
      if (!hs) return;
      const h = headState();
      const sw = $(".switch", hs);
      hs.dataset.pending = String(h.pending);
      $(".hs-text", hs).textContent = h.text;
      sw.setAttribute("aria-checked", String(h.on));
      if (h.pending) {
        sw.setAttribute("aria-disabled", "true");
        sw.title = "在下方填写后自动打开";
      } else {
        sw.removeAttribute("aria-disabled");
        sw.removeAttribute("title");
      }
    }
    function renderCard() {
      const id = D.id;
      const m = META[id];
      const p = D.draft;
      const ctl = headSwitch();
      const head = `<header class="dlg-head">${tile(id, 40)}<div class="dlg-titles"><h2 id="dlgTitle">${m.name}</h2><p class="dlg-sub"><span>${subText(id)}</span><a class="dlg-link" href="${m.link}" target="_blank" rel="noopener noreferrer">${EXT(m.linkText)}</a></p></div>${ctl}<button type="button" class="icon-btn" data-a="close" aria-label="关闭">${svg("x")}</button></header>`;
      const locked = !S.capabilities?.secretsAllowed ? note("当前连接仅支持脱敏查看。请使用已认证的本机直连或 HTTPS 连接查看和保存 Key。") : "";
      const body = `<div class="dlg-body">${locked}<form class="dlg-form" novalidate>${FIELDS[id](p)}<div id="quotaSlot"></div></form><div class="note search-result" role="status" aria-live="polite" aria-atomic="true" hidden></div></div>`;
      const clearable = Object.values(CARD_FIELDS[id]).some((key) => D.fields[key]?.source === "file" && !D.fields[key]?.readOnly);
      const clearBtn = clearable ? `<button type="button" class="btn btn-ghost btn-sm btn-danger" data-a="clear"${S.capabilities?.secretsAllowed ? "" : " disabled"}>清除配置</button>` : "";
      const foot = `<footer class="dlg-foot">${clearBtn}<span class="foot-note"></span><button type="button" class="btn btn-sm grow" data-a="cancel">取消</button><button type="button" class="btn btn-primary btn-sm grow" data-a="save">保存</button></footer>`;
      dlg.innerHTML = head + body + foot;
      const form = $(".dlg-form", dlg);
      if (form) form.addEventListener("submit", (e) => e.preventDefault());
      refreshDialog();
    }
    function openCard(id, opt = {}) {
      if (S.loading || S.busy || !META[id]) return;
      quotaView?.cancel();
      closePop();
      const base = clone(S.prov[id]);
      if (id !== "github" && !isSet(id, base)) base.enabled = true;
      const draft = clone(base);
      if (opt.enable) draft.enabled = true;
      D = {
        kind: "card",
        id,
        draft,
        base,
        fields: clone(configFields()),
        configBaseline: clone(S.config),
        orig: JSON.stringify(normCard(base)),
        revealing: /* @__PURE__ */ new Map(),
        closed: false,
        touched: /* @__PURE__ */ new Set(),
        edited: /* @__PURE__ */ new Set(),
        show: {},
        submitted: false,
        warned: false,
        saving: false,
        clearing: false,
        clearArmed: false,
        clearTimer: 0,
        returnFocus: opt.from || rowOf(id)?.querySelector(".row-main")
      };
      showOverlay();
      renderCard();
      void quotaView?.open();
      requestAnimationFrame2(initialFocus);
    }
    function stepper(k, v) {
      const n = NUM[k];
      const ok = Number.isFinite(v);
      const ro = fieldReadOnly(k);
      const dn = `<button type="button" data-a="step" data-k="${k}" data-d="-1" aria-label="减少"${ro || ok && v <= n.min ? " disabled" : ""}>${svg("minus", "ic ic-sm")}</button>`;
      const up = `<button type="button" data-a="step" data-k="${k}" data-d="1" aria-label="增加"${ro || ok && v >= n.max ? " disabled" : ""}>${svg("plus", "ic ic-sm")}</button>`;
      return `<div class="stepper${ro ? " is-readonly" : ""}">${dn}<input id="${fid(k)}" type="text" inputmode="numeric" data-k="${k}" value="${ok ? v : ""}" autocomplete="off"${ro ? " readonly" : ""}><span class="unit">${n.unit}</span>${up}</div>`;
    }
    function step(k, d) {
      if (!D || dialogBusy() || fieldReadOnly(k)) return;
      const n = NUM[k];
      const cur = Number.isFinite(D.draft[k]) ? D.draft[k] : n.min;
      const v = Math.min(n.max, Math.max(n.min, Math.round((cur + d * n.step) / n.step) * n.step));
      D.draft[k] = v;
      dlg.querySelector(`input[data-k="${k}"]`).value = v;
      D.touched.add(k);
      D.warned = false;
      syncStepper(k);
      refreshDialog();
    }
    function syncStepper(k) {
      const n = NUM[k];
      const v = D.draft[k];
      const [dn, up] = $$(`[data-a=step][data-k="${k}"]`, dlg);
      const set = (b, dis) => {
        const had = active() === b;
        b.disabled = dis;
        if (dis && had) dlg.querySelector(`input[data-k="${k}"]`).focus();
      };
      set(dn, Number.isFinite(v) && v <= n.min);
      set(up, Number.isFinite(v) && v >= n.max);
    }
    function vHub(h) {
      return validateHub(h, { base: D?.base, readOnly: fieldReadOnly });
    }
    function hubBody(h) {
      const config = configLocation();
      const source = S.program?.program?.source;
      const prog = {
        tag: `<span class="tag" data-tone="${S.program?.phase === "ready" ? "ok" : "warn"}">${esc(programSource())}</span>`,
        path: S.program?.program?.path || S.program?.error?.message || "正在自动检测，无需填写路径"
      };
      const version = S.program?.program?.version ? "v" + S.program.program.version : programPhase();
      const repair = S.program?.canRepair === true || S.program?.error?.code === "GROK_CACHE_DAMAGED";
      const hit = ["manual", "loader"].includes(source) ? 0 : ["path", "npm", "cargo"].includes(source) ? 1 : source === "private-cache" ? 2 : -1;
      const order = ["插件设置里的程序路径（只读）", "系统 PATH、npm 或 Cargo 的已有安装", "缺失时下载到插件私有缓存"].map((t, i) => `<li class="${i === hit ? "is-hit" : ""}">${t}${i === hit ? " · 当前使用" : ""}</li>`).join("");
      const cfgTag = S.cfgExists ? '<span class="tag" data-tone="agent">已存在</span>' : '<span class="tag" data-tone="warn">首次保存时创建</span>';
      const secProg = [
        '<section class="sec"><h3 class="sec-h">程序</h3>',
        `<div class="prog"><div class="prog-main"><span class="prog-title">grok-search-rs ${esc(version)} ${prog.tag}</span><span class="prog-path" title="${esc(prog.path)}">${esc(prog.path)}</span></div><button type="button" class="btn btn-sm" data-a="redetect" data-repair="${repair}">${svg("refresh", "ic ic-sm")}${repair ? "重新准备" : "重新检测"}</button></div>`,
        '<p class="f-help" style="margin:10px 0 6px">按以下顺序查找，已有兼容安装直接复用；不会覆盖全局程序：</p>',
        `<ol class="order">${order}</ol></section>`
      ].join("");
      const secCfg = [
        '<section class="sec"><h3 class="sec-h">共享配置文件</h3>',
        `<div class="prog"><div class="prog-main"><span class="prog-title">${esc(config.name)} ${cfgTag}</span><span class="prog-path" title="${esc(config.full)}">${esc(config.label)}</span></div>`,
        `<button type="button" class="btn btn-ghost btn-sm" data-a="open-file"${S.cfgExists ? "" : " disabled"}>${svg("file", "ic ic-sm")}打开文件</button>`,
        `<button type="button" class="btn btn-ghost btn-sm" data-a="open-folder">${svg("folder", "ic ic-sm")}所在文件夹</button></div>`,
        note("保存后写入此 Grok 配置文件。其他使用同一文件的应用也会读取这些设置；使用独立配置的应用不受影响。插件保存前会自动备份，并保留原有注释与排版。"),
        "</section>"
      ].join("");
      const secRoute = [
        '<section class="sec"><h3 class="sec-h">路由</h3>',
        field({ label: "路由策略", ctl: '<span class="static-val">按顺序<span class="tag">补充来源依次尝试</span></span>', help: "原生 Grok 会并行获取主搜与补充结果。Grok 关闭或程序不可用时，DSH 直接按补充链顺序尝试，首个有结果的来源返回；测试会另行检查全部已开启来源及 Key。" }),
        field({ label: "补充来源数", k: "extra", ctl: stepper("extra", h.extra), help: "Grok 正常返回时，额外展示的结果条数，不是供应商数量。供应商由主界面开关控制；设为 0 不附加补充结果，仍可失败回退。" }),
        field({ label: "回退来源数", k: "fallback", ctl: stepper("fallback", h.fallback), help: "Grok 调用失败或缺少可核验引用时，最多返回的回退结果条数，不是供应商数量。" }),
        field({ label: "请求超时", k: "timeout", ctl: stepper("timeout", h.timeout), help: "整条搜索链共用一个截止时间，不是每个来源各算一次。" }),
        "</section>"
      ].join("");
      const secAdv = [
        `<section class="sec"><button type="button" class="adv-toggle" data-a="adv" aria-expanded="${!!D.advOpen}" aria-controls="advBox">${svg("chev", "ic ic-sm")}高级<span class="adv-hint">缓存、回复上限、插件专属设置</span></button>`,
        `<div class="adv${D.advOpen ? " is-open" : ""}" id="advBox"><div${D.advOpen ? "" : " inert"}>`,
        field({ label: "会话缓存", k: "cache", ctl: stepper("cache", h.cache), help: "供 get_sources 回看来源的会话缓存条数。" }),
        field({ label: "回复字符上限", k: "maxChars", ctl: stepper("maxChars", h.maxChars), help: "单次搜索返回给 DSH 的最大字符数。" }),
        `<p class="sub-h">${svg("lock", "ic ic-sm")}插件专属设置 · 此处只读</p>`,
        field({ label: "单次搜索预算", k: "budget", ctl: stepper("budget", h.budget), help: "DSH 等待一次搜索的最长时间，30–120 秒。" }),
        field({ label: "程序路径", hint: "覆盖自动检测", k: "exeOverride", ctl: txt("exeOverride", h.exeOverride, "留空则自动检测"), help: "在 DSH 插件配置中设置，此处只显示当前值。通常无需指定。" }),
        field({ label: "配置路径", hint: "覆盖默认位置", k: "cfgOverride", ctl: txt("cfgOverride", h.cfgOverride, "自动使用 " + config.label), help: "在 DSH 插件配置中设置，此处只显示当前值。通常无需指定。" }),
        note("进程环境变量优先于 config.toml 中的同名设置；设置了 <code>GROK_SEARCH_CONFIG</code> 时，以它指向的文件为准。"),
        "</div></div></section>"
      ].join("");
      return secProg + secCfg + secRoute + secAdv;
    }
    function renderHub() {
      const version = S.program?.program?.version ? "v" + S.program.program.version : programPhase();
      const head = `<header class="dlg-head"><span class="tile tile-glyph" style="--s:40px">${svg("hub")}</span><div class="dlg-titles"><h2 id="dlgTitle">Grok Search Rs</h2><p class="dlg-sub"><span>${esc(version)} · MIT · 把 Grok 与各搜索来源串成一条路由</span><a class="dlg-link" href="https://github.com/Episkey-G/GrokSearch-rs" target="_blank" rel="noopener noreferrer">${EXT("GitHub 仓库")}</a></p></div><button type="button" class="icon-btn" data-a="close" aria-label="关闭">${svg("x")}</button></header>`;
      const foot = '<footer class="dlg-foot"><span class="foot-note"></span><button type="button" class="btn btn-sm grow" data-a="cancel">取消</button><button type="button" class="btn btn-primary btn-sm grow" data-a="save">保存</button></footer>';
      dlg.innerHTML = head + `<div class="dlg-body">${hubBody(D.draft)}</div>` + foot;
      refreshDialog();
    }
    function toggleAdv(b) {
      D.advOpen = !D.advOpen;
      b.setAttribute("aria-expanded", String(D.advOpen));
      const box = $("#advBox", dlg);
      box.classList.toggle("is-open", D.advOpen);
      box.firstElementChild.inert = !D.advOpen;
      if (D.advOpen) setTimeout2(() => box.scrollIntoView({ block: "nearest", behavior: reduced() ? "auto" : "smooth" }), 140);
    }
    async function redetect(b) {
      if (!D || dialogBusy() || b.disabled) return;
      const html = b.innerHTML;
      const repair = b.dataset.repair === "true";
      b.disabled = true;
      b.innerHTML = `<span class="spin"></span>${repair ? "准备中…" : "检测中…"}`;
      const mine = D;
      S.busy = true;
      try {
        const program = await (repair ? remote.repairProgram() : remote.prepareProgram());
        if (disposed || D !== mine) return;
        S.program = program;
        renderHead();
        toast(`${programPhase()} · ${programSource()}${program.program?.version ? " v" + program.program.version : ""}`, { tone: "info" });
        renderHub();
      } catch (error) {
        await refresh({ force: true, readLog: false });
        if (!disposed && D === mine) operationError(error, true);
      } finally {
        S.busy = false;
        if (b.isConnected) {
          b.disabled = false;
          b.innerHTML = html;
        }
        if (!disposed) syncAll(true);
      }
    }
    async function commitHub(draft = D.draft) {
      const mine = D;
      const updates = Object.fromEntries(Object.entries(HUB_FIELDS).filter(([name]) => !fieldReadOnly(name) && !Object.is(draft[name], mine.base[name])).map(([name, key]) => [key, draft[name]]));
      const receipt = await saveConfig(updates, mine.configBaseline);
      if (disposed || D !== mine) return;
      mine.saving = false;
      closeDialog(true);
      syncAll(false);
      toast("已写入 Grok 共享配置 · 下次搜索生效", { undo: configUndo(receipt) });
    }
    function openHub(opt = {}) {
      quotaView?.cancel();
      if (S.loading || S.busy) return;
      closePop();
      D = {
        kind: "hub",
        draft: clone(S.hub),
        base: clone(S.hub),
        fields: clone(configFields()),
        configBaseline: clone(S.config),
        orig: JSON.stringify(normHub(S.hub)),
        touched: /* @__PURE__ */ new Set(),
        edited: /* @__PURE__ */ new Set(),
        show: {},
        submitted: false,
        warned: false,
        saving: false,
        advOpen: !!opt.adv,
        returnFocus: opt.from || $("#nodeHub")
      };
      showOverlay();
      renderHub();
      requestAnimationFrame2(initialFocus);
    }
    function openPop() {
      if ($("#testBtn").disabled) return;
      testPop.hidden = false;
      $("#testBtn").setAttribute("aria-expanded", "true");
      requestAnimationFrame2(() => testPop.querySelector("[data-pop=go]").focus());
    }
    function closePop(refocus) {
      if (testPop.hidden) return;
      testPop.hidden = true;
      $("#testBtn").setAttribute("aria-expanded", "false");
      if (refocus) $("#testBtn").focus();
    }
    $("#testBtn").addEventListener("click", () => {
      if (S.testing) {
        cancelTest({ preserve: true });
        syncAll(true);
        return;
      }
      if (testPop.hidden) openPop();
      else closePop();
    });
    testPop.addEventListener("click", (e) => {
      const b = e.target.closest("[data-pop]");
      if (!b) return;
      if (b.dataset.pop === "go") {
        closePop();
        $("#testBtn").focus();
        runTest();
      } else closePop(true);
    });
    listen(document, "pointerdown", (e) => {
      if (!testPop.hidden && !targetOf(e).closest?.(".rc-actions")) closePop();
    });
    function travel(wid, o = {}) {
      return new Promise((resolve) => {
        const view = o.view;
        const g = view ? view.paths.get(wid)?.group : wireNodes.get(wid);
        if (!g) {
          resolve();
          return;
        }
        const path = g.children[1];
        g.classList.add("lit");
        path.style.strokeDasharray = "";
        path.style.strokeLinecap = "";
        g.children[2].style.opacity = g.children[3].style.opacity = "0";
        const canvas = view ? view.svg : wiresEl;
        const packets = view ? view.packetLayer : packetLayer;
        canvas.insertBefore(g, packets);
        const pk = document.createElementNS(SVGNS, "g");
        pk.setAttribute("class", "packet");
        pk.innerHTML = '<circle class="p-halo" r="7"></circle><circle class="p-core" r="3.2"></circle>';
        pk.dataset.return = String(!!o.back);
        pk.dataset.wire = wid;
        packets.appendChild(pk);
        const dur = o.dur || T.hop;
        const t0 = performance.now();
        const myGen = gen;
        let raf;
        const finish = () => {
          cancelAnimationFrame2(raf);
          waits.delete(finish);
          view?.cancelers.delete(finish);
          pk.remove();
          resolve();
        };
        waits.add(finish);
        view?.cancelers.add(finish);
        const frame = (now) => {
          if ((view ? view.cancelled : myGen !== gen) || disposed) {
            finish();
            return;
          }
          const t = Math.min(1, (now - t0) / dur);
          const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
          const len = path.getTotalLength();
          const pt = path.getPointAtLength((o.back ? 1 - e : e) * len);
          pk.setAttribute("transform", `translate(${pt.x},${pt.y})`);
          if (t < 1) raf = requestAnimationFrame2(frame);
          else finish();
        };
        raf = requestAnimationFrame2(frame);
      });
    }
    function cut(wid) {
      const g = wireNodes.get(wid);
      if (!g) return;
      g.classList.remove("lit");
      g._bt = performance.now();
      delete g._bf;
      pumpWires(480);
    }
    const jolts = /* @__PURE__ */ new Map();
    const faultPulses = /* @__PURE__ */ new Map();
    function pulseFault(el) {
      if (!el) return;
      clearTimeout2(faultPulses.get(el));
      el.classList.add("is-fault-flash");
      const timer = setTimeout2(() => {
        if (faultPulses.get(el) !== timer) return;
        el.classList.remove("is-fault-flash");
        faultPulses.delete(el);
      }, 1100);
      faultPulses.set(el, timer);
    }
    function jolt(el, soft = false, pump = pumpWires) {
      if (!el || reduced()) return Promise.resolve();
      jolts.get(el)?.();
      return new Promise((resolve) => {
        let leadTimer, cleanupTimer;
        const name = soft ? "route-jolt-soft" : "route-jolt";
        const clean = () => {
          clearTimeout2(leadTimer);
          clearTimeout2(cleanupTimer);
          el.removeEventListener("animationend", onEnd);
          el.removeEventListener("animationcancel", onEnd);
          if (jolts.get(el) === clean) {
            el.classList.remove("is-jolt", "is-jolt-soft");
            jolts.delete(el);
          }
          resolve();
        };
        const onEnd = (e) => {
          if (e.target === el && e.animationName === name) clean();
        };
        jolts.set(el, clean);
        el.classList.remove("is-searching", "flash-ok", "is-jolt", "is-jolt-soft");
        void el.offsetWidth;
        el.classList.add(soft ? "is-jolt-soft" : "is-jolt");
        el.addEventListener("animationend", onEnd);
        el.addEventListener("animationcancel", onEnd);
        leadTimer = setTimeout2(resolve, soft ? 220 : 300);
        cleanupTimer = setTimeout2(clean, soft ? 380 : 500);
        pump(soft ? 360 : 480);
      });
    }
    function clearLit() {
      hideStripTip();
      jolts.forEach((clean) => clean());
      faultPulses.forEach((timer, el) => {
        clearTimeout2(timer);
        el.classList.remove("is-fault-flash");
      });
      faultPulses.clear();
      wireNodes.forEach((g) => {
        g.classList.remove("lit");
        g.dataset.requesting = "false";
      });
      if (packetLayer) packetLayer.replaceChildren();
      $("#nodeHub").classList.remove("is-busy", "is-falling");
      $("#hubPillText").textContent = "按顺序";
      $$(".row.is-searching").forEach((r) => r.classList.remove("is-searching"));
    }
    const T = { hop: 380, grok: 720, supp: 560, fail: 420, hold: 900, trace: 6500 };
    const untestedCode = (code) => [
      "GROK_QUEUE_TIMEOUT",
      "GROK_QUEUE_FULL",
      "GROK_SEARCH_STOPPING",
      "SETTINGS_DIAGNOSIS_CANCELLED",
      "SETTINGS_DIAGNOSIS_BUSY"
    ].includes(code);
    function flashRow(id) {
      const r = typeof id === "string" ? rowOf(id) : id;
      if (!r || reduced()) return;
      r.classList.remove("is-searching", "flash-ok");
      void r.offsetWidth;
      r.classList.add("flash-ok");
      setTimeout2(() => r.classList.remove("flash-ok"), 900);
    }
    function flashNode(el) {
      if (!el || reduced()) return;
      el.classList.remove("flash-ok");
      void el.offsetWidth;
      el.classList.add("flash-ok");
      setTimeout2(() => el.classList.remove("flash-ok"), 1100);
    }
    async function runTest() {
      const st0 = routeStatus();
      if (S.testing || S.busy || ["off", "load", "down", "cfgerr", "ctlerr", "connecting"].includes(st0) || !isOn("github") && ["wait", "none", "prep"].includes(st0)) return;
      logView?.cancel();
      const my = ++gen;
      const started = performance.now();
      clearToasts();
      $("#announcer").textContent = "";
      S.testing = true;
      clearTimeout2(S.traceTimer);
      S.trace = { bg: false, order: S.order.slice(), items: [], failedSources: [], done: null, reroute: false };
      S.lastRoute = null;
      renderHead();
      renderSummary();
      renderBanner();
      syncRows();
      pumpWires(200);
      const alive = () => my === gen && !disposed;
      const anim = !reduced();
      const go = (wid, opt) => anim ? travel(wid, opt) : Promise.resolve();
      const live = () => {
        renderHead();
        renderSummary();
        renderBanner();
        syncRows();
        pumpWires(360);
      };
      const hub = $("#nodeHub");
      const tr = S.trace;
      const providers = [
        ...grokOn() ? ["grok"] : [],
        ...enabledSupp(),
        ...isOn("github") ? ["github"] : []
      ];
      S.testProgress = { started, completed: 0, total: providers.length, current: "" };
      const diagnosticIdentity = { expectedRevision: S.config?.revision, configIdentity: S.config?.quotaRevision };
      tickTestProgress();
      const results = [];
      let primaryFailed = false, supplementaryReady = false;
      try {
        hub.classList.add("is-busy");
        for (const id of providers) {
          if (!alive()) return;
          S.testProgress.current = META[id].name;
          if (primaryFailed && SUPP.includes(id)) {
            hub.classList.add("is-falling");
            $("#hubPillText").textContent = "检测补充来源";
          }
          const slots = id === "tavily" ? tvKeyIdx() : [0];
          const items = slots.map((slot) => ({ id, key: slot, label: META[id].name, tone: "run" }));
          tr.items.push(...items);
          const row = rowOf(id);
          row.classList.add("is-searching");
          live();
          const operationId = uuid();
          S.diagnosticOperation = operationId;
          const request = remote.diagnoseProvider({ provider: id, operationId, ...diagnosticIdentity }).catch((error) => ({
            provider: id,
            status: "failed",
            code: normalizeCode(error?.code || "SETTINGS_UNAVAILABLE"),
            message: error?.message || "设置请求失败。",
            keys: []
          }));
          await go("hub-" + id);
          if (!alive()) return;
          const result = await request;
          if (!alive()) return;
          S.diagnosticOperation = null;
          if (result.code === "CONFIG_CONFLICT") {
            cancelTest();
            S.checked = {};
            toast("配置已更新，请按当前配置重新测试。", { tone: "info" });
            await refresh({ force: true });
            return;
          }
          S.testProgress.completed++;
          delete S.providerBad[id];
          row.classList.remove("is-searching");
          results.push(result);
          const skipped = ["disabled", "not-configured"].includes(result.status) || untestedCode(result.code);
          const entries = result.keys?.length ? result.keys : slots.map((slot) => ({ keyIndex: slot, ...result }));
          for (const entry of entries) {
            const index = entry.keyIndex ?? 0;
            const item = items.find((it) => it.key === index);
            const code = entry.status === "failed" ? normalizeCode(entry.code) : "";
            const untested = skipped || untestedCode(entry.code);
            if (item) {
              item.tone = untested ? "idle" : code ? "err" : "ok";
              item.code = untested ? "" : code;
            }
            if (!untested) {
              rememberCheck(id, index, code, "test");
              S.checked[id][index].status = entry.status;
            }
          }
          if (id === "grok") primaryFailed = result.status === "failed";
          if (SUPP.includes(id) && result.status === "ok") supplementaryReady = true;
          if (result.status === "failed") tr.failedSources.push(id);
          live();
          if (skipped && untestedCode(result.code)) {
            toast(`${META[id].name}：${errText(result.code)}，未验证 Key。`, { tone: "info" });
          } else if (result.status === "failed" || result.partial) {
            pulseFault(row);
            await jolt(row, result.partial === true);
            if (!alive()) return;
            if (result.status === "failed") cut("hub-" + id);
          } else if (!skipped) {
            flashRow(id);
            await go("hub-" + id, { back: true });
          }
          if (!alive()) return;
        }
        const searchResults = results.filter((result) => result.provider !== "github" && !["disabled", "not-configured"].includes(result.status));
        const github = results.find((result) => result.provider === "github");
        const unfinished = results.filter((result) => untestedCode(result.code) || result.keys?.some((key) => untestedCode(key.code))).length;
        const passed = searchResults.filter((result) => result.status === "ok");
        const empty = searchResults.filter((result) => result.status === "empty");
        const valid = passed.length + empty.length;
        const searchAvailable = [...passed, ...empty].some((result) => result.provider !== "github");
        const searchAttempted = searchResults.some((result) => result.provider !== "github");
        const seconds = ((performance.now() - started) / 1e3).toFixed(1);
        tr.done = {
          tone: searchAvailable ? "ok" : "err",
          text: `${valid}/${searchResults.length} 项连通${empty.length ? ` · ${empty.length} 项无结果` : ""} · ${seconds} 秒`
        };
        if (!searchAvailable) {
          tr.done.text = searchAttempted ? `搜索未通过 · ${valid}/${searchResults.length} 项连通 · ${seconds} 秒` : `${github?.status === "ok" ? "GitHub 读取可用" : "GitHub 读取未通过"} · 未测试网页搜索`;
          tr.done.tone = searchAttempted || github?.status !== "ok" ? "err" : "ok";
          if (searchAttempted || github?.status !== "ok") cut("dsh-hub");
        } else if (primaryFailed && supplementaryReady) {
          tr.done.text = `Grok 未通过 · ${passed.length}/${searchResults.length} 项可用${empty.length ? ` · ${empty.length} 项无结果` : ""} · ${seconds} 秒`;
          await go("dsh-hub", { back: true });
          if (!alive()) return;
          flashNode($("#nodeDsh"));
        }
        if (unfinished) tr.done.text = `测试未完成 · ${unfinished} 项未完整验证 · ${seconds} 秒`;
        if (searchAttempted && github) tr.done.text += ` · GitHub ${github.status === "ok" ? "可用" : "未通过"}`;
        live();
        const failures = searchResults.filter((result) => result.status === "failed").map((result) => `${META[result.provider].name} ${normalizeCode(result.code)} · ${errText(result.code)}`);
        $("#announcer").textContent = joinSentences(
          unfinished ? "部分项目未完成，不能据此判定 Key 失效" : "已检查全部开启的来源与 Key",
          tr.done.text,
          failures.join("；"),
          github ? `GitHub：${github.message}` : ""
        );
      } finally {
        if (alive()) {
          S.diagnosticOperation = null;
          S.testing = false;
          clearTimeout2(S.testProgressTimer);
          S.testProgress = null;
          clearLit();
          S.traceTimer = setTimeout2(() => {
            if (!S.testing && S.trace === tr) {
              S.trace = null;
              renderSummary();
              pumpWires(200);
            }
          }, T.trace);
          syncAll(true);
        }
      }
    }
    function setTheme(dark2) {
      if (disposed) return;
      const next = dark2 === true || dark2 === "dark";
      if (darkTheme === next) return;
      darkTheme = next;
      root.dataset.theme = layer.dataset.theme = darkTheme ? "dark" : "light";
      refreshLogos();
      logView?.theme();
      quotaView?.render();
      bannerHtml = null;
      renderBanner();
    }
    let pathOpening = false;
    function syncPathOpening() {
      $$('[data-open], [data-a="open-file"], [data-a="open-folder"], [data-act="open-file"]').forEach((button) => {
        button.disabled = pathOpening || button.matches('[data-open="file"]') && !S.cfgExists;
        if (pathOpening) button.setAttribute("aria-busy", "true");
        else button.removeAttribute("aria-busy");
      });
    }
    function pathOpenNotice(message, path, tone = "info") {
      toast(message, { tone, ms: 7e3, ...path ? {
        action: { label: "复制路径", icon: "copy", run: async () => {
          if (!navigator.clipboard) {
            toast("浏览器不允许复制，请手动选择路径。", { tone: "warn" });
            return;
          }
          try {
            await navigator.clipboard.writeText(path);
            if (!disposed) toast("配置路径已复制");
          } catch {
            if (!disposed) toast("复制失败，请手动选择路径。", { tone: "warn" });
          }
        } }
      } : {} });
    }
    async function openPath(kind) {
      if (disposed || pathOpening) return;
      pathOpening = true;
      syncPathOpening();
      try {
        const result = await remote.openConfigLocationWithStatus({ kind });
        if (disposed) return;
        if (result.opened && result.fallbackReason) toast("已使用备用文本编辑器打开", { tone: "info" });
        else if (!result.opened) pathOpenNotice(result.copyOnly ? "此页面不能打开宿主文件，请复制路径后在 DSH 所在设备打开。" : !result.exists && kind === "file" ? "配置文件尚未创建，首次保存后可打开。" : `未能在宿主打开：${result.path}`, kind === "folder" ? parentPath(result.path) : result.path);
      } catch (error) {
        if (!disposed && /^CONFIG_OPEN_/.test(error?.code || "")) {
          const location = configLocation();
          pathOpenNotice(
            error.message || "无法打开配置位置，请复制路径后手动打开。",
            kind === "folder" ? location.dir : location.full,
            "err"
          );
        } else if (!disposed) operationError(error);
      } finally {
        pathOpening = false;
        if (!disposed) syncPathOpening();
      }
    }
    $$(".rc-foot [data-open]").forEach((b) => b.addEventListener("click", () => openPath(b.dataset.open)));
    $("#bannerSlot").addEventListener("click", (e) => {
      const b = e.target.closest("[data-act]");
      if (!b) return;
      const a = b.dataset.act;
      if (a === "retry") void refresh({ force: true });
      else if (a === "retry-control") void retryControl();
      else if (a === "open-file") void openPath("file");
      else if (a.startsWith("open:")) openCard(a.slice(5), { from: b });
      else if (a === "grok-off" || a === "grok-on") {
        const r = rowOf("grok");
        if (isOn("grok") !== (a === "grok-on")) onRowSwitch("grok", r);
      } else if (a === "dismiss-read") {
        S.readDismissed = true;
        renderBanner();
      } else if (a === "dismiss-aux") {
        S.auxDismissed = b.dataset.k;
        renderBanner();
      }
    });
    $("#nodeHub").addEventListener("click", (e) => openHub({ from: e.currentTarget }));
    function init() {
      logView = createSearchLogView2({
        $,
        $$,
        active,
        S,
        card,
        layer,
        listen,
        remote,
        uuid,
        clone,
        esc,
        svg,
        tile,
        logoSrc,
        isDark,
        reduced,
        META,
        SUPP,
        setTimeout: setTimeout2,
        clearTimeout: clearTimeout2,
        requestAnimationFrame: requestAnimationFrame2,
        cancelAnimationFrame: cancelAnimationFrame2,
        T,
        jolts,
        faultPulses,
        syncBreak,
        travel,
        jolt,
        pulseFault,
        flashRow,
        flashNode,
        pumpWires,
        closePop,
        hideStripTip,
        toast,
        errText,
        rowOf,
        SVGNS,
        logMemory,
        onPrivateAccessDenied: denyPrivateAccess
      });
      quotaView = createQuotaView2({
        $,
        S,
        getDialog: () => D,
        dlg,
        active,
        DEF,
        SUPP,
        svg,
        EXT,
        esc,
        hidden,
        reduced,
        dialogBusy,
        remote,
        uuid,
        hideTip: () => {
          if (stripTipTarget?.matches("[data-quota-tip]")) hideStripTip();
        }
      });
      listen(dlg, "pointerover", (event) => {
        const tip = event.target.closest("[data-quota-tip]");
        if (tip && tip !== stripTipTarget) showStripTip(tip);
      });
      listen(dlg, "pointerout", (event) => {
        if (!event.target.closest("[data-quota-tip]")) return;
        if (event.relatedTarget && (stripTipTarget?.contains(event.relatedTarget) || routeTooltip.contains(event.relatedTarget))) return;
        clearTimeout2(stripTipTimer);
        stripTipTimer = setTimeout2(() => {
          if (stripTipTarget !== active()) hideStripTip();
        }, 100);
      });
      listen(dlg, "focusin", (event) => {
        if (event.target.matches("[data-quota-tip]")) showStripTip(event.target);
      });
      listen(dlg, "focusout", (event) => {
        if (event.target.matches("[data-quota-tip]") && !routeTooltip.contains(event.relatedTarget)) hideStripTip();
      });
      listen(dlg, "click", (event) => {
        const tip = event.target.closest("[data-quota-tip]");
        if (tip) showStripTip(tip);
        else if (stripTipTarget?.matches("[data-quota-tip]")) hideStripTip();
        const action = event.target.closest("[data-a]")?.dataset.a;
        if (action === "quota-refresh") void quotaView.refresh();
      });
      listen(dlg, "change", (event) => {
        if (event.target.matches("[data-quota-key]")) quotaView.key(Number(event.target.value));
      });
      $("#hubGlyph").innerHTML = svg("hub");
      $("[data-open=file]").insertAdjacentHTML("afterbegin", svg("file", "ic ic-sm"));
      $("[data-open=folder]").insertAdjacentHTML("afterbegin", svg("folder", "ic ic-sm"));
      $(".rg-hint").insertAdjacentHTML("afterbegin", svg("grip", "ic ic-sm"));
      $("#testBtn").setAttribute("aria-haspopup", "dialog");
      $("#testBtn").setAttribute("aria-expanded", "false");
      card.dataset.layout = "wide";
      refreshLogos();
      quiet(900);
      buildRows(false);
      syncAll(true);
      void refresh({ first: true }).then(() => {
        if (disposed) return;
        animateRows(!memory.mounted);
        if (!memory.mounted) wiresEl.classList.add("draw");
        pumpWires(720);
      });
      schedulePoll();
    }
    listen(document, "visibilitychange", () => {
      if (document.visibilityState !== "hidden") {
        void refresh();
        pumpWires(180);
      }
    });
    listen(RM, "change", () => {
      logView?.cancel();
      quotaView?.stopAnimations();
      quiet(1e3);
      clearLit();
      pumpWires(80);
    });
    init();
    return Object.freeze({
      setTheme,
      refresh: () => refresh({ force: true }),
      dispose() {
        if (disposed) return;
        if (D?.githubOperation) void remote.cancelDiagnosis({ operationId: D.githubOperation }).catch(() => {
        });
        logView?.dispose();
        quotaView?.dispose();
        cancelDrag();
        cancelOwnedDiagnosis();
        gen++;
        clearTimeout2(overlayEntranceTimer);
        shakeCleanups.get(dlg)?.();
        clearLit();
        resizeObserver.disconnect();
        historyActionsObserver.disconnect();
        Object.assign(memory, {
          mounted: true,
          checked: clone(S.checked),
          bad: clone(S.bad),
          providerBad: clone(S.providerBad),
          identity: clone(S.identity),
          readDismissed: S.readDismissed,
          auxDismissed: S.auxDismissed,
          lastRouteAt: S.lastRouteAt,
          configRevision: S.configRevision,
          configIdentity: S.configIdentity,
          configPath: S.configPath,
          lastRoute: clone(S.lastRoute)
        });
        D = null;
        overlay.hidden = true;
        dlg.replaceChildren();
        disposed = true;
        listeners.forEach((off) => off());
        timers.forEach((id) => window.clearTimeout(id));
        frames.forEach((id) => window.cancelAnimationFrame(id));
        timers.clear();
        frames.clear();
        waits.forEach((done) => done());
        waits.clear();
        root.replaceChildren();
        layer.replaceChildren();
      }
    });
  }

  // src/ui/search-log-view.mjs
  function createSearchLogView(host) {
    const {
      $,
      $$,
      active,
      S,
      card,
      layer,
      listen,
      remote,
      uuid,
      clone,
      esc,
      svg,
      tile,
      logoSrc,
      isDark,
      reduced,
      META,
      SUPP,
      setTimeout: setTimeout2,
      clearTimeout: clearTimeout2,
      requestAnimationFrame: requestAnimationFrame2,
      cancelAnimationFrame: cancelAnimationFrame2,
      T,
      jolts,
      faultPulses,
      syncBreak,
      travel,
      jolt,
      pulseFault,
      flashRow,
      flashNode,
      pumpWires,
      closePop,
      hideStripTip: hideRouteTip,
      toast,
      errText,
      rowOf,
      SVGNS,
      logMemory,
      onPrivateAccessDenied
    } = host;
    const HUB_DISPLAY_NAME = "Grok Search Rs";
    let sessionId = typeof remote.openSearchLog === "function" ? null : uuid(), openTask = null;
    async function logSession() {
      if (sessionId) return sessionId;
      if (!openTask) openTask = remote.openSearchLog().then((result) => {
        if (disposed) {
          void remote.closeSearchLog(result).catch(() => {
          });
          return null;
        }
        sessionId = result.sessionId;
        return sessionId;
      }).finally(() => {
        openTask = null;
      });
      return openTask;
    }
    let disposed = false, readTask = null, generation = 0, clearing = false, pollTimer = 0;
    let readSignature = null;
    let logBaselined = false, logRestricted = false;
    let logReadError = null;
    const routeTooltip = $("#logTooltip");
    let stripTipTarget = null, stripTipTimer = 0;
    function hideStripTip() {
      clearTimeout2(stripTipTimer);
      stripTipTarget?.removeAttribute("aria-describedby");
      stripTipTarget = null;
      routeTooltip.hidden = true;
      routeTooltip.textContent = "";
      delete routeTooltip.dataset.kind;
    }
    function showStripTip(node) {
      hideRouteTip();
      if (!node?.isConnected || node.closest("[inert]")) {
        hideStripTip();
        return;
      }
      clearTimeout2(stripTipTimer);
      if (stripTipTarget !== node) stripTipTarget?.removeAttribute("aria-describedby");
      stripTipTarget = node;
      routeTooltip.textContent = node.dataset.logTip;
      routeTooltip.dataset.kind = "log";
      routeTooltip.hidden = false;
      node.setAttribute("aria-describedby", "logTooltip");
      const r = node.getBoundingClientRect();
      const t = routeTooltip.getBoundingClientRect();
      routeTooltip.style.left = Math.max(12, Math.min(innerWidth - t.width - 12, r.left + r.width / 2 - t.width / 2)) + "px";
      routeTooltip.style.top = Math.max(12, r.bottom + t.height + 10 < innerHeight ? r.bottom + 8 : r.top - t.height - 8) + "px";
    }
    function syncFocusedLogTip() {
      const node = stripTipTarget;
      if (node?.matches("[data-log-tip]") && node.isConnected && active() === node) {
        const bounds = node.getBoundingClientRect(), list = $("#logList").getBoundingClientRect();
        if (bounds.bottom > Math.max(0, list.top) && bounds.top < Math.min(innerHeight, list.bottom) && bounds.right > 0 && bounds.left < innerWidth) {
          showStripTip(node);
          return;
        }
      }
      hideStripTip();
    }
    listen(routeTooltip, "pointerenter", () => clearTimeout2(stripTipTimer));
    listen(routeTooltip, "pointerleave", () => {
      if (stripTipTarget !== active()) hideStripTip();
    });
    listen(document, "keydown", (event) => {
      if (event.key === "Escape") hideStripTip();
    });
    listen(window, "resize", hideStripTip);
    listen(window, "scroll", (event) => {
      if (!routeTooltip.contains(event.target)) syncFocusedLogTip();
    }, true);
    listen($("#logList"), "scroll", syncFocusedLogTip);
    const LOG_CAP = 20;
    const LOG_KINDS = /* @__PURE__ */ new Set(["ok", "sources", "fallback", "failed", "running", "cancelled", "unknown", "released", "enabled", "official"]);
    const LOG_CHANNELS = /* @__PURE__ */ new Set(["grok", "grok-sources", ...SUPP, "github"]);
    const LOG_CHIP = {
      ok: ["ok", "Grok 返回"],
      sources: ["ok", "补充来源"],
      fallback: ["warn", "已回退"],
      failed: ["err", "搜索失败"],
      running: ["run", "处理中"],
      cancelled: ["idle", "已取消"],
      released: ["idle", "官方已恢复"],
      enabled: ["idle", "插件已启用"],
      official: ["idle", "官方搜索"],
      unknown: ["idle", "结果未完整记录"]
    };
    const USAGE_CHANNELS = /* @__PURE__ */ new Set(["grok", "grok-sources", ...SUPP, "deepseek", "github"]);
    const USAGE_OPERATIONS = { search: "搜索", supplement: "补充搜索", fetch: "网页提取", retry: "重试" };
    const USAGE_RESULTS = { ok: "成功", failed: "失败", running: "处理中", cancelled: "已取消", unknown: "未报告" };
    function normalizeUsage(input) {
      const rows = Array.isArray(input) ? input : [];
      return rows.slice(0, 16).filter((item) => item && USAGE_CHANNELS.has(item.provider)).map((item) => {
        const basis = ["reported", "estimated"].includes(item.charge?.basis) ? item.charge.basis : "unknown";
        const amount = basis !== "unknown" && Number.isFinite(item.charge?.amount) && item.charge.amount >= 0 && item.charge.amount <= 1e9 ? item.charge.amount : null;
        const expectedUnit = item.provider === "tavily" || item.provider === "firecrawl" ? "credits" : "USD";
        const unit = item.charge?.unit === expectedUnit ? expectedUnit : null;
        const keyIndex = item.provider === "tavily" && Number.isSafeInteger(item.keyIndex) && item.keyIndex >= 0 && item.keyIndex < 100 ? item.keyIndex : null;
        return {
          provider: item.provider,
          operation: Object.hasOwn(USAGE_OPERATIONS, item.operation) ? item.operation : "search",
          result: Object.hasOwn(USAGE_RESULTS, item.result) ? item.result : "unknown",
          ...item.evidence === "source-label" ? { evidence: "source-label" } : {},
          code: /^[\w.-]{1,64}$/.test(item.code || "") ? item.code : "",
          keyIndex,
          charge: { basis: amount === null || !unit ? "unknown" : item.provider === "exa" ? "estimated" : basis, amount, unit }
        };
      });
    }
    let logRows = [];
    let logFilter = "all";
    let logSequence = 0;
    let logEpoch = 0;
    let logPrivate = logMemory?.private === true;
    let logRoutePlayback = null;
    let logReplayReturn = null;
    const logOpen = /* @__PURE__ */ new Set();
    const logNodes = /* @__PURE__ */ new Map();
    const logFingerprints = /* @__PURE__ */ new WeakMap();
    const logEvent = (rec) => rec.kind === "released" || rec.kind === "enabled";
    const logReplayable = (rec) => ["ok", "sources", "fallback", "failed", "official"].includes(rec.kind);
    const logTime = () => (/* @__PURE__ */ new Date()).toLocaleTimeString("zh-CN", { hour12: false });
    function normalizeLog(input, child = false) {
      if (!input || !LOG_KINDS.has(input.kind)) throw new TypeError("Unknown search log state.");
      const calls = logEvent(input) ? [] : normalizeUsage(input.calls);
      const record = {
        id: /^search-log-[0-9]+$/.test(input.id) ? input.id : `search-log-${++logSequence}`,
        t: String(input.t || (Number.isFinite(input.at) ? new Date(input.at).toLocaleTimeString("zh-CN", { hour12: false }) : logTime())).slice(0, 60),
        q: String(input.q || "").slice(0, 5e3),
        kind: input.kind,
        recordType: input.recordType === "github" ? "github" : "search",
        segment: Number.isSafeInteger(input.segment) && input.segment > 0 ? input.segment : null,
        cacheHit: input.cacheHit === true,
        hasMore: input.hasMore === true,
        acquiredComplete: input.acquiredComplete === true,
        apiRequests: Number.isSafeInteger(input.apiRequests) && input.apiRequests >= 0 ? input.apiRequests : null,
        served: LOG_CHANNELS.has(input.served) ? input.served : null,
        ms: !logEvent(input) && Number.isFinite(input.ms) && input.ms >= 0 && input.ms <= Number.MAX_SAFE_INTEGER ? input.ms : null,
        official: !logEvent(input) && Number.isSafeInteger(input.official) && input.official >= 0 ? input.official : null,
        reason: /^[\w.-]{1,64}$/.test(input.reason || "") ? input.reason : "",
        detail: String(input.detail || "").slice(0, 3e3),
        calls,
        callsComplete: !logEvent(input) && input.callsComplete === true && Array.isArray(input.calls) && input.calls.length === calls.length,
        epoch: logEpoch
      };
      if (Array.isArray(input.resultProviders) && !logEvent(input)) {
        record.resultProviders = [...new Set(input.resultProviders.filter((provider) => LOG_CHANNELS.has(provider) && provider !== "grok-sources"))].slice(0, 5);
        record.resultProvidersComplete = input.resultProvidersComplete === true && input.resultProviders.every((provider) => record.resultProviders.includes(provider));
      }
      if (!child && !logEvent(input) && Array.isArray(input.queries)) {
        record.queries = input.queries.slice(0, 16).filter((query) => query && LOG_KINDS.has(query.kind) && !logEvent(query)).map((query) => normalizeLog({
          ...query,
          t: query.t || (Number.isFinite(query.at) ? void 0 : record.t),
          kind: input.kind !== "running" && query.kind === "running" ? "unknown" : query.kind
        }, true));
        record.queryCount = Math.max(
          input.queries.length,
          record.queries.length,
          Number.isSafeInteger(input.queryCount) && input.queryCount >= 0 ? Math.min(input.queryCount, 1e6) : input.queries.length
        );
        record.queriesComplete = input.queriesComplete !== false && record.queryCount === record.queries.length && input.queries.length === record.queries.length;
        const kinds = record.queries.map((query) => query.kind);
        if (!["running", "failed", "cancelled", "unknown"].includes(input.kind)) {
          if (kinds.includes("failed")) record.kind = "failed";
          else if (kinds.includes("cancelled")) record.kind = "cancelled";
          else if (!record.queriesComplete || !kinds.length || kinds.includes("unknown")) record.kind = "unknown";
          else record.kind = input.kind === "fallback" || kinds.includes("fallback") ? "fallback" : kinds.every((kind) => kind === "official") ? "official" : kinds.every((kind) => kind === "sources") ? "sources" : "ok";
        }
      }
      return record;
    }
    const logQueries = (rec) => logEvent(rec) ? [] : rec.queries || [rec];
    const logQueryCount = (rec) => logEvent(rec) || rec.recordType === "github" ? 0 : rec.queryCount ?? 1;
    const logEntryId = (record, index = 0) => record.queries?.length ? `${record.id}-query-${record.queries[index].id}` : record.id;
    function logEntries() {
      const entries = [];
      for (const record of logRows) {
        if (record.queries?.length) {
          record.queries.forEach((query, index) => entries.push({
            ...query,
            id: logEntryId(record, index),
            parentId: record.id,
            queryIndex: index,
            receipt: {
              kind: record.kind,
              reason: record.reason,
              detail: record.detail,
              incomplete: record.queriesComplete === false
            }
          }));
        } else {
          entries.push({
            ...record,
            parentId: record.id,
            queryIndex: 0,
            receiptOnly: Array.isArray(record.queries),
            queries: void 0
          });
        }
        if (entries.length >= LOG_CAP) break;
      }
      return entries.slice(0, LOG_CAP);
    }
    function logDuration(ms) {
      if (ms === null) return "—";
      if (ms >= 864e5) return (ms / 864e5).toLocaleString("zh-CN", { maximumFractionDigits: 1 }) + " 天";
      return (ms / 1e3).toFixed(1) + " 秒";
    }
    const logSucceeded = (rec) => ["ok", "sources", "fallback", "official"].includes(rec.kind);
    function logStatus(rec) {
      if (rec.recordType === "github") {
        if (rec.kind === "failed") return ["err", "读取失败", "warn"];
        if (logSucceeded(rec)) return rec.hasMore ? ["warn", "可继续读取", "info"] : ["ok", "读取完成", "ok"];
      }
      if (rec.kind === "fallback") return ["warn", "已回退", "reroute"];
      if (logSucceeded(rec)) return ["ok", LOG_CHIP[rec.kind][1], "ok"];
      if (rec.kind === "failed") return ["err", "搜索失败", "warn"];
      if (rec.kind === "cancelled") return ["idle", "已取消", "minus"];
      if (rec.kind === "running") return ["run", "处理中", "refresh"];
      return [LOG_CHIP[rec.kind][0], LOG_CHIP[rec.kind][1], "info"];
    }
    function logStatusHtml(rec) {
      const [tone, label] = logStatus(rec);
      return `<span class="le-chip" data-t="${tone}"><span class="le-dot" aria-hidden="true"></span>${label}</span>`;
    }
    function logChannel(rec) {
      if (rec.kind === "released") return "官方路由已恢复";
      if (rec.kind === "enabled") return "尚未发起搜索";
      if (rec.kind === "official") return "DeepSeek 官方搜索";
      if (rec.kind === "running") return "等待结果回执";
      if (rec.kind === "cancelled") return "请求未完成";
      if (rec.kind === "unknown") return "结果未完整记录";
      if (rec.kind === "failed") return "无可用通道";
      if (rec.resultProviders?.length) return [
        ...rec.resultProviders.map((provider) => META[provider].name),
        ...rec.resultProvidersComplete ? [] : ["来源未报告"]
      ].join(" / ");
      if (rec.served === "grok-sources") return "来源未报告";
      return META[rec.served]?.name || "具体来源未报告";
    }
    function logVisibleQuery(rec) {
      return logPrivate && !logEvent(rec) ? rec.recordType === "github" ? "链接已隐藏" : "搜索内容已隐藏" : rec.recordType === "github" ? `GitHub${rec.segment ? ` · 分段 ${rec.segment}` : ""}${rec.cacheHit ? " · 缓存续读" : ""} · ${rec.q}` : rec.q;
    }
    function logNode(id, name, state, tone = "") {
      const mark = id === "hub" ? `<span class="lhub">${svg("hub")}</span>` : tile(id, 18);
      return `<span class="lnode" title="${esc(name)}" data-node="${id}" data-s="${state}"${tone ? ` data-tone="${tone}"` : ""}>${mark}<span class="ln-name">${esc(name)}</span></span>`;
    }
    function logWire(state) {
      return `<span class="lwire" data-s="${state}"></span>`;
    }
    function logRouteHtml(rec) {
      let route = logNode("dsh", "DSH", "hit");
      if (rec.recordType === "github") return route + logWire("flow") + logNode("hub", HUB_DISPLAY_NAME, "hit") + logWire(rec.kind === "failed" ? "dead" : logSucceeded(rec) ? "flow" : "idle") + logNode("github", "GitHub API", rec.kind === "failed" ? "fail" : logSucceeded(rec) ? "hit" : "off");
      const final = rec.served === "grok-sources" || !rec.served ? "hub" : rec.served;
      const providers = rec.resultProviders;
      const results = providers ? [...providers, ...rec.resultProvidersComplete ? [] : ["hub"]] : [final];
      if (!results.length) results.push("hub");
      const appendResults = (fallback) => results.map((provider) => logWire(fallback ? "back" : "flow") + logNode(provider, provider === "hub" ? "来源未报告" : META[provider].name, "hit", fallback ? "warn" : "")).join("");
      if (rec.kind === "released" || rec.kind === "official") {
        route += logWire(rec.kind === "released" ? "idle" : "flow") + logNode("deepseek", "DeepSeek 官方搜索", "hit");
      } else if (rec.kind === "enabled") {
        route += logWire("idle") + logNode("hub", HUB_DISPLAY_NAME, "off");
      } else if (["running", "cancelled", "unknown"].includes(rec.kind)) {
        route += logWire("idle") + logNode("hub", rec.kind === "running" ? "等待结果回执" : rec.kind === "cancelled" ? "请求已取消" : "结果未完整记录", "off");
      } else {
        route += logWire("flow") + logNode("hub", HUB_DISPLAY_NAME, "hit");
        if (rec.kind === "fallback") {
          const failed = [...new Set(rec.calls.filter((call) => call.result === "failed" && call.provider !== rec.served && !providers?.includes(call.provider) && LOG_CHANNELS.has(call.provider)).map((call) => call.provider))];
          for (const provider of failed) {
            route += logWire("dead") + logNode(
              provider === "grok-sources" ? "hub" : provider,
              provider === "grok-sources" ? "来源未报告" : META[provider].name,
              "fail"
            );
          }
          route += appendResults(true);
        } else if (rec.kind === "failed") {
          route += logWire("dead") + logNode("hub", "无可用通道", "fail");
        } else {
          route += appendResults(false);
        }
      }
      return route;
    }
    function logBandHtml(rec, queryIndex = 0) {
      const replayHint = logReplayable(rec) ? "仅回放这个查询的结果链路，不重新搜索或消耗额度；动画不代表原始请求时序。" : rec.kind === "running" ? "等待搜索完成后回放。" : logEvent(rec) ? "这是启停路由事件，没有发起搜索。" : "没有完整的结果链路可供回放。";
      return `<div class="lband"><div class="lroute-viewport" tabindex="0" role="group" aria-label="搜索或读取链路，较长时可横向滚动"><div class="lroute" role="img" aria-label="${esc(`${logStatus(rec)[1]}；结果通道：${logChannel(rec)}。`)}" title="记录中的结果与失败来源，不表示供应商之间直接调用或实际网络时序。">${logRouteHtml(rec)}</div></div>
    <button type="button" class="lr-replay" data-log-replay="${queryIndex}" aria-label="回放此条搜索的链路动画" aria-pressed="false" title="${replayHint}"${logReplayable(rec) && !rec.receiptOnly ? "" : " disabled"}>${svg("replay", "ic ic-sm")}<span>回放</span></button></div>`;
    }
    function logReason(rec) {
      const codes = {
        grok_auth_error: "Grok 认证失败",
        grok_sources_empty: "Grok 未返回引用链接",
        grok_provider_error: "Grok 接口调用失败",
        grok_timeout: "Grok 响应超时",
        grok_parse_error: "Grok 响应无法解析",
        SOURCE_ALL_FAILED: "全部搜索来源不可用",
        CONFIG_REQUIRED: "尚未配置搜索来源",
        CANCELLED: "此次搜索已取消"
      };
      return Object.hasOwn(codes, rec.reason) ? codes[rec.reason] : rec.reason ? errText(rec.reason) : "";
    }
    function logChargeAmount(charge) {
      const amount = charge.amount > 0 && charge.amount < 1e-6 ? "<0.000001" : charge.amount.toLocaleString("en-US", { maximumFractionDigits: 6 });
      return charge.unit === "USD" ? "$" + amount : amount + " credits";
    }
    function logInfoTip(text, label) {
      return `<button type="button" class="lu-info" data-log-tip="${esc(text)}" aria-label="${esc(label)}"><svg class="lu-info-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="10" cy="10" r="7.2"/><path d="M10 5.8v5.1m0 3.2v.1"/></svg></button>`;
    }
    function logCharge(call) {
      if (call.provider === "github") return `<span class="lu-unknown">API 配额${logInfoTip("GitHub 使用 API 请求配额，不扣补充搜索来源的额度。缓存续读仍需联网验证权限。", "GitHub API 配额说明")}</span>`;
      const charge = call.charge;
      if (charge.basis === "unknown" || charge.amount === null || !charge.unit) {
        return `<span class="lu-unknown">未报告${logInfoTip("未报告不代表免费；失败、超时或取消也可能产生消耗。", "未报告消耗的说明")}</span>`;
      }
      const amount = logChargeAmount(charge);
      return `<span class="lu-charge" data-basis="${charge.basis}">${esc(amount)}<small title="${charge.basis === "estimated" ? "服务返回的估算费用，不是账单或实际扣费。" : "服务在本次响应中报告的消耗，不由余额差值计算。"}">${charge.basis === "estimated" ? "估算" : "接口报告"}</small></span>`;
    }
    function logCallsHtml(rec) {
      if (logEvent(rec)) return '<p class="lu-empty">无搜索调用</p>';
      const calls = rec.calls;
      const notes = [];
      if (rec.recordType === "github") {
        const progress = logSucceeded(rec) ? `第 ${rec.segment ?? "—"} 段；${rec.acquiredComplete ? "接口获取已完成" : "接口获取未完成"}；${rec.hasMore ? "仍有未交付内容，请续读" : "当前内容已交付"}。` : rec.kind === "running" ? "正在读取，本次尚未交付内容。" : `${rec.kind === "cancelled" ? "本次读取已取消" : "本次读取未成功"}；未确认向模型交付内容。`;
        notes.push(progress + (rec.apiRequests === null ? "" : `本次 ${rec.apiRequests} 次 GitHub API 请求。`) + (rec.cacheHit && logSucceeded(rec) ? "本次命中缓存；交付前已重新联网核验权限。" : ""));
      }
      if (rec.reason) notes.push(`${logReason(rec)}（${rec.reason}）`);
      if (rec.detail) notes.push(logPrivate ? "错误详情已隐藏。" : rec.detail);
      const receipt = rec.receipt;
      if (receipt) {
        if (receipt.kind === "failed") notes.push("所属调用报告失败；本条状态仅代表此查询。");
        else if (receipt.kind === "cancelled") notes.push("所属调用已取消，本条保留已记录的结果。");
        if (receipt.kind === "unknown" || receipt.incomplete) notes.push("所属调用的记录不完整。");
        if (receipt.reason && receipt.reason !== rec.reason) notes.push(`${logReason(receipt)}（${receipt.reason}）`);
        if (receipt.detail && receipt.detail !== rec.detail) notes.push(logPrivate ? "错误详情已隐藏。" : receipt.detail);
      }
      if (rec.receiptOnly || !rec.callsComplete) notes.push("调用明细未完整报告，不推测缺失来源。");
      if (calls.some((call) => call.evidence === "source-label")) {
        notes.push("结果来源由 Grok Search Rs 返回标签确认，不代表完整调用次数或具体 Key；未报告的消耗不推算。");
      }
      const resultInfo = notes.length ? logInfoTip(notes.join("\n"), "搜索结果补充说明") : "";
      const rows = calls.map((call) => {
        const provider = call.provider === "grok-sources" ? "来源未报告" : call.provider === "deepseek" ? "DeepSeek 官方搜索" : META[call.provider].name;
        const mark = call.provider === "grok-sources" ? `<span class="lhub">${svg("hub")}</span>` : tile(call.provider, 18);
        return `<div class="lu-row" role="row">
      <div class="lu-provider" role="cell">${mark}<span>${provider}${call.keyIndex === null ? "" : `<small>Key ${call.keyIndex + 1}</small>`}</span></div>
      <span class="lu-operation" role="cell">${call.provider === "github" ? "专用读取" : call.evidence === "source-label" ? "结果来源" : USAGE_OPERATIONS[call.operation]}</span>
      <span class="lu-result" role="cell" data-result="${call.result}">${USAGE_RESULTS[call.result]}${call.code ? `<code>${esc(call.code)}</code>${logInfoTip(errText(call.code), `错误 ${call.code} 的说明`)}` : ""}</span>
      <span class="lu-cost" role="cell">${logCharge(call)}</span></div>`;
      }).join("");
      return `<section class="log-usage" aria-label="此查询的调用与消耗明细">
    <div class="lu-table" role="table" aria-label="本次服务调用">
      <div class="lu-columns" role="row"><span role="columnheader">服务</span><span role="columnheader">调用</span><span role="columnheader">结果${resultInfo}</span><span role="columnheader">消耗</span></div>
      ${rows || `<div class="lu-empty-row" role="row"><span role="cell" aria-colspan="4">${rec.kind === "running" ? "等待调用明细" : "暂无调用明细"}</span></div>`}
    </div></section>`;
    }
    function logDetailHtml(rec) {
      return `<section class="lquery" aria-label="此条搜索的详情">${logCallsHtml(rec)}</section>`;
    }
    function logMatches(rec) {
      return logFilter === "all" || rec.kind === logFilter || logFilter === "ok" && (rec.kind === "sources" || rec.kind === "official");
    }
    function syncLogControls({ snap = false } = {}) {
      const filters = $$("[data-logfilter]");
      filters.forEach((b) => {
        const selected = b.dataset.logfilter === logFilter;
        b.setAttribute("aria-checked", String(selected));
        b.tabIndex = selected ? 0 : -1;
      });
      const target = filters.find((b) => b.dataset.logfilter === logFilter);
      const indicator = $("#logFilterActive");
      if (snap) indicator.style.transition = "none";
      indicator.style.width = target.offsetWidth + "px";
      indicator.style.transform = `translateX(${target.offsetLeft - 3}px)`;
      if (snap) requestAnimationFrame2(() => indicator.style.removeProperty("transition"));
      const privacy = $("#logPrivacy");
      privacy.setAttribute("aria-pressed", String(logPrivate));
      privacy.setAttribute("aria-label", logPrivate ? "显示搜索内容" : "隐藏搜索内容");
      privacy.title = logPrivate ? "显示搜索内容" : "隐藏搜索内容";
      const icon = svg(logPrivate ? "eyeOff" : "eye");
      if (privacy.innerHTML !== icon) privacy.innerHTML = icon;
      $("#logCount").textContent = logReadError && !logRows.length ? "—" : String(logEntries().length);
      $("#logClear").disabled = !logRows.length;
    }
    function updateLogEntry(article, rec) {
      const open = logOpen.has(rec.id);
      const fingerprint = JSON.stringify([rec, logPrivate, isDark()]);
      if (stripTipTarget && article.contains(stripTipTarget) && !open) hideStripTip();
      if (logFingerprints.get(article) !== fingerprint) {
        const label = logStatus(rec)[1];
        if (logRoutePlayback?.entryId === rec.id) stopLogRouteReplay();
        const duration = logEvent(rec) ? "—" : logDuration(rec.ms);
        const query = logVisibleQuery(rec) || (rec.receiptOnly ? "查询明细未报告" : "搜索内容未报告");
        const summary = `${rec.t}，${query}，${label}，耗时 ${duration}；展开查看详情`;
        if (!article.firstElementChild) article.innerHTML = `<button type="button" class="le-head">
      <span class="le-top"><span class="le-time"></span><span class="le-query"></span>
        <span class="le-state"></span>
        <span class="le-dur" title="此条查询报告的耗时"></span>
        <span class="le-chevron">${svg("chev")}</span></span></button>
      <div class="le-band-slot"></div><div class="ldet">
        <div class="ldet-inner"><div class="ldet-body"></div></div></div>`;
        const header = $(".le-head", article), title = $(".le-query", article), time = $(".le-time", article);
        header.setAttribute("aria-controls", `${rec.id}-detail`);
        header.setAttribute("aria-describedby", `${rec.id}-summary`);
        header.setAttribute("aria-label", summary);
        if (time.textContent !== rec.t) time.textContent = rec.t;
        time.title = rec.t;
        if (title.textContent !== query) title.textContent = query;
        title.title = query;
        title.dataset.private = String(logPrivate && !logEvent(rec));
        $(".le-dur", article).textContent = duration;
        const state = $(".le-state", article), stateHtml = logStatusHtml(rec);
        if (state._logHtml !== stateHtml) {
          state.innerHTML = stateHtml;
          state._logHtml = stateHtml;
        }
        const band = $(".le-band-slot", article), bandHtml = logBandHtml(rec, rec.queryIndex);
        if (band._logHtml !== bandHtml) {
          const scrollLeft = $(".lroute-viewport", band)?.scrollLeft || 0;
          band.innerHTML = bandHtml;
          band._logHtml = bandHtml;
          $(".lroute-viewport", band).scrollLeft = scrollLeft;
        }
        $(".lband", article).id = `${rec.id}-summary`;
        const detail2 = $(".ldet", article);
        detail2.id = `${rec.id}-detail`;
        detail2._logFingerprint = null;
        if (!open && detail2._logHtml) {
          $(".ldet-body", detail2).replaceChildren();
          detail2._logHtml = null;
        }
        logFingerprints.set(article, fingerprint);
      }
      article.dataset.kind = rec.kind;
      article.dataset.id = rec.id;
      article.dataset.parentId = rec.parentId;
      article.dataset.queryIndex = String(rec.queryIndex);
      article.classList.toggle("is-open", open);
      $(".le-head", article).setAttribute("aria-expanded", String(open));
      const detail = $(".ldet", article);
      if (open && detail._logFingerprint !== fingerprint) {
        const detailHtml = logDetailHtml(rec);
        if (detail._logHtml !== detailHtml) {
          if (stripTipTarget && detail.contains(stripTipTarget)) hideStripTip();
          const scrollLeft = $(".lu-table", detail)?.scrollLeft || 0;
          $(".ldet-body", detail).innerHTML = detailHtml;
          const table = $(".lu-table", detail);
          if (table) table.scrollLeft = scrollLeft;
          detail._logHtml = detailHtml;
        }
        detail._logFingerprint = fingerprint;
      }
      detail.setAttribute("aria-hidden", String(!open));
      detail.inert = !open;
    }
    function renderLog(opt = {}) {
      const list = $("#logList");
      if (!list) return;
      const focusElement = active();
      const focused = focusElement?.closest(".log-entry")?.dataset.id;
      const replayFocused = active()?.getAttribute("data-log-replay");
      const top = list.scrollTop;
      const anchor = top > 24 ? Array.from(list.children).find((node) => node.dataset.id && node.getBoundingClientRect().bottom > list.getBoundingClientRect().top) : null;
      const anchorOffset = anchor ? anchor.getBoundingClientRect().top - list.getBoundingClientRect().top : null;
      const entries = logEntries();
      const rows = entries.filter(logMatches);
      const allIds = new Set(entries.map((r) => r.id));
      for (const [id, node] of logNodes) if (!allIds.has(id)) {
        node.remove();
        logNodes.delete(id);
        logOpen.delete(id);
      }
      const visibleIds = new Set(rows.map((r) => r.id));
      if (logRoutePlayback && !visibleIds.has(logRoutePlayback.entryId)) stopLogRouteReplay();
      if (logReplayReturn && !visibleIds.has(logReplayReturn.entryId)) clearHistoryReturn();
      for (const node of Array.from(list.children)) {
        if (!visibleIds.has(node.dataset.id)) node.remove();
      }
      if (!rows.length) {
        const blank = logReadError ? ["搜索记录暂不可读", "读取失败不代表未调用插件；恢复连接后自动刷新"] : logRows.length ? ["没有符合条件的记录", "切换筛选查看其他记录"] : ["还没有搜索记录", S.plugin ? "下一次搜索完成后，可在这里查看通道" : "官方路由已恢复，当前没有搜索记录"];
        const empty = document.createElement("div");
        empty.className = "lc-empty";
        empty.innerHTML = `<p>${blank[0]}</p><small>${blank[1]}</small>`;
        list.appendChild(empty);
      } else {
        rows.forEach((rec, index) => {
          let node = logNodes.get(rec.id);
          if (!node) {
            node = document.createElement("article");
            node.className = "log-entry";
            node.setAttribute("role", "listitem");
            logNodes.set(rec.id, node);
          }
          updateLogEntry(node, rec);
          if (list.children[index] !== node) list.insertBefore(node, list.children[index] || null);
          if (opt.fresh === rec.parentId || opt.final === rec.parentId) {
            node.classList.remove("is-new", "is-final");
            node.classList.add(opt.final ? "is-final" : "is-new");
          }
        });
      }
      if (focused && logNodes.get(focused)?.isConnected && !focusElement?.isConnected) {
        const node = logNodes.get(focused);
        const replay = replayFocused !== null ? $(`[data-log-replay="${replayFocused}"]`, node) : null;
        const target = replay && !replay.disabled ? replay : $(".le-head", node);
        if (target !== active()) target.focus({ preventScroll: true });
      }
      if (anchor?.isConnected && anchorOffset !== null) {
        list.scrollTop += anchor.getBoundingClientRect().top - list.getBoundingClientRect().top - anchorOffset;
      } else list.scrollTop = opt.fresh && top < 24 ? 0 : top;
      if (focused && !logNodes.get(focused)?.isConnected && active() === document.body) {
        const target = list.querySelector(".le-head") || $("[data-logfilter=all]");
        target.focus({ preventScroll: true });
      }
      syncLogControls({ snap: opt.snap === true });
      if (stripTipTarget?.matches("[data-log-tip]")) {
        if (!stripTipTarget.isConnected || stripTipTarget.closest("[inert]")) hideStripTip();
        else showStripTip(stripTipTarget);
      }
    }
    function clearLocalLog({ announce = true } = {}) {
      stopLogRouteReplay();
      clearHistoryReturn();
      logEpoch++;
      logRows = [];
      readSignature = null;
      logOpen.clear();
      logNodes.clear();
      renderLog();
      if (announce) $("#logAnnouncer").textContent = "已清空本次会话的搜索记录。";
    }
    function selectLogFilter(value, focus = false) {
      if (!["all", "ok", "fallback", "failed"].includes(value)) return;
      logFilter = value;
      renderLog();
      if (focus) $(`[data-logfilter="${value}"]`).focus();
    }
    function syncLogRouteReplay(play, active2) {
      const buttons = $$(`[data-log-replay="${play.queryIndex}"]`, play.article || play.node);
      buttons.forEach((button) => {
        button.setAttribute("aria-pressed", String(active2));
        button.setAttribute("aria-label", active2 ? "停止此条搜索的链路回放" : "回放此条搜索的链路动画");
        button.innerHTML = `${svg(active2 ? "stop" : "replay", "ic ic-sm")}<span>${active2 ? "停止" : "回放"}</span>`;
      });
    }
    function cleanupLogUi(actions) {
      const errors = [];
      for (const action of actions) {
        try {
          action();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length) throw new AggregateError(errors, "Search log UI cleanup failed");
    }
    function clearHistoryReturn() {
      logReplayReturn = null;
      let focused = false;
      cleanupLogUi([
        () => {
          focused = $("#historyBar").contains(active());
        },
        () => {
          $("#historyBar").hidden = true;
        },
        () => {
          $("#historyQuery").textContent = "";
        },
        () => {
          $("#historyContext").hidden = true;
        },
        () => {
          $("#historyPhase").textContent = "";
        },
        () => $("#historyRoute").replaceChildren(),
        () => $("#historyRoute").classList.remove("is-replaying"),
        () => {
          if (focused) $("#routeTitle").focus({ preventScroll: true });
        }
      ]);
    }
    function stopLogRouteReplay({ retain = false, completed = false } = {}) {
      const play = logRoutePlayback;
      if (!play) {
        if (!retain) clearHistoryReturn();
        return false;
      }
      logRoutePlayback = null;
      play.cancelled = true;
      let focusInHistory = false;
      cleanupLogUi([
        // Restore every live control even if an unrelated animation or DOM cleanup fails.
        ...play.locks.map(([element, inert]) => () => {
          element.inert = inert;
        }),
        () => {
          delete card.dataset.history;
        },
        () => {
          $("#historyStage").hidden = true;
        },
        () => {
          $("#historyNote").hidden = true;
        },
        () => {
          $("#historyContext").hidden = true;
        },
        () => play.cancelScroll?.(),
        ...Array.from(play.cancelers, (cancel) => () => cancel()),
        () => cancelAnimationFrame2(play.pumpRaf),
        () => {
          if (!play.stage) return;
          cleanupLogUi($$(".hr-node", play.stage).flatMap((element) => [
            () => jolts.get(element)?.(),
            () => clearTimeout2(faultPulses.get(element)),
            () => faultPulses.delete(element)
          ]));
        },
        ...Array.from(play.animations, (animation) => () => animation.cancel()),
        () => play.resize?.disconnect(),
        () => play.offResize?.(),
        () => play.node.classList.remove("is-replaying"),
        () => play.article?.classList.remove("is-replaying"),
        () => cleanupLogUi($$(".is-replay-seen", play.node).map((node) => () => node.classList.remove("is-replay-seen"))),
        () => syncLogRouteReplay(play, false),
        () => {
          focusInHistory = $("#historyBar").contains(active());
        },
        () => $("#historyStage").replaceChildren(),
        () => $("#historyRoute").replaceChildren(),
        () => $("#historyRoute").classList.remove("is-replaying"),
        () => {
          if (retain && play.article?.isConnected) {
            $("#historyBar").dataset.phase = "done";
            $("#historyLabel").textContent = "已恢复当前配置";
            $("#historyLabel").title = `${completed ? "回放结束" : "回放已停止"} · ${play.rec.t}`;
            $("#historyPhase").textContent = "";
            $("#historyStop").hidden = true;
            $("#historyDismiss").hidden = false;
            if (focusInHistory) $("#historyReturn").focus({ preventScroll: true });
          } else clearHistoryReturn();
        },
        // The live canvas never changed state; redraw coordinates after unhiding it.
        () => pumpWires(120)
      ]);
      return true;
    }
    function historyNode(id, name, meta = "") {
      const glyph = id === "hub" ? `<span class="hub-glyph">${svg("hub")}</span>` : `<img class="node-logo" src="${logoSrc(id)}" alt="">`;
      return `<div class="node ${id === "dsh" ? "node-dsh" : id === "hub" ? "node-hub" : "history-official"} hr-node" data-history-node="${id}" data-hs="idle">
    ${id !== "dsh" ? '<span class="port hr-port"></span>' : ""}${id !== "deepseek" ? '<span class="port hr-port out"></span>' : ""}
    ${glyph}<span class="node-name">${esc(name)}</span><span class="node-meta">${esc(meta)}</span>
    ${id === "hub" ? '<span class="hub-pill hr-hub-mode">历史路径</span>' : ""}</div>`;
    }
    function mountHistoryRoute(play) {
      const rec = play.rec;
      const stage = $("#historyStage");
      const unknown = rec.kind === "failed" || rec.kind !== "official" && (rec.resultProviders ? !rec.resultProviders.length || !rec.resultProvidersComplete : !rec.served || rec.served === "grok-sources");
      const provider = (id) => `<div class="row hr-provider hr-node" data-history-node="${id}" data-hs="idle" data-st="off">
    ${id === "unknown" ? `<span class="tile tile-glyph" style="--s:28px">${svg("hub")}</span>` : tile(id, 28)}
    <span class="hr-provider-name">${id === "unknown" ? rec.kind === "failed" ? "无可用通道" : "来源未报告" : META[id].name}</span>
    <span class="hr-result"></span><span class="row-fault hr-fault" hidden></span><span class="port hr-port"></span></div>`;
      stage.innerHTML = `<svg class="wires hr-wires" aria-hidden="true"></svg>
    ${historyNode("dsh", "DeepSeek Harness", rec.recordType === "github" ? "github_read / web_fetch" : "web_search")}${rec.kind === "official" ? historyNode("deepseek", "DeepSeek 官方搜索", "记录报告的通道") : ""}
    ${historyNode("hub", HUB_DISPLAY_NAME, rec.kind === "official" ? "未经过此通道" : "记录链路")}
    ${["grok", ...SUPP, "github", ...unknown ? ["unknown"] : []].map(provider).join("")}
    ${["primary", "supp", "extract"].map((group, index) => `<span class="hr-label" data-history-group="${group}">${["主搜索", "补充来源", "专用抽取"][index]}</span>`).join("")}`;
      play.stage = stage;
      play.svg = $(".hr-wires", stage);
      play.paths = /* @__PURE__ */ new Map();
      const edges = rec.kind === "official" ? [["dsh-deepseek", "dsh", "deepseek"]] : [["dsh-hub", "dsh", "hub"], ...["grok", ...SUPP, "github", ...unknown ? ["unknown"] : []].map((id) => ["hub-" + id, "hub", id])];
      for (const [id, from, to] of edges) {
        const group = document.createElementNS(SVGNS, "g");
        group.setAttribute("class", "wg");
        group.dataset.ws = "rest";
        group.innerHTML = '<path class="wt"/><path class="w"/><circle class="w-end" r="1.4"/><circle class="w-end" r="1.4"/>';
        const path = group.children[1];
        path.dataset.historyWire = id;
        path.dataset.hs = "idle";
        play.svg.appendChild(group);
        play.paths.set(id, { path, group, from, to });
      }
      play.packetLayer = document.createElementNS(SVGNS, "g");
      play.packetLayer.setAttribute("class", "packets");
      play.svg.appendChild(play.packetLayer);
      if (rec.kind === "official") {
        $("[data-history-node=dsh] .hr-port", stage).className = "port hr-port bottom";
        $("[data-history-node=deepseek] .hr-port", stage).className = "port hr-port top";
        $("[data-history-node=hub] .hr-port.out", stage).hidden = true;
      } else if (unknown) {
        $("[data-history-node=unknown] .hr-port", stage).className = "port hr-port top";
        $("[data-history-node=hub]", stage).insertAdjacentHTML("beforeend", '<span class="port hr-port bottom"></span>');
      }
      const draw = () => {
        if (logRoutePlayback !== play || play.cancelled || stage.hidden) return;
        const liveStage = $("#stage"), root = liveStage.getBoundingClientRect();
        const parent = card.getBoundingClientRect();
        const computed = getComputedStyle(liveStage);
        const sx = root.width / parseFloat(computed.width), sy = root.height / parseFloat(computed.height);
        stage.style.left = (root.left - parent.left) / sx - card.clientLeft + "px";
        stage.style.top = (root.top - parent.top) / sy - card.clientTop + "px";
        stage.style.width = root.width / sx + "px";
        stage.style.height = root.height / sy + "px";
        const place = (target, bounds) => {
          Object.assign(target.style, {
            left: (bounds.left - root.left) / sx + "px",
            top: (bounds.top - root.top) / sy - stage.clientTop + "px",
            width: bounds.width / sx + "px",
            height: bounds.height / sy + "px"
          });
        };
        for (const element of $$(".hr-node", stage)) {
          const id = element.dataset.historyNode;
          const source = id === "dsh" ? $("#nodeDsh") : id === "hub" ? $("#nodeHub") : id === "deepseek" ? $("#nodeOfficial") : id === "unknown" ? null : rowOf(id);
          if (source) place(element, source.getBoundingClientRect());
          else {
            const hub = $("#nodeHub").getBoundingClientRect();
            place(element, { left: hub.left - 15 * sx, top: hub.bottom + 26 * sy, width: hub.width + 30 * sx, height: 44 * sy });
          }
        }
        for (const label of $$(".hr-label", stage)) {
          place(label, $(`[data-group="${label.dataset.historyGroup}"] .rg-label`).getBoundingClientRect());
        }
        const banner = $("#bannerSlot").getBoundingClientRect(), context = $("#historyContext");
        const compact = banner.height < 36 * sy;
        context.dataset.compact = String(compact);
        Object.assign(context.style, {
          left: "20px",
          right: "20px",
          top: (compact ? root.top - parent.top + 4 * sy : banner.top - parent.top) / sy - card.clientTop + "px",
          height: (compact ? 22 : banner.height / sy) + "px"
        });
        const overlayRoot = stage.getBoundingClientRect();
        for (const { path, group, from, to } of play.paths.values()) {
          const a = $(`[data-history-node="${from}"]`, stage).getBoundingClientRect();
          const b = $(`[data-history-node="${to}"]`, stage).getBoundingClientRect();
          const vertical = to === "deepseek" || to === "unknown";
          const x1 = ((vertical ? a.left + a.width / 2 : a.right) - overlayRoot.left) / sx;
          const y1 = ((vertical ? a.bottom : a.top + a.height / 2) - overlayRoot.top) / sy - stage.clientTop;
          const x2 = ((vertical ? b.left + b.width / 2 : b.left) - overlayRoot.left) / sx;
          const y2 = ((vertical ? b.top : b.top + b.height / 2) - overlayRoot.top) / sy - stage.clientTop;
          const mid = (x1 + x2) / 2;
          path.setAttribute("d", vertical ? `M${x1},${y1} L${x2},${y2}` : `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`);
          group.children[0].setAttribute("d", path.getAttribute("d"));
          syncBreak(group, group.dataset.ws, from === "dsh" ? "start" : "end");
        }
      };
      play.layout = draw;
      play.pump = (ms = 520) => {
        play.pumpUntil = Math.max(play.pumpUntil || 0, performance.now() + ms);
        if (play.pumpRaf) return;
        const tick = () => {
          if (play.cancelled || logRoutePlayback !== play) {
            play.pumpRaf = 0;
            return;
          }
          draw();
          play.pumpRaf = performance.now() < play.pumpUntil ? requestAnimationFrame2(tick) : 0;
        };
        play.pumpRaf = requestAnimationFrame2(tick);
      };
      stage.hidden = false;
      draw();
      play.resize = new ResizeObserver(draw);
      play.resize.observe($("#stage"));
      play.resize.observe(card);
      play.offResize = listen(window, "resize", draw);
    }
    function scrollToHistory(play) {
      const scrollers = [];
      for (let element = card.parentElement; element; element = element.parentElement || element.getRootNode()?.host) {
        if (element.scrollHeight > element.clientHeight && /auto|scroll/.test(getComputedStyle(element).overflowY)) scrollers.push(element);
      }
      if (!scrollers.length) scrollers.push(document.scrollingElement);
      const positions = scrollers.filter(Boolean).map((element) => {
        const viewport = element === document.scrollingElement ? { top: 0 } : element.getBoundingClientRect();
        return { element, start: element.scrollTop, target: Math.max(0, Math.min(
          element.scrollHeight - element.clientHeight,
          element.scrollTop + card.getBoundingClientRect().top - viewport.top - 16
        )) };
      });
      if (reduced()) {
        positions.forEach(({ element, target }) => {
          element.scrollTop = target;
        });
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        const start = performance.now();
        let frame, offWheel, offTouch;
        const done = () => {
          cancelAnimationFrame2(frame);
          offWheel?.();
          offTouch?.();
          play.cancelScroll = null;
          resolve();
        };
        offWheel = listen(window, "wheel", done, { once: true, passive: true });
        offTouch = listen(window, "touchstart", done, { once: true, passive: true });
        play.cancelScroll = done;
        const tick = (time) => {
          if (play.cancelled) return done();
          const progress = Math.min(1, (time - start) / 420);
          positions.forEach(({ element, start: start2, target }) => {
            element.scrollTop = start2 + (target - start2) * (1 - (1 - progress) ** 3);
          });
          if (progress === 1) done();
          else frame = requestAnimationFrame2(tick);
        };
        frame = requestAnimationFrame2(tick);
      });
    }
    async function replayLogRoute(id, queryIndex = 0) {
      if (!Number.isSafeInteger(queryIndex) || queryIndex < 0 || queryIndex >= 16) return false;
      const rec = logEntries().find((record) => record.parentId === id && record.queryIndex === queryIndex);
      const article = rec && logNodes.get(rec.id);
      if (!rec || rec.receiptOnly || !article?.isConnected || !logReplayable(rec)) return false;
      if (logRoutePlayback?.entryId === rec.id) {
        stopLogRouteReplay({ retain: true });
        $("#logAnnouncer").textContent = "已停止链路回放，没有重新搜索。";
        return true;
      }
      if (S.testing || S.loading || logRows.some((record) => record.kind === "running")) {
        $("#logAnnouncer").textContent = "正在处理搜索或加载，完成后可回放历史链路。";
        toast("搜索或加载进行中，请完成后再回放", { tone: "info" });
        return false;
      }
      const node = article;
      const play = {
        id,
        entryId: rec.id,
        queryIndex,
        article,
        node,
        rec,
        epoch: logEpoch,
        animations: /* @__PURE__ */ new Set(),
        cancelers: /* @__PURE__ */ new Set(),
        cancelled: false,
        static: reduced(),
        locks: []
      };
      let completed = false;
      try {
        stopLogRouteReplay();
        play.locks = [$("#stage"), $(".rc-actions", card), $("#bannerSlot"), $(".rc-foot", card)].map((element) => [element, element.inert]);
        logRoutePlayback = play;
        logReplayReturn = { id, entryId: rec.id, queryIndex, epoch: logEpoch };
        if (!play.static) {
          node.classList.add("is-replaying");
          article.classList.add("is-replaying");
        }
        syncLogRouteReplay(play, true);
        closePop();
        hideStripTip();
        play.locks.forEach(([element]) => {
          element.inert = true;
        });
        card.dataset.history = "true";
        $("#historyBar").hidden = false;
        $("#historyBar").dataset.phase = "playing";
        $("#historyLabel").textContent = `${play.static ? "历史记录" : "历史回放"} · ${rec.t}`;
        $("#historyLabel").removeAttribute("title");
        $("#historyQuery").textContent = logVisibleQuery(rec);
        $("#historyContext").hidden = false;
        $("#historyPhase").textContent = play.static ? "历史终态" : "准备回放";
        $("#historyStop").hidden = false;
        $("#historyStop").innerHTML = `${svg(play.static ? "replay" : "stop")}<span>${play.static ? "返回当前配置" : "停止"}</span>`;
        $("#historyReturn").innerHTML = `${svg("returnLog")}<span>返回该条日志</span>`;
        $("#historyDismiss").innerHTML = svg("x");
        $("#historyDismiss").hidden = true;
        $("#historyNote").hidden = false;
        mountHistoryRoute(play);
        $("#historyStop").focus({ preventScroll: true });
        $("#logAnnouncer").textContent = "正在回放记录链路，不会重新搜索或消耗额度。";
        const alive = () => logRoutePlayback === play && !play.cancelled && logEpoch === play.epoch && node.isConnected;
        const animate = async (element, keyframes, duration, options = {}) => {
          if (!alive() || play.static) return;
          const index = elements.indexOf(element);
          const targets = index < 0 ? [element] : [element, historyElements[index]];
          await Promise.all(targets.map(async (target) => {
            const animation = target.animate(keyframes, {
              duration,
              easing: "cubic-bezier(.2,.7,.2,1)",
              fill: "forwards",
              ...options
            });
            play.animations.add(animation);
            await animation.finished.catch(() => {
            });
            if (options.fill === "none") {
              animation.cancel();
              play.animations.delete(animation);
            }
          }));
        };
        const elements = Array.from($(".lroute", node).children);
        const historyRoute = $("#historyRoute");
        historyRoute.innerHTML = logRouteHtml(rec);
        historyRoute.classList.toggle("is-replaying", !play.static);
        historyRoute.setAttribute("aria-label", `历史结果链路：${Array.from(historyRoute.querySelectorAll(".ln-name"), (el) => el.textContent).join(" → ")}；${logStatus(rec)[1]}。不重新搜索，不代表原始请求时序。`);
        const historyElements = Array.from(historyRoute.children);
        const mainNode = (element) => $(`[data-history-node="${element.dataset.node === "hub" ? element === elements[2] ? "hub" : "unknown" : element.dataset.node}"]`, play.stage);
        const hub = $("[data-history-node=hub]", play.stage);
        const delay = (ms) => new Promise((resolve) => {
          if (!alive() || play.static) {
            resolve();
            return;
          }
          let timer;
          const clean = () => {
            clearTimeout2(timer);
            play.cancelers.delete(clean);
            resolve();
          };
          timer = setTimeout2(clean, ms);
          play.cancelers.add(clean);
        });
        const markNode = (element) => {
          const target = mainNode(element);
          if (!target) return null;
          target.dataset.hs = element.dataset.s === "fail" ? "fail" : element.dataset.tone === "warn" ? "back" : "hit";
          if (target.classList.contains("row")) target.dataset.st = element.dataset.s === "fail" ? "bad" : "live";
          $$(".hr-port", target).forEach((port) => {
            port.dataset.ps = element.dataset.s === "fail" ? "broken" : "live";
            if (target.classList.contains("row") && element.dataset.s !== "fail") port.dataset.mark = "ok";
          });
          const result = $(".hr-result", target);
          if (result) result.textContent = element.dataset.s === "fail" ? target.dataset.historyNode === "unknown" ? "搜索失败" : "来源不可用" : rec.kind === "failed" ? "搜索未完成" : "返回结果";
          const badge = $(".hr-fault", target);
          if (badge && element.dataset.s === "fail") {
            const code = rec.calls.find((call) => call.provider === target.dataset.historyNode && call.result === "failed")?.code;
            badge.textContent = code ? `${code} · ${errText(code)}` : logReason(rec) || "来源不可用";
            badge.hidden = false;
            target.classList.add("has-fault");
          }
          return target;
        };
        const wireFor = (index) => {
          const next = elements[index + 1]?.dataset.node;
          return play.paths.get(next === "deepseek" ? "dsh-deepseek" : index === 1 ? "dsh-hub" : "hub-" + (next === "hub" ? "unknown" : next));
        };
        const setWire = (edge, state) => {
          if (!edge) return;
          edge.path.dataset.hs = state;
          edge.group.dataset.ws = state === "fail" ? "broken" : "live";
          if (state === "fail") {
            edge.group.classList.remove("lit");
            edge.group._bt = performance.now();
            delete edge.group._bf;
          }
          play.pump(480);
        };
        await scrollToHistory(play);
        if (!alive()) return true;
        if (play.static) {
          elements.forEach((element, index) => {
            if (element.classList.contains("lwire")) {
              setWire(wireFor(index), element.dataset.s === "dead" ? "fail" : element.dataset.s === "back" ? "back" : "hit");
            } else markNode(element);
          });
          play.layout();
          $("#historyPhase").textContent = logChannel(rec);
          $("#logAnnouncer").textContent = "已在搜索路由图展示历史终态，没有重新搜索。可返回当前配置或该条日志。";
          completed = true;
          return true;
        }
        for (const [index, element] of elements.entries()) {
          if (!alive()) return true;
          element.classList.add("is-replay-seen");
          historyElements[index].classList.add("is-replay-seen");
          if (element.classList.contains("lwire")) {
            const edge = wireFor(index);
            const tone = element.dataset.s === "back" ? "back" : "hit";
            setWire(edge, "active");
            const nextTarget = mainNode(elements[index + 1]);
            if (nextTarget?.classList.contains("row")) {
              nextTarget.dataset.st = "on";
            }
            if (tone === "back") {
              hub.classList.add("is-falling");
              $(".hr-hub-mode", hub).textContent = "回退中";
              await delay(260);
              if (!alive()) return true;
            }
            if (edge) edge.group.dataset.requesting = "true";
            $("#historyPhase").textContent = index === 1 ? rec.kind === "official" ? "官方结果路径" : "进入 Grok Search Rs" : tone === "back" ? "转向补充来源" : "请求路径";
            await Promise.all([animate(element, [
              { clipPath: "inset(0 100% 0 0)", opacity: 0.35 },
              { clipPath: "inset(0)", opacity: 1 }
            ], T.hop), edge && travel(edge.path.dataset.historyWire, { view: play })]);
            if (!alive()) return true;
            if (edge) edge.group.dataset.requesting = "false";
          } else {
            const target = mainNode(element);
            const failed = element.dataset.s === "fail";
            if (target?.classList.contains("row")) {
              target.classList.add("is-searching");
              await delay(failed ? T.fail : target.dataset.historyNode === "grok" ? T.grok : T.supp);
              if (!alive()) return true;
              target.classList.remove("is-searching");
            }
            markNode(element);
            if (failed) {
              $("#historyPhase").textContent = rec.kind === "failed" ? "没有可用结果" : `${element.querySelector(".ln-name").textContent} 不可用`;
              pulseFault(target);
              await jolt(target, false, play.pump);
              if (!alive()) return true;
              setWire(wireFor(index - 1), "fail");
              await delay(260);
            } else {
              if (target === hub) hub.classList.add("is-busy");
              if (target?.classList.contains("row")) flashRow(target);
              if (index > 0) setWire(wireFor(index - 1), element.dataset.tone === "warn" ? "back" : "hit");
              await animate(element, [{ opacity: 0.6 }, { opacity: 1 }], 180);
            }
          }
        }
        if (alive()) {
          if (rec.kind !== "failed") {
            $("#historyPhase").textContent = "结果返回";
            const lastEdge = wireFor(elements.length - 2);
            if (lastEdge) await travel(lastEdge.path.dataset.historyWire, { view: play, back: true });
            if (alive() && rec.kind !== "official") {
              hub.classList.remove("is-busy", "is-falling");
              $(".hr-hub-mode", hub).textContent = "历史路径";
              await travel("dsh-hub", { view: play, back: true });
            }
            if (alive()) flashNode($("[data-history-node=dsh]", play.stage));
          } else {
            hub.classList.remove("is-busy", "is-falling");
            await jolt($("[data-history-node=dsh]", play.stage), false, play.pump);
            if (alive()) setWire(play.paths.get("dsh-hub"), "fail");
          }
          if (!alive()) return true;
          $("#historyPhase").textContent = logChannel(rec);
          await animate($(".le-chip", node), [{ opacity: 0.7 }, { opacity: 1 }, { opacity: 1 }], T.hold);
          if (alive()) $("#logAnnouncer").textContent = "链路回放结束，已恢复当前配置。原记录与额度未改变。";
        }
        completed = alive();
        return true;
      } catch {
        $("#logAnnouncer").textContent = "回放未能完成，已恢复当前配置；原记录未改变。";
        return false;
      } finally {
        if (logRoutePlayback === play && (!play.static || !completed)) {
          stopLogRouteReplay({ retain: completed, completed });
        }
      }
    }
    listen($("#historyStop"), "click", () => stopLogRouteReplay({ retain: true }));
    listen($("#historyDismiss"), "click", clearHistoryReturn);
    listen($("#historyReturn"), "click", () => {
      const target = logReplayReturn && logReplayReturn.epoch === logEpoch ? logNodes.get(logReplayReturn.entryId) : null;
      const queryIndex = logReplayReturn?.queryIndex || 0;
      stopLogRouteReplay({ retain: true });
      if (!target?.isConnected) {
        clearHistoryReturn();
        return;
      }
      target.style.scrollMarginTop = "16px";
      target.scrollIntoView({ behavior: reduced() ? "instant" : "smooth", block: "center" });
      ($(`[data-log-replay="${queryIndex}"]`, target) || $(".le-head", target)).focus({ preventScroll: true });
    });
    listen($("#logList"), "pointerover", (event) => {
      const tip = event.target.closest("[data-log-tip]");
      if (tip && tip !== stripTipTarget) showStripTip(tip);
    });
    listen($("#logList"), "pointerout", (event) => {
      if (!event.target.closest("[data-log-tip]")) return;
      if (event.relatedTarget && (stripTipTarget?.contains(event.relatedTarget) || routeTooltip.contains(event.relatedTarget))) return;
      clearTimeout2(stripTipTimer);
      stripTipTimer = setTimeout2(() => {
        if (stripTipTarget !== active()) hideStripTip();
      }, 100);
    });
    listen($("#logList"), "focusin", (event) => {
      if (event.target.matches("[data-log-tip]")) showStripTip(event.target);
    });
    listen($("#logList"), "focusout", (event) => {
      if (event.target.matches("[data-log-tip]") && !routeTooltip.contains(event.relatedTarget)) hideStripTip();
    });
    listen($("#logList"), "click", (event) => {
      const tip = event.target.closest("[data-log-tip]");
      if (tip) {
        showStripTip(tip);
        return;
      }
      const replay = event.target.closest("[data-log-replay]");
      if (replay) {
        if (!replay.disabled) void replayLogRoute(replay.closest(".log-entry").dataset.parentId, Number(replay.dataset.logReplay));
        return;
      }
      const button = event.target.closest(".le-head");
      if (!button) return;
      const node = button.closest(".log-entry");
      const id = node.dataset.id;
      if (logOpen.has(id)) {
        if (logRoutePlayback?.entryId === id) stopLogRouteReplay();
        logOpen.delete(id);
      } else logOpen.add(id);
      updateLogEntry(node, logEntries().find((r) => r.id === id));
    });
    listen($("#logList"), "animationend", (event) => {
      if (event.target.classList.contains("log-entry")) event.target.classList.remove("is-new", "is-final");
    });
    $$("[data-logfilter]").forEach((b) => listen(b, "click", () => selectLogFilter(b.dataset.logfilter)));
    listen($(".lc-filters"), "keydown", (event) => {
      const buttons = $$("[data-logfilter]");
      const current = buttons.indexOf(event.target);
      if (current < 0 || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (current + (event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length;
      selectLogFilter(buttons[next].dataset.logfilter, true);
    });
    listen($("#logPrivacy"), "click", () => {
      stopLogRouteReplay();
      logPrivate = !logPrivate;
      if (logMemory) logMemory.private = logPrivate;
      renderLog();
      $("#logAnnouncer").textContent = logPrivate ? "搜索内容已隐藏，结果通道仍可查看。" : "搜索内容已显示。";
    });
    listen($("#logClear"), "click", () => {
      void clearRemoteLog();
    });
    function logReadNotice(code) {
      const reason = code === "SETTINGS_SECURE_CONNECTION_REQUIRED" ? "请通过本机直连或 HTTPS 查看" : code === "SETTINGS_AUTH_REQUIRED" ? "宿主身份验证失效，请重新连接" : code === "SEARCH_LOG_SESSION_INVALID" ? "日志会话失效，请重新打开插件页" : "读取失败，正在重试；这不代表没有搜索记录";
      return `日志暂不可读 · ${code} · ${reason}`;
    }
    function restrict(code = null) {
      if (disposed) return;
      if (!logRestricted) {
        generation++;
        logRestricted = true;
        logBaselined = false;
        logReadError = code;
        hideStripTip();
        clearLocalLog({ announce: false });
        $("#logAnnouncer").textContent = "";
      }
      if (code && logReadError !== code) {
        logReadError = code;
        renderLog();
      }
      $("#logNote").textContent = logReadError ? logReadNotice(logReadError) : "请通过本机直连或 HTTPS 查看搜索日志";
    }
    async function read() {
      if (disposed) return;
      if (!S.capabilities) return;
      if (!S.capabilities?.secretsAllowed) {
        restrict();
        return;
      }
      if (clearing) return;
      logRestricted = false;
      if (readTask) return;
      const mine = generation;
      readTask = (async () => {
        try {
          const id = sessionId || await logSession();
          if (disposed || mine !== generation || !S.capabilities?.secretsAllowed) return;
          const result = await remote.readSearchLog({ sessionId: id });
          if (disposed || mine !== generation || !S.capabilities?.secretsAllowed) return;
          const wasUnreadable = logReadError !== null;
          logReadError = null;
          const records = (result.records || []).slice(0, LOG_CAP);
          const signature = JSON.stringify([records, S.plugin]);
          $("#logNote").textContent = "仅内存 · 最近 20 条 · 停用或退出 DSH 后清空";
          if (readSignature === signature) {
            if (wasUnreadable) renderLog();
            return;
          }
          const before = new Map(logRows.map((row) => [row.id, row.kind]));
          logRows = records.map((input) => {
            const row = normalizeLog({ ...input, t: new Date(input.at).toLocaleTimeString("zh-CN", { hour12: false }) });
            return { ...row, id: /^search-log-[0-9]+$/.test(input.id) ? input.id : row.id };
          });
          if (logRows.some((row) => row.kind === "running")) stopLogRouteReplay();
          const fresh = logBaselined ? logRows.find((row) => !before.has(row.id)) : void 0;
          const final = logBaselined ? logRows.find((row) => before.get(row.id) === "running" && row.kind !== "running") : void 0;
          renderLog({ fresh: fresh?.id, final: final?.id });
          readSignature = signature;
          logBaselined = true;
          if (fresh || final) {
            const row = final || fresh;
            $("#logAnnouncer").textContent = `${logVisibleQuery(row)}，${logStatus(row)[1]}。`;
          }
        } catch (error) {
          if (disposed || mine !== generation || !S.capabilities?.secretsAllowed) return;
          const code = /^[\w./-]{1,80}$/.test(error?.code || "") ? error.code : "SETTINGS_UNAVAILABLE";
          if (code === "SEARCH_LOG_VIEW_EXPIRED" && typeof remote.openSearchLog === "function") sessionId = null;
          if (code === "SETTINGS_AUTH_REQUIRED" || code === "SETTINGS_SECURE_CONNECTION_REQUIRED") {
            restrict(code);
            onPrivateAccessDenied?.(error);
          }
          $("#logNote").textContent = logReadNotice(code);
          if (logReadError !== code) {
            logReadError = code;
            renderLog();
          }
        }
      })().finally(() => {
        readTask = null;
      });
      return readTask;
    }
    async function clearRemoteLog() {
      if (clearing || disposed) return;
      clearing = true;
      generation++;
      try {
        clearLocalLog();
        const id = sessionId || await logSession();
        if (disposed) return;
        await remote.clearSearchLog({ sessionId: id });
        if (!disposed) toast("已清空当前插件的搜索记录", { tone: "info" });
      } catch (error) {
        if (error?.code === "SEARCH_LOG_VIEW_EXPIRED" && typeof remote.openSearchLog === "function") sessionId = null;
        if (!disposed) toast("清空未确认，请稍后重试", { tone: "info" });
      } finally {
        generation++;
        clearing = false;
      }
    }
    renderLog({ snap: true });
    const poll = async () => {
      if (disposed) return;
      if (document.visibilityState !== "hidden") await read();
      if (!disposed) pollTimer = setTimeout2(poll, 2500);
    };
    pollTimer = setTimeout2(poll, 2500);
    return Object.freeze({
      read,
      restrict,
      hideTip: hideStripTip,
      stop: () => {
        hideStripTip();
        return stopLogRouteReplay();
      },
      cancel: () => {
        hideStripTip();
        stopLogRouteReplay();
        clearHistoryReturn();
      },
      theme: () => {
        hideStripTip();
        stopLogRouteReplay();
        renderLog();
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        generation++;
        clearTimeout2(pollTimer);
        hideStripTip();
        stopLogRouteReplay();
        clearHistoryReturn();
        logRows = [];
        readSignature = null;
        logNodes.clear();
        logOpen.clear();
        if (sessionId) void remote.closeSearchLog({ sessionId }).catch(() => {
        });
      }
    });
  }

  // src/ui/quota-view.mjs
  function createQuotaView(host) {
    const {
      $,
      S,
      getDialog,
      dlg,
      active,
      DEF,
      SUPP,
      svg,
      EXT,
      esc,
      reduced,
      dialogBusy,
      remote,
      uuid,
      hideTip,
      hidden = (value) => typeof value === "string" && value.startsWith("⁣dsg-configured-secret:")
    } = host;
    let D = null, disposed = false;
    const QUOTA_PROVIDERS = new Set(SUPP);
    const QUOTA_CONSOLE = {
      tavily: "https://app.tavily.com",
      exa: "https://dashboard.exa.ai",
      firecrawl: "https://www.firecrawl.dev/app",
      tinyfish: "https://agent.tinyfish.ai/wallet"
    };
    const QUOTA_ERRORS = {
      AUTH: "额度接口鉴权失败",
      RATE_LIMIT: "额度查询失败 · 请求限流",
      PERMISSION: "额度接口拒绝访问",
      BILLING: "账户或计费受限",
      ENDPOINT: "额度接口不存在",
      REDIRECT: "额度接口发生重定向",
      UPSTREAM: "额度服务异常",
      TIMEOUT: "额度查询超时",
      NETWORK: "额度查询失败 · 网络异常",
      CONFIG: "请检查查询参数",
      UNAVAILABLE: "额度查询失败",
      UNREPORTED: "额度接口未报告数据"
    };
    const QUOTA_ERROR_HELP = {
      AUTH: "额度接口鉴权失败。请核对 API Key 和查询权限；这不代表搜索一定不可用。",
      RATE_LIMIT: "额度查询请求受到限流，请稍后重试。",
      NETWORK: "未能完成额度查询，请检查网络或服务地址后重试。",
      UNAVAILABLE: "暂时未能取得额度信息，请稍后重试。额度查询失败不等于搜索不可用。",
      UNREPORTED: "接口未返回可识别的额度数据。未报告不代表余额为零。"
    };
    const quotaCache = /* @__PURE__ */ new Map();
    const QUOTA_CACHE_MS = 3e4;
    const animations = /* @__PURE__ */ new Set();
    let quotaEpoch = 0;
    function cancelAnimations() {
      for (const animation of animations) animation.cancel();
      animations.clear();
    }
    function animate(element, keyframes, options) {
      if (!element?.animate || disposed || reduced()) return;
      const animation = element.animate(keyframes, options);
      animations.add(animation);
      animation.finished.then(() => animations.delete(animation), () => animations.delete(animation));
    }
    const quotaTime = () => (/* @__PURE__ */ new Date()).toLocaleTimeString("zh-CN", { hour12: false });
    function quotaBase(id, p) {
      const raw = id === "tinyfish" ? p.searchUrl || DEF.tfSearch : p.url || DEF[id === "firecrawl" ? "fcUrl" : id + "Url"];
      try {
        const url = new URL(raw.trim());
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
        return url.href.replace(/\/+$/, "");
      } catch {
        return null;
      }
    }
    function quotaContext(id, p, keyIndex = 0) {
      const keys = id === "tavily" ? p.keys : [p.key];
      const index = Math.max(0, Math.min(Number.isSafeInteger(keyIndex) ? keyIndex : 0, keys.length - 1));
      const key = (keys[index] || "").trim();
      const base = quotaBase(id, p);
      const official = id === "tavily" ? base === DEF.tavilyUrl : id === "exa" ? base === DEF.exaUrl : id === "firecrawl" ? base === DEF.fcUrl || base === DEF.fcUrl + "/v2" : base === DEF.tfSearch;
      const savedKey = (id === "tavily" ? D.base.keys[index] : D.base.key) || "";
      const draftSame = key === savedKey.trim() && base === quotaBase(id, D.base);
      const signature = JSON.stringify([id, base, key, index]);
      if (D.quotaFormIdentity !== signature) {
        D.quotaFormIdentity = signature;
        D.quotaDraftId = uuid();
      }
      return {
        id,
        keyIndex: index,
        key,
        base,
        official,
        draftSame,
        scope: JSON.stringify([
          id,
          base,
          S.config?.quotaRevision || S.configRevision,
          index,
          draftSame ? "saved" : D.quotaDraftId
        ])
      };
    }
    const quotaNumber = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1e12;
    function quotaValue(value) {
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      const note = typeof value.note === "string" ? value.note.slice(0, 2048) : "";
      if (value.kind === "credits") return {
        kind: "credits",
        note,
        ...Object.fromEntries(["used", "plan", "remaining", "keyUsed", "keyLimit", "keyRemaining"].map((key) => [key, quotaNumber(value[key]) ? value[key] : null]))
      };
      if (value.kind === "wallet" && typeof value.balance === "number" && Number.isFinite(value.balance) && Math.abs(value.balance) <= 1e12) {
        return { kind: "wallet", balance: value.balance, note };
      }
      return null;
    }
    const quotaFormat = (value) => quotaNumber(value) ? value.toLocaleString("zh-CN", { maximumFractionDigits: 6 }) : "未报告";
    function quotaView() {
      if (!D || D.kind !== "card" || !QUOTA_PROVIDERS.has(D.id)) return null;
      const context = quotaContext(D.id, D.draft, D.quotaKeyIndex);
      const baselineCurrent = D.configBaseline.revision === S.configRevision && D.configBaseline.quotaRevision === S.config?.quotaRevision;
      const cached = quotaCache.get(context.scope);
      const status = !S.capabilities?.secretsAllowed ? "restricted" : !context.key ? "unconfigured" : !context.base ? "invalid" : D.id === "exa" ? "unsupported" : !baselineCurrent ? "stale" : D.quotaRequest?.scope === context.scope ? "loading" : cached?.error ? "error" : cached?.value ? "ready" : "unreported";
      return {
        context,
        status,
        cached,
        unchanged: baselineCurrent,
        canRefresh: context.key && baselineCurrent && !!context.base && D.id !== "exa" && status !== "loading" && !dialogBusy() && S.capabilities?.secretsAllowed
      };
    }
    function quotaHtml() {
      const view = quotaView();
      if (!view) return "";
      const { context, status, cached } = view;
      const select = context.id === "tavily" && D.draft.keys.length > 1 ? `<label class="qp-key"><select data-quota-key aria-label="查看哪个 Tavily Key 的额度">${D.draft.keys.map((_, index) => `<option value="${index}"${index === context.keyIndex ? " selected" : ""}>Key ${index + 1}</option>`).join("")}</select></label>` : "";
      const value = ["ready", "loading", "error"].includes(status) ? cached?.value : null;
      const credits = value?.kind === "credits";
      const placeholder = {
        unconfigured: "填写 API Key 后可查询",
        invalid: "Base URL 无效，请检查后查询",
        stale: "配置已在别处修改，读取最新配置后刷新",
        unsupported: "请到服务控制台查看",
        unreported: "尚未查询额度",
        error: (QUOTA_ERRORS[cached?.error] || "额度查询失败") + (cached?.httpStatus ? ` · HTTP ${cached.httpStatus}` : ""),
        loading: "正在查询额度…",
        restricted: "请使用本机直连或 HTTPS 查看额度"
      };
      const info = (kind, label, text) => `<button type="button" class="qp-info" data-quota-kind="${kind}" data-quota-tip="${esc(text)}" aria-label="${esc(label)}">${svg("info", "ic")}</button>`;
      const stat = (label, amount, name, primary = false) => `<div class="qp-stat${primary ? " is-primary" : ""}" data-stat="${name}">
    <span class="qp-label">${label}</span><div class="qp-amount"><strong class="qp-value${quotaNumber(amount) ? "" : " is-unknown"}">${quotaFormat(amount)}</strong>${quotaNumber(amount) ? '<span class="qp-unit">credits</span>' : ""}</div></div>`;
      const metrics = credits ? `<div class="qp-stats">${stat("已用", value.used, "used")}${stat("剩余", value.remaining, "remaining", true)}</div>` : value?.kind === "wallet" ? `<div class="qp-wallet"><span class="qp-label">钱包余额</span><div class="qp-amount"><span class="qp-currency">$</span><strong class="qp-value">${esc(value.balance)}</strong><span class="qp-unit">USD</span></div></div>` : "";
      const progress = credits && quotaNumber(value.used) && quotaNumber(value.plan) && value.plan > 0 ? `<div class="qp-meter" role="meter" aria-label="账户已用额度" aria-valuemin="0" aria-valuemax="${value.plan}" aria-valuenow="${Math.min(value.plan, value.used)}" aria-valuetext="已用 ${quotaFormat(value.used)} credits，总额度 ${quotaFormat(value.plan)} credits"><i style="transform:scaleX(${Math.min(1, value.used / value.plan)})"></i></div>` : credits ? '<div class="qp-meter is-unreported" aria-hidden="true"></div>' : "";
      const hasKey = credits && context.id === "tavily" && ["keyUsed", "keyLimit", "keyRemaining"].some((field) => quotaNumber(value[field]));
      const restricted = hasKey && quotaNumber(value.remaining) && quotaNumber(value.keyRemaining) && value.keyRemaining < value.remaining;
      const keyNote = restricted ? `当前 Key 最多还可用 ${quotaFormat(value.keyRemaining)} credits。` : "";
      const accountInfo = context.id === "tavily" ? keyNote ? info("key", "当前 Key 剩余额度", keyNote) : "" : value ? info("account", "额度统计说明", value.note) : "";
      const errorHelp = cached?.message ? `${cached.message} 额度查询失败不等于搜索不可用。` : QUOTA_ERROR_HELP[cached?.error] || QUOTA_ERROR_HELP.UNAVAILABLE;
      const stateText = status === "loading" ? "正在刷新…" : status === "error" && value ? `刷新失败 · 上次结果${cached?.httpStatus ? ` · HTTP ${cached.httpStatus}` : ""}` : value ? `更新于 ${cached.updatedAt}` : "";
      const stateIcon = status === "error" ? info("error", "额度查询失败原因", errorHelp) : svg("info", "ic qp-state-icon");
      const retry = status === "error";
      const refreshHelp = view.canRefresh ? context.draftSame ? "刷新账户额度" : "查询当前表单的额度，不保存配置" : placeholder[status] || "请等待当前操作完成";
      const refresh2 = context.id === "exa" ? "" : `<button type="button" class="qp-refresh${retry ? " is-retry" : ""}" data-a="quota-refresh" aria-label="${retry ? "重新查询账户额度" : "刷新账户额度"}" title="${esc(refreshHelp)}"${view.canRefresh ? "" : " disabled"} aria-busy="${status === "loading"}">${svg("refresh", "ic")}${retry ? "<span>重试</span>" : ""}</button>`;
      const tools = `<div class="qp-tools">${select}${refresh2}</div>`;
      const consoleHelp = context.official ? "打开官方服务控制台" : "打开官方服务控制台；自定义服务的账户余额请以该服务提供方为准。";
      const consoleLink = `<a class="dlg-link qp-console" href="${QUOTA_CONSOLE[context.id]}" target="_blank" rel="noopener noreferrer" data-quota-kind="console" data-quota-tip="${consoleHelp}" aria-label="服务控制台（官方）">${EXT("服务控制台")}</a>`;
      const total = credits ? `<span class="qp-total">${quotaNumber(value.plan) ? `总额度 <b>${quotaFormat(value.plan)}</b> credits` : "总额度未报告"}</span>` : "";
      const updated = value ? `<span class="qp-updated" data-state="${status}">${status === "error" ? info("error", "额度查询失败原因", `${errorHelp}
上次更新：${cached.updatedAt}`) : ""}<span>${stateText}</span></span>` : "";
      return `<section class="quota-panel" id="quotaPanel" data-provider="${context.id}" data-state="${status}" data-kind="${esc(value?.kind || "")}" aria-labelledby="quotaTitle" aria-busy="${status === "loading"}">
    <header class="qp-head"><div class="qp-heading"><h3 id="quotaTitle">账户额度</h3>${consoleLink}</div>${tools}</header>
    <div class="qp-content"><div class="qp-main" aria-live="polite" aria-atomic="true">
      ${value ? `${metrics}${progress}<div class="qp-summary"><span class="qp-account-meta">${total}${accountInfo}</span>${updated}</div>` : `<div class="qp-empty"><div class="qp-placeholder" data-state="${status}">${stateIcon}<span>${placeholder[status] || "额度尚未查询"}</span></div></div>`}
    </div></div></section>`;
    }
    function renderQuota() {
      const slot = $("#quotaSlot", dlg);
      if (!slot || !D || D.kind !== "card") return;
      const html = quotaHtml();
      if (slot._html === html) return;
      const focused = active()?.closest("#quotaSlot")?.querySelector(":focus");
      const focusedTip = focused?.dataset.quotaKind;
      const focusKind = focused?.hasAttribute("data-quota-key") ? "select" : focusedTip ? "tip" : focused?.dataset.a === "quota-refresh" || focused?.id === "quotaPanel" ? "refresh" : null;
      const previousMeter = $(".qp-meter i", slot);
      const previousTransform = previousMeter && getComputedStyle(previousMeter).transform;
      const previousHeight = parseFloat(getComputedStyle(slot).height);
      const previousState = $("#quotaPanel", slot)?.dataset.state;
      cancelAnimations();
      hideTip?.();
      slot._html = html;
      slot.innerHTML = html;
      const nextHeight = parseFloat(getComputedStyle(slot).height);
      if (previousHeight && Math.abs(nextHeight - previousHeight) > 1) {
        animate(
          slot,
          [{ height: `${previousHeight}px` }, { height: `${nextHeight}px` }],
          { duration: 200, easing: "cubic-bezier(.2,.7,.2,1)" }
        );
      }
      if (previousState && previousState !== $("#quotaPanel", slot)?.dataset.state) {
        animate($(".qp-main", slot), [{ opacity: 0.65 }, { opacity: 1 }], { duration: 180, easing: "ease-out" });
      }
      const meter = $(".qp-meter i", slot);
      if (meter && previousTransform) animate(meter, [
        { transform: previousTransform },
        { transform: meter.style.transform }
      ], { duration: 220, easing: "cubic-bezier(.2,.7,.2,1)" });
      if (focusKind) {
        const target = focusKind === "select" ? $("[data-quota-key]", slot) : focusKind === "tip" ? $(`[data-quota-kind="${focusedTip}"]`, slot) : $("[data-a=quota-refresh]", slot);
        if (target && !target.disabled) target.focus({ preventScroll: true });
        else {
          const panel = $("#quotaPanel", slot);
          panel.tabIndex = -1;
          panel.focus({ preventScroll: true });
        }
      }
    }
    function cancel() {
      cancelAnimations();
      hideTip?.();
      const request = D?.quotaRequest;
      if (request) void remote.cancelDiagnosis({ operationId: request.operationId }).catch(() => {
      });
      if (D) D.quotaRequest = null;
      quotaEpoch++;
    }
    function syncDialog() {
      const next = getDialog();
      if (D !== next) cancel();
      D = next;
    }
    function render() {
      if (disposed) return;
      syncDialog();
      const view = quotaView();
      if (D?.quotaRequest && (!view?.unchanged || !S.capabilities?.secretsAllowed || D.quotaRequest.scope !== view.context.scope)) cancel();
      renderQuota();
    }
    async function refresh({ automatic = false } = {}) {
      syncDialog();
      const view = quotaView();
      if (disposed) return;
      if (!view?.canRefresh) {
        if (!automatic) renderQuota();
        return;
      }
      const age = Date.now() - (view.cached?.completedAt ?? -Infinity);
      if (automatic && age >= 0 && age < QUOTA_CACHE_MS) return;
      const mine = D, epoch = quotaEpoch;
      const request = { scope: view.context.scope, operationId: uuid() };
      mine.quotaRequest = request;
      renderQuota();
      const previous = quotaCache.get(request.scope);
      try {
        const query = view.context.draftSame ? remote.accountQuota : remote.previewAccountQuota;
        const savedKey = (D.id === "tavily" ? D.base.keys[view.context.keyIndex] : D.base.key) || "";
        const result = await query({
          provider: view.context.id,
          keyIndex: view.context.keyIndex,
          ...!view.context.draftSame ? { draft: {
            ...view.context.base !== quotaBase(D.id, D.base) ? { baseUrl: view.context.base } : {},
            ...!hidden(view.context.key) && view.context.key !== savedKey.trim() ? { apiKey: view.context.key } : {}
          } } : {},
          expectedRevision: mine.configBaseline.revision,
          quotaRevision: mine.configBaseline.quotaRevision,
          operationId: request.operationId
        });
        if (disposed || getDialog() !== mine || epoch !== quotaEpoch || mine.quotaRequest !== request) return;
        D = mine;
        mine.quotaRequest = null;
        const current = quotaView();
        if (!current?.unchanged || !S.capabilities?.secretsAllowed || current.context.scope !== request.scope) return;
        const value = quotaValue(result?.value);
        quotaCache.set(request.scope, {
          value,
          updatedAt: quotaTime(),
          completedAt: Date.now(),
          error: value ? null : "UNREPORTED"
        });
      } catch (error) {
        if (disposed || getDialog() !== mine || epoch !== quotaEpoch || mine.quotaRequest !== request) return;
        D = mine;
        mine.quotaRequest = null;
        const current = quotaView();
        if (!current?.unchanged || !S.capabilities?.secretsAllowed || current.context.scope !== request.scope) return;
        const category = error?.details?.category;
        const status = error?.details?.httpStatus;
        quotaCache.set(request.scope, {
          value: previous?.value ?? null,
          updatedAt: previous?.updatedAt,
          completedAt: Date.now(),
          error: Object.hasOwn(QUOTA_ERRORS, category) ? category : "UNAVAILABLE",
          httpStatus: Number.isInteger(status) && status >= 300 && status <= 599 ? status : null,
          message: error?.code === "QUOTA_QUERY_FAILED" ? error.message : `设置服务返回 ${/^[\w./-]{1,80}$/.test(error?.code || "") ? error.code : "未知错误"}；额度查询失败不代表搜索不可用。`
        });
      } finally {
        while (quotaCache.size > 16) quotaCache.delete(quotaCache.keys().next().value);
        if (!disposed && getDialog() === mine) {
          D = mine;
          renderQuota();
        }
      }
    }
    return Object.freeze({
      render,
      stale() {
        syncDialog();
        return quotaView()?.status === "stale";
      },
      open() {
        render();
        return refresh({ automatic: true });
      },
      refresh,
      cancel,
      stopAnimations: cancelAnimations,
      key(index) {
        if (disposed || dialogBusy()) return;
        syncDialog();
        if (D) {
          cancel();
          D.quotaKeyIndex = index;
          renderQuota();
          return refresh({ automatic: true });
        }
      },
      dispose() {
        cancel();
        disposed = true;
        D = null;
        quotaCache.clear();
      }
    });
  }

  // src/ui/tool-route-view.mjs
  function createToolRouteView({ React, jsx, remote, Original, logos = {}, theme = null }) {
    const names = {
      grok: "Grok",
      "grok-sources": "来源未报告",
      tavily: "Tavily",
      exa: "Exa",
      tinyfish: "TinyFish",
      firecrawl: "Firecrawl",
      github: "GitHub API"
    };
    const describe = (result, phase, isError) => {
      if (!result?.known || !Array.isArray(result.routes) || result.routes.length === 0) {
        return {
          known: false,
          tone: "unknown",
          text: phase === "preparing" ? "等待搜索调用" : phase === "start" ? "正在确认搜索通道…" : "本次来源未记录"
        };
      }
      const sources = [...new Set(result.routes.flatMap((route) => Array.isArray(route.resultProviders) ? [
        ...route.resultProviders.filter((provider) => Object.hasOwn(names, provider) && provider !== "grok-sources").map((provider) => names[provider]),
        ...route.resultProvidersComplete === true && route.resultProviders.length ? [] : ["来源未报告"]
      ] : Object.hasOwn(names, route.served) ? [names[route.served]] : []))];
      const cancelled = result.state === "cancelled";
      const failed = !cancelled && (isError || result.state === "failed");
      const running = phase !== "result" || result.state === "running";
      const fallback = result.routes.some((route) => route.fallbackUsed === true);
      const status = cancelled ? "已取消" : failed ? "搜索失败" : running ? "正在搜索" : fallback ? "已回退" : "";
      const text = [
        "由 dsh-grok-search 执行",
        sources.join(" / ") || (running ? "等待来源返回" : "来源未报告"),
        result.routesComplete === false ? "其余来源未记录" : "",
        status
      ].filter(Boolean).join(" · ");
      return { known: true, tone: failed ? "error" : cancelled ? "cancelled" : running ? "running" : "ok", text };
    };
    const known = (value) => value?.known === true && Array.isArray(value.routes) && value.routes.length > 0;
    const validIdentity = (value, limit) => typeof value === "string" && value.length > 0 && value.length <= limit && !/[\s\u0000-\u001f]/.test(value);
    function watch({ sessionId, callId, phase, onChange }) {
      let active = true, visible = true, timer = null, deadline = null, inFlight = false, attempts = 0, last = "", legacy = false, buffered = null;
      let currentPhase = phase, settled = false;
      const readable = validIdentity(sessionId, 128) && validIdentity(callId, 512);
      const emit = (value) => {
        if (!visible) {
          buffered = value;
          return;
        }
        const signature = JSON.stringify(value);
        if (last !== signature) {
          last = signature;
          onChange(value);
        }
      };
      const queue = () => {
        clearTimeout(timer);
        timer = null;
        if (active && visible && !settled) timer = setTimeout(poll, 750);
      };
      async function poll() {
        if (!active || !visible || inFlight || !readable || currentPhase === "preparing" || settled) return;
        inFlight = true;
        let timedOut = false;
        deadline = setTimeout(() => {
          deadline = null;
          timedOut = true;
          settled = true;
          if (active) emit({ result: null, unreadable: true, code: "SETTINGS_READ_TIMEOUT" });
        }, 4e3);
        try {
          let result;
          try {
            result = !legacy && typeof remote.toolCallTrace === "function" ? await remote.toolCallTrace({ sessionId, callId }) : await remote.toolCallRoute({ sessionId, callId });
          } catch (error) {
            if (!active || timedOut) return;
            if (!legacy && /(?:METHOD_NOT_FOUND|method.not.found|method_not_found)/i.test(error?.code ?? "")) {
              legacy = true;
              result = await remote.toolCallRoute({ sessionId, callId });
            } else throw error;
          }
          if (!active || timedOut) return;
          const incomplete = !known(result) || result.state === "running";
          const retry = incomplete && (currentPhase === "start" || ++attempts < 3);
          settled = !retry;
          emit(settled && known(result) && result.state === "running" ? { result: null, unreadable: true, code: "TOOL_ROUTE_PENDING" } : { result, reading: !known(result) && currentPhase === "result" && retry });
        } catch (error) {
          if (!active || timedOut) return;
          const code = /^[\w./-]{1,80}$/.test(error?.code || "") ? error.code : "SETTINGS_UNAVAILABLE";
          settled = ++attempts >= 3;
          emit({ result: null, unreadable: true, code });
        } finally {
          clearTimeout(deadline);
          deadline = null;
          inFlight = false;
          queue();
        }
      }
      return {
        update(next) {
          const resumed = !visible && next.visible !== false;
          if (next.phase !== currentPhase) {
            currentPhase = next.phase;
            settled = false;
            attempts = 0;
          }
          if (resumed && settled) {
            settled = false;
            attempts = 0;
          }
          visible = next.visible !== false;
          clearTimeout(timer);
          timer = null;
          if (visible && buffered) {
            const value = buffered;
            buffered = null;
            emit(value);
          }
          if (visible) void poll();
        },
        dispose() {
          active = false;
          clearTimeout(timer);
          clearTimeout(deadline);
          timer = null;
          deadline = null;
          buffered = null;
        }
      };
    }
    const finiteMs = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
    const duration = (value) => finiteMs(value) === null ? "—" : `${(value / 1e3).toFixed(1)} 秒`;
    const errorText = (code) => {
      if (/401|grok_auth_error/.test(code)) return "鉴权失败";
      if (/403/.test(code)) return "访问受限";
      if (/429|rate.limit/i.test(code)) return "请求限流";
      if (/TIMEOUT|timeout/.test(code)) return "响应超时";
      if (/50[234]/.test(code)) return "服务不可用";
      if (/EMPTY|empty|NO_RESULTS/.test(code)) return "未返回结果";
      if (/NETWORK|CONNECT|network/.test(code)) return "连接失败";
      if (/BUDGET|OUTPUT_LIMIT/.test(code)) return "达到调用上限";
      return "调用失败";
    };
    const safeUrl = (value) => {
      if (typeof value !== "string") return null;
      try {
        const url = new URL(value);
        return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
      } catch {
        return null;
      }
    };
    function model(result, props) {
      const phase = props.phase, block = props.block ?? {};
      let args = {};
      try {
        args = JSON.parse((phase === "result" ? block.call?.argsRaw : block.argsRaw) ?? "{}");
      } catch {
      }
      const queries = Array.isArray(args?.queries) ? [...new Set(args.queries.filter((value) => typeof value === "string"))] : [];
      const state = result?.state === "cancelled" ? "cancelled" : block.isError || result?.state === "failed" ? "failed" : phase !== "result" || result?.state === "running" ? "running" : "done";
      const routes = (result?.routes ?? []).slice(0, 16).map((route, index) => {
        const counts = /* @__PURE__ */ new Map();
        const calls = (Array.isArray(route.calls) ? route.calls : []).slice(0, 16).filter((call) => Object.hasOwn(names, call.provider) && call.provider !== "grok-sources").map((call) => {
          const occurrence = counts.get(call.provider) ?? 0;
          counts.set(call.provider, occurrence + 1);
          return {
            ...call,
            id: `${call.provider}-${occurrence}`,
            elapsedMs: finiteMs(call.elapsedMs),
            result: state !== "running" && call.result === "running" ? "unknown" : ["ok", "failed", "cancelled", "running"].includes(call.result) ? call.result : "unknown",
            code: /^[\w.-]{1,64}$/.test(call.code ?? "") ? call.code : "",
            keyIndex: Number.isSafeInteger(call.keyIndex) && call.keyIndex >= 0 && call.keyIndex < 100 ? call.keyIndex : null
          };
        });
        if (!calls.length && route.outcome !== "running") {
          const providers = Array.isArray(route.resultProviders) ? route.resultProviders : route.served && route.served !== "grok-sources" ? [route.served] : [];
          for (const provider of providers.filter((id) => Object.hasOwn(names, id))) calls.push({
            id: `evidence-${provider}`,
            provider,
            result: route.outcome === "ok" ? "ok" : "unknown",
            evidence: "source-label",
            elapsedMs: null,
            keyIndex: null,
            code: ""
          });
        }
        const planned = Array.isArray(route.planned) ? [...new Set(route.planned.filter((provider) => Object.hasOwn(names, provider) && provider !== "grok-sources"))].slice(0, 5) : [];
        if (state === "running" && route.outcome === "running") {
          for (const provider of planned) if (!counts.has(provider)) {
            calls.push({ id: `${provider}-0`, provider, result: "pending", evidence: "planned", elapsedMs: null, keyIndex: null, code: "" });
          }
        }
        return {
          ...route,
          index,
          query: queries[index] ?? `查询 ${index + 1}`,
          calls,
          partial: calls.some((call) => call.evidence === "source-label" || call.evidence === "kernel-summary") || route.callsTruncated === true || !Array.isArray(route.calls) || phase === "result" && route.outcome === "running"
        };
      });
      const sources = Array.isArray(block.meta?.sources) ? block.meta.sources.map((source) => {
        const url = safeUrl(source?.url);
        return url ? {
          url,
          title: typeof source.title === "string" && source.title ? source.title : new URL(url).hostname,
          domain: new URL(url).hostname,
          snippet: typeof source.snippet === "string" ? source.snippet : "",
          publishedAt: typeof source.publishedAt === "string" ? source.publishedAt : ""
        } : null;
      }).filter(Boolean) : [];
      const fallback = routes.some((route) => route.fallbackUsed);
      const label = state === "cancelled" ? "已取消" : state === "failed" ? "搜索失败" : state === "running" ? phase === "result" ? "正在确认结果" : result?.state === "done" ? "正在整理结果" : routes.some((route) => route.calls.some((call) => call.result === "failed")) ? "正在切换来源" : "搜索中" : fallback ? "已回退" : "已完成";
      return {
        state,
        label,
        routes,
        sources,
        queries,
        query: queries.length > 1 ? `${queries.length} 个查询` : queries[0] ?? "网页搜索",
        elapsedMs: finiteMs(result?.elapsedMs),
        truncated: block.meta?.truncated === true,
        answer: typeof block.meta?.answer === "string" ? block.meta.answer : "",
        output: Array.isArray(block.content) ? block.content.filter((row) => row?.type === "text" && typeof row.text === "string").map((row) => row.text).join("\n") : "",
        complete: result?.routesComplete !== false
      };
    }
    const sameRows = (left, right, fields) => left === right || Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((row, index) => row === right[index] || fields.every((field) => row?.[field] === right[index]?.[field]));
    function sameBlock(left, right) {
      left ??= {};
      right ??= {};
      return left === right || left.argsRaw === right.argsRaw && left.call?.argsRaw === right.call?.argsRaw && left.isError === right.isError && left.meta?.answer === right.meta?.answer && left.meta?.truncated === right.meta?.truncated && sameRows(left.meta?.sources, right.meta?.sources, ["url", "title", "snippet", "publishedAt"]) && sameRows(left.content, right.content, ["type", "text"]);
    }
    const paths = {
      route: "M7.3 12h3.2m0 0c2.6 0 2.4-6.5 6.5-6.5M10.5 12h6.5M10.5 12c2.6 0 2.4 6.5 6.5 6.5",
      check: "m7 12 3 3 7-7",
      alert: "M12 7v6m0 4h.01",
      clock: "M12 7v5l3 2",
      cancel: "m8 8 8 8m0-8-8 8",
      chevron: "m9 5 7 7-7 7",
      code: "m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18",
      external: "M14 3h7v7m0-7L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"
    };
    function icon(name, extra = "") {
      const children = name === "spinner" ? [jsx("path", { d: "M20 12a8 8 0 1 1-8-8" }, "path")] : name === "route" ? [jsx("path", { d: paths.route }, "path"), ...[[5, 12, 2.3], [19, 5.5, 2], [19, 12, 2], [19, 18.5, 2]].map((p, i) => jsx("circle", { cx: p[0], cy: p[1], r: p[2] }, String(i)))] : [
        jsx("path", { d: paths[name] ?? paths.alert }, "path"),
        ...["check", "alert", "clock", "cancel"].includes(name) ? [jsx("circle", { cx: 12, cy: 12, r: 9 }, "circle")] : []
      ];
      return jsx("svg", { className: `icon ${name === "spinner" ? "spinner" : ""} ${extra}`, viewBox: "0 0 24 24", "aria-hidden": true, children });
    }
    const stateIcon = (state) => state === "running" ? "spinner" : state === "failed" ? "alert" : state === "cancelled" ? "cancel" : ["unknown", "pending"].includes(state) ? "clock" : "check";
    function Logo({ id, dark }) {
      if (id === "hub") return icon("route");
      const key = id === "dsh" ? dark ? "harnessChatDark" : "harnessChat" : dark && ["tavily", "exa", "github"].includes(id) ? `${id}Dark` : id;
      return logos[key] ? jsx("img", { className: "logo", "data-logo": id, src: logos[key], alt: "", "aria-hidden": true, draggable: false }) : null;
    }
    function Edge({ id, state, recovery = false, extra = "" }) {
      return jsx("span", {
        className: `edge ${state === "active" ? "active" : ""} ${extra}`,
        "data-edge": id,
        "data-wire": state,
        "data-tone": recovery ? "back" : "flow",
        "aria-hidden": true,
        children: jsx("svg", {
          className: "wire-svg wire-horizontal",
          viewBox: "0 0 26 12",
          preserveAspectRatio: "none",
          children: [
            jsx("path", { className: "wire-track", d: "M3 6H22" }, "track"),
            jsx("path", { className: "wire-head", d: "m18.5 2.5 3.5 3.5-3.5 3.5" }, "head"),
            ...["wire-halo", "", "wire-tip"].map((name, i) => jsx("path", { className: `wire-flow ${name}`, pathLength: 100, d: "M3 6H22" }, String(i)))
          ]
        })
      });
    }
    function Node({ id, name, result, note, code, dark, recovery, evidence, animate, ingressActive = false }) {
      const ref = React.useRef(null), previous = React.useRef(null);
      React.useEffect(() => {
        const before = previous.current;
        previous.current = result;
        const feedback = !animate ? "" : before === null && ingressActive || result === "running" && before !== result ? "receive" : before !== null && before !== result && result === "failed" ? "failed" : before !== null && before !== result && result === "ok" && !["dsh", "hub"].includes(id) ? "success" : "";
        if (ref.current) {
          if (feedback) ref.current.dataset.feedback = feedback;
          else if (before !== result || !animate || ["dsh", "hub"].includes(id) && !ingressActive) delete ref.current.dataset.feedback;
        }
      }, [result, animate, ingressActive]);
      return jsx("div", {
        ref,
        className: `route-node ${evidence ? "source-evidence" : ""}`,
        "data-result": result,
        "data-recovery": String(Boolean(recovery)),
        style: id === "hub" && ingressActive ? { "--arrival-delay": "620ms" } : void 0,
        title: code || void 0,
        children: [
          jsx("div", { className: "route-name", children: [jsx(Logo, { id, dark }, "logo"), jsx("span", { children: name }, "name")] }, "name"),
          jsx("div", { className: "route-note", children: [...!["dsh", "hub"].includes(id) ? [icon(stateIcon(result))] : [], jsx("span", { children: note }, "note")] }, "note")
        ]
      });
    }
    function Flow({ route, state, dark, animate }) {
      const calls = route.calls, active = state === "running";
      const follows = (index) => calls.slice(0, index).some((call) => call.result === "failed");
      const wireState = (call, index) => !call || call.result === "pending" ? "pending" : call.evidence === "source-label" ? follows(index) ? "recovered" : "passed" : call.result === "running" ? "active" : call.result === "failed" ? "dead" : call.result === "ok" ? follows(index) ? "recovered" : "passed" : "idle";
      const children = [
        jsx("div", { className: "ingress", children: [
          jsx(Node, { id: "dsh", name: "DSH", result: "ok", note: "发起搜索", dark, animate, ingressActive: active }, "dsh"),
          jsx(Edge, { id: "dsh-hub", state: active ? "active" : "passed" }, "dsh-hub"),
          jsx(Node, {
            id: "hub",
            name: "Grok Search Rs",
            result: route.phase === "queued" ? "running" : "ok",
            note: route.phase === "queued" ? "等待执行" : "执行搜索路由",
            dark,
            animate,
            ingressActive: active
          }, "hub")
        ] }, "ingress"),
        ...calls.length ? [jsx(Edge, {
          id: "hub-source",
          state: wireState(calls[0], 0),
          extra: `bridge${calls[0].evidence === "source-label" ? " source-link" : ""}`
        }, "bridge")] : [],
        jsx("div", { className: "provider-steps", children: calls.flatMap((call, index) => {
          const repeated = calls.filter((row) => row.provider === call.provider && row.result !== "pending").length > 1;
          const key = call.keyIndex === null || !repeated && call.keyIndex === 0 ? "" : ` · Key ${call.keyIndex + 1}`;
          const text = call.evidence === "source-label" ? "结果来源" : call.result === "pending" ? "待命" : call.result === "running" ? "搜索中" : call.result === "ok" ? "返回结果" : call.result === "cancelled" ? "已取消" : call.result === "unknown" ? "状态未报告" : errorText(call.code);
          const note = [text, call.elapsedMs === null ? "" : duration(call.elapsedMs)].filter(Boolean).join(" · ");
          return [
            // A source label establishes attribution, not an observed dispatch.
            // Keep its connector visible and static without inventing transit time.
            ...index ? [jsx(Edge, {
              id: `source-${index}`,
              state: wireState(call, index),
              recovery: follows(index),
              extra: call.evidence === "source-label" ? "source-link" : ""
            }, `edge-${call.id}`)] : [],
            jsx(Node, {
              id: call.provider,
              name: names[call.provider] + key,
              result: call.result,
              note,
              code: call.code,
              dark,
              recovery: follows(index),
              evidence: call.evidence === "source-label",
              animate
            }, call.id)
          ];
        }) }, "providers")
      ];
      return jsx("div", {
        className: "flow-scroll",
        role: "region",
        tabIndex: 0,
        "aria-label": `查询 ${route.index + 1} 的搜索执行链路，可横向滚动`,
        children: jsx("div", { className: "flow", "data-terminal": state, children })
      });
    }
    const fallbackDisclosure = () => {
      const [expanded, setExpanded] = React.useState(true);
      return { expanded, toggle: () => setExpanded((value) => !value) };
    };
    const fallbackMenu = () => ({ getTriggerProps: () => ({}) });
    function Card({ value, host, dark, visible, reduce }) {
      const disclosure = (host.useDisclosure ?? fallbackDisclosure)();
      const { getTriggerProps } = (host.useContextMenu ?? fallbackMenu)();
      const open = disclosure.expanded, body = React.useRef(null);
      const previousState = React.useRef(value.state);
      const animate = visible && open && !reduce;
      React.useEffect(() => {
        const element = body.current;
        if (!element || !animate) return;
        const container = element.parentElement;
        let previousHeight = null, previousWidth = null, motion = null, frame = null, from = 0, to = 0, active = true;
        const observer = new ResizeObserver((entries) => {
          const box = entries[0]?.borderBoxSize?.[0], height = box?.blockSize, width = box?.inlineSize;
          if (!active || !Number.isFinite(height)) return;
          const before = previousHeight, resized = previousWidth !== null && Math.abs(previousWidth - width) > 1;
          previousHeight = height;
          previousWidth = width;
          if (resized) {
            cancelAnimationFrame(frame);
            frame = null;
            motion?.cancel();
            motion = null;
            return;
          }
          if (before === null || Math.abs(before - height) < 1) return;
          cancelAnimationFrame(frame);
          frame = requestAnimationFrame(() => {
            frame = null;
            if (!active) return;
            const progress = motion?.effect?.getComputedTiming().progress;
            const current = typeof progress === "number" ? from + (to - from) * progress : before;
            motion?.cancel();
            from = current;
            to = height;
            const playback = container.animate(
              [{ height: `${from}px` }, { height: `${to}px` }],
              { duration: 240, easing: "cubic-bezier(.2,.75,.25,1)" }
            );
            motion = playback;
            playback.onfinish = () => {
              if (motion === playback) motion = null;
            };
          });
        });
        observer.observe(element, { box: "border-box" });
        return () => {
          active = false;
          observer.disconnect();
          cancelAnimationFrame(frame);
          motion?.cancel();
        };
      }, [animate]);
      React.useEffect(() => {
        const settled = previousState.current === "running" && value.state === "done";
        previousState.current = value.state;
        const results2 = body.current?.querySelector(".results");
        if (!animate) return;
        if (settled && results2) results2.dataset.feedback = "success";
        return () => {
          if (results2) delete results2.dataset.feedback;
        };
      }, [value.state, animate]);
      const label = jsx("span", {
        className: "state",
        "data-state": value.state,
        role: "status",
        "aria-live": "polite",
        "aria-atomic": true,
        children: [icon(stateIcon(value.state)), jsx("span", { children: value.label }, "label")]
      });
      const sourceNames = [...new Set(value.routes.filter((route) => route.outcome === "ok").flatMap((route) => {
        const providers = Array.isArray(route.resultProviders) ? route.resultProviders : [route.served];
        return providers.filter((provider) => Object.hasOwn(names, provider) && provider !== "grok-sources").map((provider) => names[provider]);
      }))];
      const cause = value.state === "cancelled" ? "搜索已停止，未继续请求剩余来源。" : value.state === "failed" ? "本次搜索未返回可用结果，未回退到官方搜索。" : value.routes.some((route) => route.fallbackUsed) && value.state === "done" ? `已静默回退${sourceNames.length ? `，结果由 ${sourceNames.join("、")} 提供` : ""}。` : "";
      const results = jsx("div", { className: "results", children: [
        jsx("div", { className: "results-heading", children: [
          jsx("span", { children: "搜索结果" }, "title"),
          jsx("span", { className: "results-count", children: value.sources.length ? `${value.sources.length} 个引用来源` : "" }, "count")
        ] }, "head"),
        value.answer ? jsx("details", { className: "answer-summary", children: [jsx("summary", { children: "搜索摘要" }, "title"), jsx("div", { children: value.answer }, "content")] }, "answer") : null,
        value.state === "running" ? jsx("p", { className: "outcome-note", children: "正在等待来源返回结果…" }, "waiting") : value.sources.length ? jsx("div", { className: "source-list", children: value.sources.map((source, index) => jsx("div", { children: [
          jsx("a", {
            className: "source-row",
            href: source.url,
            target: "_blank",
            rel: "noopener noreferrer",
            ...getTriggerProps({ kind: "url", value: { sessionId: host.sessionId, url: source.url } }),
            children: [
              jsx("span", { className: "source-num", children: String(index + 1) }, "number"),
              jsx("span", { className: "source-copy", children: [
                jsx("span", { className: "source-title", children: source.title }, "title"),
                jsx("span", { className: "source-domain", children: source.domain }, "domain")
              ] }, "copy"),
              icon("external")
            ]
          }, "link"),
          source.snippet || source.publishedAt ? jsx("details", { className: "source-extra", children: [
            jsx("summary", { children: source.publishedAt || "来源摘要" }, "title"),
            jsx("div", { children: source.snippet }, "content")
          ] }, "excerpt") : null
        ] }, `${source.url}-${index}`)) }, "list") : jsx("p", { className: "outcome-note", children: value.state === "cancelled" ? "本次未返回搜索结果。" : value.output || "本次没有可展示的搜索结果。" }, "empty"),
        value.truncated ? jsx("p", { className: "outcome-note", children: "部分搜索结果已截断，可缩小查询范围继续搜索。" }, "truncated") : null
      ] });
      return jsx("article", { className: "search-card", "data-open": String(open), children: [
        jsx("div", { className: "card-header", children: [
          jsx("button", { className: "card-toggle", type: "button", "aria-expanded": open, onClick: disclosure.toggle, children: [
            jsx("span", { className: "plugin-mark", children: icon("route") }, "mark"),
            jsx("span", { className: "card-name", children: "dsh-grok-search" }, "name"),
            jsx("span", { className: "title-dot", children: "·" }, "dot"),
            jsx("span", { className: "tool-type", children: "网页搜索" }, "type"),
            jsx("span", { className: "query-summary", title: value.queries.join("\n"), children: value.query }, "query"),
            jsx("span", { className: "header-right", children: [label, jsx("span", { className: "elapsed", children: duration(value.elapsedMs) }, "time"), icon("chevron", "chevron")] }, "right")
          ] }, "toggle"),
          typeof host.inspect === "function" ? jsx("button", {
            className: "inspect-btn",
            type: "button",
            "aria-label": "查看调用参数与原始结果",
            title: "查看调用参数与原始结果",
            onClick: host.inspect,
            children: icon("code")
          }, "inspect") : null
        ] }, "header"),
        jsx("div", { className: "fold", inert: open ? void 0 : "", children: jsx("div", { className: "fold-inner", children: jsx("div", { className: "card-body", ref: body, children: [
          jsx("div", { className: "section-line", children: [
            jsx("span", { className: "section-caption", children: "执行过程" }, "title"),
            jsx("span", { className: "wire-name", children: [icon("code"), "web_search"] }, "wire")
          ] }, "head"),
          jsx("div", { className: "batch-list", children: value.routes.map((route) => jsx("section", { className: "query-block", children: [
            value.routes.length > 1 || value.query.length > 65 ? jsx("div", { className: "query-head", children: [
              jsx("span", { className: "query-number", children: String(route.index + 1).padStart(2, "0") }, "number"),
              jsx("span", { className: "query-text", children: route.query }, "query"),
              jsx("span", {
                className: "state",
                "data-state": route.outcome === "ok" ? "done" : route.outcome,
                children: [
                  icon(stateIcon(route.outcome === "ok" ? "done" : route.outcome)),
                  route.outcome === "running" ? "搜索中" : route.outcome === "failed" ? "搜索失败" : route.outcome === "cancelled" ? "已取消" : route.fallbackUsed ? "已回退" : "已完成"
                ]
              }, "state")
            ] }, "query") : null,
            jsx(Flow, { route, state: value.state, dark, animate }, "flow")
          ] }, String(route.index))) }, "routes"),
          !value.complete ? jsx("p", { className: "cause", children: [icon("alert"), "部分查询明细已超出记录上限。"] }, "omitted") : null,
          cause ? jsx("p", { className: "cause", children: [icon("alert"), cause] }, "cause") : null,
          results
        ] }) }) }, "fold")
      ] });
    }
    const MemoCard = typeof React.memo === "function" ? React.memo(Card) : Card;
    function SearchToolWithRoute(props) {
      const { sessionId, callId, phase, block } = props;
      const identity = JSON.stringify([sessionId, callId]);
      const readable = validIdentity(sessionId, 128) && validIdentity(callId, 512) && phase !== "preparing";
      const [answer, setAnswer] = React.useState(null);
      const element = React.useRef(null), subscription = React.useRef(null), presentation = React.useRef(null);
      const inspectRef = React.useRef(props.inspect);
      inspectRef.current = props.inspect;
      const inspect = React.useCallback(() => inspectRef.current?.(), []);
      const host = React.useMemo(
        () => ({
          sessionId,
          useDisclosure: props.useDisclosure,
          useContextMenu: props.useContextMenu,
          inspect: typeof props.inspect === "function" ? inspect : void 0
        }),
        [sessionId, props.useDisclosure, props.useContextMenu, typeof props.inspect, inspect]
      );
      const [visible, setVisible] = React.useState(false);
      const [dark, setDark] = React.useState(theme?.current ?? false), [reduce, setReduce] = React.useState(false);
      const latest = React.useRef({ phase });
      latest.current = { phase };
      React.useEffect(() => {
        let inView = true;
        const update = () => setVisible(inView && !document.hidden);
        const observer = new IntersectionObserver((entries) => {
          inView = entries[0].isIntersecting;
          update();
        });
        observer.observe(element.current);
        document.addEventListener("visibilitychange", update);
        const color = matchMedia("(prefers-color-scheme: dark)"), motion = matchMedia("(prefers-reduced-motion: reduce)");
        const updateTheme = () => setDark(theme?.current ?? color.matches), updateMotion = () => setReduce(motion.matches);
        theme?.listeners.add(updateTheme);
        color.addEventListener("change", updateTheme);
        motion.addEventListener("change", updateMotion);
        updateTheme();
        updateMotion();
        return () => {
          observer.disconnect();
          document.removeEventListener("visibilitychange", update);
          theme?.listeners.delete(updateTheme);
          color.removeEventListener("change", updateTheme);
          motion.removeEventListener("change", updateMotion);
        };
      }, []);
      React.useEffect(() => {
        const current = watch({
          sessionId,
          callId,
          phase: latest.current.phase,
          // Keep the subscription's identity immutable even between a new render
          // and its passive-effect cleanup; a late old reply cannot label a new call.
          onChange: (value2) => setAnswer({ identity, ...value2 })
        });
        subscription.current = current;
        return () => {
          current.dispose();
          subscription.current = null;
        };
      }, [remote, sessionId, callId]);
      React.useEffect(() => {
        subscription.current?.update({ phase, visible });
      }, [phase, visible, sessionId, callId]);
      const matched = answer?.identity === identity;
      const label = readable && (!matched || answer.reading) ? { known: false, tone: "unknown", text: "正在读取本次来源…" } : matched && answer.unreadable ? { known: false, tone: "unknown", text: `本次来源暂不可读 · ${answer.code}` } : describe(matched ? answer.result : null, phase, block?.isError);
      let value = null;
      if (readable && matched && known(answer.result)) {
        const before = presentation.current;
        if (!before || before.result !== answer.result || before.phase !== phase || !sameBlock(before.block, block)) {
          presentation.current = { result: answer.result, phase, block, value: model(answer.result, props) };
        }
        value = presentation.current.value;
      } else presentation.current = null;
      return jsx("div", {
        ref: element,
        className: "dsg-chat",
        "data-theme": dark ? "dark" : "light",
        "data-visible": String(visible),
        "data-motion": reduce ? "reduce" : "full",
        "data-dsg-search-card": callId,
        children: value ? [
          jsx(MemoCard, { value, host, dark, visible, reduce }, "card")
        ] : [
          jsx(Original, props, "original"),
          jsx("span", {
            className: "dsg-tool-attribution",
            "data-tone": label.tone,
            "data-known": String(label.known),
            role: phase === "start" ? "status" : void 0,
            "aria-atomic": phase === "start" ? "true" : void 0,
            children: label.text
          }, "attribution")
        ]
      });
    }
    return Object.freeze({ Component: SearchToolWithRoute, describe, model, watch });
  }

  // src/ui/shared-styles.mjs
  var sheets = /* @__PURE__ */ new WeakMap();
  function attachSharedStyles(root, css) {
    const document2 = root.ownerDocument;
    const Constructor = document2?.defaultView?.CSSStyleSheet;
    let sheet;
    if (typeof Constructor === "function" && "adoptedStyleSheets" in root) {
      try {
        const cached = sheets.get(document2);
        if (cached?.css === css) sheet = cached.sheet;
        else {
          sheet = new Constructor();
          sheet.replaceSync(css);
          sheets.set(document2, { css, sheet });
        }
        if (!root.adoptedStyleSheets.includes(sheet)) root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
        let attached = true;
        return () => {
          if (!attached) return;
          attached = false;
          root.adoptedStyleSheets = root.adoptedStyleSheets.filter((candidate) => candidate !== sheet);
        };
      } catch {
      }
    }
    const style = document2.createElement("style");
    style.textContent = css;
    root.prepend(style);
    return () => style.remove();
  }

  // dsh-client:data
  var LOGOS = { "harness": "data:image/png;base64,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", "harnessChat": "data:image/png;base64,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", "harnessChatDark": "data:image/png;base64,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", "deepseek": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9Ii0xLjUgLTguMyA1OSA1OSIgZmlsbD0ibm9uZSI+PCEtLSBEZWVwU2VlayB3aGFsZSBtYXJrLCBwYXRoIGNvcGllZCB2ZXJiYXRpbSBmcm9tIGdpdGh1Yi5jb20vZGVlcHNlZWstYWkvRGVlcFNlZWstVjIvYmxvYi9tYWluL2ZpZ3VyZXMvbG9nby5zdmcgKHdvcmRtYXJrIHJlbW92ZWQsIHZpZXdCb3ggc3F1YXJlZCkgLS0+PHBhdGggZD0iTTU1LjYxMjggMy40NzExOUM1NS4wMTc1IDMuMTc5NDQgNTQuNzYxMSAzLjczNTM1IDU0LjQxMyA0LjAxNzgyQzU0LjI5MzkgNC4xMDg4OSA1NC4xOTMyIDQuMjI3MjkgNTQuMDkyNCA0LjMzNjY3QzUzLjIyMjMgNS4yNjU4NyA1Mi4yMDU3IDUuODc2NDYgNTAuODc3NiA1LjgwMzQ3QzQ4LjkzNTkgNS42OTQwOSA0Ny4yNzgxIDYuMzA0NjkgNDUuODEyNiA3Ljc4OTc5QzQ1LjUwMTIgNS45NTg1IDQ0LjQ2NjMgNC44NjQ5OSA0Mi44OTA5IDQuMTYzNTdDNDIuMDY2NyAzLjc5OTA3IDQxLjIzMzIgMy40MzQ1NyA0MC42NTYxIDIuNjQxODVDNDAuMjUzMiAyLjA3NzE1IDQwLjE0MzIgMS40NDg0OSAzOS45NDE4IDAuODI4ODU3QzM5LjgxMzUgMC40NTUzMjIgMzkuNjg1MyAwLjA3MjUwOTggMzkuMjU0OCAwLjAwODc4OTA2QzM4Ljc4NzcgLTAuMDYzOTY0OCAzOC42MDQ1IDAuMzI3NjM3IDM4LjQyMTMgMC42NTU3NjJDMzcuNjg4NiAxLjk5NTEyIDM3LjQwNDcgMy40NzExOSAzNy40MzIxIDQuOTY1MzNDMzcuNDk2MiA4LjMyNzM5IDM4LjkxNTkgMTEuMDA1OSA0MS43MzY5IDEyLjkxMDJDNDIuMDU3NSAxMy4xMjg5IDQyLjEzOTkgMTMuMzQ3NCA0Mi4wMzkyIDEzLjY2NjVDNDEuODQ2OCAxNC4zMjI1IDQxLjYxNzggMTQuOTYwMiA0MS40MTY0IDE1LjYxNjJDNDEuMjg4MSAxNi4wMzU0IDQxLjA5NTcgMTYuMTI2NSA0MC42NDcgMTUuOTQ0MUMzOS4wOTkxIDE1LjI5NzQgMzcuNzYxOCAxNC4zNDA2IDM2LjU4MDMgMTMuMTgzNkMzNC41NzQ1IDExLjI0MjkgMzIuNzYxIDkuMTAxODEgMzAuNDk4OCA3LjQyNTI5QzI5Ljk2NzUgNy4wMzM0NSAyOS40MzYzIDYuNjY5MTkgMjguODg2NyA2LjMyMjc1QzI2LjU3ODYgNC4wODE1NCAyOS4xODkgMi4yNDA5NyAyOS43OTM1IDIuMDIyNDZDMzAuNDI1NCAxLjc5NDY4IDMwLjAxMzMgMS4wMTA5OSAyNy45NzA4IDEuMDIwMjZDMjUuOTI4MyAxLjAyOTMgMjQuMDU5OSAxLjcxMjY1IDIxLjY3ODYgMi42MjM3OEMyMS4zMzA2IDIuNzYwNSAyMC45NjQxIDIuODYwNiAyMC41ODg2IDIuOTQyNjNDMTguNDI3MSAyLjUzMjcxIDE2LjE4MzEgMi40NDE0MSAxMy44Mzg0IDIuNzA1ODFDOS40MjM3MSAzLjE5Nzc1IDUuODk3NTggNS4yODQxOCAzLjMwNTU0IDguODQ2NjhDMC4xOTE0MDYgMTMuMTI4OSAtMC41NDEyNiAxNy45OTQxIDAuMzU2MzIzIDIzLjA2OTFDMS4yOTk2OCAyOC40MTcyIDQuMDI5MDUgMzIuODQ1MiA4LjIyMzg4IDM2LjMwNzZDMTIuNTc0NSAzOS44OTcyIDE3LjU4NDUgNDEuNjU1OCAyMy4yOTk3IDQxLjMxODZDMjYuNzcxIDQxLjExODIgMzAuNjM2MSA0MC42NTM2IDM0Ljk5NTggMzYuOTYzNkMzNi4wOTQ4IDM3LjUxMDMgMzcuMjQ4OSAzNy43Mjg4IDM5LjE2MzIgMzcuODkyOEM0MC42Mzc4IDM4LjAyOTUgNDIuMDU3NSAzNy44MjAxIDQzLjE1NjUgMzcuNTkyM0M0NC44Nzg0IDM3LjIyNzggNDQuNzU5NCAzNS42MzMzIDQ0LjEzNjYgMzUuMzQxOEMzOS4wOSAzMi45OTEyIDQwLjE5ODEgMzMuOTQ3OCAzOS4xOTA3IDMzLjE3MzNDNDEuNzU1MiAzMC4xMzk0IDQ1LjYyMDQgMjYuOTg2OCA0Ny4xMzE2IDE2Ljc3MzJDNDcuMjUwNiAxNS45NjI0IDQ3LjE0OTkgMTUuNDUyMSA0Ny4xMzE2IDE0Ljc5NjFDNDcuMTIyNCAxNC4zOTUzIDQ3LjIxNCAxNC4yNDA1IDQ3LjY3MiAxNC4xOTQ4QzQ4LjkzNTkgMTQuMDQ5MSA1MC4xNjMyIDEzLjcwMjkgNTEuMjg5OCAxMy4wODMzQzU0LjU1OTYgMTEuMjk3NiA1NS44Nzg0IDguMzYzNzcgNTYuMTg5OCA0Ljg0NjkyQzU2LjIzNTcgNC4zMDkzMyA1Ni4xODA3IDMuNzUzNDIgNTUuNjEyOCAzLjQ3MTE5Wk0yNy4xMTkgMzUuMTIzQzIyLjIyODEgMzEuMjc4MyAxOS44NTYgMzAuMDExNyAxOC44NzU5IDMwLjA2NjRDMTcuOTYgMzAuMTIxMSAxOC4xMjQ5IDMxLjE2ODkgMTguMzI2MyAzMS44NTIzQzE4LjUzNyAzMi41MjY0IDE4LjgxMTggMzIuOTkxMiAxOS4xOTY0IDMzLjU4MzNDMTkuNDYyIDMzLjk3NTEgMTkuNjQ1MyAzNC41NTgxIDE4LjkzMDkgMzQuOTk1NkMxNy4zNTU1IDM1Ljk3MDUgMTQuNjE2OSAzNC42Njc1IDE0LjQ4ODYgMzQuNjAzOEMxMS4zMDE0IDMyLjcyNjggOC42MzYxMSAzMC4yNDg1IDYuNzU4NDIgMjYuODU5NEM0Ljk0NDk1IDIzLjU5NzQgMy44OTE3MiAyMC4wOTg5IDMuNzE3NjUgMTYuMzYzM0MzLjY3MTg4IDE1LjQ2MTQgMy45Mzc1IDE1LjE0MjMgNC44MzUwOCAxNC45Nzg1QzYuMDE2NiAxNC43NTk4IDcuMjM0NzQgMTQuNzE0MSA4LjQxNjI2IDE0Ljg4NzJDMTMuNDA4IDE1LjYxNjIgMTcuNjU3NyAxNy44NDg0IDIxLjIyMDYgMjEuMzgzNUMyMy4yNTM5IDIzLjM5NyAyNC43OTI2IDI1LjgwMjUgMjYuMzc3MiAyOC4xNTMxQzI4LjA2MjQgMzAuNjQ5NCAyOS44NzU5IDMzLjAyNzYgMzIuMTg0IDM0Ljk3NzNDMzIuOTk5MSAzNS42NjA2IDMzLjY0OTQgMzYuMTc5OSAzNC4yNzIyIDM2LjU2MjdDMzIuMzk0NyAzNi43NzIyIDI5LjI2MjIgMzYuODE3OSAyNy4xMTkgMzUuMTIzWk0yOS40NjM3IDIwLjA0NDJDMjkuNDYzNyAxOS42NDMzIDI5Ljc4NDMgMTkuMzI0NSAzMC4xODc0IDE5LjMyNDVDMzAuMjc4OSAxOS4zMjQ1IDMwLjM2MTMgMTkuMzQyNSAzMC40MzQ2IDE5LjM2OTlDMzAuNTM1NCAxOS40MDY1IDMwLjYyNyAxOS40NjEyIDMwLjcwMDIgMTkuNTQzQzMwLjgyODUgMTkuNjcwNyAzMC45MDE3IDE5Ljg1MjggMzAuOTAxNyAyMC4wNDQyQzMwLjkwMTcgMjAuNDQ1MSAzMC41ODEyIDIwLjc2MzkgMzAuMTc4MiAyMC43NjM5QzI5Ljc3NTEgMjAuNzYzOSAyOS40NjM3IDIwLjQ0NTEgMjkuNDYzNyAyMC4wNDQyWk0zNi43NDUyIDIzLjc3OThDMzYuMjc4MSAyMy45NzEyIDM1LjgxMSAyNC4xMzUgMzUuMzYyMiAyNC4xNTMzQzM0LjY2NjEgMjQuMTg5NyAzMy45MDU5IDIzLjkwNzIgMzMuNDkzOCAyMy41NjFDMzIuODUyNyAyMy4wMjM0IDMyLjM5NDcgMjIuNzIyOSAzMi4yMDIzIDIxLjc4NDRDMzIuMTE5OSAyMS4zODM1IDMyLjE2NTYgMjAuNzYzOSAzMi4yMzkgMjAuNDA4N0MzMi40MDM4IDE5LjY0MzMgMzIuMjIwNiAxOS4xNTE0IDMxLjY4MDMgMTguNzA0OEMzMS4yNDA2IDE4LjM0MDMgMzAuNjgxOSAxOC4yNDAyIDMwLjA2ODIgMTguMjQwMkMyOS44MzkyIDE4LjI0MDIgMjkuNjI4NyAxOC4xMzk5IDI5LjQ3MjkgMTguMDU3OUMyOS4yMTY0IDE3LjkzMDQgMjkuMDA1OSAxNy42MTE2IDI5LjIwNzMgMTcuMjE5N0MyOS4yNzE0IDE3LjA5MjMgMjkuNTgyOSAxNi43ODI1IDI5LjY1NjEgMTYuNzI3OEMzMC40ODk2IDE2LjI1MzkgMzEuNDUxMyAxNi40MDg5IDMyLjMzOTcgMTYuNzY0MkMzMy4xNjQxIDE3LjEwMTMgMzMuNzg2OSAxNy43MjA5IDM0LjY4NDQgMTguNTk1NUMzNS42MDAzIDE5LjY1MjMgMzUuNzY1MSAxOS45NDQxIDM2LjI4NzIgMjAuNzM2NkMzNi42OTk1IDIxLjM1NjIgMzcuMDc1IDIxLjk5MzkgMzcuMzMxNCAyMi43MjI5QzM3LjQ4NzEgMjMuMTc4NSAzNy4yODU2IDIzLjU1MiAzNi43NDUyIDIzLjc3OThaIiBmaWxsLXJ1bGU9Im5vbnplcm8iIGZpbGw9IiM0RDZCRkUiLz48L3N2Zz4=", "grok": "data:image/png;base64,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", "tavily": "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNTUiIGhlaWdodD0iNTUiIHZpZXdCb3g9IjAgMCA1NSA1NSIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHBhdGggZmlsbC1ydWxlPSJldmVub2RkIiBjbGlwLXJ1bGU9ImV2ZW5vZGQiIGQ9Ik0zOC44MDg4IDBDNDQuNDc2MiAwIDQ3LjMxMDEgOS4xODk1ZS0wNSA0OS40NzQ4IDEuMTAzMDZDNTEuMzc4OCAyLjA3MzI2IDUyLjkyNyAzLjYyMTM1IDUzLjg5NzEgNS41MjU0NEM1NS4wMDAxIDcuNjkwMTMgNTUgMTAuNTI0IDU1IDE2LjE5MTRWMzguODA4OEM1NSA0NC40NzYxIDU1LjAwMDEgNDcuMzA5OSA1My44OTcxIDQ5LjQ3NDZDNTIuOTI3IDUxLjM3ODYgNTEuMzc4OCA1Mi45MjY3IDQ5LjQ3NDggNTMuODk2OUM0Ny4zMTAxIDU0Ljk5OTkgNDQuNDc2MiA1NSAzOC44MDg4IDU1SDE2LjE5MTRDMTAuNTIzOSA1NSA3LjY5MDE0IDU0Ljk5OTkgNS41MjU0NCA1My44OTY5QzMuNjIxMzMgNTIuOTI2NyAyLjA3MzI1IDUxLjM3ODcgMS4xMDMwNiA0OS40NzQ2QzAuMDAwMTA5OTU4IDQ3LjMwOTkgMCA0NC40NzYyIDAgMzguODA4OFYxNi4xOTEyQzAgMTAuNTIzOCAwLjAwMDEwNzYxNCA3LjY5MDEyIDEuMTAzMDYgNS41MjU0NEMyLjA3MzI1IDMuNjIxMzMgMy42MjEzMyAyLjA3MzI2IDUuNTI1NDQgMS4xMDMwNkM3LjY5MDE0IDguODg0MzZlLTA1IDEwLjUyMzkgMCAxNi4xOTE0IDBIMzguODA4OFpNMjMuMzg2MyAzMC40MDVDMjMuMDg4NSAzMC40MDUgMjIuNzkzNCAzMC40NjM4IDIyLjUxODMgMzAuNTc4MkMyMi4yNDMzIDMwLjY5MjYgMjEuOTkzMyAzMC44NjAzIDIxLjc4MjcgMzEuMDcxNkwxNy40NTM0IDM1LjQxODhMMTYuMzAyOSAzNC4yNjM4QzE1LjQ1NzMgMzMuNDE1IDE0LjAwOTkgMzMuODM0NiAxMy43NDcxIDM1LjAwNjRMMTIuMTA3MyA0Mi4zMDIzQzEyLjA0OTggNDIuNTUzMiAxMi4wNTY4IDQyLjgxNDggMTIuMTI4IDQzLjA2MjFDMTIuMTk5IDQzLjMwODUgMTIuMzMxMyA0My41MzI3IDEyLjUxMjMgNDMuNzEzNkwxMi41MTA4IDQzLjcxNTlDMTIuNjkxNSA0My44OTg3IDEyLjkxNTUgNDQuMDMyMSAxMy4xNjE5IDQ0LjEwMzdDMTMuNDA4MyA0NC4xNzUyIDEzLjY2ODggNDQuMTgyNCAxMy45MTg4IDQ0LjEyNDZMMjEuMTg2MiA0Mi40Nzc2QzIyLjM1MjcgNDIuMjEzNyAyMi43NzE1IDQwLjc2MTQgMjEuOTI1OSAzOS45MTI0TDIwLjc3NTQgMzguNzU3NEwyNS4xMDU2IDM0LjQxMUMyNS41MzA2IDMzLjk4NDIgMjUuNzY5NSAzMy40MDQ5IDI1Ljc2OTUgMzIuODAxM0MyNS43Njk1IDMyLjE5NzcgMjUuNTMwNiAzMS42MTg1IDI1LjEwNTYgMzEuMTkxNkwyNS4wNDc2IDMxLjEzMzRMMjUuMDQ5NyAzMS4xMzE5TDI0Ljk4OTYgMzEuMDcxNkMyNC43NzkxIDMwLjg2MDMgMjQuNTI5IDMwLjY5MjYgMjQuMjU0IDMwLjU3ODJDMjMuOTc5IDMwLjQ2MzggMjMuNjg0IDMwLjQwNTEgMjMuMzg2MyAzMC40MDVaTTM5LjAwNTQgMjcuNjY2M0MzNy45OTQxIDI3LjAyNDUgMzYuNjc2OCAyNy43NTQ2IDM2LjY3NjYgMjguOTU1NlYzMC41ODg0SDI3LjM5ODFDMjcuNzA4MSAzMS4xODMyIDI3Ljg4NDcgMzEuODU5NiAyNy44ODQ3IDMyLjU3NzRDMjcuODg0NiAzMy42MTUyIDI3LjUxODEgMzQuNTY3MiAyNi45MDggMzUuMzA5OUwzNi42NzU4IDM1LjMwOTZMMzYuNjc1MiAzNi45NDI0QzM2LjY3NTMgMzguMTQzNCAzNy45OTQxIDM4Ljg3MzYgMzkuMDA1NCAzOC4yMzE5TDQ1LjMwNDUgMzQuMjM4N0M0NS43NzU3IDMzLjkzODQgNDYuMDExNCAzMy40NDMgNDYuMDExNSAzMi45NDhDNDYuMDEwOSAzMi40NTM2IDQ1Ljc3NTIgMzEuOTU5MiA0NS4zMDMgMzEuNjYwMUwzOS4wMDU0IDI3LjY2NjNaTTIzLjYxMDQgMTAuMjIwNkMyMy4zNTM5IDEwLjIxOTQgMjMuMTAxIDEwLjI4MzkgMjIuODc2MyAxMC40MDgxQzIyLjY1MTQgMTAuNTMyNSAyMi40NjE0IDEwLjcxMzIgMjIuMzI1MyAxMC45MzE4TDE4LjM0NzIgMTcuMjU0OUgxOC4zNDU4QzE3LjcwNjcgMTguMjcwMSAxOC40MzQ2IDE5LjU5MzMgMTkuNjMwNyAxOS41OTM2SDIxLjI1NzhWMjguOTg2OUMyMS45MzI3IDI4LjU0MDYgMjIuNzQwMyAyOC4yODAxIDIzLjYwOSAyOC4yODAxQzI0LjQ3ODEgMjguMjgwMSAyNS4yODY0IDI4LjU0MDcgMjUuOTYxNSAyOC45ODc1VjE5LjU5MzZIMjcuNTg4NEMyOC43ODQ5IDE5LjU5MzYgMjkuNTExMiAxOC4yNzAyIDI4Ljg3MjggMTcuMjU0MUwyNC44OTM5IDEwLjkzMThDMjQuNTk1MSAxMC40NTg0IDI0LjEwMjkgMTAuMjIxMiAyMy42MTA0IDEwLjIyMDZaIiBmaWxsPSIjMUYxRTFFIi8+Cjwvc3ZnPgo=", "tavilyDark": "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNTUiIGhlaWdodD0iNTUiIHZpZXdCb3g9IjAgMCA1NSA1NSIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHBhdGggZmlsbC1ydWxlPSJldmVub2RkIiBjbGlwLXJ1bGU9ImV2ZW5vZGQiIGQ9Ik0zOC44MDg4IDBDNDQuNDc2MiAwIDQ3LjMxMDEgOS4xODk1ZS0wNSA0OS40NzQ4IDEuMTAzMDZDNTEuMzc4OCAyLjA3MzI2IDUyLjkyNyAzLjYyMTM1IDUzLjg5NzEgNS41MjU0NEM1NS4wMDAxIDcuNjkwMTMgNTUgMTAuNTI0IDU1IDE2LjE5MTRWMzguODA4OEM1NSA0NC40NzYxIDU1LjAwMDEgNDcuMzA5OSA1My44OTcxIDQ5LjQ3NDZDNTIuOTI3IDUxLjM3ODYgNTEuMzc4OCA1Mi45MjY3IDQ5LjQ3NDggNTMuODk2OUM0Ny4zMTAxIDU0Ljk5OTkgNDQuNDc2MiA1NSAzOC44MDg4IDU1SDE2LjE5MTRDMTAuNTIzOSA1NSA3LjY5MDE0IDU0Ljk5OTkgNS41MjU0NCA1My44OTY5QzMuNjIxMzMgNTIuOTI2NyAyLjA3MzI1IDUxLjM3ODcgMS4xMDMwNiA0OS40NzQ2QzAuMDAwMTA5OTU4IDQ3LjMwOTkgMCA0NC40NzYyIDAgMzguODA4OFYxNi4xOTEyQzAgMTAuNTIzOCAwLjAwMDEwNzYxNCA3LjY5MDEyIDEuMTAzMDYgNS41MjU0NEMyLjA3MzI1IDMuNjIxMzMgMy42MjEzMyAyLjA3MzI2IDUuNTI1NDQgMS4xMDMwNkM3LjY5MDE0IDguODg0MzZlLTA1IDEwLjUyMzkgMCAxNi4xOTE0IDBIMzguODA4OFpNMjMuMzg2MyAzMC40MDVDMjMuMDg4NSAzMC40MDUgMjIuNzkzNCAzMC40NjM4IDIyLjUxODMgMzAuNTc4MkMyMi4yNDMzIDMwLjY5MjYgMjEuOTkzMyAzMC44NjAzIDIxLjc4MjcgMzEuMDcxNkwxNy40NTM0IDM1LjQxODhMMTYuMzAyOSAzNC4yNjM4QzE1LjQ1NzMgMzMuNDE1IDE0LjAwOTkgMzMuODM0NiAxMy43NDcxIDM1LjAwNjRMMTIuMTA3MyA0Mi4zMDIzQzEyLjA0OTggNDIuNTUzMiAxMi4wNTY4IDQyLjgxNDggMTIuMTI4IDQzLjA2MjFDMTIuMTk5IDQzLjMwODUgMTIuMzMxMyA0My41MzI3IDEyLjUxMjMgNDMuNzEzNkwxMi41MTA4IDQzLjcxNTlDMTIuNjkxNSA0My44OTg3IDEyLjkxNTUgNDQuMDMyMSAxMy4xNjE5IDQ0LjEwMzdDMTMuNDA4MyA0NC4xNzUyIDEzLjY2ODggNDQuMTgyNCAxMy45MTg4IDQ0LjEyNDZMMjEuMTg2MiA0Mi40Nzc2QzIyLjM1MjcgNDIuMjEzNyAyMi43NzE1IDQwLjc2MTQgMjEuOTI1OSAzOS45MTI0TDIwLjc3NTQgMzguNzU3NEwyNS4xMDU2IDM0LjQxMUMyNS41MzA2IDMzLjk4NDIgMjUuNzY5NSAzMy40MDQ5IDI1Ljc2OTUgMzIuODAxM0MyNS43Njk1IDMyLjE5NzcgMjUuNTMwNiAzMS42MTg1IDI1LjEwNTYgMzEuMTkxNkwyNS4wNDc2IDMxLjEzMzRMMjUuMDQ5NyAzMS4xMzE5TDI0Ljk4OTYgMzEuMDcxNkMyNC43NzkxIDMwLjg2MDMgMjQuNTI5IDMwLjY5MjYgMjQuMjU0IDMwLjU3ODJDMjMuOTc5IDMwLjQ2MzggMjMuNjg0IDMwLjQwNTEgMjMuMzg2MyAzMC40MDVaTTM5LjAwNTQgMjcuNjY2M0MzNy45OTQxIDI3LjAyNDUgMzYuNjc2OCAyNy43NTQ2IDM2LjY3NjYgMjguOTU1NlYzMC41ODg0SDI3LjM5ODFDMjcuNzA4MSAzMS4xODMyIDI3Ljg4NDcgMzEuODU5NiAyNy44ODQ3IDMyLjU3NzRDMjcuODg0NiAzMy42MTUyIDI3LjUxODEgMzQuNTY3MiAyNi45MDggMzUuMzA5OUwzNi42NzU4IDM1LjMwOTZMMzYuNjc1MiAzNi45NDI0QzM2LjY3NTMgMzguMTQzNCAzNy45OTQxIDM4Ljg3MzYgMzkuMDA1NCAzOC4yMzE5TDQ1LjMwNDUgMzQuMjM4N0M0NS43NzU3IDMzLjkzODQgNDYuMDExNCAzMy40NDMgNDYuMDExNSAzMi45NDhDNDYuMDEwOSAzMi40NTM2IDQ1Ljc3NTIgMzEuOTU5MiA0NS4zMDMgMzEuNjYwMUwzOS4wMDU0IDI3LjY2NjNaTTIzLjYxMDQgMTAuMjIwNkMyMy4zNTM5IDEwLjIxOTQgMjMuMTAxIDEwLjI4MzkgMjIuODc2MyAxMC40MDgxQzIyLjY1MTQgMTAuNTMyNSAyMi40NjE0IDEwLjcxMzIgMjIuMzI1MyAxMC45MzE4TDE4LjM0NzIgMTcuMjU0OUgxOC4zNDU4QzE3LjcwNjcgMTguMjcwMSAxOC40MzQ2IDE5LjU5MzMgMTkuNjMwNyAxOS41OTM2SDIxLjI1NzhWMjguOTg2OUMyMS45MzI3IDI4LjU0MDYgMjIuNzQwMyAyOC4yODAxIDIzLjYwOSAyOC4yODAxQzI0LjQ3ODEgMjguMjgwMSAyNS4yODY0IDI4LjU0MDcgMjUuOTYxNSAyOC45ODc1VjE5LjU5MzZIMjcuNTg4NEMyOC43ODQ5IDE5LjU5MzYgMjkuNTExMiAxOC4yNzAyIDI4Ljg3MjggMTcuMjU0MUwyNC44OTM5IDEwLjkzMThDMjQuNTk1MSAxMC40NTg0IDI0LjEwMjkgMTAuMjIxMiAyMy42MTA0IDEwLjIyMDZaIiBmaWxsPSIjRkZGQ0Y2Ii8+Cjwvc3ZnPgo=", "exa": "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTUxIiBoZWlnaHQ9IjE4MiIgdmlld0JveD0iMCAwIDE1MSAxODIiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CjxwYXRoIGQ9Ik0xNTAuNSAxNC4xMDY0QzE1MC41IDE0LjMzNTYgMTUwLjQyMSAxNC41NTc5IDE1MC4yNzcgMTQuNzM2TDg4LjQ3NjYgOTFMMTUwLjI3NyAxNjcuMjY0QzE1MC40MjEgMTY3LjQ0MiAxNTAuNSAxNjcuNjY0IDE1MC41IDE2Ny44OTRWMTgxQzE1MC41IDE4MS41NTIgMTUwLjA1MiAxODIgMTQ5LjUgMTgySDFDMC40NDc3MiAxODIgMCAxODEuNTUyIDAgMTgxVjAuOTk5OTk1QzAgMC40NDc3MSAwLjQ0NzcxNSAwIDEgMEgxNDkuNUMxNTAuMDUyIDAgMTUwLjUgMC40NDc3MTUgMTUwLjUgMVYxNC4xMDY0Wk0zMC40MDU5IDE2Mi43MTlIMTIxLjcyOEw3Ni4wNjY0IDEwNi4zMjZMMzAuNDA1OSAxNjIuNzE5Wk0xOS4yOTQ5IDEwMC4yNjFWMTQ1Ljc4N0w1Ni4xNTcyIDEwMC4yNjFIMTkuMjk0OVpNMTkuMjk0OSA4MC45ODAxSDU1LjU0MzRMMTkuMjk0OSAzNi4yMTIxVjgwLjk4MDFaTTc2LjA2NjQgNzUuNjczMUwxMjEuNzI4IDE5LjI4MUgzMC40MDU5TDc2LjA2NjQgNzUuNjczMVoiIGZpbGw9ImJsYWNrIi8+CjxwYXRoIGQ9Ik0xNTAuNSAxNC4xMDY0QzE1MC41IDE0LjMzNTYgMTUwLjQyMSAxNC41NTc5IDE1MC4yNzcgMTQuNzM2TDg4LjQ3NjYgOTFMMTUwLjI3NyAxNjcuMjY0QzE1MC40MjEgMTY3LjQ0MiAxNTAuNSAxNjcuNjY0IDE1MC41IDE2Ny44OTRWMTgxQzE1MC41IDE4MS41NTIgMTUwLjA1MiAxODIgMTQ5LjUgMTgySDFDMC40NDc3MiAxODIgMCAxODEuNTUyIDAgMTgxVjAuOTk5OTk1QzAgMC40NDc3MSAwLjQ0NzcxNSAwIDEgMEgxNDkuNUMxNTAuMDUyIDAgMTUwLjUgMC40NDc3MTUgMTUwLjUgMVYxNC4xMDY0Wk0zMC40MDU5IDE2Mi43MTlIMTIxLjcyOEw3Ni4wNjY0IDEwNi4zMjZMMzAuNDA1OSAxNjIuNzE5Wk0xOS4yOTQ5IDEwMC4yNjFWMTQ1Ljc4N0w1Ni4xNTcyIDEwMC4yNjFIMTkuMjk0OVpNMTkuMjk0OSA4MC45ODAxSDU1LjU0MzRMMTkuMjk0OSAzNi4yMTIxVjgwLjk4MDFaTTc2LjA2NjQgNzUuNjczMUwxMjEuNzI4IDE5LjI4MUgzMC40MDU5TDc2LjA2NjQgNzUuNjczMVoiIGZpbGw9IiMwMTQzRDkiLz4KPC9zdmc+Cg==", "exaDark": "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTUxIiBoZWlnaHQ9IjE4MiIgdmlld0JveD0iMCAwIDE1MSAxODIiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CjxwYXRoIGQ9Ik0xNTAuNSAxNC4xMDY0QzE1MC41IDE0LjMzNTYgMTUwLjQyMSAxNC41NTc5IDE1MC4yNzcgMTQuNzM2TDg4LjQ3NjYgOTFMMTUwLjI3NyAxNjcuMjY0QzE1MC40MjEgMTY3LjQ0MiAxNTAuNSAxNjcuNjY0IDE1MC41IDE2Ny44OTRWMTgxQzE1MC41IDE4MS41NTIgMTUwLjA1MiAxODIgMTQ5LjUgMTgySDFDMC40NDc3MiAxODIgMCAxODEuNTUyIDAgMTgxVjAuOTk5OTk1QzAgMC40NDc3MSAwLjQ0NzcxNSAwIDEgMEgxNDkuNUMxNTAuMDUyIDAgMTUwLjUgMC40NDc3MTUgMTUwLjUgMVYxNC4xMDY0Wk0zMC40MDU5IDE2Mi43MTlIMTIxLjcyOEw3Ni4wNjY0IDEwNi4zMjZMMzAuNDA1OSAxNjIuNzE5Wk0xOS4yOTQ5IDEwMC4yNjFWMTQ1Ljc4N0w1Ni4xNTcyIDEwMC4yNjFIMTkuMjk0OVpNMTkuMjk0OSA4MC45ODAxSDU1LjU0MzRMMTkuMjk0OSAzNi4yMTIxVjgwLjk4MDFaTTc2LjA2NjQgNzUuNjczMUwxMjEuNzI4IDE5LjI4MUgzMC40MDU5TDc2LjA2NjQgNzUuNjczMVoiIGZpbGw9ImJsYWNrIi8+CjxwYXRoIGQ9Ik0xNTAuNSAxNC4xMDY0QzE1MC41IDE0LjMzNTYgMTUwLjQyMSAxNC41NTc5IDE1MC4yNzcgMTQuNzM2TDg4LjQ3NjYgOTFMMTUwLjI3NyAxNjcuMjY0QzE1MC40MjEgMTY3LjQ0MiAxNTAuNSAxNjcuNjY0IDE1MC41IDE2Ny44OTRWMTgxQzE1MC41IDE4MS41NTIgMTUwLjA1MiAxODIgMTQ5LjUgMTgySDFDMC40NDc3MiAxODIgMCAxODEuNTUyIDAgMTgxVjAuOTk5OTk1QzAgMC40NDc3MSAwLjQ0NzcxNSAwIDEgMEgxNDkuNUMxNTAuMDUyIDAgMTUwLjUgMC40NDc3MTUgMTUwLjUgMVYxNC4xMDY0Wk0zMC40MDU5IDE2Mi43MTlIMTIxLjcyOEw3Ni4wNjY0IDEwNi4zMjZMMzAuNDA1OSAxNjIuNzE5Wk0xOS4yOTQ5IDEwMC4yNjFWMTQ1Ljc4N0w1Ni4xNTcyIDEwMC4yNjFIMTkuMjk0OVpNMTkuMjk0OSA4MC45ODAxSDU1LjU0MzRMMTkuMjk0OSAzNi4yMTIxVjgwLjk4MDFaTTc2LjA2NjQgNzUuNjczMUwxMjEuNzI4IDE5LjI4MUgzMC40MDU5TDc2LjA2NjQgNzUuNjczMVoiIGZpbGw9IndoaXRlIi8+Cjwvc3ZnPgo=", "tinyfish": "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjIxIiBoZWlnaHQ9IjIwNyIgdmlld0JveD0iMCAwIDIyMSAyMDciIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CjxwYXRoIGQ9Ik01NS45MTczIDg1LjE4MzhDNDkuNDc0OSA3Mi45Njc0IDM1LjIzMzggNTAuOTM3MyAxNi4yNjUgNTEuMTY5OEMtOS45NTk5MiA1MS40Nzk4IDIwLjU2NjQgMTEwLjczMSAyMC41NjY0IDExMC43MzFDMjAuNTY2NCAxMTAuNzMxIC00LjE4NTk4IDE1OS4yNTcgMTcuMzk4NSAxNjQuMzgyQzM4Ljk4MyAxNjkuNTA3IDU3LjE5NjEgMTM5LjA5NyA1Ny4xOTYxIDEzOS4wOTciIGZpbGw9IiNGRjY3MDAiLz4KPHBhdGggZD0iTTE2MC42NzggMTg3LjQ5NEMxNzEuMTg4IDE3Ny4xNTkgMTc0LjQ1NiAxNjMuNDM5IDE2Ny45NzcgMTU2Ljg1MUMxNjEuNDk4IDE1MC4yNjMgMTQ3LjcyNiAxNTMuMyAxMzcuMjE2IDE2My42MzZDMTI2LjcwNiAxNzMuOTcxIDEyMy40MzggMTg3LjY5MSAxMjkuOTE3IDE5NC4yNzlDMTM2LjM5NSAyMDAuODY3IDE1MC4xNjggMTk3LjgzIDE2MC42NzggMTg3LjQ5NFoiIGZpbGw9ImJsYWNrIi8+CjxwYXRoIGQ9Ik0xNjAuNjc4IDE4Ny40OTRDMTcxLjE4OCAxNzcuMTU5IDE3NC40NTYgMTYzLjQzOSAxNjcuOTc3IDE1Ni44NTFDMTYxLjQ5OCAxNTAuMjYzIDE0Ny43MjYgMTUzLjMgMTM3LjIxNiAxNjMuNjM2QzEyNi43MDYgMTczLjk3MSAxMjMuNDM4IDE4Ny42OTEgMTI5LjkxNyAxOTQuMjc5QzEzNi4zOTUgMjAwLjg2NyAxNTAuMTY4IDE5Ny44MyAxNjAuNjc4IDE4Ny40OTRaIiBmaWxsPSJibGFjayIgZmlsbC1vcGFjaXR5PSIwLjIiLz4KPHBhdGggZD0iTTE3MS41MzQgNTUuNjIwM0MxNzEuNTM0IDU1LjYyMDMgMTUzLjk1IDIxLjg0ODUgMTE1LjI1NyA2LjczNTQ5Qzk2LjY0NjYgLTAuNTMwMzg0IDg5LjA5MDEgMTAuODA0NCA5OS44MTQ1IDI1LjA2NDlDMTEzLjQ4NCA0My4yMjk1IDYxLjY3MzYgNy40NjIwNyA5NC45MzE5IDY2LjU3NzJMMTcxLjU0MyA1NS42MjAzSDE3MS41MzRaIiBmaWxsPSIjRkY2NzAwIi8+CjxwYXRoIGQ9Ik0xNDIuMTMxIDQyLjE1NjRMMTU4Ljc0NiAzNy4yMjUzTDEzMC4zNTEgMTQuMDgxMUwxMDQuMTM1IDQuNDgwNDdMOTUuMTkzNCAxMC42OTA0Qzk1LjE5MzQgMTAuNjkwNCAxMzMuMTIxIDIzLjMyMzMgMTQyLjEzMSA0Mi4xNTY0WiIgZmlsbD0iI0ZFQ0I4QiIvPgo8cGF0aCBkPSJNMTY2Ljg5MSA1My4yMzk3QzE2Ni4wNjggNTQuNDIxNiAxNjYuMDc4IDU2LjYxMTEgMTY2LjgxNCA1Ny42ODY0TDE2Ni44MDQgNTcuNjQ3N0wxNjYuNzQ2IDU3LjUwMjNDMTY0LjMzNCA1MS4xNTY4IDE2MC40NzggNDUuNDMxMyAxNTYuMTY3IDQwLjE5OTlDMTQ2LjQzMSAyOC44MDcgMTM0LjEwOCAxOS42MDM2IDEyMC41MTYgMTMuMzkzN0MxMTUuNTI2IDExLjM5OCAxMDkuNDYyIDguNTMwMzcgMTA0LjI2OSA5LjAwNTA3Qzk4LjI4MjEgOS4zMTUwOCA5OS4zMDkgMTQuMjA3NCAxMDEuNTA4IDE4LjE5ODhDMTA0LjAyNyAyMi43MjMgMTEwLjI2NiAyNy43ODk4IDEwNi4zMjMgMzMuNDY2OEMxMDIuODk0IDM4LjExNyA5Ni4xMDI0IDM1Ljc1MzIgOTEuNjM2MyAzNi4wNDM4QzkwLjI5OTQgMzYuMDYzMiA4OS4zMTEyIDM2LjQzMTMgODkuMzg4NyAzNi40OTkxQzg5LjM5ODQgMzYuNTI4MiA4OS41NTM0IDM2LjM4MjkgODkuNTYzMSAzNi4zNzMyQzg5LjEwNzggNDAuNTI5MyA5MS40ODEzIDQ1LjUyODIgOTMuMDg5NSA0OS41NTgzQzkzLjU5MzIgNTAuNzQwMiA5NC42MjAxIDUzLjEzMzEgOTUuMTYyNyA1NC4zMDU0Qzk2LjU5NjQgNTcuNDkyNyA5OC4wODg0IDYwLjcwOSA5OS40NzM3IDY0LjAyMjJMOTQuMTkzOSA2MS40MTYyQzExOC41NzggNTcuODIyIDE0Mi4yMDcgNTUuNTQ1NCAxNjYuOTAxIDUzLjIzOTdIMTY2Ljg5MVpNMTc2LjE3MiA1OC4wMDYxQzE0OS44MTIgNjMuMDM0MSAxMjIuMzU2IDY4LjAzMyA5NS42Mjc3IDcxLjc0MzRDOTMuNDQ3OSA3Mi4wNTM1IDkxLjM4NDQgNzAuOTM5NCA5MC4zNzY5IDY5LjEyNzdDODQuODM1NCA2MS4xNzQgODAuMjYyOCA1Mi40NzQ0IDc4LjIxODYgNDIuNzk2MkM3NS41MDYgMjguNDAwMSA4NC4xNDc2IDIyLjg3OCA5Ny41MzYyIDI1LjI0MTlDOTguMzg4NyAyNS4zNDg0IDk5LjIxMjIgMjUuNDM1NiA5OS42ODY5IDI1LjQ0NTNDOTkuOSAyNS40NjQ3IDEwMC4wMzYgMjUuNDE2MyA5OS42NzcyIDI1LjUxMzFDOTguMDY5IDI1Ljk4NzggOTYuNzcwOCAyNy43MjIgOTYuNzcwOCAyOS40MTczQzk2Ljc0MTggMjkuNzQ2NyA5Ni43OTk5IDMwLjEyNDUgOTYuOTA2NSAzMC40MTUyQzk1LjcwNTIgMjcuOTY0MiA5My41NTQ1IDI1LjU1MTkgOTIuNDAxNiAyMi44MTAyQzkwLjM0NzggMTguNDIxNiA4OS4wNzg3IDEzLjQ3MTIgOTAuODYxMyA4LjQwNDQyQzk0Ljc2NTUgLTIuMDU4NDMgMTA3LjkyMiAtMS4wNjA1OCAxMTYuMjA1IDIuNTgyMDRDMTE4Ljc5MSAzLjY2NzA4IDEyMS40NDYgNS4wMDQgMTIzLjk4NCA2LjE0NzE2QzEyNi4yNyA3LjQ2NDcxIDEyOS4xNzcgOC45MTc4OCAxMzEuNDA1IDEwLjI5MzZMMTM2LjE4MSAxMy4zMTYyQzE0OC43MzYgMjEuNjU3NCAxNTkuMjY3IDMyLjU3NTYgMTY4Ljg3NyA0NC4wODQ3QzE3MC42OTkgNDYuMTg3IDE3Mi41NTkgNDguNTg5NSAxNzQuMzAzIDUwLjc2OTNMMTc1LjIxMyA1MS45MzE4TDE3NS42NjkgNTIuNTMyNUwxNzUuNzg1IDUyLjY4NzVDMTc2Ljc0NCA1NC4xMjEzIDE3Ni44NyA1Ni40MzY3IDE3Ni4xODIgNTcuOTk2NEwxNzYuMTcyIDU4LjAwNjFaIiBmaWxsPSJibGFjayIvPgo8cGF0aCBkPSJNMTY2Ljg5MSA1My4yMzk3QzE2Ni4wNjggNTQuNDIxNiAxNjYuMDc4IDU2LjYxMTEgMTY2LjgxNCA1Ny42ODY0TDE2Ni44MDQgNTcuNjQ3N0wxNjYuNzQ2IDU3LjUwMjNDMTY0LjMzNCA1MS4xNTY4IDE2MC40NzggNDUuNDMxMyAxNTYuMTY3IDQwLjE5OTlDMTQ2LjQzMSAyOC44MDcgMTM0LjEwOCAxOS42MDM2IDEyMC41MTYgMTMuMzkzN0MxMTUuNTI2IDExLjM5OCAxMDkuNDYyIDguNTMwMzcgMTA0LjI2OSA5LjAwNTA3Qzk4LjI4MjEgOS4zMTUwOCA5OS4zMDkgMTQuMjA3NCAxMDEuNTA4IDE4LjE5ODhDMTA0LjAyNyAyMi43MjMgMTEwLjI2NiAyNy43ODk4IDEwNi4zMjMgMzMuNDY2OEMxMDIuODk0IDM4LjExNyA5Ni4xMDI0IDM1Ljc1MzIgOTEuNjM2MyAzNi4wNDM4QzkwLjI5OTQgMzYuMDYzMiA4OS4zMTEyIDM2LjQzMTMgODkuMzg4NyAzNi40OTkxQzg5LjM5ODQgMzYuNTI4MiA4OS41NTM0IDM2LjM4MjkgODkuNTYzMSAzNi4zNzMyQzg5LjEwNzggNDAuNTI5MyA5MS40ODEzIDQ1LjUyODIgOTMuMDg5NSA0OS41NTgzQzkzLjU5MzIgNTAuNzQwMiA5NC42MjAxIDUzLjEzMzEgOTUuMTYyNyA1NC4zMDU0Qzk2LjU5NjQgNTcuNDkyNyA5OC4wODg0IDYwLjcwOSA5OS40NzM3IDY0LjAyMjJMOTQuMTkzOSA2MS40MTYyQzExOC41NzggNTcuODIyIDE0Mi4yMDcgNTUuNTQ1NCAxNjYuOTAxIDUzLjIzOTdIMTY2Ljg5MVpNMTc2LjE3MiA1OC4wMDYxQzE0OS44MTIgNjMuMDM0MSAxMjIuMzU2IDY4LjAzMyA5NS42Mjc3IDcxLjc0MzRDOTMuNDQ3OSA3Mi4wNTM1IDkxLjM4NDQgNzAuOTM5NCA5MC4zNzY5IDY5LjEyNzdDODQuODM1NCA2MS4xNzQgODAuMjYyOCA1Mi40NzQ0IDc4LjIxODYgNDIuNzk2MkM3NS41MDYgMjguNDAwMSA4NC4xNDc2IDIyLjg3OCA5Ny41MzYyIDI1LjI0MTlDOTguMzg4NyAyNS4zNDg0IDk5LjIxMjIgMjUuNDM1NiA5OS42ODY5IDI1LjQ0NTNDOTkuOSAyNS40NjQ3IDEwMC4wMzYgMjUuNDE2MyA5OS42NzcyIDI1LjUxMzFDOTguMDY5IDI1Ljk4NzggOTYuNzcwOCAyNy43MjIgOTYuNzcwOCAyOS40MTczQzk2Ljc0MTggMjkuNzQ2NyA5Ni43OTk5IDMwLjEyNDUgOTYuOTA2NSAzMC40MTUyQzk1LjcwNTIgMjcuOTY0MiA5My41NTQ1IDI1LjU1MTkgOTIuNDAxNiAyMi44MTAyQzkwLjM0NzggMTguNDIxNiA4OS4wNzg3IDEzLjQ3MTIgOTAuODYxMyA4LjQwNDQyQzk0Ljc2NTUgLTIuMDU4NDMgMTA3LjkyMiAtMS4wNjA1OCAxMTYuMjA1IDIuNTgyMDRDMTE4Ljc5MSAzLjY2NzA4IDEyMS40NDYgNS4wMDQgMTIzLjk4NCA2LjE0NzE2QzEyNi4yNyA3LjQ2NDcxIDEyOS4xNzcgOC45MTc4OCAxMzEuNDA1IDEwLjI5MzZMMTM2LjE4MSAxMy4zMTYyQzE0OC43MzYgMjEuNjU3NCAxNTkuMjY3IDMyLjU3NTYgMTY4Ljg3NyA0NC4wODQ3QzE3MC42OTkgNDYuMTg3IDE3Mi41NTkgNDguNTg5NSAxNzQuMzAzIDUwLjc2OTNMMTc1LjIxMyA1MS45MzE4TDE3NS42NjkgNTIuNTMyNUwxNzUuNzg1IDUyLjY4NzVDMTc2Ljc0NCA1NC4xMjEzIDE3Ni44NyA1Ni40MzY3IDE3Ni4xODIgNTcuOTk2NEwxNzYuMTcyIDU4LjAwNjFaIiBmaWxsPSJibGFjayIgZmlsbC1vcGFjaXR5PSIwLjIiLz4KPHBhdGggZD0iTTU3LjE4ODkgMTM5LjA3N0w1Ny40MzExIDEzNC41OTFDNzMuMzI4OSAxNTUuMTM5IDEwNC41MzMgMTc0LjQwOCAxMzUuODE1IDE3NC40MDhDMTgwLjQ4NiAxNzQuNDA4IDIxNi42OTkgMTQ0LjEzNCAyMTYuNjk5IDEwNi43OTdDMjE2LjY5OSA2OS40NiAxODAuNDg2IDM5LjE4NTUgMTM1LjgxNSAzOS4xODU1QzEwNS4zNjcgMzkuMTg1NSA3MS43ODg1IDYyLjQzNjMgNTUuOTEwMiA4NS4xODM0IiBmaWxsPSIjRkVDQjhCIi8+CjxwYXRoIGQ9Ik0xMzIuODA1IDE1OS44MTRDMTQwLjk0MiAxNjQuMjAzIDE1OC4zMjIgMTY1Ljk5NSAxNzEuMzA0IDE2My4yMDVDMTgzLjEzMyAxNjAuNjU3IDE1OS4xNDYgMTc3LjI3MiAxMzMuOTQ4IDE3Ni41MzZMMTMyLjgxNCAxNTkuODE0SDEzMi44MDVaIiBmaWxsPSIjRkY2NzAwIi8+CjxwYXRoIGQ9Ik00NS4zMTA0IDk0LjI4MzZDMzMuMjE5OSA2Ny45MzI3IDE1LjI4NzggNTguNjMyNCAxMC45MDg5IDcwLjA4MzVDOC4yMTU2NiAyOS4wMTY3IDQzLjI5NTMgNjcuMTk2NSA1MC4yMDI3IDgzLjAzNjFMNDUuMzEwNCA5NC4yODM2WiIgZmlsbD0iI0ZFQ0I4QiIvPgo8cGF0aCBkPSJNMjAuMjE4OCAxNTkuNjA3QzM4LjA0NDQgMTU5LjAyNSA0NS45MzAyIDEzMS4zNDcgNDUuODYyNCAxMjIuMzA5TDU1Ljg3IDEzOC4yMDZDNDQuODM1NSAxNTMuMDU4IDMzLjA1NTEgMTYxLjE2NiAyMC4yMTg4IDE1OS42MDdaIiBmaWxsPSJibGFjayIvPgo8cGF0aCBkPSJNMjAuMjE4OCAxNTkuNjA3QzM4LjA0NDQgMTU5LjAyNSA0NS45MzAyIDEzMS4zNDcgNDUuODYyNCAxMjIuMzA5TDU1Ljg3IDEzOC4yMDZDNDQuODM1NSAxNTMuMDU4IDMzLjA1NTEgMTYxLjE2NiAyMC4yMTg4IDE1OS42MDdaIiBmaWxsPSJibGFjayIgZmlsbC1vcGFjaXR5PSIwLjIiLz4KPHBhdGggZD0iTTUyLjUwMjggMTE5Ljk4N0M1NS45ODA3IDEyMy40MzYgNDUuMzYyOSAxMDQuODg0IDUxLjI4MjEgOTIuNzU0NEM4MS42NDM4IDMwLjYwNyAxNDguMzkzIDM5LjgxMDUgMTQyLjEyNSA0Mi4xNTQ5QzkwLjI0NjYgNjEuNTc5IDg1LjM1NDIgMTE3LjM5MSAxMTEuMTYzIDE1Mi43OEw5Mi45MDExIDE2MC44MTFDODMuNzU1NyAxNjEuOTU1IDQ5LjQ4MDIgMTMyLjgwNCA1Mi40OTMxIDExOS45OTdMNTIuNTAyOCAxMTkuOTg3WiIgZmlsbD0iI0ZGNjcwMCIvPgo8cGF0aCBkPSJNNjEuNjYzNyAxNDEuNzY5QzUyLjQ2MDMgMTU2IDM3LjI2MDEgMTcyLjE5OSAxOC42NDk4IDE2OS45MTJDMTEuOTg0NiAxNjkuMDc5IDYuNDA0MzcgMTY1LjE1NSA0LjQwODY3IDE1OC4xNDFDMC4yOTEzNDcgMTQzLjQwNiA5LjU3MjI5IDEyMS42NTcgMTUuOTE3OCAxMDguMzU2QzE1LjkxNzggMTA4LjM1NiAxNS45Mjc1IDExMy4xMzIgMTUuOTE3OCAxMTMuMTEyQzkuMDg3OSA5OC42OTcgLTEuNTc4NCA3NC41MDY1IDEuNDA1NDUgNTguNTg5NEMzLjk0MzY2IDQ2LjA5MjEgMTYuMDE0NyA0NC42ODczIDI2LjEzODUgNDguMjIzNEMzNy4wNDcgNTIuMTM3MyA0NC44ODQ0IDYwLjU5NDcgNTEuMzM2NSA2OS41NzU0QzU0LjQyNjkgNzMuOTYzOSA1Ny4xNDkyIDc4LjUzNjYgNTkuNTkwNSA4My4yNDQ5QzYxLjk0NDcgODguMTg1NyA1NC45NTk4IDkxLjgxODYgNTIuMjQ3MiA4Ny4xMkM0NS41MjM4IDc1LjEwNzEgMzYuNTQzMiA2MS42NTA3IDIzLjI0MTggNTYuODU1MkMxOS4zNDczIDU1LjU0NzQgMTQuMTI1NiA1NS4zOTI0IDEyLjYwNDYgNTYuODM1OUM3Ljg0Nzg1IDYxLjI2MzIgMTEuOTE2NyA3NC45MjMgMTMuNjcwMiA4MC44MjI5QzE2LjY1NDEgOTAuMTkxMSAyMC43NDI0IDk5LjYwNzYgMjUuMTk4OCAxMDguMzQ2QzI1Ljk5MzIgMTA5Ljg5NiAyNS45NDQ3IDExMS42NTkgMjUuMjA4NCAxMTMuMTAzQzIxLjM5MTQgMTIwLjg4MiAxNy45OTEgMTI5LjMwMSAxNS43NDM0IDEzNy42NjFDMTQuMzI5IDE0My40NzQgMTEuNjM1OCAxNTQuNDg5IDE2LjU5NiAxNTguNDgxQzE5LjE3MjkgMTU5LjkxNCAyMi4zODkzIDE1OS45MzQgMjUuMzE1IDE1OS40NjlDMzUuMDgwMyAxNTcuNTk5IDQzLjA4MjUgMTQ5LjMzNSA0OS4xMTggMTQxLjU3NUM1MC4zNTggMTM5Ljk0OCA1MS42NzU2IDEzOC4wNzggNTIuNzQxMyAxMzYuMzU0QzU2LjUwOTggMTMwLjU4IDY1LjA0NDggMTM1Ljc0MyA2MS42NTQxIDE0MS43NjlINjEuNjYzN1oiIGZpbGw9ImJsYWNrIi8+CjxwYXRoIGQ9Ik02MS42NjM3IDE0MS43NjlDNTIuNDYwMyAxNTYgMzcuMjYwMSAxNzIuMTk5IDE4LjY0OTggMTY5LjkxMkMxMS45ODQ2IDE2OS4wNzkgNi40MDQzNyAxNjUuMTU1IDQuNDA4NjcgMTU4LjE0MUMwLjI5MTM0NyAxNDMuNDA2IDkuNTcyMjkgMTIxLjY1NyAxNS45MTc4IDEwOC4zNTZDMTUuOTE3OCAxMDguMzU2IDE1LjkyNzUgMTEzLjEzMiAxNS45MTc4IDExMy4xMTJDOS4wODc5IDk4LjY5NyAtMS41Nzg0IDc0LjUwNjUgMS40MDU0NSA1OC41ODk0QzMuOTQzNjYgNDYuMDkyMSAxNi4wMTQ3IDQ0LjY4NzMgMjYuMTM4NSA0OC4yMjM0QzM3LjA0NyA1Mi4xMzczIDQ0Ljg4NDQgNjAuNTk0NyA1MS4zMzY1IDY5LjU3NTRDNTQuNDI2OSA3My45NjM5IDU3LjE0OTIgNzguNTM2NiA1OS41OTA1IDgzLjI0NDlDNjEuOTQ0NyA4OC4xODU3IDU0Ljk1OTggOTEuODE4NiA1Mi4yNDcyIDg3LjEyQzQ1LjUyMzggNzUuMTA3MSAzNi41NDMyIDYxLjY1MDcgMjMuMjQxOCA1Ni44NTUyQzE5LjM0NzMgNTUuNTQ3NCAxNC4xMjU2IDU1LjM5MjQgMTIuNjA0NiA1Ni44MzU5QzcuODQ3ODUgNjEuMjYzMiAxMS45MTY3IDc0LjkyMyAxMy42NzAyIDgwLjgyMjlDMTYuNjU0MSA5MC4xOTExIDIwLjc0MjQgOTkuNjA3NiAyNS4xOTg4IDEwOC4zNDZDMjUuOTkzMiAxMDkuODk2IDI1Ljk0NDcgMTExLjY1OSAyNS4yMDg0IDExMy4xMDNDMjEuMzkxNCAxMjAuODgyIDE3Ljk5MSAxMjkuMzAxIDE1Ljc0MzQgMTM3LjY2MUMxNC4zMjkgMTQzLjQ3NCAxMS42MzU4IDE1NC40ODkgMTYuNTk2IDE1OC40ODFDMTkuMTcyOSAxNTkuOTE0IDIyLjM4OTMgMTU5LjkzNCAyNS4zMTUgMTU5LjQ2OUMzNS4wODAzIDE1Ny41OTkgNDMuMDgyNSAxNDkuMzM1IDQ5LjExOCAxNDEuNTc1QzUwLjM1OCAxMzkuOTQ4IDUxLjY3NTYgMTM4LjA3OCA1Mi43NDEzIDEzNi4zNTRDNTYuNTA5OCAxMzAuNTggNjUuMDQ0OCAxMzUuNzQzIDYxLjY1NDEgMTQxLjc2OUg2MS42NjM3WiIgZmlsbD0iYmxhY2siIGZpbGwtb3BhY2l0eT0iMC4yIi8+CjxwYXRoIGQ9Ik00Ny4xMzE0IDkwLjU4ODlDNjIuNTkzMSA2Mi43NzUyIDk2LjYyNjUgMzkuMDEwOSAxMjguMjk2IDM1LjI4MTFDMTYxLjc5NyAzMi4yNzc5IDE5OC4zNDkgNDguNDI3NSAyMTMuODQgNzkuMzEyM0MyMzMuMDEyIDExOC40NzEgMjA4LjI1IDE1OS43NSAxNjkuNzExIDE3My45MTRDMTU2LjQ4OCAxNzguOTAzIDE0Mi4xOTggMTgwLjc5MiAxMjguMTUxIDE3OS42MkMxMDIuMSAxNzYuODQgNzcuNjA5MyAxNjMuNzIyIDYwLjAxNjIgMTQ0LjQ5MkM1OC41NjMgMTQzLjAxIDU2LjY3MzkgMTQwLjUxIDU1LjM0NjYgMTM4LjkwMkM1MS41NzgxIDEzNC4wNTggNDguNDU4NiAxMjguNzU5IDQ2LjA5NDggMTIyLjk4NUM0NS4yOTA3IDEyMS4wODYgNDYuMTgyIDExOC44OTcgNDguMDgwOCAxMTguMDkzQzQ5Ljg5MjQgMTE3LjMyNyA1MS45NjU2IDExOC4wOTMgNTIuODQ3MiAxMTkuODE3QzU2Ljc2MTEgMTI3LjUwOSA2Mi40MzgxIDEzNC40NzUgNjkuMDA2NSAxNDAuNDgxQzg4LjA3MjEgMTU3LjkyOSAxMTQuMzQ2IDE3MC4wNzggMTQwLjUwMyAxNjguNzAyQzE3NC40MSAxNjcuNTk3IDIxMS45NSAxNDQuNTIxIDIxMi45NTggMTA3LjY2OUMyMTMuODQ5IDcwLjMxMjMgMTc2LjgwMyA0NS4yNDAyIDE0Mi4zNDMgNDMuNjk5OUMxMjQuODA4IDQyLjEzMDQgMTA3LjU0NSA0OC4zNzkxIDkyLjQwMjYgNTcuNzE4MUM3Ny42Mjg2IDY3LjAyODEgNjMuNjY4NSA3OS42MjIzIDU1LjQxNDUgOTQuOTg3MkM1Mi4zNTMxIDEwMC4zODMgNDQuMzg5NyA5Ni4xNzg4IDQ3LjE1MDcgOTAuNTk4Nkw0Ny4xMzE0IDkwLjU4ODlaIiBmaWxsPSJibGFjayIvPgo8cGF0aCBkPSJNNDcuMTMxNCA5MC41ODg5QzYyLjU5MzEgNjIuNzc1MiA5Ni42MjY1IDM5LjAxMDkgMTI4LjI5NiAzNS4yODExQzE2MS43OTcgMzIuMjc3OSAxOTguMzQ5IDQ4LjQyNzUgMjEzLjg0IDc5LjMxMjNDMjMzLjAxMiAxMTguNDcxIDIwOC4yNSAxNTkuNzUgMTY5LjcxMSAxNzMuOTE0QzE1Ni40ODggMTc4LjkwMyAxNDIuMTk4IDE4MC43OTIgMTI4LjE1MSAxNzkuNjJDMTAyLjEgMTc2Ljg0IDc3LjYwOTMgMTYzLjcyMiA2MC4wMTYyIDE0NC40OTJDNTguNTYzIDE0My4wMSA1Ni42NzM5IDE0MC41MSA1NS4zNDY2IDEzOC45MDJDNTEuNTc4MSAxMzQuMDU4IDQ4LjQ1ODYgMTI4Ljc1OSA0Ni4wOTQ4IDEyMi45ODVDNDUuMjkwNyAxMjEuMDg2IDQ2LjE4MiAxMTguODk3IDQ4LjA4MDggMTE4LjA5M0M0OS44OTI0IDExNy4zMjcgNTEuOTY1NiAxMTguMDkzIDUyLjg0NzIgMTE5LjgxN0M1Ni43NjExIDEyNy41MDkgNjIuNDM4MSAxMzQuNDc1IDY5LjAwNjUgMTQwLjQ4MUM4OC4wNzIxIDE1Ny45MjkgMTE0LjM0NiAxNzAuMDc4IDE0MC41MDMgMTY4LjcwMkMxNzQuNDEgMTY3LjU5NyAyMTEuOTUgMTQ0LjUyMSAyMTIuOTU4IDEwNy42NjlDMjEzLjg0OSA3MC4zMTIzIDE3Ni44MDMgNDUuMjQwMiAxNDIuMzQzIDQzLjY5OTlDMTI0LjgwOCA0Mi4xMzA0IDEwNy41NDUgNDguMzc5MSA5Mi40MDI2IDU3LjcxODFDNzcuNjI4NiA2Ny4wMjgxIDYzLjY2ODUgNzkuNjIyMyA1NS40MTQ1IDk0Ljk4NzJDNTIuMzUzMSAxMDAuMzgzIDQ0LjM4OTcgOTYuMTc4OCA0Ny4xNTA3IDkwLjU5ODZMNDcuMTMxNCA5MC41ODg5WiIgZmlsbD0iYmxhY2siIGZpbGwtb3BhY2l0eT0iMC4yIi8+CjxwYXRoIGQ9Ik0xMTkuMTA3IDE5MC40MkMxMzIuMTQ0IDE4MS43MTUgMTM4LjI3NyAxNjguMDE0IDEzMi44MDUgMTU5LjgxN0MxMjcuMzMyIDE1MS42MjEgMTEyLjMyNyAxNTIuMDMzIDk5LjI4ODcgMTYwLjczOEM4Ni4yNTA5IDE2OS40NDMgODAuMTE4IDE4My4xNDUgODUuNTkwNiAxOTEuMzQxQzkxLjA2MzIgMTk5LjUzNyAxMDYuMDY5IDE5OS4xMjUgMTE5LjEwNyAxOTAuNDJaIiBmaWxsPSIjRkVDQjhCIi8+CjxwYXRoIGQ9Ik0xMzMuNjM3IDE2NC40MzNDMTMyLjY1OSAxNjIuMzk5IDEzMS4wMjEgMTU4LjA5OCAxMjkuMDM1IDE1Ni44NjdDMTMxLjExOCAxNjUuMjI4IDEyMy40NzQgMTc3LjQ3MyAxMTAuOTU4IDE4My41MjhDMTAwLjU3MiAxODguNTQ2IDkwLjcyOTYgMTg0LjMxMyA4Ny40NjQ4IDE3NS4wMDNDODcuNjQ4OSAxNzUuNzM5IDg0LjAxNiAxODcuNTc4IDg0LjM0NTQgMTg4LjI2NUM4OC40ODIxIDE5Ni44MiAxMDIuODY4IDE5OC40MTggMTE2LjQ3IDE5MS44NEMxMzAuMDgyIDE4NS4yNjIgMTM3Ljc2NCAxNzIuOTg4IDEzMy42MjcgMTY0LjQzM0gxMzMuNjM3WiIgZmlsbD0iI0ZGNjcwMCIvPgo8cGF0aCBkPSJNMTEyLjIwNyAxNTYuMjYyQzEwNC4zMTEgMTYxLjY1OSA5Ni4zNzY3IDE2Ny45MTcgOTIuMDA3NSAxNzYuMTgxQzg4LjY1NTUgMTgyLjcxIDg3LjY3NyAxOTAuMTg5IDk2Ljc0NDggMTkxLjM2MUMxMDMuMTY4IDE5Mi4xNTYgMTA5Ljk1OSAxODkuODg5IDExNS42MDcgMTg2LjcxMUMxMjEuNTc1IDE4My4zODggMTI2LjI3MyAxNzguMTA5IDEyOC43NzMgMTcxLjcwNUMxMzAuMjk0IDE2Ny41NTkgMTMwLjk0MyAxNjIuNzQ0IDEyOS4wNzMgMTU4LjY0NkMxMjguNTMxIDE1Ny42MTkgMTI4Ljk2NyAxNTYuMzMgMTMwLjAyMyAxNTUuODQ2QzEzMy4yOTcgMTU0LjMxNSAxMzUuNzE5IDE2Mi40NzIgMTM1Ljk2MSAxNjQuNzJDMTM3LjE5MiAxNzMuNjYyIDEzMy41NjggMTgyLjU4NCAxMjcuNjk3IDE4OS4yNTlDMTE3LjEyOCAyMDEuMTU2IDkzLjE2MDMgMjA5Ljk3MiA4MS4yMTUyIDE5NS4zNjNDNzIuMDIxNSAxODIuMSA4My40MzM3IDE2NS4zODggOTQuOTIzNSAxNTguMjc4Qzk5LjY4OTkgMTU1LjE3NyAxMDQuODQ0IDE1Mi45NjkgMTEwLjEzMyAxNTEuNTkzQzExMS41MTkgMTUxLjIzNSAxMTIuOTMzIDE1Mi4wNjggMTEzLjI5MiAxNTMuNDUzQzExMy41NzMgMTU0LjU1NyAxMTMuMTA4IDE1NS42NzIgMTEyLjIwNyAxNTYuMjYyWiIgZmlsbD0iYmxhY2siLz4KPHBhdGggZD0iTTExMi4yMDcgMTU2LjI2MkMxMDQuMzExIDE2MS42NTkgOTYuMzc2NyAxNjcuOTE3IDkyLjAwNzUgMTc2LjE4MUM4OC42NTU1IDE4Mi43MSA4Ny42NzcgMTkwLjE4OSA5Ni43NDQ4IDE5MS4zNjFDMTAzLjE2OCAxOTIuMTU2IDEwOS45NTkgMTg5Ljg4OSAxMTUuNjA3IDE4Ni43MTFDMTIxLjU3NSAxODMuMzg4IDEyNi4yNzMgMTc4LjEwOSAxMjguNzczIDE3MS43MDVDMTMwLjI5NCAxNjcuNTU5IDEzMC45NDMgMTYyLjc0NCAxMjkuMDczIDE1OC42NDZDMTI4LjUzMSAxNTcuNjE5IDEyOC45NjcgMTU2LjMzIDEzMC4wMjMgMTU1Ljg0NkMxMzMuMjk3IDE1NC4zMTUgMTM1LjcxOSAxNjIuNDcyIDEzNS45NjEgMTY0LjcyQzEzNy4xOTIgMTczLjY2MiAxMzMuNTY4IDE4Mi41ODQgMTI3LjY5NyAxODkuMjU5QzExNy4xMjggMjAxLjE1NiA5My4xNjAzIDIwOS45NzIgODEuMjE1MiAxOTUuMzYzQzcyLjAyMTUgMTgyLjEgODMuNDMzNyAxNjUuMzg4IDk0LjkyMzUgMTU4LjI3OEM5OS42ODk5IDE1NS4xNzcgMTA0Ljg0NCAxNTIuOTY5IDExMC4xMzMgMTUxLjU5M0MxMTEuNTE5IDE1MS4yMzUgMTEyLjkzMyAxNTIuMDY4IDExMy4yOTIgMTUzLjQ1M0MxMTMuNTczIDE1NC41NTcgMTEzLjEwOCAxNTUuNjcyIDExMi4yMDcgMTU2LjI2MloiIGZpbGw9ImJsYWNrIiBmaWxsLW9wYWNpdHk9IjAuMiIvPgo8cGF0aCBkPSJNMTUzLjg1IDEwNS45ODZDMTU4LjkwNiAxMDQuNTU2IDE2MS4wNjYgOTYuNTQ3MiAxNTguNjc2IDg4LjA5ODhDMTU2LjI4NSA3OS42NTA1IDE1MC4yNDkgNzMuOTYxNSAxNDUuMTkzIDc1LjM5MjFDMTQwLjEzNyA3Ni44MjI3IDEzNy45NzcgODQuODMxMiAxNDAuMzY4IDkzLjI3OTVDMTQyLjc1OCAxMDEuNzI4IDE0OC43OTUgMTA3LjQxNyAxNTMuODUgMTA1Ljk4NloiIGZpbGw9ImJsYWNrIi8+CjxwYXRoIGQ9Ik0xNTMuODUgMTA1Ljk4NkMxNTguOTA2IDEwNC41NTYgMTYxLjA2NiA5Ni41NDcyIDE1OC42NzYgODguMDk4OEMxNTYuMjg1IDc5LjY1MDUgMTUwLjI0OSA3My45NjE1IDE0NS4xOTMgNzUuMzkyMUMxNDAuMTM3IDc2LjgyMjcgMTM3Ljk3NyA4NC44MzEyIDE0MC4zNjggOTMuMjc5NUMxNDIuNzU4IDEwMS43MjggMTQ4Ljc5NSAxMDcuNDE3IDE1My44NSAxMDUuOTg2WiIgZmlsbD0iYmxhY2siIGZpbGwtb3BhY2l0eT0iMC4yIi8+CjxwYXRoIGQ9Ik0xNDIuNzU1IDk3LjcwNEMxNDQuNzMyIDk3LjE0NDUgMTQ1LjY1OSA5NC4zMDM4IDE0NC44MjYgOTEuMzU5QzE0My45OTMgODguNDE0MSAxNDEuNzE1IDg2LjQ4MDQgMTM5LjczOCA4Ny4wMzk4QzEzNy43NjEgODcuNTk5MiAxMzYuODM0IDkwLjQ0IDEzNy42NjcgOTMuMzg0OEMxMzguNSA5Ni4zMjk2IDE0MC43NzggOTguMjYzNCAxNDIuNzU1IDk3LjcwNFoiIGZpbGw9IndoaXRlIi8+CjxwYXRoIGQ9Ik0xODAuNzA2IDk5LjkyMzFDMTg1LjQ1OCA5OC41Nzg1IDE4Ny40ODkgOTEuMDUyOSAxODUuMjQyIDgzLjExNDJDMTgyLjk5NiA3NS4xNzU1IDE3Ny4zMjMgNjkuODMgMTcyLjU3MSA3MS4xNzQ3QzE2Ny44MTkgNzIuNTE5MyAxNjUuNzg4IDgwLjA0NDkgMTY4LjAzNCA4Ny45ODM2QzE3MC4yODEgOTUuOTIyMyAxNzUuOTU0IDEwMS4yNjggMTgwLjcwNiA5OS45MjMxWiIgZmlsbD0iYmxhY2siLz4KPHBhdGggZD0iTTE4MC43MDYgOTkuOTIzMUMxODUuNDU4IDk4LjU3ODUgMTg3LjQ4OSA5MS4wNTI5IDE4NS4yNDIgODMuMTE0MkMxODIuOTk2IDc1LjE3NTUgMTc3LjMyMyA2OS44MyAxNzIuNTcxIDcxLjE3NDdDMTY3LjgxOSA3Mi41MTkzIDE2NS43ODggODAuMDQ0OSAxNjguMDM0IDg3Ljk4MzZDMTcwLjI4MSA5NS45MjIzIDE3NS45NTQgMTAxLjI2OCAxODAuNzA2IDk5LjkyMzFaIiBmaWxsPSJibGFjayIgZmlsbC1vcGFjaXR5PSIwLjIiLz4KPHBhdGggZD0iTTE3MC4yNzYgOTIuMTM2NkMxNzIuMTM0IDkxLjYxMDcgMTczLjAwNiA4OC45MzkgMTcyLjIyMiA4Ni4xNjkyQzE3MS40MzggODMuMzk5NSAxNjkuMjk2IDgxLjU4MDQgMTY3LjQzNyA4Mi4xMDYzQzE2NS41NzkgODIuNjMyMyAxNjQuNzA4IDg1LjMwMzkgMTY1LjQ5MSA4OC4wNzM3QzE2Ni4yNzUgOTAuODQzNSAxNjguNDE3IDkyLjY2MjUgMTcwLjI3NiA5Mi4xMzY2WiIgZmlsbD0id2hpdGUiLz4KPHBhdGggZD0iTTE0Ni40MSAxMjMuMzE5QzE0Ni40MSAxMjMuMzE5IDE0Ni41MjYgMTQwLjQzNyAxNjAuMDcgMTM5LjExQzE4MC40NzMgMTM3LjEwNSAyMDAuMzYyIDk4LjY3MjkgMTYzLjAwNSAxMTkuMDk1QzE1My4xMDQgMTI0LjUxIDE0Ni40MiAxMjMuMzE5IDE0Ni40MiAxMjMuMzE5SDE0Ni40MVoiIGZpbGw9ImJsYWNrIi8+CjxwYXRoIGQ9Ik0xNDYuNDEgMTIzLjMxOUMxNDYuNDEgMTIzLjMxOSAxNDYuNTI2IDE0MC40MzcgMTYwLjA3IDEzOS4xMUMxODAuNDczIDEzNy4xMDUgMjAwLjM2MiA5OC42NzI5IDE2My4wMDUgMTE5LjA5NUMxNTMuMTA0IDEyNC41MSAxNDYuNDIgMTIzLjMxOSAxNDYuNDIgMTIzLjMxOUgxNDYuNDFaIiBmaWxsPSJibGFjayIgZmlsbC1vcGFjaXR5PSIwLjIiLz4KPC9zdmc+Cg==", "firecrawl": "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjAwIiBoZWlnaHQ9IjI4NCIgdmlld0JveD0iMCAwIDIwMCAyODQiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CjxwYXRoIGQ9Ik0xNjYuODYyIDkwLjc3MTZDMTU1LjgxMiA5NC4wNTE0IDE0Ny40ODMgMTAxLjQ3MSAxNDEuMzgzIDEwOS41M0MxNDAuMDczIDExMS4yNiAxMzcuMzQzIDEwOS45NiAxMzcuODYzIDEwNy44NDFDMTQ5LjU0MyA1OS44MTM2IDEzNC4xMTMgMTkuODk2IDg2LjAxNTcgMC4yNDcyNjlDODMuNTc1OCAtMC43NTI2NjkgODEuMDM1OSAxLjQzNzE5IDgxLjY3NTkgMy45OTcwNEMxMDMuNTU1IDkxLjg0MTYgMTEuNTI5NCA4NC40MzIgMjMuMTU4OCAxODQuMDE2QzIzLjM1ODggMTg1LjcyNiAyMS40Mzg5IDE4Ni44OTYgMjAuMDM5IDE4NS44OTZDMTUuNjc5MiAxODIuNzY2IDEwLjgwOTUgMTc2LjIzNiA3LjQ2OTYzIDE3MS42NDdDNi40ODk2OCAxNzAuMjk3IDQuMzY5NzggMTcwLjY3NyAzLjkxOTggMTcyLjI4N0MxLjI1OTk0IDE4MS45MDYgMCAxOTAuOTY1IDAgMTk5Ljk2NUMwIDIzNC45NjMgMTcuOTg5MSAyNjUuNzcxIDQ1LjIxNzcgMjgzLjYzQzQ2Ljc3NzcgMjg0LjY1IDQ4Ljc3NzYgMjgzLjE5IDQ4LjI0NzYgMjgxLjRDNDYuODQ3NyAyNzYuNyA0Ni4wNTc3IDI3MS43NCA0NS45OTc3IDI2Ni42MTFDNDUuOTk3NyAyNjMuNDYxIDQ2LjE5NzcgMjYwLjI0MSA0Ni42ODc3IDI1Ny4yNDFDNDcuODI3NiAyNDkuNzAyIDUwLjQ0NzUgMjQyLjUyMiA1NC44NDczIDIzNS45ODNDNjkuOTM2NSAyMTMuMzM0IDEwMC4xODUgMTkxLjQ1NSA5NS4zNTUyIDE2MS43NDdDOTUuMDQ1MyAxNTkuODY3IDk3LjI2NTEgMTU4LjYyNyA5OC42NjUxIDE1OS45MTdDMTE5Ljk3NCAxNzkuMzg2IDEyNC4xOTQgMjA1LjU3NSAxMjAuNjk0IDIyOS4wNjNDMTIwLjM5NCAyMzEuMTAzIDEyMi45NTQgMjMyLjE5MyAxMjQuMjQ0IDIzMC41OTNDMTI3LjUwNCAyMjYuNTEzIDEzMS40ODMgMjIyLjkzMyAxMzUuODEzIDIyMC4yNDRDMTM2Ljg5MyAyMTkuNTc0IDEzOC4zMzMgMjIwLjA4NCAxMzguNzQzIDIyMS4yODRDMTQxLjE1MyAyMjguMjkzIDE0NC43MzMgMjM0Ljg3MyAxNDguMTEzIDI0MS40NTJDMTUyLjE1MiAyNDkuMzYyIDE1NC4zMDIgMjU4LjM5MSAxNTMuOTYyIDI2Ny45NTFDMTUzLjc5MiAyNzIuNiAxNTMuMDIyIDI3Ny4xIDE1MS43MzIgMjgxLjM4QzE1MS4xODIgMjgzLjE5IDE1My4xNjIgMjg0LjcgMTU0Ljc1MiAyODMuNjZDMTgyLjAwMSAyNjUuODAxIDIwMCAyMzQuOTkzIDIwMCAxOTkuOTc1QzIwMCAxODcuODA2IDE5Ny44NyAxNzUuODc2IDE5My44NCAxNjQuNjk3QzE4NS4zOTEgMTQxLjI0OCAxNjMuOTUyIDEyMy42NCAxNjkuMzcyIDkzLjA4MTVDMTY5LjYzMiA5MS42MjE2IDE2OC4yODIgOTAuMzUxNyAxNjYuODYyIDkwLjc3MTZaIiBmaWxsPSIjRkE1RDE5IiBzdHlsZT0iZmlsbDojRkE1RDE5O2ZpbGw6Y29sb3IoZGlzcGxheS1wMyAwLjk4MTYgMC4zNjM0IDAuMDk4NCk7ZmlsbC1vcGFjaXR5OjE7Ii8+Cjwvc3ZnPgo=", "github": "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iOTgiIGhlaWdodD0iOTYiIHZpZXdCb3g9IjAgMCA5OCA5NiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPGcgY2xpcC1wYXRoPSJ1cmwoI2NsaXAwXzczMF8yNzEyNikiPgo8cGF0aCBkPSJNNDEuNDM5NSA2OS4zODQ4QzI4LjgwNjYgNjcuODUzNSAxOS45MDYyIDU4Ljc2MTcgMTkuOTA2MiA0Ni45OTAyQzE5LjkwNjIgNDIuMjA1MSAyMS42Mjg5IDM3LjAzNzEgMjQuNSAzMy41OTE4QzIzLjI1NTkgMzAuNDMzNiAyMy40NDczIDIzLjczNDQgMjQuODgyOCAyMC45NTlDMjguNzEwOSAyMC40ODA1IDMzLjg3ODkgMjIuNDkwMiAzNi45NDE0IDI1LjI2NTZDNDAuNTc4MSAyNC4xMTcyIDQ0LjQwNjIgMjMuNTQzIDQ5LjA5NTcgMjMuNTQzQzUzLjc4NTIgMjMuNTQzIDU3LjYxMzMgMjQuMTE3MiA2MS4wNTg2IDI1LjE2OTlDNjQuMDI1NCAyMi40OTAyIDY5LjI4OTEgMjAuNDgwNSA3My4xMTcyIDIwLjk1OUM3NC40NTcgMjMuNTQzIDc0LjY0ODQgMzAuMjQyMiA3My40MDQzIDMzLjQ5NjFDNzYuNDY2OCAzNy4xMzI4IDc4LjA5MzcgNDIuMDEzNyA3OC4wOTM3IDQ2Ljk5MDJDNzguMDkzNyA1OC43NjE3IDY5LjE5MzQgNjcuNjYyMSA1Ni4zNjkxIDY5LjI4OTFDNTkuNjIzIDcxLjM5NDUgNjEuODI0MiA3NS45ODgzIDYxLjgyNDIgODEuMjUyTDYxLjgyNDIgOTEuMjA1MUM2MS44MjQyIDk0LjA3NjIgNjQuMjE2OCA5NS43MDMxIDY3LjA4NzkgOTQuNTU0N0M4NC40MTAyIDg3Ljk1MTIgOTggNzAuNjI4OSA5OCA0OS4xOTE0Qzk4IDIyLjEwNzQgNzUuOTg4MyA2LjY5NTM5ZS0wNyA0OC45MDQzIDQuMzA5ZS0wN0MyMS44MjAzIDEuOTIyNjFlLTA3IC0xLjk0NzllLTA3IDIyLjEwNzQgLTQuMzM0M2UtMDcgNDkuMTkxNEMtNi4yMDYzMWUtMDcgNzAuNDM3NSAxMy40OTQxIDg4LjA0NjkgMzEuNjc3NyA5NC42NTA0QzM0LjI2MTcgOTUuNjA3NCAzNi43NSA5My44ODQ4IDM2Ljc1IDkxLjMwMDhMMzYuNzUgODMuNjQ0NUMzNS40MTAyIDg0LjIxODggMzMuNjg3NSA4NC42MDE2IDMyLjE1NjIgODQuNjAxNkMyNS44Mzk4IDg0LjYwMTYgMjIuMTA3NCA4MS4xNTYzIDE5LjQyNzcgNzQuNzQ0MUMxOC4zNzUgNzIuMTYwMiAxNy4yMjY2IDcwLjYyODkgMTUuMDI1NCA3MC4zNDE4QzEzLjg3NyA3MC4yNDYxIDEzLjQ5NDEgNjkuNzY3NiAxMy40OTQxIDY5LjE5MzRDMTMuNDk0MSA2OC4wNDQ5IDE1LjQwODIgNjcuMTgzNiAxNy4zMjIzIDY3LjE4MzZDMjAuMDk3NyA2Ny4xODM2IDIyLjQ5MDIgNjguOTA2MyAyNC45Nzg1IDcyLjQ0NzNDMjYuODkyNiA3NS4yMjI3IDI4LjkwMjMgNzYuNDY2OCAzMS4yOTQ5IDc2LjQ2NjhDMzMuNjg3NSA3Ni40NjY4IDM1LjIxODcgNzUuNjA1NSAzNy40MTk5IDczLjQwNDNDMzkuMDQ2OSA3MS43NzczIDQwLjI5MSA3MC4zNDE4IDQxLjQzOTUgNjkuMzg0OFoiIGZpbGw9ImJsYWNrIi8+CjwvZz4KPGRlZnM+CjxjbGlwUGF0aCBpZD0iY2xpcDBfNzMwXzI3MTI2Ij4KPHJlY3Qgd2lkdGg9Ijk4IiBoZWlnaHQ9Ijk2IiBmaWxsPSJ3aGl0ZSIvPgo8L2NsaXBQYXRoPgo8L2RlZnM+Cjwvc3ZnPgo=", "githubDark": "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iOTgiIGhlaWdodD0iOTYiIHZpZXdCb3g9IjAgMCA5OCA5NiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPGcgY2xpcC1wYXRoPSJ1cmwoI2NsaXAwXzczMF8yNzEzNikiPgo8cGF0aCBkPSJNNDEuNDM5NSA2OS4zODQ4QzI4LjgwNjYgNjcuODUzNSAxOS45MDYyIDU4Ljc2MTcgMTkuOTA2MiA0Ni45OTAyQzE5LjkwNjIgNDIuMjA1MSAyMS42Mjg5IDM3LjAzNzEgMjQuNSAzMy41OTE4QzIzLjI1NTkgMzAuNDMzNiAyMy40NDczIDIzLjczNDQgMjQuODgyOCAyMC45NTlDMjguNzEwOSAyMC40ODA1IDMzLjg3ODkgMjIuNDkwMiAzNi45NDE0IDI1LjI2NTZDNDAuNTc4MSAyNC4xMTcyIDQ0LjQwNjIgMjMuNTQzIDQ5LjA5NTcgMjMuNTQzQzUzLjc4NTIgMjMuNTQzIDU3LjYxMzMgMjQuMTE3MiA2MS4wNTg2IDI1LjE2OTlDNjQuMDI1NCAyMi40OTAyIDY5LjI4OTEgMjAuNDgwNSA3My4xMTcyIDIwLjk1OUM3NC40NTcgMjMuNTQzIDc0LjY0ODQgMzAuMjQyMiA3My40MDQzIDMzLjQ5NjFDNzYuNDY2OCAzNy4xMzI4IDc4LjA5MzcgNDIuMDEzNyA3OC4wOTM3IDQ2Ljk5MDJDNzguMDkzNyA1OC43NjE3IDY5LjE5MzQgNjcuNjYyMSA1Ni4zNjkxIDY5LjI4OTFDNTkuNjIzIDcxLjM5NDUgNjEuODI0MiA3NS45ODgzIDYxLjgyNDIgODEuMjUyTDYxLjgyNDIgOTEuMjA1MUM2MS44MjQyIDk0LjA3NjIgNjQuMjE2OCA5NS43MDMxIDY3LjA4NzkgOTQuNTU0N0M4NC40MTAyIDg3Ljk1MTIgOTggNzAuNjI4OSA5OCA0OS4xOTE0Qzk4IDIyLjEwNzQgNzUuOTg4MyA2LjY5NTM5ZS0wNyA0OC45MDQzIDQuMzA5ZS0wN0MyMS44MjAzIDEuOTIyNjFlLTA3IC0xLjk0NzllLTA3IDIyLjEwNzQgLTQuMzM0M2UtMDcgNDkuMTkxNEMtNi4yMDYzMWUtMDcgNzAuNDM3NSAxMy40OTQxIDg4LjA0NjkgMzEuNjc3NyA5NC42NTA0QzM0LjI2MTcgOTUuNjA3NCAzNi43NSA5My44ODQ4IDM2Ljc1IDkxLjMwMDhMMzYuNzUgODMuNjQ0NUMzNS40MTAyIDg0LjIxODggMzMuNjg3NSA4NC42MDE2IDMyLjE1NjIgODQuNjAxNkMyNS44Mzk4IDg0LjYwMTYgMjIuMTA3NCA4MS4xNTYzIDE5LjQyNzcgNzQuNzQ0MUMxOC4zNzUgNzIuMTYwMiAxNy4yMjY2IDcwLjYyODkgMTUuMDI1NCA3MC4zNDE4QzEzLjg3NyA3MC4yNDYxIDEzLjQ5NDEgNjkuNzY3NiAxMy40OTQxIDY5LjE5MzRDMTMuNDk0MSA2OC4wNDQ5IDE1LjQwODIgNjcuMTgzNiAxNy4zMjIzIDY3LjE4MzZDMjAuMDk3NyA2Ny4xODM2IDIyLjQ5MDIgNjguOTA2MyAyNC45Nzg1IDcyLjQ0NzNDMjYuODkyNiA3NS4yMjI3IDI4LjkwMjMgNzYuNDY2OCAzMS4yOTQ5IDc2LjQ2NjhDMzMuNjg3NSA3Ni40NjY4IDM1LjIxODcgNzUuNjA1NSAzNy40MTk5IDczLjQwNDNDMzkuMDQ2OSA3MS43NzczIDQwLjI5MSA3MC4zNDE4IDQxLjQzOTUgNjkuMzg0OFoiIGZpbGw9IndoaXRlIi8+CjwvZz4KPGRlZnM+CjxjbGlwUGF0aCBpZD0iY2xpcDBfNzMwXzI3MTM2Ij4KPHJlY3Qgd2lkdGg9Ijk4IiBoZWlnaHQ9Ijk2IiBmaWxsPSJ3aGl0ZSIvPgo8L2NsaXBQYXRoPgo8L2RlZnM+Cjwvc3ZnPgo=" };
  var SETTINGS_DESCRIPTORS = [{ "id": "dsh-grok-search#grokSearchSettings/openSearchLog", "service": "grokSearchSettings", "namespace": "grokSearchSettings", "method": "openSearchLog", "description": "Open a bounded server-issued secure history view.", "invocation": { "kind": "direct" }, "parameters": [], "result": { "mode": "strict", "typeSymbol": "dsh-grok-search/settings#OpenSearchLogResult", "jsonSchema": { "type": "object", "properties": { "sessionId": { "type": "string" } }, "required": ["sessionId"], "additionalProperties": false } } }, { "id": "dsh-grok-search#grokSearchSettings/previewGithubConnection", "service": "grokSearchSettings", "namespace": "grokSearchSettings", "method": "previewGithubConnection", "description": "Test the current GitHub token draft and a public resource without saving credentials or consent.", "invocation": { "kind": "direct" }, "parameters": [{ "name": "request", "wire": "request", "source": "json", "codec": { "mode": "strict", "typeSymbol": "dsh-grok-search/settings#GithubPreviewRequest", "jsonSchema": { "type": "object", "properties": { "token": { "type": "string" }, "expectedRevision": { "type": "string" }, "configIdentity": { "type": "string" }, "operationId": { "type": "string" } }, "required": ["expectedRevision", "configIdentity", "operationId"], "additionalProperties": false } } }], "result": { "mode": "strict", "typeSymbol": "dsh-grok-search/settings#GithubPreviewResult", "jsonSchema": { "type": "object", "properties": { "provider": { "type": "string" }, "status": { "type": "string" }, "code": { "type": "string" }, "message": { "type": "string" }, "elapsedMs": { "type": "number" }, "keys": { "type": "array", "items": { "type": "object", "additionalProperties": true } } }, "required": ["provider", "status", "code", "message"], "additionalProperties": true } } }, { "id": "dsh-grok-search#grokSearchSettings/readSearchLog", "service": "grokSearchSettings", "namespace": "grokSearchSettings", "method": "readSearchLog", "description": "Read or clear plugin-owned volatile search history, or close only this secure view.", "invocation": { "kind": "direct" }, "parameters": [{ "name": "request", "wire": "request", "source": "json", "codec": { "mode": "strict", "typeSymbol": "dsh-grok-search/settings#readSearchLogRequest", "jsonSchema": { "type": "object", "properties": { "sessionId": { "type": "string" } }, "required": ["sessionId"], "additionalProperties": false } } }], "result": { "mode": "strict", "typeSymbol": "dsh-grok-search/settings#readSearchLogResult", "jsonSchema": { "type": "object", "properties": { "records": { "type": "array", "items": { "type": "object", "additionalProperties": true } }, "closed": { "type": "boolean" } }, "additionalProperties": false } } }, { "id": "dsh-grok-search#grokSearchSettings/clearSearchLog", "service": "grokSearchSettings", "namespace": "grokSearchSettings", "method": "clearSearchLog", "description": "Read or clear plugin-owned volatile search history, or close only this secure view.", "invocation": { "kind": "direct" }, "parameters": [{ "name": "request", "wire": "request", "source": "json", "codec": { "mode": "strict", "typeSymbol": "dsh-grok-search/settings#clearSearchLogRequest", "jsonSchema": { "type": "object", "properties": { "sessionId": { "type": "string" } }, "required": ["sessionId"], "additionalProperties": false } } }], "result": { "mode": "strict", "typeSymbol": "dsh-grok-search/settings#clearSearchLogResult", "jsonSchema": { "type": "object", "properties": { "records": { "type": "array", "items": { "type": "object", "additionalProperties": true } }, "closed": { "type": "boolean" } }, "additionalProperties": false } } }, { "id": "dsh-grok-search#grokSearchSettings/closeSearchLog", "service": "grokSearchSettings", "namespace": "grokSearchSettings", "method": "closeSearchLog", "description": "Read or clear plugin-owned volatile search history, or close only this secure view.", "invocation": { "kind": "direct" }, "parameters": [{ "name": "request", "wire": "request", "source": "json", "codec": { "mode": "strict", "typeSymbol": "dsh-grok-search/settings#closeSearchLogRequest", "jsonSchema": { "type": "object", "properties": { "sessionId": { "type": "string" } }, "required": ["sessionId"], "additionalProperties": false } } }], "result": { "mode": "strict", "typeSymbol": "dsh-grok-search/settings#closeSearchLogResult", "jsonSchema": { "type": "object", "properties": { "records": { "type": "array", "items": { "type": "object", "additionalProperties": true } }, "closed": { "type": "boolean" } }, "additionalProperties": false } } }, { "id": "dsh-grok-search#grokSearchSettings/toolCallTrace", "service": "grokSearchSettings", "namespace": "grokSearchSettings", "method": "toolCallTrace", "description": "Read bounded provider attempt states and timings for an exact call; no query, response or credentials.", "invocation": { "kind": "direct" }, "parameters": [{ "name": "request", "wire": "request", "source": "json", "codec": { "mode": "strict", "typeSymbol": "dsh-grok-search/settings#ToolCallTraceRequest", "jsonSchema": { "type": "object", "properties": { "sessionId": { "type": "string" }, "callId": { "type": "string" } }, "required": ["sessionId", "callId"], "additionalProperties": false } } }], "result": { "mode": "strict", "typeSymbol": "dsh-grok-search/settings#ToolCallTraceResult", "jsonSchema": { "type": "object", "properties": { "known": { "type": "boolean" }, "state": { "type": "string" }, "toolName": { "type": "string" }, "at": { "type": "number" }, "elapsedMs": { "type": ["number", "null"] }, "routesComplete": { "type": "boolean" }, "routes": { "type": "array", "maxItems": 16, "items": { "type": "object", "properties": { "served": { "type": ["string", "null"] }, "outcome": { "type": "string" }, "fallbackUsed": { "type": "boolean" }, "code": { "type": "string" }, "resultProviders": { "type": "array", "items": { "type": "string" } }, "resultProvidersComplete": { "type": "boolean" }, "index": { "type": "number" }, "phase": { "type": "string" }, "at": { "type": "number" }, "elapsedMs": { "type": ["number", "null"] }, "callsComplete": { "type": "boolean" }, "callsTruncated": { "type": "boolean" }, "planned": { "type": "array", "items": { "type": "string" } }, "calls": { "type": "array", "maxItems": 16, "items": { "type": "object", "properties": { "provider": { "type": "string" }, "result": { "type": "string" }, "code": { "type": "string" }, "keyIndex": { "type": ["number", "null"] }, "operation": { "type": "string" }, "evidence": { "type": "string" }, "at": { "type": "number" }, "elapsedMs": { "type": ["number", "null"] } }, "required": ["provider", "result", "code", "keyIndex", "operation", "evidence", "at", "elapsedMs"], "additionalProperties": false } } }, "required": ["served", "outcome", "fallbackUsed", "code", "index", "phase", "at", "elapsedMs", "callsComplete", "callsTruncated", "calls", "planned"], "additionalProperties": false } } }, "required": ["known", "state", "routes"], "additionalProperties": false } } }, { "id": "dsh-grok-search#grokSearchSettings/toolCallRoute", "service": "grokSearchSettings", "namespace": "grokSearchSettings", "method": "toolCallRoute", "description": "Return the exact recorded routes for one session tool call; no query text or credentials.", "invocation": { "kind": "direct" }, "parameters": [{ "name": "request", "wire": "request", "source": "json", "codec": { "mode": "strict", "typeSymbol": "dsh-grok-search/settings#ToolCallRouteRequest", "jsonSchema": { "type": "object", "properties": { "sessionId": { "type": "string" }, "callId": { "type": "string" } }, "required": ["sessionId", "callId"], "additionalProperties": false } } }], "result": { "mode": "strict", "typeSymbol": "dsh-grok-search/settings#ToolCallRouteResult", "jsonSchema": { "type": "object", "properties": { "known": { "type": "boolean" }, "state": { "type": "string" }, "routes": { "type": "array", "items": { "type": "object", "properties": { "served": { "type": ["string", "null"] }, "outcome": { "type": "string" }, "fallbackUsed": { "type": "boolean" }, "code": { "type": "string" }, "resultProviders": { "type": "array", "items": { "type": "string" } }, "resultProvidersComplete": { "type": "boolean" } }, "required": ["served", "outcome", "fallbackUsed", "code"], "additionalProperties": false } }, "routesComplete": { "type": "boolean" } }, "required": ["known", "state", "routes"], "additionalProperties": false } } }, { "id": "dsh-grok-search#grokSearchSettings/accountQuota", "service": "grokSearchSettings", "namespace": "grokSearchSettings", "method": "accountQuota", "description": "Query a saved account or a transient form draft without saving or returning credentials.", "invocation": { "kind": "direct" }, "parameters": [{ "name": "request", "wire": "request", "source": "json", "codec": { "mode": "strict", "typeSymbol": "dsh-grok-search/settings#AccountQuotaRequest", "jsonSchema": { "type": "object", "properties": { "provider": { "type": "string" }, "keyIndex": { "type": "number" }, "expectedRevision": { "type": "string" }, "operationId": { "type": "string" }, "quotaRevision": { "type": "string" }, "draft": { "type": "object", "properties": { "baseUrl": { "type": "string" }, "apiKey": { "type": "string" } }, "additionalProperties": false } }, "required": ["provider", "expectedRevision", "operationId", "quotaRevision"], "additionalProperties": false } } }], "result": { "mode": "strict", "typeSymbol": "dsh-grok-search/settings#AccountQuotaResult", "jsonSchema": { "type": "object", "properties": { "supported": { "type": "boolean" }, "value": { "anyOf": [{ "type": "object", "additionalProperties": true }, { "type": "null" }] } }, "required": ["supported", "value"], "additionalProperties": false } } }, { "id": "dsh-grok-search#grokSearchSettings/previewAccountQuota", "service": "grokSearchSettings", "namespace": "grokSearchSettings", "method": "previewAccountQuota", "description": "Query a saved account or a transient form draft without saving or returning credentials.", "invocation": { "kind": "direct" }, "parameters": [{ "name": "request", "wire": "request", "source": "json", "codec": { "mode": "strict", "typeSymbol": "dsh-grok-search/settings#AccountQuotaRequest", "jsonSchema": { "type": "object", "properties": { "provider": { "type": "string" }, "keyIndex": { "type": "number" }, "expectedRevision": { "type": "string" }, "operationId": { "type": "string" }, "quotaRevision": { "type": "string" }, "draft": { "type": "object", "properties": { "baseUrl": { "type": "string" }, "apiKey": { "type": "string" } }, "additionalProperties": false } }, "required": ["provider", "expectedRevision", "operationId", "quotaRevision"], "additionalProperties": false } } }], "result": { "mode": "strict", "typeSymbol": "dsh-grok-search/settings#AccountQuotaResult", "jsonSchema": { "type": "object", "properties": { "supported": { "type": "boolean" }, "value": { "anyOf": [{ "type": "object", "additionalProperties": true }, { "type": "null" }] } }, "required": ["supported", "value"], "additionalProperties": false } } }, { "id": "dsh-grok-search#grokSearchSettings/snapshot", "service": "grokSearchSettings", "namespace": "grokSearchSettings", "method": "snapshot", "description": "Read redacted Grok shared configuration and current takeover state.", "invocation": { "kind": "direct" }, "parameters": [], "result": { "mode": "strict", "typeSymbol": "dsh-grok-search/settings#Snapshot", "jsonSchema": { "type": "object", "properties": { "control": { "type": "object", "properties": { "available": { "type": "boolean" }, "phase": { "type": "string" }, "policy": { "anyOf": [{ "type": "string" }, { "type": "null" }] }, "revision": { "type": "number" }, "canStop": { "type": "boolean" }, "completionCommitted": { "type": "boolean" }, "routeVerified": { "type": "boolean" }, "routeChanged": { "type": "boolean" }, "releaseOperationId": { "anyOf": [{ "type": "string" }, { "type": "null" }] }, "error": { "anyOf": [{ "type": "object", "properties": { "code": { "type": ["string", "null"] }, "message": { "type": "string" } }, "required": ["code", "message"], "additionalProperties": false }, { "type": "null" }] } }, "required": ["available", "phase", "policy", "revision", "canStop", "completionCommitted", "routeVerified", "routeChanged", "releaseOperationId", "error"], "additionalProperties": false }, "program": { "anyOf": [{ "type": "null" }, { "type": "object", "properties": { "phase": { "type": "string" }, "program": { "anyOf": [{ "type": "object", "additionalProperties": true }, { "type": "null" }] }, "configPath": { "anyOf": [{ "type": "string" }, { "type": "null" }] }, "error": { "anyOf": [{ "type": "object", "properties": { "code": { "type": ["string", "null"] }, "message": { "type": "string" } }, "required": ["code", "message"], "additionalProperties": false }, { "type": "null" }] }, "canRepair": { "type": "boolean" }, "configuration": { "type": "object", "additionalProperties": true } }, "required": ["phase", "program", "configPath", "error"], "additionalProperties": false }] }, "config": { "type": "object", "properties": { "path": { "type": "string" }, "displayPath": { "type": "string" }, "exists": { "type": "boolean" }, "revision": { "type": "string" }, "quotaRevision": { "type": "string" }, "fields": { "type": "object", "additionalProperties": true }, "unknownFields": { "type": "array", "items": { "type": "string" } }, "error": { "anyOf": [{ "type": "object", "properties": { "code": { "type": ["string", "null"] }, "message": { "type": "string" } }, "required": ["code", "message"], "additionalProperties": false }, { "type": "null" }] } }, "required": ["path", "exists", "revision", "fields", "unknownFields"], "additionalProperties": false }, "capabilities": { "type": "object", "properties": { "secretsAllowed": { "type": "boolean" }, "transport": { "type": "string" }, "reason": { "anyOf": [{ "type": "string" }, { "type": "null" }] } }, "required": ["secretsAllowed", "transport", "reason"], "additionalProperties": false }, "route": { "anyOf": [{ "type": "null" }, { "type": "object", "properties": { "at": { "type": "number" }, "origin": { "type": "string" }, "outcome": { "type": "string" }, "served": { "anyOf": [{ "type": "string" }, { "type": "null" }] }, "grokCode": { "anyOf": [{ "type": "string" }, { "type": "null" }] }, "fallbackUsed": { "type": "boolean" }, "resultProviders": { "type": "array", "items": { "type": "string" } }, "resultProvidersComplete": { "type": "boolean" }, "provenance": { "type": "string" }, "code": { "type": "string" }, "failures": { "type": "array", "items": { "type": "object", "additionalProperties": true } } }, "required": ["at", "origin", "outcome", "served", "grokCode", "fallbackUsed", "failures"], "additionalProperties": false }] }, "plugin": { "type": "object", "properties": { "budgetMs": { "anyOf": [{ "type": "number" }, { "type": "null" }] }, "programConfigured": { "type": "boolean" }, "configSource": { "type": "string" } }, "required": ["budgetMs", "programConfigured", "configSource"], "additionalProperties": false }, "available": { "type": "boolean" }, "phase": { "type": "string" }, "policy": { "anyOf": [{ "type": "string" }, { "type": "null" }] }, "revision": { "type": "number" }, "canStop": { "type": "boolean" }, "completionCommitted": { "type": "boolean" }, "routeVerified": { "type": "boolean" }, "routeChanged": { "type": "boolean" }, "releaseOperationId": { "anyOf": [{ "type": "string" }, { "type": "null" }] }, "error": { "anyOf": [{ "type": "object", "properties": { "code": { "type": ["string", "null"] }, "message": { "type": "string" } }, "required": ["code", "message"], "additionalProperties": false }, { "type": "null" }] } }, "required": ["control", "program", "config", "capabilities", "available", "phase", "policy", "revision", "canStop", "completionCommitted", "routeVerified", "routeChanged", "releaseOperationId", "error"], "additionalProperties": false } } }, { "id": "dsh-grok-search#grokSearchSettings/save", "service": "grokSearchSettings", "namespace": "grokSearchSettings", "method": "save", "description": "Save validated changes to the shared Grok configuration with CAS.", "invocation": { "kind": "direct" }, "parameters": [{ "name": "request", "wire": "request", "source": "json", "codec": { "mode": "strict", "typeSymbol": "dsh-grok-search/settings#SaveRequest", "jsonSchema": { "type": "object", "properties": { "expectedRevision": { "type": "string" }, "updates": { "type": "object", "additionalProperties": true } }, "required": ["expectedRevision", "updates"], "additionalProperties": false } } }], "result": { "mode": "strict", "typeSymbol": "dsh-grok-search/settings#SaveResult", "jsonSchema": { "type": "object", "properties": { "config": { "type": "object", "properties": { "path": { "type": "string" }, "displayPath": { "type": "string" }, "exists": { "type": "boolean" }, "revision": { "type": "string" }, "quotaRevision": { "type": "string" }, "fields": { "type": "object", "additionalProperties": true }, "unknownFields": { "type": "array", "items": { "type": "string" } }, "error": { "anyOf": [{ "type": "object", "properties": { "code": { "type": ["string", "null"] }, "message": { "type": "string" } }, "required": ["code", "message"], "additionalProperties": false }, { "type": "null" }] } }, "required": ["path", "exists", "revision", "fields", "unknownFields"], "additionalProperties": false } }, "required": ["config"], "additionalProperties": false } } }, { "id": "dsh-grok-search#grokSearchSettings/restoreConfig", "service": "grokSearchSettings", "namespace": "grokSearchSettings", "method": "restoreConfig", "description": "Restore one verified configuration history revision with CAS over a secure connection.", "invocation": { "kind": "direct" }, "parameters": [{ "name": "request", "wire": "request", "source": "json", "codec": { "mode": "strict", "typeSymbol": "dsh-grok-search/settings#RestoreRequest", "jsonSchema": { "type": "object", "properties": { "expectedRevision": { "type": "string" }, "revision": { "type": "string" } }, "required": ["expectedRevision", "revision"], "additionalProperties": false } } }], "result": { "mode": "strict", "typeSymbol": "dsh-grok-search/settings#RestoreResult", "jsonSchema": { "type": "object", "properties": { "config": { "type": "object", "properties": { "path": { "type": "string" }, "displayPath": { "type": "string" }, "exists": { "type": "boolean" }, "revision": { "type": "string" }, "quotaRevision": { "type": "string" }, "fields": { "type": "object", "additionalProperties": true }, "unknownFields": { "type": "array", "items": { "type": "string" } }, "error": { "anyOf": [{ "type": "object", "properties": { "code": { "type": ["string", "null"] }, "message": { "type": "string" } }, "required": ["code", "message"], "additionalProperties": false }, { "type": "null" }] } }, "required": ["path", "exists", "revision", "fields", "unknownFields"], "additionalProperties": false } }, "required": ["config"], "additionalProperties": false } } }, { "id": "dsh-grok-search#grokSearchSettings/reveal", "service": "grokSearchSettings", "namespace": "grokSearchSettings", "method": "reveal", "description": "Explicitly reveal one credential over an authenticated secure connection.", "invocation": { "kind": "direct" }, "parameters": [{ "name": "request", "wire": "request", "source": "json", "codec": { "mode": "strict", "typeSymbol": "dsh-grok-search/settings#RevealRequest", "jsonSchema": { "type": "object", "properties": { "key": { "type": "string" } }, "required": ["key"], "additionalProperties": false } } }], "result": { "mode": "strict", "typeSymbol": "dsh-grok-search/settings#RevealResult", "jsonSchema": { "type": "object", "properties": { "key": { "type": "string" }, "value": { "type": "string" }, "source": { "type": "string" }, "readOnly": { "type": "boolean" } }, "required": ["key", "value", "source", "readOnly"], "additionalProperties": false } } }, { "id": "dsh-grok-search#grokSearchSettings/prepareProgram", "service": "grokSearchSettings", "namespace": "grokSearchSettings", "method": "prepareProgram", "description": "Discover or prepare the verified private Grok program.", "invocation": { "kind": "direct" }, "parameters": [], "result": { "mode": "strict", "typeSymbol": "dsh-grok-search/settings#PrepareResult", "jsonSchema": { "type": "object", "properties": { "phase": { "type": "string" }, "program": { "anyOf": [{ "type": "object", "additionalProperties": true }, { "type": "null" }] }, "configPath": { "anyOf": [{ "type": "string" }, { "type": "null" }] }, "error": { "anyOf": [{ "type": "object", "properties": { "code": { "type": ["string", "null"] }, "message": { "type": "string" } }, "required": ["code", "message"], "additionalProperties": false }, { "type": "null" }] }, "canRepair": { "type": "boolean" }, "configuration": { "type": "object", "additionalProperties": true } }, "required": ["phase", "program", "configPath", "error"], "additionalProperties": false } } }, { "id": "dsh-grok-search#grokSearchSettings/repairProgram", "service": "grokSearchSettings", "namespace": "grokSearchSettings", "method": "repairProgram", "description": "Explicitly repair damaged private program content using a verified version.", "invocation": { "kind": "direct" }, "parameters": [], "result": { "mode": "strict", "typeSymbol": "dsh-grok-search/settings#PrepareResult", "jsonSchema": { "type": "object", "properties": { "phase": { "type": "string" }, "program": { "anyOf": [{ "type": "object", "additionalProperties": true }, { "type": "null" }] }, "configPath": { "anyOf": [{ "type": "string" }, { "type": "null" }] }, "error": { "anyOf": [{ "type": "object", "properties": { "code": { "type": ["string", "null"] }, "message": { "type": "string" } }, "required": ["code", "message"], "additionalProperties": false }, { "type": "null" }] }, "canRepair": { "type": "boolean" }, "configuration": { "type": "object", "additionalProperties": true } }, "required": ["phase", "program", "configPath", "error"], "additionalProperties": false } } }, { "id": "dsh-grok-search#grokSearchSettings/openConfigLocation", "service": "grokSearchSettings", "namespace": "grokSearchSettings", "method": "openConfigLocation", "description": "Open the shared Grok configuration file or its folder on the local host.", "invocation": { "kind": "direct" }, "parameters": [{ "name": "request", "wire": "request", "source": "json", "codec": { "mode": "strict", "typeSymbol": "dsh-grok-search/settings#OpenConfigRequest", "jsonSchema": { "type": "object", "properties": { "kind": { "type": "string" } }, "required": [], "additionalProperties": false } } }], "result": { "mode": "strict", "typeSymbol": "dsh-grok-search/settings#OpenConfigResult", "jsonSchema": { "type": "object", "properties": { "path": { "type": "string" }, "displayPath": { "type": "string" }, "opened": { "type": "boolean" }, "exists": { "type": "boolean" }, "kind": { "type": "string" } }, "required": ["path", "opened"], "additionalProperties": false } } }, { "id": "dsh-grok-search#grokSearchSettings/openConfigLocationWithStatus", "service": "grokSearchSettings", "namespace": "grokSearchSettings", "method": "openConfigLocationWithStatus", "description": "Open the shared Grok configuration file or its folder on the local host.", "invocation": { "kind": "direct" }, "parameters": [{ "name": "request", "wire": "request", "source": "json", "codec": { "mode": "strict", "typeSymbol": "dsh-grok-search/settings#OpenConfigRequest", "jsonSchema": { "type": "object", "properties": { "kind": { "type": "string" } }, "required": [], "additionalProperties": false } } }], "result": { "mode": "strict", "typeSymbol": "dsh-grok-search/settings#OpenConfigStatusResult", "jsonSchema": { "type": "object", "properties": { "path": { "type": "string" }, "displayPath": { "type": "string" }, "opened": { "type": "boolean" }, "exists": { "type": "boolean" }, "kind": { "type": "string" }, "editor": { "anyOf": [{ "type": "string" }, { "type": "null" }] }, "fallbackReason": { "anyOf": [{ "type": "string" }, { "type": "null" }] }, "copyOnly": { "type": "boolean" } }, "required": ["path", "opened"], "additionalProperties": false } } }, { "id": "dsh-grok-search#grokSearchSettings/diagnose", "service": "grokSearchSettings", "namespace": "grokSearchSettings", "method": "diagnose", "description": "Check every enabled source and every configured key without exposing secrets.", "invocation": { "kind": "direct" }, "parameters": [], "result": { "mode": "strict", "typeSymbol": "dsh-grok-search/settings#DiagnosticsResult", "jsonSchema": { "type": "array", "items": { "type": "object", "additionalProperties": true } } } }, { "id": "dsh-grok-search#grokSearchSettings/diagnoseProvider", "service": "grokSearchSettings", "namespace": "grokSearchSettings", "method": "diagnoseProvider", "description": "Check one search engine or source (every configured key) with a real request.", "invocation": { "kind": "direct" }, "parameters": [{ "name": "request", "wire": "request", "source": "json", "codec": { "mode": "strict", "typeSymbol": "dsh-grok-search/settings#DiagnoseProviderRequest", "jsonSchema": { "type": "object", "properties": { "provider": { "type": "string" }, "operationId": { "type": "string" }, "expectedRevision": { "type": "string" }, "configIdentity": { "type": "string" } }, "required": ["provider"], "additionalProperties": false } } }], "result": { "mode": "strict", "typeSymbol": "dsh-grok-search/settings#ProviderDiagnosis", "jsonSchema": { "type": "object", "properties": { "provider": { "type": "string" }, "status": { "type": "string" }, "code": { "type": "string" }, "message": { "type": "string" }, "elapsedMs": { "type": "number" }, "keys": { "type": "array", "items": { "type": "object", "additionalProperties": true } } }, "required": ["provider", "status", "code", "message"], "additionalProperties": true } } }, { "id": "dsh-grok-search#grokSearchSettings/cancelDiagnosis", "service": "grokSearchSettings", "namespace": "grokSearchSettings", "method": "cancelDiagnosis", "description": "Cancel only a settings diagnosis owned by this plugin; accepted requests may still be billed upstream.", "invocation": { "kind": "direct" }, "parameters": [{ "name": "request", "wire": "request", "source": "json", "codec": { "mode": "strict", "typeSymbol": "dsh-grok-search/settings#CancelDiagnosisRequest", "jsonSchema": { "type": "object", "properties": { "operationId": { "type": "string" } }, "required": ["operationId"], "additionalProperties": false } } }], "result": { "mode": "strict", "typeSymbol": "dsh-grok-search/settings#CancelDiagnosisResult", "jsonSchema": { "type": "object", "properties": { "cancelled": { "type": "boolean" } }, "required": ["cancelled"], "additionalProperties": false } } }, { "id": "dsh-grok-search#grokSearchSettings/testSearch", "service": "grokSearchSettings", "namespace": "grokSearchSettings", "method": "testSearch", "description": "Run a real test search and report fallback metadata.", "invocation": { "kind": "direct" }, "parameters": [{ "name": "request", "wire": "request", "source": "json", "codec": { "mode": "strict", "typeSymbol": "dsh-grok-search/settings#TestSearchRequest", "jsonSchema": { "type": "object", "properties": { "query": { "type": "string", "maxLength": 8192 } }, "required": ["query"], "additionalProperties": false } } }], "result": { "mode": "strict", "typeSymbol": "dsh-grok-search/settings#TestSearchResult", "jsonSchema": { "type": "object", "properties": { "sources": { "type": "array", "items": { "type": "object", "additionalProperties": true } }, "fallbackUsed": { "type": "boolean" }, "provider": { "anyOf": [{ "type": "string" }, { "type": "null" }] } }, "required": ["sources", "fallbackUsed", "provider"], "additionalProperties": false } } }, { "id": "dsh-grok-search#grokSearchSettings/preferences", "service": "grokSearchSettings", "namespace": "grokSearchSettings", "method": "preferences", "description": "Read plugin-private route preferences.", "invocation": { "kind": "direct" }, "parameters": [], "result": { "mode": "strict", "typeSymbol": "dsh-grok-search/settings#PreferencesResult", "jsonSchema": { "type": "object", "properties": { "value": { "type": "object", "additionalProperties": true }, "revision": { "type": "string" } }, "required": ["value", "revision"], "additionalProperties": false } } }, { "id": "dsh-grok-search#grokSearchSettings/savePreferences", "service": "grokSearchSettings", "namespace": "grokSearchSettings", "method": "savePreferences", "description": "Save plugin-private route preferences with CAS.", "invocation": { "kind": "direct" }, "parameters": [{ "name": "request", "wire": "request", "source": "json", "codec": { "mode": "strict", "typeSymbol": "dsh-grok-search/settings#SavePreferencesRequest", "jsonSchema": { "type": "object", "properties": { "expectedRevision": { "type": "string" }, "value": { "type": "object", "additionalProperties": true } }, "required": ["expectedRevision", "value"], "additionalProperties": false } } }], "result": { "mode": "strict", "typeSymbol": "dsh-grok-search/settings#SavePreferencesResult", "jsonSchema": { "type": "object", "properties": { "value": { "type": "object", "additionalProperties": true }, "revision": { "type": "string" } }, "required": ["value", "revision"], "additionalProperties": false } } }, { "id": "dsh-grok-search#grokSearchSettings/retryControlRelease", "service": "grokSearchSettings", "namespace": "grokSearchSettings", "method": "retryControlRelease", "description": "Retry only a previously requested incomplete release, or read the unchanged current state.", "invocation": { "kind": "direct" }, "parameters": [], "result": { "mode": "strict", "typeSymbol": "dsh-grok-search/settings#ControlRetryResult", "jsonSchema": { "type": "object", "properties": { "control": { "type": "object", "properties": { "available": { "type": "boolean" }, "phase": { "type": "string" }, "policy": { "anyOf": [{ "type": "string" }, { "type": "null" }] }, "revision": { "type": "number" }, "canStop": { "type": "boolean" }, "completionCommitted": { "type": "boolean" }, "routeVerified": { "type": "boolean" }, "routeChanged": { "type": "boolean" }, "releaseOperationId": { "anyOf": [{ "type": "string" }, { "type": "null" }] }, "error": { "anyOf": [{ "type": "object", "properties": { "code": { "type": ["string", "null"] }, "message": { "type": "string" } }, "required": ["code", "message"], "additionalProperties": false }, { "type": "null" }] } }, "required": ["available", "phase", "policy", "revision", "canStop", "completionCommitted", "routeVerified", "routeChanged", "releaseOperationId", "error"], "additionalProperties": false }, "program": { "anyOf": [{ "type": "null" }, { "type": "object", "properties": { "phase": { "type": "string" }, "program": { "anyOf": [{ "type": "object", "additionalProperties": true }, { "type": "null" }] }, "configPath": { "anyOf": [{ "type": "string" }, { "type": "null" }] }, "error": { "anyOf": [{ "type": "object", "properties": { "code": { "type": ["string", "null"] }, "message": { "type": "string" } }, "required": ["code", "message"], "additionalProperties": false }, { "type": "null" }] }, "canRepair": { "type": "boolean" }, "configuration": { "type": "object", "additionalProperties": true } }, "required": ["phase", "program", "configPath", "error"], "additionalProperties": false }] }, "config": { "type": "object", "properties": { "path": { "type": "string" }, "displayPath": { "type": "string" }, "exists": { "type": "boolean" }, "revision": { "type": "string" }, "quotaRevision": { "type": "string" }, "fields": { "type": "object", "additionalProperties": true }, "unknownFields": { "type": "array", "items": { "type": "string" } }, "error": { "anyOf": [{ "type": "object", "properties": { "code": { "type": ["string", "null"] }, "message": { "type": "string" } }, "required": ["code", "message"], "additionalProperties": false }, { "type": "null" }] } }, "required": ["path", "exists", "revision", "fields", "unknownFields"], "additionalProperties": false }, "capabilities": { "type": "object", "properties": { "secretsAllowed": { "type": "boolean" }, "transport": { "type": "string" }, "reason": { "anyOf": [{ "type": "string" }, { "type": "null" }] } }, "required": ["secretsAllowed", "transport", "reason"], "additionalProperties": false }, "route": { "anyOf": [{ "type": "null" }, { "type": "object", "properties": { "at": { "type": "number" }, "origin": { "type": "string" }, "outcome": { "type": "string" }, "served": { "anyOf": [{ "type": "string" }, { "type": "null" }] }, "grokCode": { "anyOf": [{ "type": "string" }, { "type": "null" }] }, "fallbackUsed": { "type": "boolean" }, "resultProviders": { "type": "array", "items": { "type": "string" } }, "resultProvidersComplete": { "type": "boolean" }, "provenance": { "type": "string" }, "code": { "type": "string" }, "failures": { "type": "array", "items": { "type": "object", "additionalProperties": true } } }, "required": ["at", "origin", "outcome", "served", "grokCode", "fallbackUsed", "failures"], "additionalProperties": false }] }, "plugin": { "type": "object", "properties": { "budgetMs": { "anyOf": [{ "type": "number" }, { "type": "null" }] }, "programConfigured": { "type": "boolean" }, "configSource": { "type": "string" } }, "required": ["budgetMs", "programConfigured", "configSource"], "additionalProperties": false }, "available": { "type": "boolean" }, "phase": { "type": "string" }, "policy": { "anyOf": [{ "type": "string" }, { "type": "null" }] }, "revision": { "type": "number" }, "canStop": { "type": "boolean" }, "completionCommitted": { "type": "boolean" }, "routeVerified": { "type": "boolean" }, "routeChanged": { "type": "boolean" }, "releaseOperationId": { "anyOf": [{ "type": "string" }, { "type": "null" }] }, "error": { "anyOf": [{ "type": "object", "properties": { "code": { "type": ["string", "null"] }, "message": { "type": "string" } }, "required": ["code", "message"], "additionalProperties": false }, { "type": "null" }] } }, "required": ["control", "program", "config", "capabilities", "available", "phase", "policy", "revision", "canStop", "completionCommitted", "routeVerified", "routeChanged", "releaseOperationId", "error"], "additionalProperties": false } } }, { "id": "dsh-grok-search#grokSearchSettings/stop", "service": "grokSearchSettings", "namespace": "grokSearchSettings", "method": "stop", "description": "Compatibility endpoint for older clients; native switch is preferred.", "invocation": { "kind": "direct" }, "parameters": [], "result": { "mode": "strict", "typeSymbol": "dsh-grok-search/settings#StopResult", "jsonSchema": { "type": "object", "properties": { "outcome": { "type": "object", "additionalProperties": true }, "snapshot": { "type": "object", "properties": { "available": { "type": "boolean" }, "phase": { "type": "string" }, "policy": { "anyOf": [{ "type": "string" }, { "type": "null" }] }, "revision": { "type": "number" }, "canStop": { "type": "boolean" }, "completionCommitted": { "type": "boolean" }, "routeVerified": { "type": "boolean" }, "routeChanged": { "type": "boolean" }, "releaseOperationId": { "anyOf": [{ "type": "string" }, { "type": "null" }] }, "error": { "anyOf": [{ "type": "object", "properties": { "code": { "type": ["string", "null"] }, "message": { "type": "string" } }, "required": ["code", "message"], "additionalProperties": false }, { "type": "null" }] } }, "required": ["available", "phase", "policy", "revision", "canStop", "completionCommitted", "routeVerified", "routeChanged", "releaseOperationId", "error"], "additionalProperties": false } }, "required": ["outcome", "snapshot"], "additionalProperties": false } } }];
  var TOOL_ROUTE_CSS = '.dsg-chat{--surface:#fff;--soft:#f6f7f9;--line:#e6e8ed;--line-strong:#d7dbe3;--text:#242831;--secondary:#626b79;--muted:#707987;--blue:#5267df;--blue-soft:#eef1ff;--green:#23734d;--red:#b74648;--amber:#97631b;--route-flow:#4d6bfe;--route-back:#b86e00;--route-dead:#e5484d;--shadow:0 1px 3px #16274306,0 5px 18px #16274303;--ease:cubic-bezier(.2,.75,.25,1);min-width:0;color:var(--text);font-family:inherit;container-type:inline-size}\n.dsg-chat[data-theme=dark]{--surface:#1e2026;--soft:#25282f;--line:#343841;--line-strong:#454b58;--text:#e7e9ee;--secondary:#b0b7c4;--muted:#9ca6b7;--blue:#a2b0ff;--blue-soft:#2c3452;--green:#7dd8a2;--red:#f39698;--amber:#edc17d;--route-flow:#7b93ff;--route-back:#f0b04a;--route-dead:#ff6b70;--shadow:0 1px 3px #0002,0 5px 18px #0001}\n.dsg-chat *{box-sizing:border-box}\n.dsg-chat button{font:inherit;color:inherit;cursor:pointer;border:0;background:none}\n.dsg-chat button:focus-visible,.dsg-chat a:focus-visible,.dsg-chat summary:focus-visible,.dsg-chat .flow-scroll:focus-visible{outline:2px solid var(--blue);outline-offset:1px;border-radius:4px}\n.dsg-chat .icon{width:14px;height:14px;flex:none;stroke:currentColor;stroke-width:1.6;fill:none;stroke-linecap:round;stroke-linejoin:round}\n.dsg-chat .logo{width:14px;height:14px;flex:none;object-fit:contain}\n.dsg-chat .search-card{border:1px solid var(--line);border-radius:11px;background:var(--surface);overflow:hidden;box-shadow:var(--shadow)}\n.dsg-chat .card-header{display:flex;align-items:center;min-height:50px;padding:0 11px 0 14px;gap:0}\n.dsg-chat .card-toggle{display:flex;align-items:center;gap:9px;min-width:0;flex:1;align-self:stretch;padding:12px 0;text-align:left}\n.dsg-chat .plugin-mark{display:grid;place-items:center;color:var(--blue);width:21px;height:24px;flex:none}\n.dsg-chat .plugin-mark .icon{width:18px;height:18px}\n.dsg-chat .card-name{font-size:13px;font-weight:650;white-space:nowrap;letter-spacing:-.15px}\n.dsg-chat .tool-type,.dsg-chat .title-dot{font-size:12px;white-space:nowrap;color:var(--secondary)}\n.dsg-chat .query-summary{min-width:0;flex:1;font-size:12px;color:var(--secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding-left:5px}\n.dsg-chat .header-right{display:flex;align-items:center;gap:12px;flex:none;margin-left:auto;padding-left:8px}\n.dsg-chat .state{display:inline-flex;align-items:center;gap:5px;color:var(--green);font-size:12px;white-space:nowrap}\n.dsg-chat .state[data-state=running]{color:var(--blue)}\n.dsg-chat .state[data-state=failed]{color:var(--red)}\n.dsg-chat .state[data-state=cancelled],.dsg-chat .state[data-state=unknown]{color:var(--muted)}\n.dsg-chat .elapsed{font-size:12px;white-space:nowrap;color:var(--secondary);font-variant-numeric:tabular-nums;min-width:36px;text-align:right}\n.dsg-chat .chevron{width:14px;height:14px;color:var(--muted);transition:transform .18s var(--ease)}\n.dsg-chat .search-card[data-open=true] .chevron{transform:rotate(90deg)}\n.dsg-chat .inspect-btn{display:grid;place-items:center;width:28px;height:30px;border-radius:5px;margin-left:4px;flex:none;color:var(--muted)}\n.dsg-chat .inspect-btn:hover{background:var(--soft);color:var(--text)}\n.dsg-chat .fold{display:grid;grid-template-rows:0fr;transition:grid-template-rows .12s var(--ease)}\n.dsg-chat .search-card[data-open=true] .fold{grid-template-rows:1fr;transition-duration:.18s}\n.dsg-chat .fold-inner{min-width:0;min-height:0;overflow:hidden}\n.dsg-chat .card-body{border-top:1px solid var(--line);padding:14px 17px 15px}\n.dsg-chat .section-line{display:flex;justify-content:space-between;align-items:center;gap:12px;margin:0 0 9px}\n.dsg-chat .section-caption{font-size:12px;color:var(--secondary);font-weight:500}\n.dsg-chat .wire-name{display:flex;align-items:center;gap:5px;font:11px/1.5 ui-monospace,monospace;color:var(--muted)}\n.dsg-chat .wire-name .icon{width:12px;height:12px}\n.dsg-chat .flow-scroll{max-width:100%;min-width:0;overflow-x:auto;overflow-y:hidden;overscroll-behavior-x:contain;padding:3px 3px 7px;margin:-3px -3px 2px;scrollbar-width:thin;scrollbar-color:var(--line-strong) transparent}\n.dsg-chat .flow{display:flex;align-items:flex-start;width:max-content;min-width:0}\n.dsg-chat .ingress{display:flex;align-items:flex-start;flex:none}\n.dsg-chat .route-node{--arrival-delay:0ms;display:flex;flex-direction:column;align-items:flex-start;justify-content:center;min-width:0;min-height:44px;padding:5px 8px;border:1px solid var(--line);border-radius:6px;background:var(--soft);position:relative;transition:border-color .24s var(--ease),background-color .24s var(--ease),opacity .24s var(--ease)}\n.dsg-chat .route-node::before,.dsg-chat .route-node::after{content:"";position:absolute;inset:-1px;border:1px solid var(--blue);border-radius:inherit;pointer-events:none;opacity:0}\n.dsg-chat .route-node::before{box-shadow:0 0 0 2px color-mix(in srgb,var(--blue) 9%,transparent),0 0 10px color-mix(in srgb,var(--blue) 14%,transparent)}\n.dsg-chat .route-node[data-feedback=receive]::before{animation:dsg-arrival .6s var(--ease) var(--arrival-delay) both}\n.dsg-chat .route-node[data-recovery=true]{--arrival-delay:480ms}\n.dsg-chat .route-node[data-feedback=failed]{animation:dsg-jolt .32s ease-out}\n.dsg-chat .route-node[data-feedback=failed]::before{border-color:var(--route-dead);box-shadow:0 0 0 2px color-mix(in srgb,var(--route-dead) 8%,transparent),0 0 10px color-mix(in srgb,var(--route-dead) 12%,transparent);animation:dsg-fault .58s ease-out}\n.dsg-chat .route-node[data-feedback=success]::before{border-color:var(--green);box-shadow:0 0 0 2px color-mix(in srgb,var(--green) 7%,transparent);animation:dsg-settle .6s ease-out}\n.dsg-chat .route-node[data-feedback=success] .route-note .icon{animation:dsg-check .38s var(--ease)}\n.dsg-chat .ingress .route-node:first-child{min-width:62px}\n.dsg-chat .ingress .route-node:last-child{min-width:120px}\n.dsg-chat .route-name{display:flex;align-items:center;gap:6px;white-space:nowrap;font-size:12px;font-weight:500;line-height:16px}\n.dsg-chat .route-name .icon{color:var(--blue)}\n.dsg-chat .route-note{display:flex;align-items:center;gap:4px;margin-top:2px;font-size:11px;line-height:14px;color:var(--muted);min-height:14px;white-space:nowrap}\n.dsg-chat .route-note .icon{width:11px;height:11px}\n.dsg-chat .edge{--wire-color:var(--line-strong);--flight-time:380ms;--flight-delay:40ms;display:block;position:relative;width:26px;height:12px;min-width:26px;flex:0 0 26px;margin-top:16px;color:var(--wire-color)}\n.dsg-chat .wire-svg{display:block;width:100%;height:100%;overflow:visible;fill:none;stroke:currentColor;stroke-width:1;stroke-linecap:butt;stroke-linejoin:miter}\n.dsg-chat .wire-svg path{vector-effect:non-scaling-stroke}\n.dsg-chat .wire-flow{opacity:0;stroke-width:1.8;stroke:currentColor;stroke-linecap:round;stroke-dasharray:22 178;stroke-dashoffset:22}\n.dsg-chat .wire-halo{stroke-width:5;filter:blur(1px)}\n.dsg-chat .wire-tip{stroke-width:2.2;stroke-dasharray:3 197;stroke-dashoffset:3;filter:drop-shadow(0 0 1.6px currentColor)}\n/* Completed/pending edges keep their static track and head, but do not retain\n   invisible blur/drop-shadow surfaces. Active edge light effects stay intact. */\n.dsg-chat .edge:not(.active) .wire-flow{display:none}\n.dsg-chat .edge[data-wire=passed],.dsg-chat .edge.active{--wire-color:var(--route-flow)}\n.dsg-chat .edge[data-wire=recovered],.dsg-chat .edge.active[data-tone=back]{--wire-color:var(--route-back)}\n.dsg-chat .edge[data-wire=dead]{--wire-color:var(--route-dead)}\n.dsg-chat .edge:is([data-wire=dead],[data-wire=pending],[data-wire=idle]) .wire-track{stroke-dasharray:3 3}\n.dsg-chat .edge:is([data-wire=dead],[data-wire=pending],[data-wire=idle]) .wire-head{display:none}\n.dsg-chat .edge[data-wire=pending]{opacity:.45}\n.dsg-chat .edge.active .wire-flow{animation:dsg-travel var(--flight-time) cubic-bezier(.25,.1,.3,1) var(--flight-delay) both}\n.dsg-chat .edge.active .wire-halo{animation-name:dsg-halo}\n.dsg-chat .edge.active .wire-tip{animation-name:dsg-tip}\n.dsg-chat .edge[data-edge=dsh-hub]{--flight-time:560ms;--flight-delay:60ms}\n.dsg-chat .edge.active[data-tone=back]{--flight-delay:140ms}\n.dsg-chat .edge.source-link .wire-track{stroke-dasharray:3 3}\n.dsg-chat .ingress>.edge{flex:none}\n.dsg-chat .bridge{width:28px;min-width:28px;flex:0 0 28px}\n.dsg-chat .provider-steps{display:flex;align-items:flex-start;flex:none;min-width:0}\n.dsg-chat .provider-steps>.route-node{flex:none;min-width:112px}\n.dsg-chat .provider-steps>.edge{min-width:26px;flex:0 0 26px}\n.dsg-chat .route-node[data-result=ok] .route-note{color:var(--green)}\n.dsg-chat .route-node[data-result=failed] .route-note{color:var(--amber)}\n.dsg-chat .flow[data-terminal=failed] .route-node[data-result=failed] .route-note{color:var(--red)}\n.dsg-chat .route-node[data-result=running]{border-color:color-mix(in srgb,var(--blue) 58%,var(--line));background:var(--blue-soft)}\n.dsg-chat .route-node[data-result=running]::after{box-shadow:0 0 0 2px color-mix(in srgb,var(--blue) 6%,transparent);animation:dsg-breathe 1.8s ease-in-out calc(var(--arrival-delay) + 350ms) infinite}\n.dsg-chat .route-node[data-result=running] .route-note{color:var(--blue)}\n.dsg-chat .route-node[data-result=pending]{opacity:.55}\n.dsg-chat .ingress .route-node[data-result=ok] .route-note{color:var(--muted)}\n.dsg-chat .source-evidence{border-style:dashed}\n.dsg-chat .cause{display:flex;align-items:flex-start;gap:6px;margin:0;font-size:12px;line-height:1.7;color:var(--secondary)}\n.dsg-chat .cause>.icon{color:var(--amber);width:13px;height:13px;margin-top:4px}\n.dsg-chat .results{border-top:1px solid var(--line);margin-top:13px;padding-top:11px}\n.dsg-chat .results[data-feedback=success]{animation:dsg-results .26s var(--ease)}\n.dsg-chat .results-heading{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;font-size:12px;color:var(--secondary)}\n.dsg-chat .results-count{color:var(--muted);font-size:11px}\n.dsg-chat .source-list{display:grid;gap:8px}\n.dsg-chat .source-row{display:flex;align-items:flex-start;gap:9px;min-width:0;text-decoration:none;color:var(--text)}\n.dsg-chat .source-num{width:18px;height:18px;display:grid;place-items:center;border-radius:4px;background:var(--soft);border:1px solid var(--line);font:10px/1 ui-monospace,monospace;color:var(--secondary);margin-top:2px;flex:none}\n.dsg-chat .source-copy{min-width:0;flex:1;display:flex;align-items:baseline;justify-content:space-between;gap:14px}\n.dsg-chat .source-title{font-size:12.5px;line-height:1.6;overflow-wrap:anywhere}\n.dsg-chat .source-domain{font-size:11px;line-height:1.7;color:var(--muted);flex:none}\n.dsg-chat .source-copy .source-domain{white-space:nowrap}\n.dsg-chat .source-row>.icon{color:var(--muted);width:12px;height:12px;opacity:0;margin-top:4px}\n.dsg-chat .source-row:hover .source-title{text-decoration:underline;text-underline-offset:3px;color:var(--blue)}\n.dsg-chat .source-row:hover>.icon,.dsg-chat .source-row:focus-visible>.icon{opacity:1}\n.dsg-chat .source-extra,.dsg-chat .answer-summary{margin:4px 0 0 27px;color:var(--secondary);font-size:12px;line-height:1.75;overflow-wrap:anywhere;white-space:pre-wrap}\n.dsg-chat .answer-summary{margin:8px 0}\n.dsg-chat .outcome-note{font-size:12px;color:var(--secondary);margin:0;line-height:1.75;overflow-wrap:anywhere;white-space:pre-wrap}\n.dsg-chat .batch-list{display:grid;grid-template-columns:minmax(0,1fr);gap:14px}\n.dsg-chat .query-block{min-width:0}\n.dsg-chat .query-block+.query-block{padding-top:13px;border-top:1px solid var(--line)}\n.dsg-chat .query-head{display:flex;gap:8px;align-items:baseline;margin-bottom:11px;font-size:12px;line-height:1.65}\n.dsg-chat .query-number{color:var(--muted);font:11px ui-monospace,monospace;flex:none}\n.dsg-chat .query-text{font-weight:500;overflow-wrap:anywhere;min-width:0}\n.dsg-chat .query-head .state{margin-left:auto}\n.dsg-chat .spinner{animation:dsg-spin 1.3s linear infinite}\n.dsg-chat .dsg-tool-attribution{display:block;margin:2px 0 5px 20px;font-size:12px;line-height:1.6;color:var(--secondary);overflow-wrap:anywhere}\n.dsg-chat .search-card[data-open=false] .card-body *,.dsg-chat .search-card[data-open=false] .card-body *::before,.dsg-chat .search-card[data-open=false] .card-body *::after,\n.dsg-chat[data-visible=false] *,.dsg-chat[data-visible=false] *::before,.dsg-chat[data-visible=false] *::after{animation-play-state:paused!important}\n.dsg-chat[data-motion=reduce] *,.dsg-chat[data-motion=reduce] *::before,.dsg-chat[data-motion=reduce] *::after{animation:none!important;transition:none!important}\n@keyframes dsg-spin{to{transform:rotate(360deg)}}\n@keyframes dsg-travel{from{stroke-dashoffset:22;opacity:0}12%,76%{opacity:.8}to{stroke-dashoffset:-100;opacity:0}}\n@keyframes dsg-halo{from{stroke-dashoffset:22;opacity:0}12%,76%{opacity:.2}to{stroke-dashoffset:-100;opacity:0}}\n@keyframes dsg-tip{from{stroke-dashoffset:3;opacity:0}12%,76%{opacity:1}to{stroke-dashoffset:-119;opacity:0}}\n@keyframes dsg-arrival{0%{opacity:0;transform:scale(.995)}22%{opacity:.85}100%{opacity:0;transform:scale(1.025)}}\n@keyframes dsg-breathe{0%,100%{opacity:.12}50%{opacity:.46}}\n@keyframes dsg-jolt{0%,100%{transform:translateX(0)}18%{transform:translateX(-1.2px)}38%{transform:translateX(1px)}60%{transform:translateX(-.6px)}80%{transform:translateX(.25px)}}\n@keyframes dsg-fault{0%{opacity:0}18%,42%{opacity:.9}100%{opacity:0}}\n@keyframes dsg-settle{0%{opacity:.65;transform:scale(1)}100%{opacity:0;transform:scale(1.02)}}\n@keyframes dsg-check{0%{opacity:.4;transform:scale(.82)}65%{opacity:1;transform:scale(1.08)}100%{transform:scale(1)}}\n@keyframes dsg-results{from{opacity:.45;transform:translateY(3px)}to{opacity:1;transform:translateY(0)}}\n@container(max-width:600px){\n .dsg-chat .query-summary,.dsg-chat .tool-type,.dsg-chat .title-dot{display:none}\n .dsg-chat .card-header{padding-inline:10px}.dsg-chat .card-toggle{gap:6px}.dsg-chat .header-right{gap:7px;padding-left:0}\n .dsg-chat .source-copy{display:block}.dsg-chat .source-copy .source-domain{display:block;white-space:normal;overflow-wrap:anywhere}\n}\n@container(max-width:380px){\n .dsg-chat .card-name{font-size:12px}.dsg-chat .state,.dsg-chat .elapsed{font-size:11px}.dsg-chat .header-right{gap:5px}\n .dsg-chat .card-body{padding:13px}.dsg-chat .inspect-btn{width:24px;margin-left:0}.dsg-chat .query-head{flex-wrap:wrap}\n}\n@container(max-width:310px){.dsg-chat .elapsed{display:none}.dsg-chat .card-toggle{gap:4px}.dsg-chat .card-header{padding-inline:8px}}\n@media(prefers-reduced-motion:reduce){.dsg-chat *,.dsg-chat *::before,.dsg-chat *::after{animation:none!important;transition:none!important}}\n';
  var ROUTE_CSS = `/* dsh-grok-search · v74 route presentation
   视觉方向：magpie 式单色中性底 + 一处 agent 蓝；节点/连线/数据包组成动态路由图。 */

:host,.dsg-surface{
  --font:"Inter","Segoe UI Variable Text","Segoe UI",-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei UI","Microsoft YaHei",sans-serif;
  --mono:"JetBrains Mono","Cascadia Mono",Consolas,"SFMono-Regular",ui-monospace,monospace;
  --ease:cubic-bezier(.2,.7,.2,1);
  --spring:cubic-bezier(.34,1.45,.64,1);
  color-scheme:light;
  --page:#eef0f3; --surface:#ffffff; --surface-2:#f7f8fa; --stage:#f4f5f8; --dot:#dde0e6;
  --line:#e5e7eb; --line-2:#d5d8de; --hair:rgba(15,23,42,.06);
  --text:#14161a; --text-2:#545a66; --text-3:#626a77; --text-4:#767e8b;
  --field:#f1f2f5; --field-hover:#eaecf0; --field-focus:#ffffff;
  --agent:#4d6bfe; --agent-soft:rgba(77,107,254,.10); --agent-ring:rgba(77,107,254,.30); --agent-text:#3559d8;
  --btn-primary:#4561ed; --btn-primary-hover:#3d59e8;
  --ok:#12a150; --ok-soft:rgba(18,161,80,.10); --ok-text:#0a7a3b;
  --warn:#b86e00; --warn-soft:rgba(214,138,0,.11); --warn-line:#e0a23a; --warn-text:#8c5a00;
  --err:#e5484d; --err-soft:rgba(229,72,77,.10); --err-text:#b32429; --err-solid:#a92a30;
  --wire-standby:#a6acb7; --wire-rest:#c0c5cd; --wire-unset:#cdd1d8; --wire-aux:#b4bac4;
  --wire-broken:#a8595c; --wire-broken-soft:#c49a9c;
  --tile:#f3f4f6; --tile-line:rgba(15,23,42,.08);
  --shadow-sm:0 1px 2px rgba(15,23,42,.05);
  --shadow-md:0 1px 2px rgba(15,23,42,.05),0 4px 14px rgba(15,23,42,.06);
  --shadow-lg:0 2px 6px rgba(15,23,42,.06),0 22px 56px rgba(15,23,42,.16);
  --shadow-drag:0 12px 32px rgba(15,23,42,.18),0 2px 6px rgba(15,23,42,.08);
  --scrim:rgba(17,20,26,.34);
  --toast-bg:#1b1d22; --toast-text:#f3f4f6; --toast-act:rgba(255,255,255,.12);
}
[data-theme=dark]{
  color-scheme:dark;
  --page:#0c0d10; --surface:#16181c; --surface-2:#1b1d22; --stage:#111316; --dot:#24272d;
  --line:#272a31; --line-2:#353941; --hair:rgba(255,255,255,.06);
  --text:#ecedf0; --text-2:#a6abb5; --text-3:#9aa1ac; --text-4:#929aa7;
  --field:#1f2227; --field-hover:#252930; --field-focus:#121417;
  --agent:#7b93ff; --agent-soft:rgba(123,147,255,.14); --agent-ring:rgba(123,147,255,.34); --agent-text:#9eb0ff;
  --btn-primary:#4561ed; --btn-primary-hover:#3d59e8;
  --ok:#3ccb7f; --ok-soft:rgba(60,203,127,.12); --ok-text:#3ccb7f;
  --warn:#f0b04a; --warn-soft:rgba(240,176,74,.12); --warn-line:#c98b2a; --warn-text:#f0b04a;
  --err:#ff6b70; --err-soft:rgba(255,107,112,.13); --err-text:#ff7b80; --err-solid:#b23b41;
  --wire-standby:#5f6570; --wire-rest:#464b54; --wire-unset:#3c4048; --wire-aux:#525862;
  --wire-broken:#b0696c; --wire-broken-soft:#6e4649;
  --tile:#22252b; --tile-line:rgba(255,255,255,.08);
  --shadow-sm:0 1px 2px rgba(0,0,0,.4);
  --shadow-md:0 1px 2px rgba(0,0,0,.35),0 6px 18px rgba(0,0,0,.32);
  --shadow-lg:0 2px 8px rgba(0,0,0,.4),0 26px 64px rgba(0,0,0,.55);
  --shadow-drag:0 14px 36px rgba(0,0,0,.55),0 2px 6px rgba(0,0,0,.4);
  --scrim:rgba(0,0,0,.56);
  --toast-bg:#eceef2; --toast-text:#15171b; --toast-act:rgba(0,0,0,.08);
}

*,*::before,*::after{box-sizing:border-box}
[hidden]{display:none !important}
:host{all:initial;display:block;min-width:0}
.dsg-surface{font:13px/1.5 var(--font);color:var(--text);-webkit-font-smoothing:antialiased;text-align:left}
.dsg-root{width:100%;min-width:0;container-type:inline-size}
/* The host detail is normally 960px, not the standalone mockup's 1016px.
   Keep one fluid canvas; shadows remain visible without a nested scrollport. */
.route-scroll{display:flow-root;width:100%;min-width:0}
.dsg-layer{width:0;height:0;pointer-events:none}
.dsg-layer .overlay,.dsg-layer .route-tooltip{pointer-events:auto}
button,input,select,textarea{font:inherit;color:inherit}
button{cursor:pointer}
button:disabled{cursor:not-allowed}
a{color:inherit}
:focus-visible{outline:2px solid var(--agent);outline-offset:2px}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.ic{width:16px;height:16px;flex:none;display:block}
.ic-sm{width:13px;height:13px}

/* ---------- 路由卡 ---------- */
.plugin-intro{margin:0 0 18px;padding:12px 0;border-block:.5px solid var(--line-2)}
.intro-title{display:flex;align-items:center;gap:7px;margin:0 0 4px;font-size:15px;line-height:22px;font-weight:600;letter-spacing:.01em}
.intro-github{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:5px;opacity:.68;transition:opacity 140ms var(--ease),background-color 140ms var(--ease)}
.intro-github .tile{width:15px;height:15px;background:none;box-shadow:none}
.intro-github:hover,.intro-github:focus-visible{opacity:1;background:var(--surface-2)}
.intro-illustration{position:relative;width:min(502px,100%);height:44px;margin:0;user-select:none}
.intro-illustration::before{content:"";position:absolute;left:30px;top:21.5px;width:32px;height:1px;background:color-mix(in srgb,var(--agent) 38%,var(--line))}
.intro-network{position:relative;width:calc(100% - 62px);height:44px;margin-left:62px}
.intro-lines{position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none}
.intro-branch{stroke:color-mix(in srgb,var(--agent) 38%,var(--line));stroke-width:1;stroke-linecap:round;stroke-linejoin:round}
.intro-junction{fill:var(--agent)}
.intro-core{position:absolute;left:0;top:9px;width:26px;height:26px;display:grid;place-items:center;color:var(--agent-text);border-radius:6px}
.intro-core svg{width:22px;height:22px}
.intro-source,.intro-host{position:absolute;display:grid;place-items:center;width:30px;height:30px;border:1px solid var(--line);border-radius:9px;background:var(--surface);box-shadow:0 1px 2px var(--hair)}
.intro-source{top:12px;transform:translateX(-50%)}
.intro-host{left:0;top:7px}
.intro-source-grok{left:23.409%}.intro-source-tavily{left:41.136%}.intro-source-exa{left:58.864%}.intro-source-firecrawl{left:76.591%}.intro-source-tinyfish{left:94.318%}
.intro-source .tile,.intro-host .tile{width:22px;height:22px;border-radius:5px;box-shadow:none}
.intro-source,.intro-core,.intro-host{text-decoration:none;transition:border-color 140ms var(--ease),background-color 140ms var(--ease),box-shadow 140ms var(--ease)}
.intro-source:hover,.intro-host:hover{border-color:var(--agent-ring);background:var(--surface-2);box-shadow:0 0 0 2px var(--agent-soft)}
.intro-core:hover{background:var(--agent-soft)}
@media(prefers-reduced-motion:reduce){.intro-source,.intro-core,.intro-host,.intro-github{transition:none}}
.route-card{position:relative;width:100%;min-width:0;background:var(--surface);border:1px solid var(--line);border-radius:18px;box-shadow:var(--shadow-md);padding:18px 20px 0;transition:background-color .25s,border-color .25s}
.rc-head{position:relative;display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:8px 12px}
.rc-title{display:flex;align-items:center;align-content:center;flex-wrap:wrap;gap:4px 10px;min-width:0;min-height:32px}
.rc-title h3{margin:0;font-size:15px;font-weight:650;letter-spacing:-.005em;white-space:nowrap}
.rc-actions{position:relative;display:flex;align-items:center;justify-content:flex-end;gap:12px;flex-wrap:wrap;flex:0 1 auto;min-width:0;max-width:100%;margin-left:auto}

/* 顺序 = 补充链优先级；logo = 启用状态；圆点 = 最近验证结果，三者不互相冒充。 */
.strip-slot{flex:0 1 auto;min-width:0;max-width:100%;display:grid;grid-template-rows:0fr;opacity:0;transition:grid-template-rows .3s var(--ease),opacity .25s var(--ease)}
.strip-slot.has{grid-template-rows:1fr;opacity:1}
.strip-slot:not(.has){display:none}
.strip-slot > div{overflow:hidden;min-height:0}
.strip{display:flex;align-items:center;flex-wrap:nowrap;gap:6px;min-height:30px;padding:3px 8px 4px;border-radius:8px;background:color-mix(in srgb,var(--surface-2) 78%,transparent);box-shadow:inset 0 0 0 1px var(--hair);color:var(--text-3)}
.strip .s-node{position:relative;display:inline-flex;flex:none;padding-bottom:5px;opacity:1;border-radius:3px;cursor:help;transition:opacity .32s var(--ease),filter .32s var(--ease)}
.strip .s-node .tile{border-radius:4px}
.strip .s-node[data-st=unset] .tile{filter:grayscale(1);opacity:.45}
.strip .s-node[data-st=off] .tile{filter:grayscale(1);opacity:.28}
.strip .s-node:focus-visible{outline:2px solid var(--agent);outline-offset:2px}
.strip .s-dots{position:absolute;left:50%;bottom:0;display:flex;align-items:center;gap:2px;transform:translateX(-50%)}
.strip .s-dot{width:4px;height:4px;border-radius:50%;border:1px solid var(--text-4);background:transparent;transition:border-color .3s,background-color .3s,opacity .3s}
.strip .s-dot[data-tone=ok]{border-color:var(--agent);background:var(--agent)}
.strip .s-dot[data-tone=err]{border-color:var(--wire-broken);background:transparent}
.strip .s-dot[data-tone=run]{border-color:var(--agent);background:var(--agent);animation:s-pulse 1s var(--ease) infinite}
.strip .s-dot[data-tone=idle]{border-color:var(--text-2);background:transparent}
.strip .s-link{align-self:flex-start;flex:none;width:20px;height:8px;margin-top:5px;display:block;overflow:visible;color:var(--text-3);transition:color .3s var(--ease),opacity .3s var(--ease)}
.strip .s-link .sl-line{fill:none;stroke:currentColor;stroke-width:1.25;stroke-linecap:round}
.strip .s-link .sl-head{fill:none;stroke:currentColor;stroke-width:1.25;stroke-linecap:round;stroke-linejoin:round}
.strip .s-link[data-tone=dash] .sl-line,.strip .s-link[data-tone=dash] .sl-head{stroke-dasharray:2 3;opacity:.55}
.strip .s-link[data-tone=broken]{color:var(--wire-broken);overflow:visible}
.strip .s-link[data-tone=detour]{color:var(--warn-line);overflow:visible}
.strip .s-link[data-tone=detour] .sl-arc{fill:none;stroke:currentColor;stroke-width:1.25;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:1;stroke-dashoffset:0;animation:s-draw .55s var(--ease) both}
.strip .s-link[data-tone=detour] .sl-head{stroke-dasharray:0}
.strip .s-link.is-new{animation:s-fade-in .3s var(--ease)}
.strip .s-end{margin-left:2px;padding-left:10px;border-left:1px solid var(--line-2);font-size:11.5px;line-height:1.5;color:var(--text-3);white-space:nowrap;font-variant-numeric:tabular-nums}
.strip .s-end[data-tone=err]{color:var(--wire-broken)}
.strip .s-end[data-tone=ok]{color:var(--text-2)}
.strip .s-end.is-new{animation:s-fade-in .3s var(--ease)}
.strip .s-skel{display:block;flex:none;height:16px;border-radius:4px;background:linear-gradient(90deg,var(--field) 0 30%,var(--field-hover) 50%,var(--field) 70%) 0 0/300% 100%;animation:shimmer 1.2s linear infinite}
@keyframes s-pulse{0%,100%{transform:scale(1);opacity:.5}50%{transform:scale(1.35);opacity:1}}
@keyframes s-fade-in{from{opacity:0;transform:translateX(-3px)}}
@keyframes s-draw{from{stroke-dashoffset:1}}
.route-tooltip{position:fixed;z-index:65;max-width:min(310px,calc(100vw - 24px));padding:10px 12px;border:1px solid var(--line-2);border-radius:9px;background:var(--surface);box-shadow:var(--shadow-md);color:var(--text-2);font:12px/1.6 var(--font);white-space:pre-line;overflow-wrap:anywhere;pointer-events:auto}
.route-tooltip[hidden]{display:none}
.banner-slot{display:grid;grid-template-rows:0fr;margin-top:0;transition:grid-template-rows .32s var(--ease),margin-top .32s var(--ease)}
.banner-slot.has{grid-template-rows:1fr;margin-top:12px}
.banner-slot > div{overflow:hidden;min-width:0;min-height:0}

/* 状态胶囊 */
.pill{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 9px 0 8px;border-radius:999px;font-size:11.5px;font-weight:600;background:var(--surface-2);color:var(--text-2);border:1px solid var(--line);white-space:nowrap;transition:background-color .25s,color .25s,border-color .25s}
.pill-dot{position:relative;width:7px;height:7px;border-radius:50%;background:currentColor;flex:none}
.pill[data-s=live]{color:var(--ok-text);background:var(--ok-soft);border-color:transparent}
.pill[data-s=live] .pill-dot::after,.pill[data-s=fallback] .pill-dot::after,.pill[data-s=backup] .pill-dot::after{content:"";position:absolute;inset:-3px;border-radius:50%;border:1.5px solid currentColor;opacity:0;animation:ping 2.4s var(--ease) infinite}
.pill[data-s=wait]{color:var(--warn-text);background:var(--warn-soft);border-color:transparent}
.pill[data-s=none]{color:var(--warn-text);background:var(--warn-soft);border-color:transparent}
.pill[data-s=fallback]{color:var(--warn-text);background:var(--warn-soft);border-color:transparent}
.pill[data-s=backup]{color:var(--agent);background:var(--agent-soft);border-color:transparent}
.pill[data-s=err]{color:var(--err-text);background:var(--err-soft);border-color:transparent}
.pill[data-s=cfgerr],.pill[data-s=ctlerr],.pill[data-s=down]{color:var(--err-text);background:var(--err-soft);border-color:transparent}
.pill[data-s=prep],.pill[data-s=connecting]{color:var(--text-3);background:var(--surface-2)}
.pill[data-s=prep] .pill-dot,.pill[data-s=connecting] .pill-dot{animation:blink 1s steps(2,jump-none) infinite}
.pill[data-s=off]{color:var(--text-2)}
.pill[data-s=load]{color:var(--text-3)}
.pill[data-s=load] .pill-dot{animation:blink 1s steps(2,jump-none) infinite}
.pill.swap{animation:pill-swap .42s var(--spring)}
@keyframes pill-swap{from{transform:scale(.86);opacity:.35}}
@keyframes ping{0%{transform:scale(.6);opacity:.7}70%,100%{transform:scale(1.9);opacity:0}}
@keyframes blink{50%{opacity:.2}}

/* 按钮 */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 12px;border-radius:9px;border:1px solid var(--line-2);background:var(--surface);color:var(--text);font-size:12.5px;font-weight:550;line-height:1;white-space:nowrap;box-shadow:var(--shadow-sm);transition:background-color .15s,border-color .15s,color .15s,box-shadow .15s,transform .1s,opacity .15s}
.btn:hover:not(:disabled){background:var(--surface-2)}
.btn:active:not(:disabled){transform:translateY(.5px)}
.btn:disabled{opacity:.48}
.btn-sm{height:28px;padding:0 10px;font-size:12px;border-radius:8px}
.btn-ghost{background:transparent;border-color:transparent;box-shadow:none;color:var(--text-2)}
.btn-ghost:hover:not(:disabled){background:var(--field);color:var(--text)}
.btn-primary{background:var(--btn-primary);border-color:var(--btn-primary);color:#fff}
.btn-primary:hover:not(:disabled){background:var(--btn-primary-hover);border-color:var(--btn-primary-hover)}
.btn-danger{color:var(--err-text)}
.btn-danger:hover:not(:disabled){background:var(--err-soft);color:var(--err-text)}
.btn.is-confirm,.btn.is-confirm:hover:not(:disabled){background:var(--err-solid);border-color:var(--err-solid);color:#fff}
.btn .spin,.spin{width:13px;height:13px;flex:none;border-radius:50%;border:1.7px solid currentColor;border-right-color:transparent;animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.icon-btn{width:28px;height:28px;flex:none;padding:0;display:inline-grid;place-items:center;border-radius:7px;border:0;background:transparent;color:var(--text-3);transition:background-color .15s,color .15s}
.icon-btn:hover:not(:disabled){background:var(--field-hover);color:var(--text)}
.icon-btn.is-on{color:var(--agent)}
.icon-btn:disabled{opacity:.4}

/* 测试确认弹层 */
.popover{position:absolute;right:0;top:calc(100% + 9px);z-index:20;width:268px;background:var(--surface);border:1px solid var(--line);border-radius:12px;box-shadow:var(--shadow-lg);padding:12px 14px;transform-origin:top right;animation:pop-in .16s var(--ease)}
.popover::before{content:"";position:absolute;top:-6px;right:30px;width:10px;height:10px;background:var(--surface);border-left:1px solid var(--line);border-top:1px solid var(--line);transform:rotate(45deg)}
.pop-title{margin:0;font-weight:650;font-size:13px}
.pop-text{margin:4px 0 12px;color:var(--text-2);font-size:12px;line-height:1.55}
.pop-actions{display:flex;justify-content:flex-end;gap:6px}
@keyframes pop-in{from{opacity:0;transform:translateY(-4px) scale(.97)}}

/* 提示条 */
.banner{display:flex;align-items:flex-start;gap:10px;padding:10px 10px 10px 12px;border-radius:12px;border:1px solid var(--line);background:var(--surface-2);font-size:12.5px;color:var(--text-2)}
.banner .b-ic{flex:none;margin-top:1px;color:var(--text-3)}
.banner .b-body{flex:1;min-width:0}
.banner .b-title{display:block;color:var(--text);font-weight:600}
.banner .b-text{display:block;margin-top:1px}
.banner .b-text code{white-space:normal;overflow-wrap:anywhere}
.banner .b-actions{display:flex;gap:4px;align-items:center;flex:none;align-self:center}
.banner[data-tone=info] .b-ic{color:var(--agent)}
.banner[data-tone=warn]{background:var(--warn-soft);border-color:transparent}
.banner[data-tone=warn] .b-ic{color:var(--warn)}
.banner[data-tone=err]{background:var(--surface-2);border-color:var(--line-2)}
.banner[data-tone=err] .b-ic{color:var(--err-text)}
.banner[data-tone=err] .b-title{color:var(--err-text)}
.banner[data-tone=err] .b-text{color:var(--text-2)}
.banner[data-tone=fallback]{background:var(--warn-soft);border-color:transparent}
.banner[data-tone=fallback] .b-ic{color:var(--warn)}
.banner[data-tone=soft] .b-ic{color:var(--warn)}
.b-swap{animation:b-swap .3s var(--ease)}
@keyframes b-swap{from{opacity:0;transform:translateY(-3px)}}
.chip-list{display:inline-flex;gap:4px;flex-wrap:wrap;vertical-align:middle;margin-left:2px}
.mini-chip{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 7px 0 3px;border-radius:999px;background:var(--surface);border:1px solid var(--line);font-size:11.5px;color:var(--text);line-height:1}
.mini-chip .tile{--s:14px}

/* ---------- 路由舞台 ---------- */
.stage{position:relative;margin:14px -20px 0;padding:28px clamp(12px,3cqi,28px);display:grid;align-items:center;justify-content:center;min-height:300px;background-color:var(--stage);background-image:radial-gradient(var(--dot) 1px,transparent 1.3px);background-size:16px 16px;background-position:8px 8px;border-top:1px solid var(--line);border-bottom:1px solid var(--line);transition:column-gap .35s var(--ease),padding .3s var(--ease),background-color .25s}
/* 与 magpie 路由图一致：左侧两个节点单行并排，右侧供应商单列竖排 */
.stage{grid-template-columns:clamp(128px,16cqi,148px) clamp(132px,16cqi,150px) minmax(0,460px);column-gap:clamp(12px,calc((100cqi - 560px)/6),56px)}
.col-agent,.col-hub,.col-list{position:relative;z-index:2;min-width:0}

.wires{position:absolute;left:0;top:0;width:100%;height:100%;overflow:visible;pointer-events:none;z-index:1;transition:opacity .3s var(--ease)}
.wg .wt{fill:none;stroke:none;stroke-width:5;stroke-linecap:round}
.wg .w{fill:none;stroke-width:1.6;stroke-linecap:round;transition:stroke .3s var(--ease),opacity .3s var(--ease),stroke-width .2s}
.wg[data-ws=live] .w{stroke:var(--agent);stroke-width:1.8;stroke-dasharray:none}
.wg[data-ws=live] .wt{stroke:var(--agent);opacity:.12}
.wg[data-ws=standby] .w{stroke:var(--wire-standby)}
.wg[data-ws=rest] .w{stroke:var(--wire-rest);stroke-dasharray:2 6;opacity:.5}
.wg[data-ws=unset] .w{stroke:var(--wire-unset);stroke-dasharray:1 5}
.wg[data-ws=aux] .w{stroke:var(--wire-aux);stroke-dasharray:1 4}
.wg[data-ws=warn] .w{stroke:var(--warn-line);stroke-dasharray:5 4}
.wg[data-ws=broken] .w{stroke:var(--wire-broken);stroke-dasharray:none;opacity:.9}
.wg[data-ws=broken] .wt{stroke:var(--wire-broken);opacity:.07}
.wg .w-end{fill:var(--wire-broken);opacity:0;transition:opacity .3s var(--ease)}
.wg.is-broken .w-end{opacity:1}
.wg.is-broken.lit .w-end{opacity:0}
.wg[data-ws=hidden]{opacity:0}
.wg.hl .w{stroke-width:2.4}
.wg.lit .w{stroke:var(--agent);stroke-width:2.2;opacity:1;stroke-dasharray:none}
.wg.lit .wt{stroke:var(--agent);opacity:.16}
.wg[data-requesting=true] .w{stroke:var(--agent);stroke-dasharray:3 5;animation:flow .7s linear infinite}
/* 路由切换：新接管的支路涌光一次；失效由断路缓动承担，不再闪红 */
.wg.surge .wt{stroke:var(--agent);animation:surge .95s var(--ease)}
@keyframes surge{0%{opacity:.5;stroke-width:12}100%{opacity:0;stroke-width:5}}
@keyframes flow{to{stroke-dashoffset:-8}}
.packet .p-halo{fill:var(--agent);opacity:.2}
.packet .p-core{fill:var(--agent)}
.wires.draw{animation:wire-draw .65s var(--ease) both}
@keyframes wire-draw{from{clip-path:inset(0 100% 0 0)}to{clip-path:inset(0 0 0 0)}}

/* 端口 */
.port{position:absolute;width:9px;height:9px;border-radius:50%;background:var(--surface);border:1.5px solid var(--wire-unset);transform:translate(-50%,-50%);z-index:3;pointer-events:none;transition:border-color .25s,background-color .25s,opacity .25s}
.port[data-port=dsh-out],.port[data-port=hub-out]{left:100%;top:50%}
.port[data-port=hub-in],.row > .port{left:0;top:50%}
.port[data-port=dsh-alt]{left:50%;top:100%}
.port[data-port=off-in]{left:50%;top:0}
.port[data-ps=hidden]{opacity:0}
.port[data-ps=live]{border-color:var(--agent);background:var(--agent)}
.port[data-ps=standby]{border-color:var(--wire-standby)}
.port[data-ps=rest],.port[data-ps=aux]{border-color:var(--wire-rest)}
.port[data-ps=warn]{border-color:var(--warn-line)}
.port[data-ps=broken]{border-color:var(--wire-broken);background:var(--stage)}
/* 服务端口：空心 = 未验证或失效；半实心 = 部分 Key 通过；实心 = 全部 Key 最近验证通过。 */
.row > .port{transition:width .22s var(--spring),height .22s var(--spring),border-color .25s,background-color .25s,opacity .25s,left .22s var(--ease)}
.row > .port[data-ps=live]{background:var(--surface)}
.row > .port[data-mark=ok]{background:var(--agent);border-color:var(--agent);box-shadow:0 0 0 3px var(--agent-soft)}
.row > .port[data-mark=part]{width:11px;height:11px;color:var(--wire-standby);background:linear-gradient(90deg,currentColor 50%,transparent 50%);border-color:currentColor}
.row[data-st=live] > .port[data-mark=part]{color:var(--agent)}
.row > .port.pop{animation:mark-pop .42s var(--spring)}
@keyframes mark-pop{from{scale:.3}}

/* 节点 */
.node{position:relative;background:var(--surface);border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow-sm);transition:opacity .35s var(--ease),filter .35s var(--ease),border-color .2s,box-shadow .2s,transform .2s var(--ease),background-color .25s}
.node-name{font-weight:600;font-size:13px;color:var(--text);line-height:1.3}
.node-meta{font:500 11px/1.45 var(--mono);color:var(--text-3)}
.node-meta .nw{white-space:nowrap}
#hubMeta{display:flex;flex-wrap:wrap;justify-content:center;column-gap:4px}
.node-dsh .node-name{white-space:normal}
.node-logo{display:block;filter:drop-shadow(0 1px 1px rgba(15,23,42,.10));transition:filter .4s var(--ease),opacity .4s var(--ease)}

/* DSH 节点（对应 magpie 的 Codex 卡）：位置始终不动 */
.col-agent{position:relative}
.node-dsh{display:flex;flex-direction:column;align-items:center;text-align:center;padding:14px 8px 12px;gap:1px}
.node-dsh .node-logo{width:34px;height:34px;margin-bottom:8px}
.node-dsh .node-name::before{content:"";display:inline-block;width:6px;height:6px;margin-right:5px;border-radius:50%;background:var(--text-4);vertical-align:.12em;transition:background-color .25s}
.route-card[data-s=live] .node-dsh .node-name::before{background:var(--agent)}
.route-card[data-s=wait] .node-dsh .node-name::before{background:var(--warn-line)}
.route-card[data-s=none] .node-dsh .node-name::before{background:var(--warn-line)}
.route-card[data-s=fallback] .node-dsh .node-name::before{background:var(--warn-line)}
.route-card[data-s=backup] .node-dsh .node-name::before{background:var(--agent)}
.route-card[data-s=err] .node-dsh .node-name::before{background:transparent;box-shadow:inset 0 0 0 1.3px var(--wire-broken)}
.route-card[data-s=off] .node-dsh .node-name::before{background:var(--ok)}
.node-dsh.flash-ok{animation:node-ok 1.05s var(--ease)}
@keyframes node-ok{0%{box-shadow:0 0 0 0 var(--agent),var(--shadow-sm);border-color:var(--agent)}30%{box-shadow:0 0 0 6px var(--agent-soft),var(--shadow-sm);border-color:var(--agent)}}
/* 全部失败：整张图一起安静下来，红色只留给状态胶囊和提示条标题 */
.route-card[data-s=err] .node-hub{border-color:color-mix(in srgb,var(--text) 42%,var(--line))}
.route-card[data-s=err] .hub-glyph{color:var(--text-3)}
.route-card[data-s=err] .hub-pill{background:var(--text-3);color:var(--surface)}
.route-card[data-s=err] .node-dsh .node-logo{filter:grayscale(1);opacity:.55;transition:filter .4s var(--ease),opacity .4s var(--ease)}

/* 官方搜索节点：只在插件关闭时浮现在 DSH 下方，绝对定位，不挤动主行 */
.node-official{position:absolute;left:50%;top:calc(100% + 44px);width:136px;display:flex;flex-direction:column;align-items:center;text-align:center;padding:11px 8px 10px;gap:1px;opacity:0;visibility:hidden;translate:-50% -6px;scale:.98;transition:opacity .22s var(--ease),translate .35s var(--ease),scale .35s var(--ease),visibility 0s linear .35s,border-color .2s,background-color .25s,box-shadow .2s}
.route-card[data-s=off] .node-official{opacity:1;visibility:visible;translate:-50% 0;scale:1;border-color:color-mix(in srgb,var(--agent) 55%,var(--line));box-shadow:0 0 0 3px var(--agent-soft),var(--shadow-sm);transition:opacity .3s var(--ease) .1s,translate .4s var(--ease) .1s,scale .4s var(--ease) .1s,visibility 0s linear 0s,border-color .2s,background-color .25s,box-shadow .2s}
.node-official .node-logo{width:26px;height:26px;margin-bottom:6px}
.node-official .off-text{display:flex;flex-direction:column;align-items:center}
.node-official .node-name{font-size:12px}
.node-official .node-meta{font-family:var(--font);color:var(--ok-text);font-weight:600}

/* 中继节点（对应 magpie 网关卡）：深色描边 + 黑色“按顺序”胶囊 */
.col-hub{display:flex;justify-content:center;align-items:center;transition:opacity .35s var(--ease),filter .35s var(--ease)}
.node-hub{display:flex;flex-direction:column;align-items:center;text-align:center;gap:1px;width:100%;padding:14px 8px 11px;color:inherit;font:inherit;cursor:pointer;border:1.5px solid color-mix(in srgb,var(--text) 82%,transparent)}
.node-hub:hover{box-shadow:var(--shadow-md);transform:translateY(-1px)}
.node-hub:active{transform:none}
.node-hub.is-busy{border-color:var(--agent);box-shadow:0 0 0 3px var(--agent-soft),var(--shadow-sm)}
.node-hub.is-falling{border-color:var(--warn-line);box-shadow:0 0 0 3px var(--warn-soft),var(--shadow-sm)}
.node-hub.is-falling .hub-pill{background:var(--warn-line);color:#fff}
.node-hub.is-falling .hub-glyph{color:var(--warn)}
.hub-glyph{width:34px;height:34px;flex:none;border-radius:10px;display:grid;place-items:center;background:var(--tile);box-shadow:inset 0 0 0 1px var(--tile-line);color:var(--text-2);margin-bottom:8px;transition:color .3s var(--ease)}
.hub-glyph svg{width:21px;height:21px}
.route-card[data-s=live] .hub-glyph{color:var(--agent)}
.route-card[data-s=backup] .hub-glyph{color:var(--agent)}
.route-card[data-s=fallback] .hub-glyph{color:var(--warn)}
.hub-text{display:flex;flex-direction:column;align-items:center}
.hub-pill{margin-top:8px;display:inline-flex;align-items:center;gap:2px;height:19px;padding:0 8px;border-radius:999px;background:var(--text);color:var(--surface);font-size:10.5px;font-weight:600;transition:opacity .15s}
.node-hub:hover .hub-pill{opacity:.85}
.route-card[data-plugin=off] .col-hub,.route-card[data-plugin=off] .col-list{opacity:.5;filter:grayscale(1)}

/* ---------- 供应商列表（每行：图标 + 名称 + 开关） ---------- */
.col-list{display:flex;flex-direction:column;gap:14px;min-width:0;transition:opacity .35s var(--ease),filter .35s var(--ease)}
.rg-label{font-size:11px;font-weight:600;color:var(--text-3);letter-spacing:.04em;margin:0 0 6px 2px;display:flex;align-items:center;gap:8px;white-space:nowrap}
.rg-hint{font-weight:500;color:var(--text-4);letter-spacing:0;display:inline-flex;align-items:center;gap:3px}
.rg-rows{position:relative;display:flex;flex-direction:column;gap:6px}

.row{position:relative;display:flex;align-items:center;height:44px;padding:0 10px 0 0;border-radius:12px;background:var(--surface);border:1px solid var(--line);box-shadow:var(--shadow-sm);user-select:none;-webkit-user-select:none;transition:border-color .2s var(--ease),box-shadow .2s var(--ease),background-color .2s,opacity .2s}
.row[data-drag=true]{touch-action:none}
.row-main{flex:1;min-width:0;display:flex;align-items:center;gap:11px;height:100%;padding:0 6px 0 10px;border:0;background:transparent;border-radius:11px;cursor:pointer;text-align:left;color:inherit}
.row[data-drag=true] .row-main{cursor:grab}
.row-main:focus-visible{outline:none}
.row:has(.row-main:focus-visible){outline:2px solid var(--agent);outline-offset:2px}
.row.is-dragging{outline:none !important}
.row-name{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:color .2s}
.row .switch{margin-left:auto}
.row:hover{border-color:var(--line-2);box-shadow:var(--shadow-md)}
.row[data-st=unset]{border-style:dashed;border-color:var(--line-2);background:color-mix(in srgb,var(--surface) 55%,transparent);box-shadow:none}
.row[data-st=unset] .row-name{color:var(--text-3)}
.row[data-st=unset] .tile{filter:grayscale(1);opacity:.42}
.row[data-st=off]{border-style:dashed;border-color:var(--line-2);box-shadow:none}
.row[data-st=off] .row-name{color:var(--text-3)}
.row[data-st=off] .tile{filter:grayscale(1);opacity:.42}
.row[data-st=live]{border-color:var(--text);box-shadow:var(--shadow-sm)}
.row[data-st=wait]{border-style:dashed;border-color:var(--warn-line);background:var(--warn-soft);box-shadow:none}
.row[data-st=wait] .tile{filter:grayscale(1);opacity:.5}
.row[data-st=bad],.row[data-st=err]{border-color:var(--line);background:color-mix(in srgb,var(--surface-2) 62%,var(--surface))}
.row[data-st=bad] .tile,.row[data-st=err] .tile{opacity:.5;filter:saturate(.3)}
.row[data-st=bad] .row-name,.row[data-st=err] .row-name{color:var(--text-3)}
.row .tile{transition:filter .5s var(--ease),opacity .5s var(--ease)}
/* 参考 Magpie 0.1.1978 的 .rt-accts .tag：右上悬浮，不挤占名称或开关。
   动画只提示本次错误；最近失败的简短原因继续留在原供应商，直到重验或配置改变。 */
.row-fault{position:absolute;right:10px;top:-14px;z-index:5;display:inline-flex;align-items:center;gap:5px;padding:1px 7px;border:1px solid transparent;border-radius:6px;background:var(--err-solid);color:#fff;font:600 12px/1.35 var(--font);font-variant-numeric:tabular-nums;max-width:calc(100% - 20px);white-space:nowrap;pointer-events:none;opacity:0;transform:translateY(4px) scale(.96);transform-origin:right bottom;transition:opacity .2s var(--ease),transform .25s var(--ease),background-color .2s,color .2s}
.row.has-fault .row-fault{opacity:1;transform:none}
.row-fault[data-tone=partial]{background:var(--surface);border-color:var(--warn-line);color:var(--warn-text)}
.row-fault-code{font:600 11.5px/1.35 var(--mono);font-variant-numeric:tabular-nums}
.row-fault-sep{opacity:.72}
.row.is-fault-flash{border-color:var(--err);box-shadow:0 0 0 2px var(--err-soft)}
.row.flash-ok{animation:row-ok .85s var(--ease)}
@keyframes row-ok{0%{border-color:var(--agent);box-shadow:0 0 0 0 var(--agent-soft)}35%{border-color:var(--agent);box-shadow:0 0 0 5px var(--agent-soft)}}
.row.is-hl{border-color:var(--line-2)}
.row.is-searching{animation:searching 1s var(--ease) infinite}
@keyframes searching{0%,100%{box-shadow:0 0 0 3px var(--agent-soft)}50%{box-shadow:0 0 0 6px var(--agent-soft)}}
.row.tick{animation:tick .55s var(--spring)}
.row.tick .tile{animation:lightup .7s var(--ease)}
@keyframes tick{35%{transform:scale(1.025)}}
@keyframes lightup{from{filter:grayscale(1);opacity:.42}}
.row.enter{animation:row-in .42s var(--ease) both;animation-delay:calc(var(--i,0) * 45ms)}
@keyframes row-in{from{opacity:0;transform:translateY(6px)}}
.shake{animation:shake .38s var(--ease)}
@keyframes shake{20%{transform:translateX(-4px)}40%{transform:translateX(4px)}60%{transform:translateX(-2px)}80%{transform:translateX(2px)}}
/* 参考 Magpie 的 rthit：450ms 衰减轻颤；translate 不占用拖拽的 transform。 */
.row.is-jolt,.node.is-jolt{animation:route-jolt .45s linear}
.row.is-jolt-soft{animation:route-jolt-soft .3s linear}
@keyframes route-jolt{0%,100%{translate:0 0}20%{translate:-5px 0}40%{translate:4px 0}60%{translate:-2px 0}80%{translate:1px 0}}
@keyframes route-jolt-soft{0%,100%{translate:0 0}18%{translate:-1.5px 0}38%{translate:1.2px 0}60%{translate:-.7px 0}80%{translate:.3px 0}}

/* 拖拽 */
.rg-rows.is-sorting .row:not(.is-dragging){transition:transform .22s var(--ease),border-color .2s,box-shadow .2s}
.row.is-dragging{z-index:6;border-color:var(--line-2);box-shadow:var(--shadow-drag)}
.row.is-dragging .row-main{cursor:grabbing}
.drop-ghost{position:absolute;left:0;right:0;z-index:0;border:1.5px dashed var(--agent-ring);border-radius:12px;background:var(--agent-soft);pointer-events:none;transition:transform .22s var(--ease)}
.dsg-root.is-grabbing,.dsg-root.is-grabbing *{cursor:grabbing !important}

/* logo 方块：官方原图不改，只做统一尺寸、底板与灰度滤镜 */
.tile{--s:28px;position:relative;width:var(--s);height:var(--s);flex:none;border-radius:calc(var(--s) * .27);display:grid;place-items:center;overflow:hidden;transition:filter .3s var(--ease),opacity .3s var(--ease)}
.tile img{display:block;width:100%;height:100%;object-fit:cover}
.tile[data-fit=contain]{background:var(--tile);box-shadow:inset 0 0 0 1px var(--tile-line)}
.tile[data-fit=contain] img{width:var(--k,62%);height:var(--k,62%);object-fit:contain}
.tile[data-plate=light]{background:#f4f5f7}
.tile[data-ring=true]::after{content:"";position:absolute;inset:0;border-radius:inherit;box-shadow:inset 0 0 0 1px rgba(255,255,255,.16);pointer-events:none}
.tile-glyph{background:var(--tile);box-shadow:inset 0 0 0 1px var(--tile-line);color:var(--text-2)}
.tile-glyph svg{width:62%;height:62%}

/* 开关 */
.switch{position:relative;width:34px;height:20px;flex:none;border-radius:999px;border:0;padding:0;background:var(--line-2);transition:background-color .2s var(--ease),opacity .2s}
.switch i{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.22),0 0 0 .5px rgba(0,0,0,.04);display:grid;place-items:center;color:var(--btn-primary);transition:transform .26s var(--spring)}
.switch[aria-checked=true]{background:var(--btn-primary)}
.switch[aria-checked=true] i{transform:translateX(14px)}
.switch:hover:not(:disabled){filter:brightness(1.04)}
.switch-lg{width:42px;height:24px}
.switch-lg i{width:20px;height:20px}
.switch-lg[aria-checked=true] i{transform:translateX(18px)}
[data-theme=dark] .switch{background:#3a3e46}
[data-theme=dark] .switch[aria-checked=true]{background:#5873ff}

/* 底部配置文件条 */
.rc-foot{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 12px 11px 20px;font-size:12px;color:var(--text-3)}
.cf-label{white-space:nowrap}
.cf-path{font:500 11.5px/1.5 var(--mono);color:var(--text-2);background:var(--surface-2);border:1px solid var(--line);border-radius:6px;padding:1px 7px;min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tag{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 7px;border-radius:999px;font-size:11px;font-weight:550;background:var(--surface-2);color:var(--text-3);border:1px solid var(--line);white-space:nowrap;line-height:1}
.tag[data-tone=agent]{background:var(--agent-soft);color:var(--agent);border-color:transparent}
.tag[data-tone=warn]{background:var(--warn-soft);color:var(--warn);border-color:transparent}
.tag[data-tone=ok]{background:var(--ok-soft);color:var(--ok-text);border-color:transparent}
.cf-spacer{flex:1}
.rc-foot .btn svg{width:14px;height:14px}

/* ---------- 弹窗 ---------- */
.overlay{position:fixed;inset:0;z-index:60;display:grid;place-items:center;padding:24px;background:var(--scrim);backdrop-filter:blur(2px);animation:fade-in .16s var(--ease)}
.overlay[hidden]{display:none}
.overlay.is-closing{animation:fade-out .15s var(--ease) forwards}
.dialog{width:min(600px,100%);max-height:min(780px,calc(100vh - 48px));display:flex;flex-direction:column;background:var(--surface);border:1px solid var(--line);border-radius:18px;box-shadow:var(--shadow-lg);overflow:hidden;animation:dlg-in .22s var(--ease)}
.overlay.is-closing .dialog{animation:dlg-out .15s var(--ease) forwards}
.dialog.is-in{animation:none}
.dialog.shake{animation:shake .38s var(--ease)}
@keyframes fade-in{from{opacity:0}}
@keyframes fade-out{to{opacity:0}}
@keyframes dlg-in{from{opacity:0;transform:translateY(8px) scale(.98)}}
@keyframes dlg-out{to{opacity:0;transform:translateY(4px) scale(.985)}}

.dlg-head{display:flex;align-items:center;gap:12px;padding:16px 14px 14px 20px;border-bottom:1px solid var(--line)}
.dlg-head > .tile{--s:40px}
.dlg-titles{flex:1;min-width:0}
.dlg-titles h2{margin:0;font-size:16px;font-weight:650;letter-spacing:-.005em;line-height:1.3}
.dlg-sub{margin:2px 0 0;font-size:12px;color:var(--text-3);display:flex;align-items:center;gap:4px 8px;flex-wrap:wrap}
.dlg-link{color:var(--agent);text-decoration:none;display:inline-flex;align-items:center;gap:2px;white-space:nowrap;font-weight:550}
.dlg-link:hover{text-decoration:underline}
.head-switch{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-2);white-space:nowrap;cursor:pointer}
.head-switch[data-pending=true]{color:var(--text-3);cursor:default}
.head-switch[data-pending=true] .switch{opacity:.48;cursor:default}
.head-switch[data-pending=true] .switch:hover{filter:none}
.dlg-head .icon-btn{margin-left:2px}

.dlg-body{padding:4px 20px 8px;overflow:auto;overscroll-behavior:contain}
.dlg-form{margin:0}
.field{display:grid;grid-template-columns:112px minmax(0,1fr);column-gap:16px;align-items:start;padding:12px 0;border-bottom:1px solid var(--hair)}
.field:last-child{border-bottom:0}
.f-label{padding-top:8px;font-size:12.5px;font-weight:550;color:var(--text);display:flex;flex-direction:column;gap:1px}
.f-label small{font-weight:400;color:var(--text-3);font-size:11px}
.f-label small:has(.ic){display:inline-flex;align-items:center;gap:4px}
.f-ctl{min-width:0;display:flex;flex-direction:column;gap:6px}
.f-help{font-size:11.5px;color:var(--text-3);line-height:1.5;margin:0}
.f-help code,.note code{font:500 11px var(--mono);color:var(--text-2);background:var(--field);border-radius:4px;padding:0 4px}
.f-msg{font-size:11.5px;line-height:1.45;display:flex;gap:5px;align-items:flex-start;margin:0}
.f-msg svg{flex:none;margin-top:2px}
.f-msg[data-tone=err]{color:var(--err-text)}
.f-msg[data-tone=warn]{color:var(--warn-text)}

.input{position:relative;display:flex;align-items:center;height:34px;min-width:0;border-radius:9px;background:var(--field);border:1px solid transparent;transition:background-color .15s,border-color .15s,box-shadow .15s}
.input:hover{background:var(--field-hover)}
.input:focus-within{background:var(--field-focus);border-color:var(--agent);box-shadow:0 0 0 3px var(--agent-soft)}
.input[data-invalid=true]{border-color:var(--err);box-shadow:0 0 0 3px var(--err-soft)}
.input[data-health=true]{border-color:color-mix(in srgb,var(--err) 55%,transparent)}
.input input{flex:1;min-width:0;height:100%;border:0;background:transparent;outline:none;padding:0 10px;font-size:12.5px}
.input input.mono{font-family:var(--mono);font-size:12px}
.input input::placeholder{color:var(--text-4)}
.input .in-act{display:flex;gap:1px;padding-right:3px}
.input.is-readonly{background:transparent;border:1px dashed var(--line-2)}
.input.is-readonly input{color:var(--text-3)}
.save-error{color:var(--err-text);border:1px solid var(--err-soft)}

.seg{display:inline-flex;align-self:flex-start;max-width:100%;padding:3px;gap:2px;border-radius:10px;background:var(--field)}
.seg button{border:0;background:transparent;height:28px;padding:0 12px;border-radius:7px;font-size:12.5px;font-weight:550;color:var(--text-2);white-space:nowrap;transition:background-color .15s,color .15s,box-shadow .15s}
.seg button:hover{color:var(--text)}
.seg button[aria-checked=true]{background:var(--surface);color:var(--text);box-shadow:var(--shadow-sm),0 0 0 1px var(--line)}
.chips{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.chips .f-help{margin-right:2px}
.chip{height:24px;padding:0 9px;border-radius:999px;border:1px solid var(--line);background:var(--surface);font:500 11.5px var(--mono);color:var(--text-2);transition:border-color .15s,color .15s,background-color .15s}
.chip:hover{border-color:var(--line-2);color:var(--text)}
.chip[aria-pressed=true]{border-color:var(--agent);color:var(--agent);background:var(--agent-soft)}

.checks{display:flex;flex-direction:column;gap:2px}
.check{position:relative;display:flex;align-items:flex-start;gap:9px;padding:6px 8px;margin:0 -8px;border-radius:8px;cursor:pointer}
.check:hover{background:var(--surface-2)}
.check input{position:absolute;opacity:0;pointer-events:none}
.check .box{flex:none;width:16px;height:16px;margin-top:1px;border-radius:5px;border:1.5px solid var(--line-2);background:var(--surface);display:grid;place-items:center;color:#fff;transition:background-color .15s,border-color .15s}
.check .box svg{width:11px;height:11px;opacity:0;transform:scale(.6);transition:opacity .15s,transform .2s var(--spring)}
.check input:checked + .box{background:var(--btn-primary);border-color:var(--btn-primary)}
.check input:checked + .box svg{opacity:1;transform:none}
.check input:focus-visible + .box{outline:2px solid var(--agent);outline-offset:2px}
.check.is-disabled{cursor:not-allowed}
.check.is-disabled .box,.check.is-disabled .c-text{opacity:.45}
.check .c-text{display:flex;flex-direction:column;font-size:12.5px;font-weight:550}
.check .c-text small{color:var(--text-3);font-size:11.5px;font-weight:400}

.keylist{display:flex;flex-direction:column;gap:6px}
.key-row{display:flex;gap:6px;align-items:center}
.key-row .input{flex:1}
.key-row.enter{animation:row-in .25s var(--ease)}
.add-key{align-self:flex-start;display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 10px;border-radius:8px;border:1px dashed var(--line-2);background:transparent;color:var(--text-2);font-size:12px;transition:border-color .15s,color .15s,background-color .15s}
.add-key:hover{border-color:var(--agent);color:var(--agent);background:var(--agent-soft)}

.dlg-foot{display:flex;align-items:center;gap:8px;padding:12px 16px 12px 14px;border-top:1px solid var(--line);background:var(--surface-2)}
.foot-note{flex:1;min-width:0;font-size:11.5px;color:var(--text-3);text-align:right;padding-right:4px}
.foot-note b{color:var(--warn);font-weight:600}

/* 中继弹窗 */
.sec{padding:12px 0 4px;border-bottom:1px solid var(--line)}
.sec:last-child{border-bottom:0}
.sec-h{margin:4px 0 2px;font-size:11px;font-weight:650;letter-spacing:.06em;color:var(--text-3);display:flex;align-items:center;gap:8px}
.prog{display:flex;align-items:center;flex-wrap:wrap;gap:8px 10px;padding:10px 10px 10px 12px;border-radius:12px;background:var(--surface-2);border:1px solid var(--line)}
.prog-main{flex:1;min-width:190px;display:flex;flex-direction:column;gap:2px}
.prog-title{font-weight:600;font-size:12.5px;display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.prog-path{font:500 11.5px var(--mono);color:var(--text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.order{margin:2px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:4px;counter-reset:o}
.order li{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-3)}
.order li::before{counter-increment:o;content:counter(o);width:17px;height:17px;flex:none;border-radius:50%;display:grid;place-items:center;font-size:10px;font-weight:650;background:var(--field);color:var(--text-3)}
.order li.is-hit{color:var(--text)}
.order li.is-hit::before{background:var(--btn-primary);color:#fff}
.stepper{display:inline-flex;align-items:center;align-self:flex-start;height:34px;border-radius:9px;background:var(--field);border:1px solid transparent;transition:background-color .15s,border-color .15s,box-shadow .15s}
.stepper:focus-within{border-color:var(--agent);box-shadow:0 0 0 3px var(--agent-soft);background:var(--field-focus)}
.stepper button{width:30px;height:30px;margin:0 1px;border:0;background:transparent;border-radius:8px;color:var(--text-2);display:grid;place-items:center}
.stepper button:hover:not(:disabled){background:var(--field-hover);color:var(--text)}
.stepper button:disabled{opacity:.3}
.stepper input{width:58px;height:100%;border:0;background:transparent;text-align:center;font:600 12.5px var(--mono);outline:none;-moz-appearance:textfield;appearance:textfield}
.stepper input::-webkit-inner-spin-button,.stepper input::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}
.stepper .unit{font-size:11.5px;color:var(--text-3);margin:0 2px 0 -6px}
.stepper.is-readonly{background:transparent;border:1px dashed var(--line-2);color:var(--text-3)}
.static-val{display:inline-flex;align-items:center;gap:8px;min-height:34px;font-size:12.5px;color:var(--text);flex-wrap:wrap}
.adv-toggle{display:flex;align-items:center;gap:6px;width:100%;padding:13px 0 11px;border:0;background:transparent;font-size:12.5px;font-weight:600;color:var(--text-2);text-align:left}
.adv-toggle:hover{color:var(--text)}
.adv-toggle .adv-hint{font-weight:400;color:var(--text-3);font-size:11.5px}
.adv-toggle svg{transition:transform .25s var(--ease)}
.adv-toggle[aria-expanded=true] svg{transform:rotate(90deg)}
.adv{display:grid;grid-template-rows:0fr;transition:grid-template-rows .32s var(--ease)}
.adv.is-open{grid-template-rows:1fr}
.adv > div{overflow:hidden;min-height:0}
.sub-h{margin:12px 0 0;padding-top:12px;border-top:1px solid var(--line);font-size:11.5px;font-weight:650;color:var(--text-2);display:flex;align-items:center;gap:6px}
.note{display:flex;gap:8px;align-items:flex-start;padding:9px 11px;border-radius:10px;background:var(--surface-2);font-size:11.5px;color:var(--text-2);line-height:1.55;margin:8px 0}
.note svg{flex:none;margin-top:1px;color:var(--text-3)}
.search-result{border:1px solid var(--err-soft);background:var(--err-soft)}
.search-result[data-tone=ok]{border-color:var(--ok-soft);background:var(--ok-soft);color:var(--ok-text)}
.search-result[data-tone=run]{border-color:var(--agent-soft);background:var(--agent-soft);color:var(--agent-text)}
.search-result svg{color:var(--err-text)}
.search-result span{min-width:0;white-space:pre-line;overflow-wrap:anywhere}
.search-result strong{display:block;margin-bottom:2px;font-weight:600;color:var(--err-text)}

/* ---------- 加载骨架 ---------- */
.skel{display:inline-block;height:10px;border-radius:5px;background:linear-gradient(90deg,var(--field) 0 30%,var(--field-hover) 50%,var(--field) 70%) 0 0/300% 100%;animation:shimmer 1.2s linear infinite}
.route-card.is-loading .row{border-style:solid;border-color:transparent;box-shadow:none;background:linear-gradient(90deg,var(--field) 0 30%,var(--field-hover) 50%,var(--field) 70%) 0 0/300% 100%;animation:shimmer 1.2s linear infinite}
.route-card.is-loading .row > *{visibility:hidden}
.route-card.is-loading .wires,.route-card.is-loading .port{opacity:0}
.route-card.is-loading .rc-foot .cf-path,.route-card.is-loading .rc-foot .tag{opacity:.4}
@keyframes shimmer{from{background-position:100% 0}to{background-position:0 0}}

/* ---------- toast ---------- */
.toasts{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:80;display:flex;flex-direction:column;align-items:center;gap:8px;pointer-events:none;width:max-content;max-width:calc(100vw - 32px)}
.toast{pointer-events:auto;display:flex;align-items:center;gap:9px;min-height:38px;max-width:100%;padding:7px 7px 7px 13px;border-radius:12px;background:var(--toast-bg);color:var(--toast-text);font-size:12.5px;box-shadow:0 10px 30px rgba(0,0,0,.25);animation:toast-in .28s var(--spring)}
.toast.no-act{padding-right:15px}
.toast.is-out{animation:toast-out .18s var(--ease) forwards}
.toast .t-ic{flex:none;display:grid;place-items:center}
.toast[data-tone=ok] .t-ic{color:#3ccb7f}
.toast[data-tone=err] .t-ic{color:#ff6b70}
.toast[data-tone=warn] .t-ic{color:#f0b04a}
.toast[data-tone=info] .t-ic{color:#93a6ff}
[data-theme=dark] .toast[data-tone=ok] .t-ic{color:#12a150}
[data-theme=dark] .toast[data-tone=err] .t-ic{color:#e5484d}
[data-theme=dark] .toast[data-tone=warn] .t-ic{color:#b86e00}
[data-theme=dark] .toast[data-tone=info] .t-ic{color:#4d6bfe}
.toast .t-text{min-width:0}
.toast .t-act{flex:none;display:inline-flex;align-items:center;gap:4px;border:0;background:var(--toast-act);color:inherit;height:26px;padding:0 10px 0 8px;border-radius:7px;font-size:12px;font-weight:600;white-space:nowrap}
.toast .t-act:hover{filter:brightness(1.15)}
@keyframes toast-in{from{opacity:0;transform:translateY(10px) scale(.96)}}
@keyframes toast-out{to{opacity:0;transform:translateY(6px) scale(.98)}}

@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{animation-duration:.001ms !important;animation-delay:0s !important;animation-iteration-count:1 !important;transition-duration:.001ms !important;transition-delay:0s !important;scroll-behavior:auto !important}
}

/* 独立历史层只隔离数据；连线、光点、闪光和抖动复用测试搜索。 */
.route-card,.log-card{--rp-blue:#5276d6;--rp-blue-text:#3b5fae;--rp-blue-soft:rgba(82,118,214,.09);--rp-amber:#bd8a45;--rp-amber-text:#946329;--rp-coral:#cf7470;--rp-coral-text:#a3504c}
[data-theme=dark] .route-card,[data-theme=dark] .log-card{--rp-blue:#88a8f4;--rp-blue-text:#aac1f8;--rp-blue-soft:rgba(136,168,244,.10);--rp-amber:#d7ae72;--rp-amber-text:#dfba88;--rp-coral:#db8a84;--rp-coral-text:#e3a09a}
.history-bar{position:absolute;inset:0 0 0 88px;display:flex;align-items:center;gap:12px;z-index:4;min-width:0}
.history-bar[hidden],.history-stage[hidden],.history-note[hidden],.history-context[hidden],.history-actions [hidden]{display:none}
.history-label{display:inline-flex;align-items:center;gap:7px;font-size:12px;font-weight:550;color:var(--text-2);white-space:nowrap;font-variant-numeric:tabular-nums}
.history-label::before{content:"";width:5px;height:5px;border-radius:50%;background:var(--rp-blue);box-shadow:0 0 0 3px var(--rp-blue-soft)}
.history-phase{min-width:0;color:var(--text-3);font-size:12px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.history-actions{display:flex;align-items:center;gap:6px;margin-left:auto;flex:none}
.history-context{position:absolute;z-index:3;display:flex;flex-direction:column;justify-content:center;gap:5px;min-width:0;pointer-events:none}
.history-context[data-compact=true]{flex-direction:row;justify-content:flex-start;align-items:center;gap:12px}
.history-context[data-compact=true] .history-query{flex:1;min-width:0;max-width:none}
.history-query{flex-shrink:0;font-size:13px;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:500}
.history-route.lroute{align-self:flex-start;flex-wrap:nowrap;width:100%;max-width:none;min-height:28px;overflow-x:auto;overflow-y:hidden;scrollbar-width:thin;pointer-events:auto}
.history-context[data-compact=true] .history-route{flex:0 1 700px;align-self:center}
.history-bar[data-phase=done]{inset:0 calc(var(--history-actions-width,320px) + 14px) 0 auto;height:32px;gap:8px}
.history-bar[data-phase=done] .history-label::before{background:var(--text-4);box-shadow:none}
.history-bar[data-phase=done] .history-label{font-size:11px;color:var(--text-3)}
.history-bar[data-phase=done] .history-phase{display:none}
.history-bar[data-phase=done] .history-return{color:var(--text-2)}
.history-bar[data-phase=done] .history-dismiss{width:22px}
.route-card[data-history=true] > #stage,.route-card[data-history=true] > #bannerSlot,.route-card[data-history=true] > .rc-foot{visibility:hidden}
.route-card[data-history=true] #statusPill,.route-card[data-history=true] .rc-actions{visibility:hidden}
.history-stage{position:absolute;overflow:visible;background:var(--stage);background-image:radial-gradient(var(--dot) 1px,transparent 1.3px);background-size:16px 16px;background-position:8px 8px;border-block:1px solid var(--line);pointer-events:none}
.history-stage .hr-node{position:absolute;z-index:2;box-sizing:border-box}
.history-stage .hr-node.node{cursor:default;transform:none;filter:none}
.history-stage .node-name::before{display:none}
.history-stage .hr-node[data-hs] .node-logo,.history-stage .hr-node[data-hs] .hub-glyph{filter:none;opacity:1}
.history-stage .hr-node[data-hs] .hub-glyph{color:var(--agent)}
.history-stage .hr-node.node-hub{border-color:color-mix(in srgb,var(--text) 82%,transparent);box-shadow:var(--shadow-sm)}
.history-stage .hr-node.node-hub.is-busy{border-color:var(--agent);box-shadow:0 0 0 3px var(--agent-soft),var(--shadow-sm)}
.history-stage .hr-node.node-hub.is-falling{border-color:var(--warn-line);box-shadow:0 0 0 3px var(--warn-soft),var(--shadow-sm)}
.history-stage .hr-node.node-hub.is-falling .hub-glyph{color:var(--warn)}
.history-stage .hr-node.node-hub .hub-pill{background:var(--text);color:var(--surface)}
.history-stage .hr-node.node-hub.is-falling .hub-pill{background:var(--warn-line);color:#fff}
.history-stage .node-meta{font:500 11px/1.5 var(--font);color:var(--text-3);margin-top:2px}
.history-stage .history-official{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:11px 8px;gap:1px}
.history-official .node-logo{width:26px;height:26px;margin-bottom:6px}
.history-official .node-name{font-size:12px}
.hr-provider{display:flex;align-items:center;gap:11px;padding:0 11px}
.hr-provider .tile{--s:28px;flex:none}
.hr-provider[data-hs=idle] .hr-provider-name{color:var(--text-3)}
.history-stage .hr-provider[data-st=on],.history-stage .hr-provider[data-st=live]{box-shadow:var(--shadow-sm);border-style:solid}
.history-stage .hr-provider[data-st=on] .tile,.history-stage .hr-provider[data-st=live] .tile{filter:none;opacity:1}
.history-stage .hr-provider[data-st=live]{border-color:var(--text)}
.history-stage .hr-provider.is-fault-flash{border-color:var(--err);box-shadow:0 0 0 2px var(--err-soft)}
.hr-provider-name{font-size:13px;font-weight:600;flex:1;min-width:0;white-space:nowrap}
.hr-result{font-size:11px;color:var(--text-3);white-space:nowrap;display:inline-flex;align-items:center;gap:5px}
.hr-result:not(:empty)::before{content:"";width:4px;height:4px;border-radius:50%;background:currentColor}
[data-hs=hit] > .hr-result,[data-hs=back] > .hr-result{color:var(--agent-text)}
[data-hs=fail] > .hr-result{color:var(--err-text)}
.hr-port{left:0;top:50%}
.hr-port.out{left:100%}
.hr-port.bottom{left:50%;top:100%}
.hr-port.top{left:50%;top:0}
.hr-fault[hidden]{display:none}
.hr-label{position:absolute;font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--text-3)}
.history-note{position:absolute;bottom:12px;left:20px;right:20px;margin:0;color:var(--text-3);font-size:12px;line-height:1.5;white-space:nowrap}
.replay-control,.lr-replay{position:relative;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:28px;padding:0 9px;border:1px solid var(--line);border-radius:7px;background:var(--surface);color:var(--text-2);box-shadow:0 1px 1px var(--hair);font-size:12px;font-weight:550;line-height:1;white-space:nowrap;transition:background-color .18s,border-color .18s,color .18s,box-shadow .18s,transform .12s}
.replay-control .ic,.lr-replay .ic{width:13px;height:13px;flex:none;transition:transform .22s var(--ease)}
.replay-control:hover:not(:disabled),.lr-replay:hover:not(:disabled){border-color:color-mix(in srgb,var(--rp-blue) 34%,var(--line));background:var(--rp-blue-soft);color:var(--rp-blue-text);box-shadow:0 1px 3px var(--hair)}
.replay-control:active:not(:disabled),.lr-replay:active:not(:disabled){transform:translateY(1px) scale(.97);box-shadow:none}
.lr-replay:hover:not(:disabled):not([aria-pressed=true]) .ic{transform:rotate(-30deg)}
.lr-replay[aria-pressed=true],#historyStop{color:var(--rp-blue-text);border-color:color-mix(in srgb,var(--rp-blue) 30%,var(--line));background:var(--rp-blue-soft)}
.replay-control:focus-visible,.lr-replay:focus-visible{outline:2px solid var(--rp-blue);outline-offset:2px}
.history-return{background:transparent;border-color:transparent;box-shadow:none}
.history-dismiss{width:28px;padding:0;border-color:transparent;box-shadow:none;background:transparent}
#historyStop,.lr-replay{min-width:70px}
.lr-replay:disabled{color:var(--text-4);opacity:.5;background:transparent;box-shadow:none}
@media(prefers-reduced-motion:reduce){.history-stage *,.replay-control,.lr-replay,.lr-replay .ic{transition:none!important}}

/* Account quota is separate from a historical request's usage. */
#quotaSlot{overflow:clip;overflow-clip-margin:6px}
.quota-panel{padding:16px 0 12px;border-top:1px solid var(--line);margin-top:4px;container-type:inline-size}
.qp-head{display:flex;align-items:center;gap:8px;min-height:30px;margin-bottom:12px}
.qp-heading{display:flex;align-items:baseline;gap:8px;flex:1;min-width:0}
.qp-head h3{font-size:13px;font-weight:600;line-height:1.5;margin:0;white-space:nowrap}
.qp-tools{display:flex;align-items:center;justify-content:flex-end;gap:6px;flex:none;margin-left:auto}
.qp-key{display:flex;align-items:center;font-size:13px;color:var(--text-2)}
.qp-key select{border:1px solid var(--line);background:var(--surface-2);border-radius:7px;height:30px;padding:0 6px;max-width:94px;cursor:pointer}
.qp-refresh{display:inline-flex;align-items:center;justify-content:center;gap:5px;min-width:30px;height:30px;padding:0 7px;flex:none;border:0;border-radius:7px;background:transparent;color:var(--text-2);transition:background-color .15s,color .15s,transform .12s}
.qp-refresh.is-retry{color:var(--agent-text);font-size:13px;font-weight:550;white-space:nowrap}
.qp-refresh .ic{width:15px;height:15px}
.qp-refresh:hover:not(:disabled){background:var(--field);color:var(--text)}
.qp-refresh:active:not(:disabled){transform:scale(.94)}
.qp-refresh:disabled{color:var(--text-3);opacity:.55}
.qp-refresh[aria-busy=true]{opacity:1;color:var(--agent-text)}
.qp-refresh[aria-busy=true] .ic{animation:spin .9s linear infinite}
.qp-stats{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px}
.qp-stat{min-width:0}
.qp-stat.is-primary{text-align:right}
.qp-label{display:block;font-size:13px;line-height:1.6;color:var(--text-2);margin-bottom:3px}
.qp-amount{display:flex;align-items:baseline;gap:7px;flex-wrap:wrap}
.qp-stat.is-primary .qp-amount{justify-content:flex-end}
.qp-value{font-size:24px;font-weight:600;letter-spacing:-.025em;line-height:1.2;color:var(--text-2);font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.qp-stat.is-primary .qp-value,.qp-wallet .qp-value{color:var(--agent-text)}
.qp-value.is-unknown{font-size:14px;font-weight:500;letter-spacing:0;line-height:28.8px;color:var(--text-3)}
.qp-unit{font-size:13px;font-weight:400;line-height:1.5;color:var(--text-3)}
.qp-currency{font-size:20px;color:var(--agent-text)}
.qp-meter{height:4px;border-radius:4px;background:var(--field);margin:10px 0 7px;overflow:hidden}
.qp-meter i{display:block;width:100%;height:100%;border-radius:inherit;background:var(--agent);transform-origin:left}
.qp-meter.is-unreported{background:var(--field)}
.qp-summary{display:flex;align-items:center;gap:4px 10px;min-height:30px;flex-wrap:wrap;font-size:13px;line-height:1.6;color:var(--text-3)}
.qp-account-meta{display:inline-flex;align-items:center;gap:4px;min-width:0}
.qp-total{overflow-wrap:anywhere}
.qp-total b{font-weight:500;color:var(--text-2);font-variant-numeric:tabular-nums}
.qp-updated{display:inline-flex;align-items:center;gap:4px;margin-left:auto;min-width:0}
.qp-updated[data-state=error]{color:var(--warn-text)}
.qp-info{display:inline-grid;place-items:center;flex:none;width:24px;height:24px;padding:0;border:0;border-radius:50%;background:transparent;color:inherit;vertical-align:middle;transition:background-color .15s,color .15s}
.qp-info .ic{width:14px;height:14px}
.qp-info:hover,.qp-info:focus-visible{background:var(--field);color:var(--text)}
.qp-console{font-size:11px;font-weight:550;line-height:1.5}
.qp-console .ic{width:11px;height:11px}
.qp-wallet{padding:0 0 9px}
.qp-empty{min-height:36px;display:flex;align-items:center;justify-content:space-between;gap:8px 12px}
.qp-placeholder{display:flex;align-items:center;gap:6px;min-width:0;font-size:13px;line-height:1.65;color:var(--text-2);margin:0;overflow-wrap:anywhere}
.qp-placeholder .qp-info{margin-left:-5px;margin-right:-5px}
.qp-state-icon{width:14px;height:14px;color:var(--text-3)}
.qp-placeholder[data-state=error]{color:var(--warn-text)}
.qp-placeholder[data-state=loading]{color:var(--agent-text)}
.quota-panel[data-state=loading] .qp-updated{color:var(--agent-text)}
@container (max-width:479px){
  .qp-summary{gap:3px 8px}
  .qp-summary .qp-updated{margin-left:0}
  .qp-stats{gap:12px}
}
@container (max-width:359px){
  .qp-stats{grid-template-columns:minmax(0,1fr);gap:10px}
  .qp-stat.is-primary{text-align:left}
  .qp-stat.is-primary .qp-amount{justify-content:flex-start}
  .qp-head{gap:4px}
  .qp-tools{gap:3px}
  .qp-key select{max-width:76px}
  .qp-refresh.is-retry span{display:none}
}
@media (max-width:520px){
  .dialog:has(#quotaPanel) .field{grid-template-columns:minmax(0,1fr);gap:6px}
  .dialog:has(#quotaPanel) .f-label{padding-top:0}
  .dialog:has(#quotaPanel) .dlg-head{flex-wrap:wrap;gap:8px}
  .dialog:has(#quotaPanel) .dlg-titles{flex-basis:calc(100% - 84px)}
  .dialog:has(#quotaPanel) .head-switch{margin-left:auto}
  .dialog:has(#quotaPanel) .dlg-foot{flex-wrap:wrap}
  .dialog:has(#quotaPanel) .foot-note{flex-basis:100%;order:2;text-align:left}
}


/* ---------- 搜索接管日志 ---------- */
/* 链路表示最终通道，而不是上游不可观测的逐跳处理时间线。 */
.route-card,.log-card{--lg3:#626a77;--lg-label:#515966;--lg-blue:#3559d8;--lg-plate:#edf1ff}
.log-card{position:relative;container-type:inline-size;margin-top:14px;background:var(--surface);border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow-sm);overflow:hidden;transition:background-color .25s,border-color .25s;animation:log-enter .26s var(--ease)}
[data-theme=dark] .route-card,[data-theme=dark] .log-card{--lg3:#9aa1ac;--lg-label:#c4c9d2;--lg-blue:#9eb0ff;--lg-plate:#252d46}
@keyframes log-enter{from{opacity:0;transform:translateY(5px)}}
.lc-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:16px 20px 13px}
.lc-title{min-width:0}
.lc-title h3{margin:0;font-size:15px;font-weight:650;color:var(--text);display:flex;align-items:center;gap:8px}
.lc-count{font:500 12px var(--mono);color:var(--lg3);font-variant-numeric:tabular-nums}
.lc-sub{margin:4px 0 0;font-size:13px;color:var(--lg3);line-height:1.6}
.lc-actions{display:flex;align-items:center;gap:7px;flex:none}
.lc-filters{position:relative;display:flex;gap:2px;padding:3px;background:var(--field);border-radius:9px}
.lc-filters button{position:relative;z-index:1;border:0;background:transparent;height:28px;padding:0 10px;font-size:13px;font-weight:500;color:var(--lg3);border-radius:7px;transition:color .15s}
.lc-filters button[aria-checked=true]{color:var(--text)}
.lc-filter-active{position:absolute;top:3px;left:3px;height:28px;pointer-events:none;background:var(--surface);box-shadow:var(--shadow-sm);border:1px solid var(--line);border-radius:7px;transition:transform .19s var(--ease),width .19s var(--ease)}
.lc-privacy{display:grid;place-items:center;width:34px;height:34px;border:1px solid transparent;border-radius:9px;background:transparent;color:var(--lg3);transition:background-color .15s,color .15s,transform .12s}
.lc-privacy:hover{background:var(--field);color:var(--text)}
.lc-privacy:active{transform:scale(.96)}
.lc-privacy[aria-pressed=true]{background:var(--lg-plate);color:var(--lg-blue)}
.log-card button:focus-visible{outline:2px solid var(--agent);outline-offset:2px}
.log-list{padding:2px 20px 10px;min-height:88px;max-height:620px;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable;scrollbar-width:thin;overflow-anchor:none}
.log-entry{position:relative;border:0;border-bottom:1px solid var(--hair);margin:0;background:var(--surface)}
.log-entry.is-new{animation:log-drop .3s var(--ease)}
@keyframes log-drop{
  from{transform:translateY(-6px);opacity:0}
  to{transform:none;opacity:1}
}
.log-entry.is-final{animation:log-settle .38s var(--ease)}
@keyframes log-settle{from{opacity:.72}to{opacity:1}}
.le-head{display:block;height:52px;width:100%;padding:14px 0 10px;border:0;background:var(--surface);text-align:left;color:inherit;font:inherit;border-radius:5px}
.le-top{display:grid;grid-template-columns:minmax(0,104px) minmax(0,1fr) auto 68px 16px;align-items:center;gap:14px;min-width:0}
.log-card .le-head:focus-visible{outline-offset:-2px}
.le-time{font:550 12px var(--mono);color:var(--text-2);font-variant-numeric:tabular-nums;white-space:nowrap;min-width:0;overflow:hidden;text-overflow:ellipsis}
.le-query{display:block;min-width:0;font-size:14px;font-weight:550;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text);transition:color .16s}
.le-query[data-private=true]{font-weight:400;color:var(--lg3)}
.le-head:hover .le-query{color:var(--lg-blue)}
.le-state{display:flex;gap:10px;justify-content:flex-end;flex-wrap:nowrap}
.le-chip{font-size:12px;font-weight:600;padding:2px 7px;line-height:18px;border-radius:6px;white-space:nowrap;display:inline-flex;align-items:center;gap:5px}
.le-dot{width:5px;height:5px;border-radius:50%;background:currentColor;flex:none}
.le-chip[data-t=ok]{color:var(--lg-blue);background:var(--lg-plate)}
.le-chip[data-t=warn]{color:var(--warn-text);background:var(--warn-soft)}
.le-chip[data-t=err]{color:var(--err-text);background:var(--err-soft)}
.le-chip[data-t=idle]{color:var(--lg-label);background:var(--field)}
.le-chip[data-t=run]{color:var(--lg-blue);background:var(--lg-plate)}
.le-chip[data-t=run] .le-dot{animation:log-pulse 1.6s ease-in-out infinite}
@keyframes log-pulse{50%{opacity:.3}}
.le-dur{text-align:right;font:500 12px var(--mono);color:var(--lg3);font-variant-numeric:tabular-nums;white-space:nowrap}
.le-chevron{display:grid;place-items:center;color:var(--lg3);transition:transform .19s var(--ease)}
.le-chevron .ic{width:13px;height:13px}
.log-entry.is-open .le-chevron{transform:rotate(90deg)}

.lband{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:20px;align-items:center;height:48px;padding:0 0 10px;min-width:0}
.lroute-viewport{display:flex;align-items:center;min-width:0;height:38px;overflow-x:auto;overflow-y:hidden;overscroll-behavior-x:contain;scrollbar-width:thin;scrollbar-color:var(--line-2) transparent;border-radius:5px}
.lroute-viewport:focus-visible{outline:2px solid var(--agent);outline-offset:2px}
.lroute{display:flex;align-items:center;flex-wrap:wrap;gap:4px 0;min-width:0;max-width:540px}
.lroute-viewport>.lroute{flex-wrap:nowrap;flex:none;width:min(640px,100%);min-width:max-content;max-width:none}
.lroute-viewport .lwire{flex:1 0 20px;min-width:20px}
.lnode{display:flex;align-items:center;gap:6px;flex:none;padding:3px 6px;border-radius:6px;border:1px solid transparent;min-width:0}
.lnode .tile{--s:18px;border-radius:4px;background:transparent;border-color:transparent;flex:none}
.lnode[data-s=off] .tile{filter:grayscale(1);opacity:.5}
.lnode .lhub{display:grid;place-items:center;width:18px;height:18px;color:var(--lg3)}
.lnode .lhub .ic{width:15px;height:15px}
.lnode .ln-name{font-size:12px;color:var(--lg-label);white-space:nowrap}
.lnode[data-s=hit]{background:var(--lg-plate)}
.lnode[data-s=hit] .ln-name,.lnode[data-s=hit] .lhub{color:var(--lg-blue)}
.lnode[data-s=hit][data-tone=warn]{background:var(--warn-soft)}
.lnode[data-s=hit][data-tone=warn] .ln-name{color:var(--warn-text)}
.lnode[data-s=fail]{background:var(--err-soft)}
.lnode[data-s=fail] .ln-name{color:var(--err-text)}
.lnode[data-s=off]{border-style:dashed;border-color:var(--line-2)}
.lnode[data-s=off] .ln-name{color:var(--lg3)}
.lwire{position:relative;flex:0 0 24px;min-width:15px;height:1px;margin:0 5px;color:var(--agent);background:repeating-linear-gradient(90deg,var(--line-2) 0 3px,transparent 3px 6px)}
.lwire[data-s=flow],.lwire[data-s=back]{background:currentColor}
.lwire[data-s=back]{color:var(--warn)}
.lwire[data-s=dead]{color:var(--err);background:repeating-linear-gradient(90deg,currentColor 0 3px,transparent 3px 6px)}
.lwire[data-s=flow]::before,.lwire[data-s=back]::before{content:"";position:absolute;right:0;top:-2px;width:5px;height:5px;border-top:1px solid currentColor;border-right:1px solid currentColor;transform:rotate(45deg)}
.log-entry.is-replaying .lroute > *,.history-route.is-replaying > *{opacity:.35}
.log-entry.is-replaying .lroute > .is-replay-seen,.history-route.is-replaying > .is-replay-seen{opacity:1}
.log-entry.is-replaying .lnode[data-s=hit],.history-route.is-replaying .lnode[data-s=hit]{background:var(--rp-blue-soft)}
.log-entry.is-replaying .lnode[data-s=fail],.history-route.is-replaying .lnode[data-s=fail]{background:color-mix(in srgb,var(--rp-coral) 8%,var(--surface))}
.log-entry.is-replaying .lnode[data-s=fail] .ln-name,.history-route.is-replaying .lnode[data-s=fail] .ln-name{color:var(--rp-coral-text)}
.log-entry.is-replaying .lwire[data-s=dead],.history-route.is-replaying .lwire[data-s=dead]{color:var(--rp-coral)}
.log-entry.is-replaying .lwire[data-s=flow],.history-route.is-replaying .lwire[data-s=flow]{color:var(--rp-blue)}
.log-entry.is-replaying .lwire[data-s=back],.history-route.is-replaying .lwire[data-s=back]{color:var(--rp-amber)}

.ldet{display:grid;grid-template-rows:0fr;opacity:0;transition:grid-template-rows .26s var(--ease),opacity .18s}
.ldet-inner{overflow:hidden;min-height:0}
.log-entry.is-open .ldet{grid-template-rows:1fr;opacity:1}
.ldet-body{padding:0}
.lquery{min-width:0;padding:6px 0 14px}
.ldet code{font:500 12px var(--mono);color:var(--lg-label);background:var(--field);border-radius:4px;padding:1px 5px}
.log-usage{padding-top:1px}
.lu-table{overflow-x:auto;scrollbar-width:thin;scrollbar-color:var(--line-2) transparent}
.lu-columns,.lu-row{display:grid;grid-template-columns:minmax(110px,1fr) minmax(65px,.65fr) minmax(100px,1fr) minmax(130px,1.2fr);gap:12px;align-items:center;min-width:0}
.lu-columns{font-size:12px;color:var(--lg3);line-height:1.6;padding:0 0 5px}
.lu-columns>[role=columnheader]{display:flex;align-items:center;gap:5px}
.lu-row{padding:7px 0;min-height:35px;font-size:13px;line-height:1.6}
.lu-row+.lu-row{border-top:1px solid var(--hair)}
.lu-provider{display:flex;align-items:center;gap:7px;font-weight:550}
.lu-provider .tile{--s:18px;border-radius:4px;flex:none}
.lu-provider small{font-size:12px;font-weight:400;color:var(--lg3);margin-left:7px}
.lu-provider .lhub{width:18px;height:18px;display:grid;place-items:center;color:var(--lg3)}
.lu-operation{color:var(--lg-label)}
.lu-result{display:flex;align-items:center;gap:6px;color:var(--lg-label);flex-wrap:wrap}
.lu-result[data-result=failed]{color:var(--err-text)}
.lu-result[data-result=running]{color:var(--lg-blue)}
.lu-result code{font-size:11px;font-weight:500;max-width:160px;overflow-wrap:anywhere}
.lu-charge{font-variant-numeric:tabular-nums;font-weight:550;display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.lu-charge small{font-size:11px;font-weight:400;color:var(--lg3)}
.lu-charge[data-basis=estimated] small{color:var(--warn-text)}
.lu-unknown{display:inline-flex;align-items:center;gap:5px;color:var(--lg3);font-size:12px}
.lu-info{display:inline-flex;align-items:center;justify-content:center;flex:none;width:20px;height:20px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--lg3);cursor:help;vertical-align:middle;transition:color .15s var(--ease),background-color .15s var(--ease)}
.lu-info-icon{display:block;width:16px;height:16px;stroke:currentColor;stroke-width:1.25;stroke-linecap:round}
.lu-info-icon circle{fill:var(--surface)}
.lu-info:hover,.lu-info:focus-visible{color:var(--lg-blue);background:var(--lg-plate)}
[data-theme=dark] .lu-info-icon circle{fill:#f4f5f7;stroke:#f4f5f7}
[data-theme=dark] .lu-info-icon path{stroke:#555e6d}
.lu-empty,.lu-empty-row{margin:0;padding:7px 0;color:var(--lg3);font-size:12px;line-height:1.65}
.lc-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 12px 9px 20px;border-top:1px solid var(--hair);font-size:12px;color:var(--lg3)}
.log-card #logClear{color:var(--lg3);height:28px;font-size:13px}
.lc-empty{display:grid;gap:6px;justify-items:center;padding:38px 20px 40px;text-align:center}
.lc-empty p{margin:0;font-size:13px;color:var(--text-2)}
.lc-empty small{font-size:13px;color:var(--lg3)}

@container (max-width:680px){
  .lc-head{flex-wrap:wrap;padding:16px}
  .lc-actions{flex-wrap:wrap}
  .log-list{padding-inline:10px}
  .le-top{grid-template-columns:78px minmax(0,1fr) auto 48px 14px;gap:9px}
  .le-state{gap:6px}
  .lband{gap:12px}
  .lu-columns,.lu-row{min-width:520px}
  .lc-foot{padding-left:16px;flex-wrap:wrap}
}
@container (max-width:420px){
  .le-head{height:78px}
  .le-top{grid-template-columns:minmax(0,1fr) auto auto 14px;row-gap:9px}
  .le-time{grid-area:1/1}
  .le-state{grid-area:1/2}
  .le-top>.le-dur{grid-area:1/3}
  .le-chevron{grid-area:1/4}
  .le-query{grid-area:2/1/3/5}
}

.dlg-form:has(#quotaPanel) .f-help{font-size:13px;line-height:1.65}
.dlg-form:has(#quotaPanel) .field:has(+ #quotaSlot){border-bottom:0}
.log-card{min-width:0}

.route-tooltip:is([data-kind=log],[data-kind=quota]){max-height:min(280px,calc(100vh - 24px));overflow-y:auto;animation:log-tip-in .14s var(--ease)}
@keyframes log-tip-in{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}

@media(prefers-reduced-motion:reduce){.ldet,.le-chevron,.lu-info,.route-tooltip:is([data-kind=log],[data-kind=quota]){transition:none!important;animation:none!important}.le-chip[data-t=run] .le-dot{animation:none!important}}
`;
  var ROUTE_CARD = '<section class="plugin-intro" aria-label="插件介绍">\n  <p class="intro-title">搜索不止一条路<a class="intro-github" href="https://github.com/Lain-in-coding/dsh-grok-search" target="_blank" rel="noopener noreferrer" aria-label="打开 dsh-grok-search 的 GitHub 仓库（新窗口）" title="用着还行？给个 star"><span class="tile" data-logo="github" data-fit="contain" style="--k:100%"><img alt="" draggable="false"></span></a></p>\n  <nav class="intro-illustration" aria-label="搜索服务官方网站">\n    <a class="intro-host" href="https://deepseek.com/harness" target="_blank" rel="noopener noreferrer" aria-label="打开 DeepSeek Harness 官网（新窗口）" title="DeepSeek Harness 官网"><span class="tile" data-logo="dsh" data-fit="cover"><img alt="" draggable="false"></span></a>\n    <div class="intro-network">\n    <svg class="intro-lines" viewBox="0 0 440 44" fill="none" aria-hidden="true">\n      <path class="intro-branch" d="M25 22H53C68 22 63 6 80 6H416M103 6V12M181 6V12M259 6V12M337 6V12M415 6V12"/>\n      <circle cx="53" cy="22" r="2" class="intro-junction"/>\n    </svg>\n    <a class="intro-core" href="https://github.com/Episkey-G/GrokSearch-rs" target="_blank" rel="noopener noreferrer" aria-label="打开 grok-search-rs 项目（新窗口）" title="grok-search-rs · 搜索内核">\n      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="5" cy="12" r="2.3"/><circle cx="19" cy="5.5" r="2"/><circle cx="19" cy="12" r="2"/><circle cx="19" cy="18.5" r="2"/><path d="M7.3 12h3.2m0 0c2.6 0 2.4-6.5 6.5-6.5M10.5 12h6.5M10.5 12c2.6 0 2.4 6.5 6.5 6.5"/></svg>\n    </a>\n    <a class="intro-source intro-source-grok" href="https://grok.com/" target="_blank" rel="noopener noreferrer" aria-label="打开 Grok 官网（新窗口）" title="Grok 官网"><span class="tile" data-logo="grok" data-fit="cover"><img alt="" draggable="false"></span></a>\n    <a class="intro-source intro-source-tavily" href="https://tavily.com/" target="_blank" rel="noopener noreferrer" aria-label="打开 Tavily 官网（新窗口）" title="Tavily 官网"><span class="tile" data-logo="tavily" data-fit="cover"><img alt="" draggable="false"></span></a>\n    <a class="intro-source intro-source-exa" href="https://exa.ai/" target="_blank" rel="noopener noreferrer" aria-label="打开 Exa 官网（新窗口）" title="Exa 官网"><span class="tile" data-logo="exa" data-fit="contain" style="--k:54%"><img alt="" draggable="false"></span></a>\n    <a class="intro-source intro-source-firecrawl" href="https://firecrawl.dev/" target="_blank" rel="noopener noreferrer" aria-label="打开 Firecrawl 官网（新窗口）" title="Firecrawl 官网"><span class="tile" data-logo="firecrawl" data-fit="contain" style="--k:54%"><img alt="" draggable="false"></span></a>\n    <a class="intro-source intro-source-tinyfish" href="https://tinyfish.ai/" target="_blank" rel="noopener noreferrer" aria-label="打开 TinyFish 官网（新窗口）" title="TinyFish 官网"><span class="tile" data-logo="tinyfish" data-fit="contain" style="--k:74%"><img alt="" draggable="false"></span></a>\n    </div>\n  </nav>\n</section>\n<section class="route-card" id="routeCard" data-layout="wide" aria-labelledby="routeTitle">\n  <div class="rc-head">\n    <div class="rc-title">\n      <h3 id="routeTitle" tabindex="-1">搜索路由</h3>\n      <span class="pill" id="statusPill" data-s="load"><i class="pill-dot" aria-hidden="true"></i><span id="statusText">读取配置…</span></span>\n    </div>\n    <div class="rc-actions">\n      <div class="strip-slot" id="stripSlot"><div><div class="strip" id="strip" role="group" aria-label="搜索顺序与最近验证状态"></div></div></div>\n      <button type="button" class="btn" id="testBtn"></button>\n      <div class="popover" id="testPop" role="dialog" aria-modal="false" aria-labelledby="testPopTitle" hidden>\n        <p class="pop-title" id="testPopTitle">测试全部已开启的搜索来源？</p>\n        <p class="pop-text">会逐一测试已开启的搜索来源及其 Key，各次测试会消耗相应额度。</p>\n        <div class="pop-actions">\n          <button type="button" class="btn btn-ghost btn-sm" data-pop="cancel">取消</button>\n          <button type="button" class="btn btn-primary btn-sm" data-pop="go">开始测试</button>\n        </div>\n      </div>\n    </div>\n      <div class="history-bar" id="historyBar" hidden>\n        <span class="history-label" id="historyLabel"></span>\n        <span class="history-phase" id="historyPhase" aria-hidden="true"></span>\n        <div class="history-actions">\n          <button type="button" class="replay-control" id="historyStop">停止</button>\n          <button type="button" class="replay-control history-return" id="historyReturn">返回该条日志</button>\n          <button type="button" class="replay-control history-dismiss" id="historyDismiss" aria-label="关闭回放提示" hidden></button>\n        </div>\n      </div>\n  </div>\n    <div class="history-context" id="historyContext" hidden>\n      <span class="history-query" id="historyQuery"></span>\n      <div class="lroute history-route" id="historyRoute" role="img" aria-label="这条历史记录的完整结果链路" title="最终结果路径，不表示上游网络请求的先后顺序。"></div>\n    </div>\n  <div class="banner-slot" id="bannerSlot"></div>\n  <div class="stage" id="stage" data-layout="wide" role="group" aria-label="搜索路由图">\n    <svg class="wires" id="wires" aria-hidden="true"></svg>\n    <div class="col-agent" id="colAgent">\n      <div class="node node-dsh" id="nodeDsh" title="宿主：DeepSeek Harness 的 web_search 工具">\n        <span class="port" data-port="dsh-out"></span>\n        <span class="port" data-port="dsh-alt"></span>\n        <img class="node-logo" data-logo="dsh" alt="">\n        <span class="node-name">DeepSeek Harness</span>\n        <span class="node-meta">web_search</span>\n      </div>\n      <div class="node node-official" id="nodeOfficial" aria-hidden="true">\n        <span class="port" data-port="off-in"></span>\n        <img class="node-logo" data-logo="deepseek" alt="">\n        <span class="off-text">\n          <span class="node-name">DeepSeek 官方搜索</span>\n          <span class="node-meta">内置 · 已恢复</span>\n        </span>\n      </div>\n    </div>\n    <div class="col-hub">\n      <button type="button" class="node node-hub" id="nodeHub" aria-label="Grok Search Rs 设置">\n        <span class="port" data-port="hub-in"></span>\n        <span class="port" data-port="hub-out"></span>\n        <span class="hub-glyph" id="hubGlyph" aria-hidden="true"></span>\n        <span class="hub-text">\n          <span class="node-name">Grok Search Rs</span>\n          <span class="node-meta" id="hubMeta">准备中…</span>\n        </span>\n        <span class="hub-pill" id="hubPill"><span id="hubPillText">按顺序</span><span aria-hidden="true">›</span></span>\n      </button>\n    </div>\n    <div class="col-list" id="colList">\n      <div class="rgroup" data-group="primary">\n        <div class="rg-label">主搜索</div>\n        <div class="rg-rows" id="rowsPrimary"></div>\n      </div>\n      <div class="rgroup" data-group="supp">\n        <div class="rg-label">补充来源 <span class="rg-hint">拖动排序</span></div>\n        <div class="rg-rows" id="rowsSupp"></div>\n      </div>\n      <div class="rgroup" data-group="extract">\n        <div class="rg-label">专用抽取</div>\n        <div class="rg-rows" id="rowsExtract"></div>\n      </div>\n    </div>\n  </div>\n    <div class="history-stage" id="historyStage" role="group" aria-label="历史搜索结果链路" hidden></div>\n    <p class="history-note" id="historyNote" hidden>历史结果路径 · 动效不代表原始请求时序</p>\n\n  <footer class="rc-foot">\n    <span class="cf-label">配置文件</span>\n    <code class="cf-path" id="cfgPath"></code>\n    <span class="tag" id="cfgTag"></span>\n    <span class="cf-spacer"></span>\n    <button type="button" class="btn btn-ghost btn-sm" data-open="file">打开文件</button>\n    <button type="button" class="btn btn-ghost btn-sm" data-open="folder">打开文件夹</button>\n  </footer>\n</section>\n\n  <section class="log-card" id="logCard" data-region="插件提供的界面" aria-labelledby="logTitle">\n    <div class="lc-head">\n      <div class="lc-title">\n        <h3 id="logTitle">最近记录 <span class="lc-count" id="logCount">0</span></h3>\n        <p class="lc-sub">点击记录查看查询与消耗</p>\n      </div>\n      <div class="lc-actions">\n        <div class="lc-filters" role="radiogroup" aria-label="筛选搜索记录">\n          <span class="lc-filter-active" id="logFilterActive" aria-hidden="true"></span>\n          <button type="button" role="radio" data-logfilter="all" aria-checked="true" tabindex="0">全部</button>\n          <button type="button" role="radio" data-logfilter="ok" aria-checked="false" tabindex="-1">成功</button>\n          <button type="button" role="radio" data-logfilter="fallback" aria-checked="false" tabindex="-1">回退</button>\n          <button type="button" role="radio" data-logfilter="failed" aria-checked="false" tabindex="-1">失败</button>\n        </div>\n        <button type="button" class="lc-privacy" id="logPrivacy" aria-pressed="false" aria-label="隐藏搜索内容" title="隐藏搜索内容"></button>\n      </div>\n    </div>\n    <div class="log-list" id="logList" role="list" aria-label="搜索、GitHub读取与路由记录"></div>\n    <footer class="lc-foot">\n      <span id="logNote">仅内存 · 最近 20 条 · 停用或退出 DSH 后清空</span>\n      <button type="button" class="btn btn-ghost btn-sm" id="logClear">清空记录</button>\n    </footer>\n    <div class="sr-only" id="logAnnouncer" role="status" aria-live="polite" aria-atomic="true"></div>\n  </section>\n\n<div class="route-tooltip" id="logTooltip" role="tooltip" hidden></div>\n';
  var ROUTE_LAYER = '<div class="overlay" id="overlay" hidden>\n  <div class="dialog" id="dialog" role="dialog" aria-modal="true" aria-labelledby="dlgTitle"></div>\n</div>\n<div class="route-tooltip" id="routeTooltip" role="tooltip" hidden></div>\n<div class="toasts" id="toasts" aria-live="polite"></div>\n<div class="sr-only" id="announcer" aria-live="polite"></div>\n';

  // src/client.template.js
  window.__ModuleLoader__.load({
    id: "dsh-grok-search",
    factory: (require2) => {
      const React = require2("react");
      const { jsx } = require2("react/jsx-runtime");
      const { useEffect, useRef } = React;
      const NS = "plugins.dshGrokSearch";
      const inject = ["slots", "locale", "remote"];
      const SOURCE_CHAIN = createSourceChain();
      const descriptors = SETTINGS_DESCRIPTORS.map((descriptor) => ({
        ...descriptor,
        parameters: descriptor.parameters.map((parameter) => ({
          ...parameter,
          codec: createSettingsCodec(parameter.codec.typeSymbol, parameter.codec.jsonSchema)
        })),
        result: createSettingsCodec(descriptor.result.typeSymbol, descriptor.result.jsonSchema)
      }));
      const text = { title: "Grok 搜索", configure: "Grok 搜索设置" };
      const logMemory = { private: false };
      function ProjectLink({ theme }) {
        const element = useRef(null);
        useEffect(() => {
          const shadow = element.current.shadowRoot || element.current.attachShadow({ mode: "open" });
          shadow.innerHTML = `<style>
          :host{display:inline-flex;flex:none;width:24px;height:24px;vertical-align:middle}
          .project{position:relative;display:inline-flex;--focus:#4d6bfe}
          .project[data-theme=dark]{--focus:#9aabff}
          a{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;width:24px;height:24px;border-radius:6px;text-decoration:none;cursor:pointer}
          img{display:block;width:16px;height:16px;object-fit:contain;opacity:.7;transition:opacity 140ms ease}
          a:hover img,a:focus-visible img{opacity:1}
          a:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
          a:active img{opacity:.85}
          [role=tooltip]{position:absolute;top:calc(100% + 8px);left:50%;z-index:10;transform:translate(-50%,-2px);padding:5px 9px;border:1px solid #ffffff16;border-radius:7px;background:#26282d;color:#f5f6f8;box-shadow:0 4px 12px #0002;font:500 12px/1.5 "Segoe UI","Microsoft YaHei",sans-serif;white-space:nowrap;opacity:0;visibility:hidden;pointer-events:none;transition:opacity 140ms ease,transform 140ms ease,visibility 140ms}
          [role=tooltip]::before{content:"";position:absolute;bottom:100%;left:0;right:0;height:8px}
          .project:not([data-dismissed]):is(:hover,:focus-within) [role=tooltip]{opacity:1;visibility:visible;pointer-events:auto;transform:translate(-50%,0)}
          @media(prefers-reduced-motion:reduce){img,[role=tooltip]{transition:none}}
        </style><span class="project"><a href="https://github.com/Lain-in-coding/dsh-grok-search" target="_blank" rel="noopener noreferrer" aria-label="打开 dsh-grok-search 的 GitHub 项目首页（新窗口）" aria-describedby="project-tip"><img alt="" aria-hidden="true" width="16" height="16" draggable="false"></a><span id="project-tip" role="tooltip">用着还行？给个 star</span></span>`;
          const root = shadow.querySelector(".project");
          const image = shadow.querySelector("img");
          const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
          const updateTheme = () => {
            const dark = theme?.current ?? systemTheme.matches;
            root.dataset.theme = dark ? "dark" : "light";
            image.src = dark ? LOGOS.githubDark : LOGOS.github;
          };
          const show = () => root.removeAttribute("data-dismissed");
          const dismiss = () => root.setAttribute("data-dismissed", "");
          const keydown = (event) => {
            if (event.key === "Escape" && root.matches(":hover,:focus-within")) dismiss();
          };
          root.addEventListener("pointerenter", show);
          root.addEventListener("focusin", show);
          document.addEventListener("keydown", keydown);
          root.addEventListener("click", dismiss);
          theme?.listeners.add(updateTheme);
          systemTheme.addEventListener("change", updateTheme);
          updateTheme();
          return () => {
            theme?.listeners.delete(updateTheme);
            systemTheme.removeEventListener("change", updateTheme);
            root.removeEventListener("pointerenter", show);
            root.removeEventListener("focusin", show);
            document.removeEventListener("keydown", keydown);
            root.removeEventListener("click", dismiss);
            shadow.replaceChildren();
          };
        }, [theme]);
        return jsx("span", { ref: element, "data-dsg-project": "1" });
      }
      function ProjectBadge({ subject, theme }) {
        return subject?.kind === "bundle" && subject.pkg?.name === "dsh-grok-search" ? jsx(ProjectLink, { theme }) : null;
      }
      function remoteAdapter(remote) {
        return Object.fromEntries(descriptors.map(({ method }) => [method, async (...args) => {
          let result;
          try {
            result = await remote.grokSearchSettings[method](...args);
          } catch (error) {
            const code = typeof error?.code === "string" && /^(?:SETTINGS_|SEARCH_LOG_|CONFIG_|gateway[/.])[\w./-]{1,64}$/.test(error.code) ? error.code : "SETTINGS_UNAVAILABLE";
            throw Object.assign(new Error("设置连接不可用，请重新打开插件详情页。"), {
              code
            });
          }
          if (result?.ok === true) return result.value;
          throw Object.assign(new Error(result?.error?.message || "设置操作失败，请重试。"), {
            code: result?.error?.code || "SETTINGS_OPERATION_FAILED",
            details: result?.error?.details || {}
          });
        }]));
      }
      function RoutePage({ remote, theme }) {
        const element = useRef(null);
        const memory = useRef({});
        useEffect(() => {
          if (!element.current) return;
          const shadow = element.current.shadowRoot || element.current.attachShadow({ mode: "open" });
          shadow.innerHTML = `<div class="dsg-surface dsg-root"><div class="route-scroll">${ROUTE_CARD}</div></div>`;
          const detachMainStyle = attachSharedStyles(shadow, ROUTE_CSS);
          const root = shadow.querySelector(".dsg-root");
          const layerHost = document.createElement("div");
          layerHost.dataset.dsgLayer = "1";
          Object.assign(layerHost.style, {
            position: "fixed",
            top: "0",
            left: "0",
            width: "0",
            height: "0",
            zIndex: "2147483000",
            pointerEvents: "none"
          });
          const layerShadow = layerHost.attachShadow({ mode: "open" });
          layerShadow.innerHTML = `<div class="dsg-surface dsg-layer">${ROUTE_LAYER}</div>`;
          const detachLayerStyle = attachSharedStyles(layerShadow, ROUTE_CSS);
          document.body.appendChild(layerHost);
          const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
          const currentTheme = () => theme?.current === null || theme?.current === void 0 ? systemTheme.matches : theme.current;
          const controller = createRouteController({
            root,
            layer: layerShadow.querySelector(".dsg-layer"),
            remote: remoteAdapter(remote),
            logos: LOGOS,
            sourceChain: SOURCE_CHAIN,
            memory: memory.current,
            logMemory,
            createSearchLogView,
            createQuotaView,
            dark: currentTheme()
          });
          const updateTheme = () => controller.setTheme(currentTheme());
          theme?.listeners.add(updateTheme);
          systemTheme.addEventListener("change", updateTheme);
          updateTheme();
          return () => {
            theme?.listeners.delete(updateTheme);
            systemTheme.removeEventListener("change", updateTheme);
            controller.dispose();
            detachMainStyle();
            detachLayerStyle();
            layerHost.remove();
            shadow.replaceChildren();
          };
        }, [remote, theme]);
        return jsx("div", {
          ref: element,
          "data-dsg-route": "1",
          style: { width: "100%", minWidth: 0 },
          // rc.1 renders a bordered section even for an empty detail document.
          // Match only the empty document immediately before our own config slot.
          // React owns this light-DOM style; it leaves with the page on unmount.
          children: jsx("style", {
            "data-dsg-empty-detail": "1",
            children: `[data-detail-document]:has(> [role="region"] > :only-child:empty):has(+ [data-plugin-config] > [data-slot="plugins.bundle.config"] > [data-dsg-route="1"]) { display: none; }`
          })
        });
      }
      async function apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh: text, en: text }), "dsh-grok-search: locale");
        ctx.effect(() => {
          if (typeof document === "undefined") return () => {
          };
          const style = document.createElement("style");
          style.dataset.dsgChatStyle = "1";
          style.textContent = TOOL_ROUTE_CSS;
          document.head.appendChild(style);
          return () => style.remove();
        }, "dsh-grok-search: chat card styles");
        const unmountRemote = await ctx.remote.$mount({ package: "dsh-grok-search", descriptors });
        const theme = { current: null, listeners: /* @__PURE__ */ new Set() };
        const themeView = ctx.inject(["theme"], (themeCtx) => {
          const update = (snapshot) => {
            theme.current = snapshot.active.colorScheme === "dark";
            theme.listeners.forEach((listener) => listener());
          };
          update(themeCtx.theme.getTheme());
          themeCtx.on("theme/change", update);
          return () => {
            theme.current = null;
            theme.listeners.forEach((listener) => listener());
          };
        });
        const ui = ctx.inject(["remote.grokSearchSettings", "slots", "locale"], (settingsCtx) => {
          settingsCtx.slots.inject("plugins.detail.badge", () => settingsCtx.slots.register({
            name: "plugins.detail.badge",
            id: "dsh-grok-search-project",
            locale: NS,
            order: 30,
            inject: () => ({ theme })
          }, ProjectBadge));
          settingsCtx.slots.inject("plugins.bundle.config", () => settingsCtx.slots.register({
            name: "plugins.bundle.config",
            key: "dsh-grok-search",
            locale: NS,
            order: 30,
            inject: () => ({ remote: settingsCtx.remote, theme })
          }, RoutePage));
          settingsCtx.slots.inject("tool.call.toolview", () => {
            let stopped = false, selected = null, wrapper = null, remove = null;
            const refresh = () => {
              if (stopped) return;
              const entry = settingsCtx.slots.entries("tool.call.toolview").find((row) => row.options.key === "web_search" && row.component !== wrapper);
              if (entry === selected) return;
              remove?.();
              remove = null;
              selected = entry;
              if (!entry || entry.inject || entry.store || entry.children || entry.select) return;
              wrapper = createToolRouteView({
                React,
                jsx,
                remote: remoteAdapter(settingsCtx.remote),
                Original: entry.component,
                logos: LOGOS,
                theme
              }).Component;
              remove = settingsCtx.slots.register({
                name: "tool.call.toolview",
                key: "web_search",
                locale: entry.locale,
                priority: (entry.options.priority ?? 0) - 1
              }, wrapper);
            };
            const unsubscribe = settingsCtx.slots.subscribe("tool.call.toolview", refresh);
            refresh();
            return () => {
              stopped = true;
              unsubscribe();
              remove?.();
            };
          });
        });
        try {
          await ui;
        } catch (error) {
          await ui.dispose();
          await themeView.dispose();
          await unmountRemote();
          throw error;
        }
        return async () => {
          logMemory.private = false;
          await ui.dispose();
          await themeView.dispose();
          await unmountRemote();
        };
      }
      return { NS, inject, apply, __test: Object.freeze({
        descriptors,
        remoteAdapter,
        sourceChain: SOURCE_CHAIN,
        toolRouteView: createToolRouteView,
        routeController: createRouteController,
        searchLogView: createSearchLogView,
        quotaView: createQuotaView,
        LOGOS,
        TOOL_ROUTE_CSS,
        ROUTE_CSS,
        ROUTE_CARD,
        ROUTE_LAYER
      }) };
    }
  });
})();

import { describe, expect, it } from "vitest";
import { fastRecommendation, launchChoice, parseAgyModels, parseClaudeModels, parseCodexModels, preferredEffort, recommendFast, sortEfforts, type CliModelInfo } from "../src/cli/models";

// The model lists as each CLI reports them (fixtures written after their real output shapes). No CLI is launched.

describe("Claude Code: the initialize control response", () => {
  const response = {
    commands: [{ name: "compact", description: "Clear history but keep a summary" }],
    output_style: "default",
    models: [
      {
        value: "default",
        displayName: "Default (recommended)",
        description: "Opus 5.5 · Most capable for complex work",
        resolvedModel: "claude-opus-5-5",
        supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
      },
      {
        value: "sonnet",
        displayName: "Sonnet",
        description: "Sonnet 5 · Best for everyday tasks",
        resolvedModel: "claude-sonnet-5",
        supportedEffortLevels: ["low", "medium", "high"],
      },
      {
        value: "opus",
        displayName: "Opus",
        description: "Opus 5.5 · Most capable for complex work",
        resolvedModel: "claude-opus-5-5",
        // out of order on purpose: the parser sorts weakest first
        supportedEffortLevels: ["max", "low", "xhigh", "medium", "high"],
      },
      { value: "haiku", displayName: "Haiku", resolvedModel: "claude-haiku-5" },
      { displayName: "an entry without a value is skipped" },
    ],
  };

  it("lists every alias but the default one, with efforts weakest first and the description only when given", () => {
    const { models } = parseClaudeModels(response);
    expect(models.map((m) => m.id)).toEqual(["sonnet", "opus", "haiku"]);
    expect(models.some((m) => m.id === "default")).toBe(false);
    expect(models[0]).toEqual({ id: "sonnet", label: "Sonnet", description: "Sonnet 5 · Best for everyday tasks", efforts: ["low", "medium", "high"] });
    expect(models[1]!.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(models[2]).toEqual({ id: "haiku", label: "Haiku", efforts: [] });
  });

  it("recommends the alias the default entry resolves to, at xhigh (not max, not the first listed)", () => {
    expect(parseClaudeModels(response).recommended).toEqual({ model: "opus", effort: "xhigh" });
  });

  it("without a default entry, recommends the first model at its preferred effort", () => {
    const { recommended } = parseClaudeModels({ models: response.models.filter((m) => m.value !== "default") });
    expect(recommended).toEqual({ model: "sonnet", effort: "high" });
  });

  it("recommends the listed light model for fast work, without an effort when it has none", () => {
    expect(parseClaudeModels(response).recommendedFast).toEqual({ model: "haiku" });
  });

  it("a recommended model without efforts is recommended without one", () => {
    const { recommended } = parseClaudeModels({
      models: [
        { value: "default", resolvedModel: "claude-haiku-5" },
        { value: "haiku", displayName: "Haiku", resolvedModel: "claude-haiku-5" },
      ],
    });
    expect(recommended).toEqual({ model: "haiku" });
  });

  it("an answer without models gives an empty list and no recommendation", () => {
    expect(parseClaudeModels({ commands: [] })).toEqual({ models: [], recommended: null, recommendedFast: null });
    expect(parseClaudeModels(null)).toEqual({ models: [], recommended: null, recommendedFast: null });
  });
});

describe("Codex: codex debug models", () => {
  const level = (effort: string) => ({ effort, description: `${effort} reasoning` });
  const catalogue = {
    models: [
      {
        slug: "gpt-6-mini",
        display_name: "GPT-6 mini",
        description: "Smaller, faster",
        priority: 3,
        visibility: "list",
        supported_reasoning_levels: ["low", "medium", "high"].map(level),
      },
      {
        slug: "gpt-6-codex",
        display_name: "GPT-6 Codex",
        description: "Optimized for coding agents",
        priority: 1,
        visibility: "list",
        default_reasoning_level: "medium",
        supported_reasoning_levels: ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"].map(level),
      },
      { slug: "gpt-6-internal-eval", display_name: "internal", priority: 0, visibility: "hide", supported_reasoning_levels: ["high"].map(level) },
      // no visibility field: listed
      { slug: "gpt-6", display_name: "GPT-6", priority: 2, supported_reasoning_levels: ["high", "low"].map(level) },
      // no priority: after the ranked ones
      { slug: "gpt-5.9", visibility: "list", supported_reasoning_levels: [] },
      { display_name: "no slug, skipped", priority: 1 },
    ],
  };

  it("drops hidden entries and orders the rest by priority", () => {
    const { models } = parseCodexModels(catalogue);
    expect(models.map((m) => m.id)).toEqual(["gpt-6-codex", "gpt-6", "gpt-6-mini", "gpt-5.9"]);
    expect(models.some((m) => m.id === "gpt-6-internal-eval")).toBe(false);
  });

  it("takes efforts from supported_reasoning_levels objects, weakest first; label falls back to the slug", () => {
    const { models } = parseCodexModels(catalogue);
    expect(models[0]).toEqual({
      id: "gpt-6-codex",
      label: "GPT-6 Codex",
      description: "Optimized for coding agents",
      efforts: ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
    });
    expect(models[1]).toEqual({ id: "gpt-6", label: "GPT-6", efforts: ["low", "high"] });
    expect(models[3]).toEqual({ id: "gpt-5.9", label: "gpt-5.9", efforts: [] });
  });

  it("recommends priority 1 at xhigh even though max and ultra are offered", () => {
    expect(parseCodexModels(catalogue).recommended).toEqual({ model: "gpt-6-codex", effort: "xhigh" });
  });

  it("recommends the light model for fast work at medium, though it is listed after the flagship", () => {
    expect(parseCodexModels(catalogue).recommendedFast).toEqual({ model: "gpt-6-mini", effort: "medium" });
  });

  it("accepts a bare array and plain-string levels", () => {
    const { models, recommended } = parseCodexModels([{ slug: "gpt-x", priority: 1, supported_reasoning_levels: ["high", "medium"] }]);
    expect(models).toEqual([{ id: "gpt-x", label: "gpt-x", efforts: ["medium", "high"] }]);
    expect(recommended).toEqual({ model: "gpt-x", effort: "high" });
  });

  it("nothing listed: no recommendation", () => {
    expect(parseCodexModels({ models: [{ slug: "x", visibility: "hide" }] })).toEqual({ models: [], recommended: null, recommendedFast: null });
  });
});

describe("Antigravity: agy models", () => {
  const output = [
    "Fetching available models...",
    "gemini-4-carbon-medium\tGemini 4 Carbon (Medium)",
    "gemini-4-carbon-high\tGemini 4 Carbon (High)",
    "gemini-4-carbon-low\tGemini 4 Carbon (Low)",
    "gemini-4-flash\tGemini 4 Flash",
    "gemini-4-carbon-high\tGemini 4 Carbon (High)", // a repeated line adds nothing
    "",
  ].join("\n");

  it("ignores the progress line and folds the effort variants of one family into one model", () => {
    const { models } = parseAgyModels(output);
    expect(models).toEqual([
      { id: "gemini-4-carbon", label: "Gemini 4 Carbon", efforts: ["low", "medium", "high"] },
      { id: "gemini-4-flash", label: "Gemini 4 Flash", efforts: [] },
    ]);
  });

  it("recommends the first family at high when it has no xhigh", () => {
    expect(parseAgyModels(output).recommended).toEqual({ model: "gemini-4-carbon", effort: "high" });
  });

  it("recommends the flash family for fast work", () => {
    expect(parseAgyModels(output).recommendedFast).toEqual({ model: "gemini-4-flash" });
  });

  it("a family with xhigh is recommended at xhigh", () => {
    const text = ["Fetching available models...", "gemini-4-ultra-xhigh\tGemini 4 Ultra (XHigh)", "gemini-4-ultra-high\tGemini 4 Ultra (High)", "gemini-4-flash\tGemini 4 Flash"].join("\n");
    const { models, recommended } = parseAgyModels(text);
    expect(models[0]).toEqual({ id: "gemini-4-ultra", label: "Gemini 4 Ultra", efforts: ["high", "xhigh"] });
    expect(recommended).toEqual({ model: "gemini-4-ultra", effort: "xhigh" });
  });

  it("an id whose suffix does not match the label's effort stays as it is", () => {
    const { models } = parseAgyModels("gemini-4-pro-preview\tGemini 4 Pro (High)\nfoo-high\tFoo High\n");
    expect(models).toEqual([
      { id: "gemini-4-pro-preview", label: "Gemini 4 Pro (High)", efforts: [] },
      { id: "foo-high", label: "Foo High", efforts: [] },
    ]);
  });

  it("only progress output: nothing listed", () => {
    expect(parseAgyModels("Fetching available models...\n")).toEqual({ models: [], recommended: null, recommendedFast: null });
  });
});

describe("efforts", () => {
  it("preferredEffort: xhigh where offered, else the strongest below it, else the weakest above it", () => {
    expect(preferredEffort(["low", "medium", "high", "xhigh", "max"])).toBe("xhigh");
    expect(preferredEffort(["max", "xhigh", "ultra"])).toBe("xhigh");
    expect(preferredEffort(["low", "high", "medium"])).toBe("high");
    expect(preferredEffort(["minimal", "low"])).toBe("low");
    expect(preferredEffort([])).toBeUndefined();
    expect(preferredEffort(["max"])).toBe("max");
    expect(preferredEffort(["ultra", "max"])).toBe("max");
    expect(preferredEffort(["High", "LOW"])).toBe("high");
  });

  it("sortEfforts: weakest first, lower-cased, without duplicates; unknown levels last", () => {
    expect(sortEfforts(["max", "Low", "xhigh", "low", "turbo", "medium"])).toEqual(["low", "medium", "xhigh", "max", "turbo"]);
  });

  it("launchChoice: Antigravity takes the effort as the id's suffix; Claude Code and Codex take it separately", () => {
    expect(launchChoice("agy", { model: "gemini-4-carbon", effort: "high" })).toEqual({ model: "gemini-4-carbon-high", effort: undefined });
    expect(launchChoice("agy", { model: "gemini-4-flash" })).toEqual({ model: "gemini-4-flash", effort: undefined });
    expect(launchChoice("claude", { model: "opus", effort: "xhigh" })).toEqual({ model: "opus", effort: "xhigh" });
    expect(launchChoice("codex", { model: "gpt-6-codex", effort: "high" })).toEqual({ model: "gpt-6-codex", effort: "high" });
    expect(launchChoice("codex", { model: "gpt-6-codex" })).toEqual({ model: "gpt-6-codex", effort: undefined });
  });
});

describe("the fast tier's automatic choice", () => {
  const FLAGSHIP: CliModelInfo = { id: "flagship-9", label: "Flagship 9", efforts: ["minimal", "low", "medium", "high", "xhigh", "max"] };
  const GENERAL: CliModelInfo = { id: "general-9", label: "General 9", efforts: ["low", "medium", "high"] };
  const top = { model: "flagship-9", effort: "xhigh" };

  it("picks the first light model in catalogue order, at medium where offered", () => {
    const models: CliModelInfo[] = [
      FLAGSHIP,
      GENERAL,
      { id: "vendor-9-mini", label: "Vendor 9 mini", efforts: ["low", "medium", "high"] },
      { id: "vendor-9-nano", label: "Vendor 9 nano", efforts: ["low"] },
    ];
    expect(recommendFast(models, top)).toEqual({ model: "vendor-9-mini", effort: "medium" });
  });

  it("a light model's effort: medium, else low, else its weakest, else none", () => {
    const light = (efforts: string[]): CliModelInfo[] => [FLAGSHIP, { id: "quick", label: "Quick Flash", efforts }];
    expect(recommendFast(light(["low", "medium", "high"]), top)).toEqual({ model: "quick", effort: "medium" });
    expect(recommendFast(light(["minimal", "low", "high"]), top)).toEqual({ model: "quick", effort: "low" });
    expect(recommendFast(light(["high", "xhigh"]), top)).toEqual({ model: "quick", effort: "high" });
    expect(recommendFast(light([]), top)).toEqual({ model: "quick" });
  });

  it("recognises the light line by id or label, case-insensitively, as a whole word", () => {
    const pick = (m: CliModelInfo) => recommendFast([FLAGSHIP, m], top)?.model;
    for (const [id, label] of [
      ["x-haiku-5", "X"],
      ["x-flash-lite", "X"],
      ["x-2-flash", "X"],
      ["x-5-codex-spark", "X"],
      ["x-small", "X"],
      ["x-4o-mini", "X"],
      ["x1", "X 1 Nano"],
      ["x2", "X 2 (Fast)"],
      ["x3", "X3 LITE"],
    ] as const) {
      expect(pick({ id, label, efforts: [] }), id).toBe(id);
    }
    // a light word inside another word does not count
    for (const [id, label] of [
      ["gemini-9-pro", "Gemini 9 Pro"],
      ["x-minimal", "X minimal"],
      ["x-smaller", "X"],
      ["x-sparkle", "Sparkles"],
      ["x-elite", "Satellite"],
      ["x-breakfast", "X"],
    ] as const) {
      expect(pick({ id, label, efforts: [] }), id).toBe("flagship-9");
    }
  });

  it("a list without a light model: the recommended model at a lower effort", () => {
    expect(recommendFast([FLAGSHIP, GENERAL], top)).toEqual({ model: "flagship-9", effort: "medium" });
    const highOnly: CliModelInfo = { id: "deep", label: "Deep", efforts: ["high", "xhigh", "max"] };
    expect(recommendFast([highOnly], { model: "deep", effort: "xhigh" })).toEqual({ model: "deep", effort: "high" });
    const lowOnly: CliModelInfo = { id: "plain", label: "Plain", efforts: ["minimal", "low"] };
    expect(recommendFast([lowOnly], { model: "plain", effort: "low" })).toEqual({ model: "plain", effort: "low" });
  });

  it("nothing to lower: the same as recommended; nothing listed: null", () => {
    const bare: CliModelInfo = { id: "bare", label: "Bare", efforts: [] };
    expect(recommendFast([bare], { model: "bare" })).toEqual({ model: "bare" });
    // a recommendation the list does not describe is kept as given
    expect(recommendFast([GENERAL], { model: "elsewhere", effort: "high" })).toEqual({ model: "elsewhere", effort: "high" });
    expect(recommendFast([GENERAL], null)).toBeNull();
    expect(recommendFast([], null)).toBeNull();
  });

  it("fastRecommendation: the catalogue's own value when it carries one, derived from its list when it does not", () => {
    const models = [FLAGSHIP, GENERAL];
    expect(fastRecommendation({ models, recommended: top, recommendedFast: { model: "general-9", effort: "low" } })).toEqual({ model: "general-9", effort: "low" });
    expect(fastRecommendation({ models: [], recommended: null, recommendedFast: null })).toBeNull();
    expect(fastRecommendation({ models, recommended: top })).toEqual({ model: "flagship-9", effort: "medium" });
  });
});

import { describe, expect, it } from "vitest";
import { detectQualityLanguage } from "../src/quality/languages.js";

const cases = [
  ["src/component.astro", "astro"],
  ["infra/main.bicep", "bicep"],
  ["src/main.c", "c"],
  ["src/main.clj", "clojure"],
  ["src/main.cpp", "cpp"],
  ["src/App.cs", "csharp"],
  ["web/styles.css", "css"],
  ["web/styles.scss", "scss"],
  ["web/styles.less", "less"],
  ["lib/main.dart", "dart"],
  ["Dockerfile", "dockerfile"],
  ["lib/app.ex", "elixir"],
  ["src/app.erl", "erlang"],
  ["cmd/main.go", "go"],
  ["schema.graphql", "graphql"],
  ["build.gradle", "groovy"],
  ["src/Main.hs", "haskell"],
  ["public/index.html", "html"],
  ["src/Main.java", "java"],
  ["web/app.jsx", "javascript"],
  ["package.json", "json"],
  ["tsconfig.jsonc", "jsonc"],
  ["src/main.jl", "julia"],
  ["src/Main.kt", "kotlin"],
  ["src/main.lua", "lua"],
  ["Makefile", "makefile"],
  ["README.md", "markdown"],
  ["flake.nix", "nix"],
  ["src/App.m", "objective-c"],
  ["src/main.ml", "ocaml"],
  ["script.pl", "perl"],
  ["public/index.php", "php"],
  ["script.ps1", "powershell"],
  ["api.proto", "protobuf"],
  ["app/main.py", "python"],
  ["analysis.R", "r"],
  ["lib/main.rb", "ruby"],
  ["src/main.rs", "rust"],
  ["src/Main.scala", "scala"],
  ["scripts/check.sh", "shell"],
  ["contracts/Token.sol", "solidity"],
  ["schema.sql", "sql"],
  ["src/App.svelte", "svelte"],
  ["Sources/App.swift", "swift"],
  ["infra/main.tf", "terraform"],
  ["Cargo.toml", "toml"],
  ["src/main.tsx", "typescript"],
  ["src/App.vue", "vue"],
  ["config.xml", "xml"],
  ["config.yaml", "yaml"],
  ["src/main.zig", "zig"],
] as const;

describe("quality language detection", () => {
  it.each(cases)("detects %s as %s", (file, language) => {
    expect(detectQualityLanguage(file)).toBe(language);
  });

  it("uses a shebang for extensionless scripts", () => {
    expect(detectQualityLanguage("bin/check", "#!/usr/bin/env bash\necho ok\n")).toBe("shell");
    expect(detectQualityLanguage("bin/tool", "#!/usr/bin/env python3\nprint('ok')\n")).toBe("python");
  });

  it("supports trusted project language overrides", () => {
    expect(detectQualityLanguage("views/page.templ", "hello", { ".templ": "go-template" })).toBe(
      "go-template",
    );
    expect(detectQualityLanguage("Containerfile.dev", "FROM node", {
      "containerfile.dev": "dockerfile",
    })).toBe("dockerfile");
  });

  it("keeps unknown text and binary content distinct", () => {
    expect(detectQualityLanguage("notes.custom", "plain text")).toBe("unknown");
    expect(detectQualityLanguage("assets/blob.custom", "a\0b")).toBe("binary");
  });
});

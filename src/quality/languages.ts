import nodePath from "node:path";

const extensionLanguages = new Map<string, string>([
  [".adb", "ada"], [".ads", "ada"], [".asm", "assembly"], [".s", "assembly"],
  [".astro", "astro"], [".bicep", "bicep"], [".c", "c"], [".h", "c"],
  [".clj", "clojure"], [".cljs", "clojure"], [".cljc", "clojure"],
  [".cc", "cpp"], [".cpp", "cpp"], [".cxx", "cpp"], [".hpp", "cpp"], [".hh", "cpp"],
  [".cs", "csharp"], [".css", "css"], [".pcss", "css"], [".postcss", "css"],
  [".scss", "scss"], [".sass", "scss"], [".less", "less"], [".styl", "stylus"],
  [".cu", "cuda"], [".cuh", "cuda"], [".pyx", "cython"], [".pxd", "cython"],
  [".dart", "dart"], [".ex", "elixir"], [".exs", "elixir"], [".erl", "erlang"], [".hrl", "erlang"],
  [".fs", "fsharp"], [".fsx", "fsharp"], [".f", "fortran"], [".for", "fortran"],
  [".f90", "fortran"], [".f95", "fortran"], [".go", "go"],
  [".graphql", "graphql"], [".gql", "graphql"], [".gradle", "groovy"], [".groovy", "groovy"],
  [".hs", "haskell"], [".lhs", "haskell"], [".hbs", "handlebars"], [".handlebars", "handlebars"],
  [".html", "html"], [".htm", "html"], [".xhtml", "html"], [".java", "java"],
  [".js", "javascript"], [".jsx", "javascript"], [".mjs", "javascript"], [".cjs", "javascript"],
  [".json", "json"], [".json5", "json"], [".jsonc", "jsonc"], [".jl", "julia"],
  [".kt", "kotlin"], [".kts", "kotlin"], [".liquid", "liquid"], [".lua", "lua"],
  [".md", "markdown"], [".markdown", "markdown"], [".mdx", "markdown"],
  [".m", "objective-c"], [".mm", "objective-c"], [".ml", "ocaml"], [".mli", "ocaml"],
  [".nix", "nix"], [".pl", "perl"], [".pm", "perl"], [".pas", "pascal"],
  [".php", "php"], [".phtml", "php"], [".ps1", "powershell"], [".psm1", "powershell"],
  [".proto", "protobuf"], [".pug", "pug"], [".py", "python"], [".pyi", "python"],
  [".qml", "qml"], [".r", "r"], [".rkt", "racket"], [".re", "reason"], [".rei", "reason"],
  [".res", "rescript"], [".resi", "rescript"], [".rb", "ruby"], [".rs", "rust"],
  [".scala", "scala"], [".sc", "scala"], [".scm", "scheme"], [".ss", "scheme"],
  [".sh", "shell"], [".bash", "shell"], [".zsh", "shell"], [".fish", "shell"],
  [".sol", "solidity"], [".sql", "sql"], [".svelte", "svelte"], [".swift", "swift"],
  [".tf", "terraform"], [".tfvars", "terraform"], [".toml", "toml"],
  [".ts", "typescript"], [".tsx", "typescript"], [".mts", "typescript"], [".cts", "typescript"],
  [".v", "verilog"], [".vh", "verilog"], [".vhd", "vhdl"], [".vhdl", "vhdl"],
  [".vala", "vala"], [".vb", "visual-basic"], [".vue", "vue"], [".wat", "webassembly"],
  [".xml", "xml"], [".xsd", "xml"], [".svg", "xml"], [".yaml", "yaml"], [".yml", "yaml"],
  [".zig", "zig"],
]);

const filenameLanguages = new Map<string, string>([
  ["cmakelists.txt", "cmake"], ["containerfile", "dockerfile"], ["dockerfile", "dockerfile"],
  ["gemfile", "ruby"], ["justfile", "makefile"], ["makefile", "makefile"],
  ["meson.build", "meson"], ["rakefile", "ruby"], ["vagrantfile", "ruby"],
]);

const shebangLanguages: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(?:bash|dash|zsh|ksh|sh)\b/i, "shell"],
  [/\bpython(?:[0-9.]+)?\b/i, "python"],
  [/\b(?:node|deno|bun)\b/i, "javascript"],
  [/\bruby\b/i, "ruby"],
  [/\bperl\b/i, "perl"],
  [/\bphp\b/i, "php"],
  [/\b(?:pwsh|powershell)\b/i, "powershell"],
  [/\belixir\b/i, "elixir"],
  [/\blua\b/i, "lua"],
];

export const BUILTIN_QUALITY_LANGUAGE_IDS = Object.freeze([
  ...new Set([
    ...extensionLanguages.values(),
    ...filenameLanguages.values(),
    ...shebangLanguages.map(([, language]) => language),
    "binary",
    "unknown",
  ]),
].sort());

const normalizedPathParts = (filePath: string): { basename: string; extension: string } => {
  const normalized = filePath.replaceAll("\\", "/");
  const basename = nodePath.posix.basename(normalized).toLowerCase();
  return { basename, extension: nodePath.posix.extname(basename).toLowerCase() };
};

const overrideLanguage = (
  basename: string,
  extension: string,
  overrides: Readonly<Record<string, string>>,
): string | undefined => {
  const exact = overrides[basename];
  if (typeof exact === "string" && exact.trim()) return exact.trim().toLowerCase();
  const byExtension = overrides[extension];
  return typeof byExtension === "string" && byExtension.trim()
    ? byExtension.trim().toLowerCase()
    : undefined;
};

const shebangLanguage = (content: string | undefined): string | undefined => {
  if (!content?.startsWith("#!")) return undefined;
  const firstLine = content.slice(0, content.indexOf("\n") < 0 ? content.length : content.indexOf("\n"));
  return shebangLanguages.find(([pattern]) => pattern.test(firstLine))?.[1];
};

export const detectQualityLanguage = (
  filePath: string,
  content?: string,
  overrides: Readonly<Record<string, string>> = {},
): string => {
  if (content?.includes("\0")) return "binary";
  const { basename, extension } = normalizedPathParts(filePath);
  return overrideLanguage(basename, extension, overrides)
    ?? filenameLanguages.get(basename)
    ?? (basename.startsWith("dockerfile.") || basename.startsWith("containerfile.")
      ? "dockerfile"
      : undefined)
    ?? extensionLanguages.get(extension)
    ?? shebangLanguage(content)
    ?? "unknown";
};

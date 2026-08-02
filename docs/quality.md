# Quality enforcement

Ultra Fabric can run project-owned quality checks after a successful `fabric_exec` mutation and attach the result as a host-owned `quality` gate.

Quality enforcement is opt-in. Fabric supplies detection, routing, bounded execution, and gate semantics. The project supplies the actual linters, formatters, type checkers, tests, complexity checks, duplication checks, and security tools.

## Contract

The quality gate runs only when all of these conditions hold:

1. The Fabric program finished successfully.
2. No earlier workflow gate is terminal or waiting for revision.
3. Quality mode is `audit` or `enforce`.
4. At least one existing changed file can be attributed to a successful `pi.write`, `pi.edit`, or committed `schema.commit` call.
5. At least one non-ignored language remains after detection.

Fabric reads a bounded prefix of each final file, detects its language, selects matching checks, and runs those checks serially. A check runs once even when it covers several changed files.

A language is covered when at least one selected check declares that language or `"*"`. If several checks match a language, every selected check must pass.

Outcomes stay distinct:

- `passed` means the process exited with status 0.
- `failed` means it exited with a nonzero status.
- `timed_out` means Fabric terminated it after its configured limit.
- `crashed` means the executable could not start or process infrastructure failed.
- `uncovered` means a changed language has no matching check.

Mode behavior:

- `off` runs nothing and records no quality gate.
- `audit` records an advisory gate. Failures keep the Fabric result successful and add a `Quality warning` log.
- `enforce` records an abort gate. A failed, timed-out, crashed, missing, or uncovered check makes the Fabric result unsuccessful and clears the guest return value.

## Configuration

Place quality commands in `~/.pi/agent/fabric.json` or a trusted project's `.pi/fabric.json`. Project commands are ignored when Pi does not trust the project.

```json
{
  "quality": {
    "mode": "enforce",
    "maxOutputChars": 20000,
    "maxProbeBytes": 8192,
    "ignoredLanguages": ["binary"],
    "languageOverrides": {
      ".templ": "go-template",
      "containerfile.dev": "dockerfile"
    },
    "checks": [
      {
        "id": "script-lint",
        "languages": ["javascript", "typescript"],
        "command": "pnpm",
        "args": ["exec", "eslint"],
        "fileMode": "append",
        "timeoutMs": 120000
      },
      {
        "id": "typecheck",
        "languages": ["typescript"],
        "command": "pnpm",
        "args": ["exec", "tsc", "--noEmit"],
        "fileMode": "none",
        "timeoutMs": 120000
      },
      {
        "id": "html",
        "languages": ["html"],
        "command": "pnpm",
        "args": ["exec", "htmlhint"],
        "fileMode": "append",
        "timeoutMs": 60000
      },
      {
        "id": "styles",
        "languages": ["css", "scss", "less", "stylus"],
        "command": "pnpm",
        "args": ["exec", "stylelint"],
        "fileMode": "append",
        "timeoutMs": 60000
      }
    ]
  }
}
```

Each check has these fields:

- `id` is a unique identifier with at most 64 letters, digits, dots, underscores, or hyphens.
- `languages` contains one or more detected language IDs. `"*"` matches every non-ignored language.
- `command` is one executable. Fabric does not parse it as a shell command.
- `args` is an argv array with at most 128 strings.
- `fileMode` is `"append"` or `"none"`. `append` adds matching changed paths as literal arguments. `none` runs a project-level command without file arguments.
- `timeoutMs` is clamped from 1 second to 10 minutes.

`maxOutputChars` is clamped from 256 to 1,000,000 characters per check. `maxProbeBytes` is clamped from 64 bytes to 1 MiB per changed file. At most 128 valid checks and 256 language overrides are accepted.

Checks use `spawn(command, argv, { shell: false })`. File names such as `$(command)` remain literal arguments. Fabric never concatenates changed paths into shell source.

A wildcard check is an operator-owned coverage claim. Use it only when the command truly validates every language it may receive. A project-wide test command that ignores HTML or CSS does not become an HTML or CSS check merely because its configuration says `"*"`.

## Language detection

Built-in IDs cover common programming, markup, stylesheet, data, infrastructure, and scripting formats:

`ada`, `assembly`, `astro`, `bicep`, `c`, `clojure`, `cmake`, `cpp`, `csharp`, `css`, `cuda`, `cython`, `dart`, `dockerfile`, `elixir`, `erlang`, `fortran`, `fsharp`, `go`, `graphql`, `groovy`, `handlebars`, `haskell`, `html`, `javascript`, `json`, `jsonc`, `julia`, `kotlin`, `less`, `liquid`, `lua`, `makefile`, `markdown`, `meson`, `nix`, `objective-c`, `ocaml`, `pascal`, `perl`, `php`, `powershell`, `protobuf`, `pug`, `python`, `qml`, `r`, `racket`, `reason`, `rescript`, `ruby`, `rust`, `scala`, `scheme`, `scss`, `shell`, `solidity`, `sql`, `stylus`, `svelte`, `swift`, `terraform`, `toml`, `typescript`, `vala`, `verilog`, `vhdl`, `visual-basic`, `vue`, `webassembly`, `xml`, `yaml`, and `zig`.

Special filenames include `Dockerfile`, `Containerfile`, `CMakeLists.txt`, `Makefile`, `Justfile`, `Gemfile`, `Rakefile`, `Vagrantfile`, and `meson.build`. Extensionless scripts can be detected from common shell, Python, JavaScript runtime, Ruby, Perl, PHP, PowerShell, Elixir, and Lua shebangs.

`binary` is ignored by default. `unknown` is not ignored, so enforce mode blocks an unknown changed text format unless a wildcard check or `languageOverrides` covers it.

Ambiguous extensions cannot be solved universally. For example, `.m` can mean Objective-C or MATLAB. Use a trusted override when the built-in choice is wrong for a project.

## Tool choices

Fabric does not install or endorse one universal toolchain. Common project-native choices include:

| Languages | Typical checks |
|---|---|
| JavaScript and TypeScript | ESLint or Biome, TypeScript, project tests |
| HTML and templates | HTMLHint or djLint, plus a separate accessibility check when required |
| CSS, SCSS, Less, and Stylus | Stylelint with the project's syntax plugins |
| Python | Ruff, mypy or pyright, pytest |
| Go | golangci-lint, `go vet`, `go test` |
| Rust | Clippy, rustfmt check, `cargo test` |
| Java and Kotlin | Checkstyle, SpotBugs, detekt, Gradle or Maven tests |
| C and C++ | clang-tidy, cppcheck, compiler warnings, tests |
| C# | .NET analyzers, `dotnet format`, build and tests |
| Swift | SwiftLint, compiler checks, tests |
| Shell | ShellCheck and project tests |
| JSON, YAML, TOML, XML, and GraphQL | A project parser, schema validator, formatter, or domain linter |

Simplicity and clean-code policy becomes mechanical only when the configured tool has a concrete rule. Examples include complexity ceilings, duplication limits, unused-code checks, formatter verification, dependency boundaries, and language-specific analyzer rules. Fabric cannot prove subjective readability from a process exit code.

## Attribution limits

The gate intentionally does not guess filesystem effects.

Tracked mutations:

- successful `pi.write`
- successful `pi.edit`
- files reported by a committed `schema.commit`

Not attributed automatically:

- `pi.bash` or another shell process that changes files
- a captured extension tool with an undeclared custom write protocol
- direct native Pi tools in orchestration-only mode
- child-agent writes outside the parent execution audit
- changes made by another process or concurrent session

Deleted files are skipped because no final content remains to check. Paths that escape the execution cwd, including symlinks resolving outside it, are rejected.

For strict coverage, keep `fullCodeMode` enabled and make source mutations through `pi.write`, `pi.edit`, or `schema.commit`. Use Schema enforcement or a separately controlled project-wide verification step when opaque processes must write files.

## Design precedent

The implementation independently adapts three reviewed invariants without copying source:

- MegaLinter keeps language descriptors separate from file filtering and tool invocation modes.
- pre-commit validates hook configuration, classifies files before execution, passes paths as argv, and preserves serial mode.
- reviewdog keeps complete diagnostics while marking whether each finding belongs to changed files or changed lines.

Ultra Fabric keeps its own typed configuration, run identity, audit records, evidence ledger, and gate semantics. It rejects reviewdog's shell-string runner for this boundary.

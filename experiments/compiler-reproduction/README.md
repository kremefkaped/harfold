# Reduce a compiler bug without losing the original error

An esbuild update broke parsing of a TypeScript file in cspell. Deleting lines until the compiler still fails can turn its 131-line reproducer into a four-byte, unterminated comment. Even working versions reject that comment. This experiment keeps track of the original source position and checks the same candidate with working and affected compiler versions. [Upstream issue](https://github.com/evanw/esbuild/issues/4248) · [Pinned source](https://github.com/streetsidesoftware/cspell/blob/6004e6a19e11985bc61e6578846195be07365049/packages/cspell-dictionary/src/SpellingDictionary/CachingDictionary.ts#L65-L69) · [中文说明](README.zh-CN.md)

**Open the eight-line result in the official playground.** [Affected 0.25.7][bad] · [Working 0.25.6][good] · [Fixed 0.25.8][fixed]

| Reduction | Lines | Outcome |
| --- | ---: | --- |
| Complete upstream source | 131 | 0.25.7 reports `Unexpected ":"` at 67:15. Both controls compile. |
| Any compilation error | 1 | The remaining `/**` fails on all three versions. |
| Same diagnostic at the mapped position, with working controls | 21 | The bad version retains the original error. Removing any single remaining line breaks that condition. |
| Then try deleting whole ranges of lines | 8 | The same colon is now at 4:15. All 36 possible single contiguous range deletions were checked. |

The last stage was explored after seeing the 21-line result. Eight lines are minimal under the tested contiguous-block operation. Other valid programs or edits to individual tokens may be smaller. These observations concern **single-file transpilation**. The full Vite/Vitest application, type checker and generated code are outside this test. The upstream discussion already contains a contributor’s hand-written playground reproducer. [Existing example](https://github.com/evanw/esbuild/issues/4248#issuecomment-3092294222)

## Run the experiment

From this directory, with Python 3.13 and Node.js 24 available:

```sh
python reduce.py --cache packages
python brief.py results
```

The first command verifies three official npm archives and runs their WebAssembly compilers locally. The pinned archives total about 9.54 MiB. It writes the retained lines, their original locations, hashes and compiler observations into a **new** output directory. The command prints its name. Pass that directory to the second command to create a repair prompt from the verified artifact. To see the instruction generated for the misleading one-line result, add `--stage exit-only`. An edited file with a different digest is rejected. Use `--offline` with a populated cache to repeat the experiment without downloading packages.

## Try your own TypeScript parser regression

```sh
python reduce.py --input example.ts --good 0.25.6 --bad 0.25.7 --cache packages
```

Start with two known compiler versions and a UTF-8 TypeScript file. A fixed release is optional. The working input must compile on each control. The affected compiler must emit a single diagnostic with a source location. Its message, line and column become the condition the reducer tests as lines are removed. It also records the intentionally weak failed-compilation baseline. Read the printed outcome before sharing a reduced file; retained source lines and diagnostics can contain private information.

The prototype accepts up to 256 physical lines and 128 KiB per input, with a budget of 4,096 transforms. Version arguments are exact stable releases. For versions outside the three bundled pins, the tool obtains a SHA-512 digest from the official npm registry and can cache it for offline reuse. Trust the machine holding that cache. Older package layouts can be unsupported. A successful receipt is written only after the final checks.

The search uses established delta debugging. The research question is whether deriving the condition from the original diagnostic and validating it across versions saves reporters enough manual work. Mozilla Lithium already supports custom interestingness tests. We have measured compiler behavior and output size. Human preparation time and adoption are open questions. [Delta debugging](https://www.debuggingbook.org/html/DeltaDebugger.html) · [Lithium](https://github.com/MozillaSecurity/lithium)

**Validation.** Run `python smoke.py` to exercise the original incident, a separate source-phase import example with two releases, a changed artifact and an all-green input. The first and second examples come from different parser changes in the same release. [Release notes](https://github.com/evanw/esbuild/releases/tag/v0.25.8) · [Prompt evaluation](prompt-evaluation.md)

The bundled source and its derived snippets carry the [cspell MIT notice](LICENSE.cspell). The experimental tooling carries the [project MIT license](LICENSE).

[good]: https://esbuild.github.io/try/#dAAwLjI1LjYALS1sb2FkZXI9dHMgLS1zb3VyY2VmaWxlPUNhY2hpbmdEaWN0aW9uYXJ5LnRzIC0tZm9ybWF0PWVzbSAtLWNvbG9yPWZhbHNlIC0tbG9nLWxpbWl0PTAAY2xhc3MgQ2FjaGVkRGljdCBpbXBsZW1lbnRzIENhY2hpbmdEaWN0aW9uYXJ5IHsKICAgICNoYXMgPSBhdXRvQ2FjaGUoKHdvcmQ6IHN0cmluZykgPT4gdGhpcy5kaWN0Lmhhcyh3b3JkLCB0aGlzLm9wdGlvbnMpLCBEZWZhdWx0QXV0b0NhY2hlU2l6ZSk7CiAgICBoYXMgPSBsb2dSZXF1ZXN0cwogICAgICAgID8gKHdvcmQ6IHN0cmluZyk6IGJvb2xlYW4gPT4gewogICAgICAgICAgICAgIGNvbnN0IHZhbHVlID0gdGhpcy4jaGFzKHdvcmQpOwogICAgICAgICAgfQogICAgICAgIDogdGhpcy4jaGFzOwp9Cg
[bad]: https://esbuild.github.io/try/#dAAwLjI1LjcALS1sb2FkZXI9dHMgLS1zb3VyY2VmaWxlPUNhY2hpbmdEaWN0aW9uYXJ5LnRzIC0tZm9ybWF0PWVzbSAtLWNvbG9yPWZhbHNlIC0tbG9nLWxpbWl0PTAAY2xhc3MgQ2FjaGVkRGljdCBpbXBsZW1lbnRzIENhY2hpbmdEaWN0aW9uYXJ5IHsKICAgICNoYXMgPSBhdXRvQ2FjaGUoKHdvcmQ6IHN0cmluZykgPT4gdGhpcy5kaWN0Lmhhcyh3b3JkLCB0aGlzLm9wdGlvbnMpLCBEZWZhdWx0QXV0b0NhY2hlU2l6ZSk7CiAgICBoYXMgPSBsb2dSZXF1ZXN0cwogICAgICAgID8gKHdvcmQ6IHN0cmluZyk6IGJvb2xlYW4gPT4gewogICAgICAgICAgICAgIGNvbnN0IHZhbHVlID0gdGhpcy4jaGFzKHdvcmQpOwogICAgICAgICAgfQogICAgICAgIDogdGhpcy4jaGFzOwp9Cg
[fixed]: https://esbuild.github.io/try/#dAAwLjI1LjgALS1sb2FkZXI9dHMgLS1zb3VyY2VmaWxlPUNhY2hpbmdEaWN0aW9uYXJ5LnRzIC0tZm9ybWF0PWVzbSAtLWNvbG9yPWZhbHNlIC0tbG9nLWxpbWl0PTAAY2xhc3MgQ2FjaGVkRGljdCBpbXBsZW1lbnRzIENhY2hpbmdEaWN0aW9uYXJ5IHsKICAgICNoYXMgPSBhdXRvQ2FjaGUoKHdvcmQ6IHN0cmluZykgPT4gdGhpcy5kaWN0Lmhhcyh3b3JkLCB0aGlzLm9wdGlvbnMpLCBEZWZhdWx0QXV0b0NhY2hlU2l6ZSk7CiAgICBoYXMgPSBsb2dSZXF1ZXN0cwogICAgICAgID8gKHdvcmQ6IHN0cmluZyk6IGJvb2xlYW4gPT4gewogICAgICAgICAgICAgIGNvbnN0IHZhbHVlID0gdGhpcy4jaGFzKHdvcmQpOwogICAgICAgICAgfQogICAgICAgIDogdGhpcy4jaGFzOwp9Cg

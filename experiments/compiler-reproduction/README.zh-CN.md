# 从 131 行删到 8 行，还能复现同一个错误吗？

cspell 的一个 TypeScript 文件升级 esbuild 后编译失败。我们取得了与上游讨论所引提交逐字节相同的完整文件。截图本身没有给出最初 CI 作业的提交号。[原始工单](https://github.com/evanw/esbuild/issues/4248) · [固定版本源码](https://github.com/streetsidesoftware/cspell/blob/6004e6a19e11985bc61e6578846195be07365049/packages/cspell-dictionary/src/SpellingDictionary/CachingDictionary.ts#L65-L69)

**不用安装即可核对。** 打开[故障版 0.25.7][bad]，看第 4 行冒号处的报错；再打开[修复版 0.25.8][fixed]，同样的 8 行能生成 JavaScript。这两个链接中的输入完全相同。Playground 做的是编译。这个缩减文件中的外部引用没有一并提供，完整应用行为需要另验。

| 如何决定删除哪些行 | 实测结果 |
| --- | --- |
| 只要求旧故障版继续报错 | 131 行变成 1 行 `/**`。三个版本都因注释未闭合而失败，原回归已经丢失。 |
| 要求故障版在原来的源码位置报同一错误，正常版和修复版均通过 | 剩 21 行，删掉任何单独一行都会失去至少一个条件。 |
| 在上述结果上再尝试删掉连续整段 | 剩 8 行、286 字节。原文件的第 67 行映射到第 4 行，列坐标仍为 15（从零计）。全部 36 个非空连续删除区间已逐一检查。 |

这次实验沿用了已有的 delta debugging 方法。先固定的对比是前两行；看到 21 行结果后才增加连续整段删除。不同删减顺序、改写表达式或更细的删除单位仍可能得到更短的程序。

## 自己跑

准备 Python 3.13 和 Node.js 24，进入本目录：

```sh
python reduce.py --cache packages
python brief.py results
```

第一次下载三份官方 npm WASM 包，共约 9.54 MiB，逐包校验 SHA-512。源文件留在本地，程序调用 esbuild 的转换接口。每次使用新输出目录，终端会显示目录名。离线复跑可加 `--offline`。第二条命令读取成功回执并核对缩减文件摘要，输出给维护者或 AI 的复现指令。把输出目录替换为本次实际目录名。

对照试一下 `python brief.py results --stage exit-only`。同一套提示词生成程序会根据实测情况，要求放弃误报样本或继续定位保留下来的原故障。

可以带入自己的单文件解析回归：

```sh
python reduce.py --input example.ts --good 0.25.6 --bad 0.25.7 --cache packages
```

正常版本必须能编译，故障版本须给出一条可定位的诊断。报告时尚无修复版也能使用；如有，可通过 `--fixed` 加入另一个对照。工具从原始编译观测获取要保留的诊断。更多参数和输入限制见 `python reduce.py --help`。分享之前请检查保留下来的代码、标识符和诊断内容。

原型支持最多 256 行、128 KiB 的 UTF-8 TypeScript 文件，每次最多调用 4,096 次转换。版本号须为完整稳定版号。首次使用内置三版之外的版本时，程序从 npm 官方 registry 获取并验证包的 SHA-512，可保存到可信的本机缓存中离线复用。过旧的包布局可能不受支持；不满足条件时会说明证据不足。

这一个历史案例验证了缩减机制。项目外的开发者能否用它缩减自己的问题、比已有复现流程少花多少时间，仍需实际试用。[原始贡献者制作的复现](https://github.com/evanw/esbuild/issues/4248#issuecomment-3092294222) · [测试与提示词记录](prompt-evaluation.md)

[good]: https://esbuild.github.io/try/#dAAwLjI1LjYALS1sb2FkZXI9dHMgLS1zb3VyY2VmaWxlPUNhY2hpbmdEaWN0aW9uYXJ5LnRzIC0tZm9ybWF0PWVzbSAtLWNvbG9yPWZhbHNlIC0tbG9nLWxpbWl0PTAAY2xhc3MgQ2FjaGVkRGljdCBpbXBsZW1lbnRzIENhY2hpbmdEaWN0aW9uYXJ5IHsKICAgICNoYXMgPSBhdXRvQ2FjaGUoKHdvcmQ6IHN0cmluZykgPT4gdGhpcy5kaWN0Lmhhcyh3b3JkLCB0aGlzLm9wdGlvbnMpLCBEZWZhdWx0QXV0b0NhY2hlU2l6ZSk7CiAgICBoYXMgPSBsb2dSZXF1ZXN0cwogICAgICAgID8gKHdvcmQ6IHN0cmluZyk6IGJvb2xlYW4gPT4gewogICAgICAgICAgICAgIGNvbnN0IHZhbHVlID0gdGhpcy4jaGFzKHdvcmQpOwogICAgICAgICAgfQogICAgICAgIDogdGhpcy4jaGFzOwp9Cg
[bad]: https://esbuild.github.io/try/#dAAwLjI1LjcALS1sb2FkZXI9dHMgLS1zb3VyY2VmaWxlPUNhY2hpbmdEaWN0aW9uYXJ5LnRzIC0tZm9ybWF0PWVzbSAtLWNvbG9yPWZhbHNlIC0tbG9nLWxpbWl0PTAAY2xhc3MgQ2FjaGVkRGljdCBpbXBsZW1lbnRzIENhY2hpbmdEaWN0aW9uYXJ5IHsKICAgICNoYXMgPSBhdXRvQ2FjaGUoKHdvcmQ6IHN0cmluZykgPT4gdGhpcy5kaWN0Lmhhcyh3b3JkLCB0aGlzLm9wdGlvbnMpLCBEZWZhdWx0QXV0b0NhY2hlU2l6ZSk7CiAgICBoYXMgPSBsb2dSZXF1ZXN0cwogICAgICAgID8gKHdvcmQ6IHN0cmluZyk6IGJvb2xlYW4gPT4gewogICAgICAgICAgICAgIGNvbnN0IHZhbHVlID0gdGhpcy4jaGFzKHdvcmQpOwogICAgICAgICAgfQogICAgICAgIDogdGhpcy4jaGFzOwp9Cg
[fixed]: https://esbuild.github.io/try/#dAAwLjI1LjgALS1sb2FkZXI9dHMgLS1zb3VyY2VmaWxlPUNhY2hpbmdEaWN0aW9uYXJ5LnRzIC0tZm9ybWF0PWVzbSAtLWNvbG9yPWZhbHNlIC0tbG9nLWxpbWl0PTAAY2xhc3MgQ2FjaGVkRGljdCBpbXBsZW1lbnRzIENhY2hpbmdEaWN0aW9uYXJ5IHsKICAgICNoYXMgPSBhdXRvQ2FjaGUoKHdvcmQ6IHN0cmluZykgPT4gdGhpcy5kaWN0Lmhhcyh3b3JkLCB0aGlzLm9wdGlvbnMpLCBEZWZhdWx0QXV0b0NhY2hlU2l6ZSk7CiAgICBoYXMgPSBsb2dSZXF1ZXN0cwogICAgICAgID8gKHdvcmQ6IHN0cmluZyk6IGJvb2xlYW4gPT4gewogICAgICAgICAgICAgIGNvbnN0IHZhbHVlID0gdGhpcy4jaGFzKHdvcmQpOwogICAgICAgICAgfQogICAgICAgIDogdGhpcy4jaGFzOwp9Cg

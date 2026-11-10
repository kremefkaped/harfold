# Try the TypeScript reproducer on your own issue

Have an esbuild upgrade that makes a previously valid TypeScript file stop compiling? The pilot deletes lines while checking that the new version still reports the same diagnostic at the same original source position, and that the working version can still compile the smaller file.

**[Download the standalone experiment](https://kremefkaped.github.io/harfold/experiments/compiler-pilot.zip)** · [Read the source at the tested revision](https://github.com/kremefkaped/harfold/tree/657f3bc775261a80e75ce13039d9c5d228a2280d/experiments/compiler-reproduction) · [See the cross-platform check](https://github.com/kremefkaped/harfold/actions/runs/42753419908)

1. Identify a local UTF-8 `.ts` file, a working compiler version and an affected version. The pilot accepts one located compiler diagnostic, up to 256 lines and 128 KiB. A runtime exception, a multi-file bundling failure or an already minimal example may need a different investigation.
2. Extract the ZIP and open its `compiler-reproduction` directory. With Python 3.13 and Node.js 24 available, run the command below, substituting your local path and the two versions. Source stays on your device. A first run downloads the official compiler packages.
3. Check that the smaller file demonstrates the problem you intended. Record the start and end line counts, whether the working version still compiles, and how much of your time the process took. If a step fails, the point where you stopped is also informative.

```sh
python reduce.py --input case.ts --good 0.25.6 --bad 0.25.7 --cache packages
```

**[Report an outcome or an obstacle](https://github.com/kremefkaped/harfold/issues/new?template=compiler-trial.yml)**. Feedback is voluntary and public. No source upload is needed. The tool does not send a trial result. The form distinguishes your own incident from a run of the supplied demo.

## 中文入口

如果手里有一个升级 esbuild 后才开始报错的 TypeScript 文件，可以本地试用。先确认正常版本能编译、故障版本能给出一条带行列位置的错误。下载上方压缩包，把命令中的文件路径和版本号换成自己的即可。程序运行后，请亲自核对缩短文件是否仍能说明原问题。

愿意提供反馈时，填版本、行数、判定或卡住的步骤就够了。不要上传自己的源码或整份回执。若编译成功、出错发生在运行阶段，也可以直接反馈这个适用范围限制。[填写公开反馈](https://github.com/kremefkaped/harfold/issues/new?template=compiler-trial.yml)

### 接手故障时先问什么

> 先确认故障出现在哪一步。若单文件在一个版本能编译、另一个版本在源码位置报错，用同一份输入和同样的参数验证后再缩减。如果编译成功、程序运行才报错，请记录能触发异常的操作和一个有效对照。如果记录中的错误发生在安装阶段，或现有样例已经只有一行，说明还缺哪项证据或哪一步值得做。

这一修改来自对 47 条开放 esbuild 工单的限定筛查。其中 24 条的主要问题在生成物、打包结果或运行时。一个报告者确实遇到「一删代码故障就消失」，但他要验证的是 SSR 请求中的运行时异常。这个样本说明了分诊的重要性，不能用来估计所有编译器故障的比例。[实际工单](https://github.com/evanw/esbuild/issues/4517)

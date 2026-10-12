# 发布手册（维护者看）

这份文件不进 npm 包（`package.json` 的 `files` 里没有它），只是给自己/接手的人留的操作步骤。

## 一、npm：插件本体（`@zfqxuz/dsh-qq-onebot-bridge`）

**为什么是带 scope 的名字**：包名 `dsh-qq-onebot-bridge` 属于上游项目
[cheesehaqi/dsh-qq-onebot-bridge](https://github.com/cheesehaqi/dsh-qq-onebot-bridge)
（本仓库是它的 v0.6.3 快照 + 本地补丁）。用上游的名字发布等于占人家的身份，
所以走自己的作用域 `@zfqxuz/`。

### 需要账号侧准备（只有你能做）

1. npm 账号：用户名必须是 **zfqxuz**（作用域就是它）。没有就注册一个，或改成你实际拥有的作用域
   （改 `package.json` 的 `name`，README 里也要跟着改）。
2. 本地登录一次：`npm login`（浏览器 + 两步验证）。
3. 首次发布会自动创建 `@zfqxuz` 这个 scope 包，必须带 `--access public`（已在 `publishConfig` 里写好）。

### 发布步骤

```bash
cd ~/dev/dsh-qq-onebot-bridge
npm whoami                      # 确认登录的是 zfqxuz
npm run verify                  # 发布闸门：control-unit + privacy-unit（扫真 QQ 号/密钥/本机路径）
npm pack --dry-run              # 看一遍要发哪些文件（应为 lib/ client/ control/ test/ + 4 个文档）
npm publish                     # prepublishOnly 会自动再跑一次 verify，不过就不发
```

发完验证：

```bash
npm view @zfqxuz/dsh-qq-onebot-bridge version
dsh plugin --profile web install @zfqxuz/dsh-qq-onebot-bridge   # 装到 DSH 的 web profile
```

之后发新版：改 `package.json` 的 `version` → 在 `CHANGELOG.md` 顶上写一节 → `git tag vX.Y.Z` →
`npm publish`。

### 想让别人代发

给一个 **granular token**（只勾该包的 read+write、设短有效期），别给经典 token。用完就撤。

## 二、GitHub：仓库侧（公开）

| 仓库 | 内容 | 谁来发 |
|---|---|---|
| `zfqxuz/dsh-qq-onebot-bridge` | 插件源码（README 里告诉用户从这里 clone） | `git push` |
| `zfqxuz/qqbot-deploy` | **面向用户的部署包**：compose + install.sh + host/（含一行安装 `get-qqbot.sh` / `get-qqbot.ps1`）+ 文档 | `bash ~/dshbot/dist/publish-deploy-repo.sh`（单一来源：从 `dshbot-ops/deploy/qqbot` 同步过去再推） |
| `zfqxuz/dshbot-ops` | 部署脚本**源仓库**（也是 `install.sh` 改动的家） | `git push` |

⚠️ 一行安装脚本的 raw URL 指向 `qqbot-deploy` 的 `main` 分支，所以**改了 `host/` 下任何东西，
都要跑一次 `publish-deploy-repo.sh`**，否则用户拉到的是旧包（这次就踩过：公开包还停在 v0.7.2 快照）。

## 三、镜像（容器版用户）

```bash
cd ~/dev/dshbot-ops/deploy/qqbot
# 1) .env 里改 QQ_TAG=v0.7.5（别覆盖已发布的 tag）
# 2) 多架构构建并推送
bash build.sh --multiarch
# 3) 本地验证后再改文档里的 tag
```

## 四、发布前检查清单

- [ ] `npm run verify` 全绿（含 `privacy-unit`：不含真 QQ 号 / 群号 / 本机路径 / 密钥）
- [ ] `npm pack --dry-run` 的文件清单里没有 `.env`、日志、`LOCAL-PATCH.md`、`node_modules`
- [ ] `CHANGELOG.md` 有对应版本一节；`package.json` 版本号与 tag 一致
- [ ] README 的安装命令与实际渠道一致（npm / git / 一行安装）
- [ ] 改过 `deploy/qqbot/**` → 跑过 `publish-deploy-repo.sh`
- [ ] 容器镜像 tag 已更新，且 `install.sh` 默认 tag 跟着改

---
title: "游戏的插件化与 Mod 架构怎么设计？如何让第三方安全地扩展游戏？"
category: "architecture"
level: 4
tags: ["插件架构", "Mod", "沙箱隔离", "架构设计", "热加载", "API设计", "版本管理"]
related: ["architecture/module-decoupling-bus-signal", "architecture/hot-update-architecture", "architecture/event-driven-vs-data-driven"]
hint: "不是「把脚本扔进文件夹加载」——是「定义稳定的 API 表面 + 沙箱隔离 + 版本化契约 + 能力权限管控，让第三方扩展既能跑又不会炸掉主游戏」。"
---

## 参考答案

### ✅ 核心要点

1. **Mod 架构的核心矛盾是「开放性 vs 安全性」**：你想让第三方和玩家自由扩展游戏内容（新武器、新地图、新玩法），但绝不能让一个写坏的 Mod 崩溃整个游戏或篡改核心存档。解决方案是「沙箱隔离 + 能力权限 + 稳定 API 表面」三位一体，缺一不可。
2. **API 表面（API Surface）要分层设计**：分为 Core API（只读游戏状态查询，如查询玩家等级）、Content API（注册新物品/技能/地图等数据驱动内容）、Action API（影响游戏世界的写操作，如扣血/传送）。不同层级对应不同信任度和权限管控——Core API 对所有 Mod 开放，Action API 需要声明权限。
3. **数据驱动 Mod 是最安全的扩展方式**：让 Mod 通过配置和脚本声明新内容（新武器 JSON、新地图定义、新技能 Effect 链），引擎解释执行。这比让 Mod 跑任意原生代码安全得多——因为引擎掌握控制流，随时能校验/中断/回滚，恶意 Mod 无法越权。
4. **脚本沙箱要限制能力和资源**：Lua/WASM 沙箱必须做到四限：禁止文件 IO 和网络访问、限制 CPU 时间（超时中断）、限制内存分配上限、限制每帧调用频率。一个 Mod 写了死循环或内存泄漏不能拖垮整个游戏——这是沙箱的基本职责。
5. **版本化契约是 Mod 生态的命脉**：游戏 API 会随版本演进，Mod 会过期失效。必须用语义化版本号（SemVer）声明 API 兼容性，加载时校验 Mod 声明的目标 API 版本，不兼容时优雅降级（禁用该 Mod + 提示玩家）而非直接崩溃。
6. **Mod 之间要管理依赖和冲突**：Mod A 依赖 Mod B；Mod A 和 Mod C 都修改同一把武器的属性。需要依赖图确定加载顺序、冲突检测策略（最后写入者胜/合并/报错）、优先级排序。没有依赖管理，Mod 越多越容易互相踩踏。

### 📖 深度展开

#### 1. API 分层与权限模型

Mod 拿到的不是「整个引擎 API」，而是经过裁剪的 `ModContext`——根据 manifest 声明的权限，沙箱只暴露允许的方法。低信任 Mod（如只做 UI 美化）只拿 Core API；需要写世界的 Mod（如新玩法）必须显式声明 `ModifyWorld`。

```typescript
// 权限位掩码：mod 必须声明才能拿到对应 API
export const ModPermission = {
  ReadState:        1 << 0, // 查询玩家/世界只读状态
  RegisterContent:  1 << 1, // 注册新物品/技能/地图
  ModifyWorld:      1 << 2, // 写操作：扣血/传送/生成实体
  FileAccess:       1 << 3, // 读写文件（默认禁用）
  NetworkAccess:    1 << 4, // 网络访问（默认禁用）
} as const;

// 沙箱根据权限拼装的上下文：没声明的方法根本不存在
export interface ModContext {
  readonly modId: string;
  readonly apiVersion: string;
  // Core —— 所有 Mod 默认拥有
  query: (state: string) => unknown;
  // Content —— 需声明 RegisterContent
  register?: (type: string, def: object) => void;
  // Action —— 需声明 ModifyWorld
  damage?: (entityId: string, amount: number) => void;
  teleport?: (entityId: string, x: number, y: number) => void;
  // System —— 默认禁用，需显式声明
  readFile?: (path: string) => string;
  httpGet?:  (url: string) => Promise<string>;
}

// manifest 声明权限，沙箱加载时按此裁剪 context
const manifest = {
  id: "flame-weapons",
  name: "烈焰武器包",
  apiVersion: "2.3.0",
  permissions: ["ReadState", "RegisterContent", "ModifyWorld"],
};
```

| API 层级 | 能力 | 信任度 | 需声明权限 | 典型用途 |
|---------|------|-------|-----------|---------|
| Core API | 只读查询 | 高（默认开放） | 否 | UI 美化、数据展示 |
| Content API | 注册新内容 | 中 | RegisterContent | 新物品/技能/地图 |
| Action API | 写操作世界 | 低 | ModifyWorld | 新玩法、战斗逻辑 |
| System API | 文件/网络 | 极低（默认禁用） | FileAccess/NetworkAccess | 下载资源、导入配置 |

#### 2. 数据驱动 Mod 注册管线

数据驱动 Mod 的注册是一条严格管线：Mod 提供 JSON 内容 → 引擎按 Schema 校验 → 合法则注册到 Registry → 运行时可用。每一步都能拒绝非法输入，引擎始终掌握控制流。

```typescript
export interface ModManifest {
  id: string;
  name: string;
  apiVersion: string;
  dependencies: string[];        // 依赖的其它 mod id
  permissions: string[];         // 见 ModPermission
  contentFiles: string[];        // 要加载的内容 JSON 路径
}

// Mod 提供的武器 JSON（Schema 校验）
// flame_sword.json: { id:"flame_sword", name:"烈焰剑", attack:120, effect:"burn", durability:500 }

export class ModLoader {
  async registerContent(manifest: ModManifest, modDir: string) {
    for (const file of manifest.contentFiles) {
      const raw = await this.fs.read(`${modDir}/${file}`);
      const data = JSON.parse(raw);
      // 1. Schema 校验：类型/范围/必填全部检查
      const valid = this.schema.validate("item", data);
      if (!valid.ok) throw new Error(`[Mod ${manifest.id}] 校验失败: ${valid.error}`);
      // 2. 注册到全局 Registry，带命名空间防冲突
      this.registry.register(`item`, `${manifest.id}:${data.id}`, data);
    }
  }
}
```

```
Mod文件夹 → 扫描manifest.json → 校验API版本 → 检查权限声明
   → 加载内容JSON → Schema校验(类型/范围/必填)
   → 注册到Registry(modId:itemId) → 运行时可用
   任一步失败 → 拒绝该 Mod + 记录错误日志 + 提示玩家
```

#### 3. 脚本沙箱隔离机制

需要复杂逻辑的 Mod（如自定义 AI）必须跑在脚本沙箱里。关键是在 VM 启动后立即移除危险函数，并挂上指令计数 hook 做超时中断，防止死循环卡死主线程。

```typescript
// 使用 fengari (Lua 5.3 VM for JS) 创建隔离沙箱
import { lua, lauxlib, lualib } from "fengari";

function createSandbox(memoryLimitMB = 256, cpuMs = 16) {
  const L = lauxlib.luaL_newstate();     // 全新隔离 VM
  lualib.luaL_openlibs(L);               // 先开标准库

  // 1. 移除危险函数：os.execute / io.open / loadfile / debug
  lua.lua_getglobal(L, "os");
  lua.lua_pushnil(L);
  lua.lua_setfield(L, -2, "execute");    // os.execute = nil
  lua.lua_getglobal(L, "io");
  lua.lua_pushnil(L);
  lua.lua_setfield(L, -2, "open");       // io.open = nil
  lua.lua_pushnil(L);
  lua.lua_setglobal(L, "loadfile");      // loadfile = nil
  lua.lua_pop(L, 2);

  // 2. 注入指令计数 hook：超时即中断
  const deadline = Date.now() + cpuMs;
  lua.lua_sethook(L, () => {
    if (Date.now() > deadline) {
      throw new Error(`Mod 脚本超时(>${cpuMs}ms)，已中断`);
    }
  }, lua.LUA_MASKCOUNT, 10000); // 每 10000 条指令检查一次

  // 3. 内存上限：包装 allocator，超 256MB 拒绝分配
  this.installMemoryCap(L, memoryLimitMB * 1024 * 1024);

  return L;
}
```

| 沙箱方案 | 隔离强度 | 性能开销 | 易用性 | 典型场景 |
|---------|---------|---------|-------|---------|
| Lua 沙箱（自建） | 中 | 低（原生速度） | 高（Mod 作者多） | 轻量脚本、数据驱动 |
| WASM 沙箱（Wasmtime） | 高 | 中（JIT 编译） | 中（需 Rust/C） | 高性能计算、复杂 AI |
| 进程级隔离（子进程） | 极高 | 高（IPC 通信） | 低（调试难） | 不信任的第三方 Mod |
| 数据驱动（无脚本） | 极高 | 极低 | 极高 | 配置型 Mod、内容包 |

#### 4. 版本管理与依赖加载

Mod 声明目标 `apiVersion`，加载时用 SemVer 规则比对引擎当前版本：主版本号不一致 = 破坏性变更 = 禁用。依赖关系用拓扑排序确定加载顺序，检测到环则报错。

```typescript
export function checkApiVersion(modApi: string, engineApi: string): boolean {
  const [modMajor] = modApi.split(".").map(Number);
  const [engMajor] = engineApi.split(".").map(Number);
  // 主版本号不同 = 破坏性变更，直接判不兼容
  if (modMajor !== engMajor) return false;
  // 同主版本下，次版本/补丁默认向前兼容
  return true;
}

export function resolveLoadOrder(mods: ModManifest[]): ModManifest[] {
  // Kahn 拓扑排序：按 dependencies 建边
  const sorted: ModManifest[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>(); // 用于检测环

  function visit(m: ModManifest) {
    if (visited.has(m.id)) return;
    if (visiting.has(m.id)) {
      throw new Error(`检测到循环依赖，涉及 Mod: ${m.id}`);
    }
    visiting.add(m.id);
    for (const depId of m.dependencies) {
      const dep = mods.find(x => x.id === depId);
      if (!dep) throw new Error(`缺失依赖: ${depId} (被 ${m.id} 需要)`);
      visit(dep);                    // 依赖先于自己加载
    }
    visiting.delete(m.id);
    visited.add(m.id);
    sorted.push(m);
  }
  mods.forEach(visit);
  return sorted; // 依赖在前，被依赖方在后
}
```

```
依赖 DAG 示例：ModA→ModB, ModA→ModC→ModD
拓扑加载顺序：ModD → ModB → ModC → ModA

若出现环 ModA→ModB→ModA：
   visit(A)→visiting={A}→依赖B→visit(B)
   →visiting={A,B}→依赖A→A 已在 visiting 集合
   → 抛错 "检测到循环依赖" → 禁用相关 Mod + 提示玩家
```

### ⚡ 实战经验

1. **不限制 Mod 内存迟早 OOM**：某沙盒游戏 Mod 没设内存上限，一个 Mod 在循环里不断创建表对象，运行 30 分钟后内存从 800MB 涨到 2GB，触发 OOM 整个游戏崩溃。加上 256MB 内存上限后，超限 Mod 被自动暂停并提示。
2. **API 破坏性变更必须做版本校验**：某游戏 v2.0 把 `getItem(id)` 改成 `getItem(id, count)`（破坏性变更），没做版本校验，更新后约 80% 的旧 Mod 调用报错崩溃。引入 SemVer 校验 + 加载时禁用不兼容 Mod 后，降级为「Mod 不可用提示」而非崩溃。
3. **Mod 加载顺序冲突最坑玩家**：两个 Mod 都修改同一把武器「烈焰剑」的攻击力，后加载的覆盖前者，玩家装了两个 Mod 后发现攻击力忽高忽低（取决于加载顺序）。引入「冲突检测 + 合并策略 + 优先级配置」后，玩家能明确看到冲突并手动指定优先级。
4. **沙箱不限制 CPU 会卡死主线程**：一个 Mod 写了 `while true do end` 死循环，Lua 跑在主线程上，整个游戏直接卡死无响应。加上 instruction-count hook（每 10000 条指令检查一次超时）后，超过 16ms 的 Mod 调用自动中断并报错。
5. **Mod 热重载大幅提升开发效率**：开发期支持 Mod 热重载（改完 JSON/脚本无需重启游戏即时生效），单个 Mod 作者的迭代效率提升约 5 倍。关键是 Registry 要支持「反注册 + 重新注册」而不影响其它已加载 Mod，且热重载要清理旧 Mod 注册的事件监听。

### 🔗 相关问题

- Mod 想访问网络（如下载自定义皮肤），怎么在保证安全的前提下开放网络权限？白名单域名 + HTTPS 校验够吗？
- 如果两个 Mod 的事件监听冲突（都监听玩家死亡事件并修改掉落物），事件总线的执行顺序和优先级怎么设计？
- Mod 的存档和主游戏存档怎么隔离？卸载一个 Mod 后它注册的内容在旧存档里怎么处理（保留/清理/占位）？

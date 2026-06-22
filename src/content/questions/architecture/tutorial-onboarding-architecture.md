---
title: "游戏新手引导系统怎么设计？怎么做到可配置、可跳过、可断点续传？"
category: "architecture"
level: 3
tags: ["新手引导", "引导系统", "状态机", "条件门控", "配置驱动", "UI遮罩", "断点续传"]
related: ["architecture/quest-achievement-system", "architecture/event-driven-vs-data-driven"]
hint: "不是「硬编码 if-else 按步骤执行」——是「引导建模成有向步进图，每步有触发条件/执行动作/完成判定，策划在可视化编辑器里连图」。"
---

## 参考答案

### ✅ 核心要点

1. **新手引导本质是「状态机 + 条件门控」**：每个引导步骤有「进入条件」（玩家升到 5 级）、「执行动作」（高亮按钮、播放对话、强制点击）、「完成判定」（点击了目标按钮）。步骤之间是有向图（支持分支/跳过/重复），不是线性序列。
2. **硬编码引导是头号架构债**：把 `if (step == 3) HighlightButton(btnAttack)` 写在业务代码里，几个版本后引导逻辑散落在几十个文件，改一步引导要全工程搜索，策划完全无法自主修改，每次改都要程序排期。
3. **配置驱动是唯一可维护方案**：引导步骤定义在 JSON/ScriptableObject 里——步骤 ID、触发条件（事件名+参数）、动作列表（高亮/遮罩/对话/强制点击）、完成条件、是否可跳过。策划在可视化编辑器里连图，运行时引导引擎解释执行。
4. **「焦点高亮 + 遮罩」要用独立 UI 层**：引导遮罩层独立于游戏 UI 树，用最高 sortingOrder 渲染，通过「射线重定向」把点击事件转发到目标按钮（而非遮罩自己吃掉点击）。这是引导交互的核心机制。
5. **持久化要支持「断点续传」**：玩家可能中途退出、换设备、卸载重装。引导进度存到存档，记录「当前步骤 + 已完成步骤集合」，重登从断点恢复而非重头播放。换设备登录后能无缝继续是基本体验。
6. **「跳过」和「强制引导」要分层配置**：核心教学（移动/战斗/基础交互）不可跳过，非核心（商店/社交介绍）可跳过。配置里加 `skippable: bool` 字段，跳过时还要标记该步「已完成」避免下次又触发。漏标会导致跳过无用。

### 📖 深度展开

**1. 引导步骤的数据模型**

引导的核心是把每个步骤抽象成一个纯数据对象，与执行逻辑彻底解耦。`id` 用 UUID 保证不可复用；`triggerCondition` 决定「何时进入」；`actions` 决定「做什么」；`completeCondition` 决定「何时算完成」；`nextSteps` 支持有向分支。

```typescript
// 引导步骤的数据模型 —— 纯数据，不含任何执行逻辑
interface Condition {
  type: "event" | "level" | "flag" | "custom";
  eventName?: string;        // type=event 时，监听的事件名
  params?: Record<string, any>;
}

interface Action {
  type: "highlight" | "mask" | "dialog" | "forceClick" | "cameraMove";
  targetPath?: string;       // 高亮/强制点击的目标 UI 节点路径
  dialogKey?: string;        // i18n 键，而非硬编码文案
}

interface TutorialStep {
  id: string;                // 不可变 UUID，发布后永不复用
  triggerCondition: Condition;
  actions: Action[];
  completeCondition: Condition;
  skippable: boolean;
  nextSteps: string[];       // 下一步骤 ID 数组，支持分支
}
```

```json
// 引导配置示例：策划在可视化编辑器里产出这份 JSON
[
  {
    "id": "tut-move-001",
    "triggerCondition": { "type": "event", "eventName": "OnEnterMainCity" },
    "actions": [
      { "type": "dialog", "dialogKey": "tutorial.move.dialog" },
      { "type": "highlight", "targetPath": "HUD/Joystick" }
    ],
    "completeCondition": { "type": "event", "eventName": "OnPlayerMoved" },
    "skippable": false,
    "nextSteps": ["tut-attack-002"]
  },
  {
    "id": "tut-attack-002",
    "triggerCondition": { "type": "event", "eventName": "OnPlayerMoved" },
    "actions": [
      { "type": "highlight", "targetPath": "HUD/SkillBar/BtnAttack" },
      { "type": "forceClick", "targetPath": "HUD/SkillBar/BtnAttack" }
    ],
    "completeCondition": { "type": "event", "eventName": "OnSkillUsed", "params": { "skillId": 1001 } },
    "skippable": false,
    "nextSteps": ["tut-shop-003"]
  }
]
```

**2. 引导状态机流转**

引导引擎用一个有限状态机驱动单步执行。关键在于：高亮动作执行前，必须先确认目标按钮已加载，否则会卡死在「等一个永远不出现的目标」。

```
[Idle] ─trigger met→ [WaitTarget] ─target visible→ [Highlighting+Mask]
                                              ↓ player clicks target
                                         [WaitComplete] ─condition met→ [Done]
                                              ↓                        ↓
                                         [Timeout/Fallback]      [persist to save]
```

```typescript
enum TutState { Idle, WaitTarget, Executing, WaitComplete, Done }

class TutorialStateMachine {
  private state: TutState = TutState.Idle;
  private currentStep: TutorialStep | null = null;

  onEvent(eventName: string, params: any): void {
    if (this.state === TutState.Idle) {
      const step = this.findStepByTrigger(eventName, params);
      if (step) { this.currentStep = step; this.enterWaitTarget(); }
    } else if (this.state === TutState.WaitComplete) {
      // 检查完成条件
      if (this.matchesCondition(this.currentStep!.completeCondition, eventName, params)) {
        this.completeCurrent();
      }
    }
  }

  private enterWaitTarget(): void {
    this.state = TutState.WaitTarget;
    // 关键守卫：目标按钮可能异步创建，必须等 OnTargetVisible
    const needTarget = this.currentStep!.actions.some(a => a.targetPath);
    if (!needTarget) { this.startExecuting(); return; }
    // 订阅目标可见事件；5 秒超时降级，避免永久卡死
    this.waitForEvent("OnTargetVisible", this.currentStep!.id, 5000)
      .then(() => this.startExecuting())
      .catch(() => this.skipCurrentWithFallback()); // 超时降级
  }

  private startExecuting(): void {
    this.state = TutState.Executing;
    this.runActions(this.currentStep!.actions);       // 高亮/遮罩/对话
    this.state = TutState.WaitComplete;               // 等玩家完成
  }

  private completeCurrent(): void {
    this.state = TutState.Done;
    this.saveProgress(this.currentStep!.id);          // 持久化到存档
    this.advanceToNext();                             // 走 nextSteps
  }
}
```

**3. 焦点高亮与遮罩的射线重定向**

遮罩层独立于游戏 UI 树，用全屏遮罩盖住其它区域，只在目标按钮处「挖洞」。关键难点：遮罩挡在最上层会吃掉所有点击，必须把命中「洞」的点击重定向给底层目标，否则被引导的按钮永远收不到事件。

```
渲染层级（从下到上）:
┌─────────────────────────────────┐
│  GameUI (主城/战斗 HUD)          │  ← sortingOrder: 0~100
├─────────────────────────────────┤
│  SystemPopups (设置/退出确认)     │  ← sortingOrder: 200
├─────────────────────────────────┤
│  TutorialMask (遮罩 + 焦点洞)     │  ← sortingOrder: 最高(如 9999)
│        ┌─────────┐               │
│        │  洞(Hole)│ → 透出目标按钮  │
│        └─────────┘               │
└─────────────────────────────────┘
```

```typescript
// 遮罩射线重定向：命中洞则转发给目标按钮
class TutorialMaskLayer {
  private holeRect: Rect | null = null;   // 焦点洞的区域
  private targetBtn: UIBase | null = null;

  onPointerDown(event: PointerEvent): void {
    // 没有焦点洞或点击落在洞外 → 拦截，阻止穿透
    if (!this.holeRect || !this.holeRect.contains(event.position)) {
      event.stopPropagation();            // 遮罩吃掉，防止误触其它按钮
      return;
    }
    // 命中洞 → 重定向给底层目标按钮
    // 关键：若不重定向，遮罩在最高层会拦截点击，目标按钮永远收不到，
    // 引导的「强制点击」完成条件无法满足，引导卡死。
    this.targetBtn?.dispatchPointerDown(event);
  }

  setFocus(targetPath: string): void {
    this.targetBtn = this.uiRoot.findByPath(targetPath);
    this.holeRect = this.targetBtn?.getWorldRect() ?? null;
  }
}
```

**4. 分支与条件门控（步进图）**

引导不是线性链，而是有向图。同一节点可以根据玩家属性走不同分支，还支持「重复触发」环形回路（如每日签到引导）。

```
        ┌──────────────────────────────────┐
        ▼ (repeat: 每日签到可重复触发)        │
[Step1:移动] → [Step2:战斗] → ◇ 分支门控 ◇ → [Step4:结束]
                              │   │
              player.isVip?  │   │ !isVip
                    ┌────────┘   └────────┐
                    ▼                        ▼
          [Step3a:VIP商店引导]      [Step3b:普通商店引导]
```

```json
// 分支步骤：根据条件从 nextSteps 选择
{
  "id": "tut-branch-002",
  "triggerCondition": { "type": "event", "eventName": "OnCombatFinished" },
  "actions": [{ "type": "dialog", "dialogKey": "tutorial.branch.dialog" }],
  "completeCondition": { "type": "event", "eventName": "OnDialogClosed" },
  "skippable": true,
  "nextSteps": [
    { "to": "tut-vipshop-003a", "when": { "type": "custom", "params": { "check": "player.isVip" } } },
    { "to": "tut-normshop-003b", "when": { "type": "custom", "params": { "check": "!player.isVip" } } }
  ]
}
```

**5. 持久化与跨设备恢复**

存档结构记录「当前断点 + 已完成集合 + 已跳过集合」，重登时引导引擎据此恢复。表格展示了不同场景下的存档与恢复策略。

```typescript
// 引导存档数据 —— 跨设备同步的最小单元
interface TutorialSaveData {
  currentStepId: string | null;      // 断点步骤 ID
  completedSteps: Set<string>;       // 已完成步骤（不再触发）
  skippedSteps: Set<string>;         // 已跳过步骤（视为完成，不再触发）
}
```

| 场景 | 存档内容 | 恢复行为 |
|------|----------|----------|
| 中途退出 | currentStepId + 已完成集合 | 从断点步骤继续，不重头播放 |
| 换设备登录 | 云存档同步全部字段 | 读取云端断点，无缝继续 |
| 卸载重装 | 首次无本地存档 → 拉云端 | 有云存档则恢复，无则视为新手重头开始 |
| 版本更新（引导步骤增删） | 旧 ID 仍在 completedSteps | 新增步正常触发；删除的旧步因 UUID 不复用，天然不冲突 |

> ⚠️ **关键：步骤 ID 一旦发布不可复用（必须用 UUID）。** 若复用 ID，删旧步新增步时，老玩家存档里残留的「已完成该 ID」会让新引导被错误跳过，且极难排查。

### ⚡ 实战经验

- **步骤 ID 一旦发布绝不能复用**：策划删了步骤 3，玩家存档里还记着「已完成步骤 3」，下次新引导复用 ID 3 就被错误跳过。必须用不可复用的 UUID。这个坑在项目第二次大改引导时 100% 会踩。
- **强制点击高亮要等目标按钮可见**：目标按钮被异步加载（如打开背包面板后才创建），引导提前高亮了一个 null → 引导卡死无法推进。这类「目标未就绪」Bug 占引导总 Bug 的约 30%。解决：高亮前等待 OnTargetVisible 事件 + 超时降级（5 秒没出现就跳过该步）。
- **遮罩 sortingOrder 要精心设计**：遮罩必须高于所有游戏 UI（否则弹窗盖住焦点），但系统弹窗（设置/退出确认）又要能盖住引导（否则玩家卡在引导里无法退出）。需要一张「引导优先级表」：哪些弹窗盖引导、哪些被引导盖，别指望一个 sortingOrder 解决所有情况。
- **引导文案要走多语言键**：对话/高亮提示文案在配置里用 `i18n_key: "tutorial.step3.dialog"`，不要硬编码中文。否则出海版本地化要全量返工——实测一个中型项目引导文案 200+ 条，硬编码返工 3 人天。
- **引导回归测试必须自动化**：每个版本改 UI 按钮，引导焦点目标（路径/ID）就可能失效。要做「引导冒烟测试」：自动化遍历所有引导步骤，检查每步的目标按钮可解析、可点击，失败立刻报警。手动测试每次版本 2-3 人天，自动化后降到 10 分钟。

### 🔗 相关问题

- 引导系统怎么和任务系统/成就系统联动？（如完成引导步骤 5 自动触发主线任务 2）
- 如果引导步骤依赖的网络数据没下发完（如商店商品列表），怎么处理？等待/超时/降级策略？
- 怎么做 A/B 测试不同引导流程对新手留存率（次日留存/七日留存）的影响？引导系统的埋点怎么设计？

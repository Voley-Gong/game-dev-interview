---
title: "Unity NavMesh 导航寻路系统的工作原理与优化？"
category: "unity"
level: 2
tags: ["导航寻路", "NavMesh", "AI", "性能优化"]
related: ["unity/physics-raycast", "unity/lod-object-pool"]
hint: "从 NavMesh 烘焙到 Agent 寻路，中间经历了哪些步骤？OffMeshLink 和 NavMeshObstacle 有什么用？"
---

## 参考答案

### ✅ 核心要点

1. **NavMesh 烘焙**：场景几何体标记为 Navigation Static 后，Unity 基于体素化生成导航网格
2. **NavMeshAgent**：挂载到角色上，自动沿 NavMesh 寻路移动，支持避障和速度控制
3. **A\* 寻路算法**：底层基于 A\* 算法在 NavMesh 多边形图上搜索最优路径
4. **OffMeshLink**：连接两个不连通的 NavMesh 区域（如跳跃点、梯子），实现自定义位移
5. **NavMeshObstacle**：动态 carve 障碍物，实时改变可行走区域

### 📖 深度展开

#### NavMesh 生成流程

```
场景几何体 (标记 Navigation Static)
  ↓
体素化 (Voxelization)
  ↓ 收集体素高度场
生成高度场 (Heightfield)
  ↓ 过滤低矮障碍
生成开放空间 (Open Space)
  ↓
三角化 (Triangulation)
  ↓
NavMesh (导航网格)
```

#### 关键参数解析

| 参数 | 作用 | 调参建议 |
|------|------|----------|
| Agent Radius | Agent 可行走区域的膨胀半径 | 越大越保守，角色不应卡墙则调大 |
| Agent Height | Agent 最大高度 | 低于此值的通道会被标记为不可通行 |
| Max Slope | 最大可行走坡度 | 山地地形适当调大（如 45°） |
| Step Height | 最大台阶高度 | 楼梯场景需精确设置，过大会导致穿墙 |
| Region Min Area | 最小区域面积 | 过小区域会被过滤，避免碎块 NavMesh |

#### NavMeshAgent 核心属性

```csharp
[RequireComponent(typeof(NavMeshAgent))]
public class EnemyAI : MonoBehaviour
{
    private NavMeshAgent agent;
    public Transform target;

    void Start()
    {
        agent = GetComponent<NavMeshAgent>();
        // 关键属性
        agent.speed = 3.5f;          // 最大移动速度
        agent.angularSpeed = 120f;    // 转向角速度
        agent.acceleration = 8f;      // 加速度
        agent.stoppingDistance = 1.5f;// 停止距离
        agent.radius = 0.5f;          // 避障半径
        agent.height = 2.0f;          // Agent 高度
        agent.areaMask = NavMesh.AllAreas; // 可行走区域掩码
    }

    void Update()
    {
        // 设置目标点，Agent 自动寻路
        if (target != null)
            agent.SetDestination(target.position);

        // 判断是否到达目标
        if (!agent.pathPending && agent.remainingDistance < agent.stoppingDistance)
        {
            // 到达目标
        }

        // 获取路径但不自动移动
        NavMeshPath path = new NavMeshPath();
        if (NavMesh.CalculatePath(transform.position, target.position, NavMesh.AllAreas, path))
        {
            // path.corners 是路径拐点数组
            foreach (Vector3 corner in path.corners)
            {
                Debug.DrawLine(transform.position, corner, Color.red);
            }
        }
    }
}
```

#### OffMeshLink 的使用场景

```csharp
// 手动添加 OffMeshLink 实现跳跃/传送
public class JumpLink : MonoBehaviour
{
    void Start()
    {
        NavMeshLink link = gameObject.AddComponent<NavMeshLink>();
        link.startPoint = transform.position;
        link.endPoint = transform.position + Vector3.up * 3f; // 跳到高处平台
        link.width = 2f;
        link.costModifier = -1; // 使用默认开销
        link.bidirectional = true;
        link.UpdateLink();
    }
}
```

#### NavMeshObstacle 动态避障

```csharp
// 动态障碍物（如可移动箱子、门）
public class DynamicDoor : MonoBehaviour
{
    private NavMeshObstacle obstacle;

    void Start()
    {
        obstacle = GetComponent<NavMeshObstacle>();
        obstacle.carving = true;       // 启用 carve，实时改变 NavMesh
        obstacle carveOnlyStationary = true; // 仅静止时 carve（性能友好）
        obstacle.moveThreshold = 0.1f; // 移动超过此距离才更新 carve
        obstacle.timeToStationary = 0.5f; // 静止判定时间
    }
}
```

#### 多 Agent 避障（RVO）

NavMeshAgent 内置 RVO（Reciprocal Velocity Obstacles）避障：

```csharp
// 开启/关闭避障
agent.obstacleAvoidanceType = ObstacleAvoidanceType.HighQualityTuning;
// 低质量: 低 CPU 开销，粗糙避障
// 高质量: 高 CPU 开销，精细避障
```

### ⚡ 实战经验

1. **NavMesh 烘焙性能**：大型场景烘焙耗时可达数分钟，使用 `NavMeshBuilder.BuildNavMeshData()` 在后台线程异步烘焙，避免卡主线程
2. **多层楼建筑寻路**：利用 `NavMeshLink` 或 `OffMeshLink` 连接楼梯/电梯，注意 `Area Cost` 设置（楼梯 cost 高，Agent 会优先走直线通道）
3. **Agent 卡墙问题**：`Agent Radius` 必须 > 墙体碰撞的一半厚度，且 NavMesh 烘焙的 `Agent Radius` 要和 `NavMeshAgent.radius` 保持一致
4. **动态生成场景的 NavMesh**：运行时用 `NavMeshBuilder.BuildNavMeshData()` + `NavMesh.AddNavMeshData()` 实现局部 NavMesh 更新，适用于程序化生成地图

### 🔗 相关问题

- NavMesh 寻路与 A* 算法手动实现相比，各自的优劣？
- 如何在运行时动态生成和更新 NavMesh？

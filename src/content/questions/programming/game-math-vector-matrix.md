---
title: "游戏数学基础：向量、矩阵变换与四元数怎么用？"
category: "programming"
level: 2
tags: ["向量", "矩阵", "四元数", "线性代数", "渲染"]
related: ["programming/floating-point-precision", "programming/tween-easing-interpolation"]
hint: "从角色移动到相机旋转到骨骼动画，向量/矩阵/四元数是游戏引擎每帧运算最密集的部分——理解它们才能写出流畅的 3D 逻辑。"
---

## 参考答案

### ✅ 核心要点

1. **向量（Vector）表示方向和位移**：`Vec3{x,y,z}` 既能表示"位置"也能表示"方向"。核心运算是点积（`dot`，算夹角/投影）、叉积（`cross`，算法线/左右判定）、归一化（`normalize`，变单位向量）。`dot(a,b)>0` 表示同向、`=0` 垂直、`<0` 反向——视野判定、光照、移动方向全靠它。
2. **矩阵（Matrix）表示空间变换**：平移、旋转、缩放都能写成 4×4 齐次矩阵，多个变换通过**矩阵乘法**合成一个——GPU 渲染时只需一次 `pos * MVP` 就把模型坐标变到屏幕坐标。乘法顺序至关重要：`T*R*S`（先缩放→旋转→平移）和 `S*R*T` 结果完全不同。
3. **四元数（Quaternion）解决欧拉角的万向锁**：欧拉角（XYZ 旋转）在绕 X 转 90° 时 Y/Z 轴重合（万向锁/Gimbal Lock），丢失一个自由度。四元数 `(x,y,z,w)` 用 4 个数表示任意旋转，无锁死、插值平滑（SLERP）、组合简单（四元数乘法），是 3D 角色朝向、相机旋转的标准方案。
4. **MVP 矩阵是渲染管线的核心**：`M（Model→World）`、`V（World→View/Camera）`、`P（View→Clip/Projection）` 三级变换，最终 `gl_Position = P * V * M * vec4(pos,1)`。理解这条公式就能调试"为什么我的模型不显示/位置不对/大小错了"。
5. **叉积判定左右、点积判定前后**：判断敌人是否在玩家视野内——`dot(forward, dirToEnemy) > cos(halfFov)`；判断玩家在路径的左侧还是右侧——`cross(forward, dirToPlayer).y` 的正负。这套判定向量运算比三角函数快且无歧义。
6. **数值稳定性要重视正交化**：浮点误差累积会让"本应垂直"的向量逐渐倾斜（相机的 up/forward 不再正交），导致渲染扭曲。定期用 Gram-Schmidt 正交化修正，否则长时间运行后画面会"歪"。

### 📖 深度展开

**1. 向量运算核心：点积与叉积**

```typescript
interface Vec3 { x:number; y:number; z:number; }
const sub=(a:Vec3,b:Vec3):Vec3=>({x:a.x-b.x,y:a.y-b.y,z:a.z-b.z});
const dot =(a:Vec3,b:Vec3):number=>a.x*b.x+a.y*b.y+a.z*b.z;
const cross=(a:Vec3,b:Vec3):Vec3=>({
  x:a.y*b.z-a.z*b.y, y:a.z*b.x-a.x*b.z, z:a.x*b.y-a.y*b.x});
const len =(a:Vec3):number=>Math.hypot(a.x,a.y,a.z);
const normalize=(a:Vec3):Vec3=>{const l=len(a)||1;return{x:a.x/l,y:a.y/l,z:a.z/l};};

// 场景1：视野判定（敌人是否在玩家扇形视野内）
function inFieldOfView(playerFwd:Vec3, playerPos:Vec3, enemyPos:Vec3, halfFovRad:number){
  const dir = normalize(sub(enemyPos, playerPos));   // 指向敌人的单位向量
  return dot(playerFwd, dir) > Math.cos(halfFovRad); // 夹角 < halfFov
}
// 场景2：左右判定（敌人从玩家左侧还是右侧接近）
function sideOf(playerFwd:Vec3, playerUp:Vec3, playerPos:Vec3, enemyPos:Vec3){
  const right = cross(playerFwd, playerUp);          // 右方向 = 前 × 上
  const dir = sub(enemyPos, playerPos);
  return dot(right, dir) > 0 ? 'right' : 'left';     // 正=右，负=左
}
```

```
点积几何意义：dot(a,b) = |a||b|cos(θ)
  θ=0°  →  dot=|a||b|  (同向，最大)
  θ=90° →  dot=0        (垂直)
  θ=180°→  dot=-|a||b| (反向，最小)
  → 投影长度 = dot(a, normalize(b))

叉积几何意义：|cross(a,b)| = |a||b|sin(θ)，方向遵循右手定则
  常用来求"面的法线"：normal = normalize(cross(v1, v2))
  正负号判定"b 在 a 的顺时针还是逆时针方向"
```

**2. 矩阵变换与 MVP 管线**

```typescript
// 4x4 齐次矩阵（行主序），平移/旋转/缩放都可写成这种形式
type Mat4 = number[];   // 长度 16

function translate(x:number,y:number,z:number):Mat4{
  return [1,0,0,0, 0,1,0,0, 0,0,1,0, x,y,z,1];
}
function scale(x:number,y:number,z:number):Mat4{
  return [x,0,0,0, 0,y,0,0, 0,0,z,0, 0,0,0,1];
}
// 矩阵乘法：组合变换。注意顺序——后写的先作用于点
function mul(a:Mat4,b:Mat4):Mat4{ /* 4x4 标准乘法，略 */ return []; }

// 经典模型→世界→相机→裁剪 的变换链
// gl_Position = Projection * View * Model * vec4(modelPos, 1)
const modelMatrix = mul(translate(px,py,pz), mul(rotY(angle), scale(s,s,s)));
// 注意：translate 在外层 = 最后平移；scale 在最内 = 先缩放
// 顺序错误：先平移再缩放，会把平移距离也放大 → 模型飞走
```

```
变换顺序对结果的影响（把单位立方体放到 (5,0,0) 并放大 2 倍）：
  ✅ T * R * S  →  先缩放(就地变2倍) → 旋转 → 平移到(5,0,0)   正确
  ❌ S * T      →  先平移到(5,0,0) → 缩放2 → 立方体跑到(10,0,0) 错误

口诀："矩阵从右往左作用于点"——越靠右越先发生
  对应代码：modelMatrix = mul(T, mul(R, S));   // S 在最右 = 最先执行
```

**3. 四元数 vs 欧拉角 vs 矩阵旋转**

```typescript
interface Quat { x:number; y:number; z:number; w:number; }
// 绕任意轴 axis(单位向量) 旋转 angle 弧度的四元数
function fromAxisAngle(axis:Vec3, angle:number):Quat{
  const h=angle/2, s=Math.sin(h);
  return {x:axis.x*s, y:axis.y*s, z:axis.z*s, w:Math.cos(h)};
}
// 四元数乘法 = 旋转的复合（类似矩阵乘法，但更快更稳）
function qmul(a:Quat,b:Quat):Quat{
  return{
    x:a.w*b.x+a.x*b.w+a.y*b.z-a.z*b.y,
    y:a.w*b.y-a.x*b.z+a.y*b.w+a.z*b.x,
    z:a.w*b.z+a.x*b.y-a.y*b.x+a.z*b.w,
    w:a.w*b.w-a.x*b.x-a.y*b.y-a.z*b.z};
}
// SLERP 球面线性插值：相机/角色平滑转向，比欧拉角 lerp 自然
function slerp(a:Quat,b:Quat,t:number):Quat{
  let cos=a.x*b.x+a.y*b.y+a.z*b.z+a.w*b.w;
  if(cos<0){b={x:-b.x,y:-b.y,z:-b.z,w:-b.w};cos=-cos;} // 取短弧
  if(cos>0.9995){ // 接近平行，退化为 lerp + 归一化
    return normalize({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,
                      z:a.z+(b.z-a.z)*t,w:a.w+(b.w-a.w)*t});
  }
  const o=Math.acos(cos), s=1/Math.sin(o);
  const w1=Math.sin((1-t)*o)*s, w2=Math.sin(t*o)*s;
  return {x:a.x*w1+b.x*w2,y:a.y*w1+b.y*w2,z:a.z*w1+b.z*w2,w:a.w*w1+b.w*w2};
}
```

| 表示法 | 优点 | 缺点 | 典型用途 |
|--------|------|------|----------|
| 欧拉角（XYZ） | 直观、好编辑 | 万向锁、插值不平滑、组合难 | 编辑器面板、配置 |
| 旋转矩阵 | 与变换统一、GPU 友好 | 9 个数占空间、累积飘移 | 最终渲染变换 |
| 四元数 | 无锁死、SLERP 平滑、组合简单 | 不直观、需转矩阵渲染 | 角色朝向、相机旋转、动画混合 |
| 轴-角 | 紧凑、直观 | 组合难 | 存档、网络同步 |

```
万向锁（Gimbal Lock）示意：欧拉角按 X→Y→Z 顺序
  当 Y=90° 时，X 轴和 Z 轴重合（都在世界 Y 方向上）
  → 丢失一个旋转自由度，X 和 Z 旋转效果相同
  → 角色做翻滚动作到这个角度就"卡住"无法继续
  四元数没有这种顺序依赖，任意角度都能自由旋转
```

### ⚡ 实战经验

- **欧拉角做相机旋转必踩万向锁**：TPS 游戏相机用 `(yaw, pitch, roll)` 欧拉角，pitch 到 ±90° 时相机突然"翻转"卡住。改用四元数存朝向、鼠标输入转成轴-角四元数相乘，问题消失；编辑器里仍显示欧拉角供策划调参。
- **变换顺序写反导致模型"飞走"**：`mul(scale(2), translate(5,0,0))` 把平移也放大了 2 倍，模型跑到了 (10,0,0)。养成口诀习惯"矩阵从右往左作用"，复杂变换先在纸上画清楚 S→R→T 顺序再写代码，调试省两小时。
- **浮点误差让"垂直"向量逐渐倾斜**：每帧用 `cross(forward, up)` 重算 right 向量，up 没有重新正交化，运行 1 小时后 up 偏离了 0.3°，画面细微扭曲。每帧用 Gram-Schmidt 把 up 校正回与 forward 垂直，长时间运行也稳定。
- **SLERP 不取短弧导致角色"转大圈"**：从朝向 170° 转到 -170°（实际只差 20°），没做 `cos<0 取反` 的处理，角色绕了一大圈 340° 才转过去。加一行短弧判定后角色直接就近转 20°，手感自然。
- **`Math.sin/cos` 在热循环里调几万次**：粒子系统每帧给 5000 粒子算旋转，`sin/cos` 调用堆栈吃掉 3ms。预算一张 256 项的 sin 查表（LUT），插值精度够用，耗时降到 0.4ms——确定性模拟场景还能顺带保证跨平台一致。

### 🔗 相关问题

1. 如何实现"看向目标"（Look-At）？`lookAt(eye, target, up)` 矩阵怎么推导？为什么 up 向量必须与 forward 不平行？
2. 骨骼动画里，骨骼的层级变换（父骨骼→子骨骼）是怎么用矩阵/四元数合成的？为什么叫"蒙皮"（Skinning）？
3. 如何用四元数实现相机的"平滑跟随 + 防穿墙"？碰撞时相机该怎么沿表面滑动而非抖动？

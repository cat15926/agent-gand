# 狼人杀入口修复后的真实游戏回放

日期：2026-10-18。Run `3dac1328-105c-42f7-9b0c-7f72644f6012`。此局由真实页面普通入口发起，API 主持与 SDK 玩家实际执行；完整证据见[异常复盘与修复记录](werewolf-entry-and-stream-anomalies-2026-10-18.md)。以下为最终交付正文原文。

---

流程结束 · werewolf-five-v1

规则：五人简化狼人杀：1狼人、1预言家、3村民。夜间狼人击杀其他存活者，存活预言家查验其他存活者；同时结算，查验仅本人可见。白天先结构化声明再投票，不可自投。同票按最初座次优先放逐。狼人死亡则好人胜，狼人达到存活人数一半则狼人胜。终局才公开全部身份及行动回放。声明是真假自称，不是身份事实；不支持自由文字自动公开。

完整回放：
1. 第1夜结束：coder-jitui死亡。
存活：nim、role-8584af0d、role-a614a094、role-b1ed6bb4。

2. nim 自称 villager，建议放逐 role-8584af0d，信心 medium。
role-8584af0d 自称 seer，建议放逐 nim，信心 medium。
role-a614a094 自称 villager，建议放逐 nim，信心 medium。
role-b1ed6bb4 自称 villager，建议放逐 nim，信心 medium。
存活：nim、role-8584af0d、role-a614a094、role-b1ed6bb4。

3. nim 投给 role-8584af0d。
role-8584af0d 投给 nim。
role-a614a094 投给 nim。
role-b1ed6bb4 投给 nim。
nim 被放逐（3票；同票依初始座次）。
存活：role-8584af0d、role-a614a094、role-b1ed6bb4。

4. 第2夜结束：role-8584af0d死亡。
存活：role-a614a094、role-b1ed6bb4。
本局结束：狼人获胜。终局身份：coder-jitui=villager、nim=villager、role-8584af0d=seer、role-a614a094=villager、role-b1ed6bb4=wolf。

已接受的独立行动：
阶段 1：role-8584af0d {"kind":"inspect","target":"coder-jitui"}；role-b1ed6bb4 {"kind":"attack","target":"coder-jitui"}
阶段 2：nim {"claim":"villager","confidence":"medium","kind":"statement","target":"role-8584af0d"}；role-8584af0d {"claim":"seer","confidence":"medium","kind":"statement","target":"nim"}；role-a614a094 {"claim":"villager","confidence":"medium","kind":"statement","target":"nim"}；role-b1ed6bb4 {"claim":"villager","confidence":"medium","kind":"statement","target":"nim"}
阶段 3：nim {"kind":"vote","target":"role-8584af0d"}；role-8584af0d {"kind":"vote","target":"nim"}；role-a614a094 {"kind":"vote","target":"nim"}；role-b1ed6bb4 {"kind":"vote","target":"nim"}
阶段 4：role-8584af0d {"kind":"inspect","target":"role-a614a094"}；role-b1ed6bb4 {"kind":"attack","target":"role-8584af0d"}

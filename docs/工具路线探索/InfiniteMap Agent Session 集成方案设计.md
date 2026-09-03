# InfiniteMap Agent Session 集成方案设计

## 1. 背景与目标

InfiniteMap 作为 Agent Orchestration 平台，需要统一管理多个 Coding Agent Provider 的会话生命周期，包括：

- GitHub Copilot SDK
- OpenAI Codex Server (Codex App Server)

核心目标：

1. 用户在 InfiniteMap 中创建的 Agent 会话，需要能够被对应原生 IDE Agent 客户端识别、查看，并继续执行。
2. InfiniteMap 的 KM 文件作为 Agent 工作上下文载体，需要能够关联历史 Agent Session，并支持恢复执行。
3. Session 生命周期需要支持：
   - 新建 Session
   - 恢复历史 Session
   - Session 所有权转移
   - Native Client 接管
   - Session 状态同步

---

# 2. 明确范围

## 2.1 必须支持

### A. Copilot SDK 集成

目标：

> InfiniteMap 使用 Copilot SDK 创建的 Session，可以在 VS Code Copilot 插件中查看，并继续执行。


支持：

- Copilot SDK 创建 Session
- Session 持久化
- VS Code Copilot Session Discovery
- VS Code Copilot Native Resume


---

### B. Codex Server 集成

目标：

> InfiniteMap 使用 Codex App Server 创建的 Session，可以在 VS Code Codex 插件中查看，并继续执行。


支持：

- Codex App Server 创建 Thread
- Thread 持久化
- VS Code Codex Session Discovery
- VS Code Codex Native Resume


---

### C. KM 文件绑定历史 Session

目标：

每个 KM 文件可以绑定历史 Agent Session：

```
KM File
   |
   |
   +-- Copilot Session
   |
   +-- Codex Session
```

再次打开 KM 时：

优先：

```
恢复已有 Session
```

否则：

```
创建新的 Session
```

---

### D. 每个新 Codex Session 独立启动 Codex Server

确定采用：

```
One Session
      |
      |
      +-- One Codex App Server Process
```


不采用：

```
One Global Codex Server
      |
      |
      +-- Multiple Sessions
```


原因：

- 避免 Session writer ownership 冲突
- 支持 VS Code Codex 接管
- 简化生命周期管理
- 降低 Session unload 问题


---

## 2.2 不支持

### Codex Desktop 集成

不支持：

```
InfiniteMap
    |
    |
Codex App Server
    |
    |
Codex Desktop
```

不实现：

- codex://threads/<threadId>
- Codex Desktop Deep Link
- Desktop Session Handoff


原因：

当前产品目标聚焦：

```
InfiniteMap
       |
       |
       IDE Agent Client
```

即：

- VS Code Copilot
- VS Code Codex

---

# 3. 总体架构

## 3.1 总体关系


```
                     InfiniteMap

                         |
                         |
                  Agent Session Manager

                         |
        -------------------------------------
        |                                   |
        |                                   |
        v                                   v

 Copilot Provider                  Codex Provider

        |                                   |

 Copilot SDK                      Codex App Server

        |                                   |

 ~/.copilot/session-state          ~/.codex/sessions


        |                                   |

        v                                   v

 VS Code Copilot                 VS Code Codex Plugin

```

---

# 4. 核心设计原则

## 4.1 Session Identity 唯一原则

InfiniteMap 不创建自己的 Agent Session ID。

必须保存 Provider 原生 Session ID。

---

### Copilot

唯一 ID：

```
sessionId
```

来源：

```
Copilot SDK createSession()
```


---

### Codex

唯一 ID：

```
threadId
```

来源：

```
Codex App Server thread/start
```


---

InfiniteMap 保存：

```
InfiniteMap Execution ID

        +

Provider Native Session ID
```

---

# 5. Session 数据模型


## 5.1 Agent Session


```typescript
interface AgentSession {

    id: string;


    provider:
        | "copilot"
        | "codex";


    nativeSessionId:
        string;


    kmFileId:
        string;


    workspace:
        string;


    status:
        | "created"
        | "running"
        | "completed"
        | "handoff"
        | "external";


    owner:
        | "infinitemap"
        | "native-client"
        | "none";


    createdAt:
        number;


    updatedAt:
        number;
}
```


---

# 6. KM 文件与 Session 绑定机制


## 6.1 KM 元数据


示例：

```json
{
  "kmId": "order-refund-flow",

  "sessions": {

      "codex": {

          "threadId":
          "019xxxx",

          "owner":
          "none"

      },


      "copilot": {

          "sessionId":
          "xxxx",

          "owner":
          "none"

      }

  }
}
```


---

# 7. Session 创建策略


每次用户在 InfiniteMap 发起任务：

流程：


```
用户打开 KM

        |
        v

Session Resolver

        |
        |
        +----------------+
        |                |
        v                v

存在历史 Session      不存在历史 Session


        |                |

        v                v

检查是否允许接管       创建新 Session


        |                |

        |                |

允许                    新建

        |                |

        v                v

Resume Session       Create Session

```


---

# 8. 历史 Session 接管策略


## 8.1 判断条件


必须同时满足：

```
历史 Session 存在

AND

Session 状态有效

AND

允许当前 Runtime 接管

AND

Native Client 未占用

```


---

## 8.2 接管流程


```
KM Open

    |

读取 Session Metadata

    |

thread/session exists?

    |

check ownership

    |

Acquire Ownership

    |

Resume Session

```


---

# 9. Ownership 模型


Session 必须有明确 Owner。


```
                Session

                   |

        ----------------------

        |                    |

 InfiniteMap             Native IDE

```


状态：

```
INFINITEMAP_OWNER

        |

        |
handoff

        |

NATIVE_OWNER
```


---

## 9.1 不允许双写


禁止：

```
InfiniteMap
      |
      |
      +---- send message


VS Code
      |
      |
      +---- send message


同时操作同一个 Session
```


原因：

- Session history 冲突
- Runtime state 冲突
- Tool execution 冲突


---

# 10. Copilot Provider 设计


## 10.1 Runtime


使用：

```
@github/copilot-sdk
```


---

## 10.2 Session 创建


流程：

```
CopilotClient

    |

createSession()

    |

sessionId

    |

~/.copilot/session-state

```


---

## 10.3 VS Code Copilot 可见性


要求：

必须：

```
COPILOT_HOME
=
VS Code Copilot 使用目录
```


默认：

```
~/.copilot
```


---

## 10.4 VS Code 打开策略


优先：

```
VS Code Copilot Session Discovery
```


即：

```
InfiniteMap Session

        |

        v

~/.copilot/session-state

        |

        v

VS Code Copilot Sessions

```


---

如果未来 VS Code Chat Session API 可用：

采用：

```
chatSessionsProvider
```

实现：

```
InfiniteMap Session

        |

        v

VS Code Native Session UI

```


---

# 11. Codex Provider 设计


## 11.1 Runtime


使用：

```
codex app-server
```


---

## 11.2 生命周期


采用：

```
One Session
    |
    |
One Codex App Server Process
```


流程：

```
Create Task

      |

spawn codex app-server

      |

initialize

      |

thread/start

      |

turn/start

      |

turn/completed

      |

persist thread

      |

shutdown app-server

```


---

## 11.3 为什么不用共享 Server


不采用：

```
Global Codex Server

       |

       + Session A
       + Session B
       + Session C

```


原因：

- VS Code Codex 接管需要释放 writer
- 避免 Session ownership 冲突
- 降低资源耦合


---

# 12. VS Code Codex 查看与打开


## 12.1 查看


依赖：

```
共享 CODEX_HOME
```

即：

```
InfiniteMap

     |

~/.codex


     |

VS Code Codex Extension

```


VS Code Codex 通过：

```
thread/list
```

发现 Session。


---

## 12.2 打开


当前没有公开 Stable API：

```
openSession(threadId)
```


采用 Adapter。


```
CodexVsCodeNativeAdapter

        |

        |

openai-codex://route/local/<threadId>

```


通过：

```
chatgpt.conversationEditor
```


打开。


---

## 12.3 兼容策略


因为 URI 属于插件内部协议：

必须：

```
Version Check

       |

       |

Supported

       |

       |

Open Native Session

```


否则：

fallback：

```
提示用户在 VS Code Codex Session 列表打开
```


---

# 13. Native Client Capability 探测


启动时执行：

```
Capability Discovery
```


---

## Copilot


检测：

```
VS Code Copilot Extension

是否存在

```


---

## Codex


检测：

```
VS Code Codex Extension

是否存在

```


---

结果：

```json
{
 "copilot": {

    "available": true

 },


 "codex": {

    "available": false

 }

}
```


---

# 14. 用户体验设计


## 情况一

Copilot 已安装：

```
Session Created


[在 VS Code Copilot 打开]

```


---

## 情况二

Codex 插件未安装：


```
VS Code Codex 未安装


仍可：

[继续在 InfiniteMap 执行]


[安装 Codex 插件]

```


---

## 情况三

两个都不存在：


```
Native IDE Agent 未安装


InfiniteMap Agent Runtime 正常可用

```


---

# 15. 错误处理


## 15.1 Session 不存在


```
thread/session not found

↓

标记 invalid

↓

创建新 Session
```


---

## 15.2 Session 被其他客户端占用


```
ownership conflict

↓

提示：

当前 Session 正在 VS Code 中使用

是否接管？

```


---

## 15.3 Native Client 不存在


不影响：

```
Agent Execution

```


只影响：

```
Native Open Action
```


---

# 16. InfiniteMap 内部模块划分


```
Agent Core

    |

    |

Session Manager

    |

--------------------------------

|                              |

Copilot Adapter          Codex Adapter


|                              |

Copilot SDK              Codex App Server


--------------------------------

            |

            |

 Native Session Adapter


            |

 ----------------------------

 |                          |

VS Code Copilot        VS Code Codex

```


---

# 17. MVP 实施阶段


## Phase 1

完成：

- Copilot SDK Session 创建
- Codex App Server Session 创建
- KM Session 绑定
- Session Resume


---

## Phase 2

完成：

- VS Code Copilot Session Discovery
- VS Code Codex Session Discovery


---

## Phase 3

完成：

- Copilot Native Session Provider
- Codex VS Code Native Open Adapter


---

## Phase 4

完善：

- Ownership Transfer
- Session Lock
- Conflict Resolution


---

# 18. 最终方案总结


InfiniteMap 的 Agent Session 架构最终定义：

```
KM File

    |

Session Manager

    |

Native Agent Session

    |

---------------------------------

Copilot SDK          Codex App Server


    |                     |

sessionId             threadId


    |                     |

VS Code Copilot       VS Code Codex


```


核心原则：

1. Session Identity 使用 Agent 原生 ID。
2. KM 文件绑定 Session，而不是复制 Session。
3. 优先恢复历史 Session。
4. 新 Session 独立 Runtime。
5. Native IDE 是可选增强，不影响核心执行。
6. 不允许多个 Client 同时写同一个 Session。
7. Session handoff 必须显式发生。
8. InfiniteMap 是 Session 生命周期管理中心。

该方案可以支持未来继续扩展：

- Claude Code
- Gemini CLI
- Cursor Agent
- OpenCode
- 自研 Agent Runtime

而无需修改核心 Session 管理模型。
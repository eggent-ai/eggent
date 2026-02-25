# Full User Request Lifecycle in the LLM Pipeline

How the app processes a user message: from API entry to response streaming.

---

## 1. App Entry Point

**File:** `src/app/api/chat/route.ts`

1. A **POST** request arrives at `/api/chat` with body fields: `chatId?`, `projectId?`, `currentPath?`, `message` (or `messages[]` in AI SDK format).
2. The **message text** is extracted from the body (`message` or the latest user message in `messages`).
3. If `chatId` is missing, a new chat is created (`createChat`); otherwise existing chat presence is validated.
4. **`runAgent({ chatId, userMessage, projectId, currentPath })`** is called.
5. The response is returned as a **stream** via `result.toUIMessageStreamResponse()`.

---

## 2. Agent: Context and History

**File:** `src/lib/agent/agent.ts` -> `runAgent()`

1. **Settings** are loaded from `getSettings()` (model, temperature, memory, web search, etc.).
2. **Model** is initialized via `createModel(settings.chatModel)` (OpenAI/Anthropic/Google/OpenRouter, etc.).
3. **Agent context** is assembled as `AgentContext`:
   - `chatId`, `projectId`, `currentPath`;
   - `memorySubdir` and `knowledgeSubdirs` (project-dependent);
   - `agentNumber` (0 for the primary agent);
   - `history` starts empty, `data` starts as an empty object.
4. **Chat history** is loaded from `getChat(chatId)`, persisted user/assistant messages are converted to `ModelMessage[]`, and assigned to `context.history`.

---

## 3. Tools

**File:** `src/lib/tools/tool.ts` -> `createAgentTools(context, settings)`

A tool set is created depending on context and settings:

| Tool               | Availability               | Purpose                              |
|--------------------|----------------------------|--------------------------------------|
| `response`         | Always                     | Final reply to the user              |
| `code_execution`   | If enabled in settings     | Run Python/Node/Shell                |
| `memory_save`      | If memory is enabled       | Save to memory                       |
| `memory_load`      | If memory is enabled       | Search memory                        |
| `memory_delete`    | If memory is enabled       | Delete memory records                |
| `knowledge_query`  | Always                     | Search knowledge base documents      |
| `search_web`       | If web search is enabled   | Search the internet                  |
| `load_skill`       | If `projectId` exists      | Load full skill instructions         |
| `call_subordinate` | For agents 0-2 only        | Delegate to a subordinate agent      |

Each tool is built as `tool({ description, inputSchema, execute })`. The tool name list (`toolNames`) is passed forward into prompt generation.

---

## 4. System Prompt (prompts + project + skills metadata)

**File:** `src/lib/agent/prompts.ts` -> `buildSystemPrompt({ projectId, agentNumber, tools: toolNames })`

The system prompt is assembled from **multiple parts** (in append order):

### 4.1 Base System Prompt

- Reads **`src/prompts/system.md`** (if present).
- If the file is missing, falls back to `getDefaultSystemPrompt()` (agent role, rules, capabilities).

### 4.2 Agent Identity

- Adds text like "You are Agent 0" / "You are a subordinate agent (level N)" based on `agentNumber`.

### 4.3 Tool Prompts (tool descriptions)

- For **each tool name** in `tools`, loads **`src/prompts/tool-<name>.md`** (for example, `tool-code_execution.md`, `tool-load_skill.md`).
- Appends a block: `## Tool: <name>` + file contents.
- This gives the model not only the SDK schema/description but also detailed usage guidance.

### 4.4 Active Project (if `projectId` exists)

- Loads project data from **project-store** via `getProject(projectId)`.
- Appends:
  - project name and description;
  - **Project Instructions** from `project.instructions` (if set).

### 4.5 Skills (metadata only)

- Calls **`loadProjectSkillsMetadata(projectId)`** to read only skill **frontmatter** from `.meta/skills/<skill-name>/SKILL.md` (name + description).
- Appends:
  - a short note: skills are available, use `load_skill` when relevant;
  - an **`<available_skills>`** XML block listing `<skill><name>...</name><description>...</description></skill>`.
- **Full skill instructions are not embedded in the system prompt**; they are fetched on demand through `load_skill`.

### 4.6 Current Date and Time

- Appends date/time and timezone at the end.

The final system prompt string is joined and sent to the model call.

---

## 5. Messages

**Same file:** `src/lib/agent/agent.ts`

1. Takes **history** from context: `context.history` (all persisted user/assistant chat messages).
2. Appends the **current user message**: `{ role: "user", content: userMessage }`.
3. Produces the **`messages`** array for the model request.

(For subordinate agents, a parent-history slice plus one task message is used instead of full history.)

---

## 6. Request Logging (optional)

- Before model invocation, the server logs the full request payload: model, system, messages, tools list, and params (see `logLLMRequest` in `agent.ts`).

---

## 7. Model Invocation and Tool-Call Loop

**File:** `src/lib/agent/agent.ts` -> `streamText({ ... })`

1. **Vercel AI SDK** `streamText` is called with:
   - `model`, `system`, `messages`, `tools`;
   - `stopWhen: stepCountIs(15)` (max 15 steps: model outputs + tool calls);
   - `temperature`, `maxOutputTokens`.
2. The model receives:
   - **system**: assembled system prompt (base + identity + tool prompts + project + skills metadata + date);
   - **messages**: history + current user message;
   - **tools**: all available tool declarations (schema + SDK descriptions).
3. The model may:
   - generate text and call **response** -> stream ends and reply is delivered;
   - call one or more **tools** (for example, `code_execution`, `memory_load`, `load_skill`) -> SDK runs `execute`, injects tool output into the conversation, and calls the model again (next round).
4. The loop continues until:
   - **response** is called, or
   - step limit (15) is reached, or
   - an error occurs.

When **`load_skill`** is called, the tool reads the selected skill's full **SKILL.md** body and returns it into the conversation. The model then sees those instructions in message history and can follow them in subsequent steps.

---

## 8. After Response (onFinish)

- When streaming completes, **onFinish** runs.
- In **chat-store**, the chat is updated with:
  - the latest user message;
  - the final assistant reply (`event.text`);
- Chat title may be updated (typically from the first message).

---

## Summary Flow

```text
[User] -> POST /api/chat (message, chatId?, projectId?, currentPath?)
       v
[route.ts] extract message, resolve chatId, runAgent(...)
       v
[agent.ts] runAgent:
   1. getSettings() -> model, settings
   2. getChat(chatId) -> context.history
   3. createAgentTools(context, settings) -> tools (response, code_execution, memory_*, knowledge_query, search_web?, load_skill?, call_subordinate?)
   4. buildSystemPrompt(projectId, agentNumber, toolNames) ->
        system.md + Agent Identity + tool-*.md per tool + Active Project + project.instructions + loadProjectSkillsMetadata -> <available_skills> + date/time
   5. messages = history + { user, userMessage }
   6. logLLMRequest(...)  // server console
   7. streamText(model, system, messages, tools, stopWhen(15), ...)
       v
[SDK + provider] loop: model -> tool calls -> execute -> model -> ... -> response -> stream
       v
[route.ts] result.toUIMessageStreamResponse() -> client
[onFinish] saveChat(chat) -> persist user + assistant messages
```

**Prompts** define baseline behavior and text instructions per tool.  
**Tools** are real executable capabilities (code, memory, search, knowledge, skills, subordinates).  
**Skills** are included in system prompt as metadata only (name + description); full skill instructions are loaded on demand via **load_skill**.

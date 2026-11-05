
import os
import asyncio
import json

import ollama

from fastapi import FastAPI
from pydantic import BaseModel

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


OLLAMA_HOST = os.getenv(
    "OLLAMA_HOST",
    "http://localhost:11434"
)

OLLAMA_MODEL = os.getenv(
    "OLLAMA_MODEL",
    "qwen3:8b"
)

I3X_BASE_URL = os.getenv(
    "I3X_BASE_URL",
    "https://api.i3x.dev/v1"
)

app = FastAPI(title="i3X Ollama Agent")

llm = ollama.AsyncClient(host=OLLAMA_HOST)


class ChatRequest(BaseModel):
    message: str


def convert_tools(mcp_tools):
    result = []

    for tool in mcp_tools:

        # 相容不同版本的 MCP Python SDK
        if hasattr(tool, "input_schema"):
            schema = tool.input_schema

        elif hasattr(tool, "inputSchema"):
            schema = tool.inputSchema

        elif hasattr(tool, "model_dump"):
            data = tool.model_dump(by_alias=True)
            schema = data.get(
                "inputSchema",
                data.get("input_schema", {})
            )

        else:
            schema = {}

        # 確保 schema 是一般 Python dict
        if hasattr(schema, "model_dump"):
            schema = schema.model_dump(by_alias=True)

        if not isinstance(schema, dict):
            schema = {}

        result.append({
            "type": "function",
            "function": {
                "name": tool.name,
                "description": tool.description or "",
                "parameters": schema
            }
        })

    return result


async def ask_agent(question):

    server = StdioServerParameters(
        command="node",
        args=["/app/i3x/dist/index.js"],
        env={
            **os.environ,
            "I3X_BASE_URL": I3X_BASE_URL,
            "I3X_AUTH_SCHEME": "none"
        }
    )

    async with stdio_client(server) as (read, write):

        async with ClientSession(read, write) as session:

            await session.initialize()

            tools_result = await session.list_tools()

            print("===== MCP TOOLS =====")

            for tool in tools_result.tools:
                print(f"Tool: {tool.name}")
                print(f"Description: {tool.description}")

            tools = convert_tools(tools_result.tools)

            print("===== OLLAMA TOOLS =====")

            print(json.dumps(
                tools,
                ensure_ascii=False,
                indent=2
            ))

            messages = [
                {
                    "role": "system",
                    "content": (
                        "你是一位智慧製造 AI 助理。"
                        "請使用繁體中文回答。"
                        "需要工廠資料時，必須使用 i3X MCP 工具。"
                        "不可捏造設備數值。"
                    )
                },
                {
                    "role": "user",
                    "content": question
                }
            ]

            for _ in range(8):

                response = await llm.chat(
                    model=OLLAMA_MODEL,
                    messages=messages,
                    tools=tools
                )

                msg = response.message

                messages.append(msg)

                if not msg.tool_calls:
                    return msg.content

                for call in msg.tool_calls:

                    result = await session.call_tool(
                        call.function.name,
                        arguments=call.function.arguments
                    )

                    content = []

                    for item in result.content:
                        if hasattr(item, "text"):
                            content.append(item.text)

                    messages.append({
                        "role": "tool",
                        "tool_name": call.function.name,
                        "content": "\n".join(content)
                    })

            return "工具呼叫次數已達上限，請縮小查詢範圍。"


@app.post("/chat")
async def chat(request: ChatRequest):

    answer = await ask_agent(request.message)

    return {
        "question": request.message,
        "answer": answer
    }


@app.get("/health")
async def health():

    return {
        "status": "ok",
        "model": OLLAMA_MODEL,
        "i3x_api": I3X_BASE_URL
    }


if __name__ == "__main__":

    import uvicorn

    uvicorn.run(
        app,
        host="0.0.0.0",
        port=8000
    )

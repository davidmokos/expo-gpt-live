# Tools

Ask for current information to use OpenAI web search, or ask "What's the weather in Paris, France?" to try the custom weather tool. GPT-Live delegates these requests to `gpt-5.6-luna` while the voice conversation continues.

`live-config.ts` registers the tools. OpenAI executes web search. `tools.ts` validates and executes `get_weather` on the server, then `tool-runner.ts` sends its result back to OpenAI and resumes the response. The OpenAI key stays on the server.

The app opens `/api/live-tools` before starting audio. That streaming request keeps the server executor alive on EAS Hosting for the duration of the call, including while iOS is backgrounded. Ending the call cancels pending lookups. A lost tool connection ends the call so it cannot silently leave a lookup waiting forever. Jobs that continue after hangup need separate storage and a job worker.

## Add a function

1. Add its JSON schema to `toolDefinitions` in `src/server/tools.ts`.
2. Validate its arguments and execute it in `executeTool`. Return a JSON string describing the result or error. Pass the supplied abort signal to network requests.
3. Describe when to use it in `src/server/live-config.ts` and add tests for valid input, errors, and cancellation.

Keep credentials in server environment variables. For tools that send messages, make purchases, or change account data, require the user's confirmation before execution.

## Weather

The example uses [Open-Meteo](https://open-meteo.com/) and GeoNames geocoding. It returns modeled current conditions and today's forecast, with location, time, units, and attribution. Ambiguous locations prompt a clarification. Requests time out after ten seconds; each call allows twenty custom tool executions.

Open-Meteo's free endpoint is for noncommercial use. Use a commercial plan or another provider for a commercial app. Web search and delegated model usage add OpenAI charges.

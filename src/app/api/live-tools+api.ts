import { createLiveToolsHandler } from '../../server/live-tools';

export function POST(request: Request) {
  return createLiveToolsHandler({
    apiKey: process.env.OPENAI_API_KEY,
    apiToken: process.env.API_TOKEN,
    requireApiToken: true,
  })(request);
}

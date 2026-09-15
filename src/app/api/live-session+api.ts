import { createLiveSessionHandlers } from '../../server/live-session';

function handlers() {
  return createLiveSessionHandlers({
    apiKey: process.env.OPENAI_API_KEY,
    apiToken: process.env.API_TOKEN,
    requireApiToken: true,
  });
}

export function POST(request: Request) {
  return handlers().POST(request);
}

export function DELETE(request: Request) {
  return handlers().DELETE(request);
}

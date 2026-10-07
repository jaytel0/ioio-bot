// Preserve existing REST, WebSocket, and OAuth clients at the original address.
export default {
  fetch(request: Request, env: { SERVICE: Fetcher }) {
    return env.SERVICE.fetch(request);
  }
} satisfies ExportedHandler<{ SERVICE: Fetcher }>;
